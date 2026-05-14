/**
 * Auth Window Service — 외부 포털 interactive 로그인 후 쿠키 수집.
 *
 * 플러그인(`PluginHostApi.openAuthWindow`)을 통해 노출됨. Electron의
 * `BrowserWindow` + `session.cookies` API를 사용하여 Selenium/webdriver 의존성
 * 없이 사용자 로그인을 캡처한다.
 *
 * 설계 원칙:
 *  - 호스트가 브라우저 창 lifecycle을 소유 — 플러그인은 `ipcMain`/`BrowserWindow`에
 *    직접 접근하지 않는다 (§4.5 IPC 스코프 원칙).
 *  - 완료 조건(URL 패턴)과 쿠키 호스트 화이트리스트는 플러그인이 호출 시 전달 —
 *    호스트는 LGE-specific 정보를 알지 못한다 (§1 원칙 "NO plugin-specific code in host").
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserWindow, session, type Cookie, type Session, type WebContents } from "electron";
import { registerWindowEventListeners } from "../ipc/domains/window.js";
import { markAsWindowControlOwned } from "../ipc/window-control-registry.js";
import { markAsAuthOwned } from "./auth-window-registry.js";
import {
  buildTitlebarCss,
  buildTitlebarHtml,
  buildTitlebarButtonScript,
} from "./window-titlebar-shell.js";
import { resolveAppIconPath } from "./app-icon.js";

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
  /** Unix seconds. Session cookie이면 생략. */
  expirationDate?: number;
}

