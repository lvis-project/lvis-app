/**
 * Auth Window Service — collects cookies after an external portal interactive login.
 *
 * Exposed through `PluginHostApi.openAuthWindow`. Uses Electron's
 * `BrowserWindow` + `session.cookies` APIs to capture user login state
 * without a Selenium/webdriver dependency.
 *
 * Design principles:
 *  - The host owns the browser window lifecycle. Plugins never access
 *    `ipcMain` or `BrowserWindow` directly (§4.5 IPC scope principle).
 *  - Completion conditions (URL patterns) and cookie host allowlists are
 *    provided by the plugin at call time. The host does not know
 *    plugin-specific details (§1 principle: "NO plugin-specific code in host").
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getCommonChromeOptions } from "./window-chrome.js";
import { BrowserWindow, screen, session, type Cookie, type Session, type WebContents } from "electron";
import { registerWindowEventListeners } from "./window-event-listeners.js";
import { markAsWindowControlOwned } from "../ipc/window-control-registry.js";
import { markAsAuthOwned } from "./auth-window-registry.js";
import {
  buildTitlebarCss,
  buildTitlebarHtml,
  buildTitlebarButtonScript,
} from "./window-titlebar-shell.js";
import { resolveAppIconPath } from "./app-icon.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("auth-window");

const requireFromHere = createRequire(import.meta.url);

/**
 * Eruda devtools source — read once on demand and cached. Lets the auth shell
 * + the embedded webview both inline a working in-page console without the
 * webview having to fetch any external script (its CSP comes from the remote
 * server and would block <script src=...>).
 */
let cachedErudaSource: string | null = null;
function getErudaSource(): string | null {
  if (cachedErudaSource !== null) return cachedErudaSource;
  try {
    const erudaPath = requireFromHere.resolve("eruda");
    cachedErudaSource = readFileSync(erudaPath, "utf8");
    return cachedErudaSource;
  } catch {
    return null;
  }
}

function isDevConsoleEnabled(): boolean {
  return process.env.LVIS_DEV_CONSOLE === "1";
}

export interface AuthCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  /** Unix seconds. Omitted for session cookies. */
  expirationDate?: number;
}

export interface OpenAuthWindowOptions {
  /** Initial load URL, usually the external portal SSO entry point. */
  url: string;
  /**
   * Login is considered complete when the current URL contains any of these substrings.
   * Callers must choose precise patterns so still-in-SSO paths like `sso` are not matched.
   */
  completionUrlPatterns: string[];
  /**
   * Domain suffixes for cookies to collect, e.g. `["sso.example.com", "portal.example.com"]`.
   * Returned cookies must have `cookie.domain` ending in one of these suffixes.
   * Concrete domains are supplied by the caller/plugin; host code does not hardcode corp domains.
   */
  cookieHosts: string[];
  /** Login timeout. Defaults to five minutes. */
  timeoutMs?: number;
  /** Window title. Defaults to "Login". */
  windowTitle?: string;
  /**
   * Opt-in result shape for OAuth-style callbacks where the plugin needs the
   * final callback URL (for example a fragment token) in addition to cookies.
   * Default preserves the legacy AuthCookie[] return contract.
   */
  returnFinalUrl?: boolean;
  /**
   * Electron session partition. A `persist:` prefix makes it disk-persistent;
   * otherwise it is in-memory.
   *
   * The default is not undefined; each call gets a fresh in-memory partition
   * (`ephemeral-auth-<random>`) so the default session is never shared.
   * To reuse cookie/session storage, pass the same partition explicitly.
   *
   * The plugin host also rejects values outside the
   * `persist:plugin-auth:${encodeURIComponent(pluginId)}[:<sub>]` namespace;
   * see plugin-runtime.
   */
  persistPartition?: string;
  /**
   * Whether the BrowserWindow is shown. `true` (default) shows the auth
   * window so the user can interact with the IdP page. `false` keeps the
   * window invisible — the page still loads, navigates, and emits the
   * `did-navigate` events that drive `completionUrlPatterns`/cookie
   * harvest, but it is never raised. Used by plugin warmups that depend
   * on residual IdP cookies in `persistPartition` to silent-SSO with no
   * user input. Caller MUST pair `show: false` with a finite `timeoutMs`
   * so a hidden challenge page cannot hang invisibly.
   *
   * Mirrors `OpenAuthWindowBaseOptions.show` in `@lvis/plugin-sdk`.
   *
   * @default true
   */
  show?: boolean;
}

export interface OpenAuthWindowResult {
  cookies: AuthCookie[];
  /**
   * The URL that matched completionUrlPatterns. May contain a fragment token,
   * so host code must never include this value in logs or error messages.
   */
  finalUrl: string;
}

const PLUGIN_AUTH_PERSIST_PREFIX = "persist:plugin-auth:";
const trackedPluginAuthPartitions = new Map<string, Set<string>>();

