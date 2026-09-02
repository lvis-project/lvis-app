/**
 * Single source of truth for validating a user/tool-supplied navigation URL
 * before it is opened in an in-app browser tab or handed to the system browser.
 *
 * Validation is STRUCTURAL — it parses with `new URL()` and inspects the parsed
 * protocol / credentials. It never uses substring/`startsWith`/`includes`
 * checks (those are the CodeQL "incomplete URL substring sanitization" sink).
 * This is the only place the renderer decides whether a URL is safe to navigate
 * to. Every renderer boundary calls THIS validator (defense-in-depth, one SOT):
 *   - the tool-activity routing callback (routeActivityItem / routeActivityItemPinned),
 *   - the workspace-tab store (openInEphemeral / openPinned reject invalid urls),
 *   - the in-app browser viewer (UrlDocumentViewer, incl. its credential check).
 *
 * The protocol + credential decision itself is NOT implemented here — it is
 * delegated to `validateExternalUrl` (src/shared/external-url.ts), the single
 * authority shared with every main-process sink (shell.openExternal IPC, the
 * side-browser webview policy, the plugin host's openExternalUrl). This module
 * owns only the renderer-specific affordance on top: trimming and treating a
 * bare `example.com` as `https://example.com`.
 */
import { validateExternalUrl } from "../../../shared/external-url.js";

export function normalizeBrowserNavigationUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const validated = validateExternalUrl(candidate);
  return validated.ok ? validated.url : null;
}
