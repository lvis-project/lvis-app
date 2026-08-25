/**
 * Preload for the floating dock's own window.
 *
 * DELIBERATELY NOT the host preload. `preload.ts` composes the full host API —
 * settings, conversations, secrets, the lot — because the app window needs it.
 * The dock needs six things, and giving a persistent always-on-top window the
 * whole surface because it happens to be first-party is how a small window
 * quietly becomes a second app.
 *
 * What it exposes, and why each one is here:
 *
 *   `pluginShellUrl` / `pluginPreloadUrl` — the dock mounts plugin cards as
 *     `<webview>`s pointed at the same shell the sidebar uses. Resolved HERE,
 *     in the entry module, because `__dirname` is `dist/src/` only in the
 *     bundled entry — the same constraint `preload.ts` documents.
 *   `ensurePartition` / `registerWebview` — the existing plugin-UI handshake,
 *     unchanged. Main re-validates the entry URL against the install root, so
 *     the dock renderer asking is not the dock renderer being trusted.
 *   `getTheme` — so a card paints in the user's theme from its first frame.
 *   the dock channels — the host's activity line and slot lifecycle.
 *
 * What it does NOT expose: any way to move, resize or re-level the window. The
 * dock's geometry is main's, and a renderer that could change it would undo
 * the bound that makes an always-on-top plugin surface safe to offer.
 */
import { contextBridge, ipcRenderer } from "electron";
import { resolve as pathResolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CHANNELS } from "./contract/app-contract.js";

function safeResolveFileUrl(relative: string): string {
  try {
    return pathToFileURL(pathResolve(__dirname, relative)).toString();
  } catch {
    return "";
  }
}

/** One main-to-dock subscription, returning its own unsubscribe. */
function subscribe<T>(channel: string, handler: (payload: T) => void): () => void {
  const listener = (_event: unknown, payload: T) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const dockBridge = {
  pluginShellUrl: safeResolveFileUrl("plugin-ui-shell.html"),
  pluginPreloadUrl: safeResolveFileUrl("plugin-preload.cjs"),

  /**
   * Install a plugin partition's session policy BEFORE its `<webview>` exists.
   *
   * A frame binds its URL loader table once, at first load, so the
   * `lvis-plugin:` asset scheme has to be on the session before the guest is
   * created — installing it afterwards leaves the frame unable to fetch its
   * own assets for its whole life, with no retry that can help.
   */
  ensurePartition: (pluginId: string): Promise<unknown> =>
    ipcRenderer.invoke(CHANNELS.pluginBridge.ensurePartition, { pluginId }),

  registerWebview: (payload: {
    webContentsId: number;
    pluginId: string;
    entryUrl: string;
  }): Promise<unknown> => ipcRenderer.invoke(CHANNELS.pluginBridge.registerWebview, payload),

  getTheme: (): Promise<unknown> => ipcRenderer.invoke(CHANNELS.pluginBridge.getTheme),

  onActivity: (handler: (activity: unknown) => void) =>
    subscribe(CHANNELS.dock.activity, handler),
  onMount: (handler: (slot: unknown) => void) => subscribe(CHANNELS.dock.mount, handler),
  onResize: (handler: (change: unknown) => void) => subscribe(CHANNELS.dock.resize, handler),
  onUnmount: (handler: (slot: unknown) => void) => subscribe(CHANNELS.dock.unmount, handler),

  /** The user pressed the dock's close control. */
  requestClose: (): void => {
    ipcRenderer.send(CHANNELS.dock.requestClose);
  },

  /**
   * One slot's guest died.
   *
   * Reported from the renderer because `<webview>`'s `crashed` and
   * `destroyed` events fire on the element, and main has no handle on a guest
   * it did not create. Main re-checks that the sender is the dock before
   * acting on it.
   */
  reportSlotGone: (panelId: string): void => {
    ipcRenderer.send(CHANNELS.dock.slotGone, { panelId });
  },
};

contextBridge.exposeInMainWorld("lvisDock", dockBridge);

export type LvisDockBridge = typeof dockBridge;
