



import { app } from "electron";
import { resolve } from "node:path";
import { t } from "./i18n/index.js";
import { bootstrap } from "./boot.js";
import { registerIpcHandlers, unregisterPluginWebview } from "./ipc-bridge.js";
import {
  installHtmlPreviewPartitionBlock,
  installPluginPartitionPolicy,
} from "./main/html-preview-partition.js";
import { isAuthOwned } from "./main/auth-window-registry.js";
import { isLinkOwned } from "./main/link-window-registry.js";
import { shouldBlockGlobalWebviewNavigation } from "./main/webview-navigation-policy.js";
import { installSideBrowserPartitionPolicy } from "./main/side-browser-webview.js";
import { findLvisProtocolUri } from "./main/lvis-protocol.js";
import { buildDevProtocolArgs } from "./main/electron-protocol-args.js";
import { devNoSandboxAllowed, setIsPackaged } from "./boot/dev-flags.js";
import { WindowManager } from "./main/window-manager.js";
import { createLogger } from "./lib/logger.js";
import {
  isAppUpdateInstallPrepared,
  isAppUpdateInstallRequested,
  markAppUpdateInstallPrepared,
} from "./main/app-update-install-intent.js";
import { mainDir, distRoot, projectRoot } from "./main/main-paths.js";
import { applyRuntimeAppIcon, runEarlyBootEnv } from "./main/early-boot-env.js";
import { ensureCorporateCaInjected } from "./main/corp-ca-runtime.js";
import { updateSplashStatus, waitForMinimumBootstrapSplash } from "./main/bootstrap-splash.js";
import { runAppShutdownCleanup } from "./main/app-shutdown.js";
import {
  createWindow,
  getAppWindows,
  initialThemeArgs,
  loadMainInterface,
  showMainWindow,
} from "./main/main-window.js";
import { detachedWindowOptionsForViewKey, refreshApplicationMenu } from "./main/app-menu.js";
import { ensureTray, showOrCreateMainWindow } from "./main/app-tray.js";
import { readStartupLaunchState } from "./main/startup-launch.js";
import { reconcileOsIntegrationOnBoot } from "./main/reconcile-os-integration.js";
import { registerSettingsWindowHandlers } from "./main/settings-window.js";
import { maybeStartLocalApiServer } from "./main/local-api-server.js";
import { createA2ALoopbackRuntime } from "./main/a2a-loopback-runtime.js";
import { getLvisAppVersion } from "./shared/app-version.js";
import { installNativeEditContextMenu } from "./main/native-edit-context-menu.js";
import { handleLvisUri, lvisDevLog } from "./main/lvis-deep-link.js";
import {
  getMainWindow,
  getPendingLvisUri,
  getServices,
  isAppShutdownCompleted,
  isAppShutdownStarted,
  isPendingRendererReload,
  setPendingLvisUri,
  setRendererReloadReady,
  setServices,
  setWindowManager,
} from "./main/app-state.js";

const log = createLogger("lvis");

// Early boot environment — workspace cwd, plugin-asset protocol scheme, WSL/GPU
// switches, app name/AppUserModelId, demo activation + host resolver, env
// scrub. MUST run before app.whenReady(); called here at module load.
runEarlyBootEnv();

/**
 * `--plugin-smoke=<id1>,<id2>,...` CLI flag.
 *
 * Verifies that the named plugins mount + init correctly during boot, then
 * exits 0 (success) or 1 (any plugin missing / failed to initialize). Used
 * by per-plugin smoke tests in CI and by the Cycle 2 verification gate.
 *
 * Returns null if the flag is not present.
 */
function parsePluginSmokeFlag(argv: readonly string[]): string[] | null {
  for (const arg of argv) {
    if (arg.startsWith("--plugin-smoke=")) {
      const raw = arg.slice("--plugin-smoke=".length);
      const ids = raw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      return ids;
    }
  }
  return null;
}

const pluginSmokeIds = parsePluginSmokeFlag(process.argv);

