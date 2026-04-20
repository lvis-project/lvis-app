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
import { BrowserWindow, type Cookie, type Session } from "electron";

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
   * 수집할 쿠키의 도메인 suffix. 예: `["sso.lge.com", "newep.lge.com"]`.
   * 반환 쿠키는 `cookie.domain` 이 이 목록 중 하나의 suffix이어야 한다.
   */
  cookieHosts: string[];
  /** 로그인 타임아웃. 기본 5분. */
  timeoutMs?: number;
  /** 창 타이틀. 기본 "Login". */
  windowTitle?: string;
  /**
   * Electron session partition. `persist:` prefix가 붙으면 영구 세션.
   * 서로 다른 포털 간 쿠키 격리를 원하면 플러그인별로 다른 partition 지정.
   * 기본 undefined — default session 공유.
   */
  persistPartition?: string;
}

/** 호스트 문자열 정규화 — 선행 점/공백/대소문자 차이 흡수. 빈 문자열은 drop. */
function normalizeHost(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  return trimmed.startsWith(".") ? trimmed.slice(1) : trimmed;
}

/**
 * 쿠키 배열에서 허용된 호스트만 필터링 + AuthCookie로 직렬화.
 * `allowedHosts` 도 쿠키 domain 과 동일 방식으로 정규화하여
 * ".lge.com" vs "lge.com" 같은 표기 차이로 매칭이 실패하지 않게 한다.
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

/**
 * 지정 URL을 띄우고 완료 패턴에 도달할 때까지 대기한 뒤 쿠키 수집.
 * 창은 항상 close(). 사용자가 창을 미리 닫으면 reject.
 */
export async function openAuthWindow(
  parent: BrowserWindow,
  options: OpenAuthWindowOptions,
): Promise<AuthCookie[]> {
  const {
    url,
    completionUrlPatterns,
    cookieHosts,
    windowTitle = "Login",
    persistPartition,
  } = options;

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
    throw new Error(`openAuthWindow: invalid url "${url}"`);
  }
  if (!Array.isArray(completionUrlPatterns) || completionUrlPatterns.length === 0) {
    throw new Error("openAuthWindow: completionUrlPatterns must be a non-empty array");
  }
  if (!Array.isArray(cookieHosts) || cookieHosts.length === 0) {
    throw new Error("openAuthWindow: cookieHosts must be a non-empty array");
  }

  // Hardened webPreferences — 외부 포털을 Chromium 에 띄우는 창이므로
  // renderer ↔ Node 경계를 완전히 차단해 RCE 표면을 좁힌다. 원격지 페이지에
  // Node API / 다른 BrowserWindow 생성 권한이 없어야 한다.
  const authWindow = new BrowserWindow({
    parent,
    modal: false,
    width: 1024,
    height: 768,
    title: windowTitle,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      sandbox: true,
      ...(persistPartition ? { partition: persistPartition } : {}),
    },
  });

  // Popup / window.open 차단 — 포털이 새 창을 열어 쿠키를 다른 origin 에
  // 심거나 사용자를 임의 사이트로 튕기는 경로 제거.
  authWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  return new Promise<AuthCookie[]>((resolve, reject) => {
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
      const currentUrl = authWindow.webContents.getURL();
      if (!isCompletionUrl(currentUrl, completionUrlPatterns)) return;
      try {
        const allCookies = await (authWindow.webContents.session as Session).cookies.get({});
        const filtered = filterCookiesByHost(allCookies, cookieHosts);
        finish(() => {
          clearTimeout(timer);
          resolve(filtered);
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

    authWindow.webContents.on("did-navigate", () => { void checkAndCollect(); });
    authWindow.webContents.on("did-navigate-in-page", () => { void checkAndCollect(); });

    // Fast-fail on navigation errors so we don't wait the full timeout for
    // DNS / TLS / proxy / offline / renderer-crash scenarios. isMainFrame
    // filters out third-party asset failures that shouldn't abort login.
    const failReject = (errorCode: number, errorDesc: string, validatedUrl: string) =>
      finish(() => {
        clearTimeout(timer);
        reject(
          new Error(
            `openAuthWindow: navigation failed (${errorCode} ${errorDesc}) url=${validatedUrl}`,
          ),
        );
        if (!authWindow.isDestroyed()) authWindow.close();
      });

    authWindow.webContents.on(
      "did-fail-load",
      (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame) return;
        failReject(errorCode, errorDescription, validatedURL);
      },
    );
    authWindow.webContents.on(
      "did-fail-provisional-load",
      (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame) return;
        failReject(errorCode, errorDescription, validatedURL);
      },
    );
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

    authWindow.loadURL(url).catch((err) => {
      finish(() => {
        clearTimeout(timer);
        reject(err as Error);
        if (!authWindow.isDestroyed()) authWindow.close();
      });
    });
  });
}
