/**
 * LVIS App — Electron Main Process Entry
 *
 * 슬림 엔트리. 모든 로직은 boot.ts와 ipc-bridge.ts로 위임.
 * §4.1 Client Architecture 준수.
 */
import { Menu, app, BrowserWindow, shell, dialog, protocol, screen, type MenuItemConstructorOptions } from "electron";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import * as https from "node:https";
import * as tls from "node:tls";
import { Agent, setGlobalDispatcher } from "undici";
import { fileURLToPath } from "node:url";
import { bootstrap, type AppServices } from "./boot.js";
import { registerIpcHandlers, registerWindowEventListeners, unregisterPluginWebview } from "./ipc-bridge.js";
import { ensureCorporateCa } from "./main/corp-ca-loader.js";
import { isAuthOwned } from "./main/auth-window-registry.js";
import { installHtmlPreviewPartitionBlock, installPluginPartitionPolicy } from "./main/html-preview-partition.js";
import { registerPluginAssetProtocolScheme } from "./main/plugin-asset-protocol.js";
import { findLvisProtocolUri, parsePluginAuthUri } from "./main/lvis-protocol.js";
import { buildDevProtocolArgs } from "./main/electron-protocol-args.js";
import { devNoSandboxAllowed, setIsPackaged } from "./boot/dev-flags.js";
import { emitEvent as emitHostEvent } from "./boot/types.js";
import { WindowManager } from "./main/window-manager.js";
import { createLogger } from "./lib/logger.js";
import { LVIS_LOGO_PATH, LVIS_LOGO_VIEW_BOX } from "./shared/lvis-logo.js";
const log = createLogger("lvis");

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const distRoot = resolve(__dirname, "..");
const projectRoot = resolve(distRoot, "..");

registerPluginAssetProtocolScheme(protocol);

// Tab detach + magnetic snap — created before createWindow() so it is ready
// when the main window is registered.
let windowManager: WindowManager | null = null;

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

// Windows 10/11 OS notifications require an AppUserModelId — without this,
// `new Notification(...)` toasts are silently dropped or grouped under the
// generic "Electron" identity. Issue #260 NotificationService relies on this.
// Safe to call on all platforms; non-Windows treats it as a no-op.
app.setAppUserModelId("com.lge.lvis");

