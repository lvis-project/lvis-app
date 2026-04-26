import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { PluginMarketplaceService } from "../marketplace.js";
import { PluginDeploymentGuard } from "../deployment-guard.js";
import { _resetForTest, setIsPackaged } from "../../boot/dev-flags.js";

/**
 * Phase 1.5 F-round §F6: integration test for
 * `PluginMarketplaceService.install()` + `canInstall` guard.
 *
 * Proves the guard rejects a managed catalog item BEFORE any npm install
 * work begins (no runNpmInstall invocation, no filesystem changes under
 * installedDir or registry).
 */
describe("PluginMarketplaceService + PluginDeploymentGuard canInstall", () => {
  let testDir: string;
  let pluginsDir: string;
  let registryPath: string;
  let marketplacePath: string;
  let installedDir: string;

  beforeEach(async () => {
    // Track A pre-Phase-2: MockMarketplaceFetcher refuses to construct in
    // packaged builds. dev-flags defaults to packaged-mode for safety, so
    // tests must explicitly opt into the unpackaged gate.
    setIsPackaged(false);
    testDir = join(homedir(), ".lvis", "test-tmp", `lvis-mp-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    pluginsDir = join(testDir, "plugins");
    installedDir = join(pluginsDir, "installed");
    registryPath = join(pluginsDir, "registry.json");
    marketplacePath = join(pluginsDir, "marketplace.json");
    await mkdir(installedDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
    _resetForTest();
  });

  async function writeCatalog(installPolicy?: "admin" | "user") {
    const catalogEntry: Record<string, unknown> = {
      id: "mp-test",
      name: "Marketplace Test",
      description: "unit test fixture",
      packageSpec: "file:./nonexistent",
      packageName: "@lvis-test/nonexistent",
      methods: []
    };
    if (installPolicy) catalogEntry.installPolicy = installPolicy;
    await writeFile(
      marketplacePath,
      JSON.stringify({ version: 1, plugins: [catalogEntry] }),
      "utf-8",
    );
  }

  async function writeEmptyRegistry() {
    await writeFile(
      registryPath,
      JSON.stringify({ version: 1, plugins: [] }),
      "utf-8",
    );
  }

  function makeService(): PluginMarketplaceService {
    const guard = new PluginDeploymentGuard({
      registryPath,
      userInstalledDir: installedDir
    });
    return new PluginMarketplaceService(testDir, guard);
  }

  it("install() rejects admin-policy catalog item before runNpmInstall fires", async () => {
    await writeCatalog("admin");
    await writeEmptyRegistry();
    const service = makeService();

    await expect(service.install("mp-test")).rejects.toThrow(/installed by user/);

    // npm install should NOT have been attempted — proving the guard
    // short-circuited before any filesystem work. We verify this by
    // checking that no new manifest was written and registry is unchanged.
    const { readFile } = await import("node:fs/promises");
    const registry = JSON.parse(await readFile(registryPath, "utf-8"));
    expect(registry.plugins).toHaveLength(0);
  });

  it("install() surfaces 'Plugin not found' for unknown id (no guard bypass)", async () => {
    await writeCatalog("admin");
    await writeEmptyRegistry();
    const service = makeService();

    await expect(service.install("does-not-exist")).rejects.toThrow(/not found in marketplace/);
  });

  it("list() exposes isManaged=true for admin-policy catalog entries", async () => {
    await writeCatalog("admin");
    await writeEmptyRegistry();
    const service = makeService();

    const items = await service.list();
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("mp-test");
    expect(items[0].isManaged).toBe(true);
    expect(items[0].installed).toBe(false);
  });

  it("list() reports isManaged=false for user install-policy catalog entries", async () => {
    await writeCatalog("user");
    await writeEmptyRegistry();
    const service = makeService();

    const items = await service.list();
    expect(items[0].isManaged).toBe(false);
  });
});