async function main() {
  // Initialise WindowManager before createWindow so registerMainWindow() can
  // be called synchronously inside createWindow().
  const preloadPath = resolve(mainDir, "..", "preload.cjs");
  const windowManager = new WindowManager({
    preloadPath,
    distRoot,
    getInitialThemeArgs: initialThemeArgs,
    resolveDetachedWindowOptions: detachedWindowOptionsForViewKey,
  });
  setWindowManager(windowManager);


  createWindow();

  updateSplashStatus(t("be_main.splashCheckingCerts"));
  await ensureCorporateCaInjected();

  // Drive splash status from the real bootstrap pipeline so the text below
  // the wordmark matches what's actually happening rather than cycling
  // through a setInterval list. The fallback idle cycle inside the splash
  // still runs until the first explicit update lands.
  updateSplashStatus(t("be_main.splashLoadingSettings"));


  const services = await bootstrap(projectRoot, getMainWindow()!, () => getMainWindow());
  setServices(services);

  updateSplashStatus(t("be_main.splashOpeningWorkspace"));

  // `--plugin-smoke=<id,...>` exits early after verifying that the
  // named plugins mounted + initialized. Boot already awaited
  // pluginRuntime.startAll(); here we just confirm the named ids are loaded.
  if (pluginSmokeIds !== null) {
    const loadedIds = new Set(services.pluginRuntime.listPluginIds());
    const missing = pluginSmokeIds.filter((id) => !loadedIds.has(id));
    if (missing.length > 0) {
      log.error(
        "plugin-smoke: %d/%d plugins missing: %s",
        missing.length,
        pluginSmokeIds.length,
        missing.join(","),
      );
      app.exit(1);
      return;
    }
    log.info(`all ${pluginSmokeIds.length} plugins initialized`);
    app.exit(0);
    return;
  }

  // Window IPC handlers registered after bootstrap so auditLogger is available
  // for validateSender + viewKey security guards added in PR #354 follow-up.
  windowManager.registerIpc(services.auditLogger);

  // §4.1 IPC Bridge — 반드시 index.html 로드 전에 등록 (renderer useEffect race 방지)
  registerIpcHandlers(
    services,
    () => getMainWindow(),
    getAppWindows,
  );
  registerSettingsWindowHandlers(services.auditLogger);

  // #1436: start the OPT-IN loopback local API server (OFF by default; enabled
  // via Settings → system.localApiServer OR env LVIS_LOCAL_API=1). Wrapped in
  // try/catch so this aux transport can NEVER brick app boot — when the gate is
  // off maybeStartLocalApiServer returns null immediately (no code path throws).
  try {
    const localApi = await maybeStartLocalApiServer({
      services,
      getMainWindow: () => getMainWindow(),
      getAppWindows,
      createA2ARouter: ({ approveAgentAction }) => {
        const project = services.conversationLoop.getSessionProjectContext();
        return createA2ALoopbackRuntime({
          services,
          project: {
            root: project.projectRoot ?? services.conversationLoop.getSessionExecutionCwd(),
            ...(project.projectName ? { name: project.projectName } : {}),
          },
          appVersion: getLvisAppVersion(),
          approveAgentAction,
        });
      },
      log: (m) => log.info(m),
    });
    if (localApi) log.info(`local API server listening on 127.0.0.1:${localApi.port}`);
  } catch (err) {
    log.error({ err }, "local API server failed to start (continuing boot)");
  }

  // L1: start the routines scheduler AFTER IPC handlers are wired so a
  // routine past-due at boot fires into a renderer that already has a
  // `lvis:routines:v2:fired` listener attached. The scheduler is otherwise
  // safe to start at any time — `start()` is idempotent.
  services.startRoutinesScheduler?.();

  // Same deferral rationale as the routines scheduler: start the Work Board
  // due-soon scanner after IPC + plugin bus are wired so the first emit of
  // `work_board.work_item.due_soon` reaches any subscribed consumer.
  services.startWorkBoardDueSoon?.();

  refreshApplicationMenu();
  ensureTray();
  setRendererReloadReady(true);

  // E4 — reconcile OS-level global shortcuts + login item from persisted
  // settings once the tray + services exist. Registration failures are surfaced
  // via NotificationService (No-Fallback): a global-shortcut conflict inside
  // reconcileGlobalShortcuts, and a login-item apply failure via
  // notifyStartupLaunchFailureIfNeeded. Wiring extracted to
  // reconcileOsIntegrationOnBoot so the conflict-notification path is unit-
  // testable without a full main() startup.
  const initialSettings = services.settingsService.getAll();
  reconcileOsIntegrationOnBoot(initialSettings);
  // Detect a hidden (tray-only) auto-launch so the first window show is
  // suppressed. macOS reports `wasOpenedAsHidden`; Windows uses the `--hidden`
  // launch arg the login item carries.
  const launchedHidden = readStartupLaunchState().wasOpenedAsHidden;

  // 실 UI 로드 — 이 시점부터 렌더러의 IPC 호출이 항상 handler와 매칭됨
  const mainWindow = getMainWindow();
  if (mainWindow) {
    if (!isPendingRendererReload()) await waitForMinimumBootstrapSplash();
    await loadMainInterface(mainWindow, isPendingRendererReload() ? "bootstrap-recovery" : "bootstrap-complete");
    // Hidden auto-launch: loadMainInterface shows the window; hide it back so
    // the app starts in the tray. A user-initiated launch (launchedHidden
    // false) is unaffected.
    if (launchedHidden && !mainWindow.isDestroyed()) {
      mainWindow.hide();
    }
  }

  // Process any lvis:// URI that arrived before services were ready.
  // Deferred until after loadFile so IPC handlers are registered and the
  // renderer's lvis:plugins:install-result listener is active.
  const pendingLvisUri = getPendingLvisUri();
  if (pendingLvisUri) {
    void handleLvisUri(pendingLvisUri);
    setPendingLvisUri(null);
  }
}