// Phase 1 trust-hardening — strip LVIS_DEV* from process.env in packaged
// builds before any preload, renderer, or worker inherits it. Without this
// scrub, a packaged binary launched with LVIS_DEV=1 in the user environment
// would expose `env.isDev=true` to the renderer (via preload's
// contextBridge) and let UI code enable dev affordances. Renderer-side flags
// are advisory rather than load-bearing for trust decisions, but allowing
// them to flip in packaged builds creates a confusing forensic signal.
//
// Round-3: the prefix scrub now catches `LVIS_DEV_CONSOLE` (renamed from
// `LVIS_ENABLE_DEV_CONSOLE`) automatically. `LVIS_WIN_NO_SANDBOX` is the
// Windows-only sandbox bypass — it was previously named
// `LVIS_DEV_NO_SANDBOX`, which made it incorrectly look like a dev flag;
// the rename moves it out of the dev mask but it's still hard-gated on
// `!app.isPackaged` by `dev-flags.ts:devNoSandboxAllowed()`.
if (app.isPackaged) {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("LVIS_DEV") || key === "LVIS_WIN_NO_SANDBOX") {
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
      log.warn("corporate CA not found — 해외망 사용 중이거나 MDM 미배포. TLS 검증 기본값 유지.");
      return;
    }
    const ca = [...tls.rootCertificates, result.pem];
    // 1) undici (Node fetch / global dispatcher)
    setGlobalDispatcher(new Agent({ connect: { ca } }));
    // 2) https.globalAgent (legacy https.get / https.request)
    (https.globalAgent.options as Record<string, unknown>).ca = ca;
    // 3) tls.setDefaultCACertificates — Node 24 기준 미존재, 향후 확장 포인트
    log.info(`corporate CA injected: source=${result.source} certs=${result.certCount} path=${result.path}`);
  } catch (e) {
    // 주입 실패해도 앱은 계속 실행 (해외망에서는 기본 CA로 충분)
    log.error("corporate CA 주입 실패 (non-fatal): %s", (e as Error).message);
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
const MAIN_WINDOW_WIDTH = 460;
const MAIN_WINDOW_HEIGHT = 840;
const MAIN_WINDOW_MIN_WIDTH = 460;
const MAIN_WINDOW_MIN_HEIGHT = 640;
const MAIN_WINDOW_TOP_GAP = 24;
const MAIN_WINDOW_RIGHT_GAP = 10;

function initialMainWindowBounds(): { x: number; y: number; width: number; height: number } {
  const { workArea } = screen.getPrimaryDisplay();
  const width = Math.max(MAIN_WINDOW_MIN_WIDTH, Math.min(MAIN_WINDOW_WIDTH, workArea.width));
  const height = Math.max(MAIN_WINDOW_MIN_HEIGHT, Math.min(MAIN_WINDOW_HEIGHT, workArea.height));
  const rightGap = width < workArea.width ? MAIN_WINDOW_RIGHT_GAP : 0;
  return {
    x: workArea.x + workArea.width - width - rightGap,
    y: workArea.y + Math.min(MAIN_WINDOW_TOP_GAP, Math.max(0, workArea.height - height)),
    width,
    height,
  };
}

/**
 * W1.0 — `--plugin-smoke=<id1>,<id2>,...` CLI flag.
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
const lvisDevLog = (msg: string, obj?: object) => {
  if (app.isPackaged) return;
  if (obj !== undefined) log.info(obj, msg);
  else log.info(msg);
};
const lvisDevWarn = (msg: string, obj?: object) => {
  if (app.isPackaged) return;
  if (obj !== undefined) log.warn(obj, msg);
  else log.warn(msg);
};

async function handleLvisUri(url: string) {
  lvisDevLog("[lvis] handleLvisUri called", { url });

  // Route generic plugin OAuth callback (`lvis://plugin-auth/<pluginId>?code=<code>`)
  // to a host event so the matching plugin can exchange the code.
  // Validation lives in parsePluginAuthUri — bad URIs silently drop
  // (DoS / probing defense). Plain-text `code` MUST NOT be logged.
  const authParams = parsePluginAuthUri(url);
  if (authParams) {
    lvisDevLog("[lvis] handleLvisUri: plugin auth callback received", {
      pluginId: authParams.pluginId,
      codeLength: authParams.code.length,
    });
    emitHostEvent("plugin.auth.code.received", {
      pluginId: authParams.pluginId,
      code: authParams.code,
    });
    return;
  }

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
      log.error({ err }, "failed to load index.html for lvis:// URI");
    }
  }
  mainWindow?.focus();
  const win = mainWindow;
  if (!win) {
    // createWindow() failed or was destroyed — abort rather than install silently.
    log.warn("handleLvisUri: no window available, aborting install");
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
    .install(params.slug, "user", (evt) => {
      if (evt.phase === "downloading") {
        mainWindow?.webContents.send("lvis:plugins:install-progress", {
          slug: params.slug,
          phase: "downloading",
          bytesDownloaded: evt.bytesDownloaded,
          bytesTotal: evt.bytesTotal,
        });
      } else {
        mainWindow?.webContents.send("lvis:plugins:install-progress", { slug: params.slug, phase: evt.phase });
      }
    })
    .then(async () => {
      lvisDevLog("[lvis] handleLvisUri: install succeeded", { slug: params.slug });
      // Mirror the post-install steps from the lvis:plugins:install IPC handler
      // so deep-link installs behave identically to in-app installs.
      try {
        mainWindow?.webContents.send("lvis:plugins:install-progress", { slug: params.slug, phase: "restarting" });
        // US-A3 — single-plugin lifecycle: only the deep-link-installed
        // plugin starts up. Other plugins keep their in-memory state.
        await services!.pluginRuntime.addPlugin(params.slug);
        emitHostEvent("plugin.installed", { pluginId: params.slug, source: "marketplace" });
        services!.refreshPluginNotifications?.();
      } catch (err) {
        log.error({ err }, "post-install steps failed for lvis:// install");
      }
      mainWindow?.webContents.send("lvis:plugins:install-result", { slug: params.slug, success: true });
    })
    .catch((err: Error) => {
      log.error({ slug: params.slug, error: err.message, stack: err.stack }, "lvis:// install failed");
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
          { label: "편집", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
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
    log.info({ reason }, "main interface loaded");
  } catch (err) {
    log.error({ reason, err }, "failed to load index.html");
  }
}

const BOOTSTRAP_STATUS_MESSAGES = [
  "런타임을 준비하는 중...",
  "사용자 설정과 메모리를 불러오는 중...",
  "플러그인 무결성을 확인하는 중...",
  "마켓플레이스와 동기화하는 중...",
  "작업 화면을 여는 중...",
] as const;
const BOOTSTRAP_MESSAGE_MIN_VISIBLE_MS = 500;
const BOOTSTRAP_SPLASH_MIN_VISIBLE_MS =
  BOOTSTRAP_STATUS_MESSAGES.length * BOOTSTRAP_MESSAGE_MIN_VISIBLE_MS;
let bootstrapSplashShownAt = 0;

async function waitForMinimumBootstrapSplash() {
  if (bootstrapSplashShownAt <= 0) return;
  const remaining = BOOTSTRAP_SPLASH_MIN_VISIBLE_MS - (Date.now() - bootstrapSplashShownAt);
  if (remaining > 0) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, remaining));
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
  html,body{margin:0;height:100%;background:#f3f3f3;color:#2c2c2c;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Malgun Gothic",sans-serif}
  body{overflow:hidden}
  .wrap{box-sizing:border-box;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:28px;background:radial-gradient(circle at 62% 34%,rgba(255,255,255,.94),rgba(255,220,228,.74) 34%,rgba(255,180,198,.68) 68%,rgba(255,255,255,.82));background-size:cover}
  .panel{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px}
  .logo{width:104px;height:auto;transform:translateY(-26px);filter:drop-shadow(0 8px 18px rgba(217,0,255,.16))}
  .name{margin:-20px 0 0;color:#ef0b4c;font-size:26px;font-weight:650;line-height:1;letter-spacing:0}
  .status{min-height:18px;margin:2px 0 0;color:rgba(239,11,76,.52);font-size:12px;line-height:18px;text-align:center;transition:opacity .25s ease}
  .fade{animation:fade 1.35s ease-in-out infinite}
  @keyframes fade{0%,100%{opacity:.28}45%{opacity:.72}}
</style></head><body>
  <div class="wrap">
    <div class="panel" role="status" aria-live="polite">
      <svg class="logo" viewBox="${LVIS_LOGO_VIEW_BOX}" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
        <path d="${LVIS_LOGO_PATH}" fill="url(#lvisSplashLogo)" />
        <defs>
          <linearGradient id="lvisSplashLogo" x1="50.1574" y1="-3.85755" x2="181.301" y2="235.331" gradientUnits="userSpaceOnUse">
            <stop stop-color="#FF0000" />
            <stop offset="1" stop-color="#D900FF" />
          </linearGradient>
        </defs>
      </svg>
      <h1 class="name">LVIS</h1>
      <p id="status" class="status fade">런타임을 준비하는 중...</p>
    </div>
  </div>
  <script>
    const messages = ${JSON.stringify(BOOTSTRAP_STATUS_MESSAGES)};
    const status = document.getElementById("status");
    let i = 0;
    setInterval(() => {
      i = (i + 1) % messages.length;
      if (status) status.textContent = messages[i];
    }, ${BOOTSTRAP_MESSAGE_MIN_VISIBLE_MS});
  </script>
</body></html>`;

function createWindow() {
  const preloadPath = resolve(__dirname, "preload.cjs");
  if (!existsSync(preloadPath)) {
    throw new Error(`[lvis] preload.cjs not found at ${preloadPath} — run 'npm run build:preload' first`);
  }

  mainWindow = new BrowserWindow({
    ...initialMainWindowBounds(),
    minWidth: MAIN_WINDOW_MIN_WIDTH,
    minHeight: MAIN_WINDOW_MIN_HEIGHT,
    show: true,
    autoHideMenuBar: false,
    // ─── Cross-platform titlebar ─────────────────────────────────────────
    // macOS: keep native frame so traffic-light buttons render via the OS;
    //        hiddenInset shifts content area below the traffic lights.
    // Win/Linux: remove native frame entirely — CustomTitleBar.tsx renders
    //            our own minimize/maximize/close buttons in the renderer.
    frame: process.platform !== "darwin" ? false : undefined,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    trafficLightPosition: process.platform === "darwin" ? { x: 14, y: 14 } : undefined,
    // ─────────────────────────────────────────────────────────────────────
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // sandbox:false required for Node built-ins (node:path, node:url) in preload.cjs
      sandbox: false,
      // render_html tool renders LLM-produced HTML inside an Electron
      // <webview>. The webview runs on its own webContents / OS process so
      // a malicious or runaway payload (e.g. `while(true){}`) can't freeze
      // the main UI. The <webview> tag is gated by webPreferences.webviewTag.
      webviewTag: true,
      preload: preloadPath,
    },
  });

  const win = mainWindow;

  // Register with WindowManager so snap logic can track the main window.
  if (windowManager) {
    windowManager.registerMainWindow(win);
  }

  // Attach maximize / fullscreen broadcast listeners. These must be registered
  // on every new BrowserWindow instance (initial boot, macOS re-activation,
  // and any recovery path). The IPC handlers in ipc-bridge.ts look up the
  // current window via getMainWindow() at call-time, but win.on() bindings
  // are instance-specific and are lost when a new window object is created.
  registerWindowEventListeners(win);

  // Development debugging is provided by the renderer-side eruda console
  // (LVIS_DEV_CONSOLE=1). Do not auto-open native Chromium DevTools: it
  // changes the runtime viewport and makes UI regressions look different
  // from the real app window.

  win.once("ready-to-show", () => {
    log.info("window ready-to-show");
    win.show();
    win.focus();
  });
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });
  win.webContents.on("did-fail-load", (_e, code, desc, url) => {
    log.error({ code, desc, url }, "window failed to load");
  });
  // Recovery: if the renderer crashes (e.g. GPU-lost after GPU utility failure),
  // reload index.html. IPC handlers are registered on the main-process side and
  // survive a renderer restart — the reloaded renderer reconnects automatically.
  win.webContents.on("render-process-gone", (_e, details) => {
    log.error({ details }, "main window renderer process gone");
    if (!rendererReloadReady) {
      pendingRendererReload = true;
      log.warn("renderer reload deferred until bootstrap + IPC registration complete");
      return;
    }
    const now = Date.now();
    if (!win.isDestroyed() && now - lastRendererReloadAt > 3000) {
      lastRendererReloadAt = now;
      void loadMainInterface(win, "render-process-gone");
    } else if (!win.isDestroyed()) {
      log.warn("render-process-gone reload suppressed to avoid crash loop");
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
          log.error({ url: parsedUrl.toString(), err }, "failed to open external URL");
        });
      } else {
        log.warn({
          url,
          protocol: parsedUrl.protocol,
        }, "blocked external URL with disallowed protocol");
      }
    } catch (err) {
      log.warn({ url, err }, "blocked invalid external URL");
    }
    return { action: "deny" };
  });
  // <a href> 클릭 또는 location.href 변경으로 인한 탐색 차단.
  // Electron 24+ exposes the URL on `details.url`; the legacy positional
  // `url` arg is deprecated and arrives empty on Electron 41.x, so we read
  // the canonical event payload only.
  win.webContents.on("will-navigate", (details) => {
    const url = details.url;
    if (!url.startsWith("file://") && !url.startsWith("data:")) {
      details.preventDefault();
      void shell.openExternal(url);
    }
  });

  // §M-race: bootstrap 동안 splash만 표시. 실 index.html 로드는 main()이
  // IPC 핸들러 등록 후 수행.
  bootstrapSplashShownAt = Date.now();
  void win
    .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(BOOTSTRAP_SPLASH)}`)
    .catch((err) => log.error({ err }, "splash load failed"));
}

async function main() {
  // Initialise WindowManager before createWindow so registerMainWindow() can
  // be called synchronously inside createWindow().
  const preloadPath = resolve(__dirname, "preload.cjs");
  windowManager = new WindowManager({ preloadPath, distRoot });

  // §4.2 Step 8: window 생성 (splash 표시) — bootstrap이 mainWindow를 필요로 함
  createWindow();

  // §4.2 Boot Sequence (mainWindow 전달 — PythonRuntimeBootstrapper IPC 사용)
  services = await bootstrap(projectRoot, mainWindow!, () => mainWindow);

  // W1.0 — `--plugin-smoke=<id,...>` exits early after verifying that the
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
  registerIpcHandlers(services, () => mainWindow);

  // L1: start the routines scheduler AFTER IPC handlers are wired so a
  // routine past-due at boot fires into a renderer that already has a
  // `lvis:routines:v2:fired` listener attached. The scheduler is otherwise
  // safe to start at any time — `start()` is idempotent.
  services.startRoutinesScheduler?.();

  refreshApplicationMenu();
  rendererReloadReady = true;

  // 실 UI 로드 — 이 시점부터 렌더러의 IPC 호출이 항상 handler와 매칭됨
  if (mainWindow) {
    if (!pendingRendererReload) await waitForMinimumBootstrapSplash();
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
    // Auth-window webviews (plugin OAuth/SSO portals) load remote http/https
    // login pages. Their navigation policy lives in
    // `src/main/auth-window-service.ts` and is scoped per auth flow (allows
    // only http/https, with completion-pattern matching). The generic
    // plugin-shell policy below would block legitimate post-login redirects
    // like `/login/callback#access_token=…` because the URL is neither
    // `data:` nor `about:`. Skip the global guard *only* when this
    // webContents was explicitly registered as auth-owned — a URL-prefix
    // check would also exempt any unrelated future webview that happens
    // to be on http(s).
    if (isAuthOwned(contents)) return;
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
      // v2 shutdown routines — fire all active shutdown-trigger routines with a
      // 5s timeout so a hung LLM call cannot block app.quit() indefinitely.
      if (svc.routinesStore && svc.routineEngine) {
        try {
          const shutdownRoutines = svc.routinesStore.listActive().filter(
            (r) => r.trigger === "shutdown",
          );
          for (const r of shutdownRoutines) {
            try {
              if (r.execution === "llm-session") {
                await Promise.race([
                  svc.routineEngine.runRoutine({
                    id: r.id,
                    trigger: r.trigger,
                    prePrompt: r.prePrompt ?? "",
                    title: r.title,
                  }),
                  new Promise<void>((resolve) => setTimeout(resolve, 5000)),
                ]);
              } else {
                svc.notificationService?.fire({
                  kind: "routine",
                  title: r.notificationTitle ?? r.title ?? "종료 루틴 알림",
                  body: r.notificationBody ?? "",
                  contextRef: { routineId: r.id },
                });
              }
            } catch (err) {
              log.warn("before-quit: shutdown routine failed (id=%s): %s", r.id, (err as Error).message);
            }
          }
        } catch (e) {
          log.warn("before-quit: shutdown routines setup failed: %s", (e as Error).message);
        }
      }
      await svc.shutdown?.();
      await svc.pluginRuntime.stopAll();
      windowManager?.persistAll();
    } finally {
      appShutdownCompleted = true;
      app.quit();
    }
  })();
});

app.whenReady().then(() => {
  installHtmlPreviewPartitionBlock();
  void main().catch((error) => {
    log.error({ err: error }, "bootstrap failed");
    app.quit();
  });
});
