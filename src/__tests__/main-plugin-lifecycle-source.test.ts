import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function readSource(relative: string): Promise<string> {
  return readFile(new URL(relative, import.meta.url), "utf8");
}

describe("main process plugin lifecycle regression guards", () => {
  it("reports lvis:// install success only after runtime activation succeeds", async () => {
    const source = await readSource("../main.ts");
    const lifecycleSection = source.match(
      /const installLockId[\s\S]*?\.catch\(\(err: Error\) => \{/,
    )?.[0];

    expect(lifecycleSection, "deep-link install lifecycle section must be present").toBeTruthy();
    expect(source).not.toMatch(/mainWindow\?\.webContents\.send\("lvis:plugins:(install-progress|install-result|uninstall-result)"/);

    const lockIndex = lifecycleSection!.indexOf("withPluginInstallLock(installLockId");
    const canonicalIdIndex = lifecycleSection!.indexOf("item.id === params.slug || item.slug === params.slug");
    const pythonPrepIndex = lifecycleSection!.indexOf("await preparePythonRuntimeForInstalledPlugin(pluginId");
    const addIndex = lifecycleSection!.indexOf("await activeServices.pluginRuntime.addPlugin(pluginId)");
    const rollbackIndex = lifecycleSection!.indexOf("await activeServices.pluginMarketplace.uninstall(pluginId)");
    const failureIndex = lifecycleSection!.indexOf(
      'broadcastPluginLifecycleEvent("lvis:plugins:install-result", { slug: lifecycleSlug, success: false, error: message })',
    );
    const successIndex = lifecycleSection!.indexOf(
      'broadcastPluginLifecycleEvent("lvis:plugins:install-result", { slug: lifecycleSlug, success: true })',
    );

    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(canonicalIdIndex).toBeGreaterThanOrEqual(0);
    expect(pythonPrepIndex).toBeGreaterThanOrEqual(0);
    expect(addIndex).toBeGreaterThanOrEqual(0);
    expect(rollbackIndex).toBeGreaterThanOrEqual(0);
    expect(failureIndex).toBeGreaterThanOrEqual(0);
    expect(successIndex).toBeGreaterThanOrEqual(0);
    expect(pythonPrepIndex).toBeLessThan(addIndex);
    expect(addIndex).toBeLessThan(successIndex);
    expect(rollbackIndex).toBeLessThan(failureIndex);
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
