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
 *  - Maximising the main window hides locked (permanently snapped) children
 *    and un-snaps the rest; unmaximising restores them in the correct order.
 *
 * All coordinates are in DIP (device-independent pixels) because Electron's
 * BrowserWindow.getBounds() always returns DIP values.
 */

import { BrowserWindow, ipcMain, screen, type IpcMainInvokeEvent } from "electron";
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { validateSender, auditUnauthorized, UNAUTHORIZED_FRAME } from "../ipc-bridge.js";
import type { AuditLogger } from "../audit/audit-logger.js";

/**
 * Allowlist for viewKey values accepted by the detach IPC handlers.
 * Built-in view keys are listed explicitly; plugin views use the
 * `plugin:<pluginId>:<extensionId>` format (two colon-separated segments)
 * where each segment is alphanumeric with dots/underscores/hyphens.
 * toViewKey() in api-client.ts produces exactly this shape.
 */
export const ALLOWED_VIEW_KEYS = /^(reminders|routines|memory|starred|plugin:[a-z0-9][a-z0-9_.-]*:[a-z0-9][a-z0-9_.-]*)$/;

/** Human-readable window titles for built-in view keys. */
const BUILTIN_VIEW_LABELS: Record<string, string> = {
  tasks: "Tasks",
  reminders: "Reminders",
  routines: "Routines",
  memory: "Memory",
  starred: "Starred",
};

function isPluginViewKey(viewKey: string): boolean {
  return viewKey.startsWith("plugin:");
}

