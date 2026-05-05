/**
 * Behavioral regression tests for WindowManager magnetic-snap logic.
 *
 * Covers:
 *   1. maximize — locked side-panel children are hidden
 *   2. unmaximize — locked hidden children are re-snapped THEN re-shown (no flicker)
 *   3. right-side clamp — child.x + child.width never exceeds the right display edge
 *   4. ready-to-show while main is maximized — snap is deferred; child stays hidden
 *      (tested end-to-end via the actual openDetachedTab() handler, not a reimplementation)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "electron";

// ── BrowserWindow mock factory (for manually injected children) ───────────

function makeMockWin(opts: {
  id?: number;
  bounds?: { x: number; y: number; width: number; height: number };
  maximized?: boolean;
  visible?: boolean;
} = {}) {
  const eventHandlers = new Map<string, Array<(...a: unknown[]) => void>>();
  const onceHandlers = new Map<string, (...a: unknown[]) => void>();

  return {
    id: opts.id ?? 1,
    isDestroyed: vi.fn(() => false),
    getBounds: vi.fn(() => opts.bounds ?? { x: 0, y: 0, width: 1200, height: 800 }),
    setPosition: vi.fn(),
    setMovable: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    isVisible: vi.fn(() => opts.visible ?? true),
    isMaximized: vi.fn(() => opts.maximized ?? false),
    close: vi.fn(),
    focus: vi.fn(),
    setTitle: vi.fn(),
    loadURL: vi.fn().mockResolvedValue(undefined),
    webContents: { send: vi.fn(), on: vi.fn() },
    on: vi.fn((event: string, handler: (...a: unknown[]) => void) => {
      if (!eventHandlers.has(event)) eventHandlers.set(event, []);
      eventHandlers.get(event)!.push(handler);
    }),
    once: vi.fn((event: string, handler: (...a: unknown[]) => void) => {
      onceHandlers.set(event, handler);
    }),
    emit(event: string, ...args: unknown[]) {
      eventHandlers.get(event)?.forEach((h) => h(...args));
      const h = onceHandlers.get(event);
      if (h) {
        onceHandlers.delete(event);
        h(...args);
      }
    },
  };
}

type MockWindow = ReturnType<typeof makeMockWin>;

// ── Hoisted BrowserWindow constructor mock ────────────────────────────────
//
// vi.mock() is hoisted to the top of the file by vitest, so factory code
// cannot reference module-scope variables. vi.hoisted() runs even earlier and
// its return value CAN be referenced inside vi.mock() factories.
//
// We define a mock BrowserWindow class here so that openDetachedTab() gets
// a fully functional spy-equipped instance when it calls `new BrowserWindow()`.

const { MockBrowserWindow, bwStore, fromIdMock } = vi.hoisted(() => {
  // Instances created by `new BrowserWindow()` are stored here so that
  // BrowserWindow.fromId() and test helpers can retrieve them.
  const bwStore = new Map<number, MockWindow>();
  let _idCounter = 1000;

  class MockBrowserWindow {
    readonly id: number;
    private _eh = new Map<string, Array<(...a: unknown[]) => void>>();
    private _oh = new Map<string, (...a: unknown[]) => void>();

    isDestroyed = vi.fn(() => false);
    getBounds = vi.fn(() => ({ x: 0, y: 0, width: 400, height: 800 }));
    setPosition = vi.fn();
    setMovable = vi.fn();
    show = vi.fn();
    hide = vi.fn();
    isVisible = vi.fn(() => true);
    isMaximized = vi.fn(() => false);
    close = vi.fn();
    focus = vi.fn();
    setTitle = vi.fn();
    loadURL = vi.fn().mockResolvedValue(undefined);
    webContents = { send: vi.fn(), on: vi.fn() };

    constructor() {
      this.id = ++_idCounter;
      bwStore.set(this.id, this as unknown as MockWindow);
    }

    on(event: string, handler: (...a: unknown[]) => void) {
      if (!this._eh.has(event)) this._eh.set(event, []);
      this._eh.get(event)!.push(handler);
    }

    once(event: string, handler: (...a: unknown[]) => void) {
      this._oh.set(event, handler);
    }

    emit(event: string, ...args: unknown[]) {
      this._eh.get(event)?.forEach((h) => h(...args));
      const h = this._oh.get(event);
      if (h) {
        this._oh.delete(event);
        h(...args);
      }
    }

    static fromId(id: number) {
      return bwStore.get(id) ?? null;
    }
    static fromWebContents = vi.fn(() => null);
  }

  const fromIdMock = vi.fn((id: number) => MockBrowserWindow.fromId(id));

  return { MockBrowserWindow, bwStore, fromIdMock };
});

// ── Electron + fs mocks ───────────────────────────────────────────────────

vi.mock("electron", () => ({
  BrowserWindow: MockBrowserWindow,
  ipcMain: { handle: vi.fn() },
  screen: {
    getAllDisplays: vi.fn(() => [
      { bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
    ]),
    getDisplayNearestPoint: vi.fn(() => ({
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    })),
  },
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    readFileSync: vi.fn(() => JSON.stringify({ detached: [] })),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
  };
});

// ── Module under test ─────────────────────────────────────────────────────

import { WindowManager } from "../main/window-manager.js";

// ── Test helpers ──────────────────────────────────────────────────────────

/** Inject a pre-built child entry into WindowManager's internal map. */
function injectChild(
  wm: WindowManager,
  win: MockWindow,
  extra: Record<string, unknown> = {}
) {
  type Children = Map<number, { window: MockWindow; viewKey: string; locked?: boolean; snappedTo?: number; snapEdge?: string }>;
  (wm as unknown as { _children: Children })._children.set(win.id, {
    window: win,
    viewKey: "plugin:test:panel",
    ...extra,
  });
}

