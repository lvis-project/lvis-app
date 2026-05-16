/**
 * Portions adapted from OpenHarness (MIT License)
 * https://github.com/HKUDS/OpenHarness/blob/main/src/openharness/utils/network_guard.py
 * Copyright (c) 2025 OpenHarness Contributors
 *
 * NetworkGuard (Tier A2) — SSRF defense for outbound HTTP.
 *
 * Provides a layered defense for any tool or subsystem that issues
 * HTTP requests on behalf of the user or the model:
 *
 *   1. {@link validateHttpUrl} — synchronous syntactic check. Rejects
 *      non-http(s) schemes, missing hosts, and embedded credentials.
 *   2. {@link ensurePublicHttpUrl} — async DNS-aware check. Resolves
 *      the host and rejects any result that lands on a private /
 *      loopback / link-local / ULA address (IPv4 + IPv6 + IPv4-mapped).
 *   3. {@link fetchPublicHttpResponse} — drop-in replacement for
 *      `fetch` that validates every hop of a redirect chain (defense
 *      against DNS rebinding + CRLF location injection) and enforces
 *      a timeout.
 *
 * Node stdlib only (`node:dns`, `node:net`, built-in `fetch`).
 */
import { promises as dns } from "node:dns";
import { isIPv4, isIPv6 } from "node:net";

export class NetworkGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkGuardError";
  }
}

// ─── Private / reserved IPv4 ranges (RFC 1918, 5735, 6598, 3927) ────
const PRIVATE_IPV4_RANGES: Array<[bigint, bigint]> = [
  // 10.0.0.0/8
  [ipv4ToBigInt("10.0.0.0"), ipv4ToBigInt("10.255.255.255")],
  // 172.16.0.0/12
  [ipv4ToBigInt("172.16.0.0"), ipv4ToBigInt("172.31.255.255")],
  // 192.168.0.0/16
  [ipv4ToBigInt("192.168.0.0"), ipv4ToBigInt("192.168.255.255")],
  // 127.0.0.0/8 (loopback)
  [ipv4ToBigInt("127.0.0.0"), ipv4ToBigInt("127.255.255.255")],
  // 169.254.0.0/16 (link-local, AWS metadata 169.254.169.254)
  [ipv4ToBigInt("169.254.0.0"), ipv4ToBigInt("169.254.255.255")],
  // 100.64.0.0/10 (CGNAT)
  [ipv4ToBigInt("100.64.0.0"), ipv4ToBigInt("100.127.255.255")],
  // 0.0.0.0/8 (this network)
  [ipv4ToBigInt("0.0.0.0"), ipv4ToBigInt("0.255.255.255")],
];

/**
 * Synchronous syntactic validation for an http(s) URL.
 *
 * Throws {@link NetworkGuardError} on:
 *   - malformed URL
 *   - non-http(s) scheme
 *   - missing host
 *   - embedded credentials (user/pass)
 */
export function validateHttpUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new NetworkGuardError("URL is malformed");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new NetworkGuardError("only http and https URLs are allowed");
  }
  if (!parsed.hostname) {
    throw new NetworkGuardError("URL must include a host");
  }
  if (parsed.username || parsed.password) {
    throw new NetworkGuardError("URLs with embedded credentials are not allowed");
  }
  return parsed;
}

/**
 * Resolves the URL's host and rejects the request if any resolved
 * address lives inside a private / reserved range.
 *
 * This is the primary SSRF control: by the time a request reaches
 * {@link fetchPublicHttpResponse} we have already proven that the
 * host resolves to a public address.
 */
export async function ensurePublicHttpUrl(rawUrl: string): Promise<URL> {
  const parsed = validateHttpUrl(rawUrl);
  const addresses = await resolveHostAddresses(parsed.hostname);
  if (addresses.length === 0) {
    throw new NetworkGuardError(`target host did not resolve: ${parsed.hostname}`);
  }
  const blocked = addresses.filter((addr) => !isPublicAddress(addr));
  if (blocked.length > 0) {
    const rendered =
      blocked.slice(0, 3).join(", ") + (blocked.length > 3 ? ", ..." : "");
    throw new NetworkGuardError(
      `target resolves to non-public address(es): ${rendered}`,
    );
  }
  return parsed;
}

/**
 * Drop-in fetch wrapper that enforces per-hop redirect validation
 * and a timeout.
 *
 * Key properties:
 *   - Each redirect hop re-runs {@link ensurePublicHttpUrl} (defense
 *     against DNS rebinding and `Location: http://10.0.0.1/` pivots).
 *   - `redirect: "manual"` so the runtime fetch never silently
 *     follows a hop we have not validated.
 *   - Timeout implemented via `AbortController`.
 *   - Default `maxRedirects = 5`, `timeoutMs = 15000`.
 */
