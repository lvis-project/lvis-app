/**
 * openAuthWindow idempotency guard (EP double-login-window fix).
 *
 * A single VISIBLE auth window per (partition, title): a second concurrent call
 * for the same key focuses + awaits the in-flight window instead of spawning a
 * duplicate BrowserWindow. `show:false` silent warmups are exempt.
 *
 * MUTATION CONTRACT: reverting the dedup guard makes the "twice → ONE window"
 * assertion fail (two BrowserWindows constructed). Reverting the show:false
 * exemption makes the warmup test fail (warmup reuses the visible window).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Cookie } from "electron";

class FakeEmitter {
  private _listeners = new Map<string, Array<(...a: unknown[]) => void>>();
  on(event: string, listener: (...a: unknown[]) => void): this {
    const list = this._listeners.get(event) ?? [];
    list.push(listener);
    this._listeners.set(event, list);
    return this;
  }
  off(event: string, listener: (...a: unknown[]) => void): this {
    const list = this._listeners.get(event) ?? [];
    this._listeners.set(event, list.filter((l) => l !== listener));
    return this;
  }
  emit(event: string, ...args: unknown[]): boolean {
    const list = [...(this._listeners.get(event) ?? [])];
    for (const l of list) l(...args);
    return list.length > 0;
  }
}

class FakeWebContents extends FakeEmitter {
  public session = { cookies: { get: vi.fn().mockResolvedValue([]) } };
  public isDestroyed = vi.fn(() => false);
  public setWindowOpenHandler = vi.fn();
  public openDevTools = vi.fn();
  public executeJavaScript = vi.fn().mockResolvedValue(undefined);
  private _url = "about:blank";
  getURL(): string { return this._url; }
}

class FakeBrowserWindow extends FakeEmitter {
  public webContents = new FakeWebContents();
  private _destroyed = false;
  private _minimized = false;
  public setMenu = vi.fn();
  public isDestroyed = vi.fn(() => this._destroyed);
  public isMinimized = vi.fn(() => this._minimized);
  public restore = vi.fn(() => { this._minimized = false; });
  public focus = vi.fn();
  public getBounds = vi.fn(() => ({ x: 0, y: 0, width: 1024, height: 768 }));
  public setPosition = vi.fn();
  public loadURL = vi.fn().mockResolvedValue(undefined);
  public close = vi.fn(() => {
    if (!this._destroyed) { this._destroyed = true; this.emit("closed"); }
  });
}

let constructed: FakeBrowserWindow[] = [];

vi.mock("electron", () => {
  function MockBrowserWindow(_opts: unknown) {
    const win = new FakeBrowserWindow();
    constructed.push(win);
    return win;
  }
  return {
    BrowserWindow: MockBrowserWindow,
    screen: {
      getPrimaryDisplay: vi.fn(() => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } })),
    },
    session: { fromPartition: vi.fn().mockReturnValue({ cookies: { get: vi.fn().mockResolvedValue([]) } }) },
    shell: { openExternal: vi.fn() },
    app: {},
    ipcMain: {},
  };
});

vi.mock("../window-chrome.js", () => ({ getCommonChromeOptions: vi.fn(() => ({})) }));
vi.mock("../../ipc/domains/window.js", () => ({ registerWindowEventListeners: vi.fn() }));
vi.mock("../../ipc/window-control-registry.js", () => ({ markAsWindowControlOwned: vi.fn() }));
vi.mock("../auth-window-registry.js", () => ({ markAsAuthOwned: vi.fn() }));
vi.mock("../window-titlebar-shell.js", () => ({
  buildTitlebarCss: vi.fn(() => ""),
  buildTitlebarHtml: vi.fn(() => ""),
  buildTitlebarButtonScript: vi.fn(() => ""),
}));
vi.mock("../app-icon.js", () => ({ resolveAppIconPath: vi.fn(() => undefined) }));
vi.mock("../../lib/logger.js", () => ({
  createLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
}));

const { openAuthWindow, wirePluginAuthPartitionPersistence } = await import("../auth-window-service.js");

wirePluginAuthPartitionPersistence({
  write: vi.fn().mockResolvedValue(undefined),
  delete: vi.fn().mockResolvedValue(undefined),
  onError: vi.fn(),
});

const PARTITION = "persist:plugin-auth:lge-api";
const COMPLETION = "portal.example.com/auth/callback";
const COOKIE_HOST = "portal.example.com";

async function flush(rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setTimeout(r, 0));
}

function parent(): import("electron").BrowserWindow {
  return new FakeBrowserWindow() as unknown as import("electron").BrowserWindow;
}

beforeEach(() => {
  constructed = [];
});

describe("openAuthWindow — visible-window dedup", () => {
  it("opening twice for the same partition+title creates ONE window and focuses the existing one", async () => {
    const p = parent();
    const opts = {
      url: "https://sso.example.com/login",
      completionUrlPatterns: [COMPLETION],
      cookieHosts: [COOKIE_HOST],
      windowTitle: "LGE Login",
      persistPartition: PARTITION,
      timeoutMs: 10_000,
    };

    const first = openAuthWindow(p, opts);
    const firstOutcome = first.then((v) => ({ ok: true as const, v }), (e) => ({ ok: false as const, e }));
    await flush(1);
    // The parent window itself was constructed; the FIRST auth window is the
    // most recent construction after that.
    const authWindowsAfterFirst = constructed.filter((w) => w !== (p as unknown as FakeBrowserWindow));
    expect(authWindowsAfterFirst).toHaveLength(1);
    const firstWindow = authWindowsAfterFirst[0];

    // Second concurrent call for the SAME key — must NOT spawn a new window.
    const second = openAuthWindow(p, opts);
    const secondOutcome = second.then((v) => ({ ok: true as const, v }), (e) => ({ ok: false as const, e }));
    await flush(1);

    const authWindowsAfterSecond = constructed.filter((w) => w !== (p as unknown as FakeBrowserWindow));
    expect(authWindowsAfterSecond).toHaveLength(1); // still only ONE auth window
    expect(firstWindow.focus).toHaveBeenCalledTimes(1); // existing window focused

    // Both calls share the same in-flight promise; settle by closing the window.
    firstWindow.close();
    await flush(2);
    const r1 = await firstOutcome;
    const r2 = await secondOutcome;
    expect(r1.ok).toBe(false); // closed-before-completion reject (shared outcome)
    expect(r2.ok).toBe(false);
  });

  it("a show:false silent warmup is exempt — it does NOT reuse the visible window", async () => {
    const p = parent();
    const visible = openAuthWindow(p, {
      url: "https://sso.example.com/login",
      completionUrlPatterns: [COMPLETION],
      cookieHosts: [COOKIE_HOST],
      windowTitle: "LGE Login",
      persistPartition: PARTITION,
      timeoutMs: 10_000,
    });
    const visibleOutcome = visible.then((v) => ({ ok: true as const, v }), (e) => ({ ok: false as const, e }));
    await flush(1);
    const beforeWarmup = constructed.filter((w) => w !== (p as unknown as FakeBrowserWindow)).length;
    expect(beforeWarmup).toBe(1);

    // Silent warmup (show:false) for the SAME key — must construct its OWN window.
    const warmup = openAuthWindow(p, {
      url: "https://sso.example.com/login",
      completionUrlPatterns: [COMPLETION],
      cookieHosts: [COOKIE_HOST],
      windowTitle: "LGE Login",
      persistPartition: PARTITION,
      show: false,
      timeoutMs: 5_000,
    });
    const warmupOutcome = warmup.then((v) => ({ ok: true as const, v }), (e) => ({ ok: false as const, e }));
    await flush(1);

    const afterWarmup = constructed.filter((w) => w !== (p as unknown as FakeBrowserWindow)).length;
    expect(afterWarmup).toBe(2); // warmup got its own window, not the visible one

    // Settle both — close every constructed auth window.
    for (const w of constructed) w.close();
    await flush(2);
    await visibleOutcome;
    await warmupOutcome;
  });
});
