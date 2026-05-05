/**
 * Behavioral regression tests for WindowManager magnetic-snap logic.
 *
 * Covers:
 *   1. maximize — locked side-panel children are hidden
 *   2. unmaximize — locked hidden children are re-snapped THEN re-shown (no flicker)
 *   3. left attach — default detached shell stays on the west edge with a gap
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
    setSize: vi.fn(),
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
    setSize = vi.fn();
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
      const child = makeMockWin({ id: 103, bounds: { x: 999, y: 0, width: 400, height: 800 }, visible: true });
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

  // ── 3. default detached shell placement ───────────────────────────────────

  describe("_snapToLeftEdge — left attach", () => {
    it("uses a 12 DIP gutter when placing a child on the left side", () => {
      const leftMain = makeMockWin({
        id: 202,
        bounds: { x: 800, y: 0, width: 800, height: 1080 },
      });
      bwStore.set(leftMain.id, leftMain);
      const leftWm = new WindowManager({ preloadPath: "/fake/preload.cjs", distRoot: "/fake/dist" });
      leftWm.registerMainWindow(leftMain as never);

      const childWidth = 480;
      const child = makeMockWin({
        id: 205,
        bounds: { x: 0, y: 0, width: childWidth, height: 800 },
      });
      injectChild(leftWm, child, { locked: false, snappedTo: undefined });

      (leftWm as unknown as { _snapToLeftEdge: (id: number) => void })._snapToLeftEdge(child.id);

      expect(child.setPosition).toHaveBeenCalledOnce();
      const [x] = (child.setPosition as ReturnType<typeof vi.fn>).mock.calls[0] as [number, number];
      expect(x).toBe(800 - childWidth - 12);
    });

    it("top-aligns the detached child with a taller main window", () => {
      const tallMain = makeMockWin({
        id: 212,
        bounds: { x: 1200, y: 24, width: 560, height: 936 },
      });
      bwStore.set(tallMain.id, tallMain);
      const topWm = new WindowManager({ preloadPath: "/fake/preload.cjs", distRoot: "/fake/dist" });
      topWm.registerMainWindow(tallMain as never);

      const child = makeMockWin({
        id: 213,
        bounds: { x: 100, y: 300, width: 480, height: 780 },
      });
      injectChild(topWm, child, { locked: false, snappedTo: undefined });

      (topWm as unknown as { _snapToLeftEdge: (id: number) => void })._snapToLeftEdge(child.id);

      expect(child.setPosition).toHaveBeenCalledOnce();
      const [, y] = (child.setPosition as ReturnType<typeof vi.fn>).mock.calls[0] as [number, number];
      expect(y).toBe(24);
      const entry = wmChildren(topWm).get(child.id);
      expect(entry?.snapDeltaY).toBe(0);
    });

    it("keeps the child on the left instead of falling back to the right side", () => {
      const edgeMain = makeMockWin({
        id: 203,
        bounds: { x: 0, y: 0, width: 400, height: 1080 },
      });
      bwStore.set(edgeMain.id, edgeMain);

      const leftWm = new WindowManager({
        preloadPath: "/fake/preload.cjs",
        distRoot: "/fake/dist",
      });
      leftWm.registerMainWindow(edgeMain as never);

      const child = makeMockWin({
        id: 204,
        bounds: { x: 100, y: 0, width: 480, height: 800 },
      });
      injectChild(leftWm, child, { locked: false, snappedTo: undefined });

      (leftWm as unknown as { _snapToLeftEdge: (id: number) => void })._snapToLeftEdge(child.id);

      expect(child.setPosition).toHaveBeenCalledOnce();
      const [x] = (child.setPosition as ReturnType<typeof vi.fn>).mock.calls[0] as [number, number];
      expect(x).toBe(0);
      const entry = wmChildren(leftWm).get(child.id);
      expect(entry?.snapEdge).toBe("w");
      expect(entry?.snapDeltaX).toBe(-480 - 12);
    });

    it("does not mirror to the right even when the main window is flush against the right edge", () => {
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
      expect(x).toBe(1520 - childWidth - 12);
      const entry = wmChildren(flushWm).get(child.id);
      expect(entry?.snapEdge).toBe("w");
    });

    it("restores the 12 DIP gutter after an initial display-edge clamp", () => {
      const edgeMain = makeMockWin({
        id: 206,
        bounds: { x: 0, y: 0, width: 400, height: 1080 },
      });
      bwStore.set(edgeMain.id, edgeMain);

      const leftWm = new WindowManager({ preloadPath: "/fake/preload.cjs", distRoot: "/fake/dist" });
      leftWm.registerMainWindow(edgeMain as never);

      const child = makeMockWin({ id: 207, bounds: { x: 100, y: 0, width: 480, height: 800 } });
      injectChild(leftWm, child, { locked: false, snappedTo: undefined });

      (leftWm as unknown as { _snapToLeftEdge: (id: number) => void })._snapToLeftEdge(child.id);
      expect((child.setPosition as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual([0, 0]);

      (child.setPosition as ReturnType<typeof vi.fn>).mockClear();
      (edgeMain.getBounds as ReturnType<typeof vi.fn>).mockReturnValue({
        x: 800,
        y: 0,
        width: 400,
        height: 1080,
      });

      (leftWm as unknown as { _followMainForSnapped: (w: unknown) => void })
        ._followMainForSnapped(edgeMain as never);

      expect(child.setPosition).toHaveBeenCalledOnce();
      const [x] = (child.setPosition as ReturnType<typeof vi.fn>).mock.calls[0] as [number, number];
      expect(x).toBe(800 - 480 - 12);
    });

    it("uses a vertically overlapping left display when one is available", () => {
      const multiMain = makeMockWin({
        id: 208,
        bounds: { x: 0, y: 0, width: 400, height: 1080 },
      });
      bwStore.set(multiMain.id, multiMain);
      (screen.getAllDisplays as ReturnType<typeof vi.fn>).mockReturnValue([
        { bounds: { x: -1920, y: 0, width: 1920, height: 1080 } },
        { bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
      ]);
      (screen.getDisplayNearestPoint as ReturnType<typeof vi.fn>).mockReturnValue({
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      });

      const multiWm = new WindowManager({ preloadPath: "/fake/preload.cjs", distRoot: "/fake/dist" });
      multiWm.registerMainWindow(multiMain as never);

      const child = makeMockWin({ id: 209, bounds: { x: 0, y: 0, width: 480, height: 800 } });
      injectChild(multiWm, child, { locked: false, snappedTo: undefined });

      (multiWm as unknown as { _snapToLeftEdge: (id: number) => void })._snapToLeftEdge(child.id);

      expect(child.setPosition).toHaveBeenCalledOnce();
      const [x] = (child.setPosition as ReturnType<typeof vi.fn>).mock.calls[0] as [number, number];
      expect(x).toBe(-480 - 12);
    });

    it("uses the left display when the child fits there after clamping without the full gutter", () => {
      const partialMain = makeMockWin({
        id: 214,
        bounds: { x: 0, y: 0, width: 400, height: 1080 },
      });
      bwStore.set(partialMain.id, partialMain);
      (screen.getAllDisplays as ReturnType<typeof vi.fn>).mockReturnValue([
        { bounds: { x: -480, y: 0, width: 480, height: 1080 } },
        { bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
      ]);
      (screen.getDisplayNearestPoint as ReturnType<typeof vi.fn>).mockReturnValue({
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      });

      const partialWm = new WindowManager({ preloadPath: "/fake/preload.cjs", distRoot: "/fake/dist" });
      partialWm.registerMainWindow(partialMain as never);

      const child = makeMockWin({ id: 215, bounds: { x: 100, y: 0, width: 480, height: 800 } });
      injectChild(partialWm, child, { locked: false, snappedTo: undefined });

      (partialWm as unknown as { _snapToLeftEdge: (id: number) => void })._snapToLeftEdge(child.id);

      expect(child.setPosition).toHaveBeenCalledOnce();
      const [x] = (child.setPosition as ReturnType<typeof vi.fn>).mock.calls[0] as [number, number];
      expect(x).toBe(-480);
      const entry = wmChildren(partialWm).get(child.id);
      expect(entry?.snapEdge).toBe("w");
      expect(entry?.snapDeltaX).toBe(-480 - 12);
    });

    it("ignores a horizontally matching display that does not vertically overlap", () => {
      const stackedMain = makeMockWin({
        id: 210,
        bounds: { x: 0, y: 0, width: 400, height: 1080 },
      });
      bwStore.set(stackedMain.id, stackedMain);
      (screen.getAllDisplays as ReturnType<typeof vi.fn>).mockReturnValue([
        { bounds: { x: -1920, y: -1200, width: 1920, height: 1080 } },
        { bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
      ]);
      (screen.getDisplayNearestPoint as ReturnType<typeof vi.fn>).mockReturnValue({
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      });

      const stackedWm = new WindowManager({ preloadPath: "/fake/preload.cjs", distRoot: "/fake/dist" });
      stackedWm.registerMainWindow(stackedMain as never);

      const child = makeMockWin({ id: 211, bounds: { x: 100, y: 0, width: 480, height: 800 } });
      injectChild(stackedWm, child, { locked: false, snappedTo: undefined });

      (stackedWm as unknown as { _snapToLeftEdge: (id: number) => void })._snapToLeftEdge(child.id);

      expect(child.setPosition).toHaveBeenCalledOnce();
      const [x] = (child.setPosition as ReturnType<typeof vi.fn>).mock.calls[0] as [number, number];
      expect(x).toBe(0);
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

    it("snaps and shows child when main is NOT maximized at open time", () => {
      // Verifies the normal open path: ready-to-show must lock/snap the child
      // before show(), avoiding a visible jump from the BrowserWindow's
      // constructor position to the magnetic position.
      const normalMain = makeMockWin({
        id: 301,
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        maximized: false,
      });
      bwStore.set(normalMain.id, normalMain);

      const normalWm = new WindowManager({
        preloadPath: "/fake/preload.cjs",
        distRoot: "/fake/dist",
      });
      normalWm.registerMainWindow(normalMain as never);

      const bwSizeBefore = bwStore.size;
      normalWm.openDetachedTab("plugin:agent-hub:panel");

      const childId = [...bwStore.keys()].find(
        (id) => id !== normalMain.id && id !== mainWin.id && id >= 301
      )!;
      const child = bwStore.get(childId)!;

      (child.getBounds as ReturnType<typeof vi.fn>).mockReturnValue({
        x: 100,
        y: 100,
        width: 400,
        height: 800,
      });
      const callOrder: string[] = [];
      (child.setPosition as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callOrder.push("setPosition");
      });
      (child.show as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callOrder.push("show");
      });

      (child as unknown as { emit: (e: string) => void }).emit("ready-to-show");

      // show() must be called and child must be in a locked, snapped state.
      expect((child as unknown as MockWindow).show).toHaveBeenCalledOnce();
      expect(callOrder).toEqual(["setPosition", "show"]);
      const entry = wmChildren(normalWm).get(childId);
      expect(entry?.locked).toBe(true);
      expect((child as unknown as MockWindow).setMovable).toHaveBeenCalledWith(false);
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
      // setMovable(false)).  _onChildMove must call setPosition() directly —
      // NOT _snapToLeftEdge() — to avoid a move-event re-entry loop.
      const child = makeMockWin({
        id: 152,
        bounds: { x: 999, y: 0, width: 400, height: 800 }, // drifted position
      });
      injectChild(wm, child, { locked: true, snappedTo: mainWin.id, snapEdge: "w" });

      (wm as unknown as { _onChildMove: (id: number) => void })._onChildMove(child.id);

      // setPosition must have been called to restore snap position.
      expect(child.setPosition).toHaveBeenCalled();
    });

    it("clamps a locked west snap against the main display instead of a vertically stacked display", () => {
      const stackedMain = makeMockWin({
        id: 154,
        bounds: { x: 50, y: 0, width: 1200, height: 1080 },
      });
      bwStore.set(stackedMain.id, stackedMain);

      (screen.getAllDisplays as ReturnType<typeof vi.fn>).mockReturnValue([
        { bounds: { x: -1920, y: -1200, width: 1920, height: 1080 } },
        { bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
      ]);
      (screen.getDisplayNearestPoint as ReturnType<typeof vi.fn>).mockReturnValue({
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      });

      const stackedWm = new WindowManager({ preloadPath: "/fake/preload.cjs", distRoot: "/fake/dist" });
      stackedWm.registerMainWindow(stackedMain as never);

      const child = makeMockWin({
        id: 155,
        bounds: { x: 20, y: -100, width: 400, height: 800 },
      });
      injectChild(stackedWm, child, {
        locked: true,
        snappedTo: stackedMain.id,
        snapEdge: "w",
        snapDeltaX: -400 - 12,
        snapDeltaY: 0,
      });

      (stackedWm as unknown as { _onChildMove: (id: number) => void })._onChildMove(child.id);

      expect(child.setPosition).toHaveBeenCalledOnce();
      expect((child.setPosition as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual([0, 0]);
    });

    it("does not re-position a locked child that is already at its clamped snap point", () => {
      const child = makeMockWin({
        id: 153,
        bounds: { x: 0, y: 0, width: 400, height: 800 },
      });
      injectChild(wm, child, {
        locked: true,
        snappedTo: mainWin.id,
        snapEdge: "w",
        snapDeltaX: -400 - 12,
        snapDeltaY: 0,
      });
      (mainWin.getBounds as ReturnType<typeof vi.fn>).mockReturnValue({
        x: 50,
        y: 0,
        width: 1200,
        height: 1080,
      });

      (wm as unknown as { _onChildMove: (id: number) => void })._onChildMove(child.id);

      expect(child.setPosition).not.toHaveBeenCalled();
    });
  });

  describe("_followMainForSnapped after right-side snap", () => {
    it("preserves the 12 DIP right-side gutter when the main window moves", () => {
      const movingMain = makeMockWin({
        id: 402,
        bounds: { x: 200, y: 0, width: 800, height: 1080 },
      });
      bwStore.set(movingMain.id, movingMain);

      const followWm = new WindowManager({ preloadPath: "/fake/preload.cjs", distRoot: "/fake/dist" });
      followWm.registerMainWindow(movingMain as never);

      const child = makeMockWin({ id: 403, bounds: { x: 0, y: 0, width: 400, height: 800 } });
      wmChildren(followWm).set(child.id, {
        window: child,
        viewKey: "plugin:test:panel",
        locked: true,
        snappedTo: movingMain.id,
        snapEdge: "e",
        snapDeltaX: 12,
        snapDeltaY: 0,
      } as never);

      (followWm as unknown as { _followMainForSnapped: (w: unknown) => void })
        ._followMainForSnapped(movingMain as never);

      expect(child.setPosition).toHaveBeenCalledOnce();
      const [x] = (child.setPosition as ReturnType<typeof vi.fn>).mock.calls[0] as [number, number];
      expect(x).toBe(200 + 800 + 12);
    });

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
    it("preserves the 12 DIP left-side gutter when the main window moves", () => {
      const leftMain = makeMockWin({
        id: 502,
        bounds: { x: 800, y: 0, width: 800, height: 1080 },
      });
      bwStore.set(leftMain.id, leftMain);

      const leftWm = new WindowManager({ preloadPath: "/fake/preload.cjs", distRoot: "/fake/dist" });
      leftWm.registerMainWindow(leftMain as never);

      const child = makeMockWin({ id: 503, bounds: { x: 0, y: 0, width: 400, height: 800 } });
      wmChildren(leftWm).set(child.id, {
        window: child,
        viewKey: "plugin:test:panel",
        locked: true,
        snappedTo: leftMain.id,
        snapEdge: "w",
        snapDeltaX: -400 - 12,
        snapDeltaY: 0,
      } as never);

      (leftWm as unknown as { _followMainForSnapped: (w: unknown) => void })
        ._followMainForSnapped(leftMain as never);

      expect(child.setPosition).toHaveBeenCalledOnce();
      const [x] = (child.setPosition as ReturnType<typeof vi.fn>).mock.calls[0] as [number, number];
      expect(x).toBe(800 - 400 - 12);
    });

    it("does not call setPosition when the snapped child is already at the calculated position", () => {
      const leftMain = makeMockWin({
        id: 504,
        bounds: { x: 800, y: 0, width: 800, height: 1080 },
      });
      bwStore.set(leftMain.id, leftMain);

      const stableWm = new WindowManager({ preloadPath: "/fake/preload.cjs", distRoot: "/fake/dist" });
      stableWm.registerMainWindow(leftMain as never);

      const child = makeMockWin({ id: 505, bounds: { x: 388, y: 0, width: 400, height: 800 } });
      wmChildren(stableWm).set(child.id, {
        window: child,
        viewKey: "plugin:test:panel",
        locked: true,
        snappedTo: leftMain.id,
        snapEdge: "w",
        snapDeltaX: -400 - 12,
        snapDeltaY: 0,
      } as never);

      (stableWm as unknown as { _followMainForSnapped: (w: unknown) => void })
        ._followMainForSnapped(leftMain as never);

      expect(child.setPosition).not.toHaveBeenCalled();
    });

    it("does not call setPosition when the snapped child is already at the clamped position", () => {
      const leftMain = makeMockWin({
        id: 506,
        bounds: { x: 50, y: 0, width: 1200, height: 1080 },
      });
      bwStore.set(leftMain.id, leftMain);

      const stableWm = new WindowManager({ preloadPath: "/fake/preload.cjs", distRoot: "/fake/dist" });
      stableWm.registerMainWindow(leftMain as never);

      const child = makeMockWin({ id: 507, bounds: { x: 0, y: 0, width: 400, height: 800 } });
      wmChildren(stableWm).set(child.id, {
        window: child,
        viewKey: "plugin:test:panel",
        locked: true,
        snappedTo: leftMain.id,
        snapEdge: "w",
        snapDeltaX: -400 - 12,
        snapDeltaY: 0,
      } as never);

      (stableWm as unknown as { _followMainForSnapped: (w: unknown) => void })
        ._followMainForSnapped(leftMain as never);

      expect(child.setPosition).not.toHaveBeenCalled();
    });

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

      const child = makeMockWin({ id: 501, bounds: { x: 20, y: 0, width: 400, height: 800 } });
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

    it("clamps follow moves to the main display when a left display is vertically stacked", () => {
      const stackedMain = makeMockWin({
        id: 508,
        bounds: { x: 50, y: 0, width: 1200, height: 1080 },
      });
      bwStore.set(stackedMain.id, stackedMain);
      (screen.getAllDisplays as ReturnType<typeof vi.fn>).mockReturnValue([
        { bounds: { x: -1920, y: -1200, width: 1920, height: 1080 } },
        { bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
      ]);
      (screen.getDisplayNearestPoint as ReturnType<typeof vi.fn>).mockReturnValue({
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      });

      const stackedWm = new WindowManager({ preloadPath: "/fake/preload.cjs", distRoot: "/fake/dist" });
      stackedWm.registerMainWindow(stackedMain as never);

      const child = makeMockWin({ id: 509, bounds: { x: 20, y: -100, width: 400, height: 800 } });
      wmChildren(stackedWm).set(child.id, {
        window: child,
        viewKey: "plugin:test:panel",
        locked: true,
        snappedTo: stackedMain.id,
        snapEdge: "w",
        snapDeltaX: -400 - 12,
        snapDeltaY: 0,
      } as never);

      (stackedWm as unknown as { _followMainForSnapped: (w: unknown) => void })
        ._followMainForSnapped(stackedMain as never);

      expect(child.setPosition).toHaveBeenCalledOnce();
      expect((child.setPosition as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual([0, 0]);
    });

    it("uses the nearest vertically overlapping display when a snapped position lands in a monitor gap", () => {
      const gapMain = makeMockWin({
        id: 510,
        bounds: { x: 400, y: 0, width: 1200, height: 1080 },
      });
      bwStore.set(gapMain.id, gapMain);
      (screen.getAllDisplays as ReturnType<typeof vi.fn>).mockReturnValue([
        { bounds: { x: -1920, y: 0, width: 1900, height: 1080 } },
        { bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
      ]);
      (screen.getDisplayNearestPoint as ReturnType<typeof vi.fn>).mockReturnValue({
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      });

      const gapWm = new WindowManager({ preloadPath: "/fake/preload.cjs", distRoot: "/fake/dist" });
      gapWm.registerMainWindow(gapMain as never);

      const child = makeMockWin({ id: 511, bounds: { x: 0, y: 0, width: 400, height: 800 } });
      wmChildren(gapWm).set(child.id, {
        window: child,
        viewKey: "plugin:test:panel",
        locked: true,
        snappedTo: gapMain.id,
        snapEdge: "w",
        snapDeltaX: -400 - 12,
        snapDeltaY: 0,
      } as never);

      (gapWm as unknown as { _followMainForSnapped: (w: unknown) => void })
        ._followMainForSnapped(gapMain as never);

      expect(child.setPosition).toHaveBeenCalledOnce();
      expect((child.setPosition as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual([-12, 0]);
    });
  });

  describe("_trySnap edge deltas", () => {
    it("stores east snap delta relative to main.right so follow moves do not double-add width", () => {
      const edgeMain = makeMockWin({
        id: 600,
        bounds: { x: 100, y: 100, width: 800, height: 600 },
      });
      bwStore.set(edgeMain.id, edgeMain);

      const edgeWm = new WindowManager({ preloadPath: "/fake/preload.cjs", distRoot: "/fake/dist" });
      edgeWm.registerMainWindow(edgeMain as never);

      const child = makeMockWin({ id: 601, bounds: { x: 504, y: 200, width: 400, height: 300 } });
      injectChild(edgeWm, child, { locked: false, snappedTo: undefined });

      (edgeWm as unknown as { _trySnap: (id: number) => void })._trySnap(child.id);

      const entry = wmChildren(edgeWm).get(child.id);
      expect(entry?.snapEdge).toBe("e");
      expect(entry?.snapDeltaX).toBe(-396);
      expect(child.setPosition).not.toHaveBeenCalled();

      (edgeMain.getBounds as ReturnType<typeof vi.fn>).mockReturnValue({
        x: 200,
        y: 100,
        width: 800,
        height: 600,
      });
      (edgeWm as unknown as { _followMainForSnapped: (w: unknown) => void })
        ._followMainForSnapped(edgeMain as never);

      expect((child.setPosition as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual([604, 200]);
    });

    it("stores south snap delta relative to main.bottom so follow moves do not double-add height", () => {
      const edgeMain = makeMockWin({
        id: 602,
        bounds: { x: 100, y: 100, width: 800, height: 600 },
      });
      bwStore.set(edgeMain.id, edgeMain);

      const edgeWm = new WindowManager({ preloadPath: "/fake/preload.cjs", distRoot: "/fake/dist" });
      edgeWm.registerMainWindow(edgeMain as never);

      const child = makeMockWin({ id: 603, bounds: { x: 200, y: 404, width: 400, height: 300 } });
      injectChild(edgeWm, child, { locked: false, snappedTo: undefined });

      (edgeWm as unknown as { _trySnap: (id: number) => void })._trySnap(child.id);

      const entry = wmChildren(edgeWm).get(child.id);
      expect(entry?.snapEdge).toBe("s");
      expect(entry?.snapDeltaY).toBe(-296);
      expect(child.setPosition).not.toHaveBeenCalled();

      (edgeMain.getBounds as ReturnType<typeof vi.fn>).mockReturnValue({
        x: 100,
        y: 200,
        width: 800,
        height: 600,
      });
      (edgeWm as unknown as { _followMainForSnapped: (w: unknown) => void })
        ._followMainForSnapped(edgeMain as never);

      expect((child.setPosition as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual([200, 504]);
    });
  });

  describe("child move throttling", () => {
    it("runs a trailing snap check for the last unlocked move in a throttled burst", () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(1_000);
        const moveMain = makeMockWin({ id: 700, bounds: { x: 400, y: 0, width: 1200, height: 1080 } });
        bwStore.set(moveMain.id, moveMain);
        const moveWm = new WindowManager({ preloadPath: "/fake/preload.cjs", distRoot: "/fake/dist" });
        moveWm.registerMainWindow(moveMain as never);
        const moveSpy = vi.spyOn(moveWm as unknown as { _onChildMove: (id: number) => void }, "_onChildMove");

        moveWm.openDetachedTab("plugin:agent-hub:agent-hub-panel");
        const child = [...bwStore.values()].find((win) => win.id !== moveMain.id && win.id >= 1000)!;
        let childBounds = { x: 1000, y: 200, width: 400, height: 800 };
        (child.getBounds as ReturnType<typeof vi.fn>).mockImplementation(() => childBounds);

        child.emit("move");
        expect(moveSpy).toHaveBeenCalledOnce();
        expect(wmChildren(moveWm).get(child.id)?.snapEdge).toBeUndefined();

        vi.setSystemTime(1_010);
        childBounds = { x: 960, y: 200, width: 400, height: 800 };
        child.emit("move");
        expect(moveSpy).toHaveBeenCalledOnce();

        vi.setSystemTime(1_020);
        childBounds = { x: 404, y: 200, width: 400, height: 800 };
        child.emit("move");
        expect(moveSpy).toHaveBeenCalledOnce();

        vi.advanceTimersByTime(22);
        expect(moveSpy).toHaveBeenCalledTimes(2);
        expect(wmChildren(moveWm).get(child.id)?.snapEdge).toBe("w");
      } finally {
        vi.useRealTimers();
      }
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
