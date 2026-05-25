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
 * mutual-exclusion guard and the closed handler ordering.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { Cookie } from "electron";

// ---------------------------------------------------------------------------
// Flush async microtasks/macrotasks without relying on vi.runAllMicrotasksAsync
// (not available in vitest 4.x). Using setTimeout(0) flushes the Promise queue
// reliably in node environments.
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
  public close = vi.fn(() => {
    if (!this._destroyed) {
      this._destroyed = true;
      this.emit("closed");
    }
  });

  constructor(cookiesForSession: Cookie[] = []) {
    super();
    this.webContents = new FakeWebContents("about:blank", cookiesForSession);
  }
}

// ---------------------------------------------------------------------------
// Module-level state — the active FakeBrowserWindow created per openAuthWindow
// call. Populated by the BrowserWindow constructor mock.
// ---------------------------------------------------------------------------
let currentFakeWindow: FakeBrowserWindow;

// Shared partition session (used by session.fromPartition in grace-collect).
const fakePartitionSession = {
  cookies: { get: vi.fn() },
};

// ---------------------------------------------------------------------------
// Module mocks — must be registered before any import of the service.
//
// BrowserWindow uses a real `function` (not arrow) so it can be called with
// `new`. The mock implementation records the created FakeBrowserWindow in
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

// A minimal stand-in for the parent BrowserWindow argument.
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
// 1. Fast-SSO race regression — the core issue #960 scenario.
//
// Sequence: did-attach-webview → did-navigate(completion URL) → closed
//
// The `settled` flag in checkAndCollect() marks the promise settled BEFORE
// the `closed` handler runs. If the guard is absent (or the listener order
// is reversed in a refactor), `closed` fires first and false-rejects.
// ---------------------------------------------------------------------------
describe("openAuthWindow — fast-SSO race regression (issue #960)", () => {
  it("resolves with cookies when closed fires immediately after did-navigate to a completion URL", async () => {
    const parent = makeParentWindow() as unknown as import("electron").BrowserWindow;

    const resultPromise = openAuthWindow(parent, {
      url: "https://sso.example.com/login",
      completionUrlPatterns: [COMPLETION_PATTERN],
      cookieHosts: [COOKIE_HOST],
      timeoutMs: 10_000,
    });

    // Let loadURL + initial promise chain settle.
    await flushAsync();

    // Simulate: webview attaches.
    const fakeWv = new FakeWebContents(COMPLETION_URL, [SESSION_COOKIE]);
    fakeWv.session.cookies.get.mockResolvedValue([SESSION_COOKIE]);
    currentFakeWindow.webContents.emit("did-attach-webview", {}, fakeWv);

    // Simulate: webview navigates to completion URL (top-level committed nav).
    fakeWv.navigateTo(COMPLETION_URL);
    fakeWv.emit("did-navigate", {}, COMPLETION_URL);

    // Flush the async checkAndCollect (cookies.get is a Promise).
    await flushAsync();

    // Simulate: window closes IMMEDIATELY after — the fast-SSO race.
    // If the settled guard is broken, the closed handler fires before
    // checkAndCollect and false-rejects with "window closed before login".
    currentFakeWindow.emit("closed");

    await flushAsync();

    // The promise MUST resolve with cookies, not reject.
    const result = await resultPromise;
    expect(Array.isArray(result)).toBe(true);
    const cookies = result as import("../auth-window-service.js").AuthCookie[];
    expect(cookies.length).toBeGreaterThan(0);
    expect(cookies[0].name).toBe("session");
    expect(cookies[0].value).toBe("abc123");
  });

  it("resolves with OpenAuthWindowResult envelope when returnFinalUrl is true", async () => {
    const parent = makeParentWindow() as unknown as import("electron").BrowserWindow;

    const resultPromise = openAuthWindow(parent, {
      url: "https://sso.example.com/login",
      completionUrlPatterns: [COMPLETION_PATTERN],
      cookieHosts: [COOKIE_HOST],
      timeoutMs: 10_000,
      returnFinalUrl: true,
    });

    await flushAsync();

    const fakeWv = new FakeWebContents(COMPLETION_URL, [SESSION_COOKIE]);
    fakeWv.session.cookies.get.mockResolvedValue([SESSION_COOKIE]);
    currentFakeWindow.webContents.emit("did-attach-webview", {}, fakeWv);
    fakeWv.navigateTo(COMPLETION_URL);
    fakeWv.emit("did-navigate", {}, COMPLETION_URL);

    await flushAsync();
    currentFakeWindow.emit("closed");
    await flushAsync();

    const result = await resultPromise;
    // Must return the {cookies, finalUrl} envelope, not a plain array.
    expect(result).toHaveProperty("cookies");
    expect(result).toHaveProperty("finalUrl");
    const envelope = result as import("../auth-window-service.js").OpenAuthWindowResult;
    expect(envelope.finalUrl).toBe(COMPLETION_URL);
    expect(envelope.cookies[0].name).toBe("session");
  });
});

