/**
 * LVIS App — Electron Main Process Entry
 *
 * 슬림 엔트리. 모든 로직은 boot.ts와 ipc-bridge.ts로 위임.
 * §4.1 Client Architecture 준수.
 */
import { Menu, app, BrowserWindow, shell, dialog, type MenuItemConstructorOptions } from "electron";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import * as https from "node:https";
import * as tls from "node:tls";
import { Agent, setGlobalDispatcher } from "undici";
import { fileURLToPath } from "node:url";
import { bootstrap, type AppServices } from "./boot.js";
import { registerIpcHandlers } from "./ipc-bridge.js";
import { ensureCorporateCa } from "./main/corp-ca-loader.js";
import { installHtmlPreviewPartitionBlock, installPluginPartitionPolicy } from "./main/html-preview-partition.js";
import { findLvisProtocolUri } from "./main/lvis-protocol.js";
import { buildDevProtocolArgs } from "./main/electron-protocol-args.js";
import { devNoSandboxAllowed, setIsPackaged } from "./boot/dev-flags.js";
import { deliverRoutineResult } from "./routines/routine-delivery.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const distRoot = resolve(__dirname, "..");
const projectRoot = resolve(distRoot, "..");

// WSL 환경 대응
if (process.platform === "linux" && process.env.WSL_DISTRO_NAME) {
  app.commandLine.appendSwitch("enable-features", "UseOzonePlatform");
  if (process.env.WAYLAND_DISPLAY) {
    app.commandLine.appendSwitch("ozone-platform-hint", "wayland");
  } else if (process.env.DISPLAY) {
    app.commandLine.appendSwitch("ozone-platform-hint", "x11");
  }
}
// §GPU: Prevent the Chromium GPU utility process from spawning on Windows corp/VDI
// machines where restricted drivers produce repeated ContextResult::kFatalFailure
// errors that eventually kill the renderer process (GPU-lost IPC → render-process-gone).
// Must be called before app.whenReady(). The launch-script --disable-gpu flags only
// stop renderer compositing; only disableHardwareAcceleration() stops the GPU process.
// Mirror the same guard as scripts/run-electron.mjs: opt-out with LVIS_KEEP_GPU=1.
if (process.platform === "win32" && process.env.LVIS_KEEP_GPU !== "1") {
  app.disableHardwareAcceleration();
}

// Phase 1 trust-hardening — strip LVIS_DEV* / LVIS_ALLOW_* from process.env in
// packaged builds before any preload, renderer, or worker inherits it.
// Without this scrub, a packaged binary launched with LVIS_DEV=1 in the user
// environment would expose `env.isDev=true` to the renderer (via preload's
// contextBridge) and let UI code enable dev affordances. Renderer-side flags
// are advisory rather than load-bearing for trust decisions, but allowing them
// to flip in packaged builds creates a confusing forensic signal.
if (app.isPackaged) {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("LVIS_DEV") || key.startsWith("LVIS_ALLOW_")) {
      delete process.env[key];
    }
  }
}

// §17 C1: 사내망 Corporate CA 런타임 주입 — corp-ca-loader 사용 (정식 대응 완료).
// Phase 1.5의 dev-only TLS bypass 완전 제거. Chromium은 OS keystore 자동 신뢰.
async function injectCorporateCa() {
  try {
    const result = await ensureCorporateCa();
    if (!result.pem) {
      console.warn("[lvis] corporate CA not found — 해외망 사용 중이거나 MDM 미배포. TLS 검증 기본값 유지.");
      return;
    }
    const ca = [...tls.rootCertificates, result.pem];
    // 1) undici (Node fetch / global dispatcher)
    setGlobalDispatcher(new Agent({ connect: { ca } }));
    // 2) https.globalAgent (legacy https.get / https.request)
    (https.globalAgent.options as Record<string, unknown>).ca = ca;
    // 3) tls.setDefaultCACertificates — Node 24 기준 미존재, 향후 확장 포인트
    console.log(`[lvis] corporate CA injected: source=${result.source} certs=${result.certCount} path=${result.path}`);
  } catch (e) {
    // 주입 실패해도 앱은 계속 실행 (해외망에서는 기본 CA로 충분)
    console.error("[lvis] corporate CA 주입 실패 (non-fatal):", (e as Error).message);
  }
}
await injectCorporateCa();

let mainWindow: BrowserWindow | null = null;
let services: AppServices | null = null;
let pendingLvisUri: string | null = null;
let lastRendererReloadAt = 0;
let rendererReloadReady = false;
let pendingRendererReload = false;
let appShutdownStarted = false;
let appShutdownCompleted = false;

