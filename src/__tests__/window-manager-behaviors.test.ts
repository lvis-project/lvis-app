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

const { MockBrowserWindow, bwStore } = vi.hoisted(() => {
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

  return { MockBrowserWindow, bwStore };
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
      const child = makeMockWin({ id: 103, visible: true });
      injectChild(wm, child, { locked: true, snappedTo: undefined });

      // Emit maximize first so the child is tracked in _hiddenByMaximize;
      // without this the unmaximize handler skips children it didn't hide.
      mainWin.emit("maximize");

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

      const bwSizeBefore = bwStore.size;
      deferWm.openDetachedTab("plugin:agent-hub:panel");

      expect(bwStore.size).toBeGreaterThan(bwSizeBefore);
      const childId = [...bwStore.keys()].find(
        (id) => id !== maximizedMain.id && id !== mainWin.id
      )!;
      const child = bwStore.get(childId)!;

      (child as unknown as { emit: (e: string) => void }).emit("ready-to-show");

      expect((child as unknown as MockWindow).show).not.toHaveBeenCalled();
      const entry = wmChildren(deferWm).get(childId);
      expect(entry?.locked).toBe(true);
      // Panel opened while maximized must be in _hiddenByMaximize so the
      // unmaximize handler will restore it (regression: was not added before).
      expect(
        (deferWm as unknown as { _hiddenByMaximize: Set<number> })._hiddenByMaximize.has(childId)
      ).toBe(true);
    });
  });

  // ── 5. setMovable — locked panels cannot be dragged ─────────────────────

  describe("setMovable", () => {
    it("calls setMovable(false) when _snapToLeftEdge locks the child", () => {
      (wm as unknown as { _snapToLeftEdge: (id: number) => void })._snapToLeftEdge =
        (wm as unknown as { _snapToLeftEdge: (id: number) => void })._snapToLeftEdge;

      const child = makeMockWin({ id: 150, bounds: { x: 0, y: 0, width: 400, height: 800 } });
      injectChild(wm, child, { locked: false, snappedTo: undefined });

      (wm as unknown as { _snapToLeftEdge: (id: number) => void })._snapToLeftEdge(child.id);

      expect(child.setMovable).toHaveBeenCalledWith(false);
    });

    it("calls setMovable(true) when _unsnap releases the child", () => {
      const child = makeMockWin({ id: 151, visible: true });
      const entry = { window: child, viewKey: "plugin:test:panel", locked: true, snappedTo: mainWin.id, snapEdge: "w" };
      wmChildren(wm).set(child.id, entry as never);

      (wm as unknown as { _unsnap: (e: unknown) => void })._unsnap(entry);

      expect(child.setMovable).toHaveBeenCalledWith(true);
      expect(entry.locked).toBe(false);
    });
    it("re-snaps locked child immediately if compositor allows drag (Linux advisory)", () => {
      // Simulate a locked panel that has drifted (e.g. Linux compositor ignored
      // setMovable(false)) — _onChildMove must call _snapToLeftEdge, not return.
      const child = makeMockWin({
        id: 152,
        bounds: { x: 999, y: 0, width: 400, height: 800 }, // drifted position
      });
      injectChild(wm, child, { locked: true, snappedTo: mainWin.id, snapEdge: "w" });

      (wm as unknown as { _onChildMove: (id: number) => void })._onChildMove(child.id);

      // setPosition must have been called to restore snap position.
      expect(child.setPosition).toHaveBeenCalled();
    });
  });

  describe("_followMainForSnapped after right-side snap", () => {
    it("places child flush against main right edge (dx=0) after main moves", () => {
      // Main starts at x=400, moves to x=600.
      const movingMain = makeMockWin({
        id: 400,
        bounds: { x: 600, y: 0, width: 1200, height: 1080 },
      });
      bwStore.set(movingMain.id, movingMain);

      (screen.getAllDisplays as ReturnType<typeof vi.fn>).mockReturnValue([
        { bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
      ]);
      (screen.getDisplayNearestPoint as ReturnType<typeof vi.fn>).mockReturnValue({
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      });

      const followWm = new WindowManager({ preloadPath: "/fake/preload.cjs", distRoot: "/fake/dist" });
      followWm.registerMainWindow(movingMain as never);

      const child = makeMockWin({ id: 401, bounds: { x: 0, y: 0, width: 400, height: 800 } });
      // Inject as a right-side ("e") snapped child with snapDeltaX=0 (flush).
      wmChildren(followWm).set(child.id, {
        window: child,
        viewKey: "plugin:test:panel",
        locked: true,
        snappedTo: movingMain.id,
        snapEdge: "e",
        snapDeltaX: 0,
        snapDeltaY: 0,
      } as never);

      (followWm as unknown as { _followMainForSnapped: (w: unknown) => void })
        ._followMainForSnapped(movingMain as never);

      expect(child.setPosition).toHaveBeenCalledOnce();
      const [x] = (child.setPosition as ReturnType<typeof vi.fn>).mock.calls[0] as [number, number];
      // Display is 1920px wide; child is 400px wide.
      // Raw flush position: 600 + 1200 = 1800.
      // Clamped: min(1800, 1920 - 400) = 1520 — child stays on-screen.
      expect(x).toBe(1920 - 400);
    });
  });

  // ── 7. _followMainForSnapped — left-side child clamped at display edge ──────

  describe("_followMainForSnapped after left-side snap", () => {
    it("clamps child.x >= display.x when main moves to the left screen edge", () => {
      // Main is at x=50 (near left edge); child is 400px wide → raw left-snap
      // x = 50 + (-400) = -350, which is off-screen.  The clamp must keep x ≥ 0.
      const leftMain = makeMockWin({
        id: 500,
        bounds: { x: 50, y: 0, width: 1200, height: 1080 },
      });
      bwStore.set(leftMain.id, leftMain);

      (screen.getAllDisplays as ReturnType<typeof vi.fn>).mockReturnValue([
        { bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
      ]);
      (screen.getDisplayNearestPoint as ReturnType<typeof vi.fn>).mockReturnValue({
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      });

      const leftWm = new WindowManager({ preloadPath: "/fake/preload.cjs", distRoot: "/fake/dist" });
      leftWm.registerMainWindow(leftMain as never);

      const child = makeMockWin({ id: 501, bounds: { x: 0, y: 0, width: 400, height: 800 } });
      wmChildren(leftWm).set(child.id, {
        window: child,
        viewKey: "plugin:test:panel",
        locked: true,
        snappedTo: leftMain.id,
        snapEdge: "w",
        snapDeltaX: -400,
        snapDeltaY: 0,
      } as never);

      (leftWm as unknown as { _followMainForSnapped: (w: unknown) => void })
        ._followMainForSnapped(leftMain as never);

      expect(child.setPosition).toHaveBeenCalledOnce();
      const [x] = (child.setPosition as ReturnType<typeof vi.fn>).mock.calls[0] as [number, number];
      // Raw x = 50 - 400 = -350; clamped to display.x = 0.
      expect(x).toBe(0);
    });
  });

  // ── 8. maximize / unmaximize distinguishes user-minimised windows ─────────

  describe("_hiddenByMaximize tracking", () => {
    it("does not restore a child that was already hidden before maximize", () => {
      // Child is hidden (user minimised it) BEFORE the main window is maximised.
      // The isVisible() guard in the maximize handler must skip it, so it never
      // enters _hiddenByMaximize and is therefore not restored on unmaximize.
      const child = makeMockWin({ id: 160, visible: false });
      injectChild(wm, child, { locked: true, snappedTo: mainWin.id, snapEdge: "w" });

      // Emit maximize: child.isVisible() returns false, so the handler must NOT
      // call hide() again and must NOT add it to _hiddenByMaximize.
      mainWin.emit("maximize");

      // isVisible guard must have prevented tracking.
      expect(
        (wm as unknown as { _hiddenByMaximize: Set<number> })._hiddenByMaximize.has(child.id)
      ).toBe(false);

      // Emit unmaximize — child is not in _hiddenByMaximize, so show() must be skipped.
      (child.show as ReturnType<typeof vi.fn>).mockClear();
      mainWin.emit("unmaximize");

      expect(child.show).not.toHaveBeenCalled();
    });

    it("restores only children that maximize hid", () => {
      const childA = makeMockWin({ id: 161, visible: true });
      const childB = makeMockWin({ id: 162, visible: true });
      injectChild(wm, childA, { locked: true, snappedTo: mainWin.id, snapEdge: "w" });
      injectChild(wm, childB, { locked: true, snappedTo: mainWin.id, snapEdge: "w" });

      mainWin.emit("maximize");

      // Manually remove childB from set (simulates it had been hidden independently).
      (wm as unknown as { _hiddenByMaximize: Set<number> })._hiddenByMaximize.delete(childB.id);

      mainWin.emit("unmaximize");

      expect(childA.show).toHaveBeenCalled();
      expect(childB.show).not.toHaveBeenCalled();
    });
  });
});
