import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockMarketplaceFetcher, PluginMarketplaceService } from "../marketplace.js";
import { PluginDeploymentGuard } from "../deployment-guard.js";
import { _resetForTest, setIsPackaged } from "../../boot/dev-flags.js";
import { makeTestPluginPaths, writeTestPluginRegistry } from "./test-helpers.js";
import { mkdtempSync } from "node:fs";

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
    testDir = mkdtempSync(join(tmpdir(), "lvis-mp-"));
    pluginsDir = join(testDir, "plugins");
    // Phase 2a invariant: registry.json and installed plugins live in the
    // same directory tree (no `installed/` subdirectory). Tests that touched
    // the legacy split need to be aligned with the new shape.
    installedDir = pluginsDir;
    registryPath = join(installedDir, "registry.json");
    marketplacePath = join(testDir, "marketplace.json");
    await mkdir(installedDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
    _resetForTest();
  });

  async function writeCatalog(installPolicy?: "admin" | "user") {
    const catalogEntry = makeCatalogEntry("mp-test", installPolicy);
    await writeCatalogEntries([catalogEntry]);
  }

  function makeCatalogEntry(id: string, installPolicy?: "admin" | "user"): Record<string, unknown> {
    const catalogEntry: Record<string, unknown> = {
      id: "mp-test",
      name: "Marketplace Test",
      description: "unit test fixture",
      packageSpec: "file:./nonexistent",
      packageName: "@lvis-test/nonexistent",
      methods: []
    };
    catalogEntry.id = id;
    if (installPolicy) catalogEntry.installPolicy = installPolicy;
    return catalogEntry;
  }

  async function writeCatalogEntries(plugins: Array<Record<string, unknown>>) {
    await writeFile(
      marketplacePath,
      JSON.stringify({ version: 1, plugins }),
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
    const paths = makeTestPluginPaths({ rootDir: testDir, pluginsRoot: installedDir });
    const guard = new PluginDeploymentGuard({
      registryPath: paths.registryPath,
      pluginsRoot: paths.pluginsRoot,
    });
    const fetcher = new MockMarketplaceFetcher(marketplacePath);
    return new PluginMarketplaceService(paths, fetcher, guard);
  }

  it("install() escalates admin-policy catalog item to actor=it-admin (passes guard)", async () => {
    // Post-#964-redesign: actor decision moved inside
    // PluginMarketplaceService.install — admin-policy catalog items
    // auto-escalate to actor="it-admin" so the deployment-guard does not
    // reject them. The previous behavior (reject "installed by user") was
    // a property of the IPC handler defaulting actor="user", which is no
    // longer the case. The downstream failure here surfaces from the
    // artifact store (no real download backend in tests) — proving the
    // guard *passed* before npm/zip work began.
    await writeCatalog("admin");
    await writeEmptyRegistry();
    const service = makeService();

    await expect(service.install("mp-test")).rejects.not.toThrow(/installed by user/);
  });

  it("install() surfaces 'Plugin not found' for unknown id (no guard bypass)", async () => {
    await writeCatalog("admin");
    await writeEmptyRegistry();
    const service = makeService();

    await expect(service.install("does-not-exist")).rejects.toThrow(/not found in marketplace/);
  });

  it("install() rejects non-plugin marketplace package kinds before artifact install", async () => {
    await writeCatalogEntries([
      {
        ...makeCatalogEntry("openrouter-provider", "user"),
        pluginType: "provider",
      },
    ]);
    await writeEmptyRegistry();
    const service = makeService();

    await expect(service.install("openrouter-provider")).rejects.toThrow(
      /provider entry, not a plugin package/,
    );
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

  it("list() keeps non-installable marketplace package kinds out of the plugin registry state", async () => {
    await writeCatalogEntries([
      {
        ...makeCatalogEntry("openrouter-provider", "admin"),
        pluginType: "provider",
      },
    ]);
    await writeTestPluginRegistry(
      { registryPath },
      [{ id: "openrouter-provider", manifestPath: "openrouter-provider/plugin.json", enabled: true }],
    );
    const service = makeService();

    const items = await service.list();

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "openrouter-provider",
      pluginType: "provider",
      installed: false,
      enabled: false,
      isManaged: false,
    });
  });

  it("uninstall() allows cleanup for admin-installed plugins removed from the marketplace catalog", async () => {
    await writeCatalogEntries([]);
    const pluginDir = join(installedDir, "agent-hub");
    await mkdir(pluginDir, { recursive: true });
    const manifestPath = join(pluginDir, "plugin.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        id: "agent-hub",
        name: "Agent Hub",
        version: "1.0.0",
        entry: "dist/hostPlugin.js",
        tools: [],
        installPolicy: "admin",
      }),
      "utf-8",
    );
    await writeTestPluginRegistry(
      { registryPath },
      [{ id: "agent-hub", manifestPath, enabled: true, installSource: "admin" }],
    );
    const service = makeService();

    await expect(service.uninstall("agent-hub")).resolves.toEqual({
      pluginId: "agent-hub",
      uninstalled: true,
    });
    const registry = JSON.parse(await readFile(registryPath, "utf-8")) as { plugins: unknown[] };
    expect(registry.plugins).toEqual([]);
  });

  it("uninstall() keeps protecting admin installs while a normalized catalog entry still exists", async () => {
    await writeCatalogEntries([
      {
        ...makeCatalogEntry("lvis-plugin-agent-hub", "admin"),
        name: "Agent Hub",
        packageSpec: "@lvis/lvis-plugin-agent-hub",
        packageName: "@lvis/lvis-plugin-agent-hub",
      },
    ]);
    const pluginDir = join(installedDir, "agent-hub");
    await mkdir(pluginDir, { recursive: true });
    const manifestPath = join(pluginDir, "plugin.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        id: "agent-hub",
        name: "Agent Hub",
        version: "1.0.0",
        entry: "dist/hostPlugin.js",
        tools: [],
        installPolicy: "admin",
      }),
      "utf-8",
    );
    await writeTestPluginRegistry(
      { registryPath },
      [{ id: "agent-hub", manifestPath, enabled: true, installSource: "admin" }],
    );
    const service = makeService();

    await expect(service.uninstall("agent-hub")).rejects.toThrow(/registry installSource="admin"/);
  });
});
