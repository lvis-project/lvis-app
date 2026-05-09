/**
 * Portions adapted from OpenHarness (MIT License)
 * https://github.com/HKUDS/OpenHarness/blob/main/src/openharness/hooks/loader.py
 * Copyright (c) 2026 HKU Data Intelligence Lab
 *
 * Q12 Phase 2.5 — hook directory relocated from `~/.lvis/hooks.json`
 * (single file) → `~/.config/lvis/hooks/hooks.json`. Spec security
 * review M3 + M4: hook supply-chain protection requires hooks live
 * outside the LVIS data directory so a compromised LVIS process cannot
 * trivially mutate them. Phase 4 will add TOFU + boot-time hash check
 * + per-hook discrete files; for Phase 2.5 we only relocate.
 *
 * Old-path migration: a one-time WARN logged at boot when
 * `~/.lvis/hooks.json` still exists. We do NOT auto-migrate (data
 * integrity — admin must move the file deliberately).
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { EMPTY_HOOKS_CONFIG, HooksConfigSchema, type HooksConfig } from "./schemas.js";
import { createLogger } from "../lib/logger.js";
const log = createLogger("hooks");

function getUserHooksPath(): string {
  // Q12 P2.5 — relocated to ~/.config/lvis/hooks/. Layer 0 also lists
  // this directory as a sensitive path (deny-list) so plugin/MCP tools
  // cannot read or write hook config at runtime.
  return join(homedir(), ".config", "lvis", "hooks", "hooks.json");
}

/**
 * Q12 P2.5 — legacy path retained ONLY for boot-time migration warn.
 * Never read for actual hook execution after relocation.
 */
function getLegacyUserHooksPath(): string {
  return join(homedir(), ".lvis", "hooks.json");
}

function getAdminHooksPath(): string | null {
  switch (platform()) {
    case "darwin":
      return "/Library/Application Support/LVIS/hooks.json";
    case "win32":
      return process.env.ProgramData
        ? join(process.env.ProgramData, "LVIS", "hooks.json")
        : null;
    case "linux":
      return "/etc/lvis/hooks.json";
    default:
      return null;
  }
}

function parseFile(path: string): HooksConfig | null {
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    const result = HooksConfigSchema.safeParse(parsed);
    if (!result.success) {
      log.warn(`invalid hooks.json at ${path}: %s`, result.error.message);
      return null;
    }
    return result.data;
  } catch (err) {
    log.warn(`failed to read ${path}: %s`, (err as Error).message);
    return null;
  }
}

/**
 * Q12 P2.5 migration helper — emits a one-shot warn (no auto-migrate)
 * when the legacy `~/.lvis/hooks.json` is still present after the
 * relocation to `~/.config/lvis/hooks/hooks.json`.
 *
 * Exported so boot can call this once at startup; loadHooksConfig also
 * calls it idempotently (the underlying log.warn is itself idempotent
 * per process via the createLogger contract).
 */
let legacyHooksWarnEmitted = false;
export function checkLegacyUserHooksPath(): void {
  if (legacyHooksWarnEmitted) return;
  const legacy = getLegacyUserHooksPath();
  if (existsSync(legacy)) {
    log.warn(
      "legacy hooks.json detected at %s — Q12 P2.5 relocated this to %s. Move the file manually; auto-migration is not performed (data integrity).",
      legacy,
      getUserHooksPath(),
    );
    legacyHooksWarnEmitted = true;
  }
}

export function loadHooksConfig(): HooksConfig {
  checkLegacyUserHooksPath();
  const adminPath = getAdminHooksPath();
  const adminConfig = adminPath && existsSync(adminPath) ? parseFile(adminPath) : null;
  const userPath = getUserHooksPath();
  const userConfig = existsSync(userPath) ? parseFile(userPath) : null;

  // Merge: admin hooks always run (first), user hooks append
  return {
    preToolUse: [
      ...(adminConfig?.preToolUse ?? []),
      ...(userConfig?.preToolUse ?? []),
    ],
    postToolUse: [
      ...(adminConfig?.postToolUse ?? []),
      ...(userConfig?.postToolUse ?? []),
    ],
  };
}

/**
 * Test-only variant of {@link loadHooksConfig}. Allows explicit admin/user
 * paths so tests can stage temp files without mocking `os.homedir`/`os.platform`.
 */
export function loadHooksConfigFromPaths(params: {
  adminPath?: string | null;
  userPath?: string | null;
}): HooksConfig {
  const { adminPath, userPath } = params;
  const adminConfig = adminPath && existsSync(adminPath) ? parseFile(adminPath) : null;
  const userConfig = userPath && existsSync(userPath) ? parseFile(userPath) : null;
  return {
    preToolUse: [
      ...(adminConfig?.preToolUse ?? []),
      ...(userConfig?.preToolUse ?? []),
    ],
    postToolUse: [
      ...(adminConfig?.postToolUse ?? []),
      ...(userConfig?.postToolUse ?? []),
    ],
  };
}

export { EMPTY_HOOKS_CONFIG };