/**
 * In-flight / open VISIBLE auth-window dedup registry.
 *
 * Keyed by `effectivePartition + "\u0000" + windowTitle` (the partition already
 * encodes the owning pluginId for `persist:plugin-auth:<id>` partitions; title
 * disambiguates a login window from a logout window on the same partition).
 * When a visible auth window for the same key is already open or its
 * open-promise is still in-flight, a second `openAuthWindow` call focuses the
 * existing window and awaits the existing promise instead of spawning a second
 * `BrowserWindow` — fixing the EP double-login-window (a webview `bootstrapAuth`
 * plus a host-triggered `loginTool` both firing).
 *
 * `show: false` silent warmups are intentionally EXCLUDED — they are invisible,
 * bounded, and may legitimately overlap a visible interactive login.
 */
const inFlightVisibleAuthWindows = new Map<
  string,
  { window: BrowserWindow; promise: Promise<AuthCookie[] | OpenAuthWindowResult> }
>();

function authWindowDedupKey(effectivePartition: string, windowTitle: string): string {
  return `${effectivePartition}\u0000${windowTitle}`;
}

/**
 * Injected persistence callbacks — set once at boot by
 * `wirePluginAuthPartitionPersistence()`. Tests can inject their own stubs.
 * Keeping them module-level (rather than a class) preserves the existing
 * function-export API that boot.ts and uninstall-lifecycle depend on.
 */
let _persistWrite: ((map: ReadonlyMap<string, ReadonlySet<string>>) => Promise<void>) | null =
  null;
let _persistDelete: ((pluginId: string) => Promise<void>) | null = null;
let _persistErrorLog: ((msg: string) => void) | null = null;

/**
 * Wire persistence callbacks at boot. Must be called once before the first
 * `openAuthWindow` invocation. Safe to call multiple times (e.g. in tests).
 */
export function wirePluginAuthPartitionPersistence(opts: {
  write: (map: ReadonlyMap<string, ReadonlySet<string>>) => Promise<void>;
  delete: (pluginId: string) => Promise<void>;
  onError: (msg: string) => void;
}): void {
  _persistWrite = opts.write;
  _persistDelete = opts.delete;
  _persistErrorLog = opts.onError;
}

function pluginIdFromPluginAuthPartition(partition: string): string | null {
  if (!partition.startsWith(PLUGIN_AUTH_PERSIST_PREFIX)) return null;
  const rest = partition.slice(PLUGIN_AUTH_PERSIST_PREFIX.length);
  const encodedPluginId = rest.split(":", 1)[0];
  if (!encodedPluginId) return null;
  try {
    return decodeURIComponent(encodedPluginId);
  } catch {
    return null;
  }
}

/**
 * Seed the in-memory tracker from a previously persisted map (at boot).
 * Existing in-memory entries are merged — this is intentionally additive
 * so that a concurrent early-boot `rememberPluginAuthPartition` call cannot
 * lose a just-observed partition.
 */
export function seedPluginAuthPartitions(persisted: Record<string, string[]>): void {
  for (const [pluginId, partitions] of Object.entries(persisted)) {
    const current = trackedPluginAuthPartitions.get(pluginId) ?? new Set<string>();
    for (const p of partitions) {
      current.add(p);
    }
    trackedPluginAuthPartitions.set(pluginId, current);
  }
}

export function rememberPluginAuthPartition(partition: string): void {
  const pluginId = pluginIdFromPluginAuthPartition(partition);
  if (!pluginId) return;
  const current = trackedPluginAuthPartitions.get(pluginId) ?? new Set<string>();
  current.add(partition);
  trackedPluginAuthPartitions.set(pluginId, current);
  // Fire-and-forget persistence — auth windows are interactive, we must not
  // delay them. Errors are routed to the injected error logger (audit log).
  if (_persistWrite) {
    _persistWrite(trackedPluginAuthPartitions).catch((err) => {
      _persistErrorLog?.(
        `plugin-auth-partition-store: write failed after observing ${partition}: ${(err as Error).message}`,
      );
    });
  }
}

export function getTrackedPluginAuthPartitions(pluginId: string): string[] {
  const base = `${PLUGIN_AUTH_PERSIST_PREFIX}${encodeURIComponent(pluginId)}`;
  return [...new Set([base, ...(trackedPluginAuthPartitions.get(pluginId) ?? [])])];
}

export async function forgetTrackedPluginAuthPartitions(
  pluginId: string,
): Promise<void> {
  const previous = trackedPluginAuthPartitions.get(pluginId);
  trackedPluginAuthPartitions.delete(pluginId);
  try {
    await _persistDelete?.(pluginId);
  } catch (error) {
    const concurrentlyObserved = trackedPluginAuthPartitions.get(pluginId);
    if (previous || concurrentlyObserved) {
      trackedPluginAuthPartitions.set(
        pluginId,
        new Set([...(previous ?? []), ...(concurrentlyObserved ?? [])]),
      );
    }
    throw error;
  }
}

function authShellPreloadPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "../preload.cjs");
}

