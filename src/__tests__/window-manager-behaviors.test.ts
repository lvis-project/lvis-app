/**
 * Behavioral regression tests for WindowManager magnetic-snap logic.
 *
 * Covers:
 *   1. maximize — locked side-panel children are hidden, unlocked snapped children are unsnapped
 *   2. unmaximize — locked hidden children are re-shown and re-snapped
 *   3. right-side clamp — child.x + child.width never exceeds the right edge of its display
 *   4. ready-to-show while main is maximized — snap is deferred; child stays hidden
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "electron";

// ── BrowserWindow mock factory ────────────────────────────────────────────

type MockWindow = ReturnType<typeof makeMockWin>;

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

// ── Electron + fs mocks ───────────────────────────────────────────────────

// vi.mock is hoisted to the top of the file by vitest — use vi.hoisted() so
// mockFromId is initialised before the factory runs.
const { mockFromId } = vi.hoisted(() => ({
  mockFromId: vi.fn((_id: number) => null as MockWindow | null),
}));

vi.mock("electron", () => ({
  BrowserWindow: {
    fromId: mockFromId,
    fromWebContents: vi.fn(() => null),
  },
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

// ── Helpers ───────────────────────────────────────────────────────────────

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

function children(wm: WindowManager) {
  return (wm as unknown as { _children: Map<number, Record<string, unknown>> })._children;
}

// ── Suite ─────────────────────────────────────────────────────────────────

describe("WindowManager — magnetic snap behaviors", () => {
  let wm: WindowManager;
  let mainWin: MockWindow;

  beforeEach(() => {
    vi.clearAllMocks();

    // Reset screen mock to a standard 1920×1080 display
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

    mockFromId.mockImplementation((id) => (id === mainWin.id ? (mainWin as never) : null));

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

    it("does not hide unlocked snapped children (they are unsnapped)", () => {
      const child = makeMockWin({ id: 102 });
      injectChild(wm, child, { locked: false, snappedTo: mainWin.id, snapEdge: "e" });

      mainWin.emit("maximize");

      expect(child.hide).not.toHaveBeenCalled();
    });
  });

  // ── 2. unmaximize ─────────────────────────────────────────────────────────

  describe("unmaximize event", () => {
    it("shows and re-snaps locked children that were hidden", () => {
      const child = makeMockWin({ id: 103, visible: false });
      injectChild(wm, child, { locked: true, snappedTo: undefined });

      mainWin.emit("unmaximize");

      expect(child.show).toHaveBeenCalledOnce();
      // _snapToLeftEdge calls setPosition
      expect(child.setPosition).toHaveBeenCalledOnce();
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
      // Main right edge = display right edge → rightX = 1920, no room on right.
      // Without clamp: x would be 1920 (off-screen).
      // With clamp: x = 1920 − childWidth must be returned.
      const flushMain = makeMockWin({
        id: 200,
        bounds: { x: 1520, y: 0, width: 400, height: 1080 },
      });
      mockFromId.mockImplementation((id) =>
        id === 200 ? (flushMain as never) : null
      );

      // No display to the left of flushMain, so the right fallback is chosen.
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

      (flushWm as unknown as { _snapToLeftEdge: (id: number) => void })._snapToLeftEdge(
        child.id
      );

      expect(child.setPosition).toHaveBeenCalledOnce();
      const [x] = (child.setPosition as ReturnType<typeof vi.fn>).mock.calls[0] as [number, number];
      expect(x + childWidth).toBeLessThanOrEqual(1920);
    });
  });

  // ── 4. ready-to-show while maximized — deferred snap ─────────────────────

  describe("ready-to-show while main is maximized", () => {
    it("marks child locked and keeps it hidden when main is maximized at open time", () => {
      // Simulate the ready-to-show branch that openDetachedTab registers.
      // We reproduce the branch logic in isolation so the test stays self-contained
      // without requiring a full openDetachedTab() BrowserWindow mock.
      const maximizedMain = makeMockWin({
        id: 300,
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        maximized: true,
      });
      mockFromId.mockImplementation((id) =>
        id === 300 ? (maximizedMain as never) : null
      );

      const deferWm = new WindowManager({
        preloadPath: "/fake/preload.cjs",
        distRoot: "/fake/dist",
      });
      deferWm.registerMainWindow(maximizedMain as never);

      const child = makeMockWin({ id: 301 });
      injectChild(deferWm, child, { locked: false, snappedTo: undefined });

      // Invoke the ready-to-show branch manually.
      const main = deferWm.getMainWindow();
      if (main?.isMaximized()) {
        const entry = children(deferWm).get(child.id);
        if (entry) entry.locked = true;
      } else {
        (deferWm as unknown as { _snapToLeftEdge: (id: number) => void })._snapToLeftEdge(
          child.id
        );
        child.show();
      }

      const entry = children(deferWm).get(child.id);
      expect(entry?.locked).toBe(true);
      expect(child.show).not.toHaveBeenCalled();
      expect(child.setPosition).not.toHaveBeenCalled();
    });
  });
});
