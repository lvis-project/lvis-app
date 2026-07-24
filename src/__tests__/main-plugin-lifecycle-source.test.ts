import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { readBootWiring } from "../testing/boot-wiring-source.js";

async function readSource(relative: string): Promise<string> {
  return readFile(new URL(relative, import.meta.url), "utf8");
}

describe("main process plugin lifecycle regression guards", () => {
  it("reports lvis:// install success only after runtime activation succeeds", async () => {
    // C17: the lvis:// deep-link install lifecycle moved from main.ts into
    // src/main/lvis-deep-link.ts. Same guarantee, new location — the section
    // is now terminated by the `broadcastPluginLifecycleEvent` definition that
    // immediately follows `handleLvisUri` (previously `activateView`).
    const source = await readSource("../main/lvis-deep-link.ts");
    const lifecycleSection = source.match(
      /let installProgressSlug = params\.slug[\s\S]*?\r?\n}\r?\n\r?\nfunction broadcastPluginLifecycleEvent/,
    )?.[0];

    expect(lifecycleSection, "deep-link install lifecycle section must be present").toBeTruthy();
    expect(source).not.toMatch(/mainWindow\?\.webContents\.send\("lvis:plugins:(install-progress|install-result|uninstall-result)"/);

    const canonicalIdIndex = lifecycleSection!.indexOf("item.id === params.slug || item.slug === params.slug");
    const progressAliasIndex = lifecycleSection!.indexOf("let installProgressSlug = params.slug");
    const progressCanonicalIndex = lifecycleSection!.indexOf("installProgressSlug = installLockId");
    const lifecycleKeyIndex = lifecycleSection!.indexOf("lifecyclePluginId: installLockId");
    const requestedIdIndex = lifecycleSection!.indexOf("requestedPluginId: params.slug");
    const catchResultIndex = source.indexOf('slug: installProgressSlug');
    const lifecycleHelperIndex = lifecycleSection!.indexOf("await installMarketplacePluginWithLifecycle({");
    const progressBridgeIndex = lifecycleSection!.indexOf('broadcastPluginLifecycleEvent("lvis:plugins:install-progress", payload)');
    const failureIndex = lifecycleSection!.indexOf('slug: installProgressSlug');
    const successIndex = lifecycleSection!.indexOf("success: true", lifecycleHelperIndex);

    expect(canonicalIdIndex).toBeGreaterThanOrEqual(0);
    expect(progressAliasIndex).toBeGreaterThanOrEqual(0);
    expect(progressCanonicalIndex).toBeGreaterThanOrEqual(0);
    expect(lifecycleKeyIndex).toBeGreaterThanOrEqual(0);
    expect(requestedIdIndex).toBeGreaterThanOrEqual(0);
    expect(catchResultIndex).toBeGreaterThanOrEqual(0);
    expect(lifecycleSection).not.toContain('broadcastPluginLifecycleEvent("lvis:plugins:install-progress", { slug: params.slug');
    expect(lifecycleSection).not.toContain('broadcastPluginLifecycleEvent("lvis:plugins:install-result", { slug: params.slug');
    expect(lifecycleSection).not.toContain("preparePythonRuntimeForInstalledPlugin");
    expect(lifecycleHelperIndex).toBeGreaterThanOrEqual(0);
    expect(lifecycleSection).toContain("pluginRuntime: activeServices.pluginRuntime");
    expect(lifecycleSection).toContain("pluginMarketplace: activeServices.pluginMarketplace");
    expect(lifecycleSection).toContain(
      "const cleanupServices = requirePluginCleanupServices(activeServices)",
    );
    expect(lifecycleSection).toContain(
      "ensurePluginStateReadyForInstall(candidatePluginId",
    );
    expect(lifecycleSection).not.toContain("activeServices.pluginRuntime.addPlugin(pluginId)");
    expect(lifecycleSection).not.toContain("activeServices.pluginMarketplace.uninstall(pluginId)");
    expect(progressBridgeIndex).toBeGreaterThanOrEqual(0);
    expect(failureIndex).toBeGreaterThanOrEqual(0);
    expect(successIndex).toBeGreaterThanOrEqual(0);
    expect(lifecycleHelperIndex).toBeLessThan(successIndex);
    expect(lifecycleHelperIndex).toBeLessThan(failureIndex);
  });

  it("replaces plugin event bridge subscriptions when the main window is recreated", async () => {
    // C17: the deep-link window-recreation path (which re-registers the plugin
    // event bridge for the freshly created main window) moved into
    // src/main/lvis-deep-link.ts. C18: the bridge replacement wiring moved from
    // boot.ts into boot/steps/conversation-wiring.ts + boot/assemble-services.ts
    // as BootContext (`ctx.*`) fields — same guarantee, new location.
    const mainSource = await readSource("../main/lvis-deep-link.ts");
    const bootSource = await readBootWiring();

    expect(mainSource).toContain("registerMainWindowPluginEventBridge(mainWindow)");
    expect(bootSource).toContain("replacePluginEventBridge = (win: BrowserWindow) => {");
    expect(bootSource).toContain("pluginEventBridgeWindow = mainWindow;");
    expect(bootSource).toContain("pluginEventBridgeWindow = win;");
    expect(bootSource).toContain("disposePluginEventBridge();");
    expect(bootSource).toContain("replacePluginEventBridge(ctx.pluginEventBridgeWindow);");
    expect(bootSource).toContain("registerPluginEventBridge: ctx.replacePluginEventBridge");
  });
});
