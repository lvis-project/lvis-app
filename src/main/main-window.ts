/**
 * Main application window — creation, (re)load, and the small window helpers
 * shared across the menu, tray, settings window, and deep-link flows.
 *
 * The window instance itself and the renderer-reload flags live in
 * `app-state.ts`; this module owns the wiring (bounds, chrome, event
 * listeners, crash recovery, bootstrap splash) that produces and drives it.
 */
import { app, BrowserWindow, screen, shell } from "electron";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createLogger } from "../lib/logger.js";
import { mainDir } from "./main-paths.js";
import {
  attachSideBrowserWebview,
  configureSideBrowserWebviewAttach,
  isSideBrowserContents,
  takePendingSideBrowserSrc,
} from "./side-browser-webview.js";
import { getCommonChromeOptions } from "./window-chrome.js";
import { getLastThemePayload, registerWindowEventListeners } from "../ipc-bridge.js";
import {
  INITIAL_THEME_ARG_PREFIX,
  INITIAL_THEME_ARG_MAX_BYTES,
  type InitialThemePrime,
} from "../shared/initial-theme.js";
import {
  INITIAL_APP_MODE_ARG_PREFIX,
  normalizeAppMode,
  type InitialAppMode,
} from "../shared/initial-app-mode.js";
import { resolveAppIconPath } from "./app-icon.js";
import { readPersistedAppModeSync } from "./persisted-app-mode.js";
import {
  computeInitialMainWindowBounds,
  computeWorkModeBounds,
  MAIN_WINDOW_MIN_HEIGHT,
  MAIN_WINDOW_MIN_WIDTH,
} from "./main-window-bounds.js";
import { isAppUpdateInstallRequested } from "./app-update-install-intent.js";
import { BOOTSTRAP_SPLASH, markBootstrapSplashShown } from "./bootstrap-splash.js";
import { refreshApplicationMenu } from "./app-menu.js";
import { refreshTrayMenu } from "./app-tray.js";
import {
  getLastRendererReloadAt,
  getMainWindow,
  getServices,
  getSettingsWindow,
  getTray,
  getWindowManager,
  isAppShutdownCompleted,
  isAppShutdownStarted,
  isRendererReloadReady,
  setLastRendererReloadAt,
  setMainWindow,
  setPendingRendererReload,
} from "./app-state.js";

const log = createLogger("lvis");

export const rendererIndexUrl = () => pathToFileURL(resolve(mainDir, "..", "index.html")).toString();

/**
 * Persisted workspace mode used to size the main window and prime the renderer
 * at creation time.
 *
 * The first `createWindow()` runs BEFORE the async bootstrap assigns
 * `services`, so the in-memory `SettingsService` is not yet available. In that
 * window we read `system.appMode` straight from the settings file on disk
 * (mirrors `manual-host-resolver.ts`'s pre-`whenReady` sync read). Once the
 * service exists (re-create on macOS re-activation, recovery paths) we prefer
 * its in-memory value so an unsaved-to-disk in-session change is honored.
 *
 * Defaulting to "work" when nothing is persisted is the legitimate first-run
 * default, not a bug-papering fallback.
 */
function readPersistedAppMode(): InitialAppMode {
  const live = getServices()?.settingsService.getAll().system?.appMode;
  const normalizedLive = normalizeAppMode(live);
  if (normalizedLive !== null) return normalizedLive;
  return readPersistedAppModeSync(app.getPath("userData"));
}

function initialMainWindowBounds(): { x: number; y: number; width: number; height: number } {
  const { workArea } = screen.getPrimaryDisplay();
  // Size the window to match the persisted mode at CREATION time so the OS
  // window never opens chat-shaped then animates to work (or vice-versa)
  // after the renderer mounts. work → centered canvas; chat → right-docked.
  return readPersistedAppMode() === "work"
    ? computeWorkModeBounds(workArea)
    : computeInitialMainWindowBounds(workArea);
}

/**
 * Build the `webPreferences.additionalArguments` strings that carry the
 * host's currently cached `lastThemePayload` into every new BrowserWindow.
 *
 * The preload script parses these on document-start, applies tokens to
 * `documentElement` (frame-0 paint correct), and exposes the payload as
 * `window.__lvisInitialTheme` so ThemeProvider can init synchronously
 * without racing the renderer's first `notifyPluginTheme` broadcast. See
 * `architecture.md` §6.7.1.
 *
 * Returns `[]` when no payload is cached yet (cold-boot first window) OR
 * when the serialized payload exceeds `INITIAL_THEME_ARG_MAX_BYTES` —
 * either case is harmless because the renderer's async hydrate path
 * remains in effect.
 */
