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
 *   `host1.example.com=10.1.2.3,host2.example.com=10.1.2.4`
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
  const entries = parseHostMap(env.LVIS_DEMO_HOST_MAP);
  if (entries.length === 0) {
    log.info(
      "[demo-host-resolver] mapping skipped (LVIS_DEMO_HOST_MAP empty or unset)",
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
