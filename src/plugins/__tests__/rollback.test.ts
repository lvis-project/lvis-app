import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { MockMarketplaceFetcher, PluginMarketplaceService } from "../marketplace.js";
import { _resetForTest, setIsPackaged } from "../../boot/dev-flags.js";
import { makeTestPluginPaths } from "./test-helpers.js";

/**
 * Sprint 3-B §9.6 — install → update → rollback lifecycle.
 *
 * We subclass the service so `runNpmInstall` is a no-op; the real npm call
 * would hit the network. Everything else (filesystem cache, registry
 * updates, manifest rewrites) runs unchanged.
 */
class TestableService extends PluginMarketplaceService {
  public npmCalls: string[] = [];
  // @ts-expect-error override private for test purposes
  protected async runNpmInstall(spec: string): Promise<void> {
    this.npmCalls.push(spec);
  }
}

describe("PluginMarketplaceService install → update → rollback", () => {
  let testDir: string;
  let appRoot: string;
  let registryPath: string;
  let marketplacePath: string;
  let cacheRoot: string;

  beforeEach(async () => {
    setIsPackaged(false);
    testDir = join(homedir(), ".lvis", "test-tmp", `lvis-rb-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    appRoot = testDir;
    const pluginsDir = join(appRoot, "plugins");
    registryPath = join(pluginsDir, "registry.json");
    marketplacePath = join(pluginsDir, "marketplace.json");
    cacheRoot = join(testDir, ".cache");
    await mkdir(join(pluginsDir, "installed"), { recursive: true });

    await writeFile(
      registryPath,
      JSON.stringify({ version: 1, plugins: [] }),
      "utf-8",
    );
    await writeFile(
      marketplacePath,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: "com.lge.sample",
            name: "Sample",
            description: "sample",
            packageSpec: "@lvis/sample@1.0.0",
            packageName: "@lvis/sample",
            tools: ["sample_ping"]
          },
        ]
      }),
      "utf-8",
    );
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    _resetForTest();
  });

  function makeService(): TestableService {
    // Phase 2a: registry + installedDir live under userData/plugins. Tests
    // anchor that at testDir; the legacy `installedDir = appRoot/plugins/
    // installed` patch is gone (registry-relative paths assume registry and
    // manifests share a directory tree).
    const paths = makeTestPluginPaths({
      rootDir: testDir,
      cacheRoot,
    });
    const fetcher = new MockMarketplaceFetcher(marketplacePath);
    return new TestableService(appRoot, paths, fetcher);
  }

  it("rollback restores the prior installed version", async () => {
    const svc = makeService();

    // First install pins v1.0.0.
    await svc.installPlugin("com.lge.sample", "1.0.0");
    const reg1 = JSON.parse(await readFile(registryPath, "utf-8"));
    expect(reg1.plugins[0].id).toBe("com.lge.sample");
    const manifest1 = JSON.parse(
      await readFile(join(testDir, "plugins/com.lge.sample/plugin.json"), "utf-8"),
    );
    expect(manifest1.version).toBe("1.0.0");

    // Update to v1.1.0.
    await svc.installPlugin("com.lge.sample", "1.1.0");
    const manifest2 = JSON.parse(
      await readFile(join(testDir, "plugins/com.lge.sample/plugin.json"), "utf-8"),
    );
    expect(manifest2.version).toBe("1.1.0");

    // Rollback.
    const result = await svc.rollbackPlugin("com.lge.sample");
    expect(result.rolledBackTo).toBe("1.0.0");

    const manifest3 = JSON.parse(
      await readFile(join(testDir, "plugins/com.lge.sample/plugin.json"), "utf-8"),
    );
    expect(manifest3.version).toBe("1.0.0");

    // Rollback should have invoked npm install for the prior version.
    expect(svc.npmCalls.some((s) => s === "@lvis/sample@1.0.0")).toBe(true);
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
});
