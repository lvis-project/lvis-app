/**
 * WindowManager — tab detach + magnetic snap
 *
 * Manages detached child BrowserWindows that can be snapped to edges of the
 * main window (KakaoTalk image-viewer style). The main window is always
 * windowId 0 (the Electron BrowserWindow.id assigned at creation).
 *
 * Snap rules:
 *  - While a child window is dragged within SNAP_THRESHOLD_DIP of a main
 *    window edge it snaps: its position is locked relative to that edge.
 *  - When the main window moves, all snapped children follow.
 *  - When the child is dragged away more than SNAP_THRESHOLD_DIP it detaches.
 *  - Maximising the main window un-snaps all children.
 *
 * All coordinates are in DIP (device-independent pixels) because Electron's
 * BrowserWindow.getBounds() always returns DIP values.
 */

import { BrowserWindow, ipcMain, screen } from "electron";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Distance in DIP within which a child snaps to a main-window edge.
const SNAP_THRESHOLD_DIP = 20;

// Throttle move-event IPC sends: max one per MOVE_THROTTLE_MS.
const MOVE_THROTTLE_MS = 32; // ~30fps

type SnapEdge = "n" | "s" | "e" | "w";

interface ChildEntry {
  window: BrowserWindow;
  viewKey: string;
  /**
   * When snapped: id of the main window this child is attached to (always
   * the main window id in the current single-main design).
   */
  snappedTo?: number;
  snapEdge?: SnapEdge;
  /**
   * Delta from main edge to child origin when snapped, in DIP.
   * snapDeltaX = child.x - main.x  (for "e"/"w" snap)
   * snapDeltaY = child.y - main.y  (for "n"/"s" snap)
   * Both are stored unconditionally for the follow logic.
   */
  snapDeltaX?: number;
  snapDeltaY?: number;
}

type PersistedWindow = {
  viewKey: string;
  bounds: { x: number; y: number; width: number; height: number };
  snapped: boolean;
};

type WindowState = {
  detached: PersistedWindow[];
};

// ─── Persistence ────────────────────────────────────────────────────────────

function windowStatePath(): string {
  return join(homedir(), ".lvis", "window-state.json");
}

function loadWindowState(): WindowState {
  try {
    const raw = readFileSync(windowStatePath(), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && "detached" in parsed && Array.isArray((parsed as WindowState).detached)) {
      return parsed as WindowState;
    }
  } catch {
    // file missing or malformed — start fresh
  }
  return { detached: [] };
}

function saveWindowState(state: WindowState): void {
  try {
    writeFileSync(windowStatePath(), JSON.stringify(state, null, 2), "utf-8");
  } catch {
    // non-fatal
  }
}

// ─── Geometry helpers ───────────────────────────────────────────────────────

type Rect = { x: number; y: number; width: number; height: number };

/**
 * Returns which edge of `main` the point (x, y) is within threshold of,
 * or null if outside all edges.
 */
function nearestEdge(main: Rect, child: Rect): SnapEdge | null {
  const cx = child.x + child.width / 2;
  const cy = child.y + child.height / 2;

  const distN = Math.abs(child.y - main.y);                        // child top near main top
  const distS = Math.abs((child.y + child.height) - (main.y + main.height));
  const distW = Math.abs(child.x - main.x);
  const distE = Math.abs((child.x + child.width) - (main.x + main.width));

  // Also check that the child centre aligns approximately with the main edge extent
  const inHRange = cx >= main.x - SNAP_THRESHOLD_DIP && cx <= main.x + main.width + SNAP_THRESHOLD_DIP;
  const inVRange = cy >= main.y - SNAP_THRESHOLD_DIP && cy <= main.y + main.height + SNAP_THRESHOLD_DIP;

  const candidates: Array<[SnapEdge, number, boolean]> = [
    ["n", distN, inHRange],
    ["s", distS, inHRange],
    ["w", distW, inVRange],
    ["e", distE, inVRange],
  ];

  let best: SnapEdge | null = null;
  let bestDist = SNAP_THRESHOLD_DIP;

  for (const [edge, dist, inRange] of candidates) {
    if (inRange && dist <= bestDist) {
      bestDist = dist;
      best = edge;
    }
  }

  return best;
}

/**
 * Compute the child position when snapped to `edge` of `main`.
 */
function snappedPosition(main: Rect, child: Rect, edge: SnapEdge, dx: number, dy: number): { x: number; y: number } {
  switch (edge) {
    case "n":
      return { x: main.x + dx, y: main.y + dy };
    case "s":
      return { x: main.x + dx, y: main.y + main.height + dy };
    case "w":
      return { x: main.x + dx, y: main.y + dy };
    case "e":
      return { x: main.x + main.width + dx, y: main.y + dy };
  }
}