// lvis:// custom URI scheme — register before app ready.
// In dev mode (unpackaged) on Windows, Electron requires explicit execPath + args
// so the OS can locate the app correctly when launching from a protocol URI.
// We must also propagate the running process's --user-data-dir so the OS-spawned
// instance lands on the same userData and the single-instance lock actually
// gates it. Without this, dev (Electron-LVIS-Dev) and the protocol-launched
// process land on different userData dirs and both apps coexist.
//
// Argument-builder lives in `src/main/electron-protocol-args.ts` (pure helper)
// so the platform / argv / env policy can be unit-tested without Electron.
//
// `LVIS_WIN_NO_SANDBOX` is read through `dev-flags.ts` SoT instead of by the
// helper itself: the helper takes a resolved `disableSandbox: boolean` so the
// `!app.isPackaged` policy gate cannot be bypassed by a packaged binary that
// inherits the env var. Boot also calls `setIsPackaged` later for any other
// dev-flag callers; this top-level call early-seeds the cache.
setIsPackaged(app.isPackaged);
const _protocolRegistered = app.isPackaged
  ? app.setAsDefaultProtocolClient("lvis")
  : app.setAsDefaultProtocolClient(
      "lvis",
      process.execPath,
      buildDevProtocolArgs({
        argv1: process.argv[1],
        userDataDir: app.getPath("userData") || undefined,
        platform: process.platform,
        disableGpu: process.env.LVIS_KEEP_GPU !== "1",
        disableSandbox: devNoSandboxAllowed(),
      }),
    );
if (!_protocolRegistered) {
  log.warn("setAsDefaultProtocolClient('lvis') failed — deep links may not work in this environment");
}

// macOS: URI delivered via open-url event (register before whenReady to avoid missing cold-start)
app.on("open-url", (event, url) => {
  event.preventDefault();
  void handleLvisUri(url);
});

// Windows/Linux: URI delivered as argv of second instance
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  // We are NOT the primary instance — quit immediately and let the existing
  // primary handle the protocol URL via its `second-instance` listener.
  // Do NOT run bootstrap on this doomed process: pino-pretty's thread-stream
  // worker exits with the process, and the first `log.info(...)` afterwards
  // would throw "the worker has exited" — Electron surfaces that as an
  // uncaught-exception dialog the user sees during marketplace plugin
  // install. Quitting before `whenReady` keeps the second-instance exit
  // silent. Regression guard: `src/__tests__/main-single-instance-gate.test.ts`.
  app.quit();
} else {
  const coldStartUri = findLvisProtocolUri(process.argv);
  if (coldStartUri) {
    setPendingLvisUri(coldStartUri);
  }
  app.on("second-instance", (_event, argv) => {
    // Redact `--user-data-dir=<absolute path>` before logging — the path
    // contains the OS username and on shared/VDI/corp boxes that's PII that
    // would otherwise land in screenshots, support bundles, and stdout
    // capture tools.
    const safeArgv = argv.map((a) =>
      a.startsWith("--user-data-dir=") ? "--user-data-dir=<redacted>" : a,
    );
    lvisDevLog("[lvis] second-instance event fired", { argv: safeArgv });
    const url = findLvisProtocolUri(argv);
    lvisDevLog("[lvis] second-instance URL extracted", { url });
    if (url) void handleLvisUri(url);
    const mainWindow = getMainWindow();
    if (mainWindow) {
      showMainWindow(mainWindow);
    }
  });

  // whenReady is scoped to the primary-instance branch — second-instance
  // processes must NOT run main(). See the comment on `app.quit()` above.
  app.whenReady().then(() => {
    applyRuntimeAppIcon();
    installHtmlPreviewPartitionBlock();
    installSideBrowserPartitionPolicy();
    void main().catch((error) => {
      log.error({ err: error }, "bootstrap failed");
      app.quit();
    });
  });
}

