import { describe, expect, it } from "vitest";
import { readBootWiring } from "../__tests__/support/boot-wiring-source.js";
import { readRepoFile } from "./test-helpers.js";

describe("main process plugin lifecycle regression guards", () => {
  it("reports lvis:// install success only after runtime activation succeeds", async () => {
    // C17: the lvis:// deep-link install lifecycle moved from main.ts into
    // src/main/lvis-deep-link.ts. Same guarantee, new location — the section
    // is now terminated by the `broadcastPluginLifecycleEvent` definition that
    // immediately follows `handleLvisUri` (previously `activateView`).
    const source = readRepoFile("src/main/lvis-deep-link.ts");
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
    // The failure payload is now built by the shared `buildInstallFailureResult`
    // (one constructor for the IPC handler and this deep link), so the literal
    // `slug: installProgressSlug` object no longer appears. What this index
    // pins is unchanged: the failure is keyed by the CANONICAL install id, not
    // by `params.slug`.
    const catchResultIndex = source.indexOf("buildInstallFailureResult(installProgressSlug");
    const lifecycleHelperIndex = lifecycleSection!.indexOf("await installMarketplacePluginWithLifecycle({");
    const progressBridgeIndex = lifecycleSection!.indexOf("broadcastPluginLifecycleEvent(CHANNELS.plugins.installProgress, payload)");
    const failureIndex = lifecycleSection!.indexOf("buildInstallFailureResult(installProgressSlug");
    const successIndex = lifecycleSection!.indexOf("success: true", lifecycleHelperIndex);

    expect(canonicalIdIndex).toBeGreaterThanOrEqual(0);
    expect(progressAliasIndex).toBeGreaterThanOrEqual(0);
    expect(progressCanonicalIndex).toBeGreaterThanOrEqual(0);
    expect(lifecycleKeyIndex).toBeGreaterThanOrEqual(0);
    expect(requestedIdIndex).toBeGreaterThanOrEqual(0);
    expect(catchResultIndex).toBeGreaterThanOrEqual(0);
    // Both channels are addressed through CHANNELS now, so these guard the
    // current form. Keyed by `params.slug` is the regression they exist for:
    // an alias deep-link would then leave a stale in-flight row.
    expect(lifecycleSection).not.toContain("CHANNELS.plugins.installProgress, { slug: params.slug");
    expect(lifecycleSection).not.toContain("CHANNELS.plugins.installResult, { slug: params.slug");
    // ...and the hardcoded channel strings must not come back either.
    expect(lifecycleSection).not.toContain('broadcastPluginLifecycleEvent("lvis:plugins:install-progress"');
    expect(lifecycleSection).not.toContain('broadcastPluginLifecycleEvent("lvis:plugins:install-result"');
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

  it("addresses the agent/skill lifecycle channels through CHANNELS, not a template", async () => {
    // The deep-link handler used to build `lvis:${ns}:install-progress` and its
    // siblings from the package type. Those strings equal the declared
    // constants today, so no runtime test can tell the two apart — the
    // regression a template invites is a RENAME: `CHANNELS.agents.*` moves, the
    // renderer follows it, and the templated producer keeps broadcasting the
    // old name with nothing failing. This is the assertion that catches it.
    const source = readRepoFile("src/main/lvis-deep-link.ts");
    const channelsHelper = source.match(
      // Terminated by a brace alone on its own line, so the helper's return-TYPE
      // block (which closes with `} {`) does not end the match early.
      /function assistantPackageChannels\([\s\S]*?\r?\n}\r?\n/,
    )?.[0];

    expect(channelsHelper, "assistantPackageChannels must be present").toBeTruthy();
    expect(channelsHelper).toContain("CHANNELS.agents");
    expect(channelsHelper).toContain("CHANNELS.skills");
    // No `lvis:`-prefixed channel literal anywhere in the helper.
    expect(channelsHelper).not.toMatch(/["'`]lvis:/);
    // ...and no template-built channel name anywhere in the file.
    expect(source).not.toMatch(/`lvis:\$\{/);
  });

  it("replaces plugin event bridge subscriptions when the main window is recreated", async () => {
    // C17: the deep-link window-recreation path (which re-registers the plugin
    // event bridge for the freshly created main window) moved into
    // src/main/lvis-deep-link.ts. C18: the bridge replacement wiring moved from
    // boot.ts into boot/steps/conversation-wiring.ts + boot/assemble-services.ts
    // as BootContext (`ctx.*`) fields — same guarantee, new location.
    const mainSource = readRepoFile("src/main/lvis-deep-link.ts");
    const bootSource = await readBootWiring();

    expect(mainSource).toContain("registerMainWindowPluginEventBridge(mainWindow)");
    expect(bootSource).toContain("replacePluginEventBridge = (win: BrowserWindow) => {");
    expect(bootSource).toContain("pluginEventBridgeWindow = mainWindow;");
    expect(bootSource).toContain("pluginEventBridgeWindow = win;");
    expect(bootSource).toContain("disposePluginEventBridge();");
    expect(bootSource).toContain("replacePluginEventBridge(ctx.pluginEventBridgeWindow);");
    expect(bootSource).toContain("registerPluginEventBridge: ctx.replacePluginEventBridge");
    // The assertions above pin the replace/dispose CLOSURES. They do not pin
    // that the bridge is ever registered: replacing both call sites with
    // `ctx.disposePluginEventBridge = () => {}` left all 52 src/boot suites
    // (399 tests) green. These two pin the call sites themselves — boot-time
    // registration for the first main window, and re-registration for a
    // window recreated after `closed`.
    expect(bootSource).toContain(
      "ctx.disposePluginEventBridge = registerPluginEventBridge(pluginRuntime, mainWindow",
    );
    expect(bootSource).toContain(
      "ctx.disposePluginEventBridge = registerPluginEventBridge(pluginRuntime, win",
    );
  });
});
