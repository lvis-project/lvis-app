import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginMarketplaceService } from "../marketplace.js";
import type { MarketplaceFetcher } from "../marketplace-fetcher.js";
import type { PluginMarketplaceItem } from "../types.js";
import { _resetForTest, setIsPackaged } from "../../boot/dev-flags.js";
import { makeTestPluginPaths } from "./test-helpers.js";
import { mkdtempSync } from "node:fs";
import { canonicalJSON } from "../whitelist/canonical-json.js";

/**
 * Sprint 3-B §9.6 + Phase 2-final — install → update → rollback lifecycle.
 *
 * Phase 2-final rollback: no npm. The flow is `findRollbackTargetVersion`
 * (reads cacheRoot history.json), `getPluginDetail` (re-fetches the
 * catalog item), `installArtifact` (re-downloads + extracts the prior
 * version's verified zip). Tests stub `installArtifact` to write a
 * deterministic manifest so the rollback's state-machine concerns
 * (registry update, history append, metadata preservation) are
 * observable without exercising the real download/extract pipeline.
 */
const SAMPLE_ITEM: PluginMarketplaceItem = {
  id: "example-sample",
  name: "Sample",
  description: "sample",
  publisher: "Test fixture",
  packageSpec: "@lvis/sample@1.0.0",
  packageName: "@lvis/sample",
  tools: ["sample_ping"],
};

function sampleManifest(version: string) {
  return { id: "example-sample", version, entry: "./dist/index.js", tools: [] };
}

function manifestSha(manifest: unknown): string {
  return createHash("sha256").update(canonicalJSON(manifest)).digest("hex");
}

class StubFetcher implements MarketplaceFetcher {
  item: PluginMarketplaceItem = { ...SAMPLE_ITEM };

  async listPlugins() {
    return [this.item];
  }
  async getPluginDetail(id: string) {
    return id === this.item.id ? this.item : null;
  }
  async downloadVersion() {
    throw new Error("downloadVersion stub — installArtifact is mocked in this test file");
  }
  async listAnnouncements() {
    return [];
  }
}

