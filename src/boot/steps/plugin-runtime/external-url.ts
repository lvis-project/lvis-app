/**
 * Boot §4.2 / §B3 — external-link routing for `hostApi.openExternalUrl`.
 *
 * Extracted from `plugin-runtime.ts` (C5, behavior-preserving). Pure routing
 * (URL validation + live preferred-flow read) that tests exercise with stubbed
 * services without a full initPluginRuntime context.
 */
import type { AuditEntry } from "../../../audit/audit-logger.js";
import type { SettingsService } from "../../../data/settings-store.js";
import { validateExternalUrl } from "../../../shared/external-url.js";

/**
 * §B3 — Stable persistent partition for the in-app external-link viewer.
 *
 * Without `persist:`, every link window starts with empty cookies, so SSO
 * portals (outlook.office.com, calendar webLinks, etc.) re-prompt for login
 * on every open. A shared `persist:` partition lets the user log in once
 * per external service and keep the session across the app's lifetime.
 *
 * A SHARED partition (not per-plugin) is intentional: cookies are
 * origin-scoped by the browser, so two plugins both opening
 * outlook.office.com SHOULD see the same logged-in session — that's the
 * whole point. Per-plugin partitions would force re-login each time a
 * different plugin opened the same host. The viewer is sandboxed
 * (`sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`)
 * and cookies are never read back into plugin code, so a plugin cannot
 * exfiltrate another service's session through this partition.
 */
export const EXTERNAL_LINK_PARTITION = "persist:lvis-external-link";

/**
 * §B3 — Internal routing for `hostApi.openExternalUrl`. Extracted so it can
 * be unit-tested with stubbed services without standing up a full
 * initPluginRuntime context.
 *
 * Behavior:
 *  - Validates URL shape + scheme (http(s) only).
 *  - Reads `settings.webView.preferredFlow` LIVE on every call.
 *  - Audits with origin+path only (no full URL — query may carry secrets).
 *  - `"system-browser"` → `shellOpenExternal`.
 *  - anything else (default `"in-app"`) → light viewer with a stable
 *    persistent partition so SSO sessions survive between opens.
 */
export async function routeExternalUrl(input: {
  url: string;
  pluginId: string;
  settingsService: Pick<SettingsService, "get">;
  bootAuditLogger: { log: (entry: AuditEntry) => void };
  openLinkWindowService: (
    opts: { url: string; windowTitle?: string; persistPartition?: string },
  ) => Promise<void>;
  shellOpenExternal: (url: string) => Promise<void>;
}): Promise<void> {
  const { url, pluginId, settingsService, bootAuditLogger, openLinkWindowService, shellOpenExternal } = input;
  // Protocol + embedded-credential rule delegated to the shared authority
  // (src/shared/external-url.ts); this function only maps the structured
  // verdict onto the plugin-facing error messages.
  const validated = validateExternalUrl(url);
  if (!validated.ok) {
    if (validated.error === "invalid-url") {
      throw new Error(`[plugin:${pluginId}] openExternalUrl: url must be a non-empty string`);
    }
    if (validated.error === "malformed-url") {
      throw new Error(`[plugin:${pluginId}] openExternalUrl: invalid URL`);
    }
    if (validated.error === "embedded-credentials") {
      throw new Error(
        `[plugin:${pluginId}] openExternalUrl: URLs with embedded credentials are not allowed`,
      );
    }
    throw new Error(
      `[plugin:${pluginId}] openExternalUrl: only http(s) URLs are allowed (got ${validated.protocol})`,
    );
  }
  const parsed = new URL(validated.url);
  const safeUrlForLog = `${parsed.origin}${parsed.pathname}`;
  const flow = settingsService.get("webView")?.preferredFlow ?? "in-app";

  try {
    bootAuditLogger.log({
      timestamp: new Date().toISOString(),
      sessionId: "plugin",
      type: "tool_call",
      input: `[plugin:${pluginId}] openExternalUrl flow=${flow} url=${safeUrlForLog}`,
    });
  } catch { /* audit must not break host */ }

  // Hand the sinks the CANONICALIZED url, not the caller's raw string. Only
  // `validated.url` has been through `new URL(...).toString()`, which is what
  // percent-encodes `<` and `>`; passing the raw string let a plugin smuggle
  // markup into the link-window shell document.
  if (flow === "system-browser") {
    await shellOpenExternal(validated.url);
    return;
  }
  await openLinkWindowService({ url: validated.url, persistPartition: EXTERNAL_LINK_PARTITION });
}
