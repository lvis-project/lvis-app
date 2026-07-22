import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockMarketplaceFetcher, PluginMarketplaceService } from "../marketplace.js";
import { _resetForTest, setIsPackaged } from "../../boot/dev-flags.js";
import { makeTestPluginPaths } from "./test-helpers.js";
import { canonicalJSON } from "../whitelist/canonical-json.js";

function manifestSha(manifest: unknown): string {
  return createHash("sha256").update(canonicalJSON(manifest)).digest("hex");
}

describe("PluginMarketplaceService.installLocal", () => {
  let testDir: string;
  let pluginsDir: string;
  let registryPath: string;
  let cacheRoot: string;
  let sourceDir: string;
  let priorEnv: string | undefined;

  beforeEach(async () => {
    setIsPackaged(false);
    priorEnv = process.env.LVIS_DEV;
    process.env.LVIS_DEV = "1";

    testDir = mkdtempSync(join(tmpdir(), "lvis-install-local-"));
    pluginsDir = join(testDir, "plugins");
    cacheRoot = join(pluginsDir, ".cache");
    registryPath = join(pluginsDir, "registry.json");
    sourceDir = join(testDir, "src-plugin");
    await mkdir(pluginsDir, { recursive: true });
    await writeFile(
      registryPath,
      JSON.stringify({ version: 1, plugins: [] }),
      "utf-8",
    );

    // Source plugin: minimal Phase 1-shaped manifest + a dist/ entry.
    await mkdir(join(sourceDir, "dist"), { recursive: true });
    await writeFile(
      join(sourceDir, "plugin.json"),
      JSON.stringify(
        {
          id: "test-plugin",
          name: "Test Plugin",
          version: "1.2.3",
          description: "fixture",
          publisher: "tests",
          entry: "dist/hostPlugin.js",
        },
        null,
        2,
      ),
      "utf-8",
    );
    await writeFile(
      join(sourceDir, "dist", "hostPlugin.js"),
      "export default {};\n",
      "utf-8",
    );
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
    if (priorEnv === undefined) {
      delete process.env.LVIS_DEV;
    } else {
      process.env.LVIS_DEV = priorEnv;
    }
    _resetForTest();
  });

  function makeService(): PluginMarketplaceService {
    const paths = makeTestPluginPaths({
      rootDir: testDir,
      pluginsRoot: pluginsDir,
      cacheRoot,
    });
    const fetcher = new MockMarketplaceFetcher(join(testDir, "marketplace.json"));
    return new PluginMarketplaceService(paths, fetcher);
  }

  it("resolves a local plugin id without mutating install storage", async () => {
    const service = makeService();

    await expect(service.resolveLocalInstallPluginId(sourceDir)).resolves.toBe("test-plugin");

    expect(existsSync(join(pluginsDir, "test-plugin"))).toBe(false);
    const registry = JSON.parse(await readFile(registryPath, "utf-8")) as {
      plugins?: unknown[];
    };
    expect(registry.plugins).toEqual([]);
  });

  it("skips node_modules/electron, .git, and nested node_modules/electron during cp", async () => {
    // Keep this fixture inert because the canonical test runner itself uses
    // Electron's patched fs. The contract here is excluding the Electron tree,
    // not asking the runner to parse an intentionally corrupt ASAR archive.
    const electronDir = join(sourceDir, "node_modules", "electron", "dist", "Electron.app", "Contents", "Resources");
    await mkdir(electronDir, { recursive: true });
    const electronFixture = join(electronDir, "electron-fixture.bin");
    await writeFile(electronFixture, Buffer.from([0, 1, 2, 3]));
    expect(existsSync(electronFixture)).toBe(true);
    // Sibling dep that SHOULD be copied (plugin runtime needs it).
    await mkdir(join(sourceDir, "node_modules", "node-ical"), { recursive: true });
    await writeFile(
      join(sourceDir, "node_modules", "node-ical", "index.js"),
      "module.exports = {};\n",
    );
    // Monorepo-style nested node_modules/electron — must also be skipped.
    const nestedElectron = join(sourceDir, "packages", "child", "node_modules", "electron");
    await mkdir(nestedElectron, { recursive: true });
    await writeFile(join(nestedElectron, "package.json"), '{"name":"electron"}\n');
    // .git tree present at install time so the filter can be observed.
    await mkdir(join(sourceDir, ".git"), { recursive: true });
    await writeFile(join(sourceDir, ".git", "HEAD"), "ref: refs/heads/main\n");

    const service = makeService();
    await service.installLocal(sourceDir);

    const installDir = join(pluginsDir, "test-plugin");
    expect(existsSync(join(installDir, "node_modules", "electron"))).toBe(false);
    expect(existsSync(join(installDir, ".git"))).toBe(false);
    expect(
      existsSync(join(installDir, "packages", "child", "node_modules", "electron")),
    ).toBe(false);
    // Non-electron deps must survive.
    expect(
      existsSync(join(installDir, "node_modules", "node-ical", "index.js")),
    ).toBe(true);
  });

  it("rejects manifests that lack a string version field — and leaves no partial install dir / registry entry", async () => {
    await writeFile(
      join(sourceDir, "plugin.json"),
      JSON.stringify({
        id: "test-plugin",
        name: "Test Plugin",
        description: "fixture",
        publisher: "tests",
        entry: "dist/hostPlugin.js",
      }),
      "utf-8",
    );

    const service = makeService();
    await expect(service.installLocal(sourceDir)).rejects.toThrow(/non-empty 'version' string/);

    // The throw fires before any filesystem mutation, so the install
    // dir must NOT exist and the registry must remain empty.
    expect(existsSync(join(pluginsDir, "test-plugin"))).toBe(false);
    const reg = JSON.parse(await readFile(registryPath, "utf-8"));
    expect(reg.plugins).toHaveLength(0);
  });

  it("promotes an existing legacy dev-link entry (rewritten to local-dev on read) and re-stamps installSource='local-dev'", async () => {
    // Pre-populate registry with a legacy dev-link entry. readPluginRegistry
    // rewrites it to "local-dev" on read; installLocal then re-stamps the
    // entry, leaving installSource on "local-dev" (its declared policy is
    // not admin).
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: "test-plugin",
            manifestPath: "test-plugin/plugin.json",
            enabled: true,
            installSource: "dev-link",
          },
        ],
      }),
      "utf-8",
    );

    const service = makeService();
    await service.installLocal(sourceDir);

    const reg = JSON.parse(await readFile(registryPath, "utf-8"));
    const entry = reg.plugins.find((p: { id: string }) => p.id === "test-plugin");
    expect(entry).toBeDefined();
    expect(entry.installSource).toBe("local-dev");
  });

  it("writes a fresh install receipt covering plugin.json + dist files", async () => {
    const service = makeService();
    await service.installLocal(sourceDir);

    const installedManifest = JSON.parse(
      await readFile(join(pluginsDir, "test-plugin", "plugin.json"), "utf-8"),
    );
    const registry = JSON.parse(await readFile(registryPath, "utf-8"));
    expect(registry.plugins[0].manifestSha256).toBe(manifestSha(installedManifest));

    const receiptPath = join(cacheRoot, "test-plugin", "install-receipt.json");
    expect(existsSync(receiptPath)).toBe(true);

    const receipt = JSON.parse(await readFile(receiptPath, "utf-8"));
    expect(receipt.schemaVersion).toBe(2);
    expect(receipt.installSource).toBe("local-dev");
    expect(receipt.pluginId).toBe("test-plugin");
    expect(receipt.version).toBe("1.2.3");
    expect(receipt.signerKeyId).toBeNull();
    expect(receipt.artifactSha256).toBeNull();

    const paths = receipt.files.map((f: { path: string }) => f.path).sort();
    expect(paths).toContain("plugin.json");
    expect(paths).toContain("dist/hostPlugin.js");
    // node_modules paths must NOT be in the receipt — those are runtime
    // deps, not integrity-tracked artifacts.
    for (const p of paths) {
      expect(p.startsWith("node_modules/")).toBe(false);
    }
  });

  it("install receipt verifies cleanly against installed files", async () => {
    const service = makeService();
    await service.installLocal(sourceDir);

    const { verifyInstallReceipt } = await import("../plugin-install-receipt.js");
    const installDir = join(pluginsDir, "test-plugin");
    const result = await verifyInstallReceipt(cacheRoot, "test-plugin", installDir);
    expect(result.ok).toBe(true);
  });

  it("cleans fresh local install dir, registry, and receipt when finalization fails", async () => {
    const service = makeService();
    const store = (service as unknown as {
      artifactStore: { writeInstallReceipt: (...args: unknown[]) => Promise<unknown> };
    }).artifactStore;
    vi.spyOn(store, "writeInstallReceipt").mockImplementationOnce(async () => {
      const registryDuringReceipt = JSON.parse(await readFile(registryPath, "utf-8")) as {
        plugins: Array<{ id: string }>;
      };
      expect(registryDuringReceipt.plugins).toEqual([]);
      throw new Error("receipt write failed");
    });

    await expect(service.installLocal(sourceDir)).rejects.toThrow("receipt write failed");

    expect(existsSync(join(pluginsDir, "test-plugin"))).toBe(false);
    expect(existsSync(join(cacheRoot, "test-plugin", "install-receipt.json"))).toBe(false);

    const reg = JSON.parse(await readFile(registryPath, "utf-8"));
    expect(reg.plugins).toHaveLength(0);
  });

  it("hides an existing entry until its replacement receipt is durable", async () => {
    const service = makeService();
    await service.installLocal(sourceDir);
    const oldReceipt = await readFile(
      join(cacheRoot, "test-plugin", "install-receipt.json"),
      "utf-8",
    );
    await writeFile(
      join(sourceDir, "plugin.json"),
      JSON.stringify({
        id: "test-plugin",
        name: "Test Plugin",
        version: "2.0.0",
        description: "fixture v2",
        publisher: "tests",
        entry: "dist/hostPlugin.js",
      }),
      "utf-8",
    );
    const store = (service as unknown as {
      artifactStore: { writeInstallReceipt: (...args: unknown[]) => Promise<unknown> };
    }).artifactStore;
    vi.spyOn(store, "writeInstallReceipt").mockImplementationOnce(async () => {
      const registryDuringReceipt = JSON.parse(await readFile(registryPath, "utf-8")) as {
        plugins: Array<{ id: string; pendingUpdate?: { kind: string } }>;
      };
      expect(registryDuringReceipt.plugins).toEqual([
        expect.objectContaining({
          id: "test-plugin",
          pendingUpdate: expect.objectContaining({ kind: "local-dev" }),
        }),
      ]);
      throw new Error("replacement receipt write failed");
    });

    await expect(service.installLocal(sourceDir)).rejects.toThrow("replacement receipt write failed");

    const restoredRegistry = JSON.parse(await readFile(registryPath, "utf-8")) as {
      plugins: Array<{ id: string }>;
    };
    expect(restoredRegistry.plugins.some((entry) => entry.id === "test-plugin")).toBe(true);
    expect(await readFile(join(cacheRoot, "test-plugin", "install-receipt.json"), "utf-8"))
      .toBe(oldReceipt);
  });

  it("retains a replacement backup when a transient restore fault requires retry", async () => {
    const service = makeService();
    await service.installLocal(sourceDir);
    const oldReceipt = await readFile(
      join(cacheRoot, "test-plugin", "install-receipt.json"),
      "utf-8",
    );
    await writeFile(
      join(sourceDir, "plugin.json"),
      JSON.stringify({
        id: "test-plugin",
        name: "Test Plugin",
        version: "2.0.0",
        description: "fixture v2",
        publisher: "tests",
        entry: "dist/hostPlugin.js",
      }),
      "utf-8",
    );

    const internals = service as unknown as {
      artifactStore: { writeInstallReceipt: (...args: unknown[]) => Promise<unknown> };
      restoreLocalInstallSnapshot: (...args: unknown[]) => Promise<void>;
      localInstallRollbackSnapshots: Map<string, { backupDir?: string }>;
    };
    vi.spyOn(internals.artifactStore, "writeInstallReceipt").mockRejectedValueOnce(
      new Error("replacement receipt write failed"),
    );
    vi.spyOn(internals, "restoreLocalInstallSnapshot").mockRejectedValueOnce(
      Object.assign(new Error("transient Windows restore lock"), { code: "EACCES" }),
    );

    const error = await service.installLocal(sourceDir).catch((caught) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors[1]).toMatchObject({ code: "EACCES" });
    const retained = internals.localInstallRollbackSnapshots.get("test-plugin");
    expect(retained?.backupDir).toBeTruthy();
    expect(existsSync(retained!.backupDir!)).toBe(true);
    const hiddenRegistry = JSON.parse(await readFile(registryPath, "utf-8")) as {
      plugins: Array<{ id: string; pendingUpdate?: { kind: string } }>;
    };
    expect(hiddenRegistry.plugins).toEqual([
      expect.objectContaining({
        id: "test-plugin",
        pendingUpdate: expect.objectContaining({ kind: "local-dev" }),
      }),
    ]);

    await expect(service.rollbackLocalInstall("test-plugin")).resolves.toEqual({
      pluginId: "test-plugin",
      rolledBack: true,
    });
    expect(existsSync(retained!.backupDir!)).toBe(false);
    expect(await readFile(join(cacheRoot, "test-plugin", "install-receipt.json"), "utf-8"))
      .toBe(oldReceipt);
    const restoredManifest = JSON.parse(
      await readFile(join(pluginsDir, "test-plugin", "plugin.json"), "utf-8"),
    ) as { version: string };
    expect(restoredManifest.version).toBe("1.2.3");
    const restoredRegistry = JSON.parse(await readFile(registryPath, "utf-8")) as {
      plugins: Array<{ id: string }>;
    };
    expect(restoredRegistry.plugins.some((entry) => entry.id === "test-plugin")).toBe(true);
  });

  it("supersedes a cleaned unresolved pending row with a verified local reinstall", async () => {
    const service = makeService();
    await service.installLocal(sourceDir);
    const manifestRaw = await readFile(join(pluginsDir, "test-plugin", "plugin.json"), "utf-8");
    const receiptRaw = await readFile(join(cacheRoot, "test-plugin", "install-receipt.json"), "utf-8");
    const registry = JSON.parse(await readFile(registryPath, "utf-8")) as {
      plugins: Array<Record<string, unknown>>;
    };
    Object.assign(registry.plugins[0]!, {
      bundleRefs: ["bundle-root"],
      pendingUpdate: {
        kind: "local-dev",
        previousManifestFileSha256: createHash("sha256").update(manifestRaw).digest("hex"),
        previousReceiptRaw: receiptRaw,
      },
    });
    await writeFile(registryPath, JSON.stringify(registry));
    await writeFile(join(pluginsDir, "test-plugin", "dist", "hostPlugin.js"), "corrupted");
    await writeFile(
      join(sourceDir, "plugin.json"),
      JSON.stringify({
        id: "test-plugin",
        name: "Test Plugin",
        version: "2.0.0",
        description: "verified retry",
        publisher: "tests",
        entry: "dist/hostPlugin.js",
      }),
    );

    await expect(service.installLocal(sourceDir)).resolves.toEqual({ pluginId: "test-plugin", installed: true });

    const repaired = JSON.parse(await readFile(registryPath, "utf-8")) as {
      plugins: Array<{ bundleRefs?: string[]; pendingUpdate?: unknown; pendingCleanup?: unknown }>;
    };
    expect(repaired.plugins[0]?.bundleRefs).toEqual(["bundle-root"]);
    expect(repaired.plugins[0]?.pendingUpdate).toBeUndefined();
    expect(repaired.plugins[0]?.pendingCleanup).toBeUndefined();
  });

  it("rollbackLocalInstall restores the previous install receipt with disk and registry state", async () => {
    const service = makeService();
    await service.installLocal(sourceDir);

    await writeFile(
      join(sourceDir, "plugin.json"),
      JSON.stringify(
        {
          id: "test-plugin",
          name: "Test Plugin",
          version: "2.0.0",
          description: "fixture v2",
          publisher: "tests",
          entry: "dist/hostPlugin.js",
        },
        null,
        2,
      ),
      "utf-8",
    );
    await writeFile(
      join(sourceDir, "dist", "hostPlugin.js"),
      "export default { version: '2.0.0' };\n",
      "utf-8",
    );

    await service.installLocal(sourceDir);
    await service.rollbackLocalInstall("test-plugin");

    const installDir = join(pluginsDir, "test-plugin");
    const manifest = JSON.parse(await readFile(join(installDir, "plugin.json"), "utf-8"));
    expect(manifest.version).toBe("1.2.3");
    const registry = JSON.parse(await readFile(registryPath, "utf-8"));
    expect(registry.plugins[0].manifestSha256).toBe(manifestSha(manifest));

    const receipt = JSON.parse(
      await readFile(join(cacheRoot, "test-plugin", "install-receipt.json"), "utf-8"),
    );
    expect(receipt.version).toBe("1.2.3");

    const { verifyInstallReceipt } = await import("../plugin-install-receipt.js");
    const result = await verifyInstallReceipt(cacheRoot, "test-plugin", installDir);
    expect(result.ok).toBe(true);
  });

  it("mirrors manifest.pluginAccess into registry approvedPluginAccess (parity with marketplace install)", async () => {
    // Without this, assertPluginEventAccess finds no grant for a
    // dev-sideloaded plugin and any cross-plugin event subscribe
    // (e.g. work-assistant listening to ms-graph email.new) throws at startup.
    const accessSpec = {
      plugins: [
        { pluginId: "ms-graph", events: ["email.new", "calendar.event.upcoming"] },
      ],
    };
    await writeFile(
      join(sourceDir, "plugin.json"),
      JSON.stringify(
        {
          id: "test-plugin",
          name: "Test Plugin",
          version: "1.2.3",
          description: "fixture",
          publisher: "tests",
          entry: "dist/hostPlugin.js",
          pluginAccess: accessSpec,
        },
        null,
        2,
      ),
      "utf-8",
    );

    const service = makeService();
    await service.installLocal(sourceDir);

    const reg = JSON.parse(await readFile(registryPath, "utf-8"));
    const entry = reg.plugins.find((p: { id: string }) => p.id === "test-plugin");
    expect(entry).toBeDefined();
    expect(entry.approvedPluginAccess).toEqual(accessSpec);
  });

  it("mirrors approvedPluginAccess on UPDATE (existing entry path) — not just on insert", async () => {
    // Dev re-install: a pre-existing local-dev entry is overwritten by the
    // new installLocal call AND approvedPluginAccess must be overwritten so
    // a later cross-plugin event subscribe is granted. Using "local-dev"
    // here (rather than the now-removed "dev-link") since both produce the
    // same code path after the read-time migration.
    const accessSpec = {
      plugins: [{ pluginId: "ms-graph", events: ["email.new"] }],
    };
    await writeFile(
      registryPath,
      JSON.stringify(
        {
          version: 1,
          plugins: [
            {
              id: "test-plugin",
              manifestPath: "test-plugin/plugin.json",
              enabled: true,
              installSource: "local-dev",
              bundleRefs: ["work-assistant"],
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );
    await writeFile(
      join(sourceDir, "plugin.json"),
      JSON.stringify(
        {
          id: "test-plugin",
          name: "Test Plugin",
          version: "1.2.3",
          description: "fixture",
          publisher: "tests",
          entry: "dist/hostPlugin.js",
          pluginAccess: accessSpec,
        },
        null,
        2,
      ),
      "utf-8",
    );

    const service = makeService();
    await service.installLocal(sourceDir);

    const reg = JSON.parse(await readFile(registryPath, "utf-8"));
    const entry = reg.plugins.find((p: { id: string }) => p.id === "test-plugin");
    expect(entry.approvedPluginAccess).toEqual(accessSpec);
    expect(entry.installSource).toBe("local-dev");
    expect(entry.bundleRefs).toEqual(["work-assistant"]);
    expect(entry.pendingUpdate).toBeUndefined();
  });
});
