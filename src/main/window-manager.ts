/**
 * WindowManager — tab detach + magnetic snap
 *
 * Manages detached child BrowserWindows. Built-in detached views can be snapped
 * to edges of the main window (KakaoTalk image-viewer style). Plugin detached
 * windows keep the same initial near-main placement, but remain independently
 * movable/resizable after creation.
 *
 * Snap rules:
 *  - While a built-in child window is dragged within SNAP_THRESHOLD_DIP of a
 *    main window edge it snaps: its position is locked relative to that edge.
 *  - When the main window moves, all snapped children follow.
 *  - When the child is dragged away more than SNAP_THRESHOLD_DIP it detaches.
 *  - Maximising the main window hides locked (permanently snapped) children
 *    and un-snaps the rest; unmaximising restores them in the correct order.
 *
 * All coordinates are in DIP (device-independent pixels) because Electron's
 * BrowserWindow.getBounds() always returns DIP values.
 */

import { BrowserWindow, ipcMain, screen, type BrowserWindowConstructorOptions, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { validateSender, auditUnauthorized, UNAUTHORIZED_FRAME } from "../ipc-bridge.js";
import { validateHostRendererSender } from "../ipc/gated.js";
import type { AuditLogger } from "../audit/audit-logger.js";
import { lvisHome } from "../shared/lvis-home.js";
import { resolveAppIconPath } from "./app-icon.js";
import { computeInitialMainWindowBounds } from "./main-window-bounds.js";

/** Action-mode main-window size: centered on the work area, clamped to fit. */
const ACTION_MODE_WIDTH = 800;
const ACTION_MODE_HEIGHT = 600;

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
const SNAP_GAP_DIP = 12;

export type DetachedWindowOptions = {
  width?: number;
  height?: number;
  minWidth?: number;
  minHeight?: number;
  resizable?: boolean;
  alwaysOnTop?: boolean;
};

type NormalizedDetachedWindowOptions = DetachedWindowOptions;
type DetachedWindowOptionsResolver = (viewKey: string) => DetachedWindowOptions | undefined;

const DEFAULT_DETACHED_BOUNDS = { width: 800, height: 600 } as const;
const DETACHED_WINDOW_LIMITS = {
  width: { min: 120, max: 3840 },
  height: { min: 80, max: 2160 },
  minWidth: { min: 80, max: 3840 },
  minHeight: { min: 60, max: 2160 },
} as const;

function integerInRange(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) return undefined;
  return Math.max(min, Math.min(max, value));
}

function normalizeDetachedWindowOptions(options: DetachedWindowOptions | undefined): NormalizedDetachedWindowOptions {
  return {
    width: integerInRange(options?.width, DETACHED_WINDOW_LIMITS.width.min, DETACHED_WINDOW_LIMITS.width.max),
    height: integerInRange(options?.height, DETACHED_WINDOW_LIMITS.height.min, DETACHED_WINDOW_LIMITS.height.max),
    minWidth: integerInRange(options?.minWidth, DETACHED_WINDOW_LIMITS.minWidth.min, DETACHED_WINDOW_LIMITS.minWidth.max),
    minHeight: integerInRange(options?.minHeight, DETACHED_WINDOW_LIMITS.minHeight.min, DETACHED_WINDOW_LIMITS.minHeight.max),
    resizable: typeof options?.resizable === "boolean" ? options.resizable : undefined,
    alwaysOnTop: typeof options?.alwaysOnTop === "boolean" ? options.alwaysOnTop : undefined,
  };
}

function normalizeDetachedWindowOptionsForViewKey(
  viewKey: string,
  options: DetachedWindowOptions | undefined
): NormalizedDetachedWindowOptions {
  const normalized = normalizeDetachedWindowOptions(options);
  if (!isPluginViewKey(viewKey)) return normalized;

  return {
    ...normalized,
    minWidth: undefined,
    minHeight: undefined,
    resizable: true,
  };
}

function defaultDetachedBounds(options: NormalizedDetachedWindowOptions): { width: number; height: number } {
  return {
    width: options.width ?? DEFAULT_DETACHED_BOUNDS.width,
    height: options.height ?? DEFAULT_DETACHED_BOUNDS.height,
  };
}