describe("PluginMarketplaceService install → update → rollback", () => {
  let testDir: string;
  let registryPath: string;
  let cacheRoot: string;
  let pluginDir: string;

  beforeEach(async () => {
    setIsPackaged(false);
    testDir = mkdtempSync(join(tmpdir(), "lvis-rb-"));
    const installedDir = join(testDir, "plugins");
    registryPath = join(installedDir, "registry.json");
    cacheRoot = join(testDir, ".cache");
    pluginDir = join(installedDir, "example-sample");
    await mkdir(installedDir, { recursive: true });
    await writeFile(
      registryPath,
      JSON.stringify({ version: 1, plugins: [] }),
      "utf-8",
    );
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    _resetForTest();
  });

  function makeService(fetcher = new StubFetcher()) {
    const paths = makeTestPluginPaths({ rootDir: testDir, cacheRoot });
    const svc = new PluginMarketplaceService(paths, fetcher);
    // Stub installArtifact: write a versioned plugin.json under the live
    // install dir and return the registry-relative path. Mirrors the
    // post-extraction state of the real signed-zip pipeline.
    vi.spyOn(svc as unknown as {
      installArtifact: (plugin: PluginMarketplaceItem, version: string) => Promise<string>;
    }, "installArtifact").mockImplementation(async (_plugin, version) => {
      await mkdir(pluginDir, { recursive: true });
      const manifestFile = join(pluginDir, "plugin.json");
      await writeFile(manifestFile, JSON.stringify(sampleManifest(version)), "utf-8");
      return "example-sample/plugin.json";
    });
    return svc;
  }

  it("rollback restores the prior installed version", async () => {
    const svc = makeService();
    await svc.installPlugin("example-sample", "1.0.0");
    expect(JSON.parse(await readFile(join(pluginDir, "plugin.json"), "utf-8")).version).toBe("1.0.0");

    await svc.installPlugin("example-sample", "1.1.0");
    expect(JSON.parse(await readFile(join(pluginDir, "plugin.json"), "utf-8")).version).toBe("1.1.0");

    const result = await svc.rollbackPlugin("example-sample");
    expect(result.rolledBackTo).toBe("1.0.0");
    expect(JSON.parse(await readFile(join(pluginDir, "plugin.json"), "utf-8")).version).toBe("1.0.0");
  });

  it("normal install records history so lifecycle rollback can restore the prior version", async () => {
    const fetcher = new StubFetcher();
    const svc = makeService(fetcher);

    fetcher.item = { ...SAMPLE_ITEM, version: "1.0.0" };
    await svc.install("example-sample");
    expect(JSON.parse(await readFile(join(pluginDir, "plugin.json"), "utf-8")).version).toBe("1.0.0");

    fetcher.item = { ...SAMPLE_ITEM, version: "1.1.0" };
    await svc.install("example-sample");
    expect(JSON.parse(await readFile(join(pluginDir, "plugin.json"), "utf-8")).version).toBe("1.1.0");

    const result = await svc.rollbackPlugin("example-sample");
    expect(result.rolledBackTo).toBe("1.0.0");
    expect(JSON.parse(await readFile(join(pluginDir, "plugin.json"), "utf-8")).version).toBe("1.0.0");
  });

  it("rollback without a prior cached version throws", async () => {
    const svc = makeService();
    await svc.installPlugin("example-sample", "1.0.0");
    await expect(svc.rollbackPlugin("example-sample")).rejects.toThrow(/No prior version/);
  });

  it("installPlugin migrates a legacy `_devLinked: true` entry to local-dev then re-stamps to user on install", async () => {
    // Pre-populate registry with the legacy `_devLinked: true` shape that
    // the now-removed dev:link script wrote. readPluginRegistry migrates
    // dev-link/`_devLinked` to "local-dev" on first read; installPlugin
    // then re-stamps installSource="user" since the marketplace install
    // supersedes the prior source.
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: "example-sample", manifestPath: "example-sample/plugin.json", enabled: true, installedBy: "user", _devLinked: true }],
      }),
      "utf-8",
    );
    const svc = makeService();
    // installPlugin with a version already in registry triggers touchInstalledRegistryEntry.
    await svc.installPlugin("example-sample", "1.0.0");
    await svc.installPlugin("example-sample", "1.0.0"); // same version → fast path
    const registry = JSON.parse(await readFile(registryPath, "utf-8"));
    expect(registry.plugins[0].installSource).toBe("user");
    // Deprecated fields must not survive the migration round-trip.
    expect(registry.plugins[0]._devLinked).toBeUndefined();
    expect(registry.plugins[0].installedBy).toBeUndefined();
  });

  it("installPlugin overrides a legacy dev-link entry (rewritten to local-dev) with installSource='user'", async () => {
    // Pre-populate registry with a legacy dev-link entry. readPluginRegistry
    // rewrites it to "local-dev"; installPlugin then re-stamps to "user".
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: "example-sample", manifestPath: "example-sample/plugin.json", enabled: true, installSource: "dev-link" }],
      }),
      "utf-8",
    );
    const svc = makeService();
    await svc.installPlugin("example-sample", "1.0.0");
    const registry = JSON.parse(await readFile(registryPath, "utf-8"));
    expect(registry.plugins[0].installSource).toBe("user");
  });

  it("rollbackPlugin re-stamps installSource='user' on a rolled-back entry whose registry was tampered with a legacy dev-link value", async () => {
    const svc = makeService();
    await svc.installPlugin("example-sample", "1.0.0");
    await svc.installPlugin("example-sample", "1.1.0");
    // Manually flip installSource to a legacy dev-link to simulate a stale
    // state. The next registry read rewrites it to "local-dev"; rollback
    // then normalises any non-admin source back to "user".
    const reg = JSON.parse(await readFile(registryPath, "utf-8"));
    reg.plugins[0].installSource = "dev-link";
    await writeFile(registryPath, JSON.stringify(reg), "utf-8");
    await svc.rollbackPlugin("example-sample");
    const restored = JSON.parse(await readFile(registryPath, "utf-8"));
    expect(restored.plugins[0].installSource).toBe("user");
  });

  it("installPlugin sets installSource='user' on fresh install", async () => {
    const svc = makeService();
    await svc.installPlugin("example-sample", "1.0.0");
    const registry = JSON.parse(await readFile(registryPath, "utf-8"));
    expect(registry.plugins[0].installSource).toBe("user");
  });

  it("installPlugin sets installSource='user' when overwriting a legacy dev-link (now local-dev) entry", async () => {
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: "example-sample", manifestPath: "example-sample/plugin.json", enabled: true, installSource: "dev-link" }],
      }),
      "utf-8",
    );
    const svc = makeService();
    await svc.installPlugin("example-sample", "1.0.0");
    const registry = JSON.parse(await readFile(registryPath, "utf-8"));
    expect(registry.plugins[0].installSource).toBe("user");
  });

  it("rollback preserves installSource='user' from the pre-install state", async () => {
    const svc = makeService();
    await svc.installPlugin("example-sample", "1.0.0");
    await svc.installPlugin("example-sample", "1.1.0");

    const registry = JSON.parse(await readFile(registryPath, "utf-8"));
    expect(registry.plugins[0].installSource).toBe("user");

    await svc.rollbackPlugin("example-sample");

    const restored = JSON.parse(await readFile(registryPath, "utf-8"));
    expect(restored.plugins[0].installSource).toBe("user");
  });

  it("rollback preserves installSource='admin' for managed marketplace installs", async () => {
    const fetcher = new StubFetcher();
    const svc = makeService(fetcher);

    fetcher.item = { ...SAMPLE_ITEM, version: "1.0.0", installPolicy: "admin" };
    await svc.install("example-sample");
    fetcher.item = { ...SAMPLE_ITEM, version: "1.1.0", installPolicy: "admin" };
    await svc.install("example-sample");

    const registry = JSON.parse(await readFile(registryPath, "utf-8"));
    expect(registry.plugins[0].installSource).toBe("admin");

    await svc.rollbackPlugin("example-sample");

    const restored = JSON.parse(await readFile(registryPath, "utf-8"));
    expect(restored.plugins[0].installSource).toBe("admin");
    expect(restored.plugins[0].manifestSha256).toBe(manifestSha(sampleManifest("1.0.0")));
  });

  it("rollback normalises a legacy dev-link registry value to 'user' regardless of packaged/dev mode", async () => {
    // Pre-2026-05 a "dev-link" installSource on a packaged build was
    // explicitly cleared by a build guard. After the dev-link purge there
    // is no separate guard — readPluginRegistry rewrites dev-link to
    // local-dev on read, and the rollback normaliser then re-stamps any
    // non-admin source as "user" since rollback is always a marketplace
    // re-install (see marketplace.ts rollbackPlugin).
    setIsPackaged(true);
    const svc = makeService();
    await svc.installPlugin("example-sample", "1.0.0");
    await svc.installPlugin("example-sample", "1.1.0");
    const reg = JSON.parse(await readFile(registryPath, "utf-8"));
    reg.plugins[0].installSource = "dev-link";
    await writeFile(registryPath, JSON.stringify(reg), "utf-8");
    await svc.rollbackPlugin("example-sample");
    const restored = JSON.parse(await readFile(registryPath, "utf-8"));
    expect(restored.plugins[0].installSource).toBe("user");
  });

  it("rollback normalizes installSource='local-dev' back to 'user' (marketplace re-install)", async () => {
    const svc = makeService();
    await svc.installPlugin("example-sample", "1.0.0");
    await svc.installPlugin("example-sample", "1.1.0");
    // Simulate first version having been a local-dev install.
    const reg = JSON.parse(await readFile(registryPath, "utf-8"));
    reg.plugins[0].installSource = "local-dev";
    await writeFile(registryPath, JSON.stringify(reg), "utf-8");
    await svc.rollbackPlugin("example-sample");
    const restored = JSON.parse(await readFile(registryPath, "utf-8"));
    expect(restored.plugins[0].installSource).toBe("user");
  });

  it("rollback preserves bundleRefs metadata (and re-stamps installSource='user')", async () => {
    const svc = makeService();
    await svc.installPlugin("example-sample", "1.0.0");
    await svc.installPlugin("example-sample", "1.1.0");

    const registry = JSON.parse(await readFile(registryPath, "utf-8"));
    registry.plugins[0].bundleRefs = ["work-assistant"];
    await writeFile(registryPath, JSON.stringify(registry), "utf-8");

    await svc.rollbackPlugin("example-sample");

    const restored = JSON.parse(await readFile(registryPath, "utf-8"));
    // User-owned marketplace rollback still normalizes stale non-admin
    // registry source values to installSource="user".
    expect(restored.plugins[0].installSource).toBe("user");
    expect(restored.plugins[0].bundleRefs).toEqual(["work-assistant"]);
  });

  it("rollback fails for unknown plugin", async () => {
    const svc = makeService();
    await expect(svc.rollbackPlugin("no.such.plugin")).rejects.toThrow(/No prior version/);
  });

  it("rollback fails with explicit delisted-plugin message when catalog no longer lists the id", async () => {
    // First install + update normally (catalog still lists the plugin),
    // then simulate a yank by stubbing getPluginDetail to return null and
    // calling rollback. The service must explain the delisted cause so
    // settings UI can render an actionable message.
    const svc = makeService();
    await svc.installPlugin("example-sample", "1.0.0");
    await svc.installPlugin("example-sample", "1.1.0");

    // Now simulate the catalog yank — fetcher.getPluginDetail returns null.
    vi.spyOn(svc as unknown as {
      fetcher: MarketplaceFetcher;
    }, "fetcher", "get").mockReturnValue({
      listPlugins: async () => [],
      getPluginDetail: async () => null,
      downloadVersion: async () => {
        throw new Error("never called");
      },
    });

    await expect(svc.rollbackPlugin("example-sample")).rejects.toThrow(
      /no longer in the marketplace catalog.*Delisted plugins are unsupported/i,
    );
  });
});