const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

function parseLvisInstallUri(url: string): { slug: string } | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "lvis:") return null;
    if (parsed.hostname !== "install") return null;
    if (parsed.search || parsed.hash) return null;
    const slug = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
    if (!slug || !SLUG_RE.test(slug)) return null;
    return { slug };
  } catch {
    return null;
  }
}

/**
 * Diagnostic log gate — diagnostic console output is dev-only. Packaged
 * builds skip these noisy traces so end-user log files stay clean.
 *
 * Intentionally NOT routed through `dev-flags.ts:isDevModeUnlocked()`:
 * those helpers require an explicit LVIS_DEV* opt-in to enable, but the
 * lvis:// protocol diagnostic flow needs to be debuggable on every
 * unpackaged dev session without forcing the operator to flip an env var.
 * The `app.isPackaged` boundary alone is the right level for log-only
 * output (no trust decisions ride on these calls).
 */
const lvisDevLog: typeof console.log = (...args) => {
  if (app.isPackaged) return;
  console.log(...args);
};
const lvisDevWarn: typeof console.warn = (...args) => {
  if (app.isPackaged) return;
  console.warn(...args);
};

async function handleLvisUri(url: string) {
  lvisDevLog("[lvis] handleLvisUri called", { url });
  const params = parseLvisInstallUri(url);
  if (!params) {
    lvisDevWarn("[lvis] handleLvisUri: parseLvisInstallUri returned null", { url });
    return;
  }
  lvisDevLog("[lvis] handleLvisUri parsed", { slug: params.slug, servicesReady: !!services });
  if (!services) {
    lvisDevLog("[lvis] handleLvisUri: services not ready, queueing", { slug: params.slug });
    pendingLvisUri = url;
    return;
  }
  // macOS: app stays running after all windows closed. If the deep link arrives
  // with no window, re-open one so the confirmation dialog has a parent and the
  // user actually sees the install prompt (rather than it silently no-op'ing).
  if (!mainWindow || mainWindow.isDestroyed()) {
    lvisDevLog("[lvis] handleLvisUri: recreating window");
    createWindow();
    try {
      if (mainWindow) await (mainWindow as BrowserWindow).loadFile(resolve(__dirname, "index.html"));
    } catch (err) {
      console.error("[lvis] failed to load index.html for lvis:// URI", err);
    }
  }
  mainWindow?.focus();
  const win = mainWindow;
  if (!win) {
    // createWindow() failed or was destroyed — abort rather than install silently.
    console.warn("[lvis] handleLvisUri: no window available, aborting install");
    return;
  }
  lvisDevLog("[lvis] handleLvisUri: showing confirmation dialog", { slug: params.slug });
  const { response } = await dialog.showMessageBox(win, {
    type: "question",
    buttons: ["설치", "취소"],
    defaultId: 1,
    cancelId: 1,
    message: `플러그인 '${params.slug}'을(를) 설치하시겠습니까?`,
    detail: "외부 링크로부터 요청된 설치입니다.",
  });
  lvisDevLog("[lvis] handleLvisUri: dialog response", { slug: params.slug, response });
  if (response !== 0) return;
  lvisDevLog("[lvis] handleLvisUri: starting install", { slug: params.slug });
  // Renderer renders a skeleton card / sidebar placeholder while these
  // phase events fire — see PluginConfigTab + Sidebar progress UI.
  mainWindow?.webContents.send("lvis:plugins:install-progress", { slug: params.slug, phase: "installing" });
  void services.pluginMarketplace
    .install(params.slug)
    .then(async () => {
      lvisDevLog("[lvis] handleLvisUri: install succeeded", { slug: params.slug });
      // Mirror the post-install steps from the lvis:plugins:install IPC handler
      // so deep-link installs behave identically to in-app installs.
      try {
        mainWindow?.webContents.send("lvis:plugins:install-progress", { slug: params.slug, phase: "restarting" });
        await services!.pluginRuntime.restartAll();
        services!.refreshPluginNotifications?.();
      } catch (err) {
        console.error("[lvis] post-install steps failed for lvis:// install", err);
      }
      mainWindow?.webContents.send("lvis:plugins:install-result", { slug: params.slug, success: true });
    })
    .catch((err: Error) => {
      console.error("[lvis] lvis:// install failed", { slug: params.slug, error: err.message, stack: err.stack });
      mainWindow?.webContents.send("lvis:plugins:install-result", { slug: params.slug, success: false, error: err.message });
    });
}