function detachedBoundsForViewKey(viewKey: string, options: NormalizedDetachedWindowOptions): { width: number; height: number } {
  const saved = loadWindowState().detached.find((d) => d.viewKey === viewKey);
  const defaults = defaultDetachedBounds(options);
  return {
    width: Math.max(saved?.bounds.width ?? defaults.width, options.minWidth ?? 0),
    height: Math.max(saved?.bounds.height ?? defaults.height, options.minHeight ?? 0),
  };
}

function applyDetachedWindowOptions(win: BrowserWindow, options: NormalizedDetachedWindowOptions): void {
  win.setMinimumSize(options.minWidth ?? 0, options.minHeight ?? 0);
  win.setResizable(options.resizable ?? true);
  win.setAlwaysOnTop(options.alwaysOnTop ?? false);
}

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
   * snapDeltaX is relative to the edge used by snappedPosition().
   * For "e" it is child.x - (main.x + main.width), otherwise child.x - main.x.
   * snapDeltaY follows the same rule for "s" vs. the other edges.
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
  return join(lvisHome(), "window-state.json");
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
function snappedPosition(main: Rect, _child: Rect, edge: SnapEdge, dx: number, dy: number): { x: number; y: number } {
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

function snapDeltas(main: Rect, child: Rect, edge: SnapEdge): { dx: number; dy: number } {
  switch (edge) {
    case "n":
    case "w":
      return { dx: child.x - main.x, dy: child.y - main.y };
    case "s":
      return { dx: child.x - main.x, dy: child.y - (main.y + main.height) };
    case "e":
      return { dx: child.x - (main.x + main.width), dy: child.y - main.y };
  }
}

function horizontalDistanceToRect(x: number, rect: Rect): number {
  if (x < rect.x) return rect.x - x;
  const right = rect.x + rect.width;
  if (x >= right) return x - right;
  return 0;
}

function displayForSnappedPosition(
  displays: Array<{ bounds: Rect }>,
  mainDisplay: { bounds: Rect },
  mainBounds: Rect,
  pos: { x: number; y: number }
): { bounds: Rect } {
  const verticallyOverlapping = displays.filter(
    (d) =>
      mainBounds.y < d.bounds.y + d.bounds.height &&
      mainBounds.y + mainBounds.height > d.bounds.y
  );
  const containing = verticallyOverlapping.find(
    (d) => pos.x >= d.bounds.x && pos.x < d.bounds.x + d.bounds.width
  );
  if (containing) return containing;

  return verticallyOverlapping.reduce((best, display) => {
    const distance = horizontalDistanceToRect(pos.x, display.bounds);
    const bestDistance = horizontalDistanceToRect(pos.x, best.bounds);
    return distance < bestDistance ? display : best;
  }, mainDisplay);
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
  private _mainMoveTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Active resize-for-mode tween interval. At most one tween runs at a time —
   * a new tween cancels any in-flight one so rapid chat↔action toggling does
   * not overlap animations; the latest target always wins and lands exactly.
   */
  private _resizeTween: ReturnType<typeof setInterval> | null = null;
  private _preloadPath: string;
  private _distRoot: string;
  private _getInitialThemeArgs: () => string[];
  private _resolveDetachedWindowOptions?: DetachedWindowOptionsResolver;

  constructor(opts: {
    preloadPath: string;
    distRoot: string;
    /**
     * Returns `additionalArguments` strings to inject into every detached
     * BrowserWindow at creation time. Used by the theme-prime path to pass
     * the host's cached `lastThemePayload` so the preload + ThemeProvider
     * can initialize from frame 0 instead of racing the renderer's first
     * `notifyPluginTheme` broadcast.
     *
     * Default returns `[]` — safe when main has no cached payload yet
     * (cold-boot first window) or when the consumer doesn't wire it.
     */
    getInitialThemeArgs?: () => string[];
    /**
     * Resolves a detached `viewKey` to plugin-supplied window options
     * (width / height / minWidth / minHeight). Returning `undefined` falls
     * back to the generic detached canvas defaults.
     */
    resolveDetachedWindowOptions?: DetachedWindowOptionsResolver;
  }) {
    this._preloadPath = opts.preloadPath;
    this._distRoot = opts.distRoot;
    this._getInitialThemeArgs = opts.getInitialThemeArgs ?? (() => []);
    this._resolveDetachedWindowOptions = opts.resolveDetachedWindowOptions;
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
          const nextOptions = normalizeDetachedWindowOptionsForViewKey(
            viewKey,
            this._resolveDetachedWindowOptions?.(viewKey)
          );
          const nextBounds = detachedBoundsForViewKey(viewKey, nextOptions);
          applyDetachedWindowOptions(shell, nextOptions);
          shell.setSize(nextBounds.width, nextBounds.height);
          // Update the entry's viewKey so listChildren() reflects the live viewKey.
          const entry = this._children.get(shell.id);
          if (entry) entry.viewKey = viewKey;
          shell.setTitle(`LVIS — ${viewKeyLabel(viewKey)}`);
          shell.webContents.send("lvis:detached:navigate", { viewKey });
          if (!isPluginViewKey(viewKey)) {
            this._snapToLeftEdge(shell.id);
          }
        }
        if (isPluginViewKey(viewKey)) {
          const entry = this._children.get(shell.id);
          if (entry) this._unsnap(entry);
        }
        shell.focus();
        return shell;
      }
    }

    // Restore saved size (width/height) if available. Position (x/y) is still
    // intentionally not restored here: built-in detached views snap to the main
    // window, and plugin detached views use the same near-main initial placement
    // without staying attached afterwards.
    const windowOptions = normalizeDetachedWindowOptionsForViewKey(
      viewKey,
      this._resolveDetachedWindowOptions?.(viewKey)
    );
    const bounds = detachedBoundsForViewKey(viewKey, windowOptions);
    const childOptions: BrowserWindowConstructorOptions = {
      width: bounds.width,
      height: bounds.height,
      minWidth: windowOptions.minWidth,
      minHeight: windowOptions.minHeight,
      resizable: windowOptions.resizable ?? true,
      alwaysOnTop: windowOptions.alwaysOnTop ?? false,
      show: false,
      title: `LVIS — ${viewKeyLabel(viewKey)}`,
      icon: resolveAppIconPath(),
      autoHideMenuBar: true,
      frame: process.platform !== "darwin" ? false : undefined,
      titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        webviewTag: isPluginViewKey(viewKey),
        preload: this._preloadPath,
        // Theme race-window-zero: main's cached `lastThemePayload` is passed
        // here so the preload can apply tokens to documentElement at
        // document-start (before React mounts) and expose
        // `window.__lvisInitialTheme` for ThemeProvider's sync init. See
        // architecture.md §6.7.1.
        additionalArguments: this._getInitialThemeArgs(),
      },
    };
    const child = new BrowserWindow(childOptions);
    if (typeof child.setMenu === "function") child.setMenu(null);

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
        // Defense-in-depth: scrub our own theme-prime argv hook so that even
        // if a future Electron change started forwarding parent
        // `additionalArguments` into <webview> guests, the plugin sandbox
        // would NOT receive `--lvis-initial-theme=` (which carries host
        // theme cache). Plugin webviews already get theme via the
        // `host.theme.changed` event, never via argv.
        delete prefs.additionalArguments;
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

    // Move event: locked panels correct drift immediately. Unlocked proximity
    // checks are leading+trailing throttled so the final drag position is not
    // dropped when a burst of move events arrives inside MOVE_THROTTLE_MS.
    let lastMoveAt = 0;
    let trailingMoveTimer: ReturnType<typeof setTimeout> | null = null;
    child.on("move", () => {
      const entry = this._children.get(child.id);
      if (entry?.locked) {
        if (trailingMoveTimer !== null) {
          clearTimeout(trailingMoveTimer);
          trailingMoveTimer = null;
        }
        this._onChildMove(child.id);
        return;
      }

      const now = Date.now();
      const elapsed = now - lastMoveAt;
      if (elapsed >= MOVE_THROTTLE_MS) {
        lastMoveAt = now;
        this._onChildMove(child.id);
        return;
      }

      if (trailingMoveTimer === null) {
        trailingMoveTimer = setTimeout(() => {
          trailingMoveTimer = null;
          lastMoveAt = Date.now();
          this._onChildMove(child.id);
        }, MOVE_THROTTLE_MS - elapsed);
      }
    });

    child.on("closed", () => {
      if (trailingMoveTimer !== null) {
        clearTimeout(trailingMoveTimer);
        trailingMoveTimer = null;
      }
      this._children.delete(child.id);
      if (this._detachedShell === child) {
        this._detachedShell = null;
        this._detachedShellViewKey = null;
      }
      this._persistState();
    });

    child.once("ready-to-show", () => {
      const main = this.getMainWindow();
      if (isPluginViewKey(viewKey)) {
        // Keep the established initial spawn location, but do not lock plugins
        // to the main window after creation.
        this._placeNearMainLeftEdge(child.id);
        child.show();
      } else if (main?.isMaximized()) {
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

  /**
   * Smoothly animate a window to `target` bounds via a manual, cancellable
   * tween. Electron's `setBounds(bounds, animate=true)` flag is macOS-ONLY —
   * Windows/Linux ignore it and snap instantly. This interpolates x/y/width/
   * height with an easeOutCubic curve on a ~60fps interval so the resize is
   * smooth uniformly on every platform.
   *
   * Cancellation: any in-flight tween (`_resizeTween`) is cleared before a new
   * one starts, so rapid chat↔action toggling never overlaps animations — the
   * latest target wins and still lands EXACTLY on `target` (the final step
   * snaps to the precise integer bounds rather than an interpolated value).
   */
  animateBoundsTo(
    win: BrowserWindow,
    target: { x: number; y: number; width: number; height: number },
    opts: { durationMs?: number } = {},
  ): void {
    const durationMs = opts.durationMs ?? 220;

    // Cancel any in-flight tween — latest target wins.
    if (this._resizeTween !== null) {
      clearInterval(this._resizeTween);
      this._resizeTween = null;
    }

    if (win.isDestroyed()) return;

    const start = win.getBounds();
    const sameTarget =
      start.x === target.x &&
      start.y === target.y &&
      start.width === target.width &&
      start.height === target.height;
    if (sameTarget || durationMs <= 0) {
      win.setBounds(target, false);
      return;
    }

    const frameMs = 16; // ≈60fps
    const startedAt = Date.now();
    // easeOutCubic: fast start, gentle settle.
    const ease = (t: number): number => 1 - Math.pow(1 - t, 3);

    this._resizeTween = setInterval(() => {
      if (win.isDestroyed()) {
        if (this._resizeTween !== null) {
          clearInterval(this._resizeTween);
          this._resizeTween = null;
        }
        return;
      }

      const elapsed = Date.now() - startedAt;
      const linear = Math.min(1, elapsed / durationMs);

      if (linear >= 1) {
        // Final step — snap to the EXACT target, never an interpolated value.
        if (this._resizeTween !== null) {
          clearInterval(this._resizeTween);
          this._resizeTween = null;
        }
        win.setBounds(target, false);
        return;
      }

      const k = ease(linear);
      win.setBounds(
        {
          x: Math.round(start.x + (target.x - start.x) * k),
          y: Math.round(start.y + (target.y - start.y) * k),
          width: Math.round(start.width + (target.width - start.width) * k),
          height: Math.round(start.height + (target.height - start.height) * k),
        },
        false,
      );
    }, frameMs);
  }

  listChildren(): Array<{ windowId: number; viewKey: string; snapped: boolean }> {
    return Array.from(this._children.entries()).map(([id, e]) => ({
      windowId: id,
      viewKey: e.viewKey,
      snapped: e.snappedTo !== undefined,
    }));
  }

  getDetachedWindows(): BrowserWindow[] {
    return Array.from(this._children.values())
      .map((entry) => entry.window)
      .filter((win) => !win.isDestroyed());
  }

  private _setChildPositionIfChanged(
    entry: ChildEntry,
    x: number,
    y: number,
    currentBounds = entry.window.getBounds()
  ): void {
    if (currentBounds.x !== x || currentBounds.y !== y) {
      entry.window.setPosition(x, y);
    }
  }

  // ── Snap logic ────────────────────────────────────────────────────────────

  private _onChildMove(childId: number): void {
    const entry = this._children.get(childId);
    if (!entry || entry.window.isDestroyed()) return;

    if (isPluginViewKey(entry.viewKey)) {
      const main = this.getMainWindow();
      if (main && !main.isDestroyed()) {
        main.webContents.send("lvis:window:snap-edge", null);
      }
      return;
    }

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
      const mainDisplay = screen.getDisplayNearestPoint({
        x: Math.round(mainBounds.x + mainBounds.width / 2),
        y: Math.round(mainBounds.y + mainBounds.height / 2),
      });
      const hostDisplay = displayForSnappedPosition(allDisplays, mainDisplay, mainBounds, pos);
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
      this._setChildPositionIfChanged(entry, clampedX, clampedY, childBounds);
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

  private _leftEdgePlacement(childId: number): {
    entry: ChildEntry;
    childBounds: Rect;
    x: number;
    y: number;
    snapDeltaX: number;
    snapDeltaY: number;
  } | null {
    const entry = this._children.get(childId);
    if (!entry || entry.window.isDestroyed()) return null;
    const main = this.getMainWindow();
    if (!main || main.isDestroyed()) return null;

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

    // Prefer a real display to the left. It may be slightly too narrow for the
    // full 12 DIP gutter, but as long as the child itself fits, clamp within
    // that display instead of falling back to the main display.
    const leftX = mainBounds.x - childBounds.width - SNAP_GAP_DIP;
    const leftDisplay = allDisplays.find(
      (d) =>
        d.bounds.x + d.bounds.width <= mainBounds.x &&
        childBounds.width <= d.bounds.width &&
        leftX < d.bounds.x + d.bounds.width &&
        leftX + childBounds.width > d.bounds.x &&
        mainBounds.y < d.bounds.y + d.bounds.height &&
        mainBounds.y + mainBounds.height > d.bounds.y
    );

    const hostDisplay = leftDisplay ?? mainDisplay;
    const x = Math.max(
      hostDisplay.bounds.x,
      Math.min(leftX, hostDisplay.bounds.x + hostDisplay.bounds.width - childBounds.width)
    );
    // "w" edge: snappedPosition computes x = main.x + dx.
    // Store the desired gutter delta, even when the initial placement must be
    // clamped at the display edge. When the main window later moves right far
    // enough, follow logic restores the 12 DIP gap instead of preserving a
    // temporary clamped delta.
    const snapDeltaX = -childBounds.width - SNAP_GAP_DIP;

    // Clamp Y against the display that will actually host the child.
    const y = Math.max(
      hostDisplay.bounds.y,
      Math.min(mainBounds.y, hostDisplay.bounds.y + hostDisplay.bounds.height - childBounds.height)
    );

    return {
      entry,
      childBounds,
      x,
      y,
      snapDeltaX,
      snapDeltaY: y - mainBounds.y,
    };
  }

  private _placeNearMainLeftEdge(childId: number): void {
    const placement = this._leftEdgePlacement(childId);
    if (!placement) return;
    this._setChildPositionIfChanged(placement.entry, placement.x, placement.y, placement.childBounds);
  }

  private _snapToLeftEdge(childId: number): void {
    const placement = this._leftEdgePlacement(childId);
    if (!placement) return;
    const { entry, childBounds, x, y, snapDeltaX, snapDeltaY } = placement;
    const snapEdge: SnapEdge = "w";

    // Record snap state.
    entry.snappedTo = this._mainWindowId!;
    entry.snapEdge = snapEdge;
    entry.snapDeltaX = snapDeltaX;
    entry.snapDeltaY = snapDeltaY;
    entry.locked = true;

    // Prevent the user from independently dragging the panel away.
    // Note: setMovable(false) is enforced by Electron on macOS and Windows.
    // On Linux it is advisory only — the compositor may still allow dragging.
    // _onChildMove detects such drift and immediately re-snaps the panel back.
    entry.window.setMovable(false);
    this._setChildPositionIfChanged(entry, x, y, childBounds);
  }

  private _snap(entry: ChildEntry, mainBounds: Rect, childBounds: Rect, edge: SnapEdge): void {
    entry.snappedTo = this._mainWindowId!;
    entry.snapEdge = edge;
    const { dx, dy } = snapDeltas(mainBounds, childBounds, edge);
    entry.snapDeltaX = dx;
    entry.snapDeltaY = dy;

    // Lock child to the snapped position.
    const pos = snappedPosition(mainBounds, childBounds, edge, entry.snapDeltaX, entry.snapDeltaY);
    this._setChildPositionIfChanged(entry, pos.x, pos.y, childBounds);
  }

  // Reached only by window-manager-behaviors.test.ts via a reflective cast
  // (no production caller), so noUnusedLocals flags it. Kept because it
  // documents+exercises the snap-delta math; the directive self-removes if a
  // real caller is ever added.
  // @ts-expect-error TS6133 — intentionally test-only entry point
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
    const mainDisplay = screen.getDisplayNearestPoint({
      x: Math.round(mainBounds.x + mainBounds.width / 2),
      y: Math.round(mainBounds.y + mainBounds.height / 2),
    });

    for (const [, entry] of this._children) {
      if (entry.snappedTo !== main.id || entry.window.isDestroyed()) continue;
      const edge = entry.snapEdge!;
      const dx = entry.snapDeltaX ?? 0;
      const dy = entry.snapDeltaY ?? 0;
      const childBounds = entry.window.getBounds();
      const pos = snappedPosition(mainBounds, childBounds, edge, dx, dy);

      // Re-clamp Y on every follow-move so the child stays on-screen when
      // the main window is dragged toward a short or vertically-stacked display.
      const hostDisplay = displayForSnappedPosition(allDisplays, mainDisplay, mainBounds, pos);
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

      this._setChildPositionIfChanged(entry, clampedX, clampedY, childBounds);
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

    ipcMain.handle("lvis:window:load-session-in-main", async (event: IpcMainInvokeEvent, sessionId: unknown) => {
      if (!validateSender(event)) {
        auditUnauthorized(auditLogger, "lvis:window:load-session-in-main", event);
        return UNAUTHORIZED_FRAME;
      }
      if (typeof sessionId !== "string" || !/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
        return { ok: false, error: "invalid-session-id" };
      }
      const main = this._mainWindowId === null ? null : BrowserWindow.fromId(this._mainWindowId);
      if (!main || main.isDestroyed()) return { ok: false, error: "main-window-not-found" };
      main.show();
      main.focus();
      const requestId = randomUUID();
      return await new Promise<{ ok: true } | { ok: false; error: string }>((resolve) => {
        const timeout = setTimeout(() => {
          cleanup();
          resolve({ ok: false, error: "load-session-timeout" });
        }, 12_000);
        const cleanup = () => {
          clearTimeout(timeout);
          ipcMain.removeListener("lvis:window:load-session-in-main-result", listener);
        };
        const listener = (ackEvent: IpcMainEvent, payload: unknown) => {
          if (!validateSender(ackEvent)) {
            auditUnauthorized(auditLogger, "lvis:window:load-session-in-main-result", ackEvent);
            return;
          }
          if (ackEvent.sender !== main.webContents) return;
          const ack = payload as { requestId?: unknown; ok?: unknown; error?: unknown };
          if (ack?.requestId !== requestId) return;
          cleanup();
          if (ack.ok === true) {
            resolve({ ok: true });
            return;
          }
          resolve({ ok: false, error: typeof ack.error === "string" ? ack.error : "load-session-failed" });
        };
        ipcMain.on("lvis:window:load-session-in-main-result", listener);
        main.webContents.send("lvis:window:load-session-in-main", { sessionId, requestId });
      });
    });

    // Resize the main window to match the active workspace mode.
    //   action → centered 800×600 (clamped to the work area), the focused
    //            working canvas where inline views need room.
    //   chat   → the 기존 right-docked initial bounds (the same geometry the
    //            window boots with), computed from the primary work area.
    // State-mutating channel — validateHostRendererSender (rejects plugin UI
    // shells), mirroring the other host-only window IPCs.
    ipcMain.handle("lvis:window:resize-for-mode", (event: IpcMainInvokeEvent, mode: unknown) => {
      if (!validateHostRendererSender(event)) {
        auditUnauthorized(auditLogger, "lvis:window:resize-for-mode", event);
        return UNAUTHORIZED_FRAME;
      }
      if (mode !== "chat" && mode !== "action") {
        return { ok: false, error: "invalid-mode" };
      }
      const main = this.getMainWindow();
      if (!main || main.isDestroyed()) return { ok: false, error: "main-window-not-found" };

      const { workArea } = screen.getPrimaryDisplay();
      if (mode === "action") {
        const width = Math.min(workArea.width, ACTION_MODE_WIDTH);
        const height = Math.min(workArea.height, ACTION_MODE_HEIGHT);
        const x = Math.round(workArea.x + (workArea.width - width) / 2);
        const y = Math.round(workArea.y + (workArea.height - height) / 2);
        // Manual easeOut tween (uniform on every platform). The native animate
        // flag is macOS-only and is intentionally NOT passed anymore.
        this.animateBoundsTo(main, { x, y, width, height });
      } else {
        this.animateBoundsTo(main, computeInitialMainWindowBounds(workArea));
      }
      return { ok: true };
    });
  }
}