// ─── WindowManager ──────────────────────────────────────────────────────────

export class WindowManager {
  private _mainWindowId: number | null = null;
  private _children = new Map<number, ChildEntry>();
  private _lastMainMoveAt = 0;
  private _mainMoveTimer: ReturnType<typeof setTimeout> | null = null;
  private _preloadPath: string;
  private _distRoot: string;

  constructor(opts: { preloadPath: string; distRoot: string }) {
    this._preloadPath = opts.preloadPath;
    this._distRoot = opts.distRoot;
  }

  // ── Registration ──────────────────────────────────────────────────────────

  registerMainWindow(win: BrowserWindow): void {
    this._mainWindowId = win.id;

    win.on("move", () => this._onMainMove(win));

    win.on("maximize", () => {
      // Un-snap all children so they are not buried under the maximised main.
      for (const [, entry] of this._children) {
        if (entry.snappedTo !== undefined) {
          this._unsnap(entry);
        }
      }
    });

    win.on("closed", () => {
      // Cascade: close all children when main closes.
      for (const [, entry] of this._children) {
        if (!entry.window.isDestroyed()) entry.window.close();
      }
      this._children.clear();
      this._mainWindowId = null;
    });
  }

  // ── Child window management ───────────────────────────────────────────────

  openDetachedTab(viewKey: string): BrowserWindow {
    if (!existsSync(this._preloadPath)) {
      throw new Error(`[WindowManager] preload not found: ${this._preloadPath}`);
    }

    // Restore saved bounds if available.
    const saved = loadWindowState().detached.find((d) => d.viewKey === viewKey);

    // Validate saved position against current displays. On multi-monitor
    // setups a window may be saved to a display that is no longer connected;
    // without this check the window opens off-screen and the user cannot
    // interact with it (§354 follow-up, SEV-2).
    let restoredX = saved?.bounds.x;
    let restoredY = saved?.bounds.y;
    if (restoredX !== undefined && restoredY !== undefined) {
      const displays = screen.getAllDisplays();
      const fitsAnyDisplay = displays.some(
        (d) =>
          restoredX! >= d.bounds.x &&
          restoredX! < d.bounds.x + d.bounds.width &&
          restoredY! >= d.bounds.y &&
          restoredY! < d.bounds.y + d.bounds.height,
      );
      if (!fitsAnyDisplay) {
        // Clamp to primary display work area, preserving size.
        const primary = screen.getPrimaryDisplay();
        restoredX = primary.workArea.x + 100;
        restoredY = primary.workArea.y + 100;
      }
    }

    const child = new BrowserWindow({
      width: saved?.bounds.width ?? 800,
      height: saved?.bounds.height ?? 600,
      x: restoredX,
      y: restoredY,
      show: false,
      title: `LVIS — ${viewKey}`,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        preload: this._preloadPath,
      },
    });

    const entry: ChildEntry = { window: child, viewKey };
    this._children.set(child.id, entry);

    // Move event: throttled snap detection.
    let lastMoveAt = 0;
    child.on("move", () => {
      const now = Date.now();
      if (now - lastMoveAt < MOVE_THROTTLE_MS) return;
      lastMoveAt = now;
      this._onChildMove(child.id);
    });

    child.on("closed", () => {
      this._children.delete(child.id);
      this._persistState();
    });

    child.once("ready-to-show", () => {
      child.show();
      // If previously snapped, immediately snap.
      if (saved?.snapped) {
        this._trySnap(child.id);
      }
    });

    // Navigate to detached single-view mode via URL fragment.
    const indexUrl = `file://${this._distRoot}/src/index.html#detached/${encodeURIComponent(viewKey)}`;
    void child.loadURL(indexUrl);