export async function fetchPublicHttpResponse(
  rawUrl: string,
  init: RequestInit & { maxRedirects?: number; timeoutMs?: number } = {},
): Promise<Response> {
  const { maxRedirects = 5, timeoutMs = 15000, signal: externalSignal, ...restInit } = init;
  let currentUrl = rawUrl;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    await ensurePublicHttpUrl(currentUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // Forward aborts from the caller-supplied signal so callers can cancel
    // long-running requests (e.g., transport.close()). The per-hop timer
    // still fires independently.
    let externalAbortListener: (() => void) | null = null;
    if (externalSignal) {
      if (externalSignal.aborted) {
        controller.abort();
      } else {
        externalAbortListener = () => controller.abort();
        externalSignal.addEventListener("abort", externalAbortListener, { once: true });
      }
    }
    try {
      const response = await fetch(currentUrl, {
        ...restInit,
        redirect: "manual",
        signal: controller.signal,
      });
      // Not a redirect → final response
      if (response.status < 300 || response.status >= 400) {
        return response;
      }
      const location = response.headers.get("location");
      if (!location) {
        return response;
      }
      if (hop >= maxRedirects) {
        throw new NetworkGuardError(`too many redirects (>${maxRedirects})`);
      }
      currentUrl = new URL(location, currentUrl).toString();
    } finally {
      clearTimeout(timer);
      if (externalAbortListener && externalSignal) {
        externalSignal.removeEventListener("abort", externalAbortListener);
      }
    }
  }
  throw new NetworkGuardError("request failed before receiving a response");
}

// ─── Internals ──────────────────────────────────────────────────────

async function resolveHostAddresses(host: string): Promise<string[]> {
  // `URL.hostname` keeps IPv6 brackets (e.g. "[::1]") — strip them
  // before handing to `isIPv4` / `isIPv6` / `dns.lookup`.
  const bare = stripIpv6Brackets(host);
  if (isIPv4(bare) || isIPv6(bare)) {
    return [bare];
  }
  const results = await dns.lookup(bare, { all: true, verbatim: true });
  return results.map((r) => r.address);
}

function stripIpv6Brackets(host: string): string {
  if (host.startsWith("[") && host.endsWith("]")) {
    return host.slice(1, -1);
  }
  return host;
}

function isPublicAddress(address: string): boolean {
  if (isIPv4(address)) {
    const num = ipv4ToBigInt(address);
    return !PRIVATE_IPV4_RANGES.some(
      ([start, end]) => num >= start && num <= end,
    );
  }
  if (isIPv6(address)) {
    const lower = address.toLowerCase();

    // Unspecified (::) + loopback (::1)
    if (lower === "::" || lower === "::1") return false;

    // IPv4-mapped IPv6 (::ffff:a.b.c.d or its normalized hex form).
    // Node's URL parser normalizes "::ffff:10.0.0.1" → "::ffff:a00:1",
    // so we recover the IPv4 bytes from the final 32 bits of the
    // expanded address instead of relying on dotted-quad detection.
    if (lower.startsWith("::ffff:")) {
      const ipv4 = ipv4FromMappedIpv6(lower);
      if (ipv4 !== null) return isPublicAddress(ipv4);
      return false;
    }

    // Link-local fe80::/10 — covers fe80..febf
    // First byte = 0xfe, top two bits of second byte = 10 →
    // second nibble is 8, 9, a, or b.
    if (
      lower.startsWith("fe8") ||
      lower.startsWith("fe9") ||
      lower.startsWith("fea") ||
      lower.startsWith("feb")
    ) {
      return false;
    }

    // Unique local address fc00::/7 (fc.. or fd..)
    if (lower.startsWith("fc") || lower.startsWith("fd")) return false;

    return true;
  }
  // Unknown address family → fail closed.
  return false;
}

/**
 * Extracts the dotted-quad IPv4 form from an `::ffff:...` mapped IPv6
 * address. Accepts both the dotted-quad form (`::ffff:10.0.0.1`) and
 * the normalized hex form Node's URL parser emits (`::ffff:a00:1`).
 * Returns `null` on malformed input.
 */
function ipv4FromMappedIpv6(lower: string): string | null {
  const tail = lower.slice(7); // after "::ffff:"
  // Dotted-quad form.
  if (isIPv4(tail)) return tail;
  // Hex form: one or two hex groups (each 1..4 chars) joined by ":".
  // Pad each group to 4 chars, concatenate to 8 hex digits, then
  // split into four bytes.
  const groups = tail.split(":");
  if (groups.length < 1 || groups.length > 2) return null;
  let hex = "";
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    hex += g.padStart(4, "0");
  }
  // After padding: 2 groups → 8 chars, 1 group → 4 chars (prepend 0000).
  if (hex.length === 4) hex = "0000" + hex;
  if (hex.length !== 8) return null;
  const b1 = parseInt(hex.slice(0, 2), 16);
  const b2 = parseInt(hex.slice(2, 4), 16);
  const b3 = parseInt(hex.slice(4, 6), 16);
  const b4 = parseInt(hex.slice(6, 8), 16);
  return `${b1}.${b2}.${b3}.${b4}`;
}

function ipv4ToBigInt(ip: string): bigint {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    throw new NetworkGuardError(`invalid IPv4 address: ${ip}`);
  }
  return BigInt(
    parts[0] * 16777216 + parts[1] * 65536 + parts[2] * 256 + parts[3],
  );
}
