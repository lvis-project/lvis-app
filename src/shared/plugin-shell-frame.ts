/**
 * Single authority for "is this frame URL the plugin UI shell document".
 *
 * The plugin UI shell is the trust boundary between the plugin domain and the
 * host renderer: a shell frame receives only `window.lvisPlugin`, never
 * host-wide `window.lvisApi`. Four sites used to spell the predicate out by
 * hand — two in `src/ipc/gated.ts`, one re-typed in `src/ipc/domains/ui.ts`,
 * and one in `src/main/webview-navigation-policy.ts` — and the fourth had
 * already drifted: it was a substring test against the WHOLE url with no
 * protocol check and no pathname extraction, so
 * `file:///host.html?x=plugin-ui-shell.html` (or any http(s) page carrying the
 * name in its query) was a shell frame to the navigation policy and a host
 * frame to the IPC guards.
 *
 * Match polarity differs by call site — matching means DENY at the host-IPC
 * guards and ALLOW at the plugin-frame guard and the navigation policy — so the
 * consolidation adopts the STRICTEST existing spelling (protocol `file:` plus a
 * `/`-anchored, case-folded pathname suffix). Adopting the loose substring form
 * would have loosened the host-IPC denial.
 *
 * Pure and dependency-free on purpose: `src/main/webview-navigation-policy.ts`
 * is deliberately electron-free, so the shared predicate must be too.
 */

/** The one shell document the host mounts for plugin UI. */
const PLUGIN_SHELL_PATHNAME_SUFFIX = "/plugin-ui-shell.html";

/**
 * True only for a `file:` URL whose pathname is the plugin UI shell document.
 *
 * Fails closed: an empty or unparseable URL is not a shell frame. Host-IPC
 * guards must therefore keep their own explicit empty-URL rejection — "not a
 * plugin shell" is not the same answer as "is a trusted host renderer".
 */
export function isPluginShellFrameUrl(rawUrl: string | null | undefined): boolean {
  if (!rawUrl) return false;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "file:") return false;
    return url.pathname.toLowerCase().endsWith(PLUGIN_SHELL_PATHNAME_SUFFIX);
  } catch {
    return false;
  }
}
