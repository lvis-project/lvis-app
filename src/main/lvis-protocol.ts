export function findLvisProtocolUri(argv: readonly string[]): string | null {
  // Scheme comparison is case-insensitive per RFC 3986 §3.1, so accept e.g. LVIS://...
  return argv.find((arg) => arg.toLowerCase().startsWith("lvis://")) ?? null;
}

/**
 * `lvis://agent-hub-auth?code=<code>` parser.
 *
 * The agent-hub plugin completes its OAuth-style login by redirecting the
 * user's system browser to this URL. The host (this process) catches the
 * deep link, validates the shape, then re-emits a host event so the plugin
 * can exchange the code for a token. The host never inspects the code's
 * contents — it's an opaque value the agent-hub server issues and the plugin
 * exchanges back. We only enforce shape and length so a malformed/oversized
 * URI cannot reach the plugin event bus.
 *
 * Returns `{ code }` on success; `null` otherwise.
 *
 * Validation rules (security-relevant):
 *   - scheme must be `lvis:`
 *   - host must be `agent-hub-auth` (lowercased)
 *   - exactly one `code` query parameter (multi-value drops to null to avoid
 *     parameter-pollution ambiguity)
 *   - `code` length must be in [MIN_CODE_LENGTH, MAX_CODE_LENGTH]
 *   - `code` must match the URL-safe base64 / UUID-ish character class:
 *     `[A-Za-z0-9._~-]+` (RFC 3986 unreserved). No path, no fragment.
 *   - URL fragment is ignored entirely (not even checked) — fragments never
 *     reach the host process anyway, but we don't refuse the URL just
 *     because one is present.
 */
const AGENT_HUB_AUTH_HOST = "agent-hub-auth";
const MIN_CODE_LENGTH = 16;
const MAX_CODE_LENGTH = 256;
const CODE_RE = /^[A-Za-z0-9._~-]+$/;

export function parseAgentHubAuthUri(url: string): { code: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "lvis:") return null;
  if (parsed.hostname.toLowerCase() !== AGENT_HUB_AUTH_HOST) return null;
  // Disallow path segments — only `lvis://agent-hub-auth?...` exact form.
  // URL normalizes `lvis://agent-hub-auth` to pathname "" or "/" depending
  // on input; both are accepted, anything else is rejected.
  if (parsed.pathname && parsed.pathname !== "" && parsed.pathname !== "/") {
    return null;
  }
  const codes = parsed.searchParams.getAll("code");
  // Reject parameter pollution (`?code=a&code=b`) outright. A real callback
  // never carries duplicate `code` keys, so the only way we'd see this is an
  // attacker trying to confuse the parser.
  if (codes.length !== 1) return null;
  const code = codes[0];
  if (!code) return null;
  if (code.length < MIN_CODE_LENGTH || code.length > MAX_CODE_LENGTH) return null;
  if (!CODE_RE.test(code)) return null;
  return { code };
}
