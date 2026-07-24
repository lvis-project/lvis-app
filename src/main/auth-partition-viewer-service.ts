/**
 * Auth-partition Viewer Service — opens a hardened BrowserWindow loading
 * an external URL inside a *plugin's* `persist:plugin-auth:<pluginId>`
 * partition so the page can reuse the AAD/OIDC session cookies that the
 * same plugin's `openAuthWindow` call already deposited.
 *
 * Use case: an auth-owning plugin authenticates once (writes session
 * cookies into `persist:plugin-auth:<that-plugin>`), then later, in
 * response to a `callTool` invocation from a consumer plugin, the same
 * auth-owning plugin calls `openAuthPartitionViewer(url)`. The viewer
 * opens in the auth-owning plugin's partition and the page's silent-SSO
 * completes without forcing a re-login.
 *
 * Differs from `link-window-service.openLinkWindow`:
 *   - Partition is owned by a single plugin (caller binding decided by
 *     `plugin-runtime.ts`'s per-plugin HostApi factory). Caller cannot
 *     name a different plugin's partition.
 *   - URL host must be in the caller's manifest `auth.partitionDomains`
 *     allow-list (suffix-match via `host-allow-list.ts`).
 *   - Navigation outside the allow-list is canceled in three places —
 *     `will-navigate` (renderer-initiated), `will-redirect` (server
 *     3xx), and `setWindowOpenHandler` always denies — so a phishing
 *     redirect from `outlook.office.com` to `attacker.example` cannot
 *     persuade the user to re-authenticate inside the partition.
 *   - Downloads from this session are canceled — the partition holds
 *     real auth cookies, and an attacker page should not be able to
 *     exfil cookies via a file with cookies attached or trick the user
 *     into running a dropped binary.
 *
 * Differs from `auth-window-service.openAuthWindow`:
 *   - No `completionUrlPatterns` — there is no "auth done" event; the
 *     window stays open until the user closes it. Returns `Promise<void>`
 *     resolved on close/load.
 *   - No `cookieHosts` — cookies are NEVER returned to plugin code. A
 *     plugin that needs cookies should call `openAuthWindow` instead.
 *
 * Security stance encoded in `BrowserWindow` options:
 *   - `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`,
 *     `webSecurity: true` — same-origin policy and isolation.
 *   - No `preload` — the rendered page must not see any host bridge.
 *   - `setMenu(null)` so OS-level shortcuts (e.g. Ctrl+Shift+I) opening
 *     DevTools require an explicit menu accelerator that isn't wired.
 */
import { BrowserWindow, session as electronSession } from "electron";

import {
  applyPersistentBrowserUserAgent,
} from "./link-window-service.js";
import {
  normalizeHost,
  urlHostMatchesAllowList,
  urlMatchesAllowList,
} from "./host-allow-list.js";
import { resolveAppIconPath } from "./app-icon.js";

export interface AuthPartitionViewerAuditEvent {
  type:
    | "open_auth_partition_viewer"
    | "open_auth_partition_viewer_navigation_denied"
    | "open_auth_partition_viewer_download_denied";
  pluginId: string;
  /** `origin + pathname` only — query/fragment may carry tokens. */
  url: string;
  /** Allow-list snapshot — useful when investigating a deny. */
  allowedHosts: string[];
  /** Present on `_navigation_denied` — the host that triggered the deny. */
  deniedHost?: string;
  timestamp: string;
}

export interface OpenAuthPartitionViewerOptions {
  /** Caller plugin id. Used to compute the partition + audit. */
  pluginId: string;
  /** Full URL to load. Must already pass the allow-list. */
  url: string;
  /** Normalized allow-list (already validated via `normalizeAllowedHosts`). */
  allowedHosts: string[];
  /** Window chrome label. Default falls back to the URL hostname. */
  windowTitle?: string;
  /** Parent BrowserWindow for OS-level Z-order. */
  parent?: BrowserWindow | null;
  /** Audit sink — host log + future telemetry. */
  audit?: (event: AuthPartitionViewerAuditEvent) => void;
}