    return child;
  }

  closeDetachedTab(windowId: number): void {
    const entry = this._children.get(windowId);
    if (entry && !entry.window.isDestroyed()) {
      entry.window.close();
    }
  }

  getMainWindow(): BrowserWindow | null {
    if (this._mainWindowId === null) return null;
    return BrowserWindow.fromId(this._mainWindowId) ?? null;
  }

  listChildren(): Array<{ windowId: number; viewKey: string; snapped: boolean }> {
    return Array.from(this._children.entries()).map(([id, e]) => ({
      windowId: id,
      viewKey: e.viewKey,
      snapped: e.snappedTo !== undefined,
    }));
  }

  // ── Snap logic ────────────────────────────────────────────────────────────

  private _onChildMove(childId: number): void {
    const entry = this._children.get(childId);
    if (!entry || entry.window.isDestroyed()) return;

    const main = this.getMainWindow();
    if (!main || main.isDestroyed()) return;

    const childBounds = entry.window.getBounds();
    const mainBounds = main.getBounds();

    if (entry.snappedTo !== undefined) {
      // Already snapped — check if user is dragging away.
      const edge = nearestEdge(mainBounds, childBounds);
      if (edge === null || edge !== entry.snapEdge) {
        this._unsnap(entry);
        // Broadcast un-snap so main window removes highlight.
        main.webContents.send("lvis:window:snap-edge", null);
      }
      return;
    }

    // Not snapped — detect proximity.
    const edge = nearestEdge(mainBounds, childBounds);
    if (edge !== null) {
      this._snap(entry, mainBounds, childBounds, edge);
      // Broadcast snap edge highlight to main window.
      main.webContents.send("lvis:window:snap-edge", edge);
    } else {
      main.webContents.send("lvis:window:snap-edge", null);
    }
  }

  private _snap(entry: ChildEntry, mainBounds: Rect, childBounds: Rect, edge: SnapEdge): void {
    entry.snappedTo = this._mainWindowId!;
    entry.snapEdge = edge;
    entry.snapDeltaX = childBounds.x - mainBounds.x;
    entry.snapDeltaY = childBounds.y - mainBounds.y;

    // Lock child to the snapped position.
    const pos = snappedPosition(mainBounds, childBounds, edge, entry.snapDeltaX, entry.snapDeltaY);
    entry.window.setPosition(pos.x, pos.y);
  }

  private _trySnap(childId: number): void {
    const entry = this._children.get(childId);
    if (!entry || entry.window.isDestroyed()) return;
    const main = this.getMainWindow();
    if (!main || main.isDestroyed()) return;
    const childBounds = entry.window.getBounds();
    const mainBounds = main.getBounds();
    const edge = nearestEdge(mainBounds, childBounds);
    if (edge !== null) {
      this._snap(entry, mainBounds, childBounds, edge);
    }
  }

  private _unsnap(entry: ChildEntry): void {
    entry.snappedTo = undefined;
    entry.snapEdge = undefined;
    entry.snapDeltaX = undefined;
    entry.snapDeltaY = undefined;
  }

  private _onMainMove(main: BrowserWindow): void {
    const now = Date.now();
    this._lastMainMoveAt = now;

    // Throttle with a single scheduled callback.
    if (this._mainMoveTimer !== null) return;
    this._mainMoveTimer = setTimeout(() => {
      this._mainMoveTimer = null;
      this._followMainForSnapped(main);
    }, MOVE_THROTTLE_MS);
  }

  private _followMainForSnapped(main: BrowserWindow): void {
    if (main.isDestroyed()) return;
    const mainBounds = main.getBounds();

    for (const [, entry] of this._children) {
      if (entry.snappedTo === undefined || entry.window.isDestroyed()) continue;
      const edge = entry.snapEdge!;
      const dx = entry.snapDeltaX ?? 0;
      const dy = entry.snapDeltaY ?? 0;
      const childBounds = entry.window.getBounds();
      const pos = snappedPosition(mainBounds, childBounds, edge, dx, dy);
      entry.window.setPosition(pos.x, pos.y);
    }
  }

  // ── State persistence ─────────────────────────────────────────────────────

  private _persistState(): void {
    const detached: PersistedWindow[] = [];
    for (const [, entry] of this._children) {
      if (entry.window.isDestroyed()) continue;
      detached.push({
        viewKey: entry.viewKey,
        bounds: entry.window.getBounds(),
        snapped: entry.snappedTo !== undefined,
      });
    }
    saveWindowState({ detached });
  }

  /**
   * Persist current state of all open detached windows. Call on app quit.
   */
  persistAll(): void {
    this._persistState();
  }

  // ── IPC registration ──────────────────────────────────────────────────────

  registerIpc(): void {
    ipcMain.handle("lvis:window:open-detached", (_event, viewKey: unknown) => {
      if (typeof viewKey !== "string" || !viewKey) return { ok: false, error: "invalid-view-key" };
      try {
        const win = this.openDetachedTab(viewKey);
        return { ok: true, windowId: win.id };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    });

    ipcMain.handle("lvis:window:close-detached", (event) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) return { ok: false, error: "no-window" };
      this.closeDetachedTab(win.id);
      return { ok: true };
    });

    ipcMain.handle("lvis:window:list-detached", () => {
      return this.listChildren();
    });
  }
}