export interface OpenAuthWindowOptions {
  /** 초기 로드 URL (외부 포털 SSO 시작점). */
  url: string;
  /**
   * 현재 URL에 아래 substring 중 하나라도 포함되면 로그인 완료로 간주.
   * 주의: `sso` 등 여전히 SSO 경로를 포함하는 URL을 매칭하지 않도록 호출자가 명확히 지정.
   */
  completionUrlPatterns: string[];
  /**
   * 수집할 쿠키의 도메인 suffix. 예: `["sso.example.com", "portal.example.com"]`.
   * 반환 쿠키는 `cookie.domain` 이 이 목록 중 하나의 suffix이어야 한다.
   * 실제 도메인은 호출자(플러그인)가 제공 — 호스트 코드는 corp 도메인을 직접 박지 않는다.
   */
  cookieHosts: string[];
  /** 로그인 타임아웃. 기본 5분. */
  timeoutMs?: number;
  /** 창 타이틀. 기본 "Login". */
  windowTitle?: string;
  /**
   * Opt-in result shape for OAuth-style callbacks where the plugin needs the
   * final callback URL (for example a fragment token) in addition to cookies.
   * Default preserves the legacy AuthCookie[] return contract.
   */
  returnFinalUrl?: boolean;
  /**
   * Electron session partition. `persist:` prefix 가 붙으면 디스크 영속,
   * 없으면 in-memory.
   *
   * **기본값은 undefined 가 아니라 호출마다 새로운 in-memory partition**
   * (`ephemeral-auth-<random>`) — default session 공유하지 않는다.
   * 쿠키/세션 storage 를 재사용하려면 **같은 partition 을 명시적으로** 전달해야 한다.
   *
   * (Plugin host 는 추가로 `persist:plugin-auth:${encodeURIComponent(pluginId)}[:<sub>]`
   * 네임스페이스 밖의 값을 거부한다 — plugin-runtime 참고.)
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

/** 호스트 문자열 정규화 — 선행 점/공백/대소문자 차이 흡수. 빈 문자열은 drop. */
function normalizeHost(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  return trimmed.startsWith(".") ? trimmed.slice(1) : trimmed;
}

/**
 * 쿠키 배열에서 허용된 호스트만 필터링 + AuthCookie로 직렬화.
 * `allowedHosts` 도 쿠키 domain 과 동일 방식으로 정규화하여
 * ".example.com" vs "example.com" 같은 표기 차이로 매칭이 실패하지 않게 한다.
 */
export function filterCookiesByHost(cookies: Cookie[], allowedHosts: string[]): AuthCookie[] {
  const normalizedAllowed = allowedHosts
    .map(normalizeHost)
    .filter((h) => h.length > 0);
  if (normalizedAllowed.length === 0) return [];
  return cookies
    .filter((c) => {
      if (!c.domain) return false;
      // Electron 쿠키 domain은 선행 점(".example.com") 포함일 수 있음 — 정규화 후 비교.
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
 * URL 의 `origin + pathname` 이 완료 패턴 중 하나를 포함하면 true.
 * query/hash 는 **제외** 한다 — IdP 가 RelayState / continue / returnTo
 * 같은 파라미터에 목적지 URL 을 담아 보내 IdP 도메인에 있는 상태에서
 * 거짓 양성으로 "완료" 판정되는 것을 막는다.
 */
export function isCompletionUrl(url: string, patterns: string[]): boolean {
  const target = extractCompletionTarget(url);
  return patterns.some((p) => target.includes(p));
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
    // URL 생성자가 실패하면 query/hash 직접 제거.
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
 * 지정 URL을 띄우고 완료 패턴에 도달할 때까지 대기한 뒤 쿠키 수집.
 * 창은 항상 close(). 사용자가 창을 미리 닫으면 reject.
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

  // timeoutMs 검증 — NaN / Infinity / 음수 / 과도하게 긴 값 모두 거부.
  // 기본 5분, 최대 30분 (manifest schema 와 동일한 상한).
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

  // 문자열 배열의 빈/공백 엔트리를 drop. 빈 문자열 한 개라도 남으면
  // `isCompletionUrl` 의 substring 매칭이 항상 true 가 되어 인증 흐름이
  // 즉시 "완료" 로 오판되고 쿠키가 조기 수집된다.
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

  // `persistPartition` 미지정 시 Electron 의 default session 을 쓰지 않고
  // 호출마다 새 in-memory partition 을 만들어 격리한다. 플러그인 런타임
  // 레이어에서 이미 per-plugin 기본값을 주입하지만, 서비스가 직접 호출되는
  // 다른 경로(host 내부 auth flow 등) 에도 안전한 기본값을 보장한다.
  const effectivePartition =
    persistPartition && persistPartition.length > 0
      ? persistPartition
      : `ephemeral-auth-${randomBytes(8).toString("hex")}`;

  // Hardened webPreferences — 외부 포털을 Chromium 에 띄우는 창이므로
  // renderer ↔ Node 경계를 완전히 차단해 RCE 표면을 좁힌다. 원격지 페이지에
  // Node API / 다른 BrowserWindow 생성 권한이 없어야 한다.
  const authWindow = new BrowserWindow({
    parent,
    modal: false,
    width: 1024,
    height: 768,
    title: windowTitle,
    icon: resolveAppIconPath(),
    autoHideMenuBar: true,
    frame: process.platform !== "darwin" ? false : undefined,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
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
  if (showRequested) centerAuthWindowOverParent(authWindow, parent);
  if (typeof authWindow.setMenu === "function") authWindow.setMenu(null);
  markAsWindowControlOwned(authWindow.webContents);
  registerWindowEventListeners(authWindow);

  let authContents: WebContents | null = null;

  // Top-level navigation 프로토콜 제한 — http/https 만 허용. 외부 포털이
  // redirect / 사용자 클릭으로 `file:`, `data:`, custom scheme 으로 이동해
  // 로컬 파일 노출이나 스킴 핸들러 악용을 트리거하는 것을 차단.
  //
  // `will-navigate` 는 주로 사용자/script 기반 top-level navigation 을 잡고,
  // 서버측 302 redirect 는 `will-redirect` 로 온다. 양쪽에 같은 가드를 건다.
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

  return new Promise<AuthCookie[] | OpenAuthWindowResult>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => {
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
      markAsAuthOwned(contents);
      attachAuthNavigationGuards(contents);
      contents.on("did-navigate", () => { void checkAndCollect(); });
      contents.on("did-navigate-in-page", () => { void checkAndCollect(); });
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
    // `ERR_ABORTED` (-3) 은 SSO redirect chain 중 이전 load 가 취소되며
    // 흔히 발생하는 benign 실패다. 이걸로 즉시 reject 하면 정상적인 POST→302
    // redirect 에서 로그인 플로우가 도중에 끊긴다. 대신 현재 URL 이 이미
    // completion pattern 에 도달했는지 한 번 더 확인하고, 아니면 무시한다.
    const ERR_ABORTED = -3;
    const failReject = (errorCode: number, errorDesc: string, validatedUrl: string) =>
      finish(() => {
        clearTimeout(timer);
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
        // benign: redirect / page-transition cancel. 완료 조건 충족했는지
        // 재검사하고 (쿠키 수집이 가능하면 그쪽으로 resolve), 아니면 그냥 흘림.
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
        reject(new Error(`openAuthWindow: render process gone (${details.reason})`));
        if (!authWindow.isDestroyed()) authWindow.close();
      });
    });

    authWindow.on("closed", () => {
      finish(() => {
        clearTimeout(timer);
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
        reject(new Error(`openAuthWindow: load failed for ${sanitizeUrlForLog(url)} (${(err as Error).name || "Error"})`));
        if (!authWindow.isDestroyed()) authWindow.close();
      });
    });
  });
}

function centerAuthWindowOverParent(authWindow: BrowserWindow, parent: BrowserWindow): void {
  if (authWindow.isDestroyed() || parent.isDestroyed()) return;
  const parentBounds = parent.getBounds();
  const authBounds = authWindow.getBounds();
  authWindow.setPosition(
    Math.round(parentBounds.x + (parentBounds.width - authBounds.width) / 2),
    Math.round(parentBounds.y + (parentBounds.height - authBounds.height) / 2),
  );
}

/**
 * Wipe all credential state from a persist partition — cookies, storage,
 * cache, indexedDB, HTTP cache, auth cache, and the WebStorage stack.
 * Used after a plugin's user-triggered sign-out so that subsequent
 * `openAuthWindow` calls against the same partition cannot silently SSO
 * via residual IdP cookies (`.lge.com`, `.microsoft.com`, etc.) the host
 * Chromium still holds. Without this, plugin "sign out" only clears the
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
      "websql",
      "serviceworkers",
      "cachestorage",
    ],
  });
  await ses.clearCache();
  if (typeof ses.clearAuthCache === "function") {
    await ses.clearAuthCache();
  }
}
