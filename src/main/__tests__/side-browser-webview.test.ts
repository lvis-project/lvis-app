import { describe, expect, it, vi } from "vitest";
import { LVIS_SIDE_BROWSER_PARTITION } from "../../shared/side-browser.js";

const electronMock = vi.hoisted(() => {
  const sideBrowserSession = {
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    on: vi.fn(),
  };
  const otherSession = {};
  return { sideBrowserSession, otherSession };
});

vi.mock("electron", () => ({
  session: {
    fromPartition: vi.fn((partition: string) =>
      partition === "persist:lvis-side-browser" ? electronMock.sideBrowserSession : electronMock.otherSession
    ),
  },
}));

const {
  configureSideBrowserWebviewAttach,
  installSideBrowserPartitionPolicy,
  isSideBrowserContents,
  takePendingSideBrowserSrc,
} = await import("../side-browser-webview.js");

function event() {
  return { preventDefault: vi.fn() };
}

describe("side browser webview attach policy", () => {
  it("accepts http(s) side-browser webviews and forces isolated JS-capable preferences", () => {
    const attachEvent = event();
    const prefs: Record<string, unknown> = {
      preload: "evil.js",
      nodeIntegration: true,
      sandbox: false,
    };
    const enqueueAllowedSrc = vi.fn();

    const result = configureSideBrowserWebviewAttach({
      event: attachEvent,
      webPreferences: prefs,
      params: {
        partition: LVIS_SIDE_BROWSER_PARTITION,
        src: "https://example.com/docs",
      },
      enqueueAllowedSrc,
    });

    expect(result).toBe("accepted");
    expect(attachEvent.preventDefault).not.toHaveBeenCalled();
    expect(enqueueAllowedSrc).toHaveBeenCalledWith("https://example.com/docs");
    expect(prefs.preload).toBeUndefined();
    expect(prefs.nodeIntegration).toBe(false);
    expect(prefs.contextIsolation).toBe(true);
    expect(prefs.sandbox).toBe(true);
    expect(prefs.javascript).toBe(true);
    expect(prefs.partition).toBe(LVIS_SIDE_BROWSER_PARTITION);
  });

  it("blocks non-http side-browser navigations", () => {
    const attachEvent = event();
    const enqueueAllowedSrc = vi.fn();

    const result = configureSideBrowserWebviewAttach({
      event: attachEvent,
      webPreferences: {},
      params: {
        partition: LVIS_SIDE_BROWSER_PARTITION,
        src: "javascript:alert(1)",
      },
      enqueueAllowedSrc,
    });

    expect(result).toBe("blocked");
    expect(attachEvent.preventDefault).toHaveBeenCalledOnce();
    expect(enqueueAllowedSrc).not.toHaveBeenCalled();
  });

  it("blocks credentialed side-browser URLs", () => {
    const attachEvent = event();
    const enqueueAllowedSrc = vi.fn();

    const result = configureSideBrowserWebviewAttach({
      event: attachEvent,
      webPreferences: {},
      params: {
        partition: LVIS_SIDE_BROWSER_PARTITION,
        src: "https://user:pass@example.com/docs",
      },
      enqueueAllowedSrc,
    });

    expect(result).toBe("blocked");
    expect(attachEvent.preventDefault).toHaveBeenCalledOnce();
    expect(enqueueAllowedSrc).not.toHaveBeenCalled();
  });

  it("ignores unrelated webviews", () => {
    const attachEvent = event();
    const prefs: Record<string, unknown> = { nodeIntegration: true };
    const enqueueAllowedSrc = vi.fn();

    const result = configureSideBrowserWebviewAttach({
      event: attachEvent,
      webPreferences: prefs,
      params: {
        partition: "lvis-mcp-app",
        src: "data:text/html,ok",
      },
      enqueueAllowedSrc,
    });

    expect(result).toBe("ignored");
    expect(attachEvent.preventDefault).not.toHaveBeenCalled();
    expect(enqueueAllowedSrc).not.toHaveBeenCalled();
    expect(prefs.nodeIntegration).toBe(true);
  });

  it("matches attached guests by URL instead of blindly shifting the pending queue", () => {
    const pending = ["https://example.com/docs", "https://google.com/"];

    expect(takePendingSideBrowserSrc(pending, "https://unrelated.example/")).toBeNull();
    expect(pending).toEqual(["https://example.com/docs", "https://google.com/"]);
    expect(takePendingSideBrowserSrc(pending, "https://google.com/")).toBe("https://google.com/");
    expect(pending).toEqual(["https://example.com/docs"]);
  });

  it("installs a deny-by-default permission and download policy for the side-browser partition", () => {
    installSideBrowserPartitionPolicy();

    expect(electronMock.sideBrowserSession.setPermissionRequestHandler).toHaveBeenCalledOnce();
    expect(electronMock.sideBrowserSession.setPermissionCheckHandler).toHaveBeenCalledWith(expect.any(Function));
    expect(electronMock.sideBrowserSession.on).toHaveBeenCalledWith("will-download", expect.any(Function));

    const permissionCallback = vi.fn();
    const requestHandler = electronMock.sideBrowserSession.setPermissionRequestHandler.mock.calls[0]?.[0] as
      | ((webContents: unknown, permission: string, callback: (allowed: boolean) => void) => void)
      | undefined;
    requestHandler?.({}, "media", permissionCallback);
    expect(permissionCallback).toHaveBeenCalledWith(false);

    const checkHandler = electronMock.sideBrowserSession.setPermissionCheckHandler.mock.calls[0]?.[0] as
      | (() => boolean)
      | undefined;
    expect(checkHandler?.()).toBe(false);

    const downloadEvent = { preventDefault: vi.fn() };
    const downloadHandler = electronMock.sideBrowserSession.on.mock.calls.find((call) => call[0] === "will-download")?.[1] as
      | ((event: { preventDefault: () => void }) => void)
      | undefined;
    downloadHandler?.(downloadEvent);
    expect(downloadEvent.preventDefault).toHaveBeenCalledOnce();
  });

  it("verifies attached webContents by session before link-owned registration", () => {
    expect(isSideBrowserContents({ session: electronMock.sideBrowserSession } as never)).toBe(true);
    expect(isSideBrowserContents({ session: electronMock.otherSession } as never)).toBe(false);
  });
});
