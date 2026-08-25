/**
 * The Electron half of the floating dock — the window itself.
 *
 * Split from `floating-dock.ts` for the reason `audio-capture-surface.ts` is
 * split from `audio-capture.ts`: the policy above it (what may attach, how
 * tall a slot may be, who hears about a detach) is the part worth testing, and
 * it cannot be tested with a real display attached. This file holds everything
 * that genuinely needs Electron and as little decision-making as possible.
 *
 * THE WINDOW'S SHAPE IS FIXED HERE, NOT PASSED IN. Frameless, transparent,
 * always-on-top, off the taskbar, not resizable by drag. A plugin never names
 * any of it — the whole security argument for the dock is that the plugin
 * contributes a card and the host contributes the window, so these options are
 * constants in host code and reach no API.
 *
 * The cards inside are `<webview>` elements the dock's own renderer creates,
 * pointed at `plugin-ui-shell.html` — the SAME shell the sidebar uses, over
 * the same `lvis:plugin:*` bridge. Nothing about plugin UI hosting is
 * reimplemented here; the dock is a second place to put it.
 */
import { BrowserWindow, ipcMain, screen } from "electron";
import { runtimeAssetPath } from "./main-paths.js";
import { pluginPartitionName } from "../shared/plugin-partition.js";
import { CHANNELS } from "../contract/app-contract.js";
import { createLogger } from "../lib/logger.js";
import type {
  DockActivity,
  DockBounds,
  DockSurfaceEvent,
  FloatingDockSurface,
  ResolvedFloatingSurface,
  WorkArea,
} from "./floating-dock.js";

const log = createLogger("floating-dock");


/**
 * The real window.
 *
 * Created lazily and destroyed on `hide()` rather than merely hidden: a dock
 * with nothing in it has no state worth keeping alive, and a destroyed window
 * cannot be left floating by a bug in the visibility bookkeeping.
 */
export class ElectronFloatingDockSurface implements FloatingDockSurface {
  #window: BrowserWindow | null = null;
  #emit: ((event: DockSurfaceEvent) => void) | null = null;
  /** Queued while the renderer is still loading; flushed on ready-to-show. */
  #pending: Array<{ channel: string; payload: unknown }> = [];
  #ready = false;

  constructor() {
    // Registered ONCE, in the constructor, not per window: `show()` runs again
    // every time the dock comes back and per-window registration would stack a
    // second listener each time, so one click would report N closes.
    //
    // Both handlers check the sender is THIS dock's window. Without that, any
    // renderer in the app could close the dock or claim a plugin's slot died —
    // these channels are not on the plugin bridge, but "not reachable from a
    // plugin frame today" is not the same as "checked".
    ipcMain.on(CHANNELS.dock.requestClose, (event) => {
      if (!this.ownsSender(event.sender.id)) return;
      this.#emit?.({ kind: "dock-closed" });
    });
    ipcMain.on(CHANNELS.dock.slotGone, (event, payload: { panelId?: unknown }) => {
      if (!this.ownsSender(event.sender.id)) return;
      const panelId = payload?.panelId;
      if (typeof panelId !== "string" || !panelId) return;
      this.#emit?.({ kind: "slot-gone", panelId, reason: "renderer-gone" });
    });
  }

  workArea(): WorkArea {
    // `getPrimaryDisplay` rather than the display the main window is on: the
    // dock is a persistent overlay and moving it when the app window moves
    // would be more surprising than leaving it where the user last saw it.
    return screen.getPrimaryDisplay().workArea;
  }

  onSurfaceEvent(listener: (event: DockSurfaceEvent) => void): void {
    this.#emit = listener;
  }

