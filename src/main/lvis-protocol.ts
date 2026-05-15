export function findLvisProtocolUri(argv: readonly string[]): string | null {
  // Scheme comparison is case-insensitive per RFC 3986 §3.1, so accept e.g. LVIS://...
  return argv.find((arg) => arg.toLowerCase().startsWith("lvis://")) ?? null;
}

const MARKETPLACE_ACTIONS = new Set(["install", "uninstall"]);
const MARKETPLACE_PACKAGE_TYPES = new Set(["plugin", "mcp", "agent", "skill"]);
const MARKETPLACE_SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export function parseMarketplacePluginActionUri(
  url: string,
): { action: "install" | "uninstall"; slug: string; packageType: "plugin" | "mcp" | "agent" | "skill" } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "lvis:") return null;
  const action = parsed.hostname.toLowerCase();
  if (!MARKETPLACE_ACTIONS.has(action)) return null;
  if (parsed.search || parsed.hash) return null;
  let segments: string[];
  try {
    segments = parsed.pathname
      .replace(/^\//, "")
      .split("/")
      .filter((part) => part.length > 0)
      .map((part) => decodeURIComponent(part));
  } catch {
    return null;
  }
  if (segments.length !== 1 && segments.length !== 2) return null;
  let packageType: "plugin" | "mcp" | "agent" | "skill" = "plugin";
  let slug = segments[0];
  if (segments.length === 2) {
    if (!MARKETPLACE_PACKAGE_TYPES.has(segments[0])) return null;
    packageType = segments[0] as typeof packageType;
    slug = segments[1];
  }
  if (!slug || !MARKETPLACE_SLUG_RE.test(slug)) return null;
  return { action: action as "install" | "uninstall", slug, packageType };
}

/**
 * `lvis://plugin-auth/<pluginId>?code=<code>` parser.
 *
 * Generic OAuth-style callback route for any plugin. The plugin-specific
 * server redirects
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
