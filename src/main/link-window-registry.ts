/**
 * External-link webContents registry.
 *
 * Link-window webviews are host-created viewers for arbitrary http(s) pages.
 * They have their own scoped navigation policy in `link-window-service.ts`.
 * The global webview guard in `main.ts` must skip only these explicitly
 * registered contents so unrelated webviews cannot gain broad http(s) access.
 */
import type { WebContents } from "electron";

const linkOwnedIds = new Set<number>();

export function markAsLinkOwned(contents: WebContents): void {
  const id = contents.id;
  linkOwnedIds.add(id);
  const drop = () => {
    linkOwnedIds.delete(id);
  };
  contents.once("destroyed", drop);
  contents.once("render-process-gone", drop);
}

export function isLinkOwned(contents: WebContents): boolean {
  return linkOwnedIds.has(contents.id);
}