function activateView(viewKey: string) {
  mainWindow?.webContents.send("lvis:view:activate", { viewKey });
}

function createViewMenu() {
  if (!services) return { label: "플러그인", submenu: [] as MenuItemConstructorOptions[] };
  const pluginViews = services.pluginRuntime
    .listUiExtensions()
    .filter((item) => item.extension.slot === "sidebar")
    .map((item) => ({
      key: `plugin:${item.pluginId}:${item.extension.id}`,
      label: item.extension.displayName?.trim() || item.extension.title || item.pluginId,
    }));
  return {
    label: "플러그인",
    submenu: [
      { label: "홈", click: () => activateView("home") },
      ...pluginViews.map((item) => ({
        label: item.label,
        click: () => activateView(item.key),
      })),
    ],
  };
}

function refreshApplicationMenu() {
  const template: MenuItemConstructorOptions[] =
    process.platform === "darwin"
      ? [
          { label: app.name, submenu: [{ role: "about" }, { type: "separator" }, { role: "quit" }] },
          createViewMenu(),
          { label: "편집", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }] },
          { label: "보기", submenu: [{ role: "reload" }] },
        ]
      : [createViewMenu()];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function loadMainInterface(win: BrowserWindow, reason: string) {
  if (win.isDestroyed()) return;
  try {
    await win.loadFile(resolve(__dirname, "index.html"));
    pendingRendererReload = false;
    console.log("[lvis] main interface loaded", { reason });
  } catch (err) {
    console.error("[lvis] failed to load index.html", { reason, err });
  }
}

/**
 * Bootstrap 동안 렌더러에 표시할 임시 splash HTML.
 * 실 index.html은 IPC 핸들러 등록 후에 로드된다 — 초기 useEffect IPC 호출이
 * 핸들러보다 앞서는 race 방지 (§M-race fix).
 */
const BOOTSTRAP_SPLASH = `<!DOCTYPE html>
<html lang="ko"><head><meta charset="utf-8"><title>LVIS</title>
<style>
  html,body{margin:0;height:100%;background:#0b0b10;color:#e4e4e8;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
  .wrap{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;gap:.8rem}
  h1{margin:0;font-size:1.1rem;font-weight:600;letter-spacing:.02em}
  p{margin:0;font-size:.85rem;opacity:.65}
  .spin{width:24px;height:24px;border:2px solid #2a2a33;border-top-color:#7a7aff;border-radius:50%;animation:s 1s linear infinite}
  @keyframes s{to{transform:rotate(360deg)}}
</style></head><body><div class="wrap"><div class="spin"></div><h1>LVIS 초기 부팅 중</h1><p>Python 런타임과 플러그인을 준비하고 있습니다…</p></div></body></html>`;

