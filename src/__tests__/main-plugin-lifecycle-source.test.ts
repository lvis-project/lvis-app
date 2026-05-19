import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function readSource(relative: string): Promise<string> {
  return readFile(new URL(relative, import.meta.url), "utf8");
}

describe("main process plugin lifecycle regression guards", () => {
  it("reports lvis:// install success only after runtime activation succeeds", async () => {
    const source = await readSource("../main.ts");
    const lifecycleSection = source.match(
      /let installProgressSlug = params\.slug[\s\S]*?\n}\n\nfunction activateView/,
    )?.[0];

    expect(lifecycleSection, "deep-link install lifecycle section must be present").toBeTruthy();
    expect(source).not.toMatch(/mainWindow\?\.webContents\.send\("lvis:plugins:(install-progress|install-result|uninstall-result)"/);

    const lockIndex = lifecycleSection!.indexOf("withPluginInstallLock(installLockId");
    const canonicalIdIndex = lifecycleSection!.indexOf("item.id === params.slug || item.slug === params.slug");
    const progressAliasIndex = lifecycleSection!.indexOf("let installProgressSlug = params.slug");
    const progressCanonicalIndex = lifecycleSection!.indexOf("installProgressSlug = installLockId");
    const canonicalProgressIndex = lifecycleSection!.indexOf('slug: installLockId');
    const catchResultIndex = source.indexOf('slug: installProgressSlug');
    const lifecycleHelperIndex = lifecycleSection!.indexOf("await startInstalledPluginWithLifecycle({");
    const failureIndex = lifecycleSection!.indexOf(
      'broadcastPluginLifecycleEvent("lvis:plugins:install-result", { slug: pluginId, success: false, error: message })',
    );
    const successIndex = lifecycleSection!.indexOf("success: true", lifecycleHelperIndex);

    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(canonicalIdIndex).toBeGreaterThanOrEqual(0);
    expect(progressAliasIndex).toBeGreaterThanOrEqual(0);
    expect(progressCanonicalIndex).toBeGreaterThanOrEqual(0);
    expect(canonicalProgressIndex).toBeGreaterThanOrEqual(0);
    expect(catchResultIndex).toBeGreaterThanOrEqual(0);
    expect(lifecycleSection).not.toContain('broadcastPluginLifecycleEvent("lvis:plugins:install-progress", { slug: params.slug');
    expect(lifecycleSection).not.toContain('broadcastPluginLifecycleEvent("lvis:plugins:install-result", { slug: params.slug');
    expect(lifecycleSection).not.toContain("preparePythonRuntimeForInstalledPlugin");
    expect(lifecycleHelperIndex).toBeGreaterThanOrEqual(0);
    expect(lifecycleSection).toContain('rollbackMode: "marketplace"');
    expect(lifecycleSection).toContain("pluginRuntime: activeServices.pluginRuntime");
    expect(lifecycleSection).toContain("pluginMarketplace: activeServices.pluginMarketplace");
    expect(lifecycleSection).not.toContain("activeServices.pluginRuntime.addPlugin(pluginId)");
    expect(lifecycleSection).not.toContain("activeServices.pluginMarketplace.uninstall(pluginId)");
    expect(failureIndex).toBeGreaterThanOrEqual(0);
    expect(successIndex).toBeGreaterThanOrEqual(0);
    expect(lifecycleHelperIndex).toBeLessThan(successIndex);
    expect(lifecycleHelperIndex).toBeLessThan(failureIndex);
  });

  it("replaces plugin event bridge subscriptions when the main window is recreated", async () => {
    const mainSource = await readSource("../main.ts");
    const bootSource = await readSource("../boot.ts");

    expect(mainSource).toContain("registerMainWindowPluginEventBridge(mainWindow)");
    expect(bootSource).toContain("const replacePluginEventBridge = (win: BrowserWindow) => {");
    expect(bootSource).toContain("let pluginEventBridgeWindow = mainWindow;");
    expect(bootSource).toContain("pluginEventBridgeWindow = win;");
    expect(bootSource).toContain("disposePluginEventBridge();");
    expect(bootSource).toContain("replacePluginEventBridge(pluginEventBridgeWindow);");
    expect(bootSource).toContain("registerPluginEventBridge: replacePluginEventBridge");
  });
});