const VIEWER_PARTITION_PREFIX = "persist:plugin-auth:";
const activeViewersByPartition = new Map<string, Set<BrowserWindow>>();
const partitionCleanupCounts = new Map<string, number>();

function partitionFor(pluginId: string): string {
  return `${VIEWER_PARTITION_PREFIX}${encodeURIComponent(pluginId)}`;
}

function safeUrlForLog(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "<invalid-url>";
  }
}

/**
 * Track per-session installs so we don't stack repeated `will-download`
 * listeners on the same partition across viewer reopens — Electron's
 * `session.on(...)` does not de-dupe listeners.
 */
const installedSessions = new WeakSet<Electron.Session>();

function trackViewer(partition: string, win: BrowserWindow): void {
  const viewers = activeViewersByPartition.get(partition) ?? new Set();
  viewers.add(win);
  activeViewersByPartition.set(partition, viewers);
  win.once("closed", () => untrackViewer(partition, win));
}

function untrackViewer(partition: string, win: BrowserWindow): void {
  const viewers = activeViewersByPartition.get(partition);
  viewers?.delete(win);
  if (viewers?.size === 0) activeViewersByPartition.delete(partition);
}

/**
 * Destroy every viewer that can still write to a partition, then wait until
 * Electron confirms that its webContents are gone. Partition storage must not
 * be cleared before this barrier or a live page could immediately recreate it.
 */
export async function closeAuthPartitionViewers(
  partition: string,
): Promise<void> {
  const viewers = [...(activeViewersByPartition.get(partition) ?? [])];
  await Promise.all(
    viewers.map((win) =>
      new Promise<void>((resolve, reject) => {
        if (win.isDestroyed()) {
          untrackViewer(partition, win);
          resolve();
          return;
        }
        let settled = false;
        const complete = () => {
          if (settled) return;
          settled = true;
          untrackViewer(partition, win);
          resolve();
        };
        win.once("closed", complete);
        try {
          // destroy() is deliberate: a remote beforeunload handler must not be
          // able to postpone Host-owned credential deletion.
          win.destroy();
          if (win.isDestroyed()) complete();
        } catch (error) {
          reject(error);
        }
      }),
    ),
  );
}

export async function withAuthPartitionViewersClosed<T>(
  partition: string,
  operation: () => Promise<T>,
): Promise<T> {
  partitionCleanupCounts.set(
    partition,
    (partitionCleanupCounts.get(partition) ?? 0) + 1,
  );
  try {
    await closeAuthPartitionViewers(partition);
    return await operation();
  } finally {
    const remaining = (partitionCleanupCounts.get(partition) ?? 1) - 1;
    if (remaining === 0) partitionCleanupCounts.delete(partition);
    else partitionCleanupCounts.set(partition, remaining);
  }
}

/**
 * Install one-time session-level guards on the partition: deny every
 * download (the partition holds auth cookies) + the existing UA spoof +
 * permission-request denial.
 */
function ensurePartitionSessionGuards(
  partition: string,
  audit: ((e: AuthPartitionViewerAuditEvent) => void) | undefined,
  pluginId: string,
  allowedHosts: string[],
): void {
  applyPersistentBrowserUserAgent(partition);
  const ses = electronSession.fromPartition(partition);
  if (installedSessions.has(ses)) return;
  installedSessions.add(ses);
  ses.on("will-download", (event, item) => {
    event.preventDefault();
    audit?.({
      type: "open_auth_partition_viewer_download_denied",
      pluginId,
      url: safeUrlForLog(item.getURL()),
      allowedHosts: [...allowedHosts],
      timestamp: new Date().toISOString(),
    });
  });
}

/**
 * Open the viewer. Resolves once the window has loaded or been closed —
 * we never expose the lifetime promise to the plugin.
 */