function wmChildren(wm: WindowManager) {
  return (wm as unknown as { _children: Map<number, Record<string, unknown>> })._children;
}

// ── Suite ─────────────────────────────────────────────────────────────────

describe("WindowManager — magnetic snap behaviors", () => {
  let wm: WindowManager;
  let mainWin: MockWindow;

  beforeEach(() => {
    vi.clearAllMocks();
    bwStore.clear();

    (screen.getAllDisplays as ReturnType<typeof vi.fn>).mockReturnValue([
      { bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
    ]);
    (screen.getDisplayNearestPoint as ReturnType<typeof vi.fn>).mockReturnValue({
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    });

    mainWin = makeMockWin({
      id: 100,
      bounds: { x: 400, y: 0, width: 1200, height: 1080 },
    });
    // BrowserWindow.fromId must resolve the main window so WindowManager can
    // retrieve it via getMainWindow().
    bwStore.set(mainWin.id, mainWin);

    wm = new WindowManager({ preloadPath: "/fake/preload.cjs", distRoot: "/fake/dist" });
    wm.registerMainWindow(mainWin as never);
  });

  // ── 1. maximize ───────────────────────────────────────────────────────────

  describe("maximize event", () => {
    it("hides locked side-panel children", () => {
      const child = makeMockWin({ id: 101 });
      injectChild(wm, child, { locked: true, snappedTo: mainWin.id, snapEdge: "w" });

      mainWin.emit("maximize");

      expect(child.hide).toHaveBeenCalledOnce();
      expect(child.show).not.toHaveBeenCalled();
    });

    it("does not hide unlocked snapped children (they are unsnapped instead)", () => {
      const child = makeMockWin({ id: 102 });
      injectChild(wm, child, { locked: false, snappedTo: mainWin.id, snapEdge: "e" });

      mainWin.emit("maximize");

      expect(child.hide).not.toHaveBeenCalled();
    });
  });

  // ── 2. unmaximize ─────────────────────────────────────────────────────────

  describe("unmaximize event", () => {
    it("snaps BEFORE showing locked hidden children (no flicker)", () => {
      const child = makeMockWin({ id: 103, visible: false });
      injectChild(wm, child, { locked: true, snappedTo: undefined });

      const callOrder: string[] = [];
      (child.setPosition as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callOrder.push("setPosition");
      });
      (child.show as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callOrder.push("show");
      });

      mainWin.emit("unmaximize");

      expect(callOrder).toEqual(["setPosition", "show"]);
    });

    it("does not re-show locked children that are already visible", () => {
      const child = makeMockWin({ id: 104, visible: true });
      injectChild(wm, child, { locked: true, snappedTo: mainWin.id, snapEdge: "w" });

      mainWin.emit("unmaximize");

      expect(child.show).not.toHaveBeenCalled();
    });
  });

  // ── 3. right-side clamp ───────────────────────────────────────────────────

  describe("_snapToLeftEdge — right-side fallback", () => {
    it("clamps child within the display when main is flush against the right edge", () => {
      // Main right edge = 1920, child width = 480.
      // rightX = 1920 → without clamp x=1920 is off-screen.
      // With clamp: x = max(1920 − 480, 0) = 1440.
      const flushMain = makeMockWin({
        id: 200,
        bounds: { x: 1520, y: 0, width: 400, height: 1080 },
      });
      bwStore.set(flushMain.id, flushMain);

      (screen.getAllDisplays as ReturnType<typeof vi.fn>).mockReturnValue([
        { bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
      ]);
      (screen.getDisplayNearestPoint as ReturnType<typeof vi.fn>).mockReturnValue({
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      });

      const flushWm = new WindowManager({
        preloadPath: "/fake/preload.cjs",
        distRoot: "/fake/dist",
      });
      flushWm.registerMainWindow(flushMain as never);

      const childWidth = 480;
      const child = makeMockWin({
        id: 201,
        bounds: { x: 0, y: 0, width: childWidth, height: 1080 },
      });
      injectChild(flushWm, child, { locked: false, snappedTo: undefined });

      (flushWm as unknown as { _snapToLeftEdge: (id: number) => void })._snapToLeftEdge(child.id);

      expect(child.setPosition).toHaveBeenCalledOnce();
      const [x] = (child.setPosition as ReturnType<typeof vi.fn>).mock.calls[0] as [number, number];
      expect(x + childWidth).toBeLessThanOrEqual(1920);
    });
  });

  // ── 4. ready-to-show while main is maximized — end-to-end ────────────────
  //
  // Tests the actual once('ready-to-show', ...) handler registered by
  // openDetachedTab(), not a reimplementation of its logic.

  describe("ready-to-show while main is maximized", () => {
    it("marks child locked and keeps it hidden when main is maximized at open time", () => {
      // Replace mainWin with a maximized version.
      const maximizedMain = makeMockWin({
        id: 300,
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        maximized: true,
      });
      bwStore.set(maximizedMain.id, maximizedMain);

      const deferWm = new WindowManager({
        preloadPath: "/fake/preload.cjs",
        distRoot: "/fake/dist",
      });
      deferWm.registerMainWindow(maximizedMain as never);

      // openDetachedTab() calls `new BrowserWindow()` — MockBrowserWindow is
      // our constructor mock; the created instance is stored in bwStore.
      const bwSizeBefore = bwStore.size;
      deferWm.openDetachedTab("plugin:agent-hub:panel");

      // Retrieve the child window created by openDetachedTab().
      expect(bwStore.size).toBeGreaterThan(bwSizeBefore);
      const childId = [...bwStore.keys()].find(
        (id) => id !== maximizedMain.id && id !== mainWin.id
      )!;
      const child = bwStore.get(childId)!;

      // Fire the real ready-to-show handler registered by openDetachedTab().
      (child as unknown as { emit: (e: string) => void }).emit("ready-to-show");

      // The child must stay hidden — show() must NOT have been called.
      expect((child as unknown as MockWindow).show).not.toHaveBeenCalled();

      // The entry must be locked so unmaximize can re-snap it later.
      const entry = wmChildren(deferWm).get(childId);
      expect(entry?.locked).toBe(true);
    });
  });
});
