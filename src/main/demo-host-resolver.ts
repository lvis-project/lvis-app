/**
 * Demo host resolver — Electron command-line switch that maps demo-mode
 * hostnames to intranet IPs *inside the Electron process only*. No
 * `/etc/hosts` mutation; no sudo.
 *
 * Path 2 hotfix (2026-05-19) — when the user runs LVIS in demo mode
 * (`LVIS_DEMO_VENDOR=azure-foundry`), Chromium's net stack resolves the
 * demo endpoint hostnames according to the mapping table loaded from the
 * gitignored `.env.demo` file (or `LVIS_DEMO_HOST_MAP` env var). Public
 * DNS records do not resolve these hostnames to the intranet IPs — the
 * demo endpoint is intranet-only — so the mapping is required for the
 * fetch path to reach the Azure Foundry service.
 *
 * MUST be invoked BEFORE `app.whenReady()` — Chromium's command line is
 * frozen once the network service spins up.
 *
 * Format of `LVIS_DEMO_HOST_MAP` (comma-separated `host=ip` pairs):
 *   `host1.example.com=10.0.0.3,host2.example.com=10.0.0.4`
 *
 * `LVIS_DEMO_HOST_SUBNET` (optional, comma-separated CIDRs) narrows which
 * target IPs the host map may point to. When absent, targets are confined to
 * the generic private (RFC1918) ranges. The exact intranet subnet is delivered
 * inside the encrypted activation key — never hardcoded here.
 *
 * No-op when:
 *   - `LVIS_DEMO_VENDOR !== "azure-foundry"` (other vendors don't need
 *     the mapping; their public DNS is reachable directly).
 *   - The env var was scrubbed (production builds where demo mode is off).
 *     In that case `getDemoActiveVendor()` returns the default. The caller
 *     gates on `process.env.LVIS_DEMO_VENDOR` *before* the scrub so we
 *     observe the original value.
 *   - `LVIS_DEMO_HOST_MAP` is empty (no mapping to apply).
 */
import type { App } from "electron";
import { createLogger } from "../lib/logger.js";
import { validateFoundryEndpoint } from "../permissions/reviewer/provider-adapters.js";

const log = createLogger("demo-host-resolver");

let appliedDemoHostResolverFingerprint: string | null = null;

/**
 * Parse a `LVIS_DEMO_HOST_MAP` value into `[host, ip]` pairs. Malformed
 * entries (missing `=`, empty host, empty ip) are silently dropped — the
 * caller logs the final applied count so a typo surfaces as a zero-count
 * "mapping skipped" line.
 */
function parseHostMap(raw: string | undefined): Array<[string, string]> {
  if (typeof raw !== "string" || raw.length === 0) return [];
  const pairs: Array<[string, string]> = [];
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0 || eq === trimmed.length - 1) continue;
    const host = trimmed.slice(0, eq).trim();
    const ip = trimmed.slice(eq + 1).trim();
    if (host.length === 0 || ip.length === 0) continue;
    pairs.push([host, ip]);
  }
  return pairs;
}

export function demoHostMapContainsHost(
  rawHostMap: string | undefined,
  rawUrlOrHost: string | undefined,
): boolean {
  if (typeof rawUrlOrHost !== "string" || rawUrlOrHost.length === 0) {
    return false;
  }
  let hostname: string;
  try {
    hostname = new URL(rawUrlOrHost).hostname.toLowerCase();
  } catch {
    hostname = rawUrlOrHost.toLowerCase();
  }
  return parseHostMap(rawHostMap).some(([host]) => host.toLowerCase() === hostname);
}

export type DemoFoundryHostMapError =
  | "missing-foundry-host-map"
  | "foundry-host-map-mismatch"
  | "invalid-foundry-host-map-target";

const FOUNDRY_HOST_SUFFIXES = [
  ".openai.azure.com",
  ".services.ai.azure.com",
  ".cognitiveservices.azure.com",
] as const;