export async function openAuthPartitionViewer(
  opts: OpenAuthPartitionViewerOptions,
): Promise<void> {
  // Validate URL + initial host (defense-in-depth — caller already gated).
  if (!urlMatchesAllowList(opts.url, opts.allowedHosts)) {
    throw new Error(
      `openAuthPartitionViewer: url host is not in the allow-list (got ${safeUrlForLog(opts.url)})`,
    );
  }
  const partition = partitionFor(opts.pluginId);
  if ((partitionCleanupCounts.get(partition) ?? 0) > 0) {
    throw new Error(
      "openAuthPartitionViewer: partition cleanup is in progress",
    );
  }
  ensurePartitionSessionGuards(
    partition,
    opts.audit,
    opts.pluginId,
    opts.allowedHosts,
  );

  let parsedHost: string;
  try {
    parsedHost = normalizeHost(new URL(opts.url).hostname);
  } catch {
    throw new Error(`openAuthPartitionViewer: invalid url`);
  }

  const win = new BrowserWindow({
    parent: opts.parent ?? undefined,
    width: 1024,
    height: 768,
    title: opts.windowTitle ?? parsedHost,
    icon: resolveAppIconPath(),
    autoHideMenuBar: true,
    webPreferences: {
      partition,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      // Explicit empty preload — no host bridge inside the viewer.
    },
  });
  win.setMenu(null);
  trackViewer(partition, win);

  // setWindowOpenHandler always denies — viewer must not spawn popups
  // (target=_blank, window.open). If the user really needs to open a
  // link in another window, they can close the viewer and reopen.
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  const denyOutOfAllowList = (
    urlBeingNavigatedTo: string,
    event: Electron.Event,
  ): boolean => {
    if (urlMatchesAllowList(urlBeingNavigatedTo, opts.allowedHosts)) return false;
    event.preventDefault();
    let deniedHost = "";
    try {
      deniedHost = normalizeHost(new URL(urlBeingNavigatedTo).hostname);
    } catch {
      /* leave empty */
    }
    opts.audit?.({
      type: "open_auth_partition_viewer_navigation_denied",
      pluginId: opts.pluginId,
      url: safeUrlForLog(urlBeingNavigatedTo),
      allowedHosts: [...opts.allowedHosts],
      deniedHost,
      timestamp: new Date().toISOString(),
    });
    return true;
  };

  // `will-navigate` — renderer-initiated navigation (link clicks, JS
  // `location.href = ...`). Same-document hash navigations are gated by
  // `will-navigate-in-page` instead — auth flows don't depend on those
  // so we leave them alone.
  win.webContents.on("will-navigate", (event, urlBeingNavigatedTo) => {
    denyOutOfAllowList(urlBeingNavigatedTo, event);
  });

  // `will-redirect` — server-side 3xx during a load. AAD's silent SSO
  // path is a chain of redirects through login.microsoftonline.com and
  // ESTS endpoints; the allow-list must include each step, but a
  // hijacked endpoint redirecting to an attacker domain is canceled
  // here without ever loading.
  win.webContents.on("will-redirect", (event, urlBeingRedirectedTo) => {
    denyOutOfAllowList(urlBeingRedirectedTo, event);
  });

  // Audit the open (origin+path only).
  opts.audit?.({
    type: "open_auth_partition_viewer",
    pluginId: opts.pluginId,
    url: safeUrlForLog(opts.url),
    allowedHosts: [...opts.allowedHosts],
    timestamp: new Date().toISOString(),
  });

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
      if (code === -3) return; // ABORTED — usually a redirect/user-action
      settle(() => {
        reject(new Error(`auth-partition viewer load failed (${code}): ${desc}`));
        if (!win.isDestroyed()) win.destroy();
      });
    });
    win.loadURL(opts.url).catch((err) => {
      settle(() => {
        reject(err);
        if (!win.isDestroyed()) win.destroy();
      });
    });
  });
}

// Re-export for test scaffolding only.
export const __internals = {
  partitionFor,
  safeUrlForLog,
  urlHostMatchesAllowList,
  activeViewerCount: (partition: string) =>
    activeViewersByPartition.get(partition)?.size ?? 0,
};