export function initialThemeArgs(): string[] {
  const payload = getLastThemePayload();
  if (!payload) return [];
  // Narrow projection to `InitialThemePrime` — the three fields that drive
  // frame-0 paint. `colorScheme` / `reducedMotion` / `fonts` are renderer-
  // only and hydrate from settings.json a few ms later, so embedding them in
  // argv is pure overhead.
  // User font overrides live in `settings.appearance.font`, NOT in the cached
  // plugin-theme payload — so they're read straight from the in-memory
  // settings service (already normalized at write time by settings-store's
  // `isValidFontFamilyOverride` + `FONT_SIZE_SCALE_VALUES` guards). Carrying
  // them in the frame-0 prime makes a detached/new window paint at the
  // configured size + family instead of flashing the 1.0 / HOST_FONT_STACK
  // default until React hydrates. `"system"` family + a missing/1.0 scale are
  // the defaults, so they're left off the wire (no override → omit the field).
  const font = getServices()?.settingsService.getAll().appearance?.font;
  const fontSizeScale = typeof font?.sizeScale === "number" ? font.sizeScale : undefined;
  const fontFamily = font?.family && font.family !== "system" ? font.family : undefined;
  const prime: InitialThemePrime = {
    bundleId: payload.bundleId,
    shell: payload.shell,
    ...(payload.tokens ? { tokens: payload.tokens } : {}),
    ...(fontSizeScale !== undefined ? { fontSizeScale } : {}),
    ...(fontFamily !== undefined ? { fontFamily } : {}),
  };
  let serialized: string;
  try {
    serialized = JSON.stringify(prime);
  } catch {
    return [];
  }
  if (serialized.length > INITIAL_THEME_ARG_MAX_BYTES) return [];
  return [`${INITIAL_THEME_ARG_PREFIX}${serialized}`];
}

/**
 * Serialize the persisted workspace mode into `additionalArguments` so the
 * preload can expose `window.__lvisInitialAppMode` and the renderer's first
 * React render seeds `appMode` from the saved value (no wrong-mode flash). The
 * value is always one of the validated `AppMode` literals, so no size cap is
 * needed (unlike the theme payload). Wire format SoT: `initial-app-mode.ts`.
 */
function initialAppModeArgs(): string[] {
  return [`${INITIAL_APP_MODE_ARG_PREFIX}${readPersistedAppMode()}`];
}

