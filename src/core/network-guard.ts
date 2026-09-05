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
 *      loopback / link-local / ULA address (IPv4 + IPv6 + IPv4-mapped),
 *      unless the caller explicitly opts into private network access.
 *   3. {@link fetchPublicHttpResponse} — drop-in replacement for
 *      `fetch` that validates every hop of a redirect chain (defense
 *      against DNS rebinding + CRLF location injection) and enforces
 *      a timeout.
 *
 * Node stdlib only (`node:dns`, `node:net`, built-in `fetch`).
 */
import { promises as dns } from "node:dns";
import { isIPv4, isIPv6 } from "node:net";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";

export class NetworkGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkGuardError";
  }
}

export interface NetworkGuardOptions {
  /**
   * Allows RFC1918 IPv4 and IPv6 ULA addresses after an upstream approval
   * gate has authorized the request. A predicate scopes that approval to
   * the current redirect hop URL. Loopback, link-local, metadata, CGNAT
   * (see {@link allowCarrierGradeNat}), and 0.0.0.0/8 remain blocked.
   */
  allowPrivateNetworks?: boolean | ((url: URL) => boolean);
  /**
   * Allows loopback addresses after a separate local-development approval
   * gate has authorized the request. A predicate scopes that approval to the
   * current redirect hop URL. Link-local, metadata, CGNAT, and 0.0.0.0/8
   * remain blocked.
   */
  allowLoopback?: boolean | ((url: URL) => boolean);
  /**
   * Allows CGNAT addresses (100.64.0.0/10) after an explicit endpoint trust
   * decision has authorized the request. A predicate scopes that approval to
   * the current redirect hop URL. Loopback, link-local, metadata, RFC1918, and
   * 0.0.0.0/8 remain blocked.
   *
   * Its own axis rather than a widening of {@link allowPrivateNetworks}: this
   * is the range an authenticated overlay network (tailnet) draws peer
   * addresses from, and it is also what a carrier hands out ahead of a NAT the
   * host does not control. A caller that trusts its own LAN must not silently
   * inherit the overlay, and a caller that trusts one named overlay peer must
   * not silently inherit the LAN.
   */
  allowCarrierGradeNat?: boolean | ((url: URL) => boolean);
}

type NetworkGuardFetchInit = RequestInit & NetworkGuardOptions & {
  /**
   * The transport this request runs on. REQUIRED, and deliberately without a
   * default.
   *
   * It used to default to the ambient `fetch`, which is Node's — a stack that
   * reads neither the machine's proxy configuration nor its trust store. A
   * caller that passed the guard but forgot the transport therefore went out
   * direct, on a path the user never chose, and said nothing about it. The
   * guard is the one place every caller here already passes through, so the
   * requirement lives here: forgetting the transport is now a compile error
   * rather than a silent route change.
   */
  fetchImpl: typeof fetch;
  maxRedirects?: number;
  timeoutMs?: number;
};

// ─── Private / reserved IPv4 ranges (RFC 1918, 5735, 6598, 3927) ────
const RFC1918_IPV4_RANGES: Array<[bigint, bigint]> = [
  // 10.0.0.0/8
  [ipv4ToBigInt("10.0.0.0"), ipv4ToBigInt("10.255.255.255")],
  // 172.16.0.0/12
  [ipv4ToBigInt("172.16.0.0"), ipv4ToBigInt("172.31.255.255")],
  // 192.168.0.0/16
  [ipv4ToBigInt("192.168.0.0"), ipv4ToBigInt("192.168.255.255")],
];

// 100.64.0.0/10 (CGNAT) — also the tailnet peer range.
const CGNAT_IPV4_RANGE: [bigint, bigint] = [
  ipv4ToBigInt("100.64.0.0"),
  ipv4ToBigInt("100.127.255.255"),
];