/**
 * Allowed target subnets for host-map IPs when the activation payload does NOT
 * specify `LVIS_DEMO_HOST_SUBNET`. Confines host-map redirects to the generic
 * private (RFC1918) ranges — intranet space only, never public IPs. No
 * organisation-specific subnet is baked into source; the exact (narrower)
 * intranet range is delivered inside the encrypted activation key.
 */
const DEFAULT_ALLOWED_SUBNETS = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"] as const;

/** Parse a dotted-quad IPv4 into an unsigned 32-bit number, or null if invalid. */
function parseIpv4(ip: string): number | null {
  const octets = ip.split(".");
  if (octets.length !== 4) return null;
  let value = 0;
  for (const part of octets) {
    const n = Number.parseInt(part, 10);
    if (!Number.isInteger(n) || n < 0 || n > 255 || String(n) !== part) return null;
    value = (value * 256 + n) >>> 0;
  }
  return value >>> 0;
}

/** Parse a `base/prefix` CIDR into its network base + mask, or null if invalid. */
function parseCidr(cidr: string): { base: number; mask: number } | null {
  const slash = cidr.indexOf("/");
  if (slash <= 0) return null;
  const base = parseIpv4(cidr.slice(0, slash).trim());
  const prefix = Number.parseInt(cidr.slice(slash + 1).trim(), 10);
  if (base === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return { base: (base & mask) >>> 0, mask };
}

/**
 * `true` only when `cidr` is a strict subset of one of the private (RFC1918)
 * ranges — i.e. EVERY address it covers is private. Rejects `0.0.0.0/0`, public
 * CIDRs, and any CIDR broader than (or straddling) an RFC1918 boundary. This is
 * the guard against a misissued/typo'd activation key widening the host-resolver
 * allow-list to a public target, which would let it redirect the Foundry
 * hostname off-network and leak the request (and bearer credentials) to an
 * arbitrary public IP.
 */
function isCidrWithinRfc1918(cidr: string): boolean {
  const c = parseCidr(cidr);
  if (c === null) return false;
  return DEFAULT_ALLOWED_SUBNETS.some((rangeCidr) => {
    const r = parseCidr(rangeCidr);
    if (r === null) return false;
    // c ⊆ r iff c is at least as specific as r (r's mask bits ⊆ c's mask bits)
    // AND c's network base falls inside r.
    return ((c.mask & r.mask) >>> 0) === (r.mask >>> 0) && ((c.base & r.mask) >>> 0) === r.base;
  });
}

/**
 * Parse the activation-provided allowed-subnet list (comma-separated CIDRs,
 * e.g. `10.0.0.0/24`). Entries that are malformed OR not a strict subset of an
 * RFC1918 private range are dropped (a public target is never legitimate — the
 * whole point is intranet-only redirection). Empty/absent yields `[]`; the
 * caller ({@link resolveAllowedSubnets}) distinguishes "absent" (→ RFC1918
 * fallback) from "present-but-all-dropped" (→ fail closed).
 */
export function parseAllowedSubnets(raw: string | undefined): string[] {
  if (typeof raw !== "string" || raw.trim().length === 0) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && isCidrWithinRfc1918(s));
}

/**
 * The effective allowed-subnet list:
 *   - subnet NOT provided (absent/empty) → the generic private (RFC1918) ranges
 *     (backward compatible — keys issued before LVIS_DEMO_HOST_SUBNET existed).
 *   - subnet provided and at least one CIDR parses → those CIDR(s).
 *   - subnet provided but ENTIRELY unparseable → `null` = FAIL CLOSED. A typo'd
 *     narrowing directive (e.g. "10.182.192/24", "/24") must never silently
 *     widen back to the broad default — that would invert the security intent
 *     (narrowing the SSRF target set). The host map is rejected instead.
 */
function resolveAllowedSubnets(rawHostSubnet: string | undefined): readonly string[] | null {
  const isProvided = typeof rawHostSubnet === "string" && rawHostSubnet.trim().length > 0;
  if (!isProvided) return DEFAULT_ALLOWED_SUBNETS;
  const provided = parseAllowedSubnets(rawHostSubnet);
  if (provided.length === 0) {
    log.warn(
      "[demo-host-resolver] LVIS_DEMO_HOST_SUBNET provided but no valid CIDR parsed — failing closed (host map rejected)",
    );
    return null;
  }
  return provided;
}

