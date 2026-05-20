import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent, WebContents } from "electron";

const handleMap = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
const fromWebContents = vi.fn();
const browserWindowInstances: Array<{
  id: number;
  options: Record<string, unknown>;
  webContents: {
    setWindowOpenHandler: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
  };
  setMenu: ReturnType<typeof vi.fn>;
  loadURL: ReturnType<typeof vi.fn>;
  show: ReturnType<typeof vi.fn>;
  isDestroyed: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}> = [];
const BrowserWindowMock = vi.fn(function BrowserWindowMock(this: (typeof browserWindowInstances)[number], options: Record<string, unknown>) {
  Object.assign(this, {
    id: 100 + browserWindowInstances.length,
    options,
    webContents: {
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
    },
    setMenu: vi.fn(),
    loadURL: vi.fn(async () => undefined),
    show: vi.fn(),
    isDestroyed: vi.fn(() => false),
    close: vi.fn(),
  });
  browserWindowInstances.push(this);
});
(BrowserWindowMock as unknown as { fromWebContents: typeof fromWebContents }).fromWebContents = fromWebContents;

vi.mock("electron", () => ({
  BrowserWindow: BrowserWindowMock,
  ipcMain: {
    handle: vi.fn((channel: string, fn: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => {
      handleMap.set(channel, fn);
    }),
  },
}));

function trustedEvent(sender: object = {}): IpcMainInvokeEvent {
  return {
    senderFrame: { url: "file:///Applications/Lvis.app/dist/index.html" },
    sender,
  } as unknown as IpcMainInvokeEvent;
}

function untrustedEvent(sender: object = {}): IpcMainInvokeEvent {
  return {
    senderFrame: { url: "https://evil.example/index.html" },
    sender,
  } as unknown as IpcMainInvokeEvent;
}

function dataShellEvent(sender: object): IpcMainInvokeEvent {
  return {
    senderFrame: { url: "data:text/html;charset=utf-8,%3Chtml%3E%3C/html%3E" },
    sender,
  } as unknown as IpcMainInvokeEvent;
}

function makeWindow(overrides?: Record<string, unknown>) {
  return {
    minimize: vi.fn(),
    maximize: vi.fn(),
    unmaximize: vi.fn(),
    close: vi.fn(),
    isMaximized: vi.fn(() => false),
    setTitleBarOverlay: vi.fn(),
    ...overrides,
  };
}

describe("window domain IPC", () => {
  let registerWindowHandlers: typeof import("../domains/window.js").registerWindowHandlers;
  let mainWindow: ReturnType<typeof makeWindow>;

  beforeEach(async () => {
    handleMap.clear();
    fromWebContents.mockReset();
    BrowserWindowMock.mockClear();
    browserWindowInstances.length = 0;
    vi.resetModules();
    ({ registerWindowHandlers } = await import("../domains/window.js?t=" + Date.now()));
    mainWindow = makeWindow();
    registerWindowHandlers({
      auditLogger: { log: vi.fn() },
      getMainWindow: () => mainWindow,
    } as never);
  });

  it("closes the sender BrowserWindow instead of always closing the main window", async () => {
    const detachedWindow = makeWindow();
    fromWebContents.mockReturnValueOnce(detachedWindow);

    await handleMap.get("window:close")!(trustedEvent({ id: "detached-webcontents" }));

    expect(detachedWindow.close).toHaveBeenCalledOnce();
    expect(mainWindow.close).not.toHaveBeenCalled();
  });

  it("does not close the main window when sender BrowserWindow cannot be resolved", async () => {
    fromWebContents.mockReturnValueOnce(null);

    await handleMap.get("window:close")!(trustedEvent());

    expect(mainWindow.close).not.toHaveBeenCalled();
  });

  it("targets minimize and maximize at the sender window", async () => {
    const detachedWindow = makeWindow();
    fromWebContents.mockReturnValue(detachedWindow);

    await handleMap.get("window:minimize")!(trustedEvent());
    await handleMap.get("window:toggleMaximize")!(trustedEvent());

    expect(detachedWindow.minimize).toHaveBeenCalledOnce();
    expect(detachedWindow.maximize).toHaveBeenCalledOnce();
    expect(mainWindow.minimize).not.toHaveBeenCalled();
    expect(mainWindow.maximize).not.toHaveBeenCalled();
  });

  it("allows explicitly marked data-url shells to control their own window", async () => {
    const { markAsWindowControlOwned } = await import("../window-control-registry.js");
    const shellContents = { id: 42, once: vi.fn() } as unknown as WebContents;
    const shellWindow = makeWindow();
    markAsWindowControlOwned(shellContents);
    fromWebContents.mockReturnValueOnce(shellWindow);

    await handleMap.get("window:close")!(dataShellEvent(shellContents));

    expect(shellWindow.close).toHaveBeenCalledOnce();
    expect(mainWindow.close).not.toHaveBeenCalled();
  });

  it("ignores titlebar theme sync when overlay is disabled", async () => {
    const win = makeWindow({
      setTitleBarOverlay: vi.fn(() => {
        throw new TypeError("Titlebar overlay is not enabled");
      }),
    });
    fromWebContents.mockReturnValueOnce(win);

    expect(() =>
      handleMap.get("window:syncTitleBarTheme")!(
        trustedEvent(),
        { color: "#ffffff", symbolColor: "#111111" },
      ),
    ).not.toThrow();
  });

  it("opens render_html payloads in a sandboxed BrowserWindow", async () => {
    const result = await handleMap.get("lvis:window:open-html-preview")!(
      trustedEvent(),
      {
        html: "<main><h1>hello</h1></main>",
        title: "Preview",
        height: 320,
        allowScripts: true,
      },
    );

    expect(result).toEqual({ ok: true, windowId: 100 });
    expect(BrowserWindowMock).toHaveBeenCalledWith(expect.objectContaining({
      title: "Preview",
      show: false,
      webPreferences: expect.objectContaining({
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        webviewTag: false,
        javascript: true,
        partition: "lvis-render-html",
      }),
    }));
    const win = browserWindowInstances[0]!;
    expect(win.setMenu).toHaveBeenCalledWith(null);
    expect(win.webContents.setWindowOpenHandler).toHaveBeenCalledOnce();
    expect(win.webContents.on).toHaveBeenCalledWith("will-attach-webview", expect.any(Function));
    expect(win.webContents.on).toHaveBeenCalledWith("will-navigate", expect.any(Function));
    expect(win.loadURL).toHaveBeenCalledWith(expect.stringMatching(/^data:text\/html;charset=utf-8,/));
    const dataUrl = win.loadURL.mock.calls[0]![0] as string;
    const html = decodeURIComponent(dataUrl.slice("data:text/html;charset=utf-8,".length));
    expect(html).toContain("Content-Security-Policy");
    expect(html).toContain("frame-ancestors");
    expect(html).toMatch(/^<!doctype html><html><head><meta http-equiv="Content-Security-Policy"/);
    expect(html).toContain("<main><h1>hello</h1></main>");
    expect(win.show).toHaveBeenCalledOnce();
  });

  it("places CSP before malformed render_html body content", async () => {
    await handleMap.get("lvis:window:open-html-preview")!(
      trustedEvent(),
      {
        html: "<script>window.beforeCsp = true</script><head><title>Late head</title></head>",
      },
    );

    const win = browserWindowInstances[0]!;
    const dataUrl = win.loadURL.mock.calls[0]![0] as string;
    const html = decodeURIComponent(dataUrl.slice("data:text/html;charset=utf-8,".length));
    expect(html).toMatch(/^<!doctype html><html><head><meta http-equiv="Content-Security-Policy"/);
    expect(html.indexOf("Content-Security-Policy")).toBeLessThan(html.indexOf("window.beforeCsp"));
  });

  it("rejects untrusted render_html window senders", async () => {
    const result = await handleMap.get("lvis:window:open-html-preview")!(
      untrustedEvent(),
      { html: "<p>blocked</p>" },
    );

    expect(result).toEqual({ ok: false, error: "unauthorized-frame" });
    expect(BrowserWindowMock).not.toHaveBeenCalled();
  });
});