  show(bounds: DockBounds): void {
    if (this.#window && !this.#window.isDestroyed()) {
      this.#window.setBounds(bounds);
      return;
    }
    this.#ready = false;
    const win = new BrowserWindow({
      ...bounds,
      // Deliberately NOT `getCommonChromeOptions()`. That helper gives the app
      // window its platform titlebar — on macOS a real frame plus inset
      // traffic lights — and the dock has no titlebar to inset into. Spreading
      // it here would paint macOS window buttons over a transparent overlay
      // that draws its own header.
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      webPreferences: {
        // `.cjs` because this package is `type: "module"` and a `.js` preload
        // would load as ESM, while the preload needs `require("electron")`.
        preload: runtimeAssetPath("floating-dock-preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        // The dock hosts plugin `<webview>` guests, so its own renderer runs
        // sandboxed too. The preload needs only `contextBridge` and
        // `ipcRenderer`, both of which work in a sandboxed preload.
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        spellcheck: false,
        webviewTag: true,
      },
    });
    this.#window = win;

    // Above full-screen applications where the platform supports it. The
    // "floating" level is ignored elsewhere and `alwaysOnTop` still applies.
    try {
      win.setAlwaysOnTop(true, "floating");
    } catch {
      /* platform without the level; the flag above still holds */
    }
    // Visible on whichever space the user switches to, which is what "the app
    // is doing something" has to mean for a status surface.
    try {
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    } catch {
      /* not supported everywhere */
    }

    win.once("ready-to-show", () => {
      this.#ready = true;
      for (const queued of this.#pending) this.#post(queued.channel, queued.payload);
      this.#pending = [];
      win.show();
    });

    win.on("closed", () => {
      this.#window = null;
      this.#ready = false;
      this.#pending = [];
      // The user hit the close control, or the OS took the window. Either way
      // every attachment is gone and the plugins have to hear it — a recorder
      // whose window vanished has an orphaned session to clean up.
      this.#emit?.({ kind: "dock-closed" });
    });

    void win.loadFile(runtimeAssetPath("floating-dock-window.html")).catch((err) => {
      log.error(`dock window failed to load: ${(err as Error).message}`);
      // Fail loudly rather than leaving an invisible always-on-top window
      // behind that nothing can reach.
      if (!win.isDestroyed()) win.destroy();
    });
  }

  setBounds(bounds: DockBounds): void {
    if (!this.#window || this.#window.isDestroyed()) return;
    this.#window.setBounds(bounds);
  }

  hide(): void {
    const win = this.#window;
    if (!win || win.isDestroyed()) return;
    // Cleared first, so the `closed` handler's `dock-closed` does not travel
    // back into a service that is already tearing this down.
    this.#emit = null;
    this.#window = null;
    win.destroy();
  }

  mountSlot(panelId: string, surface: ResolvedFloatingSurface, height: number): void {
    this.#post(CHANNELS.dock.mount, {
      panelId,
      pluginId: surface.pluginId,
      // The shell resolves the real module through `getEntryUrl` after
      // `registerWebview`; this is the URL the renderer registers WITH, and
      // main re-validates it against the install root before minting anything.
      entryUrl: surface.entryUrl,
      // Computed HERE, never in the renderer. The name is a HASH of the plugin
      // id, not the id itself, and a renderer that rebuilt it from the id would
      // open a different session — one with no `lvis-plugin:` scheme on it,
      // whose guest could never fetch its own assets and could not be repaired
      // by retrying. One place knows the rule.
      partition: pluginPartitionName(surface.pluginId),
      title: surface.title,
      height,
    });
  }

  resizeSlot(panelId: string, height: number): void {
    this.#post(CHANNELS.dock.resize, { panelId, height });
  }

  unmountSlot(panelId: string): void {
    this.#post(CHANNELS.dock.unmount, { panelId });
  }

  setActivity(activity: DockActivity | null): void {
    this.#post(CHANNELS.dock.activity, activity);
  }

  /** Whether `event.sender` is this dock's window. The dock's IPC uses it. */
  ownsSender(webContentsId: number): boolean {
    const win = this.#window;
    return !!win && !win.isDestroyed() && win.webContents.id === webContentsId;
  }

  #post(channel: string, payload: unknown): void {
    const win = this.#window;
    if (!win || win.isDestroyed()) return;
    if (!this.#ready) {
      // A mount that arrived before the renderer finished loading would be
      // dropped by `send`, leaving a slot the service believes exists and the
      // user cannot see. Queue instead.
      this.#pending.push({ channel, payload });
      return;
    }
    win.webContents.send(channel, payload);
  }
}