// ─── IANA special-purpose address registry ─────────────────────────────
/**
 * The blocks IANA records as special-purpose, with the entries it marks
 * "globally reachable: True" carved back out.
 *
 * The RFC1918 ranges above answer "is this the user's own network?", which is
 * a question with a legitimate yes: a caller can opt into it. These answer a
 * different one — "could a packet to this address reach a host on the public
 * internet at all?" — and for documentation, benchmarking, multicast and
 * reserved space the answer is no under any option. Keeping the two sets
 * apart is what lets `allowPrivateNetworks` open a LAN without also opening
 * 224.0.0.0/4.
 *
 * Written as CIDR text rather than packed integers so each line can be read
 * against the registry it came from.
 */
const SPECIAL_PURPOSE_IPV4 = [
  "0.0.0.0/8", // this network
  "10.0.0.0/8", // private-use
  "100.64.0.0/10", // shared address space (CGNAT) — also the tailnet peer range
  "127.0.0.0/8", // loopback
  "169.254.0.0/16", // link-local, including the 169.254.169.254 metadata service
  "172.16.0.0/12", // private-use
  "192.0.0.0/24", // IETF protocol assignments
  "192.0.2.0/24", // documentation (TEST-NET-1)
  "192.88.99.0/24", // 6to4 relay anycast (deprecated)
  "192.168.0.0/16", // private-use
  "198.18.0.0/15", // benchmarking
  "198.51.100.0/24", // documentation (TEST-NET-2)
  "203.0.113.0/24", // documentation (TEST-NET-3)
  "224.0.0.0/4", // multicast
  "240.0.0.0/4", // reserved, including the 255.255.255.255 broadcast address
] as const;

/** Special-purpose IPv4 entries IANA still marks globally reachable. */
const GLOBALLY_REACHABLE_IPV4 = [
  "192.0.0.9/32", // PCP anycast
  "192.0.0.10/32", // NAT64/DNS64 discovery
  "192.31.196.0/24", // AS112-v4
  "192.52.193.0/24", // AMT
  "192.175.48.0/24", // direct delegation AS112 service
] as const;

const SPECIAL_PURPOSE_IPV6 = [
  "2001::/23", // IETF protocol assignments
  "2001:db8::/32", // documentation
  "2002::/16", // 6to4 (deprecated)
  "3fff::/20", // documentation
  "5f00::/16", // segment routing (SRv6) SIDs
] as const;

/** Special-purpose IPv6 entries IANA still marks globally reachable. */
const GLOBALLY_REACHABLE_IPV6 = [
  "64:ff9b::/96", // NAT64 — outside 2000::/3, so it needs the exception to pass
  "2001:1::1/128", // PCP anycast
  "2001:1::2/128", // TURN anycast
  "2001:1::3/128", // DNS-SD service registration
  "2001:3::/32", // AMT
  "2001:4:112::/48", // AS112-v6
  "2001:20::/28", // ORCHIDv2
  "2001:30::/28", // drone remote-id
  "2620:4f:8000::/48", // direct delegation AS112 service
] as const;

/** Global unicast — everything a public IPv6 destination must be inside. */
const GLOBAL_UNICAST_IPV6 = "2000::/3";

/**
 * The three ranges a caller can OPT INTO. They are matched by their own
 * predicates rather than by "not globally routable", so tightening the
 * routable answer above can never widen what an opt-in reaches.
 */
const LOOPBACK_IPV4 = "127.0.0.0/8";
const LOOPBACK_IPV6 = "::1/128";
const UNIQUE_LOCAL_IPV6 = "fc00::/7";

interface AddressBlock {
  network: bigint;
  prefix: number;
  /** 32 for IPv4, 128 for IPv6 — the width the prefix is measured against. */
  bits: 32 | 128;
}

function parseIpv4Block(cidr: string): AddressBlock {
  const [address, prefix] = cidr.split("/");
  return { network: ipv4ToBigInt(address!), prefix: Number(prefix), bits: 32 };
}

