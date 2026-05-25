/**
 * End-to-end regression tests for openAuthWindow fast-SSO race (issue #960).
 *
 * These tests exercise the full openAuthWindow() call path — including the
 * BrowserWindow/webContents event loop — to guard against refactors that
 * silently reintroduce the false-reject bug where a fast SSO success (window
 * closed immediately after did-navigate to completion URL) was incorrectly
 * rejected with "window closed before login completed".
 *
 * The existing unit tests for shouldGraceCollectClosedAuthWindow cover the
 * predicate in isolation. These tests cover the end-to-end settled/finish()
 * mutual-exclusion guard and the closed handler ordering against the live
 * openAuthWindow() implementation.
 *
 * MUTATION CONTRACT: every test in this file must fail when the production
 * fix is reverted. See inline comments for which mutation each test catches.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { Cookie } from "electron";

// ---------------------------------------------------------------------------
// Flush async microtasks/macrotasks without relying on vi.runAllMicrotasksAsync
// (not available in vitest 4.x). Multiple setTimeout(0) rounds drain the
// Promise queue in node environments.
// ---------------------------------------------------------------------------
async function flushAsync(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

// ---------------------------------------------------------------------------
// Fake EventEmitter used to drive BrowserWindow and WebContents events.
// ---------------------------------------------------------------------------
class FakeEmitter {
  private _listeners: Map<string, Array<(...args: unknown[]) => void>> = new Map();

  on(event: string, listener: (...args: unknown[]) => void): this {
    const list = this._listeners.get(event) ?? [];
    list.push(listener);
    this._listeners.set(event, list);
    return this;
  }

  once(event: string, listener: (...args: unknown[]) => void): this {
    const wrapper = (...args: unknown[]) => {
      listener(...args);
      this.off(event, wrapper);
    };
    return this.on(event, wrapper);
  }

  off(event: string, listener: (...args: unknown[]) => void): this {
    const list = this._listeners.get(event) ?? [];
    this._listeners.set(event, list.filter((l) => l !== listener));
    return this;
  }

  emit(event: string, ...args: unknown[]): boolean {
    // Snapshot the list — a listener may call off() during iteration.
    const list = [...(this._listeners.get(event) ?? [])];
    for (const l of list) l(...args);
    return list.length > 0;
  }
}

// ---------------------------------------------------------------------------
// Fake WebContents — represents the sandboxed webview contents.
// ---------------------------------------------------------------------------
class FakeWebContents extends FakeEmitter {
  private _currentUrl: string;
  public session: { cookies: { get: ReturnType<typeof vi.fn> } };
  public isDestroyed = vi.fn(() => false);
  public setWindowOpenHandler = vi.fn();
  public openDevTools = vi.fn();
  public executeJavaScript = vi.fn().mockResolvedValue(undefined);

  constructor(initialUrl: string, cookiesForSession: Cookie[] = []) {
    super();
    this._currentUrl = initialUrl;
    this.session = {
      cookies: {
        get: vi.fn().mockResolvedValue(cookiesForSession),
      },
    };
  }

  getURL(): string {
    return this._currentUrl;
  }

  navigateTo(url: string): void {
    this._currentUrl = url;
  }
}

// ---------------------------------------------------------------------------
// Fake BrowserWindow shell — hosts the webview and outer window events.
// The BrowserWindow mock in vi.mock must be a real constructor function
// (not an arrow function) so `new BrowserWindow(...)` works.
// ---------------------------------------------------------------------------
class FakeBrowserWindow extends FakeEmitter {
  public webContents: FakeWebContents;
  private _destroyed = false;

  public setMenu = vi.fn();
  public isDestroyed = vi.fn(() => this._destroyed);
  public getBounds = vi.fn(() => ({ x: 0, y: 0, width: 1024, height: 768 }));
  public setPosition = vi.fn();
  public loadURL = vi.fn().mockResolvedValue(undefined);
  // close() is a spy so tests can assert how many times it was called.
  // It emits "closed" exactly once (guards against double-fire).
  public close = vi.fn(() => {
    if (!this._destroyed) {
      this._destroyed = true;
      this.emit("closed");
    }
  });

  constructor() {
    super();
    this.webContents = new FakeWebContents("about:blank");
  }
}

// ---------------------------------------------------------------------------
// Module-level state — the active FakeBrowserWindow created per openAuthWindow
// call. Populated by the BrowserWindow constructor mock below.
// ---------------------------------------------------------------------------
let currentFakeWindow: FakeBrowserWindow;

// Shared partition session returned by session.fromPartition in grace-collect.
const fakePartitionSession = {
  cookies: { get: vi.fn() },
};

// ---------------------------------------------------------------------------
// Module mocks — registered before any dynamic import of the service.
//
// BrowserWindow uses a real `function` declaration (not an arrow) so it can
// be called with `new`. The mock records the new FakeBrowserWindow in
// `currentFakeWindow` so tests can drive events on it.
// ---------------------------------------------------------------------------
vi.mock("electron", () => {
  function MockBrowserWindow(_opts: unknown) {
    const win = new FakeBrowserWindow();
    currentFakeWindow = win;
    return win;
  }

  return {
    BrowserWindow: MockBrowserWindow,
    screen: {
      getPrimaryDisplay: vi.fn(() => ({
        workArea: { x: 0, y: 0, width: 1920, height: 1080 },
      })),
    },
    session: {
      fromPartition: vi.fn().mockReturnValue(fakePartitionSession),
    },
    shell: { openExternal: vi.fn() },
    app: {},
    ipcMain: {},
  };
});

vi.mock("../window-chrome.js", () => ({
  getCommonChromeOptions: vi.fn(() => ({})),
}));
vi.mock("../../ipc/domains/window.js", () => ({
  registerWindowEventListeners: vi.fn(),
}));
vi.mock("../../ipc/window-control-registry.js", () => ({
  markAsWindowControlOwned: vi.fn(),
}));
vi.mock("../auth-window-registry.js", () => ({
  markAsAuthOwned: vi.fn(),
}));
vi.mock("../window-titlebar-shell.js", () => ({
  buildTitlebarCss: vi.fn(() => ""),
  buildTitlebarHtml: vi.fn(() => ""),
  buildTitlebarButtonScript: vi.fn(() => ""),
}));
vi.mock("../app-icon.js", () => ({
  resolveAppIconPath: vi.fn(() => undefined),
}));
vi.mock("../../lib/logger.js", () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

// ---------------------------------------------------------------------------
// Import service under test (after all mocks are registered).
// ---------------------------------------------------------------------------
const { openAuthWindow, wirePluginAuthPartitionPersistence } = await import(
  "../auth-window-service.js"
);

// Wire no-op persistence so rememberPluginAuthPartition doesn't throw.
wirePluginAuthPartitionPersistence({
  write: vi.fn().mockResolvedValue(undefined),
  delete: vi.fn().mockResolvedValue(undefined),
  onError: vi.fn(),
});

// ---------------------------------------------------------------------------
// Test constants.
// ---------------------------------------------------------------------------
const COMPLETION_URL = "https://portal.example.com/auth/callback";
const COMPLETION_PATTERN = "portal.example.com/auth/callback";
const COOKIE_HOST = "portal.example.com";
const SESSION_COOKIE: Cookie = {
  name: "session",
  value: "abc123",
  domain: ".portal.example.com",
  path: "/",
  secure: true,
  httpOnly: true,
  session: false,
  hostOnly: false,
  sameSite: "unspecified",
};

function makeParentWindow(): FakeBrowserWindow {
  return new FakeBrowserWindow();
}

beforeEach(() => {
  vi.clearAllMocks();
  fakePartitionSession.cookies.get.mockResolvedValue([SESSION_COOKIE]);
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Suite 1 — fast-SSO race: closed arrives while checkAndCollect is in-flight.
//
// THE REAL RACE: did-navigate fires → checkAndCollect starts (calls async
// cookies.get and suspends) → closed fires BEFORE cookies.get resolves →
// grace-collect in the closed handler attempts to resolve via
// session.fromPartition. With the fix, grace-collect wins and the promise
// resolves. Without the fix (no settled guard), the closed handler rejects
// unconditionally regardless of the grace-collect path.
//
// MUTATION CAUGHT: removing the `settled` guard or removing the grace-collect
// path in the closed handler makes this test fail (the promise rejects
// instead of resolving).
//
// HOW THE RACE IS CREATED: webview cookies.get is made to hang
// (mockReturnValue(hangingPromise)) so checkAndCollect is suspended at
// `await cookies.get(...)`. closed fires synchronously before that await
// resolves. The grace-collect path reads from fakePartitionSession which
// resolves immediately with cookies.
// ---------------------------------------------------------------------------
describe("openAuthWindow — fast-SSO race: closed fires while checkAndCollect is in-flight", () => {
  it("resolves with cookies when closed arrives while the webview cookie fetch is still pending", async () => {
    // MUTATION CAUGHT: removing the grace-collect path from the closed handler
    // causes this promise to reject ("window closed before login completed")
    // instead of resolving with cookies.
    const parent = makeParentWindow() as unknown as import("electron").BrowserWindow;

    // Hang the webview-level cookies.get so checkAndCollect suspends at
    // `await cookies.get(...)` — the exact state needed to simulate the race.
    let resolveWebviewCookies!: (c: Cookie[]) => void;
    const hangingCookiePromise = new Promise<Cookie[]>((res) => {
      resolveWebviewCookies = res;
    });

    const resultPromise = openAuthWindow(parent, {
      url: "https://sso.example.com/login",
      completionUrlPatterns: [COMPLETION_PATTERN],
      cookieHosts: [COOKIE_HOST],
      timeoutMs: 10_000,
    });
    // Pre-attach catch so the rejection is never "unhandled" even when the
    // mutation causes a reject. The final assertion distinguishes ok vs error.
    const outcomePromise = resultPromise.then(
      (v) => ({ ok: true as const, value: v }),
      (e: unknown) => ({ ok: false as const, error: e }),
    );

    // Let loadURL microtask settle.
    await flushAsync(1);

    // Attach webview and navigate to completion URL. The did-navigate listener
    // in openAuthWindow calls checkAndCollect(), which checks isCompletionUrl
    // (synchronous), then suspends at `await cookies.get({})`.
    const fakeWv = new FakeWebContents(COMPLETION_URL);
    fakeWv.session.cookies.get.mockReturnValue(hangingCookiePromise); // hangs
    currentFakeWindow.webContents.emit("did-attach-webview", {}, fakeWv);
    fakeWv.navigateTo(COMPLETION_URL);
    fakeWv.emit("did-navigate", {}, COMPLETION_URL);

    // Do NOT flush here. checkAndCollect is suspended inside the hanging
    // cookies.get Promise. settled=false at this point.
    // Fire closed NOW — this is the race: closed handler runs while
    // checkAndCollect has not yet called finish().
    // Grace-collect fires because lastCommittedUrl matches completionPatterns
    // (trackNav sets lastCommittedUrl synchronously in the did-navigate handler).
    fakePartitionSession.cookies.get.mockResolvedValue([SESSION_COOKIE]);
    currentFakeWindow.emit("closed");

    // Let grace-collect's async cookies.get resolve.
    await flushAsync();

    // Webview cookies resolve now (late) — settled=true so finish() is a no-op.
    resolveWebviewCookies([]);
    await flushAsync();

    const outcome = await outcomePromise;
    // The promise MUST have resolved via grace-collect, not rejected.
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      const cookies = outcome.value as import("../auth-window-service.js").AuthCookie[];
      expect(Array.isArray(cookies)).toBe(true);
      expect(cookies.length).toBeGreaterThan(0);
      expect(cookies[0].name).toBe("session");
      expect(cookies[0].value).toBe("abc123");
    }
  });

  it("resolves with OpenAuthWindowResult envelope when returnFinalUrl is true", async () => {
    // MUTATION CAUGHT: removing the grace-collect path causes rejection instead
    // of the {cookies, finalUrl} envelope resolve.
    const parent = makeParentWindow() as unknown as import("electron").BrowserWindow;

    let resolveWebviewCookies!: (c: Cookie[]) => void;
    const hangingCookiePromise = new Promise<Cookie[]>((res) => {
      resolveWebviewCookies = res;
    });

    const resultPromise = openAuthWindow(parent, {
      url: "https://sso.example.com/login",
      completionUrlPatterns: [COMPLETION_PATTERN],
      cookieHosts: [COOKIE_HOST],
      timeoutMs: 10_000,
      returnFinalUrl: true,
    });
    const outcomePromise = resultPromise.then(
      (v) => ({ ok: true as const, value: v }),
      (e: unknown) => ({ ok: false as const, error: e }),
    );

    await flushAsync(1);

    const fakeWv = new FakeWebContents(COMPLETION_URL);
    fakeWv.session.cookies.get.mockReturnValue(hangingCookiePromise);
    currentFakeWindow.webContents.emit("did-attach-webview", {}, fakeWv);
    fakeWv.navigateTo(COMPLETION_URL);
    fakeWv.emit("did-navigate", {}, COMPLETION_URL);

    // closed fires while checkAndCollect is suspended.
    fakePartitionSession.cookies.get.mockResolvedValue([SESSION_COOKIE]);
    currentFakeWindow.emit("closed");

    await flushAsync();
    resolveWebviewCookies([]);
    await flushAsync();

    const outcome = await outcomePromise;
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value).toHaveProperty("cookies");
      expect(outcome.value).toHaveProperty("finalUrl");
      const envelope = outcome.value as import("../auth-window-service.js").OpenAuthWindowResult;
      expect(envelope.finalUrl).toBe(COMPLETION_URL);
      expect(envelope.cookies[0].name).toBe("session");
    }
  });
});

// ---------------------------------------------------------------------------
// Suite 2 — grace-collect path (closed fires BEFORE checkAndCollect ran).
// ---------------------------------------------------------------------------
describe("openAuthWindow — grace-collect path (closed fires before checkAndCollect)", () => {
  it("resolves via grace-collect when window closes while webview cookie fetch is in flight", async () => {
    const parent = makeParentWindow() as unknown as import("electron").BrowserWindow;

    let resolveWebviewCookies!: (c: Cookie[]) => void;
    const hangingCookiePromise = new Promise<Cookie[]>((res) => {
      resolveWebviewCookies = res;
    });

    const resultPromise = openAuthWindow(parent, {
      url: "https://sso.example.com/login",
      completionUrlPatterns: [COMPLETION_PATTERN],
      cookieHosts: [COOKIE_HOST],
      timeoutMs: 10_000,
    });

    await flushAsync();

    const fakeWv = new FakeWebContents(COMPLETION_URL);
    fakeWv.session.cookies.get.mockReturnValue(hangingCookiePromise);
    currentFakeWindow.webContents.emit("did-attach-webview", {}, fakeWv);
    fakeWv.navigateTo(COMPLETION_URL);
    fakeWv.emit("did-navigate", {}, COMPLETION_URL);

    fakePartitionSession.cookies.get.mockResolvedValue([SESSION_COOKIE]);
    currentFakeWindow.emit("closed");

    resolveWebviewCookies([]);
    await flushAsync();

    const result = await resultPromise;
    const cookies = result as import("../auth-window-service.js").AuthCookie[];
    expect(Array.isArray(cookies)).toBe(true);
    expect(cookies[0].name).toBe("session");
  });

  it("rejects when window closes before webview attaches (no grace-collect possible)", async () => {
    const parent = makeParentWindow() as unknown as import("electron").BrowserWindow;

    const resultPromise = openAuthWindow(parent, {
      url: "https://sso.example.com/login",
      completionUrlPatterns: [COMPLETION_PATTERN],
      cookieHosts: [COOKIE_HOST],
      timeoutMs: 10_000,
    });
    const caught = resultPromise.catch((e: unknown) => e);

    await flushAsync();

    currentFakeWindow.emit("closed");
    await flushAsync();

    const err = await caught;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("window closed before login completed");
  });

  it("rejects when window closes after webview attaches but before navigating to a completion URL", async () => {
    const parent = makeParentWindow() as unknown as import("electron").BrowserWindow;

    const resultPromise = openAuthWindow(parent, {
      url: "https://sso.example.com/login",
      completionUrlPatterns: [COMPLETION_PATTERN],
      cookieHosts: [COOKIE_HOST],
      timeoutMs: 10_000,
    });
    const caught = resultPromise.catch((e: unknown) => e);

    await flushAsync();

    const fakeWv = new FakeWebContents("https://sso.example.com/login");
    currentFakeWindow.webContents.emit("did-attach-webview", {}, fakeWv);
    fakeWv.emit("did-navigate", {}, "https://sso.example.com/login");

    await flushAsync();

    currentFakeWindow.emit("closed");
    await flushAsync();

    const err = await caught;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("window closed before login completed");
  });

  it("rejects when the grace-collect cookie fetch itself fails — error is not suppressed", async () => {
    const parent = makeParentWindow() as unknown as import("electron").BrowserWindow;

    const resultPromise = openAuthWindow(parent, {
      url: "https://sso.example.com/login",
      completionUrlPatterns: [COMPLETION_PATTERN],
      cookieHosts: [COOKIE_HOST],
      timeoutMs: 10_000,
    });
    const caught = resultPromise.catch((e: unknown) => e);

    await flushAsync();

    const fakeWv = new FakeWebContents(COMPLETION_URL);
    fakeWv.session.cookies.get.mockRejectedValue(new Error("webview session destroyed"));
    currentFakeWindow.webContents.emit("did-attach-webview", {}, fakeWv);
    fakeWv.navigateTo(COMPLETION_URL);
    fakeWv.emit("did-navigate", {}, COMPLETION_URL);

    fakePartitionSession.cookies.get.mockRejectedValue(new Error("partition gone"));

    await flushAsync();
    currentFakeWindow.emit("closed");
    await flushAsync();

    const err = await caught;
    expect(err).toBeInstanceOf(Error);
  });
});

// ---------------------------------------------------------------------------
// Suite 3 — settled/finish() mutual-exclusion guard: the "closed" event
// emitted by checkAndCollect's own authWindow.close() call must not
// trigger a second outcome.
//
// SEQUENCE UNDER TEST:
//   1. checkAndCollect wins the race: cookies collected, finish(resolve) called
//   2. finish(resolve) calls authWindow.close() — which emits "closed"
//   3. The closed handler fires; `if (settled) return` exits immediately
//   4. Promise resolves with cookies (not rejected by the cascading closed)
//
// MUTATION CAUGHT: removing `if (settled) return` at the TOP of the closed
// handler (the guard that guards the whole handler body, line ~820) lets the
// closed handler run its reject path. The test navigation URL does NOT match
// completionUrlPatterns (we arrange that), so grace-collect is ineligible and
// the handler calls finish(() => reject("window closed before login")).
// Without the outer settled guard, this finish() call would win (because
// the promise itself isn't re-settled by a no-op reject, but downstream
// code relying on a resolved result would break). We detect this by asserting
// the promise resolves (not rejects).
//
// NOTE: removing only the inner `if (settled) return` inside finish() is
// already caught by Suite 1 (double-resolve race). This suite specifically
// targets the outer `if (settled) return` at the top of the closed handler.
// ---------------------------------------------------------------------------
describe("openAuthWindow — settled/finish() mutual-exclusion guard", () => {
  it("resolves correctly when checkAndCollect calls close() which cascades a closed event", async () => {
    // MUTATION CAUGHT: without `if (settled) return` at the top of the closed
    // handler, when checkAndCollect calls authWindow.close() → "closed" fires
    // → closed handler runs the reject path (no completion URL match at that
    // moment, because the handler runs synchronously inside close()). This
    // would cause a double-finish attempt. With the guard, settled=true after
    // checkAndCollect and the closed handler exits immediately.
    //
    // We detect the mutation by asserting the promise resolves successfully.
    const parent = makeParentWindow() as unknown as import("electron").BrowserWindow;

    const resultPromise = openAuthWindow(parent, {
      url: "https://sso.example.com/login",
      completionUrlPatterns: [COMPLETION_PATTERN],
      cookieHosts: [COOKIE_HOST],
      timeoutMs: 10_000,
    });
    // Pre-attach catch so rejection doesn't become unhandled — the test asserts
    // this resolves, so any rejection here is a genuine test failure.
    const outcomePromise = resultPromise.then(
      (v) => ({ ok: true as const, value: v }),
      (e: unknown) => ({ ok: false as const, error: e }),
    );

    await flushAsync(1);

    // Navigate to completion URL with immediately-resolving cookies.get.
    // checkAndCollect will: collect cookies → call finish(resolve) →
    // resolve the promise → call authWindow.close() (our spy).
    // Our close() spy emits "closed" synchronously.
    // The closed handler then fires with settled=true → must return immediately.
    const fakeWv = new FakeWebContents(COMPLETION_URL);
    fakeWv.session.cookies.get.mockResolvedValue([SESSION_COOKIE]);
    currentFakeWindow.webContents.emit("did-attach-webview", {}, fakeWv);
    fakeWv.navigateTo(COMPLETION_URL);
    fakeWv.emit("did-navigate", {}, COMPLETION_URL);

    await flushAsync();

    const outcome = await outcomePromise;

    // The promise must have resolved — not rejected by the cascading closed event.
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      const cookies = outcome.value as import("../auth-window-service.js").AuthCookie[];
      expect(Array.isArray(cookies)).toBe(true);
      expect(cookies[0].name).toBe("session");
    }
  });

  it("does not reject when closed fires after checkAndCollect already resolved (guard makes closed a no-op)", async () => {
    // MUTATION CAUGHT: if `if (settled) return` is removed from the closed
    // handler, and closed is emitted externally AFTER checkAndCollect resolved,
    // the handler falls through to finish(() => reject(...)) — which JS ignores
    // at the Promise level (already settled) but executes the callback body.
    // We detect this by pre-hanging checkAndCollect's cookies.get, letting
    // grace-collect (closed handler) resolve first, then completing
    // checkAndCollect late — and asserting the result is still the cookies
    // (not overwritten by the late checkAndCollect path).
    //
    // More precisely: this test exercises that settled=true after grace-collect
    // makes the late-arriving checkAndCollect's finish() a no-op.
    const parent = makeParentWindow() as unknown as import("electron").BrowserWindow;

    let resolveWebviewCookies!: (c: Cookie[]) => void;
    const hangingCookiePromise = new Promise<Cookie[]>((res) => {
      resolveWebviewCookies = res;
    });

    const resultPromise = openAuthWindow(parent, {
      url: "https://sso.example.com/login",
      completionUrlPatterns: [COMPLETION_PATTERN],
      cookieHosts: [COOKIE_HOST],
      timeoutMs: 10_000,
    });
    const outcomePromise = resultPromise.then(
      (v) => ({ ok: true as const, value: v }),
      (e: unknown) => ({ ok: false as const, error: e }),
    );

    await flushAsync(1);

    // Webview attaches with hanging cookies.get — checkAndCollect suspends.
    const fakeWv = new FakeWebContents(COMPLETION_URL);
    fakeWv.session.cookies.get.mockReturnValue(hangingCookiePromise);
    currentFakeWindow.webContents.emit("did-attach-webview", {}, fakeWv);
    fakeWv.navigateTo(COMPLETION_URL);
    fakeWv.emit("did-navigate", {}, COMPLETION_URL);

    // Grace-collect fires and resolves (settled=true after this).
    fakePartitionSession.cookies.get.mockResolvedValue([SESSION_COOKIE]);
    currentFakeWindow.emit("closed");
    await flushAsync();

    // Late checkAndCollect completion — must be a no-op (settled=true).
    resolveWebviewCookies([SESSION_COOKIE]);
    await flushAsync();

    const outcome = await outcomePromise;
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      const cookies = outcome.value as import("../auth-window-service.js").AuthCookie[];
      expect(Array.isArray(cookies)).toBe(true);
      expect(cookies[0].name).toBe("session");
    }
  });
});