/** Returns a safe window title for a validated viewKey. */
function viewKeyLabel(viewKey: string): string {
  if (Object.prototype.hasOwnProperty.call(BUILTIN_VIEW_LABELS, viewKey)) {
    return BUILTIN_VIEW_LABELS[viewKey];
  }
  // plugin:<pluginId>:<extensionId> — use the pluginId segment only
  if (isPluginViewKey(viewKey)) {
    const pluginId = viewKey.slice("plugin:".length).split(":")[0];
    return pluginId;
  }
  return viewKey;
}

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
  /** When true: window is permanently attached, not independently movable. */
  locked?: boolean;
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
  const dest = windowStatePath();
  const tmp = `${dest}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
  renameSync(tmp, dest);
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
  /**
   * Single detached shell slot (Path A single-instance policy).
   * At most one detached BrowserWindow exists at any time. Clicking a
   * different plugin/view navigates the existing shell rather than spawning
   * a new one. Cleared to null when the shell is destroyed.
   */
  private _detachedShell: BrowserWindow | null = null;
  private _detachedShellViewKey: string | null = null;
  /**
   * IDs of locked children that were hidden BY maximize (not by the user).
   * Used in the unmaximize handler to avoid accidentally restoring windows
   * that the user intentionally minimised before the main was maximised.
   */
  private _hiddenByMaximize = new Set<number>();
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
      // Hide locked side-panel children (they cannot follow a maximised window).
      // Track which IDs we hide so unmaximize only restores those, not windows
      // the user intentionally minimised before maximize happened.
      // Un-snap other snapped children so they are not buried under the maximised main.
      for (const [id, entry] of this._children) {
        if (entry.locked) {
          // Only record windows that are actually visible before maximising.
          // If the user had already minimised/hidden the panel, we must not
          // unconditionally restore it on unmaximize.
          if (!entry.window.isDestroyed() && entry.window.isVisible()) {
            entry.window.hide();
            this._hiddenByMaximize.add(id);
          }
        } else if (entry.snappedTo !== undefined) {
          this._unsnap(entry);
        }
      }
    });

    win.on("unmaximize", () => {
      // Re-show and re-snap only locked children that WE hid (not user-minimised ones).
      // Snap before show() to avoid flicker from stale pre-maximize coordinates
      // (mirrors the ordering in the ready-to-show handler).
      for (const [id, entry] of this._children) {
        if (
          entry.locked &&
          !entry.window.isDestroyed() &&
          this._hiddenByMaximize.has(id)
        ) {
          this._hiddenByMaximize.delete(id);
          this._snapToLeftEdge(id);
          entry.window.show();
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

    // Single-instance policy: if the shell window already exists, navigate it
    // to the new viewKey in-place rather than spawning a second window.
    if (this._detachedShell !== null && !this._detachedShell.isDestroyed()) {
      const shell = this._detachedShell;
      if (isPluginViewKey(this._detachedShellViewKey ?? "") !== isPluginViewKey(viewKey)) {
        this._children.delete(shell.id);
        this._detachedShell = null;
        this._detachedShellViewKey = null;
        if (!shell.isDestroyed()) shell.destroy();
      } else {
        if (this._detachedShellViewKey !== viewKey) {
          this._detachedShellViewKey = viewKey;
          // Update the entry's viewKey so listChildren() reflects the live viewKey.
          const entry = this._children.get(shell.id);
          if (entry) entry.viewKey = viewKey;
          shell.setTitle(`LVIS — ${viewKeyLabel(viewKey)}`);
          shell.webContents.send("lvis:detached:navigate", { viewKey });
        }
        shell.focus();
        return shell;
      }
    }

    // Restore saved size (width/height) if available.
    // Position (x/y) is intentionally NOT restored here: every detached window
    // is snapped to the main window edge by _snapToLeftEdge() inside
    // ready-to-show before it becomes visible, so any saved x/y would be
    // immediately overwritten and would only create a misleading impression
    // that the persisted position matters.
    const saved = loadWindowState().detached.find((d) => d.viewKey === viewKey);

    const child = new BrowserWindow({
      width: saved?.bounds.width ?? 800,
      height: saved?.bounds.height ?? 600,
      show: false,
      title: `LVIS — ${viewKeyLabel(viewKey)}`,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        webviewTag: isPluginViewKey(viewKey),
        preload: this._preloadPath,
      },
    });

    this._detachedShell = child;
    this._detachedShellViewKey = viewKey;

    // Lock down any <webview> the plugin shell tries to attach. Without
    // this handler, plugin code running in the shell DOM could inject
    // `<webview src="https://attacker.com" nodeintegration preload="…">`
    // and gain Node access in the rendered context. The handler strips
    // dangerous webPreferences before the child webview's webContents
    // is constructed.
    //
    // Wrapped in `typeof === "function"` so that test fakes which mock
    // BrowserWindow without a real `webContents.on` API still work —
    // the production-only attack surface (real Electron webContents)
    // always exposes the listener API.
    if (
      isPluginViewKey(viewKey) &&
      typeof child.webContents?.on === "function"
    ) {
      child.webContents.on("will-attach-webview", (event, webPreferences, params) => {
        const prefs = webPreferences as Record<string, unknown>;
        delete prefs.preload;
        delete prefs.preloadURL;
        prefs.nodeIntegration = false;
        prefs.nodeIntegrationInWorker = false;
        prefs.nodeIntegrationInSubFrames = false;
        prefs.contextIsolation = true;
        prefs.webSecurity = true;
        // Force-set: a `<webview webpreferences="sandbox=no">` injection
        // would otherwise survive and run unsandboxed.
        prefs.sandbox = true;
        // Partition-allowlist gate. Only `persist:plugin:<slug>` partitions
        // pass through `installPluginPartitionPolicy()` in main.ts (which
        // sets the preload + http/https network block). A guest with any
        // other `partition=` value would skip that policy and regain
        // unrestricted initial navigation/network access. Block the attach
        // entirely rather than rewriting the partition — silently changing
        // it would yield an attached webview with no storage isolation.
        const requested = (params as { partition?: unknown } | undefined)?.partition;
        if (typeof requested !== "string" || !requested.startsWith("persist:plugin:")) {
          if (typeof event.preventDefault === "function") event.preventDefault();
        }
      });
    }

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
      if (this._detachedShell === child) {
        this._detachedShell = null;
        this._detachedShellViewKey = null;
      }
      this._persistState();
    });

    child.once("ready-to-show", () => {
      const main = this.getMainWindow();
      if (main?.isMaximized()) {
        // Main is maximized; mark as locked but keep hidden.
        // Also register in _hiddenByMaximize so the unmaximize handler will
        // restore this panel when the main window un-maximises (just like a
        // panel that was already open when maximize was triggered).
        const entry = this._children.get(child.id);
        if (entry) {
          entry.locked = true;
          this._hiddenByMaximize.add(child.id);
        }
      } else {
        // Snap before show() to avoid a visible position jump (flicker).
        this._snapToLeftEdge(child.id);
        child.show();
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

    // setMovable(false) is advisory-only on Linux: some compositors still
    // allow the user to drag the panel.  Re-snap it back to its locked
    // position immediately so it cannot drift away from the main window edge.
    //
    // We compare current vs expected position before calling setPosition()
    // because Electron emits 'move' for programmatic setPosition() calls too.
    // Calling _snapToLeftEdge() here would trigger another 'move' → another
    // _onChildMove() → infinite loop.  Instead we compute expected position
    // directly and only call setPosition() when the panel has genuinely drifted.
    //
    // We also apply the same screen-edge clamps as _followMainForSnapped so
    // that the restored position is always on-screen (e.g. "w" snap near the
    // left edge of the display produces a negative X without clamping).
    if (entry.locked) {
      if (entry.snapEdge === undefined) return;
      const main = this.getMainWindow();
      if (!main || main.isDestroyed()) return;
      const mainBounds = main.getBounds();
      const childBounds = entry.window.getBounds();
      const pos = snappedPosition(
        mainBounds,
        childBounds,
        entry.snapEdge,
        entry.snapDeltaX ?? 0,
        entry.snapDeltaY ?? 0,
      );
      const allDisplays = screen.getAllDisplays();
      const hostDisplay =
        allDisplays.find(
          (d) =>
            pos.x >= d.bounds.x &&
            pos.x < d.bounds.x + d.bounds.width &&
            mainBounds.y < d.bounds.y + d.bounds.height &&
            mainBounds.y + mainBounds.height > d.bounds.y,
        ) ?? screen.getDisplayNearestPoint({ x: pos.x, y: pos.y });
      const clampedY = Math.max(
        hostDisplay.bounds.y,
        Math.min(pos.y, hostDisplay.bounds.y + hostDisplay.bounds.height - childBounds.height),
      );
      let clampedX = pos.x;
      if (entry.snapEdge === "e") {
        clampedX = Math.max(
          hostDisplay.bounds.x,
          Math.min(pos.x, hostDisplay.bounds.x + hostDisplay.bounds.width - childBounds.width),
        );
      } else if (entry.snapEdge === "w") {
        clampedX = Math.max(hostDisplay.bounds.x, pos.x);
      }
      if (childBounds.x !== clampedX || childBounds.y !== clampedY) {
        entry.window.setPosition(clampedX, clampedY);
      }
      return;
    }

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

  private _snapToLeftEdge(childId: number): void {
    const entry = this._children.get(childId);
    if (!entry || entry.window.isDestroyed()) return;
    const main = this.getMainWindow();
    if (!main || main.isDestroyed()) return;

    const mainBounds = main.getBounds();
    const childBounds = entry.window.getBounds();

    // Identify the display containing the main window by its center point.
    // Using center avoids mis-detection on vertically stacked monitors that
    // share the same horizontal span (same bounds.x range).
    const mainDisplay = screen.getDisplayNearestPoint({
      x: Math.round(mainBounds.x + mainBounds.width / 2),
      y: Math.round(mainBounds.y + mainBounds.height / 2),
    });

    const allDisplays = screen.getAllDisplays();

    // Prefer left side: find a display that fully accommodates the child AND
    // vertically overlaps the main window so it is visible alongside it.
    const leftX = mainBounds.x - childBounds.width;
    const leftDisplay = allDisplays.find(
      (d) =>
        leftX >= d.bounds.x &&
        leftX + childBounds.width <= d.bounds.x + d.bounds.width &&
        mainBounds.y < d.bounds.y + d.bounds.height &&
        mainBounds.y + mainBounds.height > d.bounds.y
    );

    // Find the display that will host the child when placed on the right.
    // Must check vertical overlap (same as leftDisplay logic) so that vertically
    // stacked monitors sharing the same X range don't get picked incorrectly.
    const rightX = mainBounds.x + mainBounds.width;
    const rightDisplay =
      allDisplays.find(
        (d) =>
          rightX >= d.bounds.x &&
          rightX < d.bounds.x + d.bounds.width &&
          mainBounds.y < d.bounds.y + d.bounds.height &&
          mainBounds.y + mainBounds.height > d.bounds.y
      ) ?? mainDisplay;

    const hasSpaceOnLeft = leftDisplay !== undefined;
    // Clamp right-side X: upper bound prevents overflow beyond the display's right
    // edge; lower bound prevents underflow when childWidth > displayWidth.
    const clampedRightX = Math.max(
      rightDisplay.bounds.x,
      Math.min(rightX, rightDisplay.bounds.x + rightDisplay.bounds.width - childBounds.width)
    );
    const x = hasSpaceOnLeft ? leftX : clampedRightX;
    const snapEdge: SnapEdge = hasSpaceOnLeft ? "w" : "e";
    // "w" edge: snappedPosition computes x = main.x + dx  → dx = -childWidth
    // "e" edge: snappedPosition computes x = main.x + main.width + dx
    //           dx = 0 keeps child flush against main's right edge on every follow-move.
    //           clampedRightX already handles the initial off-screen case via setPosition(x,…)
    //           below; subsequent follow-moves re-clamp via _followMainForSnapped.
    const snapDeltaX = hasSpaceOnLeft ? -childBounds.width : 0;

    // Clamp Y against the display that will actually host the child.
    const hostDisplay = hasSpaceOnLeft ? leftDisplay! : rightDisplay;
    const y = Math.max(
      hostDisplay.bounds.y,
      Math.min(mainBounds.y, hostDisplay.bounds.y + hostDisplay.bounds.height - childBounds.height)
    );

    entry.window.setPosition(x, y);

    // Record snap state.
    entry.snappedTo = this._mainWindowId!;
    entry.snapEdge = snapEdge;
    entry.snapDeltaX = snapDeltaX;
    entry.snapDeltaY = y - mainBounds.y;
    entry.locked = true;

    // Prevent the user from independently dragging the panel away.
    // Note: setMovable(false) is enforced by Electron on macOS and Windows.
    // On Linux it is advisory only — the compositor may still allow dragging.
    // _onChildMove detects such drift and immediately re-snaps the panel back.
    entry.window.setMovable(false);
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
    if (entry.locked) {
      entry.locked = false;
      if (!entry.window.isDestroyed()) {
        entry.window.setMovable(true);
      }
    }
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
    const allDisplays = screen.getAllDisplays();

    for (const [, entry] of this._children) {
      if (entry.snappedTo === undefined || entry.window.isDestroyed()) continue;
      const edge = entry.snapEdge!;
      const dx = entry.snapDeltaX ?? 0;
      const dy = entry.snapDeltaY ?? 0;
      const childBounds = entry.window.getBounds();
      const pos = snappedPosition(mainBounds, childBounds, edge, dx, dy);

      // Re-clamp Y on every follow-move so the child stays on-screen when
      // the main window is dragged toward a short or vertically-stacked display.
      const hostDisplay =
        allDisplays.find(
          (d) =>
            pos.x >= d.bounds.x &&
            pos.x < d.bounds.x + d.bounds.width &&
            mainBounds.y < d.bounds.y + d.bounds.height &&
            mainBounds.y + mainBounds.height > d.bounds.y
        ) ?? screen.getDisplayNearestPoint({ x: pos.x, y: pos.y });
      const clampedY = Math.max(
        hostDisplay.bounds.y,
        Math.min(pos.y, hostDisplay.bounds.y + hostDisplay.bounds.height - childBounds.height)
      );

      // Re-clamp X for edge snaps: snappedPosition() returns the raw flush
      // position, but the initial _snapToLeftEdge clamped to display bounds.
      // Without follow-move clamping, dragging main to either screen edge
      // pushes the panel partially or fully off-screen (left: negative X,
      // right: x + childWidth > displayWidth).
      let clampedX = pos.x;
      if (edge === "e") {
        clampedX = Math.max(
          hostDisplay.bounds.x,
          Math.min(pos.x, hostDisplay.bounds.x + hostDisplay.bounds.width - childBounds.width)
        );
      } else if (edge === "w") {
        // Left-side: child.x can go negative when main moves to the left edge.
        clampedX = Math.max(hostDisplay.bounds.x, pos.x);
      }

      entry.window.setPosition(clampedX, clampedY);
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

  registerIpc(auditLogger: AuditLogger): void {
    ipcMain.handle("lvis:window:open-detached", (event: IpcMainInvokeEvent, viewKey: unknown) => {
      if (!validateSender(event)) {
        auditUnauthorized(auditLogger, "lvis:window:open-detached", event);
        return UNAUTHORIZED_FRAME;
      }
      if (typeof viewKey !== "string" || !ALLOWED_VIEW_KEYS.test(viewKey)) {
        return { ok: false, error: "invalid-view-key" };
      }
      try {
        const win = this.openDetachedTab(viewKey);
        return { ok: true, windowId: win.id };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    });

    ipcMain.handle("lvis:window:close-detached", (event: IpcMainInvokeEvent) => {
      if (!validateSender(event)) {
        auditUnauthorized(auditLogger, "lvis:window:close-detached", event);
        return UNAUTHORIZED_FRAME;
      }
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) return { ok: false, error: "no-window" };
      this.closeDetachedTab(win.id);
      return { ok: true };
    });

    ipcMain.handle("lvis:window:list-detached", (event: IpcMainInvokeEvent) => {
      if (!validateSender(event)) {
        auditUnauthorized(auditLogger, "lvis:window:list-detached", event);
        return UNAUTHORIZED_FRAME;
      }
      return this.listChildren();
    });
  }
}
