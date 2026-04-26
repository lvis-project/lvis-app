import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { PluginMarketplaceService } from "../marketplace.js";
import type { MarketplaceFetcher } from "../marketplace-fetcher.js";
import type { PluginMarketplaceItem } from "../types.js";
import { _resetForTest, setIsPackaged } from "../../boot/dev-flags.js";
import { makeTestPluginPaths } from "./test-helpers.js";

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
  id: "com.lge.sample",
  name: "Sample",
  description: "sample",
  packageSpec: "@lvis/sample@1.0.0",
  packageName: "@lvis/sample",
  tools: ["sample_ping"],
};

class StubFetcher implements MarketplaceFetcher {
  async listPlugins() {
    return [SAMPLE_ITEM];
  }
  async getPluginDetail(id: string) {
    return id === SAMPLE_ITEM.id ? SAMPLE_ITEM : null;
  }
  async downloadVersion() {
    throw new Error("downloadVersion stub — installArtifact is mocked in this test file");
  }
}

describe("PluginMarketplaceService install → update → rollback", () => {
  let testDir: string;
  let registryPath: string;
  let cacheRoot: string;
  let pluginDir: string;

  beforeEach(async () => {
    setIsPackaged(false);
    testDir = join(homedir(), ".lvis", "test-tmp", `lvis-rb-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const installedDir = join(testDir, "plugins");
    registryPath = join(installedDir, "registry.json");
    cacheRoot = join(testDir, ".cache");
    pluginDir = join(installedDir, "com.lge.sample");
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

  function makeService() {
    const paths = makeTestPluginPaths({ rootDir: testDir, cacheRoot });
    const svc = new PluginMarketplaceService(paths, new StubFetcher());
    // Stub installArtifact: write a versioned plugin.json under the live
    // install dir and return the registry-relative path. Mirrors the
    // post-extraction state of the real signed-zip pipeline.
    vi.spyOn(svc as unknown as {
      installArtifact: (plugin: PluginMarketplaceItem, version: string) => Promise<string>;
    }, "installArtifact").mockImplementation(async (_plugin, version) => {
      await mkdir(pluginDir, { recursive: true });
      const manifestFile = join(pluginDir, "plugin.json");
      await writeFile(
        manifestFile,
        JSON.stringify({ id: "com.lge.sample", version, entry: "./dist/index.js", tools: [] }),
        "utf-8",
      );
      return "com.lge.sample/plugin.json";
    });
    return svc;
  }

  it("rollback restores the prior installed version", async () => {
    const svc = makeService();
    await svc.installPlugin("com.lge.sample", "1.0.0");
    expect(JSON.parse(await readFile(join(pluginDir, "plugin.json"), "utf-8")).version).toBe("1.0.0");

    await svc.installPlugin("com.lge.sample", "1.1.0");
    expect(JSON.parse(await readFile(join(pluginDir, "plugin.json"), "utf-8")).version).toBe("1.1.0");

    const result = await svc.rollbackPlugin("com.lge.sample");
    expect(result.rolledBackTo).toBe("1.0.0");
    expect(JSON.parse(await readFile(join(pluginDir, "plugin.json"), "utf-8")).version).toBe("1.0.0");
  });

  it("rollback without a prior cached version throws", async () => {
    const svc = makeService();
    await svc.installPlugin("com.lge.sample", "1.0.0");
    await expect(svc.rollbackPlugin("com.lge.sample")).rejects.toThrow(/No prior version/);
  });

  it("rollback preserves installedBy and bundleRefs metadata", async () => {
    const svc = makeService();
    await svc.installPlugin("com.lge.sample", "1.0.0");
    await svc.installPlugin("com.lge.sample", "1.1.0");

    const registry = JSON.parse(await readFile(registryPath, "utf-8"));
    registry.plugins[0].installedBy = "admin";
    registry.plugins[0].bundleRefs = ["work-proactive"];
    await writeFile(registryPath, JSON.stringify(registry), "utf-8");

    await svc.rollbackPlugin("com.lge.sample");

    const restored = JSON.parse(await readFile(registryPath, "utf-8"));
    expect(restored.plugins[0].installedBy).toBe("admin");
    expect(restored.plugins[0].bundleRefs).toEqual(["work-proactive"]);
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
    await svc.installPlugin("com.lge.sample", "1.0.0");
    await svc.installPlugin("com.lge.sample", "1.1.0");

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

    await expect(svc.rollbackPlugin("com.lge.sample")).rejects.toThrow(
      /no longer in the marketplace catalog.*Delisted plugins are unsupported/i,
    );
  });
});
