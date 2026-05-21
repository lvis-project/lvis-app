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
 *   `host1.example.com=10.182.192.3,host2.example.com=10.182.192.4`
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

function isAllowedDemoHostMapTarget(ip: string): boolean {
  const octets = ip.split(".");
  if (octets.length !== 4) return false;
  const nums = octets.map((part) => Number.parseInt(part, 10));
  if (
    nums.some((n, idx) => !Number.isInteger(n) || n < 0 || n > 255 || String(n) !== octets[idx])
  ) {
    return false;
  }
  return (
    nums[0] === 10 &&
    nums[1] === 182 &&
    nums[2] === 192 &&
    nums[3] >= 1 &&
    nums[3] <= 254
  );
}

function findInvalidDemoHostMapTarget(
  entries: ReadonlyArray<readonly [string, string]>,
): readonly [string, string] | null {
  return entries.find(([, ip]) => !isAllowedDemoHostMapTarget(ip)) ?? null;
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
): DemoFoundryHostMapError | null {
  if (typeof baseUrl !== "string" || baseUrl.length === 0) return null;
  let endpointHost: string;
  try {
    endpointHost = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return null;
  }

  const entries = parseHostMap(rawHostMap);
  if (entries.length === 0) return "missing-foundry-host-map";
  if (findInvalidDemoHostMapTarget(entries) !== null) {
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
): string | null {
  const endpointHost = validatedFoundryEndpointHost(baseUrl);
  if (endpointHost === null) return null;

  const entries = parseHostMap(rawHostMap);
  if (entries.length === 0) return null;
  if (findInvalidDemoHostMapTarget(entries) !== null) return null;
  if (findDisallowedDemoHostMapHost(endpointHost, entries) !== null) {
    return null;
  }
  if (!entries.some(([host]) => host.toLowerCase() === endpointHost)) {
    return null;
  }
  return `${endpointHost}|${buildHostResolverRules(normalizedHostMapEntries(entries))}`;
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
  if (env.LVIS_DEMO_VENDOR !== "azure-foundry") {
    return false;
  }
  const baseUrl =
    env.LVIS_DEMO_BASEURL_AZURE_FOUNDRY ??
    env.LVIS_DEMO_ENDPOINT_AZURE_FOUNDRY;
  if (demoFoundryHostMapFingerprint(baseUrl, env.LVIS_DEMO_HOST_MAP) === null) {
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
  const invalidTarget = findInvalidDemoHostMapTarget(entries);
  if (invalidTarget !== null) {
    log.warn(
      `[demo-host-resolver] mapping skipped (host-map target outside approved demo subnet for ${invalidTarget[0]})`,
    );
    return false;
  }
  const rules = buildHostResolverRules(entries);
  app.commandLine.appendSwitch("host-resolver-rules", rules);
  log.info(
    `[demo-host-resolver] mapping applied: ${entries.length} host(s) → intranet`,
  );
  return true;
}

/** Test-only — expose the parser so unit tests can assert format handling. */
export const _testOnlyParseHostMap = parseHostMap;
/** Test-only — expose the rules-builder so unit tests can assert format. */
export const _testOnlyBuildHostResolverRules = buildHostResolverRules;
