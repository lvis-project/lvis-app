/**
 * Shared host-suffix allow-list helper.
 *
 * Two surfaces in the host enforce a "URL host belongs to this allow-list"
 * gate:
 *   - `openAuthWindow.cookieHosts` (`auth-window-service.ts`) — which cookies
 *     get returned to the plugin.
 *   - `openAuthPartitionViewer.partitionDomains` (`auth-partition-viewer-
 *     service.ts`) — which hosts the viewer may navigate to inside a plugin
 *     auth partition.
 *
 * Both must agree on the matching rules so a single drifted rule on one side
 * doesn't open a phishing window on the other. Dot-boundary suffix-match is
 * the SoT here (`outlook.office.com` allow-list lets `mail.outlook.office.com`
 * through but never `outlook.office.com.attacker.com`).
 *
 * Defensive choices:
 * - Single-label TLDs (`com`, `co.kr`) cannot appear in the allow-list — any
 *   site under such a registry suffix would silently match.
 * - IDN-punycode labels (`xn--*`) are rejected at load time. They encode
 *   Unicode and can be visually-similar homoglyphs of legitimate hosts
 *   (e.g. `xn--80ak6aa92e.com` reads as `аррӏе.com`); the operator-readable
 *   audit log would show the punycode form but the user sees the Unicode
 *   form in the window title. There is no per-plugin bypass — relaxing
 *   this requires a host-source change.
 * - The allow-list has a hard length cap so a runaway manifest entry can't
 *   turn into a wildcard.
 */

const MAX_HOSTS = 16;
/** Block bare registry suffixes — see PSL note in the file header. */
const FORBIDDEN_TOP_LEVELS = new Set([
  "com",
  "net",
  "org",
  "kr",
  "co.kr",
  "or.kr",
  "go.kr",
  "io",
  "ai",
  "dev",
  "app",
]);

/** Trim, lowercase, drop a leading `.` (cookie-domain artifact). */
export function normalizeHost(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  return trimmed.startsWith(".") ? trimmed.slice(1) : trimmed;
}

/**
 * Normalize + validate a manifest-supplied allow-list. Throws on a list that
 * would be too broad to enforce meaningfully. The error is the audit-friendly
 * surface that surfaces in load-time logs for a malformed plugin manifest.
 */
export function normalizeAllowedHosts(raw: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    const host = normalizeHost(entry);
    if (host.length === 0) continue;
    if (host === "*" || host.includes("*")) {
      throw new Error(`host-allow-list: wildcard host '${entry}' is not allowed`);
    }
    if (host.includes("/")) {
      throw new Error(`host-allow-list: '${entry}' must be a hostname, not a URL`);
    }
    if (FORBIDDEN_TOP_LEVELS.has(host)) {
      throw new Error(
        `host-allow-list: '${entry}' is a public-suffix-style top level — refusing to allow blanket-match`,
      );
    }
    if (!host.includes(".")) {
      throw new Error(
        `host-allow-list: '${entry}' must contain at least one dot — single-label hosts blanket-match every site under that label`,
      );
    }
    if (host.startsWith("xn--") || host.includes(".xn--")) {
      throw new Error(
        `host-allow-list: '${entry}' contains an IDN-punycode label (xn--*) — homoglyph risk; declare the ASCII brand domain instead`,
      );
    }
    if (!seen.has(host)) {
      seen.add(host);
      out.push(host);
    }
  }
  if (out.length > MAX_HOSTS) {
    throw new Error(
      `host-allow-list: at most ${MAX_HOSTS} entries permitted (got ${out.length})`,
    );
  }
  return out;
}

/**
 * Does `urlHost` (already lowercased via `new URL().hostname`) belong to one
 * of the allow-list hosts? Dot-boundary match — `outlook.office.com` allows
 * `mail.outlook.office.com` and `outlook.office.com` itself, but never
 * `outlook.office.com.attacker.com` or `notoutlook.office.com`.
 *
 * Allow-list MUST already be normalized via `normalizeAllowedHosts` (caller's
 * responsibility — we don't normalize here per call so the hot path stays
 * allocation-free).
 */
export function urlHostMatchesAllowList(
  urlHost: string,
  normalizedAllowed: readonly string[],
): boolean {
  if (!urlHost) return false;
  const host = normalizeHost(urlHost);
  for (const allowed of normalizedAllowed) {
    if (host === allowed) return true;
    if (host.endsWith(`.${allowed}`)) return true;
  }
  return false;
}

/**
 * Convenience wrapper — parse `url`, return whether its host is allowed.
 * Returns false for unparseable URLs, non-http(s) schemes, or empty hostnames.
 */
export function urlMatchesAllowList(
  url: string,
  normalizedAllowed: readonly string[],
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  return urlHostMatchesAllowList(parsed.hostname, normalizedAllowed);
}
