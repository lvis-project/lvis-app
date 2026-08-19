



import { app } from "electron";
import { t } from "./i18n/index.js";
import { registerIpcHandlers, unregisterPluginWebview } from "./ipc-bridge.js";
import { installHtmlPreviewPartitionBlock } from "./main/html-preview-partition.js";
import { isAuthOwned } from "./main/auth-window-registry.js";
import { isLinkOwned } from "./main/link-window-registry.js";
import { shouldBlockGlobalWebviewNavigation } from "./main/webview-navigation-policy.js";
import { installSideBrowserPartitionPolicy } from "./main/side-browser-webview.js";
import { findLvisProtocolUri } from "./main/lvis-protocol.js";
import { buildDevProtocolArgs } from "./main/electron-protocol-args.js";
import { getPackagedWindowsProtocolMarkerState } from "./main/lvis-protocol-registration.js";
import { devNoSandboxAllowed, setIsPackaged } from "./boot/dev-flags.js";
import { WindowManager } from "./main/window-manager.js";
import { createLogger } from "./lib/logger.js";
import {
  isAppUpdateInstallPrepared,
  isAppUpdateInstallRequested,
  markAppUpdateInstallPrepared,
} from "./main/app-update-install-intent.js";
import { distRoot, projectRoot } from "./main/main-paths.js";
import { applyRuntimeAppIcon, runEarlyBootEnv } from "./main/early-boot-env.js";
import { ensureCorporateCaInjected } from "./main/corp-ca-runtime.js";
import { loadMainStartupDependencies } from "./main/startup-dependencies.js";
import { updateSplashStatus, waitForMinimumBootstrapSplash } from "./main/bootstrap-splash.js";
import { runAppShutdownCleanup } from "./main/app-shutdown.js";
import {
  createWindow,
  getAppWindows,
  loadMainInterface,
  showMainWindow,
} from "./main/main-window.js";
import { refreshApplicationMenu } from "./main/app-menu.js";
import { ensureTray, refreshTrayMenu, showOrCreateMainWindow } from "./main/app-tray.js";
import { configureNativeWindowCoordinator } from "./main/native-window-coordinator.js";
import { readStartupLaunchState } from "./main/startup-launch.js";
import { reconcileOsIntegrationOnBoot } from "./main/reconcile-os-integration.js";
import { maybeStartLocalApiServer } from "./main/local-api-server.js";
import { createConversationSurfaceRuntime } from "./engine/conversation-surface-runtime.js";
import { createConversationCommandPort } from "./main/conversation-command-port.js";
import { createA2ALoopbackRuntime } from "./main/a2a-loopback-runtime.js";
import { maybeStartRemoteA2AReceiverServer } from "./main/a2a-remote-receiver-server.js";
import {
  maybeStartTailnetObserverServer,
  resolveTailnetObserverConfig,
} from "./main/tailnet-surface-server.js";
import { createTailnetPairedSharingRuntime } from "./main/tailnet-paired-sharing-runtime.js";
import { stopTelegramBridgeServer } from "./main/telegram-bridge-server.js";
import { createTelegramConnectionStore } from "./main/telegram-connection-store.js";
import { createTelegramConnectionService } from "./main/telegram-connection-service.js";
import { createTelegramShareChangeWatcher } from "./main/telegram-share-identity.js";
import {
  reconcileTelegramActorKey,
  startTelegramConnectionActivation,
  telegramConversationDigest,
  telegramConversationDigestFor,
} from "./main/telegram-connection-activation.js";
import { createTailnetSharingOwnerService } from "./main/tailnet-sharing-owner-service.js";
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
// switches, app name/AppUserModelId, and packaged-env scrub.
// MUST run before app.whenReady(); called here at module load.
runEarlyBootEnv();

