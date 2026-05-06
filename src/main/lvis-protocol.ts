export function findLvisProtocolUri(argv: readonly string[]): string | null {
  // Scheme comparison is case-insensitive per RFC 3986 §3.1, so accept e.g. LVIS://...
  return argv.find((arg) => arg.toLowerCase().startsWith("lvis://")) ?? null;
}

/**
 * `lvis://plugin-auth/<pluginId>?code=<code>` parser.
 *
 * Generic OAuth-style callback route for any plugin. The plugin-specific
 * server (e.g. agent-hub, future Slack/GitHub/Notion integrations) redirects
 * the user's system browser to this URL. The host (this process) catches the
 * deep link, validates the shape, then re-emits a host event so the matching
 * plugin can exchange the code for a token. The host never inspects the
 * code's contents — it's an opaque value the auth server issues and the
 * plugin exchanges back. We only enforce shape and length so a
 * malformed/oversized URI cannot reach the plugin event bus.
 *
 * The pattern parallels the existing `lvis://install/<slug>` install route:
 * a generic, registration-free routing prefix where the second segment
 * targets the specific plugin/operation.
 *
 * Returns `{ pluginId, code }` on success; `null` otherwise.
 *
 * Validation rules (security-relevant):
 *   - scheme must be `lvis:`
 *   - host must be `plugin-auth` (lowercased)
 *   - first path segment is `pluginId` and must match
 *     `^[a-z][a-z0-9_-]{0,63}$` (same charset as plugin slug class — keeps
 *     the host event payload predictable for plugin subscribers)
 *   - no path segments past the first
 *   - exactly one `code` query parameter (multi-value drops to null to avoid
 *     parameter-pollution ambiguity)
 *   - `code` length must be in [MIN_CODE_LENGTH, MAX_CODE_LENGTH]
 *   - `code` must match the URL-safe base64 / UUID-ish character class:
 *     `[A-Za-z0-9._~-]+` (RFC 3986 unreserved). No fragment-relevant chars.
 *   - URL fragment is ignored entirely (not even checked) — fragments never
 *     reach the host process anyway, but we don't refuse the URL just
 *     because one is present.
 */
const PLUGIN_AUTH_HOST = "plugin-auth";
const PLUGIN_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const MIN_CODE_LENGTH = 16;
const MAX_CODE_LENGTH = 256;
const CODE_RE = /^[A-Za-z0-9._~-]+$/;

export function parsePluginAuthUri(url: string): { pluginId: string; code: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "lvis:") return null;
  if (parsed.hostname.toLowerCase() !== PLUGIN_AUTH_HOST) return null;

  // Extract first path segment as pluginId. URL normalizes
  // `lvis://plugin-auth/foo` to pathname "/foo"; strip leading slash and
  // require non-empty single segment.
  const path = parsed.pathname ?? "";
  if (!path.startsWith("/")) return null;
  const trimmed = path.slice(1);
  if (trimmed.length === 0) return null;
  // Reject extra path segments — exact form is `plugin-auth/<pluginId>` only.
  if (trimmed.includes("/")) return null;
  const pluginId = trimmed;
  if (!PLUGIN_ID_RE.test(pluginId)) return null;

  const codes = parsed.searchParams.getAll("code");
  // Reject parameter pollution (`?code=a&code=b`) outright. A real callback
  // never carries duplicate `code` keys, so the only way we'd see this is an
  // attacker trying to confuse the parser.
  if (codes.length !== 1) return null;
  const code = codes[0];
  if (!code) return null;
  if (code.length < MIN_CODE_LENGTH || code.length > MAX_CODE_LENGTH) return null;
  if (!CODE_RE.test(code)) return null;
  return { pluginId, code };
}
