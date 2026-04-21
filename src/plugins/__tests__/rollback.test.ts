import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { PluginMarketplaceService } from "../marketplace.js";

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
  });

  function makeService(): TestableService {
    const svc = new TestableService(appRoot, undefined, undefined, cacheRoot);
    (
      svc as unknown as {
        installedDir: string;
      }
    ).installedDir = join(appRoot, "plugins", "installed");
    return svc;
  }

  it("rollback restores the prior installed version", async () => {
    const svc = makeService();

    // First install pins v1.0.0.
    await svc.installPlugin("com.lge.sample", "1.0.0");
    const reg1 = JSON.parse(await readFile(registryPath, "utf-8"));
    expect(reg1.plugins[0].id).toBe("com.lge.sample");
    const manifest1 = JSON.parse(
      await readFile(join(appRoot, "plugins/installed/com.lge.sample/plugin.json"), "utf-8"),
    );
    expect(manifest1.version).toBe("1.0.0");

    // Update to v1.1.0.
    await svc.installPlugin("com.lge.sample", "1.1.0");
    const manifest2 = JSON.parse(
      await readFile(join(appRoot, "plugins/installed/com.lge.sample/plugin.json"), "utf-8"),
    );
    expect(manifest2.version).toBe("1.1.0");

    // Rollback.
    const result = await svc.rollbackPlugin("com.lge.sample");
    expect(result.rolledBackTo).toBe("1.0.0");

    const manifest3 = JSON.parse(
      await readFile(join(appRoot, "plugins/installed/com.lge.sample/plugin.json"), "utf-8"),
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

  it("rollback fails for unknown plugin", async () => {
    const svc = makeService();
    await expect(svc.rollbackPlugin("no.such.plugin")).rejects.toThrow(/No prior version/);
  });
});
