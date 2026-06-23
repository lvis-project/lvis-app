/**
 * Security regression tests for WindowManager IPC handlers.
 *
 * Guards:
 *   1. validateSender — unauthorized sender → UNAUTHORIZED_FRAME + auditLogger call
 *   2. viewKey allowlist — path-traversal / invalid keys → invalid-view-key error
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { IpcMainInvokeEvent } from "electron";

// ── Electron mock ──────────────────────────────────────────────────────────

const handleMap = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
const listenerMap = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
const fromId = vi.hoisted(() => vi.fn());

vi.mock("electron", () => ({
  BrowserWindow: {
    fromWebContents: vi.fn(() => null),
    fromId,
  },
  ipcMain: {
    handle: vi.fn((channel: string, fn: (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown) => {
      handleMap.set(channel, fn);
    }),
    on: vi.fn((channel: string, fn: (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown) => {
      listenerMap.set(channel, fn);
    }),
    removeListener: vi.fn((channel: string, fn: (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown) => {
      if (listenerMap.get(channel) === fn) listenerMap.delete(channel);
    }),
  },
  screen: {
    getAllDisplays: vi.fn(() => []),
    getPrimaryDisplay: vi.fn(() => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } })),
  },
}));

// ── Module imports (after mock) ────────────────────────────────────────────

import { ALLOWED_VIEW_KEYS } from "../main/window-manager.js";
import { UNAUTHORIZED_FRAME } from "../ipc-bridge.js";

// ── Helpers ────────────────────────────────────────────────────────────────

/** Build an event with an unauthorized (remote) sender frame. */
function unauthorizedEvent(): IpcMainInvokeEvent {
  return {
    senderFrame: { url: "https://evil.example.com/pwn" },
    sender: {},
  } as unknown as IpcMainInvokeEvent;
}

/** Build an event with a trusted file:// sender frame. */
function trustedEvent(): IpcMainInvokeEvent {
  return {
    senderFrame: { url: "file:///Applications/Lvis.app/dist/index.html" },
    sender: {},
  } as unknown as IpcMainInvokeEvent;
}

/** Minimal AuditLogger mock. */
function makeAuditLogger() {
  return { log: vi.fn() };
}

// ── ALLOWED_VIEW_KEYS regex ────────────────────────────────────────────────

describe("ALLOWED_VIEW_KEYS", () => {
  it("accepts built-in view keys", () => {
    for (const key of ["reminders", "routines", "memory", "starred"]) {
      expect(ALLOWED_VIEW_KEYS.test(key)).toBe(true);
    }
  });

  it("rejects 'tasks' (removed from allowlist)", () => {
    expect(ALLOWED_VIEW_KEYS.test("tasks")).toBe(false);
  });

  it("accepts valid plugin view keys (pluginId:extensionId format)", () => {
    // toViewKey() produces plugin:<pluginId>:<extensionId>
    expect(ALLOWED_VIEW_KEYS.test("plugin:meeting:meeting-control")).toBe(true);
    expect(ALLOWED_VIEW_KEYS.test("plugin:my-plugin:main-view")).toBe(true);
    expect(ALLOWED_VIEW_KEYS.test("plugin:my_plugin.v2:panel_a")).toBe(true);
  });

  it("rejects single-segment plugin keys (missing extensionId)", () => {
    expect(ALLOWED_VIEW_KEYS.test("plugin:my-plugin")).toBe(false);
    expect(ALLOWED_VIEW_KEYS.test("plugin:meeting")).toBe(false);
  });

  it("rejects path traversal attempts", () => {
    expect(ALLOWED_VIEW_KEYS.test("../etc/passwd")).toBe(false);
    expect(ALLOWED_VIEW_KEYS.test("../../etc/shadow")).toBe(false);
    expect(ALLOWED_VIEW_KEYS.test("plugin:../evil")).toBe(false);
  });

  it("rejects arbitrary strings", () => {
    expect(ALLOWED_VIEW_KEYS.test("unknown-view")).toBe(false);
    expect(ALLOWED_VIEW_KEYS.test("")).toBe(false);
    expect(ALLOWED_VIEW_KEYS.test("TASKS")).toBe(false);
  });
});

// ── IPC handler security ───────────────────────────────────────────────────