/**
 * `--plugin-smoke=<id1>,<id2>,...` CLI flag.
 *
 * Verifies that the named plugins mount + init correctly during boot, then
 * exits 0 (success) or 1 (any plugin missing / failed to initialize). Used
 * by per-plugin smoke tests in CI and by the boot verification gate.
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
  configureNativeWindowCoordinator({
    showOrCreateMainWindow,
    refreshNativeChrome: () => {
      refreshApplicationMenu();
      refreshTrayMenu();
    },
  });
  // Initialise WindowManager before createWindow so registerMainWindow() can
  // be called synchronously inside createWindow().
  const windowManager = new WindowManager();
  setWindowManager(windowManager);


  createWindow();

  updateSplashStatus(t("be_main.splashCheckingCerts"));
  const { bootstrap } = await loadMainStartupDependencies(
    () => import("./boot.js"),
    ensureCorporateCaInjected,
    () => updateSplashStatus(t("be_main.splashLoadingSettings")),
  );

  // Drive splash status from the real bootstrap pipeline so the text below
  // the wordmark matches what's actually happening rather than cycling
  // through a setInterval list. The fallback idle cycle inside the splash
  // still runs until the first explicit update lands.
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
  // for the validateSender + viewKey security guards.
  windowManager.registerIpc(services.auditLogger);

  // One host-owned source for every main-conversation surface. It outlives the
  // opt-in Local API transport so Electron remains the canonical producer.
  const conversationSurfaceRuntime = createConversationSurfaceRuntime();

  // Commands, like events, have one host-owned entrypoint. Surface adapters
  // receive this instance rather than recreating their own send path.
  const conversationCommandPort = createConversationCommandPort(
    {
      ...services,
      getMainWindow: () => getMainWindow(),
      getAppWindows,
      conversationSurfaceRuntime,
    },
    conversationSurfaceRuntime,
  );
  // Pairing/share state is created once at boot and injected into both local
  // owner controls and the Tailnet listener. A failed OS-encrypted setup never
  // falls back to a second runtime or a plaintext identity secret.
  const getCurrentConversationId = () => services.conversationLoop.getSessionId();
  let tailnetPairedSharingRuntime:
    | Awaited<ReturnType<typeof createTailnetPairedSharingRuntime>>
    | undefined;
  let tailnetPairedSharingBootstrapUnavailable = false;
  let tailnetSharingOwnerService:
    | ReturnType<typeof createTailnetSharingOwnerService>
    | undefined;
  try {
    const tailnetConfig = resolveTailnetObserverConfig();
    if (tailnetConfig?.pairedSharingEnabled) {
      tailnetPairedSharingRuntime = await createTailnetPairedSharingRuntime({
        getCurrentConversationId,
      });
      tailnetSharingOwnerService = createTailnetSharingOwnerService({
        runtime: tailnetPairedSharingRuntime,
        getCurrentConversationId,
      });
    }
  } catch (err) {
    tailnetPairedSharingBootstrapUnavailable = true;
    log.error(
      { err },
      "tailnet paired sharing failed to initialize; owner controls and listener stay unavailable",
    );
  }



  let telegramConnectionService:
    | ReturnType<typeof createTelegramConnectionService>
    | undefined;
  try {
    const telegramStore = createTelegramConnectionStore({
      conversationDigestFor: telegramConversationDigest,
    });
    await telegramStore.open();
    telegramConnectionService = createTelegramConnectionService({
      store: telegramStore,
      settingsService: services.settingsService,
      bridgeControl: {
        start: () => startTelegramConnectionActivation({
          store: telegramStore,
          settingsService: services.settingsService,
          conversationSurfaceRuntime,
          conversationCommandPort,
          getCurrentConversationId,
          // A fatal poll outcome tears the activation down through the same
          // owner-initiated path a manual disconnect uses.
          stopBridge: () => stopTelegramBridgeServer("user"),
          // Read at activation time, not boot order: the gate is created with
          // the main window, after this service but before any owner-driven
          // activation can run. Absent keeps approvals desk-only.
          ...(services.approvalGate ? { approvalGate: services.approvalGate } : {}),
          log: (message: string) => log.info(message),
        }),
        stop: (reason: "shutdown" | "user") => stopTelegramBridgeServer(reason),
      },
      // Sequenced by the service ahead of its own credential read: one keychain
      // reset takes the bot token and the actor key together, and only the
      // service can put the reconcile before the read that would abandon it.
      reconcileActorKey: () => reconcileTelegramActorKey({ store: telegramStore }),
      getCurrentConversationId,
      conversationDigestFor: (conversationId: string) => {
        const digest = telegramConversationDigestFor(telegramStore, conversationId);
        // The service treats a throw here as "no digest available", which is
        // the correct answer before a bot has been verified.
        if (digest === null) throw new Error("telegram-conversation-digest-unavailable");
        return digest;
      },
      // The same source the conversation list is built from, so the owner is
      // never told a share points at something they cannot see.
      conversationExists: (conversationId: string) =>
        services.memoryManager.hasSessionTranscript(conversationId),
    });
    // Any change to the paired share retires an armed Away Authority grant.
    //
    // The grant is a desk gesture about the share that existed when it was
    // made. A revoke, re-share, pause, disconnect or re-pair replaces that
    // share with a different one, and the per-call authority re-check cannot
    // see the difference: a re-pair mints a fresh authority that is perfectly
    // current.
    //
    // The subscription is the store's single mutation chokepoint, but the raw
    // signal is far too broad to act on: the poll offset lives in the same
    // document and advances after every inbound message, so retiring on "the
    // document changed" would retire the grant on the exact traffic it exists
    // to answer. `createTelegramShareChangeWatcher` keeps the chokepoint and
    // compares the share's identity instead.
    telegramConnectionService.subscribe(
      createTelegramShareChangeWatcher({
        readOwnerSnapshot: () => telegramStore.ownerSnapshot(),
        onShareChanged: () => {
          services.approvalGate?.retireAwayAuthority("share-lifecycle");
        },
      }),
    );
  } catch (err) {
    log.error({ err }, "telegram connection service failed to initialize (continuing boot)");
  }

  // §4.1 IPC Bridge — 반드시 index.html 로드 전에 등록 (renderer useEffect race 방지)
  registerIpcHandlers(
    services,
    () => getMainWindow(),
    getAppWindows,
    conversationSurfaceRuntime,
    conversationCommandPort,
    tailnetSharingOwnerService,
    telegramConnectionService,
  );

  // #1436: start the OPT-IN loopback local API server (OFF by default; enabled
  // via Settings → system.localApiServer OR env LVIS_LOCAL_API=1). Wrapped in
  // try/catch so this aux transport can NEVER brick app boot — when the gate is
  // off maybeStartLocalApiServer returns null immediately (no code path throws).
  try {
    const localApi = await maybeStartLocalApiServer({
      services,
      getMainWindow: () => getMainWindow(),
      getAppWindows,
      conversationCommandPort,
      conversationSurfaceRuntime,
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

  // Tailnet is a separate, default-OFF ingress. Its observer is always
  // read-only unless the boot environment explicitly enables the narrow
  // controller capability; it never exposes Local API/A2A or configures Serve.
  try {
    const observer = await maybeStartTailnetObserverServer({
      conversationSurfaceRuntime,
      conversationCommandPort,
      getCurrentConversationId,
      tailnetPairedSharingRuntime: tailnetPairedSharingBootstrapUnavailable
        ? null : tailnetPairedSharingRuntime,
      isConversationBusy: () => conversationSurfaceRuntime.activity.isBusy(),
      log: (message) => log.info(message),
    });
    if (observer) {
      log.info("tailnet observer listening on 127.0.0.1:" + observer.port);
    }
  } catch (err) {
    log.error({ err }, "tailnet observer failed to start (continuing boot)");
  }

  // Telegram is a separately configured external-platform adapter. It remains
  // OFF until the owner connects a bot from the desktop; it never registers a
  // webhook and never shares Tailnet, Local API, or A2A authority.
  try {
    if (telegramConnectionService) {
      // Resume whatever the owner left connected. A paused or disconnected
      // store is a no-op, so nothing reaches Telegram until they ask for it.
      await telegramConnectionService.resumeStoredConnection();
    }
  } catch (err) {
    log.error({ err }, "telegram bridge failed to start (continuing boot)");
  }

  // The remote A2A receiver ingress has an independent immutable gate and
  // listener; it never widens or reuses the local API route family. The app
  // binds only loopback; a separately trusted HTTPS tunnel/terminator owns
  // public ingress.
  try {
    const receiver = await maybeStartRemoteA2AReceiverServer({
      services,
      log: (message) => log.info(message),
    });
    if (receiver) {
      log.info(`remote A2A receiver listening on 127.0.0.1:${receiver.port}`);
    }
  } catch (err) {
    log.error({ err }, "remote A2A receiver failed to start (continuing boot)");
  }

  // Start the routines scheduler AFTER IPC handlers are wired so a
  // routine past-due at boot fires into a renderer that already has a
  // `lvis:routines:fired` listener attached. The scheduler is otherwise
  // safe to start at any time — `start()` is idempotent.
  services.startRoutinesScheduler?.();

  // Same deferral rationale as the routines scheduler: start the Work Board
  // due-soon scanner after IPC + plugin bus are wired so the first emit of
  // `work_board.work_item.due_soon` reaches any subscribed consumer.
  services.startWorkBoardDueSoon?.();

  refreshApplicationMenu();
  ensureTray();
  setRendererReloadReady(true);

  // Reconcile OS-level global shortcuts + login item from persisted
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

// lvis:// custom URI scheme.
// The per-machine Windows installer owns the packaged association in HKLM.
// Its adjacent regular-file marker prevents Electron's Windows setter from
// shadowing HKLM with HKCU. ZIP/win-unpacked builds have no marker and keep
// self-registering; macOS/Linux and every unpackaged build retain the existing
// synchronous registration behavior.
//
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
const packagedWindowsProtocolMarkerState =
  app.isPackaged && process.platform === "win32"
    ? getPackagedWindowsProtocolMarkerState(process.execPath)
    : null;
if (packagedWindowsProtocolMarkerState === "unknown") {
  log.warn(
    "Unable to verify the packaged Windows protocol marker; skipped self-registration",
  );
}
if (
  packagedWindowsProtocolMarkerState !== "present" &&
  packagedWindowsProtocolMarkerState !== "unknown"
) {
  const protocolRegistered = app.isPackaged
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
  if (!protocolRegistered) {
    log.warn(
      "setAsDefaultProtocolClient('lvis') failed — deep links may not work in this environment",
    );
  }
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

  // There is deliberately NO attach-time `installPluginPartitionPolicy` call
  // here (#1953). One used to sit at this point, reading
  // `contents.session.partition` to recover the partition name — but Electron's
  // `Session` exposes no `partition` property (verified against the Electron 43
  // typings; only the *options* interfaces carry one), so the read was always
  // `undefined` and the branch never ran (#498). Keeping it implied a second
  // installer of the partition request filter and a fallback for partitions the
  // lifecycle missed; neither existed.
  //
  // `boot/steps/plugin-runtime.ts` is the single installer, covering every
  // partition a plugin-shell webview can be attached with: the post-`startAll`
  // loop, the `plugin.installed` event, and the `onEnable` lifecycle hook — all
  // keyed by the same `pluginPartitionName(pluginId)` the renderer uses for the
  // `<webview partition=…>` attribute. If a new producer ever attaches a
  // shell-URL webview with a partition that path does not cover, that partition
  // has no request filter and `shouldBlockGlobalWebviewNavigation` below becomes
  // its only gate.

  // Plugin webview lifecycle: clean up the (webContents.id → pluginId)
  // registry entry on destroy so a stale id can't be reused for an
  // unrelated future webContents. `render-process-gone` covers the case
  // where the underlying renderer process crashes (sandbox kill, OOM,
  // GPU lost) — Electron does not always emit `destroyed` synchronously
  // afterwards, so we clear the binding eagerly.
  const dropBinding = () => {
    const services = getServices();
    if (!services) return;
    unregisterPluginWebview(contents.id, services.revokePluginOperationSession);
  };
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
  const fields = {
    type: details.type,
    reason: details.reason,
    exitCode: details.exitCode,
    serviceName: details.serviceName ?? "",
    name: details.name ?? "",
  };
  // A child process going away during shutdown is the shutdown working, not a
  // fault. Logging it at error taught readers that errors here are routine,
  // which is how a real one gets skipped — every quit produced a handful, so
  // the level stopped carrying information.
  //
  // Outside shutdown the same event is a genuine crash and stays at error.
  if (isAppShutdownStarted() || isAppShutdownCompleted()) {
    log.info(fields, "child process gone during shutdown");
    return;
  }
  log.error(fields, "child process gone");
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
