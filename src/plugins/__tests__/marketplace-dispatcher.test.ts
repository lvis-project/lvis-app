import { createHash, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AdmZip from "adm-zip";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const mockedPublisherKeys = vi.hoisted(() => ({
  getBundledPublicKeys: vi.fn(),
}));

vi.mock("../publisher-keys.js", () => ({
  getBundledPublicKeys: mockedPublisherKeys.getBundledPublicKeys,
}));

import { PluginMarketplaceService } from "../marketplace.js";
import type { MarketplaceFetcher } from "../marketplace-fetcher.js";
import type { PluginMarketplaceItem } from "../types.js";
import { _resetForTest, setIsPackaged } from "../../boot/dev-flags.js";
import { makeTestPluginPaths } from "./test-helpers.js";

function makePluginZip(manifest: Record<string, unknown>): Buffer {
  const zip = new AdmZip();
  zip.addFile("plugin.json", Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf-8"));
  zip.addFile(
    "dist/hostPlugin.js",
    Buffer.from("export default async function createPlugin() { return { handlers: {} }; }\n", "utf-8"),
  );
  return zip.toBuffer();
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
    testDir = join(
      homedir(),
      ".lvis",
      "test-tmp",
      `lvis-marketplace-install-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    appRoot = testDir;
    // Phase 2a: registry + installed plugins live under userInstalledDir
    // (testDir/plugins). The legacy `installed/` subdir is gone.
    installedDir = join(testDir, "plugins");
    registryPath = join(installedDir, "registry.json");
    cacheRoot = join(testDir, ".cache");
    await mkdir(installedDir, { recursive: true });
    await writeFile(registryPath, JSON.stringify({ version: 1, plugins: [] }), "utf-8");
    mockedPublisherKeys.getBundledPublicKeys.mockReset();
  });

  afterEach(async () => {
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
      userInstalledDir: installedDir,
      cacheRoot,
    });
    const service = new PluginMarketplaceService(appRoot, paths, fetcher);

    const npmInstallMock = vi.fn(async () => {});
    (service as unknown as { runNpmInstall: typeof npmInstallMock }).runNpmInstall = npmInstallMock;

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
    const zipBuffer = makePluginZip({
      id: plugin.id,
      name: plugin.name,
      version: plugin.version,
      entry: "./dist/hostPlugin.js",
      tools: plugin.tools,
    });
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
    };

    const { service, npmInstallMock } = makeService(fetcher);
    await expect(service.install("test-plugin")).resolves.toEqual({
      pluginId: "test-plugin",
      installed: true,
    });

    expect(downloadArtifact).toHaveBeenCalledWith("test-plugin", "1.2.3");
    expect(fetchSignatureEnvelope).toHaveBeenCalledWith("test-plugin", "1.2.3");
    expect(downloadVersion).not.toHaveBeenCalled();
    expect(npmInstallMock).not.toHaveBeenCalled();

    const registry = JSON.parse(await readFile(registryPath, "utf-8")) as {
      plugins: Array<{ manifestPath: string }>;
    };
    const manifest = JSON.parse(
      await readFile(manifestPathToAbs(registry.plugins[0].manifestPath), "utf-8"),
    ) as { version: string; entry: string };
    expect(manifest.version).toBe("1.2.3");
    expect(manifest.entry).toBe("./dist/hostPlugin.js");
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

  it("uses the local file install path for file: package specs", async () => {
    const localPackageDir = join(appRoot, "fixtures", "local-plugin");
    await mkdir(localPackageDir, { recursive: true });
    await mkdir(join(appRoot, "node_modules", "@lvis", "local-plugin", "dist"), { recursive: true });
    await writeFile(
      join(appRoot, "node_modules", "@lvis", "local-plugin", "dist", "hostPlugin.js"),
      "export default async function createPlugin() { return { handlers: {} }; }\n",
      "utf-8",
    );

    const plugin: PluginMarketplaceItem = {
      id: "local-plugin",
      name: "Local Plugin",
      description: "A local plugin",
      version: "0.2.0",
      packageSpec: "file:fixtures/local-plugin",
      packageName: "@lvis/local-plugin",
      tools: [],
    };
    const downloadVersion = vi.fn(async () => {
      throw new Error("downloadVersion should not be called for file: installs");
    });
    const fetcher: MarketplaceFetcher = {
      listPlugins: async () => [plugin],
      getPluginDetail: async () => plugin,
      downloadVersion,
    };

    const { service, npmInstallMock } = makeService(fetcher);
    await expect(service.install("local-plugin")).resolves.toEqual({
      pluginId: "local-plugin",
      installed: true,
    });

    expect(downloadVersion).not.toHaveBeenCalled();
    expect(npmInstallMock).toHaveBeenCalledOnce();
    expect(npmInstallMock.mock.calls[0][0]).toMatch(/^file:/);

    const registry = JSON.parse(await readFile(registryPath, "utf-8")) as {
      plugins: Array<{ manifestPath: string }>;
    };
    const manifest = JSON.parse(
      await readFile(manifestPathToAbs(registry.plugins[0].manifestPath), "utf-8"),
    ) as { version: string; packageName: string };
    expect(manifest.version).toBe("0.2.0");
    expect(manifest.packageName).toBe("@lvis/local-plugin");
  });

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
    };

    const { service, npmInstallMock } = makeService(fetcher);
    await expect(service.install("broken-plugin")).rejects.toThrow(/zip format/i);
    expect(npmInstallMock).not.toHaveBeenCalled();
  });
});
