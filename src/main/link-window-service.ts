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
 *
 * Microsoft 365 SSO compatibility:
 *   - The default Electron user-agent ends in `Electron/<ver>`. Microsoft's
 *     AAD endpoint detects this token and skips the "Stay signed in?" (KMSI)
 *     prompt, so it never issues `ESTSAUTHPERSISTENT` and only `ESTSAUTH`
 *     (a session cookie) is set. The session cookie also gets dropped if the
 *     window closes before Electron's 30s/512-op cookie batch flushes to disk.
 *     Result: every reopen looks like "logged out, please log in again".
 *   - `buildPersistentBrowserUserAgent()` rewrites the UA to look like vanilla
 *     Edge so AAD treats this as a real browser; on `closed` we
 *     `cookies.flushStore()` to force the auth cookie to disk before teardown.
 */
import { BrowserWindow, session as electronSession } from "electron";

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
 * Build an Edge-flavoured UA string aligned with the current Chromium major.
 *
 * Microsoft AAD's KMSI ("Stay signed in?") gating treats UAs containing
 * `Electron/...` as embedded browsers and refuses to issue the persistent
 * `ESTSAUTHPERSISTENT` cookie — which is why even after a successful login,
 * reopening outlook.office.com asks the user to sign in again. Mimicking Edge
 * (the `Edg/<major>` token) puts us back on the supported-browser path.
 *
 * Exported for unit tests; runtime code calls it indirectly via
 * `applyPersistentBrowserUserAgent`.
 */
export function buildPersistentBrowserUserAgent(input?: {
  chromiumVersion?: string;
  platform?: NodeJS.Platform;
}): string {
  const chromium = input?.chromiumVersion ?? process.versions.chrome ?? "136.0.0.0";
  const major = chromium.split(".")[0] || "136";
  const platform = input?.platform ?? process.platform;
  const platformToken =
    platform === "darwin"
      ? "Macintosh; Intel Mac OS X 10_15_7"
      : platform === "win32"
        ? "Windows NT 10.0; Win64; x64"
        : "X11; Linux x86_64";
  return (
    `Mozilla/5.0 (${platformToken}) AppleWebKit/537.36 (KHTML, like Gecko) ` +
    `Chrome/${major}.0.0.0 Safari/537.36 Edg/${major}.0.0.0`
  );
}

/**
 * Apply the Edge-style UA + a deny-by-default permission gate to the
 * partition's session.
 *
 * Scope: session-level (`session.fromPartition(...).setUserAgent(...)`). The
 * UA persists for the lifetime of the partition, not just one window — that
 * is intentional, since the partition is dedicated to the external-link
 * viewer. Every navigation in this partition (any plugin's `openExternalUrl`,
 * any redirect chain) will emit the spoofed UA, which is precisely what AAD
 * needs to issue the persistent auth cookie.
 *
 * Permissions: persistent disk-stored partitions accumulate site permission
 * grants (notifications, geolocation, media) across reopens. We deny by
 * default so the viewer cannot silently grow privileges over time.
 */
export function applyPersistentBrowserUserAgent(persistPartition: string): void {
  const ses = electronSession.fromPartition(persistPartition);
  ses.setUserAgent(buildPersistentBrowserUserAgent());
  ses.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
}

/**
 * Force any AAD/Outlook auth cookies that landed during the login redirect
 * to disk before the partition's BrowserContext could batch them.
 *
 * Electron docs (Cookies API): writes are batched, flushed every 30 seconds
 * or 512 ops. If the user closes the window seconds after their auth redirect
 * lands, the cookies were never fsynced — next launch sees them missing and
 * AAD prompts again. `flushStore()` is cheap and idempotent.
 *
 * Failure is non-fatal — we surface a `console.warn` so a corrupt/locked
 * cookie store leaves a diagnostic breadcrumb (otherwise users see "must
 * re-login every time" with no signal pointing to the cause), but never
 * propagate the error since window teardown must always complete.
 */
async function flushPartitionCookies(persistPartition: string): Promise<void> {
  try {
    await electronSession.fromPartition(persistPartition).cookies.flushStore();
  } catch (err) {
    console.warn(
      `[lvis] cookie flush failed for partition '${persistPartition}': ${(err as Error).message}`,
    );
  }
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
  if (opts.persistPartition) {
    applyPersistentBrowserUserAgent(opts.persistPartition);
  }

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
      // Await the flush before resolving so an `app.quit()` that follows a
      // user closing this window cannot tear the process down before the
      // freshly-written auth cookies reach disk. Best-effort: errors are
      // already swallowed-with-warn inside `flushPartitionCookies`.
      const finish = () => settle(resolve);
      if (opts.persistPartition) {
        void flushPartitionCookies(opts.persistPartition).finally(finish);
      } else {
        finish();
      }
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
