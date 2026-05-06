/**
 * Link Window Service — §B3 light external-link viewer.
 *
 * Differs from `auth-window-service.ts` in two key ways:
 *   1. NO `cookieHosts` enforcement — this is a viewer for arbitrary external
 *      URLs (calendar webLinks, help docs, share-card preview, etc.), not an
 *      auth flow that needs to capture credentials.
 *   2. NO `completionUrlPatterns` — the user simply browses and closes the
 *      window when finished; there is no "completion event" to observe.
 *
 * Routing is decided by the caller (plugin-runtime) based on
 * `settings.webView.preferredFlow`:
 *   - `"in-app"`   → `openLinkWindow` opens a BrowserWindow.
 *   - `"system-browser"` → caller invokes `shell.openExternal` directly.
 *
 * Sandbox / security stance:
 *   - `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true` —
 *     the rendered page cannot access Node or any host APIs.
 *   - `webSecurity: true` — same-origin policy enforced.
 *   - The window is parented to the main window so OS-level focus/Z-order
 *     follows expectation.
 */
import { BrowserWindow } from "electron";

export interface OpenLinkWindowOptions {
  /** URL to load. MUST be `http(s):` — caller should validate before passing. */
  url: string;
  /** Window title. Defaults to "External Link". */
  windowTitle?: string;
  /**
   * Optional Electron session partition. When omitted, Electron's default
   * session is used (which is fine for a generic viewer — there is no
   * cross-plugin cookie exfiltration concern because no cookies are read
   * back to plugin code).
   */
  persistPartition?: string;
  /** Initial window width. Defaults to 1024. */
  width?: number;
  /** Initial window height. Defaults to 768. */
  height?: number;
}

/**
 * Open a lightweight BrowserWindow that loads `url` and lets the user
 * close it when done. Returns once the window has finished loading (or
 * has been closed before load completed).
 *
 * The promise never rejects on user-initiated close — that is the normal
 * happy path. It only rejects if the URL fails to start loading (e.g.
 * malformed URL crash inside Electron).
 */
export async function openLinkWindow(
  parent: BrowserWindow | null | undefined,
  opts: OpenLinkWindowOptions,
): Promise<void> {
  const win = new BrowserWindow({
    parent: parent ?? undefined,
    width: opts.width ?? 1024,
    height: opts.height ?? 768,
    title: opts.windowTitle ?? "External Link",
    autoHideMenuBar: true,
    webPreferences: {
      partition: opts.persistPartition,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });

  // Resolve when the page finishes loading or the user closes the window.
  // We do NOT keep the promise pending for the lifetime of the window —
  // plugins call `openExternalUrl` and forget about it.
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    win.once("ready-to-show", () => {
      win.show();
      settle(resolve);
    });
    win.once("closed", () => {
      settle(resolve);
    });
    win.webContents.once("did-fail-load", (_e, code, desc) => {
      // Negative codes that mean "navigation aborted because of a redirect /
      // user action" are fine — only reject on hard load failures.
      if (code === -3 /* ABORTED */) return;
      settle(() => reject(new Error(`link-window load failed (${code}): ${desc}`)));
    });

    win.loadURL(opts.url).catch((err) => {
      settle(() => reject(err));
    });
  });
}
