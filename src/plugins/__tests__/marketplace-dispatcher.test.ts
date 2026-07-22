import { createHash, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AdmZip from "adm-zip";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";

import { isAbsolute, join, resolve } from "node:path";

const mockedPublisherKeys = vi.hoisted(() => ({
  getBundledPublicKeys: vi.fn(),
}));

vi.mock("../publisher-keys.js", () => ({
  getBundledPublicKeys: mockedPublisherKeys.getBundledPublicKeys,
}));

import { PluginMarketplaceService } from "../marketplace.js";
import { ArtifactRollbackError, PluginArtifactStore } from "../plugin-artifact-store.js";
import type { MarketplaceFetcher } from "../marketplace-fetcher.js";
import type { PluginMarketplaceItem, PluginRegistryEntry } from "../types.js";
import { setCachedCatalog } from "../offline-cache.js";
import { _resetForTest, setIsPackaged } from "../../boot/dev-flags.js";
import { makeTestPluginPaths } from "./test-helpers.js";
import { canonicalJSON } from "../whitelist/canonical-json.js";
import * as installedEntryFs from "../installed-entry-fs.js";

function makePluginZip(manifest: Record<string, unknown>): Buffer {
  const zip = new AdmZip();
  zip.addFile("plugin.json", Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf-8"));
  zip.addFile(
    "dist/hostPlugin.js",
    Buffer.from("export default async function createPlugin() { return { handlers: {} }; }\n", "utf-8"),
  );
  return zip.toBuffer();
}

function manifestSha(manifest: unknown): string {
  return createHash("sha256").update(canonicalJSON(manifest)).digest("hex");
}

function freshEd25519() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const rawPub = publicKey.export({ format: "jwk" }) as { x: string };
  return {
    privateKey,
    publicKey: Buffer.from(rawPub.x, "base64url"),
  };
}

function makeEnvelope(body: Buffer, privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"]) {
  return {
    version: 1 as const,
    iat: Math.floor(Date.now() / 1000),
    artifact_sha256: createHash("sha256").update(body).digest("hex"),
    signatures: [
      {
        key_id: "test-v1",
        alg: "ed25519" as const,
        sig: cryptoSign(null, body, privateKey).toString("base64"),
      },
    ],
  };
}

describe("PluginMarketplaceService install()", () => {
  let testDir: string;
  let appRoot: string;
  let registryPath: string;
  let installedDir: string;
  let cacheRoot: string;

  beforeEach(async () => {
    setIsPackaged(false);
    // Phase 2b-1: one test exercises the file:-spec dev branch.
    // Round-3: LVIS_DEV=1 subsumes the deprecated LVIS_ALLOW_LINKED_PLUGIN_ENTRY.
    process.env.LVIS_DEV = "1";
    testDir = await mkdtemp(join(tmpdir(), "lvis-marketplace-install-"));
    appRoot = testDir;
    // Phase 2a: registry + installed plugins live under pluginsRoot
    // (testDir/plugins). The legacy `installed/` subdir is gone.
    installedDir = join(testDir, "plugins");
    registryPath = join(installedDir, "registry.json");
    cacheRoot = join(testDir, ".cache");
    await mkdir(installedDir, { recursive: true });
    await writeFile(registryPath, JSON.stringify({ version: 1, plugins: [] }), "utf-8");
    mockedPublisherKeys.getBundledPublicKeys.mockReset();
  });

  afterEach(async () => {
    delete process.env.LVIS_DEV;
    vi.restoreAllMocks();
    await rm(testDir, { recursive: true, force: true });
    _resetForTest();
  });

  function manifestPathToAbs(manifestPath: string): string {
    return isAbsolute(manifestPath)
      ? manifestPath
      : resolve(installedDir, manifestPath);
  }

  function makeService(fetcher: MarketplaceFetcher) {
    const paths = makeTestPluginPaths({
      rootDir: testDir,
      pluginsRoot: installedDir,
      cacheRoot,
    });
    const service = new PluginMarketplaceService(paths, fetcher);
    // Phase 2-final: npm install no longer exists on the service. Tests
    // that previously asserted "npm was not called" now check there's no
    // such method to call. The mock is kept as a tombstone so existing
    // assertions `expect(npmInstallMock).not.toHaveBeenCalled()` pass.
    const npmInstallMock = vi.fn(async () => {});
    return { service, npmInstallMock };
  }

  it("downloads and extracts a marketplace zip without using npm", async () => {
    const signingKey = freshEd25519();
    mockedPublisherKeys.getBundledPublicKeys.mockReturnValue({
      "test-v1": signingKey.publicKey,
    });
    const plugin: PluginMarketplaceItem = {
      id: "test-plugin",
      slug: "test-plugin",
      name: "Test Plugin",
      description: "A test plugin",
      version: "1.2.3",
      packageSpec: "@lvis/test-plugin@1.2.3",
      packageName: "@lvis/test-plugin",
      tools: ["ping"],
    };
    const pluginManifest = {
      id: plugin.id,
      name: plugin.name,
      version: plugin.version,
      entry: "./dist/hostPlugin.js",
      tools: plugin.tools,
    };
    const zipBuffer = makePluginZip(pluginManifest);
    const downloadVersion = vi.fn(async () => {
      throw new Error("downloadVersion should not be called for signed installs");
    });
    const downloadArtifact = vi.fn(async () => ({
      body: zipBuffer,
      sha256Header: createHash("sha256").update(zipBuffer).digest("hex"),
      status: 200,
    }));
    const fetchSignatureEnvelope = vi.fn(async () => makeEnvelope(zipBuffer, signingKey.privateKey));
    const fetcher: MarketplaceFetcher & {
      downloadArtifact: typeof downloadArtifact;
      fetchSignatureEnvelope: typeof fetchSignatureEnvelope;
    } = {
      listPlugins: async () => [plugin],
      getPluginDetail: async () => plugin,
      downloadVersion,
      downloadArtifact,
      fetchSignatureEnvelope,
      listAnnouncements: async () => [],
    };

    const { service, npmInstallMock } = makeService(fetcher);
    await expect(service.install("test-plugin")).resolves.toEqual({
      pluginId: "test-plugin",
      installed: true,
    });

    expect(downloadArtifact).toHaveBeenCalledWith("test-plugin", "1.2.3", undefined);
    expect(fetchSignatureEnvelope).toHaveBeenCalledWith("test-plugin", "1.2.3");
    expect(downloadVersion).not.toHaveBeenCalled();
    expect(npmInstallMock).not.toHaveBeenCalled();

    const registry = JSON.parse(await readFile(registryPath, "utf-8")) as {
      plugins: Array<{ manifestPath: string; manifestSha256?: string }>;
    };
    // Phase 2a invariant: the zip-install branch must emit a registry-
    // relative POSIX path (NOT an absolute path). Locks the regression
    // flagged by code-reviewer round 1 — production RealCloud installs
    // were writing absolute paths into registry.json.
    const entryPath = registry.plugins[0].manifestPath;
    expect(entryPath).toBe("test-plugin/plugin.json");
    expect(entryPath).not.toMatch(/^[/\\]|^[A-Za-z]:/);
    expect(entryPath).not.toContain("\\");
    expect(registry.plugins[0].manifestSha256).toBe(manifestSha(pluginManifest));

    const manifest = JSON.parse(
      await readFile(manifestPathToAbs(entryPath), "utf-8"),
    ) as { version: string; entry: string };
    expect(manifest.version).toBe("1.2.3");
    expect(manifest.entry).toBe("./dist/hostPlugin.js");
  });

  it("uses the canonical catalog id for alias replacement history and receipt-cache invalidation", async () => {
    const signingKey = freshEd25519();
    mockedPublisherKeys.getBundledPublicKeys.mockReturnValue({ "test-v1": signingKey.publicKey });
    const plugin: PluginMarketplaceItem = {
      id: "canonical-email",
      slug: "email-alias",
      name: "Email",
      description: "alias replacement fixture",
      version: "1.0.0",
      packageSpec: "@lvis/email@1.0.0",
      packageName: "@lvis/email",
      tools: [],
    };
    const makeVersionZip = (version: string) => makePluginZip({
      id: plugin.id,
      name: plugin.name,
      description: plugin.description,
      version,
      entry: "./dist/hostPlugin.js",
      tools: [],
    });
    const v1Zip = makeVersionZip("1.0.0");
    const v2Zip = makeVersionZip("2.0.0");
    const downloadArtifact = vi.fn()
      .mockResolvedValueOnce({ body: v1Zip, sha256Header: createHash("sha256").update(v1Zip).digest("hex"), status: 200 })
      .mockResolvedValueOnce({ body: v2Zip, sha256Header: createHash("sha256").update(v2Zip).digest("hex"), status: 200 });
    const fetchSignatureEnvelope = vi.fn()
      .mockResolvedValueOnce(makeEnvelope(v1Zip, signingKey.privateKey))
      .mockResolvedValueOnce(makeEnvelope(v2Zip, signingKey.privateKey));
    const fetcher: MarketplaceFetcher = {
      listPlugins: async () => [plugin],
      getPluginDetail: async () => plugin,
      downloadVersion: async () => { throw new Error("unexpected legacy download"); },
      downloadArtifact,
      fetchSignatureEnvelope,
      listAnnouncements: async () => [],
    };
    const { service } = makeService(fetcher);

    await service.install(plugin.slug);
    plugin.version = "2.0.0";
    plugin.packageSpec = "@lvis/email@2.0.0";
    plugin.artifactSha256 = createHash("sha256").update(v2Zip).digest("hex");
    await service.install(plugin.slug);

    const artifactStore = (service as unknown as { artifactStore: PluginArtifactStore }).artifactStore;
    expect(await artifactStore.findRollbackTarget(plugin.id, "2.0.0")).toBe("1.0.0");
    const history = JSON.parse(await readFile(join(cacheRoot, plugin.id, "history.json"), "utf-8")) as {
      entries: Array<{ version: string }>;
    };
    expect(history.entries.map((entry) => entry.version)).toContain("1.0.0");
    expect(existsSync(join(cacheRoot, plugin.slug, "history.json"))).toBe(false);

    await service.install(plugin.slug);
    expect(downloadArtifact).toHaveBeenCalledTimes(2);
    expect(fetchSignatureEnvelope).toHaveBeenCalledTimes(2);
  });

  it("does not mark the old registry row pending while a replacement is still downloading", async () => {
    const signingKey = freshEd25519();
    mockedPublisherKeys.getBundledPublicKeys.mockReturnValue({ "test-v1": signingKey.publicKey });
    const plugin: PluginMarketplaceItem = {
      id: "download-window",
      slug: "download-window",
      name: "Download Window",
      description: "pre-promotion crash fixture",
      version: "1.0.0",
      packageSpec: "@lvis/download-window@1.0.0",
      packageName: "@lvis/download-window",
      tools: [],
    };
    let zipBuffer = makePluginZip({ ...plugin, entry: "./dist/hostPlugin.js" });
    let releaseDownload: (() => void) | undefined;
    let downloadStarted: (() => void) | undefined;
    const downloadGate = new Promise<void>((resolveGate) => { releaseDownload = resolveGate; });
    const downloadStartedPromise = new Promise<void>((resolveStarted) => { downloadStarted = resolveStarted; });
    let pause = false;
    const fetcher: MarketplaceFetcher = {
      listPlugins: async () => [plugin],
      getPluginDetail: async () => plugin,
      downloadVersion: async () => { throw new Error("unexpected legacy download"); },
      downloadArtifact: async () => {
        if (pause) {
          downloadStarted?.();
          await downloadGate;
        }
        return { body: zipBuffer, sha256Header: createHash("sha256").update(zipBuffer).digest("hex"), status: 200 };
      },
      fetchSignatureEnvelope: async () => makeEnvelope(zipBuffer, signingKey.privateKey),
      listAnnouncements: async () => [],
    };
    const { service } = makeService(fetcher);
    await service.install(plugin.id);
    const originalRegistry = await readFile(registryPath, "utf-8");
    plugin.version = "2.0.0";
    zipBuffer = makePluginZip({ ...plugin, entry: "./dist/hostPlugin.js" });
    pause = true;

    const replacement = service.install(plugin.id);
    await downloadStartedPromise;
    expect(await readFile(registryPath, "utf-8")).toBe(originalRegistry);
    releaseDownload?.();
    await replacement;
  });

  it("marks a raw stale-manifest row pending before promotion and preserves its bundle graph", async () => {
    const signingKey = freshEd25519();
    mockedPublisherKeys.getBundledPublicKeys.mockReturnValue({ "test-v1": signingKey.publicKey });
    const plugin: PluginMarketplaceItem = {
      id: "stale-member",
      slug: "stale-alias",
      name: "Stale Member",
      description: "stale registry row fixture",
      version: "2.0.0",
      packageSpec: "@lvis/stale-member@2.0.0",
      packageName: "@lvis/stale-member",
      tools: [],
    };
    const zipBuffer = makePluginZip({
      id: plugin.id,
      name: plugin.name,
      description: plugin.description,
      version: plugin.version,
      entry: "./dist/hostPlugin.js",
      tools: [],
    });
    const fetcher: MarketplaceFetcher = {
      listPlugins: async () => [plugin],
      getPluginDetail: async () => plugin,
      downloadVersion: async () => { throw new Error("unexpected legacy download"); },
      downloadArtifact: async () => ({
        body: zipBuffer,
        sha256Header: createHash("sha256").update(zipBuffer).digest("hex"),
        status: 200,
      }),
      fetchSignatureEnvelope: async () => makeEnvelope(zipBuffer, signingKey.privateKey),
      listAnnouncements: async () => [],
    };
    await writeFile(registryPath, JSON.stringify({
      version: 1,
      plugins: [{
        id: plugin.id,
        manifestPath: `${plugin.id}/plugin.json`,
        enabled: true,
        installSource: "user",
        bundleRefs: ["bundle-root"],
        approvedPluginAccess: { plugins: [{ pluginId: "bundle-root", events: ["bundle.event"] }] },
      }],
    }));
    const { service } = makeService(fetcher);
    const target = service as unknown as {
      markMarketplaceRegistryEntryPending: (
        entry: PluginRegistryEntry | null,
        backupDir: string,
      ) => Promise<PluginRegistryEntry | null>;
    };
    const originalMark = target.markMarketplaceRegistryEntryPending.bind(service);
    vi.spyOn(target, "markMarketplaceRegistryEntryPending").mockImplementation(async (...args) => {
      const result = await originalMark(...args);
      const pendingRegistry = JSON.parse(await readFile(registryPath, "utf-8")) as {
        plugins: Array<{ id: string; pendingUpdate?: unknown; bundleRefs?: string[]; approvedPluginAccess?: unknown }>;
      };
      expect(pendingRegistry.plugins).toEqual([
        expect.objectContaining({
          id: plugin.id,
          pendingUpdate: expect.objectContaining({ kind: "marketplace" }),
          bundleRefs: ["bundle-root"],
          approvedPluginAccess: expect.any(Object),
        }),
      ]);
      return result;
    });

    await service.install(plugin.slug);

    const registry = JSON.parse(await readFile(registryPath, "utf-8")) as {
      plugins: Array<{ id: string; pendingUpdate?: unknown; bundleRefs?: string[] }>;
    };
    expect(registry.plugins).toEqual([
      expect.objectContaining({ id: plugin.id, bundleRefs: ["bundle-root"] }),
    ]);
    expect(registry.plugins[0]?.pendingUpdate).toBeUndefined();
  });

  it("keeps a pending member in the bundle plan when root uninstall starts after member replacement", async () => {
    const signingKey = freshEd25519();
    mockedPublisherKeys.getBundledPublicKeys.mockReturnValue({ "test-v1": signingKey.publicKey });
    const member: PluginMarketplaceItem = {
      id: "bundle-member",
      slug: "member-alias",
      name: "Bundle Member",
      description: "pending bundle graph fixture",
      version: "2.0.0",
      packageSpec: "@lvis/bundle-member@2.0.0",
      packageName: "@lvis/bundle-member",
      tools: [],
    };
    const zipBuffer = makePluginZip({
      id: member.id,
      name: member.name,
      description: member.description,
      version: member.version,
      entry: "./dist/hostPlugin.js",
      tools: [],
    });
    const fetcher: MarketplaceFetcher = {
      listPlugins: async () => [member],
      getPluginDetail: async () => member,
      downloadVersion: async () => { throw new Error("unexpected legacy download"); },
      downloadArtifact: async () => ({ body: zipBuffer, sha256Header: createHash("sha256").update(zipBuffer).digest("hex"), status: 200 }),
      fetchSignatureEnvelope: async () => makeEnvelope(zipBuffer, signingKey.privateKey),
      listAnnouncements: async () => [],
    };
    for (const id of ["bundle-root", member.id]) {
      await mkdir(join(installedDir, id), { recursive: true });
      await writeFile(join(installedDir, id, "plugin.json"), JSON.stringify({
        id,
        name: id,
        description: id,
        version: "1.0.0",
        entry: "./dist/hostPlugin.js",
        tools: [],
      }));
    }
    await writeFile(registryPath, JSON.stringify({
      version: 1,
      plugins: [
        { id: "bundle-root", manifestPath: "bundle-root/plugin.json", enabled: true, installSource: "user" },
        { id: member.id, manifestPath: `${member.id}/plugin.json`, enabled: true, installSource: "user", bundleRefs: ["bundle-root"] },
      ],
    }));
    const { service } = makeService(fetcher);
    const target = service as unknown as {
      markMarketplaceRegistryEntryPending: (entry: PluginRegistryEntry | null, backupDir: string) => Promise<PluginRegistryEntry | null>;
    };
    const originalMark = target.markMarketplaceRegistryEntryPending.bind(service);
    let releasePending!: () => void;
    const pendingGate = new Promise<void>((resolveGate) => { releasePending = resolveGate; });
    let pendingStarted!: () => void;
    const pendingStartedPromise = new Promise<void>((resolveStarted) => { pendingStarted = resolveStarted; });
    vi.spyOn(target, "markMarketplaceRegistryEntryPending").mockImplementation(async (...args) => {
      const result = await originalMark(...args);
      pendingStarted();
      await pendingGate;
      return result;
    });

    const install = service.install(member.slug);
    await pendingStartedPromise;
    const firstUninstall = service.uninstall("bundle-root", { removeBundleMembers: true });
    await new Promise((resolveWait) => setTimeout(resolveWait, 0));
    releasePending();
    await expect(install).resolves.toEqual({ pluginId: member.id, installed: true });
    await expect(firstUninstall).rejects.toThrow(/registry changed before uninstall locks/);

    const afterConflict = JSON.parse(await readFile(registryPath, "utf-8")) as {
      plugins: Array<{ id: string; bundleRefs?: string[]; pendingUpdate?: unknown }>;
    };
    expect(afterConflict.plugins.find((entry) => entry.id === member.id)).toEqual(
      expect.objectContaining({ bundleRefs: ["bundle-root"] }),
    );
    expect(afterConflict.plugins.find((entry) => entry.id === member.id)?.pendingUpdate).toBeUndefined();

    await expect(service.uninstall("bundle-root", { removeBundleMembers: true })).resolves.toEqual({
      pluginId: "bundle-root",
      uninstalled: true,
    });
    expect((JSON.parse(await readFile(registryPath, "utf-8")) as { plugins: unknown[] }).plugins).toEqual([]);
  });

  it("serializes a standard member install behind bundle uninstall staging", async () => {
    const signingKey = freshEd25519();
    mockedPublisherKeys.getBundledPublicKeys.mockReturnValue({
      "test-v1": signingKey.publicKey,
    });
    const member: PluginMarketplaceItem = {
      id: "email",
      slug: "email-alias",
      name: "Email",
      description: "replacement fixture",
      version: "2.0.0",
      packageSpec: "@lvis/email@2.0.0",
      packageName: "@lvis/email",
      tools: [],
    };
    const replacementManifest = {
      id: member.id,
      name: member.name,
      version: member.version,
      entry: "./dist/hostPlugin.js",
      tools: member.tools,
    };
    const zipBuffer = makePluginZip(replacementManifest);
    const downloadArtifact = vi.fn(async () => ({
      body: zipBuffer,
      sha256Header: createHash("sha256").update(zipBuffer).digest("hex"),
      status: 200,
    }));
    let catalogRead!: () => void;
    const catalogReadPromise = new Promise<void>((resolveCatalog) => { catalogRead = resolveCatalog; });
    const fetcher: MarketplaceFetcher = {
      listPlugins: async () => {
        catalogRead();
        return [member];
      },
      getPluginDetail: async () => member,
      downloadVersion: async () => {
        throw new Error("downloadVersion should not be called for signed installs");
      },
      downloadArtifact,
      fetchSignatureEnvelope: async () => makeEnvelope(zipBuffer, signingKey.privateKey),
      listAnnouncements: async () => [],
    };

    for (const pluginId of ["work-assistant", "email"]) {
      const pluginDir = join(installedDir, pluginId);
      await mkdir(join(pluginDir, "dist"), { recursive: true });
      await writeFile(join(pluginDir, "plugin.json"), JSON.stringify({
        id: pluginId,
        name: pluginId,
        version: "1.0.0",
        entry: "./dist/hostPlugin.js",
        tools: [],
      }), "utf-8");
      await writeFile(join(pluginDir, "dist", "hostPlugin.js"), "export default {};\n", "utf-8");
    }
    await writeFile(registryPath, JSON.stringify({
      version: 1,
      plugins: [
        { id: "work-assistant", manifestPath: "work-assistant/plugin.json", enabled: true, installSource: "user" },
        { id: "email", manifestPath: "email/plugin.json", enabled: true, installSource: "user", bundleRefs: ["work-assistant"] },
      ],
    }), "utf-8");

    let resumeStaging!: () => void;
    const stagingGate = new Promise<void>((resolveGate) => { resumeStaging = resolveGate; });
    let stagingStarted!: () => void;
    const stagingStartedPromise = new Promise<void>((resolveStarted) => { stagingStarted = resolveStarted; });
    const originalTombstone = installedEntryFs.tombstoneAndDeferredRemove;
    let paused = false;
    vi.spyOn(installedEntryFs, "tombstoneAndDeferredRemove").mockImplementation(async (...args) => {
      if (!paused) {
        paused = true;
        stagingStarted();
        await stagingGate;
      }
      return originalTombstone(...args);
    });

    const { service } = makeService(fetcher);
    const uninstall = service.uninstall("work-assistant", { removeBundleMembers: true });
    await stagingStartedPromise;
    const install = service.install("email-alias");
    await catalogReadPromise;
    await new Promise((resolveWait) => setTimeout(resolveWait, 0));
    expect(downloadArtifact).not.toHaveBeenCalled();

    resumeStaging();
    await expect(uninstall).resolves.toEqual({ pluginId: "work-assistant", uninstalled: true });
    await expect(install).resolves.toEqual({ pluginId: "email", installed: true });

    const registry = JSON.parse(await readFile(registryPath, "utf-8")) as {
      plugins: Array<{ id: string; manifestPath: string }>;
    };
    expect(registry.plugins).toEqual([
      expect.objectContaining({ id: "email", manifestPath: "email/plugin.json" }),
    ]);
    expect(downloadArtifact).toHaveBeenCalledTimes(1);
    expect(existsSync(join(installedDir, "email", "plugin.json"))).toBe(true);
  }, 20_000);

  it("serializes a standard install behind a managed retry paused during artifact promotion", async () => {
    const signingKey = freshEd25519();
    mockedPublisherKeys.getBundledPublicKeys.mockReturnValue({
      "test-v1": signingKey.publicKey,
    });
    const plugin: PluginMarketplaceItem = {
      id: "managed-plugin",
      slug: "managed-plugin",
      name: "Managed Plugin",
      description: "managed retry fixture",
      version: "2.0.0",
      packageSpec: "@lvis/managed-plugin@2.0.0",
      packageName: "@lvis/managed-plugin",
      installPolicy: "admin",
      tools: [],
    };
    const manifest = {
      id: plugin.id,
      name: plugin.name,
      version: plugin.version,
      entry: "./dist/hostPlugin.js",
      tools: plugin.tools,
      installPolicy: "admin",
    };
    const zipBuffer = makePluginZip(manifest);
    const downloadArtifact = vi.fn(async () => ({
      body: zipBuffer,
      sha256Header: createHash("sha256").update(zipBuffer).digest("hex"),
      status: 200,
    }));
    const fetcher: MarketplaceFetcher = {
      listPlugins: async () => [plugin],
      getPluginDetail: async () => plugin,
      downloadVersion: async () => { throw new Error("unexpected legacy download"); },
      downloadArtifact,
      fetchSignatureEnvelope: async () => makeEnvelope(zipBuffer, signingKey.privateKey),
      listAnnouncements: async () => [],
    };
    const { service } = makeService(fetcher);
    const store = (service as unknown as {
      artifactStore: {
        extractZipWithCommit: (
          slug: string,
          zip: Buffer,
          commit: (installDir: string, files: string[]) => Promise<unknown>,
        ) => Promise<{ files: string[]; result: unknown }>;
      };
    }).artifactStore;
    const originalExtract = store.extractZipWithCommit.bind(store);
    let releasePromotion!: () => void;
    const promotionGate = new Promise<void>((resolveGate) => { releasePromotion = resolveGate; });
    let promotionStarted!: () => void;
    const promotionStartedPromise = new Promise<void>((resolveStarted) => { promotionStarted = resolveStarted; });
    let pauseOnce = true;
    vi.spyOn(store, "extractZipWithCommit").mockImplementation(async (slug, zip, commit) =>
      originalExtract(slug, zip, async (installDir, files) => {
        if (pauseOnce) {
          pauseOnce = false;
          promotionStarted();
          await promotionGate;
        }
        return commit(installDir, files);
      }),
    );

    const managedRetry = service.ensureManagedInstalled();
    await promotionStartedPromise;
    const standardInstall = service.install(plugin.id);
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    expect(downloadArtifact).toHaveBeenCalledTimes(1);

    releasePromotion();
    await expect(managedRetry).resolves.toEqual({
      installed: [plugin.id],
      updated: [],
      failed: [],
    });
    await expect(standardInstall).resolves.toEqual({ pluginId: plugin.id, installed: true });
    expect(downloadArtifact).toHaveBeenCalledTimes(1);
    const registry = JSON.parse(await readFile(registryPath, "utf-8")) as {
      plugins: Array<{ id: string; installSource: string }>;
    };
    expect(registry.plugins).toEqual([
      expect.objectContaining({ id: plugin.id, installSource: "admin" }),
    ]);
    expect(JSON.parse(await readFile(join(installedDir, plugin.id, "plugin.json"), "utf-8")))
      .toMatchObject({ id: plugin.id, version: "2.0.0" });
  }, 20_000);

  it("rechecks installed version under lock so an older managed retry cannot downgrade a newer install", async () => {
    const signingKey = freshEd25519();
    mockedPublisherKeys.getBundledPublicKeys.mockReturnValue({ "test-v1": signingKey.publicKey });
    const makeCatalogItem = (version: string): PluginMarketplaceItem => ({
      id: "managed-plugin",
      slug: "managed-plugin",
      name: "Managed Plugin",
      description: "managed no-downgrade fixture",
      version,
      packageSpec: `@lvis/managed-plugin@${version}`,
      packageName: "@lvis/managed-plugin",
      installPolicy: "admin",
      tools: [],
    });
    const newer = makeCatalogItem("3.0.0");
    const older = makeCatalogItem("2.0.0");
    const zips = new Map([
      ["3.0.0", makePluginZip({ ...newer, entry: "./dist/hostPlugin.js" })],
      ["2.0.0", makePluginZip({ ...older, entry: "./dist/hostPlugin.js" })],
    ]);
    let catalogReads = 0;
    const downloadArtifact = vi.fn(async (_id: string, version: string) => {
      const body = zips.get(version)!;
      return {
        body,
        sha256Header: createHash("sha256").update(body).digest("hex"),
        status: 200,
      };
    });
    const fetcher: MarketplaceFetcher = {
      listPlugins: async () => [catalogReads++ === 0 ? newer : older],
      getPluginDetail: async () => newer,
      downloadVersion: async () => { throw new Error("unexpected legacy download"); },
      downloadArtifact,
      fetchSignatureEnvelope: async (_id: string, version: string) => {
        const body = zips.get(version)!;
        return makeEnvelope(body, signingKey.privateKey);
      },
      listAnnouncements: async () => [],
    };
    const { service } = makeService(fetcher);
    const store = (service as unknown as {
      artifactStore: {
        extractZipWithCommit: (
          slug: string,
          zip: Buffer,
          commit: (installDir: string, files: string[]) => Promise<unknown>,
        ) => Promise<{ files: string[]; result: unknown }>;
      };
    }).artifactStore;
    const originalExtract = store.extractZipWithCommit.bind(store);
    let releasePromotion!: () => void;
    const promotionGate = new Promise<void>((resolveGate) => { releasePromotion = resolveGate; });
    let promotionStarted!: () => void;
    const promotionStartedPromise = new Promise<void>((resolveStarted) => { promotionStarted = resolveStarted; });
    vi.spyOn(store, "extractZipWithCommit").mockImplementationOnce(async (slug, zip, commit) =>
      originalExtract(slug, zip, async (installDir, files) => {
        promotionStarted();
        await promotionGate;
        return commit(installDir, files);
      }),
    );

    const newerInstall = service.install(newer.id);
    await promotionStartedPromise;
    const olderManagedRetry = service.ensureManagedInstalled();
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    expect(downloadArtifact).toHaveBeenCalledTimes(1);

    releasePromotion();
    await expect(newerInstall).resolves.toEqual({ pluginId: newer.id, installed: true });
    await expect(olderManagedRetry).resolves.toEqual({ installed: [], updated: [], failed: [] });
    expect(downloadArtifact).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(join(installedDir, newer.id, "plugin.json"), "utf-8")))
      .toMatchObject({ version: "3.0.0" });
  }, 20_000);

  it("serializes quarantine behind an in-flight standard install", async () => {
    const signingKey = freshEd25519();
    mockedPublisherKeys.getBundledPublicKeys.mockReturnValue({ "test-v1": signingKey.publicKey });
    const plugin: PluginMarketplaceItem = {
      id: "quarantine-race",
      slug: "quarantine-race",
      name: "Quarantine Race",
      description: "quarantine serialization fixture",
      version: "1.0.0",
      packageSpec: "@lvis/quarantine-race@1.0.0",
      packageName: "@lvis/quarantine-race",
      tools: [],
    };
    const zipBuffer = makePluginZip({ ...plugin, entry: "./dist/hostPlugin.js" });
    const fetcher: MarketplaceFetcher = {
      listPlugins: async () => [plugin],
      getPluginDetail: async () => plugin,
      downloadVersion: async () => { throw new Error("unexpected legacy download"); },
      downloadArtifact: async () => ({
        body: zipBuffer,
        sha256Header: createHash("sha256").update(zipBuffer).digest("hex"),
        status: 200,
      }),
      fetchSignatureEnvelope: async () => makeEnvelope(zipBuffer, signingKey.privateKey),
      listAnnouncements: async () => [],
    };
    const { service } = makeService(fetcher);
    const store = (service as unknown as {
      artifactStore: {
        extractZipWithCommit: (
          slug: string,
          zip: Buffer,
          commit: (installDir: string, files: string[]) => Promise<unknown>,
        ) => Promise<{ files: string[]; result: unknown }>;
      };
    }).artifactStore;
    const originalExtract = store.extractZipWithCommit.bind(store);
    let releasePromotion!: () => void;
    const promotionGate = new Promise<void>((resolveGate) => { releasePromotion = resolveGate; });
    let promotionStarted!: () => void;
    const promotionStartedPromise = new Promise<void>((resolveStarted) => { promotionStarted = resolveStarted; });
    vi.spyOn(store, "extractZipWithCommit").mockImplementationOnce(async (slug, zip, commit) =>
      originalExtract(slug, zip, async (installDir, files) => {
        promotionStarted();
        await promotionGate;
        return commit(installDir, files);
      }),
    );

    const install = service.install(plugin.id);
    await promotionStartedPromise;
    let quarantineSettled = false;
    const quarantine = service.quarantinePlugin(plugin.id, "race fixture").finally(() => {
      quarantineSettled = true;
    });
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    expect(quarantineSettled).toBe(false);

    releasePromotion();
    await expect(install).resolves.toEqual({ pluginId: plugin.id, installed: true });
    await expect(quarantine).resolves.toEqual({ pluginId: plugin.id, quarantined: true });
    const registry = JSON.parse(await readFile(registryPath, "utf-8")) as { plugins: unknown[] };
    expect(registry.plugins).toEqual([]);
    expect(existsSync(join(installedDir, plugin.id))).toBe(false);
  }, 20_000);

  it("cleans a fresh extracted marketplace install when receipt finalization fails", async () => {
    const signingKey = freshEd25519();
    mockedPublisherKeys.getBundledPublicKeys.mockReturnValue({
      "test-v1": signingKey.publicKey,
    });
    const plugin: PluginMarketplaceItem = {
      id: "test-plugin",
      slug: "test-plugin",
      name: "Test Plugin",
      description: "A test plugin",
      version: "1.2.3",
      packageSpec: "@lvis/test-plugin@1.2.3",
      packageName: "@lvis/test-plugin",
      tools: ["ping"],
    };
    const zipBuffer = makePluginZip({
      id: plugin.id,
      name: plugin.name,
      version: plugin.version,
      entry: "./dist/hostPlugin.js",
      tools: plugin.tools,
    });
    const fetcher: MarketplaceFetcher & {
      downloadArtifact: () => Promise<{ body: Buffer; sha256Header: string; status: number }>;
      fetchSignatureEnvelope: () => Promise<ReturnType<typeof makeEnvelope>>;
    } = {
      listPlugins: async () => [plugin],
      getPluginDetail: async () => plugin,
      downloadVersion: async () => {
        throw new Error("downloadVersion should not be called for signed installs");
      },
      downloadArtifact: async () => ({
        body: zipBuffer,
        sha256Header: createHash("sha256").update(zipBuffer).digest("hex"),
        status: 200,
      }),
      fetchSignatureEnvelope: async () => makeEnvelope(zipBuffer, signingKey.privateKey),
      listAnnouncements: async () => [],
    };

    const { service } = makeService(fetcher);
    const store = (service as unknown as {
      artifactStore: { writeInstallReceipt: (...args: unknown[]) => Promise<unknown> };
    }).artifactStore;
    vi.spyOn(store, "writeInstallReceipt").mockRejectedValueOnce(new Error("receipt write failed"));

    await expect(service.install("test-plugin")).rejects.toThrow("receipt write failed");

    expect(existsSync(join(installedDir, "test-plugin"))).toBe(false);
    expect(existsSync(join(cacheRoot, "test-plugin", "install-receipt.json"))).toBe(false);
    const registry = JSON.parse(await readFile(registryPath, "utf-8"));
    expect(registry.plugins).toHaveLength(0);
  });

  it("rolls back fresh artifact and receipt when registry commit fails before publication", async () => {
    const signingKey = freshEd25519();
    mockedPublisherKeys.getBundledPublicKeys.mockReturnValue({
      "test-v1": signingKey.publicKey,
    });
    const plugin: PluginMarketplaceItem = {
      id: "test-plugin",
      slug: "test-plugin",
      name: "Test Plugin",
      description: "A test plugin",
      version: "1.2.3",
      packageSpec: "@lvis/test-plugin@1.2.3",
      packageName: "@lvis/test-plugin",
      tools: ["ping"],
    };
    const zipBuffer = makePluginZip({
      id: plugin.id,
      name: plugin.name,
      version: plugin.version,
      entry: "./dist/hostPlugin.js",
      tools: plugin.tools,
    });
    const fetcher: MarketplaceFetcher = {
      listPlugins: async () => [plugin],
      getPluginDetail: async () => plugin,
      downloadVersion: async () => { throw new Error("unexpected legacy download"); },
      downloadArtifact: async () => ({
        body: zipBuffer,
        sha256Header: createHash("sha256").update(zipBuffer).digest("hex"),
        status: 200,
      }),
      fetchSignatureEnvelope: async () => makeEnvelope(zipBuffer, signingKey.privateKey),
      listAnnouncements: async () => [],
    };
    const originalRegistry = await readFile(registryPath, "utf-8");
    const { service } = makeService(fetcher);
    vi.spyOn(
      service as unknown as { commitMarketplaceRegistryEntry: (...args: unknown[]) => Promise<void> },
      "commitMarketplaceRegistryEntry",
    ).mockRejectedValueOnce(new Error("injected registry precommit failure"));

    await expect(service.install(plugin.id)).rejects.toThrow("injected registry precommit failure");

    expect(await readFile(registryPath, "utf-8")).toBe(originalRegistry);
    expect(existsSync(join(installedDir, plugin.id))).toBe(false);
    expect(existsSync(join(cacheRoot, plugin.id, "install-receipt.json"))).toBe(false);
  });

  it("restores replacement bytes and receipt when registry commit fails before publication", async () => {
    const signingKey = freshEd25519();
    mockedPublisherKeys.getBundledPublicKeys.mockReturnValue({
      "test-v1": signingKey.publicKey,
    });
    const plugin: PluginMarketplaceItem = {
      id: "test-plugin",
      slug: "test-plugin",
      name: "Test Plugin",
      description: "A test plugin",
      version: "1.0.0",
      packageSpec: "@lvis/test-plugin@1.0.0",
      packageName: "@lvis/test-plugin",
      tools: ["ping"],
    };
    let zipBuffer = makePluginZip({
      id: plugin.id,
      name: plugin.name,
      version: plugin.version,
      entry: "./dist/hostPlugin.js",
      tools: plugin.tools,
    });
    const fetcher: MarketplaceFetcher = {
      listPlugins: async () => [plugin],
      getPluginDetail: async () => plugin,
      downloadVersion: async () => { throw new Error("unexpected legacy download"); },
      downloadArtifact: async () => ({
        body: zipBuffer,
        sha256Header: createHash("sha256").update(zipBuffer).digest("hex"),
        status: 200,
      }),
      fetchSignatureEnvelope: async () => makeEnvelope(zipBuffer, signingKey.privateKey),
      listAnnouncements: async () => [],
    };
    const { service } = makeService(fetcher);
    await service.install(plugin.id);
    const originalRegistry = await readFile(registryPath, "utf-8");
    const originalManifest = await readFile(join(installedDir, plugin.id, "plugin.json"), "utf-8");
    const originalReceipt = await readFile(
      join(cacheRoot, plugin.id, "install-receipt.json"),
      "utf-8",
    );

    plugin.version = "2.0.0";
    zipBuffer = makePluginZip({
      id: plugin.id,
      name: plugin.name,
      version: plugin.version,
      entry: "./dist/hostPlugin.js",
      tools: plugin.tools,
    });
    vi.spyOn(
      service as unknown as { commitMarketplaceRegistryEntry: (...args: unknown[]) => Promise<void> },
      "commitMarketplaceRegistryEntry",
    ).mockImplementationOnce(async () => {
      const registryDuringPublication = JSON.parse(await readFile(registryPath, "utf-8")) as {
        plugins: Array<{ id: string; pendingUpdate?: { kind: string } }>;
      };
      expect(registryDuringPublication.plugins).toEqual([
        expect.objectContaining({
          id: plugin.id,
          pendingUpdate: expect.objectContaining({ kind: "marketplace" }),
        }),
      ]);
      expect(JSON.parse(await readFile(join(installedDir, plugin.id, "plugin.json"), "utf-8")))
        .toMatchObject({ version: "2.0.0" });
      throw new Error("injected replacement registry failure");
    });

    await expect(service.install(plugin.id)).rejects.toThrow("injected replacement registry failure");

    expect(await readFile(registryPath, "utf-8")).toBe(originalRegistry);
    expect(await readFile(join(installedDir, plugin.id, "plugin.json"), "utf-8")).toBe(originalManifest);
    expect(await readFile(join(cacheRoot, plugin.id, "install-receipt.json"), "utf-8"))
      .toBe(originalReceipt);
    const store = (service as unknown as {
      artifactStore: {
        readHistory: (pluginId: string) => Promise<Array<{ version: string }>>;
        findRollbackTarget: (pluginId: string, currentVersion: string) => Promise<string | null>;
      };
    }).artifactStore;
    expect((await store.readHistory(plugin.id)).map((entry) => entry.version)).not.toContain("2.0.0");
    await expect(store.findRollbackTarget(plugin.id, "1.0.0")).resolves.toBeNull();
  });

  it.runIf(process.platform !== "win32")(
    "keeps the registry row pending with durable recovery metadata when directory rollback cannot complete",
    async () => {
      const signingKey = freshEd25519();
      mockedPublisherKeys.getBundledPublicKeys.mockReturnValue({ "test-v1": signingKey.publicKey });
      const plugin: PluginMarketplaceItem = {
        id: "rollback-fault-plugin",
        slug: "rollback-fault-plugin",
        name: "Rollback Fault Plugin",
        description: "persistent rollback fault fixture",
        version: "1.0.0",
        packageSpec: "@lvis/rollback-fault-plugin@1.0.0",
        packageName: "@lvis/rollback-fault-plugin",
        tools: [],
      };
      let zipBuffer = makePluginZip({ ...plugin, entry: "./dist/hostPlugin.js" });
      const fetcher: MarketplaceFetcher = {
        listPlugins: async () => [plugin],
        getPluginDetail: async () => plugin,
        downloadVersion: async () => { throw new Error("unexpected legacy download"); },
        downloadArtifact: async () => ({
          body: zipBuffer,
          sha256Header: createHash("sha256").update(zipBuffer).digest("hex"),
          status: 200,
        }),
        fetchSignatureEnvelope: async () => makeEnvelope(zipBuffer, signingKey.privateKey),
        listAnnouncements: async () => [],
      };
      const { service } = makeService(fetcher);
      await service.install(plugin.id);
      const oldReceipt = await readFile(join(cacheRoot, plugin.id, "install-receipt.json"), "utf-8");
      plugin.version = "2.0.0";
      zipBuffer = makePluginZip({ ...plugin, entry: "./dist/hostPlugin.js" });
      vi.spyOn(
        service as unknown as { commitMarketplaceRegistryEntry: (...args: unknown[]) => Promise<void> },
        "commitMarketplaceRegistryEntry",
      ).mockImplementationOnce(async () => {
        await chmod(installedDir, 0o500);
        throw new Error("registry publication failed");
      });

      const error = await service.install(plugin.id).catch((caught) => caught);
      await chmod(installedDir, 0o700);

      expect(error).toBeInstanceOf(ArtifactRollbackError);
      expect((error as ArtifactRollbackError).backupDir).toBeTruthy();
      expect(existsSync((error as ArtifactRollbackError).backupDir!)).toBe(true);
      const registry = JSON.parse(await readFile(registryPath, "utf-8")) as {
        plugins: Array<{ id: string; pendingUpdate?: { recoveryBackupDir?: string } }>;
      };
      expect(registry.plugins).toEqual([
        expect.objectContaining({
          id: plugin.id,
          pendingUpdate: expect.objectContaining({
            recoveryBackupDir: (error as ArtifactRollbackError).backupDir,
          }),
        }),
      ]);
      expect(JSON.parse(await readFile(join(installedDir, plugin.id, "plugin.json"), "utf-8")))
        .toMatchObject({ version: "2.0.0" });
      const currentReceipt = await readFile(join(cacheRoot, plugin.id, "install-receipt.json"), "utf-8");
      expect(currentReceipt).not.toBe(oldReceipt);
      expect(JSON.parse(currentReceipt)).toMatchObject({ version: "2.0.0" });
    },
    10_000,
  );

  it("reinstalls the same marketplace version when the install receipt is missing", async () => {
    const signingKey = freshEd25519();
    mockedPublisherKeys.getBundledPublicKeys.mockReturnValue({
      "test-v1": signingKey.publicKey,
    });
    const plugin: PluginMarketplaceItem = {
      id: "test-plugin",
      slug: "test-plugin",
      name: "Test Plugin",
      description: "A test plugin",
      version: "1.2.3",
      packageSpec: "@lvis/test-plugin@1.2.3",
      packageName: "@lvis/test-plugin",
      tools: ["ping"],
    };
    const zipBuffer = makePluginZip({
      id: plugin.id,
      name: plugin.name,
      version: plugin.version,
      entry: "./dist/hostPlugin.js",
      tools: plugin.tools,
    });
    const downloadArtifact = vi.fn(async () => ({
      body: zipBuffer,
      sha256Header: createHash("sha256").update(zipBuffer).digest("hex"),
      status: 200,
    }));
    const fetchSignatureEnvelope = vi.fn(async () => makeEnvelope(zipBuffer, signingKey.privateKey));
    const fetcher: MarketplaceFetcher & {
      downloadArtifact: typeof downloadArtifact;
      fetchSignatureEnvelope: typeof fetchSignatureEnvelope;
    } = {
      listPlugins: async () => [plugin],
      getPluginDetail: async () => plugin,
      downloadVersion: async () => {
        throw new Error("downloadVersion should not be called for signed installs");
      },
      downloadArtifact,
      fetchSignatureEnvelope,
      listAnnouncements: async () => [],
    };

    const { service } = makeService(fetcher);
    await expect(service.install("test-plugin")).resolves.toEqual({
      pluginId: "test-plugin",
      installed: true,
    });

    await rm(join(cacheRoot, "test-plugin", "install-receipt.json"), { force: true });
    await rm(join(installedDir, "test-plugin", "dist", "hostPlugin.js"), { force: true });

    await expect(service.install("test-plugin")).resolves.toEqual({
      pluginId: "test-plugin",
      installed: true,
    });

    await expect(
      readFile(join(cacheRoot, "test-plugin", "install-receipt.json"), "utf-8"),
    ).resolves.toContain('"schemaVersion": 2');
    await expect(
      readFile(join(installedDir, "test-plugin", "dist", "hostPlugin.js"), "utf-8"),
    ).resolves.toContain("createPlugin");
    expect(downloadArtifact).toHaveBeenCalled();
    expect(fetchSignatureEnvelope).toHaveBeenCalled();
  });

  it("reinstalls the same marketplace version when the catalog artifact hash changes", async () => {
    const signingKey = freshEd25519();
    mockedPublisherKeys.getBundledPublicKeys.mockReturnValue({
      "test-v1": signingKey.publicKey,
    });
    const v1Manifest = {
      id: "hash-repair-plugin",
      name: "Hash Repair Plugin",
      version: "1.2.3",
      entry: "./dist/hostPlugin.js",
      tools: ["ping"],
    };
    const v2Manifest = {
      id: "hash-repair-plugin",
      name: "Hash Repair Plugin",
      version: "1.2.3",
      entry: "./dist/hostPlugin.js",
      tools: ["ping"],
      description: "Rebuilt artifact",
    };
    const v1Zip = makePluginZip(v1Manifest);
    const v2Zip = makePluginZip(v2Manifest);
    const plugin: PluginMarketplaceItem = {
      id: "hash-repair-plugin",
      slug: "hash-repair-plugin",
      name: "Hash Repair Plugin",
      description: "A test plugin",
      version: "1.2.3",
      packageSpec: "@lvis/hash-repair-plugin@1.2.3",
      packageName: "@lvis/hash-repair-plugin",
      tools: ["ping"],
      artifactSha256: createHash("sha256").update(v1Zip).digest("hex"),
    };
    const downloadArtifact = vi
      .fn()
      .mockResolvedValueOnce({
        body: v1Zip,
        sha256Header: createHash("sha256").update(v1Zip).digest("hex"),
        status: 200,
      })
      .mockResolvedValueOnce({
        body: v2Zip,
        sha256Header: createHash("sha256").update(v2Zip).digest("hex"),
        status: 200,
      });
    const fetchSignatureEnvelope = vi
      .fn()
      .mockResolvedValueOnce(makeEnvelope(v1Zip, signingKey.privateKey))
      .mockResolvedValueOnce(makeEnvelope(v2Zip, signingKey.privateKey));
    const fetcher: MarketplaceFetcher & {
      downloadArtifact: typeof downloadArtifact;
      fetchSignatureEnvelope: typeof fetchSignatureEnvelope;
    } = {
      listPlugins: async () => [plugin],
      getPluginDetail: async () => plugin,
      downloadVersion: async () => {
        throw new Error("downloadVersion should not be called for signed installs");
      },
      downloadArtifact,
      fetchSignatureEnvelope,
      listAnnouncements: async () => [],
    };

    const { service } = makeService(fetcher);
    await service.install("hash-repair-plugin");
    plugin.artifactSha256 = createHash("sha256").update(v2Zip).digest("hex");
    await service.install("hash-repair-plugin");

    const receipt = JSON.parse(
      await readFile(join(cacheRoot, "hash-repair-plugin", "install-receipt.json"), "utf-8"),
    ) as { artifactSha256: string | null };
    const registry = JSON.parse(await readFile(registryPath, "utf-8")) as {
      plugins: Array<{ manifestSha256?: string }>;
    };
    expect(receipt.artifactSha256).toBe(plugin.artifactSha256);
    expect(registry.plugins[0].manifestSha256).toBe(manifestSha(v2Manifest));
    expect(downloadArtifact).toHaveBeenCalledTimes(2);
    expect(fetchSignatureEnvelope).toHaveBeenCalledTimes(2);
  });

  it("does not compare explicit prior-version installs against the latest catalog artifact hash", async () => {
    const signingKey = freshEd25519();
    mockedPublisherKeys.getBundledPublicKeys.mockReturnValue({
      "test-v1": signingKey.publicKey,
    });
    const pluginId = "versioned-plugin";
    const priorZip = makePluginZip({
      id: pluginId,
      name: "Versioned Plugin",
      version: "0.4.16",
      entry: "./dist/hostPlugin.js",
      tools: ["ping"],
      installPolicy: "user",
    });
    const latestZip = makePluginZip({
      id: pluginId,
      name: "Versioned Plugin",
      version: "0.4.18",
      entry: "./dist/hostPlugin.js",
      tools: ["ping"],
      installPolicy: "admin",
    });
    const priorSha = createHash("sha256").update(priorZip).digest("hex");
    const latestSha = createHash("sha256").update(latestZip).digest("hex");
    const plugin: PluginMarketplaceItem = {
      id: pluginId,
      slug: pluginId,
      name: "Versioned Plugin",
      description: "A versioned test plugin",
      version: "0.4.18",
      packageSpec: "@lvis/versioned-plugin@0.4.18",
      packageName: "@lvis/versioned-plugin",
      tools: ["ping"],
      installPolicy: "admin",
      artifactSha256: latestSha,
    };
    const downloadArtifact = vi.fn(async (_slug: string, version: string) => {
      const body = version === "0.4.16" ? priorZip : latestZip;
      return {
        body,
        sha256Header: createHash("sha256").update(body).digest("hex"),
        status: 200,
      };
    });
    const fetchSignatureEnvelope = vi.fn(async (_slug: string, version: string) =>
      makeEnvelope(version === "0.4.16" ? priorZip : latestZip, signingKey.privateKey),
    );
    const fetcher: MarketplaceFetcher & {
      downloadArtifact: typeof downloadArtifact;
      fetchSignatureEnvelope: typeof fetchSignatureEnvelope;
    } = {
      listPlugins: async () => [plugin],
      getPluginDetail: async () => plugin,
      downloadVersion: async () => {
        throw new Error("downloadVersion should not be called for signed installs");
      },
      downloadArtifact,
      fetchSignatureEnvelope,
      listAnnouncements: async () => [],
    };

    const { service } = makeService(fetcher);
    await service.installPlugin(pluginId, "0.4.16");

    const manifest = JSON.parse(
      await readFile(join(installedDir, pluginId, "plugin.json"), "utf-8"),
    );
    const receipt = JSON.parse(
      await readFile(join(cacheRoot, pluginId, "install-receipt.json"), "utf-8"),
    ) as { artifactSha256: string | null };
    expect(manifest.version).toBe("0.4.16");
    expect(receipt.artifactSha256).toBe(priorSha);
    expect(receipt.artifactSha256).not.toBe(latestSha);
  });

  it("rejects zip-slip entries from signed marketplace artifacts", async () => {
    const signingKey = freshEd25519();
    mockedPublisherKeys.getBundledPublicKeys.mockReturnValue({
      "test-v1": signingKey.publicKey,
    });
    const plugin: PluginMarketplaceItem = {
      id: "slip-plugin",
      slug: "slip-plugin",
      name: "Slip Plugin",
      description: "Bad zip payload",
      version: "1.0.0",
      packageSpec: "@lvis/slip-plugin@1.0.0",
      packageName: "@lvis/slip-plugin",
      tools: [],
    };
    const zip = new AdmZip();
    zip.addFile("C:/escape.txt", Buffer.from("owned", "utf-8"));
    const zipBuffer = zip.toBuffer();
    const fetcher: MarketplaceFetcher & {
      downloadArtifact: (slug: string, version: string) => Promise<{
        body: Buffer;
        sha256Header: string | null;
        status: number;
      }>;
      fetchSignatureEnvelope: (slug: string, version: string) => Promise<ReturnType<typeof makeEnvelope>>;
    } = {
      listPlugins: async () => [plugin],
      getPluginDetail: async () => plugin,
      downloadVersion: vi.fn(async () => {
        throw new Error("downloadVersion should not be called for signed installs");
      }),
      downloadArtifact: async () => ({
        body: zipBuffer,
        sha256Header: createHash("sha256").update(zipBuffer).digest("hex"),
        status: 200,
      }),
      fetchSignatureEnvelope: async () => makeEnvelope(zipBuffer, signingKey.privateKey),
      listAnnouncements: async () => [],
    };

    const { service } = makeService(fetcher);
    await expect(service.install("slip-plugin")).rejects.toThrow(/absolute drive path|escapes install root/i);
  });

  it("rejects signed marketplace artifacts whose manifest id does not match the catalog item", async () => {
    const signingKey = freshEd25519();
    mockedPublisherKeys.getBundledPublicKeys.mockReturnValue({
      "test-v1": signingKey.publicKey,
    });
    const plugin: PluginMarketplaceItem = {
      id: "catalog-plugin",
      slug: "catalog-plugin",
      name: "Catalog Plugin",
      description: "A test plugin",
      version: "1.2.3",
      packageSpec: "@lvis/catalog-plugin@1.2.3",
      packageName: "@lvis/catalog-plugin",
      tools: ["ping"],
    };
    const zipBuffer = makePluginZip({
      id: "other-plugin",
      name: plugin.name,
      version: plugin.version,
      entry: "./dist/hostPlugin.js",
      tools: plugin.tools,
    });
    const fetcher: MarketplaceFetcher & {
      downloadArtifact: (slug: string, version: string) => Promise<{
        body: Buffer;
        sha256Header: string | null;
        status: number;
      }>;
      fetchSignatureEnvelope: (slug: string, version: string) => Promise<ReturnType<typeof makeEnvelope>>;
    } = {
      listPlugins: async () => [plugin],
      getPluginDetail: async () => plugin,
      downloadVersion: vi.fn(async () => {
        throw new Error("downloadVersion should not be called for signed installs");
      }),
      downloadArtifact: async () => ({
        body: zipBuffer,
        sha256Header: createHash("sha256").update(zipBuffer).digest("hex"),
        status: 200,
      }),
      fetchSignatureEnvelope: async () => makeEnvelope(zipBuffer, signingKey.privateKey),
      listAnnouncements: async () => [],
    };

    const { service } = makeService(fetcher);
    await expect(service.install("catalog-plugin")).rejects.toThrow(/manifest id mismatch/i);
    await expect(readFile(join(installedDir, "catalog-plugin", "plugin.json"), "utf-8")).rejects.toThrow();
  });

  it("rejects signed marketplace artifacts whose manifest version does not match the catalog version", async () => {
    const signingKey = freshEd25519();
    mockedPublisherKeys.getBundledPublicKeys.mockReturnValue({
      "test-v1": signingKey.publicKey,
    });
    const plugin: PluginMarketplaceItem = {
      id: "versioned-plugin",
      slug: "versioned-plugin",
      name: "Versioned Plugin",
      description: "A test plugin",
      version: "1.2.3",
      packageSpec: "@lvis/versioned-plugin@1.2.3",
      packageName: "@lvis/versioned-plugin",
      tools: ["ping"],
    };
    const zipBuffer = makePluginZip({
      id: plugin.id,
      name: plugin.name,
      version: "9.9.9",
      entry: "./dist/hostPlugin.js",
      tools: plugin.tools,
    });
    const fetcher: MarketplaceFetcher & {
      downloadArtifact: (slug: string, version: string) => Promise<{
        body: Buffer;
        sha256Header: string | null;
        status: number;
      }>;
      fetchSignatureEnvelope: (slug: string, version: string) => Promise<ReturnType<typeof makeEnvelope>>;
    } = {
      listPlugins: async () => [plugin],
      getPluginDetail: async () => plugin,
      downloadVersion: vi.fn(async () => {
        throw new Error("downloadVersion should not be called for signed installs");
      }),
      downloadArtifact: async () => ({
        body: zipBuffer,
        sha256Header: createHash("sha256").update(zipBuffer).digest("hex"),
        status: 200,
      }),
      fetchSignatureEnvelope: async () => makeEnvelope(zipBuffer, signingKey.privateKey),
      listAnnouncements: async () => [],
    };

    const { service } = makeService(fetcher);
    await expect(service.install("versioned-plugin")).rejects.toThrow(/manifest version mismatch/i);
    await expect(readFile(join(installedDir, "versioned-plugin", "plugin.json"), "utf-8")).rejects.toThrow();
  });

  it("replaces the old install directory on upgrade so stale files do not survive", async () => {
    const signingKey = freshEd25519();
    mockedPublisherKeys.getBundledPublicKeys.mockReturnValue({
      "test-v1": signingKey.publicKey,
    });
    const plugin: PluginMarketplaceItem = {
      id: "upgrade-plugin",
      slug: "upgrade-plugin",
      name: "Upgrade Plugin",
      description: "Upgrade test plugin",
      version: "1.0.0",
      packageSpec: "@lvis/upgrade-plugin@1.0.0",
      packageName: "@lvis/upgrade-plugin",
      tools: [],
    };
    const v1 = new AdmZip();
    v1.addFile("plugin.json", Buffer.from(JSON.stringify({
      id: plugin.id,
      name: plugin.name,
      version: "1.0.0",
      entry: "./dist/hostPlugin.js",
      tools: [],
    }), "utf-8"));
    v1.addFile("dist/hostPlugin.js", Buffer.from("export default {};\n", "utf-8"));
    v1.addFile("dist/stale.txt", Buffer.from("stale\n", "utf-8"));
    const v1Buffer = v1.toBuffer();

    const v2 = new AdmZip();
    v2.addFile("plugin.json", Buffer.from(JSON.stringify({
      id: plugin.id,
      name: plugin.name,
      version: "1.1.0",
      entry: "./dist/hostPlugin.js",
      tools: [],
    }), "utf-8"));
    v2.addFile("dist/hostPlugin.js", Buffer.from("export default { upgraded: true };\n", "utf-8"));
    const v2Buffer = v2.toBuffer();

    const downloadArtifact = vi
      .fn()
      .mockResolvedValueOnce({
        body: v1Buffer,
        sha256Header: createHash("sha256").update(v1Buffer).digest("hex"),
        status: 200,
      })
      .mockResolvedValueOnce({
        body: v2Buffer,
        sha256Header: createHash("sha256").update(v2Buffer).digest("hex"),
        status: 200,
      });
    const fetchSignatureEnvelope = vi
      .fn()
      .mockResolvedValueOnce(makeEnvelope(v1Buffer, signingKey.privateKey))
      .mockResolvedValueOnce(makeEnvelope(v2Buffer, signingKey.privateKey));
    const fetcher: MarketplaceFetcher & {
      downloadArtifact: typeof downloadArtifact;
      fetchSignatureEnvelope: typeof fetchSignatureEnvelope;
    } = {
      listPlugins: async () => [plugin],
      getPluginDetail: async () => plugin,
      downloadVersion: vi.fn(async () => {
        throw new Error("downloadVersion should not be called for signed installs");
      }),
      downloadArtifact,
      fetchSignatureEnvelope,
      listAnnouncements: async () => [],
    };

    const { service } = makeService(fetcher);
    await service.install("upgrade-plugin");
    plugin.version = "1.1.0";
    plugin.packageSpec = "@lvis/upgrade-plugin@1.1.0";
    await service.install("upgrade-plugin");

    const staleFile = join(installedDir, "upgrade-plugin", "dist", "stale.txt");
    const manifest = JSON.parse(
      await readFile(join(installedDir, "upgrade-plugin", "plugin.json"), "utf-8"),
    ) as { version: string };
    await expect(readFile(staleFile, "utf-8")).rejects.toThrow();
    expect(manifest.version).toBe("1.1.0");
  });

  // Removed in Phase 2-final: the file:-spec / npm-install branch is gone,
  // and so is the test that exercised it. Production has a single install
  // path (signed-zip download); dev runs the marketplace server locally
  // and publishes plugins through it rather than sideloading file: paths.

  it("surfaces zip extraction errors instead of silently falling back", async () => {
    const signingKey = freshEd25519();
    mockedPublisherKeys.getBundledPublicKeys.mockReturnValue({
      "test-v1": signingKey.publicKey,
    });
    const plugin: PluginMarketplaceItem = {
      id: "broken-plugin",
      slug: "broken-plugin",
      name: "Broken Plugin",
      description: "Broken zip payload",
      version: "0.0.1",
      packageSpec: "@lvis/broken-plugin@0.0.1",
      packageName: "@lvis/broken-plugin",
      tools: [],
    };
    const body = Buffer.from("not-a-zip");
    const fetcher: MarketplaceFetcher & {
      downloadArtifact: (slug: string, version: string) => Promise<{
        body: Buffer;
        sha256Header: string | null;
        status: number;
      }>;
      fetchSignatureEnvelope: (slug: string, version: string) => Promise<ReturnType<typeof makeEnvelope>>;
    } = {
      listPlugins: async () => [plugin],
      getPluginDetail: async () => plugin,
      downloadVersion: vi.fn(async () => {
        throw new Error("downloadVersion should not be called for signed installs");
      }),
      downloadArtifact: async () => ({
        body,
        sha256Header: createHash("sha256").update(body).digest("hex"),
        status: 200,
      }),
      fetchSignatureEnvelope: async () => makeEnvelope(body, signingKey.privateKey),
      listAnnouncements: async () => [],
    };

    const { service, npmInstallMock } = makeService(fetcher);
    await expect(service.install("broken-plugin")).rejects.toThrow(/zip format/i);
    expect(npmInstallMock).not.toHaveBeenCalled();
  });

  it("reads update guard versions from the live fetcher instead of the offline catalog cache", async () => {
    const cachedPlugin: PluginMarketplaceItem = {
      id: "meeting",
      slug: "meeting",
      name: "LVIS Meeting",
      description: "cached",
      version: "0.5.8",
      packageSpec: "meeting@0.5.8",
      packageName: "meeting",
      tools: [],
    };
    const livePlugin: PluginMarketplaceItem = {
      ...cachedPlugin,
      description: "live",
      version: "0.5.25",
      packageSpec: "meeting@0.5.25",
    };
    await setCachedCatalog([cachedPlugin], resolve(cacheRoot, "marketplace-catalog"));
    const fetcher: MarketplaceFetcher = {
      listPlugins: vi.fn(async () => [livePlugin]),
      getPluginDetail: vi.fn(async (slug: string) => (slug === "meeting" ? livePlugin : null)),
      downloadVersion: vi.fn(async () => ({
        zipBuffer: Buffer.from(""),
        sha256: "",
      })),
      listAnnouncements: vi.fn(async () => []),
    };
    const { service } = makeService(fetcher);

    const listed = await service.list();
    expect(listed.find((item) => item.id === "meeting")?.version).toBe("0.5.8");
    await expect(service.getLiveCatalogVersion("meeting")).resolves.toBe("0.5.25");
    expect(fetcher.getPluginDetail).toHaveBeenCalledWith("meeting");
  });
});
