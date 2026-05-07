/**
 * Auth-window webContents registry.
 *
 * Auth-window webviews load remote http(s) login portals and have their own
 * scoped navigation policy installed by `attachAuthNavigationGuards()` in
 * `auth-window-service.ts`. The host-level `will-navigate` guard in
 * `main.ts` (LFI rejection + `data:`/`about:` denial) MUST skip those
 * webContents, otherwise legitimate post-login redirects like
 * `/login/callback#access_token=…` get blocked.
 *
 * Previously the host guard short-circuited on `currentUrl.startsWith("http")`
 * — a string-prefix heuristic that opened a hole for any unrelated webview
 * that ever lands on http(s). This registry replaces that heuristic with
 * an explicit allow-list keyed on `webContents.id`, populated only at
 * auth-window creation.
 *
 * Cleanup is automatic: `markAsAuthOwned()` subscribes to `destroyed` and
 * `render-process-gone`, deleting the entry so reused contentIds cannot
 * inherit the marker.
 */
import type { WebContents } from "electron";

const authOwnedIds = new Set<number>();

/**
 * Tag a webContents as belonging to an auth-window flow. The host-level
 * navigation guard will defer to the auth-window's own scoped policy for
 * any webContents tagged here.
 */
export function markAsAuthOwned(contents: WebContents): void {
  const id = contents.id;
  authOwnedIds.add(id);
  const drop = () => {
    authOwnedIds.delete(id);
  };
  contents.once("destroyed", drop);
  contents.once("render-process-gone", drop);
}

/** Whether the given webContents was registered as auth-owned. */
export function isAuthOwned(contents: WebContents): boolean {
  return authOwnedIds.has(contents.id);
}