function parseIpv6Block(cidr: string): AddressBlock {
  const [address, prefix] = cidr.split("/");
  const network = ipv6ToBigInt(address!);
  if (network === null) throw new NetworkGuardError(`invalid IPv6 block: ${cidr}`);
  return { network, prefix: Number(prefix), bits: 128 };
}

function inBlock(value: bigint, block: AddressBlock): boolean {
  const shift = BigInt(block.bits - block.prefix);
  return value >> shift === block.network >> shift;
}

const SPECIAL_PURPOSE_IPV4_BLOCKS = SPECIAL_PURPOSE_IPV4.map(parseIpv4Block);
const GLOBALLY_REACHABLE_IPV4_BLOCKS = GLOBALLY_REACHABLE_IPV4.map(parseIpv4Block);
const SPECIAL_PURPOSE_IPV6_BLOCKS = SPECIAL_PURPOSE_IPV6.map(parseIpv6Block);
const GLOBALLY_REACHABLE_IPV6_BLOCKS = GLOBALLY_REACHABLE_IPV6.map(parseIpv6Block);
const GLOBAL_UNICAST_IPV6_BLOCK = parseIpv6Block(GLOBAL_UNICAST_IPV6);
const LOOPBACK_IPV4_BLOCK = parseIpv4Block(LOOPBACK_IPV4);
const LOOPBACK_IPV6_BLOCK = parseIpv6Block(LOOPBACK_IPV6);
const UNIQUE_LOCAL_IPV6_BLOCK = parseIpv6Block(UNIQUE_LOCAL_IPV6);

/**
 * Expand an IPv6 literal to its 128 bits, or `null` when it is malformed.
 *
 * Textual prefix tests do not survive contact with the address forms a URL can
 * carry: `::1` and `0:0:0:0:0:0:0:1` name the same host, a zone id can be
 * appended, and `::ffff:1.2.3.4` embeds a dotted quad. Expanding once and
 * comparing numbers is the only form that answers the same for all of them.
 */
function ipv6ToBigInt(address: string): bigint | null {
  let input = address.toLowerCase().split("%")[0]!;
  const embeddedIpv4 = input.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (embeddedIpv4) {
    if (!isIPv4(embeddedIpv4[2]!)) return null;
    const packed = ipv4ToBigInt(embeddedIpv4[2]!);
    const high = (packed >> 16n) & 0xffffn;
    const low = packed & 0xffffn;
    input = `${embeddedIpv4[1]}${high.toString(16)}:${low.toString(16)}`;
  }
  const halves = input.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1]!.split(":") : [];
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const parts = [...left, ...Array(Math.max(0, missing)).fill("0"), ...right];
  if (parts.length !== 8 || parts.some((part) => !/^[a-f0-9]{1,4}$/.test(part))) return null;
  return parts.reduce((value, part) => (value << 16n) | BigInt(Number.parseInt(part, 16)), 0n);
}

/**
 * Can a packet to `address` reach a host on the public internet?
 *
 * This is the shared answer for every caller that has to refuse a destination
 * the user did not choose — the SSRF guard below, and the A2A remote transport
 * in `api/a2a-remote-transport.ts`, which used to carry a second copy. Two
 * copies of this question is one classifier more than the codebase can keep
 * consistent: they disagreed on multicast, on reserved space, and on every
 * IPv6 address outside global unicast, so the two subsystems refused different
 * sets while both looked like they were asking the same thing.
 *
 * IPv4 is a deny-list because the registry is: anything not recorded as
 * special-purpose is routable. IPv6 is an allow-list — global unicast, minus
 * the special-purpose blocks inside it — because the address space is mostly
 * unassigned, and unassigned is not the same as reachable.
 */