export function createWindow(options: { showBootstrapSplash?: boolean } = {}) {
  const showBootstrapSplash = options.showBootstrapSplash ?? true;
  const preloadPath = resolve(mainDir, "..", "preload.cjs");
  if (!existsSync(preloadPath)) {
    throw new Error(`[lvis] preload.cjs not found at ${preloadPath} — run 'npm run build:preload' first`);
  }

  const win = new BrowserWindow({
    ...initialMainWindowBounds(),
    minWidth: MAIN_WINDOW_MIN_WIDTH,
    minHeight: MAIN_WINDOW_MIN_HEIGHT,
    show: true,
    icon: resolveAppIconPath(),
    autoHideMenuBar: false,
    // Cross-platform titlebar — see `src/main/window-chrome.ts` for the
    // full rationale. The helper unifies main / settings / link / auth.
    ...getCommonChromeOptions(),
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
      // Pass the host's cached lastThemePayload + persisted appMode to the
      // renderer so ThemeProvider and the App shell can both init from frame 0
      // (no flash of fallback theme / wrong mode). See initialThemeArgs() and
      // initialAppModeArgs() above.
      additionalArguments: [...initialThemeArgs(), ...initialAppModeArgs()],
    },
  });
  setMainWindow(win);

  // Register with WindowManager so snap logic can track the main window.
  const windowManager = getWindowManager();
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
    showMainWindow(win);
  });
  win.on("close", (event) => {
    if (isAppUpdateInstallRequested()) return;
    if (isAppShutdownStarted() || isAppShutdownCompleted() || !getTray() || win.isDestroyed()) return;
    // Honour user's close-button preference. The default is `hide-to-tray`
    // (keeps routine scheduler + plugin background work alive); a user who
    // picks `quit` in Settings → 일반 → 시스템 동작 gets the conventional
    // Windows behaviour (close button terminates the app).
    //
    // Defensive `?? "hide-to-tray"` covers two real cases:
    //   (1) very early boot before `services` is assigned;
    //   (2) older settings.json from a pre-PR version with no `system`
    //       block — the renderer-side AppSettings types `system?` as
    //       optional, mirroring this fallback.
    const behavior = getServices()?.settingsService.getAll().system?.closeBehavior ?? "hide-to-tray";
    if (behavior === "quit") {
      // Gate the destroy through `before-quit` so the cleanup pipeline
      // owns shutdown ordering — calling `app.quit()` without preventDefault
      // races the window's default destroy against the async cleanup queue
      // and can leave the user staring at an invisible-but-not-yet-exited
      // process for up to `cleanupTimeoutMs` on slow shutdowns.
      event.preventDefault();
      app.quit();
      return;
    }
    event.preventDefault();
    win.hide();
    refreshApplicationMenu();
    refreshTrayMenu();
  });
  win.on("closed", () => {
    if (getMainWindow() === win) setMainWindow(null);
    refreshApplicationMenu();
    refreshTrayMenu();
  });
  win.webContents.on("did-fail-load", (_e, code, desc, url) => {
    log.error({ code, desc, url }, "window failed to load");
  });
  // Recovery: if the renderer crashes (e.g. GPU-lost after GPU utility failure),
  // reload index.html. IPC handlers are registered on the main-process side and
  // survive a renderer restart — the reloaded renderer reconnects automatically.
  win.webContents.on("render-process-gone", (_e, details) => {
    log.error({ details }, "main window renderer process gone");
    if (!isRendererReloadReady()) {
      setPendingRendererReload(true);
      log.warn("renderer reload deferred until bootstrap + IPC registration complete");
      return;
    }
    const now = Date.now();
    if (!win.isDestroyed() && now - getLastRendererReloadAt() > 3000) {
      setLastRendererReloadAt(now);
      void loadMainInterface(win, "render-process-gone");
    } else if (!win.isDestroyed()) {
      log.warn("render-process-gone reload suppressed to avoid crash loop");
    }
  });

  const pendingSideBrowserWebviews: string[] = [];
  win.webContents.on("will-attach-webview", (event, webPreferences, params) => {
    const result = configureSideBrowserWebviewAttach({
      event,
      webPreferences: webPreferences as Record<string, unknown>,
      params,
      enqueueAllowedSrc: (src) => pendingSideBrowserWebviews.push(src),
    });
    if (result === "blocked") {
      log.warn({ src: params.src, partition: params.partition }, "blocked side browser webview attach");
    }
  });
  win.webContents.on("did-attach-webview", (_event, contents) => {
    const src = takePendingSideBrowserSrc(pendingSideBrowserWebviews, contents.getURL());
    if (!src || !isSideBrowserContents(contents)) return;
    attachSideBrowserWebview(contents);
    log.debug({ src, webContentsId: contents.id }, "side browser webview attached");
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

  if (showBootstrapSplash) {
    // §M-race: bootstrap 동안 splash만 표시. 실 index.html 로드는 main()이
    // IPC 핸들러 등록 후 수행.
    markBootstrapSplashShown();
    void win
      .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(BOOTSTRAP_SPLASH)}`)
      .then(() => showMainWindow(win))
      .catch((err) => log.error({ err }, "splash load failed"));
  }
}

export async function loadMainInterface(win: BrowserWindow, reason: string) {
  if (win.isDestroyed()) return;
  try {
    await win.loadFile(resolve(mainDir, "..", "index.html"));
    setPendingRendererReload(false);
    showMainWindow(win);
    log.info({ reason }, "main interface loaded");
  } catch (err) {
    log.error({ reason, err }, "failed to load index.html");
  }
}

export function showMainWindow(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  win.moveTop();
}

/**
 * E4 — toggle the main window's visibility, the action bound to the global
 * show/hide accelerator. If the window is hidden or not focused, bring it
 * forward (reuses {@link showMainWindow}); if it is already visible AND
 * focused, hide it. The "focused" check makes the toggle feel right when the
 * window is visible but behind other apps — the first press raises it, the
 * second hides it. Returns the action taken so callers/tests can assert.
 */
export function toggleMainWindowVisibility(win: BrowserWindow): "shown" | "hidden" {
  if (win.isDestroyed()) return "shown";
  const visibleAndFocused = win.isVisible() && !win.isMinimized() && win.isFocused();
  if (visibleAndFocused) {
    win.hide();
    return "hidden";
  }
  showMainWindow(win);
  return "shown";
}

export function getAppWindows(): BrowserWindow[] {
  const seen = new Set<number>();
  const windows = [
    getMainWindow(),
    getSettingsWindow(),
    ...(getWindowManager()?.getDetachedWindows() ?? []),
  ];
  return windows.filter((win): win is BrowserWindow => {
    if (!win || win.isDestroyed() || seen.has(win.id)) return false;
    seen.add(win.id);
    return true;
  });
}

export function registerMainWindowPluginEventBridge(win: BrowserWindow): void {
  getServices()?.registerPluginEventBridge?.(win);
}
