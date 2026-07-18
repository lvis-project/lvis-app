/**
 * Manual host resolver — applies a user-configured /etc/hosts-style mapping
 * as a Chromium `host-resolver-rules` command-line switch.
 *
 * Applies whenever a valid map is persisted in the LLM settings.
 *
 * MUST be called before `app.whenReady()` — Chromium's command line is frozen
 * once the network service starts.
 *
 * Format of `hostResolverMap` (persisted at `llm.hostResolverMap` in the app
 * settings file `<userData>/lvis-settings.json`, where `<userData>` is
 * `app.getPath("userData")`): /etc/hosts-style text, one "IP hostname" entry
 * per line. Blank lines and lines starting with `#` are ignored. Structurally
 * malformed lines (bad IPv4, non-DNS hostname, extra tokens) are skipped —
 * see {@link parseHostResolverMap}.
 *
 */
import { existsSync, readFileSync } from "node:fs";
import type { App } from "electron";
import { settingsFilePath } from "../data/settings-store.js";
import { parseHostResolverMap, type HostResolverMapEntry } from "../shared/host-resolver-map.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("manual-host-resolver");

const appliedHostnames = new Set<string>();

/** Whether a URL is covered by the map applied before Chromium network boot. */
export function isAppliedManualHostResolverUrl(value: string): boolean {
  try {
    return appliedHostnames.has(new URL(value).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** Build the `host-resolver-rules` switch value from parsed entries. */
function buildHostResolverRules(entries: ReadonlyArray<HostResolverMapEntry>): string {
  return entries.map(({ hostname, ip }) => `MAP ${hostname} ${ip}`).join(",");
}

/**
 * Read the app settings file and return `llm.hostResolverMap` if present.
 * Returns `undefined` when the file is absent, unreadable, or the field is not set.
 *
 * Reads from `settingsFilePath(userDataPath)` — the same path the
 * `SettingsService` writes to — so a map saved via the UI is the one applied
 * on the next boot.
 *
 * Uses synchronous I/O because this is called before `app.whenReady()` —
 * the async boot pipeline has not started yet.
 */
function readPersistedManualHostMap(userDataPath: string): string | undefined {
  const settingsPath = settingsFilePath(userDataPath);
  if (!existsSync(settingsPath)) return undefined;
  try {
    const raw = readFileSync(settingsPath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const llm = parsed.llm as Record<string, unknown> | undefined;
    if (!llm) return undefined;
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
 * Apply a user-configured non-empty host-resolver map before `app.whenReady()`.
 *
 * `userDataPath` is `app.getPath("userData")` — the directory the
 * `SettingsService` persists to. Threading it through (rather than
 * hardcoding a path) keeps the reader and writer on the same file.
 *
 * Returns `true` when the switch was applied, `false` when no map is configured
 */
export function applyManualHostResolverRules(
  app: Pick<App, "commandLine">,
  userDataPath: string,
): boolean {
  appliedHostnames.clear();
  const rawMap = readPersistedManualHostMap(userDataPath);
  if (!rawMap) return false;

  const entries = parseHostResolverMap(rawMap);
  if (entries.length === 0) {
    log.info("manual host-resolver map present but no valid entries — skipping");
    return false;
  }

  const rules = buildHostResolverRules(entries);
  for (const { hostname } of entries) {
    appliedHostnames.add(hostname);
  }
  app.commandLine.appendSwitch("host-resolver-rules", rules);
  log.info(`manual host-resolver rules applied: ${entries.length} mapping(s)`);
  return true;
}