// ---------------------------------------------------------------------------
// 2. Grace-collect path (closed fires BEFORE checkAndCollect resolves).
//
// This covers the scenario where the window close event arrives while
// checkAndCollect is still awaiting cookies.get — the closed handler's
// grace-collect logic then reads from session.fromPartition and resolves.
// ---------------------------------------------------------------------------
describe("openAuthWindow — grace-collect path (closed fires before checkAndCollect)", () => {
  it("resolves via grace-collect when window closes while webview cookie fetch is in flight", async () => {
    const parent = makeParentWindow() as unknown as import("electron").BrowserWindow;

    // Hang the webview-level cookies.get so checkAndCollect never settles.
    // The grace-collect path (session.fromPartition) must pick it up.
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

    const fakeWv = new FakeWebContents(COMPLETION_URL, []);
    // Webview cookies.get hangs indefinitely — simulates the race condition.
    fakeWv.session.cookies.get.mockReturnValue(hangingCookiePromise);
    currentFakeWindow.webContents.emit("did-attach-webview", {}, fakeWv);
    fakeWv.navigateTo(COMPLETION_URL);
    fakeWv.emit("did-navigate", {}, COMPLETION_URL);

    // Don't flush — checkAndCollect is stuck. Close the window now so the
    // grace-collect path in the `closed` handler fires.
    fakePartitionSession.cookies.get.mockResolvedValue([SESSION_COOKIE]);
    currentFakeWindow.emit("closed");

    // Allow the webview's pending cookie promise to resolve (should be ignored
    // since settled is already true from grace-collect).
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
    // Attach rejection handler immediately so it is never "unhandled".
    const caught = resultPromise.catch((e: unknown) => e);

    await flushAsync();

    // Window closes without webview ever attaching.
    currentFakeWindow.emit("closed");
    await flushAsync();

    const err = await caught;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("window closed before login completed");
  });

  it("rejects when window closes after webview attach but before navigating to a completion URL", async () => {
    const parent = makeParentWindow() as unknown as import("electron").BrowserWindow;

    const resultPromise = openAuthWindow(parent, {
      url: "https://sso.example.com/login",
      completionUrlPatterns: [COMPLETION_PATTERN],
      cookieHosts: [COOKIE_HOST],
      timeoutMs: 10_000,
    });
    // Attach rejection handler immediately so it is never "unhandled".
    const caught = resultPromise.catch((e: unknown) => e);

    await flushAsync();

    // Webview attaches but only navigates to the SSO login page (not completion).
    const fakeWv = new FakeWebContents("https://sso.example.com/login", []);
    currentFakeWindow.webContents.emit("did-attach-webview", {}, fakeWv);
    fakeWv.emit("did-navigate", {}, "https://sso.example.com/login");

    await flushAsync();

    // User dismisses the window without completing login.
    currentFakeWindow.emit("closed");
    await flushAsync();

    // Grace-collect predicate: webviewAttached=true but lastCommittedUrl does
    // not match completionPatterns — must still reject.
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
    // Attach rejection handler immediately so it is never "unhandled".
    const caught = resultPromise.catch((e: unknown) => e);

    await flushAsync();

    // Webview reaches completion URL but both cookie paths fail.
    const fakeWv = new FakeWebContents(COMPLETION_URL, []);
    fakeWv.session.cookies.get.mockRejectedValue(new Error("webview session destroyed"));
    currentFakeWindow.webContents.emit("did-attach-webview", {}, fakeWv);
    fakeWv.navigateTo(COMPLETION_URL);
    fakeWv.emit("did-navigate", {}, COMPLETION_URL);

    // Partition session (grace-collect) also fails.
    fakePartitionSession.cookies.get.mockRejectedValue(new Error("partition gone"));

    await flushAsync();
    currentFakeWindow.emit("closed");
    await flushAsync();

    // The error must propagate — grace failure must not be silently swallowed.
    const err = await caught;
    expect(err).toBeInstanceOf(Error);
  });
});

// ---------------------------------------------------------------------------
// 3. Settled guard — only one outcome (resolve XOR reject) fires, never both.
// ---------------------------------------------------------------------------
describe("openAuthWindow — settled/finish() mutual-exclusion guard", () => {
  it("does not produce a second resolution when closed fires after did-navigate already settled the promise", async () => {
    const parent = makeParentWindow() as unknown as import("electron").BrowserWindow;

    let resolveCount = 0;
    let rejectCount = 0;

    const resultPromise = openAuthWindow(parent, {
      url: "https://sso.example.com/login",
      completionUrlPatterns: [COMPLETION_PATTERN],
      cookieHosts: [COOKIE_HOST],
      timeoutMs: 10_000,
    });

    // Attach then/catch counters before any events fire.
    resultPromise.then(() => { resolveCount++; }).catch(() => { rejectCount++; });

    await flushAsync();

    const fakeWv = new FakeWebContents(COMPLETION_URL, [SESSION_COOKIE]);
    fakeWv.session.cookies.get.mockResolvedValue([SESSION_COOKIE]);
    currentFakeWindow.webContents.emit("did-attach-webview", {}, fakeWv);
    fakeWv.navigateTo(COMPLETION_URL);
    fakeWv.emit("did-navigate", {}, COMPLETION_URL);

    await flushAsync();

    // Fire both closed AND a second did-navigate — settled must block all
    // subsequent finish() calls.
    currentFakeWindow.emit("closed");
    fakeWv.emit("did-navigate", {}, COMPLETION_URL);

    await flushAsync();

    await resultPromise;

    expect(resolveCount).toBe(1);
    expect(rejectCount).toBe(0);
  });
});
