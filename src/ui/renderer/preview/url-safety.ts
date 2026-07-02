/**
 * Single source of truth for validating a user/tool-supplied navigation URL
 * before it is opened in an in-app browser tab or handed to the system browser.
 *
 * Validation is STRUCTURAL — it parses with `new URL()` and inspects the parsed
 * protocol / credentials. It never uses substring/`startsWith`/`includes`
 * checks (those are the CodeQL "incomplete URL substring sanitization" sink).
 * This is the only place the renderer decides whether a URL is safe to navigate
 * to. Every renderer boundary calls THIS validator (defense-in-depth, one SOT):
 *   - the ActionPanel routing callback (routeActivityItem / routeActivityItemPinned),
 *   - the workspace-tab store (openInEphemeral / openPinned reject invalid urls),
 *   - the in-app browser viewer (UrlDocumentViewer, incl. its credential check).
 * The main process independently re-validates on the IPC / webview boundary
 * (side-browser-webview.ts) with the same protocol + credential rules.
 */
export function normalizeBrowserNavigationUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(candidate);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}