export function buildAuthWindowShellHtml(input: {
  title: string;
  url: string;
  partition: string;
  /**
   * Platform string. macOS hides the HTML titlebar controls/title text since
   * the OS-rendered traffic lights (from `titleBarStyle: "hiddenInset"`)
   * already cover minimize/maximize/close. On Win/Linux `frame: false` removes
   * any native chrome, so the HTML buttons are required to allow window
   * control. Defaults to current `process.platform` when omitted.
   */
  platform?: NodeJS.Platform;
  /** When true, inline eruda devtools script. */
  devConsole?: boolean;
}): string {
  const platform: NodeJS.Platform = input.platform ?? process.platform;
  const title = JSON.stringify(input.title);
  const url = JSON.stringify(input.url);
  const partition = JSON.stringify(input.partition);
  const erudaScript = input.devConsole === true ? buildErudaInlineScript() : "";
  const titleBarHtml = buildTitlebarHtml({ platform, title: input.title });
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; frame-src http: https:;" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(input.title)}</title>
  <style>${buildTitlebarCss()}</style>
</head>
<body>
  ${titleBarHtml}
  <webview id="auth-view" src="" partition=""></webview>
  <script>
    const title = ${title};
    const url = ${url};
    const partition = ${partition};
    document.title = title;
    const titleEl = document.getElementById("title");
    if (titleEl) titleEl.textContent = title;
    const view = document.getElementById("auth-view");
    view.setAttribute("partition", partition);
    view.setAttribute("src", url);
    ${buildTitlebarButtonScript({ platform, title: input.title })}
  </script>
  ${erudaScript}
</body>
</html>`;
}

function buildErudaInlineScript(): string {
  const src = getErudaSource();
  if (!src) return "";
  // Wrap in a try/catch so a malformed eruda load can't break the shell.
  // `__lvis_eruda_booted` guards against double-init when the shell is
  // re-rendered (HMR / future flows).
  return `<script>${src}
;try{if(!window.__lvis_eruda_booted){window.__lvis_eruda_booted=true;eruda.init();}}catch(e){console.error("[lvis] auth shell eruda init failed", e);}</script>`;
}

/** Normalize host strings by absorbing leading dots, whitespace, and case differences. Empty strings are dropped. */
function normalizeHost(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  return trimmed.startsWith(".") ? trimmed.slice(1) : trimmed;
}

/**
 * Filter a cookie array to allowed hosts and serialize it as AuthCookie.
 * `allowedHosts` are normalized the same way as cookie domains so spelling
 * differences like ".example.com" vs "example.com" do not break matches.
 */
export function filterCookiesByHost(cookies: Cookie[], allowedHosts: string[]): AuthCookie[] {
  const normalizedAllowed = allowedHosts
    .map(normalizeHost)
    .filter((h) => h.length > 0);
  if (normalizedAllowed.length === 0) return [];
  return cookies
    .filter((c) => {
      if (!c.domain) return false;
      // Electron cookie domains may include a leading dot (".example.com"); normalize before comparing.
      const normalized = normalizeHost(c.domain);
      return normalizedAllowed.some(
        (host) => normalized === host || normalized.endsWith(`.${host}`),
      );
    })
    .map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      expirationDate: c.expirationDate,
    }));
}

/**
 * Returns true when the URL's `origin + pathname` contains a completion pattern.
 * Query/hash are intentionally excluded so IdP parameters like RelayState,
 * continue, or returnTo cannot embed a destination URL and create a false
 * "complete" verdict while still on the IdP domain.
 */
export function isCompletionUrl(url: string, patterns: readonly string[]): boolean {
  const target = extractCompletionTarget(url);
  return patterns.some((p) => target.includes(p));
}

export function shouldGraceCollectClosedAuthWindow(input: {
  webviewAttached: boolean;
  lastCommittedUrl: string | null;
  completionPatterns: readonly string[];
}): boolean {
  return (
    input.webviewAttached &&
    input.lastCommittedUrl !== null &&
    isCompletionUrl(input.lastCommittedUrl, input.completionPatterns)
  );
}

/** URL for host-visible diagnostics only; strips query/hash to avoid token leaks. */
export function sanitizeUrlForLog(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    const q = url.indexOf("?");
    const h = url.indexOf("#");
    const cut =
      q === -1 ? h : h === -1 ? q : Math.min(q, h);
    return cut === -1 ? url : url.slice(0, cut);
  }
}

/**
 * Result-shape selector for `openAuthWindow`. Pulled out as a pure function so the
 * `returnFinalUrl` contract can be exercised without spinning up a BrowserWindow —
 * Copilot flagged that the branch was otherwise untested.
 */
export function buildAuthResult(
  cookies: AuthCookie[],
  finalUrl: string,
  returnFinalUrl: boolean,
): AuthCookie[] | OpenAuthWindowResult {
  return returnFinalUrl ? { cookies, finalUrl } : cookies;
}

function extractCompletionTarget(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    // If URL construction fails, strip query/hash manually.
    const q = url.indexOf("?");
    const h = url.indexOf("#");
    const cut =
      q === -1 ? h : h === -1 ? q : Math.min(q, h);
    return cut === -1 ? url : url.slice(0, cut);
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Open the target URL, wait until a completion pattern is reached, then collect cookies.
 * The window is always closed. Rejects if the user closes it early.
 */
export function openAuthWindow(
  parent: BrowserWindow,
  options: OpenAuthWindowOptions & { returnFinalUrl: true },
): Promise<OpenAuthWindowResult>;
export function openAuthWindow(
  parent: BrowserWindow,
  options: OpenAuthWindowOptions & { returnFinalUrl?: false | undefined },
): Promise<AuthCookie[]>;
export function openAuthWindow(
  parent: BrowserWindow,
  options: OpenAuthWindowOptions,
): Promise<AuthCookie[] | OpenAuthWindowResult>;
export async function openAuthWindow(
  parent: BrowserWindow,
  options: OpenAuthWindowOptions,
): Promise<AuthCookie[] | OpenAuthWindowResult> {
  const {
    url,
    completionUrlPatterns,
    cookieHosts,
    windowTitle = "Login",
    persistPartition,
    returnFinalUrl = false,
    show: showRequested = true,
  } = options;
  // Silent warmups (show:false) MUST pair with an explicit timeoutMs so an
  // invisible challenge page can't hang forever. Reject the combination
  // early so the caller surface is unambiguous.
  if (showRequested === false && options.timeoutMs === undefined) {
    throw new Error(
      "openAuthWindow: when show is false, timeoutMs is required (silent warmup must bound itself)",
    );
  }

  // Validate timeoutMs; reject NaN, Infinity, negative, and excessive values.
  // Default is five minutes; maximum is 30 minutes, matching the manifest schema cap.
  const DEFAULT_TIMEOUT_MS = 5 * 60_000;
  const MAX_TIMEOUT_MS = 30 * 60_000;
  const MIN_TIMEOUT_MS = 1_000;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (options.timeoutMs !== undefined) {
    const t = options.timeoutMs;
    if (!Number.isFinite(t) || t < MIN_TIMEOUT_MS || t > MAX_TIMEOUT_MS) {
      throw new Error(
        `openAuthWindow: timeoutMs must be a finite number between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`,
      );
    }
    timeoutMs = Math.floor(t);
  }

  if (!url || !/^https?:\/\//i.test(url)) {
    throw new Error("openAuthWindow: invalid url");
  }

  // Drop empty/blank string entries. Any remaining empty string would make
  // `isCompletionUrl` substring matching always true, incorrectly treating
  // auth as complete and collecting cookies too early.
  const normalizedCompletionPatterns = (
    Array.isArray(completionUrlPatterns) ? completionUrlPatterns : []
  )
    .filter((p): p is string => typeof p === "string")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (normalizedCompletionPatterns.length === 0) {
    throw new Error("openAuthWindow: completionUrlPatterns must be a non-empty array of non-blank strings");
  }

  const normalizedCookieHosts = (Array.isArray(cookieHosts) ? cookieHosts : [])
    .filter((h): h is string => typeof h === "string")
    .map((h) => h.trim())
    .filter((h) => h.length > 0);
  if (normalizedCookieHosts.length === 0) {
    throw new Error("openAuthWindow: cookieHosts must be a non-empty array of non-blank strings");
  }

  // When `persistPartition` is omitted, isolate the call with a fresh in-memory
  // partition instead of Electron's default session. The plugin runtime already
  // injects a per-plugin default, but this also protects direct service callers
  // such as host-internal auth flows.
  const effectivePartition =
    persistPartition && persistPartition.length > 0
      ? persistPartition
      : `ephemeral-auth-${randomBytes(8).toString("hex")}`;
  rememberPluginAuthPartition(effectivePartition);

  // Idempotency guard — a single visible auth window per (partition, title).
  // Silent warmups (show:false) are never deduped: they are invisible and may
  // overlap an interactive login. For visible calls, focus + await an already
  // open/in-flight window instead of spawning a duplicate.
  const dedupKey = authWindowDedupKey(effectivePartition, windowTitle);
  const dedupEligible = showRequested !== false;
  if (dedupEligible) {
    const existing = inFlightVisibleAuthWindows.get(dedupKey);
    if (existing && !existing.window.isDestroyed()) {
      log.info(
        { phase: "dedup", partition: effectivePartition, windowTitle },
        `[auth-window:dedup] reusing in-flight visible auth window for partition=${effectivePartition} title=${windowTitle}`,
      );
      if (existing.window.isMinimized()) existing.window.restore();
      existing.window.focus();
      return existing.promise;
    }
    // Stale entry (window already destroyed but not yet cleaned up) — drop it
    // so the fresh window below registers cleanly.
    if (existing) inFlightVisibleAuthWindows.delete(dedupKey);
  }

  // Hardened webPreferences: this window loads an external portal in Chromium,
  // so fully block the renderer ↔ Node boundary to reduce RCE surface. Remote
  // pages must not get Node APIs or permission to create other BrowserWindows.
  const authWindow = new BrowserWindow({
    parent,
    modal: false,
    width: 1024,
    height: 768,
    title: windowTitle,
    icon: resolveAppIconPath(),
    autoHideMenuBar: true,
    // Frame settings sourced from the shared `getCommonChromeOptions()`
    // helper so this window — when made visible — uses the same
    // 36px CustomTitleBar slot + traffic-light position as the other
    // LVIS windows. See `src/main/window-chrome.ts`.
    ...getCommonChromeOptions(),
    // Hidden warmup BrowserWindow — page still loads + harvests cookies +
    // emits navigation events; never rendered to the user. Electron's
    // default `show: true` produces the popup-flash when callers want
    // silent SSO; explicit `show: false` suppresses both the initial
    // raise and any later focus/raise from web content.
    show: showRequested,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      sandbox: false,
      preload: authShellPreloadPath(),
    },
  });
  // Centering only matters for visible windows; skip the geometry math
  // when the caller asked for a hidden warmup.
  if (showRequested) centerAuthWindowOnScreen(authWindow);
  if (typeof authWindow.setMenu === "function") authWindow.setMenu(null);
  markAsWindowControlOwned(authWindow.webContents);
  registerWindowEventListeners(authWindow);

  let authContents: WebContents | null = null;

  // Restrict top-level navigation protocols to http/https. This blocks an
  // external portal from redirecting or user-clicking into `file:`, `data:`,
  // or custom schemes that could expose local files or abuse scheme handlers.
  //
  // `will-navigate` mainly catches user/script top-level navigation, while
  // server-side 302 redirects arrive through `will-redirect`; guard both.
  const isHttpUrl = (targetUrl: string): boolean => {
    try {
      const p = new URL(targetUrl).protocol;
      return p === "http:" || p === "https:";
    } catch {
      return false;
    }
  };
  // Electron 24+ exposes the navigation URL on `details.url` (the typed event
  // payload). The legacy second positional `url` argument is deprecated and is
  // empty/undefined on Electron 41.x — relying on it silently
  // `preventDefault()`'d every navigation, which is the bug that broke the
  // /login/callback handoff for plugin auth windows. Read only from the
  // canonical event payload.
  const attachAuthNavigationGuards = (contents: WebContents) => {
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", (details) => {
      if (!isHttpUrl(details.url)) details.preventDefault();
    });
    contents.on("will-redirect", (details) => {
      if (!isHttpUrl(details.url)) details.preventDefault();
    });
  };

  // The host shell is local/data: and owns only the chrome. The external
  // login page must be the single sandboxed webview below.
  authWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  authWindow.webContents.on("will-attach-webview", (event, webPreferences, params) => {
    if (typeof params.src !== "string" || params.src !== url) {
      event.preventDefault();
      return;
    }
    const prefs = webPreferences as Record<string, unknown>;
    delete prefs.preload;
    delete prefs.preloadURL;
    prefs.nodeIntegration = false;
    prefs.nodeIntegrationInWorker = false;
    prefs.nodeIntegrationInSubFrames = false;
    prefs.contextIsolation = true;
    prefs.webSecurity = true;
    prefs.sandbox = true;
    prefs.webviewTag = false;
    prefs.partition = effectivePartition;
  });

  // Diagnostic instrumentation for issue #960. Record structured logs for every
  // close path to identify the exact close trigger behind the silent-SSO warmup
  // regression (window closing after about 39ms, likely a race). Track ms delta,
  // URL, and reason. Diagnostic overhead is acceptable because auth windows are
  // created once per explicit user action.
  const createdAtMs = Date.now();
  const sinceCreated = (): number => Date.now() - createdAtMs;
  const sanitizedOpenUrl = sanitizeUrlForLog(url);
  // `lastSeenUrl` is for diagnostics — updated from any nav signal (including
  // `did-navigate-in-page` which fires on history.pushState/replaceState).
  // `lastCommittedUrl` only updates on `did-navigate` (real top-level commit)
  // — used as the trust gate for grace-collect. Page JS can spoof the former
  // via `history.replaceState(...)`, but cannot fabricate a top-level
  // navigation (security cycle-1 HIGH).
  let lastSeenUrl: string | null = null;
  let lastCommittedUrl: string | null = null;
  let webviewAttached = false;
  log.info(
    {
      phase: "open",
      url: sanitizedOpenUrl,
      partition: effectivePartition,
      showRequested,
      timeoutMs,
      completionPatternCount: normalizedCompletionPatterns.length,
      cookieHostCount: normalizedCookieHosts.length,
    },
    `[auth-window:open] url=${sanitizedOpenUrl} partition=${effectivePartition} show=${showRequested} timeoutMs=${timeoutMs}`,
  );

  const authPromise = new Promise<AuthCookie[] | OpenAuthWindowResult>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => {
        log.warn(
          {
            phase: "close",
            closeReason: "timeout",
            elapsedMs: sinceCreated(),
            lastSeenUrl: lastSeenUrl ? sanitizeUrlForLog(lastSeenUrl) : null,
            webviewAttached,
          },
          `[auth-window:timeout] url=${sanitizedOpenUrl} elapsedMs=${sinceCreated()} lastSeenUrl=${lastSeenUrl ? sanitizeUrlForLog(lastSeenUrl) : "none"} webviewAttached=${webviewAttached}`,
        );
        reject(new Error(`openAuthWindow: login timeout after ${timeoutMs}ms`));
        if (!authWindow.isDestroyed()) authWindow.close();
      });
    }, timeoutMs);

    const checkAndCollect = async () => {
      if (settled) return;
      if (!authContents || authContents.isDestroyed()) return;
      const currentUrl = authContents.getURL();
      if (!isCompletionUrl(currentUrl, normalizedCompletionPatterns)) return;
      try {
        const allCookies = await (authContents.session as Session).cookies.get({});
        const filtered = filterCookiesByHost(allCookies, normalizedCookieHosts);
        finish(() => {
          clearTimeout(timer);
          resolve(buildAuthResult(filtered, currentUrl, returnFinalUrl));
          if (!authWindow.isDestroyed()) authWindow.close();
        });
      } catch (err) {
        finish(() => {
          clearTimeout(timer);
          reject(err as Error);
          if (!authWindow.isDestroyed()) authWindow.close();
        });
      }
    };

    authWindow.webContents.on("did-attach-webview", (_event, contents) => {
      authContents = contents;
      webviewAttached = true;
      markAsAuthOwned(contents);
      attachAuthNavigationGuards(contents);
      log.info(
        { phase: "webview-attached", elapsedMs: sinceCreated(), url: sanitizedOpenUrl },
        `[auth-window:webview-attached] elapsedMs=${sinceCreated()} url=${sanitizedOpenUrl}`,
      );
      const trackNav = (navUrl: string, kind: string, isCommitted: boolean): void => {
        lastSeenUrl = navUrl;
        if (isCommitted) lastCommittedUrl = navUrl;
        log.info(
          { phase: kind, elapsedMs: sinceCreated(), url: sanitizeUrlForLog(navUrl), isCommitted },
          `[auth-window:${kind}] elapsedMs=${sinceCreated()} url=${sanitizeUrlForLog(navUrl)} committed=${isCommitted}`,
        );
      };
      contents.on("did-navigate", (_e, navUrl: string) => {
        trackNav(navUrl, "did-navigate", true);
        void checkAndCollect();
      });
      contents.on("did-navigate-in-page", (_e, navUrl: string) => {
        // history.pushState / replaceState — page-script controlled, NOT a
        // committed navigation. Diagnostic only, not trusted for grace-collect.
        trackNav(navUrl, "did-navigate-in-page", false);
        void checkAndCollect();
      });
      contents.on("will-redirect", (_e, navUrl: string) => {
        // Pre-commit redirect intent — not yet observed by server.
        trackNav(navUrl, "will-redirect", false);
      });
      contents.on("did-finish-load", () => {
        const cur = (() => { try { return contents.getURL(); } catch { return null; } })();
        if (cur) lastSeenUrl = cur;
        log.info(
          { phase: "did-finish-load", elapsedMs: sinceCreated(), url: cur ? sanitizeUrlForLog(cur) : null },
          `[auth-window:did-finish-load] elapsedMs=${sinceCreated()} url=${cur ? sanitizeUrlForLog(cur) : "unknown"}`,
        );
      });
      contents.on("destroyed", () => {
        log.warn(
          {
            phase: "webview-destroyed",
            elapsedMs: sinceCreated(),
            lastSeenUrl: lastSeenUrl ? sanitizeUrlForLog(lastSeenUrl) : null,
          },
          `[auth-window:webview-destroyed] elapsedMs=${sinceCreated()} lastSeenUrl=${lastSeenUrl ? sanitizeUrlForLog(lastSeenUrl) : "none"}`,
        );
      });
      // Inject eruda into the sandboxed webview after each navigation so
      // the in-page console survives the SPA's own client-side routes.
      // The webview's CSP comes from the remote server and may forbid
      // <script src=...>, but `executeJavaScript` runs in the page's main
      // world and bypasses page-level CSP — that's the whole point here.
      if (isDevConsoleEnabled()) {
        const injectEruda = () => {
          const src = getErudaSource();
          if (!src || contents.isDestroyed()) return;
          const script =
            `${src}\n;try{if(!window.__lvis_eruda_booted){window.__lvis_eruda_booted=true;eruda.init();}}catch(e){console.error("[lvis] webview eruda init failed", e);}`;
          contents.executeJavaScript(script).catch(() => {
            // Swallow — devtools is best-effort, never block the auth flow.
          });
        };
        contents.on("did-finish-load", injectEruda);
        contents.on("did-frame-finish-load", (_e, isMainFrame) => {
          if (isMainFrame) injectEruda();
        });
      }
      void checkAndCollect();
    });
    // F12 / Cmd+Alt+I → open native Chromium DevTools on the webview. Eruda
    // is fine for read-only inspection but native DevTools is needed for
    // network panel / breakpoints when the login flow misbehaves.
    if (isDevConsoleEnabled()) {
      authWindow.webContents.on("before-input-event", (_event, input) => {
        const isF12 = input.key === "F12" && input.type === "keyDown";
        const isCmdAltI =
          input.type === "keyDown" &&
          (input.meta || input.control) &&
          input.alt &&
          (input.key === "i" || input.key === "I");
        if (!(isF12 || isCmdAltI)) return;
        if (authContents && !authContents.isDestroyed()) {
          authContents.openDevTools({ mode: "detach" });
        } else if (!authWindow.isDestroyed()) {
          authWindow.webContents.openDevTools({ mode: "detach" });
        }
      });
    }

    // Fast-fail on navigation errors so we don't wait the full timeout for
    // DNS / TLS / proxy / offline / renderer-crash scenarios. isMainFrame
    // filters out third-party asset failures that shouldn't abort login.
    //
    // `ERR_ABORTED` (-3) is a common benign failure when a previous load is
    // canceled during an SSO redirect chain. Rejecting immediately would break
    // normal POST→302 redirects. Instead, check whether the current URL has
    // already reached a completion pattern; otherwise ignore it.
    const ERR_ABORTED = -3;
    const failReject = (errorCode: number, errorDesc: string, validatedUrl: string) =>
      finish(() => {
        clearTimeout(timer);
        log.warn(
          {
            phase: "close",
            closeReason: "did-fail-load",
            errorCode,
            errorDescription: errorDesc,
            url: sanitizeUrlForLog(validatedUrl),
            elapsedMs: sinceCreated(),
          },
          `[auth-window:fail-load] errorCode=${errorCode} desc=${errorDesc} url=${sanitizeUrlForLog(validatedUrl)} elapsedMs=${sinceCreated()}`,
        );
        reject(
          new Error(
            `openAuthWindow: navigation failed (${errorCode} ${errorDesc}) url=${sanitizeUrlForLog(validatedUrl)}`,
          ),
        );
        if (!authWindow.isDestroyed()) authWindow.close();
      });

    // Read load-failure metadata from the canonical Electron 24+ event payload
    // (`event.errorCode`, `event.errorDescription`, `event.validatedURL`,
    // `event.isMainFrame`). The deprecated positional args arrive empty on
    // Electron 41.x; reading them would silently turn every fail-load into a
    // no-op (isMainFrame === undefined → early return) and we'd wait the full
    // 5-minute timeout instead of fast-failing on real DNS/TLS errors.
    type FailLoadEvent = {
      errorCode: number;
      errorDescription: string;
      validatedURL: string;
      isMainFrame: boolean;
    };
    const onFailLoad = (event: FailLoadEvent) => {
      if (!event.isMainFrame) return;
      if (event.errorCode === ERR_ABORTED) {
        // Benign redirect/page-transition cancel. Re-check completion and
        // resolve through cookie collection when possible; otherwise ignore it.
        void checkAndCollect();
        return;
      }
      failReject(event.errorCode, event.errorDescription, event.validatedURL);
    };

    authWindow.webContents.on("did-fail-load", onFailLoad as never);
    authWindow.webContents.on("did-fail-provisional-load", onFailLoad as never);
    authWindow.webContents.on("did-attach-webview", (_event, contents) => {
      contents.on("did-fail-load", onFailLoad as never);
      contents.on("did-fail-provisional-load", onFailLoad as never);
    });
    authWindow.webContents.on("render-process-gone", (_e, details) => {
      finish(() => {
        clearTimeout(timer);
        log.warn(
          {
            phase: "close",
            closeReason: "render-process-gone",
            reason: details.reason,
            elapsedMs: sinceCreated(),
            url: sanitizedOpenUrl,
          },
          `[auth-window:render-process-gone] reason=${details.reason} elapsedMs=${sinceCreated()} url=${sanitizedOpenUrl}`,
        );
        reject(new Error(`openAuthWindow: render process gone (${details.reason})`));
        if (!authWindow.isDestroyed()) authWindow.close();
      });
    });

    authWindow.on("closed", () => {
      if (settled) return;
      clearTimeout(timer);
      // Grace-collect (issue #960 fix): if the window closes too quickly because
      // of a silent SSO race, but a webview attached and the *committed* navigation
      // URL matches a completion pattern, try one more cookie fetch from the
      // partition session. The server still validates cookies, so this is not a
      // security bypass. Always use `lastCommittedUrl` (did-navigate top-level
      // only); `lastSeenUrl` can be spoofed by page JS via history.pushState
      // (security cycle-1 HIGH).
      const lastUrlSanitized = lastSeenUrl ? sanitizeUrlForLog(lastSeenUrl) : null;
      const lastCommittedSanitized = lastCommittedUrl
        ? sanitizeUrlForLog(lastCommittedUrl)
        : null;
      const isGraceEligible = shouldGraceCollectClosedAuthWindow({
        webviewAttached,
        lastCommittedUrl,
        completionPatterns: normalizedCompletionPatterns,
      });
      if (isGraceEligible && lastCommittedUrl) {
        const capturedUrl = lastCommittedUrl;
        const partitionSession = session.fromPartition(effectivePartition);
        log.warn(
          {
            phase: "close",
            closeReason: "closed-event",
            graceCollectAttempt: true,
            url: sanitizedOpenUrl,
            lastSeenUrl: lastUrlSanitized,
            lastCommittedUrl: lastCommittedSanitized,
            webviewAttached,
            elapsedMs: sinceCreated(),
          },
          `[auth-window:closed-grace-collect] url=${sanitizedOpenUrl} committed=${lastCommittedSanitized} elapsedMs=${sinceCreated()} — attempting grace cookie fetch`,
        );
        void (async () => {
          try {
            const allCookies = await partitionSession.cookies.get({});
            const filtered = filterCookiesByHost(allCookies, normalizedCookieHosts);
            finish(() => {
              log.info(
                {
                  phase: "close",
                  closeReason: "closed-event-grace-resolved",
                  cookieCount: filtered.length,
                  elapsedMs: sinceCreated(),
                },
                `[auth-window:closed-grace-resolved] cookies=${filtered.length} elapsedMs=${sinceCreated()}`,
              );
              resolve(buildAuthResult(filtered, capturedUrl, returnFinalUrl));
            });
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            finish(() => {
              log.warn(
                {
                  phase: "close",
                  closeReason: "closed-event-grace-failed",
                  errorMessage: errMsg,
                  elapsedMs: sinceCreated(),
                },
                `[auth-window:closed-grace-failed] err=${errMsg} elapsedMs=${sinceCreated()}`,
              );
              reject(new Error(`openAuthWindow: window closed before login completed (grace fetch failed: ${errMsg})`));
            });
          }
        })();
        return;
      }
      finish(() => {
        // Issue #960 hint: webviewAttached=false + elapsedMs<100 means an
        // external close before webview attach. Possible sources include
        // window-control IPC, partition reuse cleanup, or a pending render-process
        // crash. webviewAttached=true + lastSeenUrl mismatch points to page
        // window.close() or a silent SSO race that checkAndCollect did not reach
        // and grace path did not trigger because it was not a completion URL.
        log.warn(
          {
            phase: "close",
            closeReason: "closed-event",
            graceCollectAttempt: false,
            url: sanitizedOpenUrl,
            lastSeenUrl: lastUrlSanitized,
            lastCommittedUrl: lastCommittedSanitized,
            webviewAttached,
            elapsedMs: sinceCreated(),
          },
          `[auth-window:closed-before-completion] url=${sanitizedOpenUrl} lastSeenUrl=${lastUrlSanitized ?? "none"} committed=${lastCommittedSanitized ?? "none"} webviewAttached=${webviewAttached} elapsedMs=${sinceCreated()}`,
        );
        reject(new Error("openAuthWindow: window closed before login completed"));
      });
    });

    const html = buildAuthWindowShellHtml({
      title: windowTitle,
      url,
      partition: effectivePartition,
      platform: process.platform,
      devConsole: isDevConsoleEnabled(),
    });
    authWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch((err) => {
      finish(() => {
        clearTimeout(timer);
        const errName = (err as Error).name || "Error";
        log.warn(
          {
            phase: "close",
            closeReason: "load-url-failed",
            url: sanitizedOpenUrl,
            errorName: errName,
            elapsedMs: sinceCreated(),
          },
          `[auth-window:load-url-failed] url=${sanitizedOpenUrl} err=${errName} elapsedMs=${sinceCreated()}`,
        );
        reject(new Error(`openAuthWindow: load failed for ${sanitizeUrlForLog(url)} (${errName})`));
        if (!authWindow.isDestroyed()) authWindow.close();
      });
    });
  });

  // Register the visible window for dedup and clean up on settle / teardown so
  // a later open finds either a live window to focus or no stale entry. Only
  // remove our own entry (a fresh window for the same key may have replaced it).
  if (dedupEligible) {
    const clearOwnEntry = (): void => {
      const current = inFlightVisibleAuthWindows.get(dedupKey);
      if (current?.window === authWindow) inFlightVisibleAuthWindows.delete(dedupKey);
    };
    inFlightVisibleAuthWindows.set(dedupKey, { window: authWindow, promise: authPromise });
    // Cleanup is driven by window teardown, NOT by the promise: every settle
    // path (resolve / reject / timeout) closes the window, so `closed` always
    // fires. We deliberately do NOT chain `.finally(clearOwnEntry)` on
    // `authPromise` — that would create an uncaught rejection on the derived
    // promise whenever the auth flow rejects.
    authWindow.on("closed", clearOwnEntry);
    authWindow.webContents.on("render-process-gone", clearOwnEntry);
  }

  return authPromise;
}

// Auth windows are centered in the primary display work area. The previous
// behavior followed the host parent position, which clipped auth windows when
// the host was near a screen edge and forced users to move them manually.
function centerAuthWindowOnScreen(authWindow: BrowserWindow): void {
  if (authWindow.isDestroyed()) return;
  const { workArea } = screen.getPrimaryDisplay();
  const { width, height } = authWindow.getBounds();
  authWindow.setPosition(
    Math.round(workArea.x + (workArea.width - width) / 2),
    Math.round(workArea.y + (workArea.height - height) / 2),
  );
}

/**
 * Wipe all credential state from a persist partition — cookies, storage,
 * cache, indexedDB, HTTP cache, auth cache, and the WebStorage stack.
 * Used after a plugin's user-triggered sign-out so that subsequent
 * `openAuthWindow` calls against the same partition cannot silently SSO
 * via residual IdP cookies the host Chromium still holds. Without this,
 * plugin "sign out" only clears the
 * plugin's in-memory + on-disk shadow state; the partition keeps the
 * federated session alive and re-login proceeds with no challenge.
 *
 * The plugin-runtime layer (`plugin-runtime.ts`) validates the partition
 * argument against the calling plugin's `persist:plugin-auth:<pluginId>`
 * allow-list before calling this service. Direct host callers are
 * responsible for their own scoping.
 *
 * The wipe runs in two passes: `clearStorageData()` for the broad
 * cookie/storage/cache surface, then `clearAuthCache()` for HTTP-auth
 * + NTLM/Kerberos credentials that `clearStorageData` does not touch.
 */
export async function clearAuthPartition(partition: string): Promise<void> {
  if (typeof partition !== "string" || partition.length === 0) {
    throw new Error("clearAuthPartition: partition must be a non-empty string");
  }
  const ses = session.fromPartition(partition);
  await ses.clearStorageData({
    storages: [
      "cookies",
      "filesystem",
      "indexdb",
      "localstorage",
      "shadercache",
      "serviceworkers",
      "cachestorage",
    ],
  });
  await ses.clearCache();
  if (typeof ses.clearAuthCache === "function") {
    await ses.clearAuthCache();
  }
}