/**
 * `allowedSubnets === null` is the fail-closed sentinel (a present-but-malformed
 * subnet directive): every target is rejected.
 */
function isAllowedDemoHostMapTarget(ip: string, allowedSubnets: readonly string[] | null): boolean {
  if (allowedSubnets === null) return false;
  const value = parseIpv4(ip);
  if (value === null) return false;
  return allowedSubnets.some((cidr) => {
    const parsed = parseCidr(cidr);
    return parsed !== null && ((value & parsed.mask) >>> 0) === parsed.base;
  });
}

function findInvalidDemoHostMapTarget(
  entries: ReadonlyArray<readonly [string, string]>,
  allowedSubnets: readonly string[] | null,
): readonly [string, string] | null {
  // With the fail-closed sentinel (null), every target is rejected, so the
  // first entry is returned as the offending one.
  return entries.find(([, ip]) => !isAllowedDemoHostMapTarget(ip, allowedSubnets)) ?? null;
}

function foundryResourcePrefix(host: string): string | null {
  const normalized = host.toLowerCase();
  const suffix = FOUNDRY_HOST_SUFFIXES.find((candidate) =>
    normalized.endsWith(candidate),
  );
  if (suffix === undefined) return null;
  const prefix = normalized.slice(0, normalized.length - suffix.length);
  if (prefix.length === 0) return null;
  return prefix;
}

function allowedFoundryHostMapHosts(endpointHost: string): Set<string> | null {
  const prefix = foundryResourcePrefix(endpointHost);
  if (prefix === null) return null;
  return new Set(FOUNDRY_HOST_SUFFIXES.map((suffix) => `${prefix}${suffix}`));
}

function findDisallowedDemoHostMapHost(
  endpointHost: string,
  entries: ReadonlyArray<readonly [string, string]>,
): readonly [string, string] | null {
  const allowedHosts = allowedFoundryHostMapHosts(endpointHost);
  if (allowedHosts === null) return entries[0] ?? null;
  return entries.find(([host]) => !allowedHosts.has(host.toLowerCase())) ?? null;
}