export function isGloballyRoutableAddress(address: string): boolean {
  if (isIPv4(address)) {
    const value = ipv4ToBigInt(address);
    if (GLOBALLY_REACHABLE_IPV4_BLOCKS.some((block) => inBlock(value, block))) return true;
    return !SPECIAL_PURPOSE_IPV4_BLOCKS.some((block) => inBlock(value, block));
  }
  if (isIPv6(address)) {
    const value = ipv6ToBigInt(address);
    if (value === null) return false;
    if (GLOBALLY_REACHABLE_IPV6_BLOCKS.some((block) => inBlock(value, block))) return true;
    if (!inBlock(value, GLOBAL_UNICAST_IPV6_BLOCK)) return false;
    return !SPECIAL_PURPOSE_IPV6_BLOCKS.some((block) => inBlock(value, block));
  }
  // Unknown address family → fail closed.
  return false;
}

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
 * host resolves to a public address, or to an explicitly approved
 * private-network address.
 */
export async function ensurePublicHttpUrl(
  rawUrl: string,
  options: NetworkGuardOptions = {},
): Promise<URL> {
  const parsed = validateHttpUrl(rawUrl);
  const addresses = await resolveHostAddresses(parsed.hostname);
  if (addresses.length === 0) {
    throw new NetworkGuardError(`target host did not resolve: ${parsed.hostname}`);
  }
  const scope: AllowedAddressScope = {
    allowPrivateNetworks: resolveScope(options.allowPrivateNetworks, parsed),
    allowLoopback: resolveScope(options.allowLoopback, parsed),
    allowCarrierGradeNat: resolveScope(options.allowCarrierGradeNat, parsed),
  };
  const blocked = addresses.filter((addr) => !isAllowedAddress(addr, scope));
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
 * Does `host` land EXCLUSIVELY on this machine?
 *
 * The question {@link ensurePublicHttpUrl} cannot answer: it says "no blocked
 * address here", and a public address is never blocked — so a name that has
 * been poisoned or rebound to a routable host passes it. A caller that is
 * about to do something only safe on the local machine (send cleartext, for
 * one) needs the positive form instead, and gets it from the same resolution
 * and the same loopback predicate the SSRF layer uses — no second notion of
 * "loopback" anywhere.
 *
 * Fails closed: an unresolvable host, or one that answers with nothing, is
 * unproven and therefore not loopback.
 */
export async function resolvesToLoopbackOnly(host: string): Promise<boolean> {
  let addresses: string[];
  try {
    addresses = await resolveHostAddresses(host);
  } catch {
    return false;
  }
  return addresses.length > 0 && addresses.every(isLoopbackAddress);
}

/**
 * Does `host` land EXCLUSIVELY on the private network (or this machine)?
 *
 * The second positive form, for the second cleartext exemption: a plugin the
 * user granted `allowPrivateNetworks` may speak http to an INTRANET host,
 * because bytes that never cross the public internet have nothing for https
 * to protect them from on the way. That sentence is only true if every
 * address behind the name is actually private — a name with one public
 * address would put cleartext on the open wire — so this proves the positive
 * with the same resolution and the same classifiers the SSRF layer uses.
 *
 * Loopback counts toward THE PROOF — those bytes stay local — but passing
 * this proof does not reach loopback: whether 127.0.0.1 is reachable at all
 * stays the SSRF layer's decision, under the separate declared-literal grant.
 * A split-horizon name answering 127.0.0.1 alongside 10.x proves private here
 * and is then refused there. Link-local and CGNAT do NOT count — 169.254.x
 * is where cloud metadata lives, and neither range is what "the user's
 * intranet" means.
 *
 * Fails closed: unresolvable, or resolving to nothing, is unproven.
 */
export async function resolvesToPrivateNetworkOnly(host: string): Promise<boolean> {
  let addresses: string[];
  try {
    addresses = await resolveHostAddresses(host);
  } catch {
    return false;
  }
  return (
    addresses.length > 0
    && addresses.every(
      (address) => isPrivateNetworkAddress(address) || isLoopbackAddress(address),
    )
  );
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
  init: NetworkGuardFetchInit,
): Promise<Response> {
  const {
    allowPrivateNetworks = false,
    allowLoopback = false,
    allowCarrierGradeNat = false,
    fetchImpl,
    maxRedirects = 5,
    timeoutMs = TOOL_TIMEOUT_POLICY.networkFetchDefaultMs,
    signal: externalSignal,
    ...restInit
  } = init;
  let currentUrl = rawUrl;

  // Unbounded loop: the redirect cap is enforced by the single `hop >= maxRedirects`
  // check below. The last permitted hop (hop === maxRedirects) always returns a final
  // response or throws, so control never falls through past the loop.
  for (let hop = 0; ; hop++) {
    await ensurePublicHttpUrl(currentUrl, {
      allowPrivateNetworks,
      allowLoopback,
      allowCarrierGradeNat,
    });
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
      const response = await fetchImpl(currentUrl, {
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

/**
 * The SSRF layer's default verdict. Every axis a caller can opt into
 * (`allowPrivateNetworks`, `allowLoopback`, `allowCarrierGradeNat`) is
 * checked separately in `isAllowedAddress` against its own range, so
 * narrowing this function narrows only what passes WITHOUT an opt-in.
 */
function isPublicAddress(address: string): boolean {
  return isGloballyRoutableAddress(address);
}

/** Each axis already resolved against the current hop URL. */
interface AllowedAddressScope {
  allowPrivateNetworks: boolean;
  allowLoopback: boolean;
  allowCarrierGradeNat: boolean;
}

function resolveScope(
  option: boolean | ((url: URL) => boolean) | undefined,
  url: URL,
): boolean {
  if (option === true) return true;
  return typeof option === "function" && option(url);
}

function isAllowedAddress(address: string, scope: AllowedAddressScope): boolean {
  if (isPublicAddress(address)) return true;
  if (scope.allowLoopback && isLoopbackAddress(address)) return true;
  if (scope.allowCarrierGradeNat && isCarrierGradeNatAddress(address)) return true;
  if (!scope.allowPrivateNetworks) return false;
  return isPrivateNetworkAddress(address);
}

function isCarrierGradeNatAddress(address: string): boolean {
  if (isIPv4(address)) {
    const num = ipv4ToBigInt(address);
    return num >= CGNAT_IPV4_RANGE[0] && num <= CGNAT_IPV4_RANGE[1];
  }
  if (isIPv6(address) && address.toLowerCase().startsWith("::ffff:")) {
    const ipv4 = ipv4FromMappedIpv6(address.toLowerCase());
    return ipv4 !== null && isCarrierGradeNatAddress(ipv4);
  }
  return false;
}

function isLoopbackAddress(address: string): boolean {
  if (isIPv4(address)) return inBlock(ipv4ToBigInt(address), LOOPBACK_IPV4_BLOCK);
  if (isIPv6(address)) {
    const lower = address.toLowerCase();
    if (lower.startsWith("::ffff:")) {
      const ipv4 = ipv4FromMappedIpv6(lower);
      return ipv4 !== null && isLoopbackAddress(ipv4);
    }
    const value = ipv6ToBigInt(lower);
    return value !== null && inBlock(value, LOOPBACK_IPV6_BLOCK);
  }
  return false;
}

function isPrivateNetworkAddress(address: string): boolean {
  if (isIPv4(address)) return isRfc1918Ipv4(address);
  if (isIPv6(address)) {
    const lower = address.toLowerCase();
    if (lower.startsWith("::ffff:")) {
      const ipv4 = ipv4FromMappedIpv6(lower);
      return ipv4 !== null && isRfc1918Ipv4(ipv4);
    }
    const value = ipv6ToBigInt(lower);
    return value !== null && inBlock(value, UNIQUE_LOCAL_IPV6_BLOCK);
  }
  return false;
}

function isRfc1918Ipv4(address: string): boolean {
  const num = ipv4ToBigInt(address);
  return RFC1918_IPV4_RANGES.some(([start, end]) => num >= start && num <= end);
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