function createWindow() {
  const preloadPath = resolve(__dirname, "preload.js");
  if (!existsSync(preloadPath)) {
    throw new Error(`[lvis] preload.js not found at ${preloadPath} — run 'npm run build:preload' first`);
  }

  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    show: true,
    autoHideMenuBar: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // render_html tool renders LLM-produced HTML inside an Electron
      // <webview>. The webview runs on its own webContents / OS process so
      // a malicious or runaway payload (e.g. `while(true){}`) can't freeze
      // the main UI. The <webview> tag is gated by webPreferences.webviewTag.
      webviewTag: true,
      preload: preloadPath,
    },
  });

  const win = mainWindow;
  // Development debugging is provided by an in-app floating console toggle in
  // the renderer. Avoid docking Chromium DevTools into the main window because
  // it distorts the runtime viewport and causes misleading layout regressions.

  win.once("ready-to-show", () => {
    console.log("[lvis] window ready-to-show");
    win.show();
    win.focus();
  });
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });
  win.webContents.on("did-fail-load", (_e, code, desc, url) => {
    console.error("[lvis] window failed to load", { code, desc, url });
  });
  // Recovery: if the renderer crashes (e.g. GPU-lost after GPU utility failure),
  // reload index.html. IPC handlers are registered on the main-process side and
  // survive a renderer restart — the reloaded renderer reconnects automatically.
  win.webContents.on("render-process-gone", (_e, details) => {
    console.error("[lvis] main window renderer process gone", details);
    if (!rendererReloadReady) {
      pendingRendererReload = true;
      console.warn("[lvis] renderer reload deferred until bootstrap + IPC registration complete");
      return;
    }
    const now = Date.now();
    if (!win.isDestroyed() && now - lastRendererReloadAt > 3000) {
      lastRendererReloadAt = now;
      void loadMainInterface(win, "render-process-gone");
    } else if (!win.isDestroyed()) {
      console.warn("[lvis] render-process-gone reload suppressed to avoid crash loop");
    }
  });

  // 외부 URL → 시스템 브라우저로 리다이렉트 (앱 내 탐색 방지)
  // window.open() 차단
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsedUrl = new URL(url);
      const allowedProtocols = new Set(["http:", "https:"]);

      if (allowedProtocols.has(parsedUrl.protocol)) {
        void shell.openExternal(parsedUrl.toString()).catch((err) => {
          console.error("[lvis] failed to open external URL", { url: parsedUrl.toString(), err });
        });
      } else {
        console.warn("[lvis] blocked external URL with disallowed protocol", {
          url,
          protocol: parsedUrl.protocol,
        });
      }
    } catch (err) {
      console.warn("[lvis] blocked invalid external URL", { url, err });
    }
    return { action: "deny" };
  });
  // <a href> 클릭 또는 location.href 변경으로 인한 탐색 차단
  win.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("file://") && !url.startsWith("data:")) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  // §M-race: bootstrap 동안 splash만 표시. 실 index.html 로드는 main()이
  // IPC 핸들러 등록 후 수행.
  void win
    .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(BOOTSTRAP_SPLASH)}`)
    .catch((err) => console.error("[lvis] splash load failed", err));
}

async function main() {
  // §4.2 Step 8: window 생성 (splash 표시) — bootstrap이 mainWindow를 필요로 함
  createWindow();

  // §4.2 Boot Sequence (mainWindow 전달 — PythonRuntimeBootstrapper IPC 사용)
  services = await bootstrap(projectRoot, mainWindow!, () => mainWindow);

  // §4.1 IPC Bridge — 반드시 index.html 로드 전에 등록 (renderer useEffect race 방지)
  registerIpcHandlers(services, () => mainWindow);

  refreshApplicationMenu();
  rendererReloadReady = true;

  // 실 UI 로드 — 이 시점부터 렌더러의 IPC 호출이 항상 handler와 매칭됨
  if (mainWindow) {
    await loadMainInterface(mainWindow, pendingRendererReload ? "bootstrap-recovery" : "bootstrap-complete");
  }

  // Process any lvis:// URI that arrived before services were ready.
  // Deferred until after loadFile so IPC handlers are registered and the
  // renderer's lvis:plugins:install-result listener is active.
  if (pendingLvisUri) {
    void handleLvisUri(pendingLvisUri);
    pendingLvisUri = null;
  }
}

// render_html tool webview hardening — the <webview> element carries LLM
// authored HTML. It loads a data: URL and must never navigate anywhere else
// (a click on <a href="…"> would bypass the injected meta CSP by moving to a
// new document). Deny every non-data navigation and new-window attempt on
// any webview webContents as soon as it's created.
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
// `LVIS_DEV_NO_SANDBOX` is read through `dev-flags.ts` SoT instead of by the
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
  console.warn("[main] setAsDefaultProtocolClient('lvis') failed — deep links may not work in this environment");
}

// macOS: URI delivered via open-url event (register before whenReady to avoid missing cold-start)
app.on("open-url", (event, url) => {
  event.preventDefault();
  void handleLvisUri(url);
});

// Windows/Linux: URI delivered as argv of second instance
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  const coldStartUri = findLvisProtocolUri(process.argv);
  if (coldStartUri) {
    pendingLvisUri = coldStartUri;
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
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

app.on("web-contents-created", (_event, contents) => {
  if (contents.getType() !== "webview") return;

  // Determine the webview's session partition name so we can install the
  // correct network policy before the first navigation.
  // The partition is not directly readable from WebContents, but we can
  // distinguish plugin webviews (persist:plugin:*) from the LLM-HTML webview
  // by checking the initial URL once it's ready.
  contents.once("did-navigate", (_navEvent, url) => {
    if (url.includes("plugin-ui-shell")) {
      // This is a plugin webview. Install a file://-allowing policy on its
      // session partition.  We derive the partition name from the
      // webContents session's partition identifier.
      const partitionName = (contents.session as unknown as { partition?: string }).partition;
      if (typeof partitionName === "string" && partitionName.startsWith("persist:plugin:")) {
        installPluginPartitionPolicy(partitionName);
      }
    }
  });

  contents.on("will-navigate", (navEvent, url) => {
    // Plugin webview policy: allow file:// navigations ONLY into the app's
    // dist/src directory (plugin-ui-shell.html + plugin entry modules
    // resolved by the shell). The previous substring match on ".js" or
    // "plugin-ui-shell" let any local .js file load — treat that as LFI
    // and reject. LLM-HTML webviews (different consumer) keep the
    // data:/about: only fallback below.
    const currentUrl = contents.getURL();
    const isPluginShellFrame = currentUrl.includes("plugin-ui-shell.html");
    if (isPluginShellFrame && url.startsWith("file://")) {
      try {
        const distSrc = resolve(distRoot, "src").replace(/\\/g, "/");
        const allowedPrefix = `file:///${distSrc.replace(/^\//, "")}/`;
        if (url.toLowerCase().startsWith(allowedPrefix.toLowerCase())) return; // allow
      } catch { /* fall through */ }
    }
    if (!url.startsWith("data:") && !url.startsWith("about:")) {
      navEvent.preventDefault();
    }
  });
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
});

