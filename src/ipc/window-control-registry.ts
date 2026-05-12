import type { WebContents } from "electron";

const windowControlOwnedIds = new Set<number>();

/**
 * Mark a host-owned shell webContents as allowed to use window-control IPC.
 *
 * Auth/link windows load a host-authored `data:` shell with the normal preload,
 * while remote content stays inside a sandboxed webview. The generic sender
 * gate rejects `data:` URLs, so only explicitly marked shell contents may
 * minimize/maximize/close their own BrowserWindow.
 */
export function markAsWindowControlOwned(contents: WebContents): void {
  const id = contents.id;
  windowControlOwnedIds.add(id);
  const drop = () => {
    windowControlOwnedIds.delete(id);
  };
  contents.once("destroyed", drop);
  contents.once("render-process-gone", drop);
}

export function isWindowControlOwned(contents: WebContents | null | undefined): boolean {
  return !!contents && windowControlOwnedIds.has(contents.id);
}