// render_html tool webview hardening — the <webview> element carries LLM
// authored HTML. It loads a data: URL and must never navigate anywhere else
// (a click on <a href="…"> would bypass the injected meta CSP by moving to a
// new document). Deny every non-data navigation and new-window attempt on
// any webview webContents as soon as it's created.
app.on("web-contents-created", (_event, contents) => {
  if (contents.getType() !== "webview") {
    installNativeEditContextMenu(contents);
    return;
  }

  // Eagerly install the partition network policy at attach time —
  // BEFORE the first navigation lands. The previous `did-navigate`
  // hook ran AFTER the first request, leaving a TOCTOU window where
  // the plugin shell document itself escaped the file://-only allow
  // list. `installPluginPartitionPolicy` is idempotent so re-installs
  // on the same partition are no-ops.
  //
  // BUG (#498): `contents.session.partition` is undocumented and returns
  // `undefined` on current Electron, so this guard never matches and
  // `setPreloads` is never called → plugin webviews load without the
  // `lvisPlugin` contextBridge → shell aborts with "lvisPlugin bridge
  // missing". The proper fix pre-registers the policy at boot for every
  // known plugin partition (see `boot/steps/plugin-runtime.ts`); the
  // attach-time hook here is kept for the case where the partition wasn't
  // pre-registered (defensive only).
  const partitionName = (contents.session as unknown as { partition?: string }).partition;
  if (typeof partitionName === "string" && partitionName.startsWith("persist:plugin:")) {
    installPluginPartitionPolicy(partitionName);
  }

  // Plugin webview lifecycle: clean up the (webContents.id → pluginId)
  // registry entry on destroy so a stale id can't be reused for an
  // unrelated future webContents. `render-process-gone` covers the case
  // where the underlying renderer process crashes (sandbox kill, OOM,
  // GPU lost) — Electron does not always emit `destroyed` synchronously
  // afterwards, so we clear the binding eagerly.
  const dropBinding = () => unregisterPluginWebview(contents.id);
  contents.on("destroyed", dropBinding);
  contents.on("render-process-gone", dropBinding);

  contents.on("will-navigate", (navEvent) => {
    // Plugin webview policy: allow file:// navigations ONLY into the app's
    // dist/src directory (plugin-ui-shell.html + plugin entry modules
    // resolved by the shell). The previous substring match on ".js" or
    // "plugin-ui-shell" let any local .js file load — treat that as LFI
    // and reject. LLM-HTML webviews (different consumer) keep the
    // data:/about: only fallback below.
    //
    // URL must come from the canonical `navEvent.url` payload. Electron 41.x
    // empties the deprecated positional `url` arg, so reading it would crash
    // here and bypass the security check entirely.
    const url = navEvent.url;
    const currentUrl = contents.getURL();
    // Auth and external-link viewer webviews load remote http(s) pages under
    // scoped per-window policies. Keep the global guard deny-by-default for
    // every unregistered webview.
    if (shouldBlockGlobalWebviewNavigation({
      url,
      currentUrl,
      distRoot,
      authOwned: isAuthOwned(contents),
      linkOwned: isLinkOwned(contents),
    })) {
      navEvent.preventDefault();
    }
  });
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
});

app.on("child-process-gone", (_event, details) => {
  log.error({
    type: details.type,
    reason: details.reason,
    exitCode: details.exitCode,
    serviceName: details.serviceName ?? "",
    name: details.name ?? "",
  }, "child process gone");
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// macOS: re-create window on Dock icon click when all windows are closed.
// Re-register the plugin event bridge for the new window (Issue 5).
app.on("activate", () => {
  showOrCreateMainWindow("activate");
});

app.on("before-quit", (event) => {
  const appUpdateInstallRequested = isAppUpdateInstallRequested();
  if (isAppUpdateInstallPrepared()) return;
  if (!getServices() || isAppShutdownCompleted()) return;
  if (isAppShutdownStarted()) {
    event.preventDefault();
    return;
  }
  event.preventDefault();
  void (async () => {
    const outcome = await runAppShutdownCleanup({
      reason: appUpdateInstallRequested ? "app-update-install" : "before-quit",
      exitOnTimeout: !appUpdateInstallRequested,
    });
    if (appUpdateInstallRequested) {
      markAppUpdateInstallPrepared();
      app.quit();
      return;
    }
    if (outcome === "timed-out") return;
    app.quit();
  })();
});
