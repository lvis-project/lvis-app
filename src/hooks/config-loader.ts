/**
 * Portions adapted from OpenHarness (MIT License)
 * https://github.com/HKUDS/OpenHarness/blob/main/src/openharness/hooks/loader.py
 * Copyright (c) 2026 HKU Data Intelligence Lab
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { EMPTY_HOOKS_CONFIG, HooksConfigSchema, type HooksConfig } from "./schemas.js";

function getUserHooksPath(): string {
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
      console.warn(`[hooks] invalid hooks.json at ${path}:`, result.error.message);
      return null;
    }
    return result.data;
  } catch (err) {
    console.warn(`[hooks] failed to read ${path}:`, (err as Error).message);
    return null;
  }
}

export function loadHooksConfig(): HooksConfig {
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