function validatedFoundryEndpointHost(baseUrl: string | undefined): string | null {
  if (typeof baseUrl !== "string" || baseUrl.length === 0) return null;
  try {
    validateFoundryEndpoint(baseUrl);
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function validateDemoFoundryHostMap(
  baseUrl: string | undefined,
  rawHostMap: string | undefined,
  rawHostSubnet?: string,
): DemoFoundryHostMapError | null {
  if (typeof baseUrl !== "string" || baseUrl.length === 0) return null;
  let endpointHost: string;
  try {
    endpointHost = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return null;
  }

  const allowedSubnets = resolveAllowedSubnets(rawHostSubnet);
  const entries = parseHostMap(rawHostMap);
  if (entries.length === 0) return "missing-foundry-host-map";
  if (findInvalidDemoHostMapTarget(entries, allowedSubnets) !== null) {
    return "invalid-foundry-host-map-target";
  }
  if (findDisallowedDemoHostMapHost(endpointHost, entries) !== null) {
    return "foundry-host-map-mismatch";
  }
  const match = entries.find(([host]) => host.toLowerCase() === endpointHost);
  if (!match) return "foundry-host-map-mismatch";
  return null;
}

/**
 * Build the `host-resolver-rules` switch value from `[host, ip]` pairs.
 * Format: comma-separated `MAP <host> <ip>` clauses (Chromium net stack
 * `--host-resolver-rules`).
 */
function buildHostResolverRules(
  entries: ReadonlyArray<readonly [string, string]>,
): string {
  return entries.map(([host, ip]) => `MAP ${host} ${ip}`).join(",");
}

function normalizedHostMapEntries(
  entries: ReadonlyArray<readonly [string, string]>,
): Array<readonly [string, string]> {
  return entries
    .map(([host, ip]) => [host.toLowerCase(), ip] as const)
    .sort(([leftHost, leftIp], [rightHost, rightIp]) => {
      const hostOrder = leftHost.localeCompare(rightHost);
      if (hostOrder !== 0) return hostOrder;
      return leftIp.localeCompare(rightIp);
    });
}

export function demoFoundryHostMapFingerprint(
  baseUrl: string | undefined,
  rawHostMap: string | undefined,
  rawHostSubnet?: string,
): string | null {
  const endpointHost = validatedFoundryEndpointHost(baseUrl);
  if (endpointHost === null) return null;

  const allowedSubnets = resolveAllowedSubnets(rawHostSubnet);
  const entries = parseHostMap(rawHostMap);
  if (entries.length === 0) return null;
  if (findInvalidDemoHostMapTarget(entries, allowedSubnets) !== null) return null;
  if (findDisallowedDemoHostMapHost(endpointHost, entries) !== null) {
    return null;
  }
  if (!entries.some(([host]) => host.toLowerCase() === endpointHost)) {
    return null;
  }
  return `${endpointHost}|${buildHostResolverRules(normalizedHostMapEntries(entries))}`;
}

export function getAppliedDemoHostResolverFingerprint(): string | null {
  return appliedDemoHostResolverFingerprint;
}

/**
 * Apply the demo host-resolver mapping when `LVIS_DEMO_VENDOR=azure-foundry`
 * and `LVIS_DEMO_HOST_MAP` is non-empty. MUST be called before
 * `app.whenReady()`.
 *
 * Returns `true` when the switch was applied, `false` when no-op (vendor
 * mismatch, demo not enabled, or empty map).
 */
export function applyDemoHostResolverRules(
  app: Pick<App, "commandLine">,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  appliedDemoHostResolverFingerprint = null;
  if (env.LVIS_DEMO_VENDOR !== "azure-foundry") {
    return false;
  }
  const baseUrl =
    env.LVIS_DEMO_BASEURL_AZURE_FOUNDRY ??
    env.LVIS_DEMO_ENDPOINT_AZURE_FOUNDRY;
  const allowedSubnets = resolveAllowedSubnets(env.LVIS_DEMO_HOST_SUBNET);
  const fingerprint = demoFoundryHostMapFingerprint(
    baseUrl,
    env.LVIS_DEMO_HOST_MAP,
    env.LVIS_DEMO_HOST_SUBNET,
  );
  if (fingerprint === null) {
    log.info(
      "[demo-host-resolver] mapping skipped (endpoint/host-map invalid or mismatched)",
    );
    return false;
  }
  const entries = parseHostMap(env.LVIS_DEMO_HOST_MAP);
  if (entries.length === 0) {
    log.info(
      "[demo-host-resolver] mapping skipped (LVIS_DEMO_HOST_MAP empty or unset)",
    );
    return false;
  }
  const invalidTarget = findInvalidDemoHostMapTarget(entries, allowedSubnets);
  if (invalidTarget !== null) {
    log.warn(
      `[demo-host-resolver] mapping skipped (host-map target outside approved demo subnet for ${invalidTarget[0]})`,
    );
    return false;
  }
  const rules = buildHostResolverRules(entries);
  app.commandLine.appendSwitch("host-resolver-rules", rules);
  appliedDemoHostResolverFingerprint = fingerprint;
  log.info(
    `[demo-host-resolver] mapping applied: ${entries.length} host(s) → intranet`,
  );
  return true;
}

export function _testOnlyResetAppliedDemoHostResolverFingerprint(): void {
  appliedDemoHostResolverFingerprint = null;
}

/** Test-only — expose the parser so unit tests can assert format handling. */
export const _testOnlyParseHostMap = parseHostMap;
/** Test-only — expose the rules-builder so unit tests can assert format. */
export const _testOnlyBuildHostResolverRules = buildHostResolverRules;
