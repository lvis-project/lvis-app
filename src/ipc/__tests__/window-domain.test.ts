import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent, WebContents } from "electron";

const handleMap = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
const fromWebContents = vi.fn();

vi.mock("electron", () => ({
  BrowserWindow: {
    fromWebContents,
  },
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
});