app.on("child-process-gone", (_event, details) => {
  console.error("[lvis] child process gone", {
    type: details.type,
    reason: details.reason,
    exitCode: details.exitCode,
    serviceName: details.serviceName ?? "",
    name: details.name ?? "",
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// macOS: re-create window on Dock icon click when all windows are closed.
// Re-register the plugin event bridge for the new window (Issue 5).
app.on("activate", () => {
  if (mainWindow === null || mainWindow.isDestroyed()) {
    createWindow();
    if (mainWindow && services?.registerPluginEventBridge) {
      services.registerPluginEventBridge(mainWindow);
    }
  }
});

app.on("before-quit", (event) => {
  if (!services || appShutdownCompleted) return;
  if (appShutdownStarted) {
    event.preventDefault();
    return;
  }
  appShutdownStarted = true;
  event.preventDefault();
  // Capture services in a local so TypeScript narrowing survives the async
  // closure boundary, and so a future window-closed handler that nulls
  // `services` mid-shutdown cannot NPE us on the next member access.
  const svc = services;
  void (async () => {
    try {
      const routineSettings = svc.settingsService.get("routine");
      if ((routineSettings?.enableShutdownRoutine ?? true) && svc.routineEngine) {
        // Isolate the routine call so a throw here doesn't skip the
        // services.shutdown() / pluginRuntime.stopAll() teardown below
        // (those persist state and must run on every quit path).
        try {
          const { buildRoutineForTrigger } = await import("./routines/registry.js");
          const { notifyRoutineStarted, notifyRoutineFailed } = await import("./routines/routine-delivery.js");
          const built = buildRoutineForTrigger("shutdown", routineSettings);
          if (built.ok) {
            notifyRoutineStarted(mainWindow, { routineId: "shutdown", trigger: "shutdown", startedAt: new Date().toISOString() });
            try {
              // Bound the LLM call so a hung provider can't block app.quit()
              // indefinitely. 15s is generous for a single-turn summary;
              // beyond that we surface as failure and continue teardown.
              const SHUTDOWN_ROUTINE_TIMEOUT_MS = 15_000;
              const routineEngine = svc.routineEngine;
              const result = await Promise.race([
                routineEngine.runRoutine(built.routine),
                new Promise<never>((_, reject) =>
                  setTimeout(
                    () => reject(new Error(`shutdown routine timed out after ${SHUTDOWN_ROUTINE_TIMEOUT_MS}ms`)),
                    SHUTDOWN_ROUTINE_TIMEOUT_MS,
                  ),
                ),
              ]);
              await deliverRoutineResult(mainWindow, result);
            } catch (e) {
              const message = e instanceof Error ? e.message : String(e);
              console.warn("[lvis] before-quit: shutdown routine failed:", message);
              notifyRoutineFailed(mainWindow, { routineId: "shutdown", trigger: "shutdown" }, message);
            }
          }
        } catch (e) {
          console.warn("[lvis] before-quit: shutdown routine setup failed:", e instanceof Error ? e.message : String(e));
        }
      }
      await svc.shutdown?.();
      await svc.pluginRuntime.stopAll();
    } finally {
      appShutdownCompleted = true;
      app.quit();
    }
  })();
});

app.whenReady().then(() => {
  installHtmlPreviewPartitionBlock();
  void main().catch((error) => {
    console.error("[lvis] bootstrap failed", error);
    app.quit();
  });
});