describe("WindowManager IPC — validateSender guard", () => {
  let WindowManager: typeof import("../main/window-manager.js").WindowManager;
  let auditLogger: ReturnType<typeof makeAuditLogger>;
  let wm: InstanceType<typeof WindowManager>;

  beforeEach(async () => {
    handleMap.clear();
    listenerMap.clear();
    fromId.mockReset();
    vi.resetModules();
    // Re-import so handleMap gets freshly registered handlers
    const mod = await import("../main/window-manager.js?t=" + Date.now());
    WindowManager = mod.WindowManager;
    auditLogger = makeAuditLogger();
    wm = new WindowManager({ preloadPath: "/fake/preload.cjs", distRoot: "/fake/dist" });
    wm.registerIpc(auditLogger as never);
  });

  describe("lvis:window:open-detached", () => {
    it("returns UNAUTHORIZED_FRAME and calls auditLogger for unauthorized sender", async () => {
      const handler = handleMap.get("lvis:window:open-detached")!;
      const result = await handler(unauthorizedEvent(), "tasks");
      expect(result).toEqual(UNAUTHORIZED_FRAME);
      expect(auditLogger.log).toHaveBeenCalledOnce();
    });

    it("returns invalid-view-key for path traversal viewKey", async () => {
      const handler = handleMap.get("lvis:window:open-detached")!;
      const result = await handler(trustedEvent(), "../etc/passwd");
      expect(result).toEqual({ ok: false, error: "invalid-view-key" });
    });

    it("returns invalid-view-key for empty viewKey", async () => {
      const handler = handleMap.get("lvis:window:open-detached")!;
      const result = await handler(trustedEvent(), "");
      expect(result).toEqual({ ok: false, error: "invalid-view-key" });
    });
  });

  describe("lvis:window:close-detached", () => {
    it("returns UNAUTHORIZED_FRAME and calls auditLogger for unauthorized sender", async () => {
      const handler = handleMap.get("lvis:window:close-detached")!;
      const result = await handler(unauthorizedEvent());
      expect(result).toEqual(UNAUTHORIZED_FRAME);
      expect(auditLogger.log).toHaveBeenCalledOnce();
    });
  });

  describe("lvis:window:list-detached", () => {
    it("returns UNAUTHORIZED_FRAME and calls auditLogger for unauthorized sender", async () => {
      const handler = handleMap.get("lvis:window:list-detached")!;
      const result = await handler(unauthorizedEvent());
      expect(result).toEqual(UNAUTHORIZED_FRAME);
      expect(auditLogger.log).toHaveBeenCalledOnce();
    });
  });

  describe("lvis:window:load-session-in-main", () => {
    it("forwards a valid session id to the registered main window and waits for renderer acknowledgement", async () => {
      const mainWebContents = { send: vi.fn() };
      const mainWindow = {
        id: 7,
        on: vi.fn(),
        isDestroyed: vi.fn(() => false),
        show: vi.fn(),
        focus: vi.fn(),
        webContents: mainWebContents,
      };
      wm.registerMainWindow(mainWindow as never);
      fromId.mockReturnValueOnce(mainWindow);

      const handler = handleMap.get("lvis:window:load-session-in-main")!;
      const resultPromise = Promise.resolve(handler(trustedEvent(), "sess_star-1"));

      expect(mainWindow.show).toHaveBeenCalledOnce();
      expect(mainWindow.focus).toHaveBeenCalledOnce();
      const sentPayload = mainWebContents.send.mock.calls[0]?.[1] as { sessionId: string; requestId: string };
      expect(mainWebContents.send).toHaveBeenCalledWith(
        "lvis:window:load-session-in-main",
        expect.objectContaining({ sessionId: "sess_star-1", requestId: expect.any(String) }),
      );
      const ack = listenerMap.get("lvis:window:load-session-in-main-result");
      expect(ack).toBeDefined();
      ack?.({ ...trustedEvent(), sender: mainWebContents } as never, {
        requestId: sentPayload.requestId,
        ok: true,
      });

      await expect(resultPromise).resolves.toEqual({ ok: true });
    });

    it("returns a failure when the main renderer rejects detached session loading", async () => {
      const mainWebContents = { send: vi.fn() };
      const mainWindow = {
        id: 7,
        on: vi.fn(),
        isDestroyed: vi.fn(() => false),
        show: vi.fn(),
        focus: vi.fn(),
        webContents: mainWebContents,
      };
      wm.registerMainWindow(mainWindow as never);
      fromId.mockReturnValueOnce(mainWindow);

      const handler = handleMap.get("lvis:window:load-session-in-main")!;
      const resultPromise = Promise.resolve(handler(trustedEvent(), "sess_star-1"));
      const sentPayload = mainWebContents.send.mock.calls[0]?.[1] as { requestId: string };
      listenerMap.get("lvis:window:load-session-in-main-result")?.(
        { ...trustedEvent(), sender: mainWebContents } as never,
        { requestId: sentPayload.requestId, ok: false, error: "load-session-failed" },
      );

      await expect(resultPromise).resolves.toEqual({ ok: false, error: "load-session-failed" });
    });

    it("rejects malformed session ids", async () => {
      const handler = handleMap.get("lvis:window:load-session-in-main")!;
      const result = await handler(trustedEvent(), "../session");
      expect(result).toEqual({ ok: false, error: "invalid-session-id" });
    });
  });

  describe("lvis:window:resize-for-mode", () => {
    // The resize now uses a manual easeOut tween (the native `setBounds`
    // animate flag is macOS-only). The mock window starts at bounds far from
    // any target so the tween runs; tests flush timers and assert the LAST
    // setBounds call lands EXACTLY on the target.
    function makeMainWindow() {
      let bounds = { x: 0, y: 0, width: 100, height: 100 };
      return {
        id: 7,
        on: vi.fn(),
        isDestroyed: vi.fn(() => false),
        getBounds: vi.fn(() => ({ ...bounds })),
        setBounds: vi.fn((b: { x: number; y: number; width: number; height: number }) => {
          bounds = { ...b };
        }),
        webContents: { send: vi.fn() },
      };
    }

    /** Drive the manual tween to completion. */
    function flushTween() {
      vi.runAllTimers();
    }

    /** Last bounds passed to setBounds (the final, exact landing point). */
    function lastBounds(main: ReturnType<typeof makeMainWindow>) {
      const calls = main.setBounds.mock.calls;
      return calls[calls.length - 1]?.[0] as {
        x: number; y: number; width: number; height: number;
      };
    }

    beforeEach(() => {
      // Fake timers so the ~16ms tween interval is deterministic and the
      // final-target landing can be flushed synchronously.
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
    });

    it("returns UNAUTHORIZED_FRAME and audits for unauthorized sender", async () => {
      const handler = handleMap.get("lvis:window:resize-for-mode")!;
      const result = await handler(unauthorizedEvent(), "action");
      expect(result).toEqual(UNAUTHORIZED_FRAME);
      expect(auditLogger.log).toHaveBeenCalledOnce();
    });

    it("rejects an invalid mode", async () => {
      const main = makeMainWindow();
      wm.registerMainWindow(main as never);
      fromId.mockReturnValue(main);
      const handler = handleMap.get("lvis:window:resize-for-mode")!;
      const result = await handler(trustedEvent(), "fullscreen");
      expect(result).toEqual({ ok: false, error: "invalid-mode" });
      expect(main.setBounds).not.toHaveBeenCalled();
    });

    it("returns main-window-not-found when no main window is registered", async () => {
      fromId.mockReturnValue(null);
      const handler = handleMap.get("lvis:window:resize-for-mode")!;
      const result = await handler(trustedEvent(), "action");
      expect(result).toEqual({ ok: false, error: "main-window-not-found" });
    });

    it("centers an 800×600 window on the work area for action mode", async () => {
      const main = makeMainWindow();
      wm.registerMainWindow(main as never);
      fromId.mockReturnValue(main);
      const handler = handleMap.get("lvis:window:resize-for-mode")!;
      const result = await handler(trustedEvent(), "action");
      expect(result).toEqual({ ok: true });
      // The tween emits intermediate setBounds frames; flush it to completion.
      flushTween();
      // workArea 1920×1080 → centered 800×600. The LAST setBounds call must
      // land EXACTLY on the target (intermediate interpolated frames allowed).
      expect(lastBounds(main)).toEqual({ x: 560, y: 240, width: 800, height: 600 });
    });

    it("restores the right-docked initial bounds for chat mode", async () => {
      const main = makeMainWindow();
      wm.registerMainWindow(main as never);
      fromId.mockReturnValue(main);
      const handler = handleMap.get("lvis:window:resize-for-mode")!;
      const result = await handler(trustedEvent(), "chat");
      expect(result).toEqual({ ok: true });
      flushTween();
      // chat mode uses computeInitialMainWindowBounds — a right-docked,
      // narrower-than-action bounds (not centered, not 800 wide). The final
      // landing bounds must match that geometry exactly.
      const bounds = lastBounds(main);
      expect(bounds.width).toBeLessThan(800);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(1920);
    });

    it("cancels an in-flight tween so the latest target wins and lands exactly", async () => {
      const main = makeMainWindow();
      wm.registerMainWindow(main as never);
      fromId.mockReturnValue(main);
      const handler = handleMap.get("lvis:window:resize-for-mode")!;
      // Start an action tween, advance partway, then switch to chat mid-flight.
      await handler(trustedEvent(), "action");
      vi.advanceTimersByTime(48); // a few frames in, not yet settled
      await handler(trustedEvent(), "chat");
      flushTween();
      // The latest (chat) target wins: final bounds are the chat geometry,
      // never the abandoned action 800×600.
      const bounds = lastBounds(main);
      expect(bounds.width).toBeLessThan(800);
      expect(bounds).not.toEqual({ x: 560, y: 240, width: 800, height: 600 });
    });
  });
});
