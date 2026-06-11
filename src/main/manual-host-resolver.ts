/**
 * Manual host resolver — applies a user-configured /etc/hosts-style mapping
 * as a Chromium `host-resolver-rules` command-line switch.
 *
 * Only active when `authMode === "manual"` in the persisted LLM settings.
 * Demo mode (`authMode === "login"`) uses `LVIS_DEMO_HOST_MAP` exclusively
 * via `demo-host-resolver.ts`; this module is a no-op when demo mode is active.
 *
 * MUST be called before `app.whenReady()` — Chromium's command line is frozen
 * once the network service starts.
 *
 * Format of `hostResolverMap` (persisted in `~/.lvis/lvis-settings.json` at
 * `llm.hostResolverMap`): /etc/hosts-style text, one "IP hostname" entry per
 * line. Blank lines and lines starting with `#` are ignored. Malformed lines
 * (missing whitespace separator) are silently skipped.
 *
 * When both demo AND manual host maps are present, demo mode takes precedence
 * (the demo map is installed by `demo-host-resolver.ts` first; this function
 * is a no-op so the two maps never collide on the same switch).
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { App } from "electron";
import { createLogger } from "../lib/logger.js";

const log = createLogger("manual-host-resolver");

/** Build the `host-resolver-rules` switch value from [host, ip] pairs. */
function buildHostResolverRules(entries: ReadonlyArray<readonly [string, string]>): string {
  return entries.map(([host, ip]) => `MAP ${host} ${ip}`).join(",");
}

/**
 * Parse /etc/hosts-style text into [host, ip] pairs. Blank lines and lines
 * starting with `#` are skipped; malformed lines are silently dropped.
 */
export function parseHostsStyleText(raw: string): Array<readonly [string, string]> {
  const result: Array<readonly [string, string]> = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 2) continue;
    const ip = parts[0]!;
    const hostname = parts[1]!.toLowerCase();
    result.push([hostname, ip] as const);
  }
  return result;
}

/**
 * Read the persisted settings file and return `llm.hostResolverMap` if
 * present and `llm.authMode === "manual"`. Returns `undefined` when the
 * file is absent, unreadable, or the field is not set.
 *
 * Uses synchronous I/O because this is called before `app.whenReady()` —
 * the async boot pipeline has not started yet.
 */
function readPersistedManualHostMap(): string | undefined {
  const settingsPath = join(homedir(), ".lvis", "lvis-settings.json");
  if (!existsSync(settingsPath)) return undefined;
  try {
    const raw = readFileSync(settingsPath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const llm = parsed.llm as Record<string, unknown> | undefined;
    if (!llm) return undefined;
    if (llm.authMode !== "manual") return undefined;
    const map = llm.hostResolverMap;
    if (typeof map !== "string" || map.trim().length === 0) return undefined;
    return map;
  } catch {
    // Corrupt settings file — skip silently; the boot flow will surface
    // the JSON parse error through the normal settings service path.
    return undefined;
  }
}

/**
 * Apply the user-configured host-resolver map when `authMode === "manual"`
 * and a non-empty map is persisted. MUST be called before `app.whenReady()`.
 *
 * Returns `true` when the switch was applied, `false` when no-op (demo mode
 * active, no map configured, or map is empty after parsing).
 *
 * When demo mode is active (`LVIS_DEMO_VENDOR` is set in the environment),
 * this function is a no-op — the demo map takes precedence.
 */
export function applyManualHostResolverRules(
  app: Pick<App, "commandLine">,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  // Demo mode already installs its own host-resolver-rules; do not collide.
  if (env.LVIS_DEMO_VENDOR) {
    return false;
  }

  const rawMap = readPersistedManualHostMap();
  if (!rawMap) return false;

  const entries = parseHostsStyleText(rawMap);
  if (entries.length === 0) {
    log.info("manual host-resolver map present but no valid entries — skipping");
    return false;
  }

  const rules = buildHostResolverRules(entries);
  app.commandLine.appendSwitch("host-resolver-rules", rules);
  log.info(`manual host-resolver rules applied: ${entries.length} mapping(s)`);
  return true;
}
