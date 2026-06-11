/**
 * Shared parser for the manual host-resolver map (/etc/hosts-style text).
 *
 * Used by both the renderer (LlmTab count badge) and the Electron main process
 * (`manual-host-resolver.ts`, which builds the Chromium `host-resolver-rules`
 * switch). Keeping a single parser guarantees the entry count shown in the UI
 * and the switch installed at boot agree on which lines are valid — and on
 * hostname casing (always lowercased here).
 *
 * Power-user surface by design: manual mode intentionally accepts ANY routable
 * IPv4 + hostname pair, including public endpoints. There is deliberately NO
 * RFC1918 / private-subnet confinement — a user who selects manual auth may map
 * a public endpoint to a private IP or vice versa. The validation below only
 * rejects *structurally* malformed lines so a single textarea entry cannot
 * inject extra comma-separated MAP rules into the switch.
 */

/** Result of parsing one valid map line. */
export interface HostResolverMapEntry {
  /** Hostname, lowercased. */
  hostname: string;
  /** IPv4 dotted-quad address. */
  ip: string;
}

/** Each octet must be 0-255 with no leading zeros (so `String(n) === part`). */
function isValidIpv4(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return false;
    const n = Number(part);
    if (n < 0 || n > 255) return false;
    // Reject leading zeros / non-canonical forms (e.g. "01", "001").
    if (String(n) !== part) return false;
  }
  return true;
}

/**
 * RFC 1123 hostname: dot-separated labels, each 1-63 chars from `[a-z0-9-]`,
 * not starting or ending with a hyphen, with no empty labels; total length
 * <= 253. Rejects structurally invalid forms like ".", "a..b", "-x", "x-"
 * that a looser `[a-z0-9.-]+` charset would wave through — those inflate the
 * parsed count and emit `MAP` rules Chromium silently ignores at resolve time.
 */
const HOSTNAME_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function isValidHostname(value: string): boolean {
  if (value.length === 0 || value.length > 253) return false;
  return value.split(".").every((label) => HOSTNAME_LABEL_RE.test(label));
}

/**
 * Parse /etc/hosts-style text into validated {@link HostResolverMapEntry}
 * pairs. Blank lines and `#` comments are skipped. A line is accepted only
 * when it is exactly `<ipv4> <hostname>` (whitespace separated): the IP must
 * be a dotted-quad with octets 0-255, and the hostname must contain only DNS
 * characters (`a-z`, `0-9`, `.`, `-`). The hostname is lowercased. Lines with
 * extra tokens, commas, or non-DNS characters are rejected so a single
 * textarea line cannot inject additional comma-separated MAP rules into the
 * Chromium switch.
 */
export function parseHostResolverMap(raw: string): HostResolverMapEntry[] {
  const result: HostResolverMapEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const parts = trimmed.split(/\s+/);
    // Exactly two tokens — a trailing token (e.g. a comma-injected MAP rule)
    // makes the line ambiguous, so reject it rather than guessing.
    if (parts.length !== 2) continue;
    const ip = parts[0]!;
    const hostname = parts[1]!.toLowerCase();
    if (!isValidIpv4(ip)) continue;
    if (!isValidHostname(hostname)) continue;
    result.push({ hostname, ip });
  }
  return result;
}
