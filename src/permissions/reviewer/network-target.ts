/**
 * Single authority for "which network endpoint is this tool call aimed at".
 *
 * Two modules used to answer that question with two different implementations:
 *
 *   `host-risk-inspector.hasNetworkTarget` — decides whether the call's
 *     effective CATEGORY is `network`. Checked `url` / `endpoint` / `uri` for a
 *     parseable http(s)/ws(s) URL, treated any non-empty `host` field as a
 *     target, and then — default-strict — scanned EVERY top-level string for a
 *     URL, so a URL hidden under an arbitrary key still escalated.
 *
 *   `risk-classifier.extractNetworkTarget` — decides the network VERDICT, and
 *     so needs the hostname, not just a boolean. Checked `url` / `endpoint` /
 *     `host` / `uri` only, with a bare-hostname fallback, and no any-key scan.
 *
 * The gap was the any-key scan. `{ target: "https://api.openai.com/v1/chat" }`
 * escalated to category `network` (the inspector found the URL) and then rated
 * HIGH "network untrusted host" (the classifier did not), so the trusted-host
 * allowance was unreachable for every key outside the named four. Consolidating
 * makes it reachable — a deliberate LOOSENING, approved as such.
 *
 * Extraction order is the classifier's, preserved: the named fields in
 * declaration order first, then the any-key scan. A field explicitly named
 * `url`/`endpoint`/`host`/`uri` outranks an incidental URL elsewhere in the
 * arguments.
 */

/** Argument selectors that DECLARE a network endpoint. Order is significant. */
export const NETWORK_TARGET_FIELDS: readonly string[] = ["url", "endpoint", "host", "uri"];

export interface NetworkTarget {
  /** Lowercased hostname. Empty string for a network URL with no authority. */
  host: string;
  /** URL pathname, or "" when the value was a bare hostname. */
  path: string;
}

/**
 * Parse a value as a network URL. Restricted to the schemes that actually reach
 * a network peer — the inspector has always required this, and the classifier
 * rated a non-network scheme HIGH "untrusted host" anyway, so requiring it in
 * one place changes neither.
 *
 * An empty hostname is still returned as a target rather than a miss. WHATWG
 * parsing makes that shape hard to reach (`https:///x` promotes `x` to the
 * authority), but if it ever is reached the call stays in the network domain
 * and rates HIGH, because an empty host matches no trusted entry — the safe
 * direction.
 */
function parseNetworkUrl(value: string): NetworkTarget | null {
  try {
    const u = new URL(value);
    if (u.protocol !== "http:" && u.protocol !== "https:" && u.protocol !== "ws:" && u.protocol !== "wss:") {
      return null;
    }
    return { host: u.hostname.toLowerCase(), path: u.pathname };
  } catch {
    return null;
  }
}

/** Bare hostname shape — letters, digits, dots and hyphens only. */
function parseBareHost(value: string): NetworkTarget | null {
  return /^[a-zA-Z0-9.-]+$/.test(value) ? { host: value.toLowerCase(), path: "" } : null;
}

/**
 * The endpoint this call is aimed at, or `null` when no argument names one.
 */
export function extractNetworkTarget(input: Record<string, unknown>): NetworkTarget | null {
  for (const field of NETWORK_TARGET_FIELDS) {
    const value = input[field];
    if (typeof value !== "string" || value.length === 0) continue;
    const url = parseNetworkUrl(value);
    if (url) return url;
    // A field literally named `host` declares a hostname; take it as one even
    // when it is not well-formed, so a junk value cannot demote the call out of
    // the network domain. It matches no trusted entry, so it rates HIGH.
    if (field === "host") return { host: value.toLowerCase(), path: "" };
    const bare = parseBareHost(value);
    if (bare) return bare;
  }
  // Default-strict: a network URL under any other key is still a network target.
  for (const [key, value] of Object.entries(input)) {
    if (NETWORK_TARGET_FIELDS.includes(key)) continue;
    if (typeof value !== "string" || value.length === 0) continue;
    const url = parseNetworkUrl(value);
    if (url) return url;
  }
  return null;
}

/** True when any argument names a network endpoint. */
export function hasNetworkTarget(input: Record<string, unknown>): boolean {
  return extractNetworkTarget(input) !== null;
}
