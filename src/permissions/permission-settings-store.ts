/**
 * Q12 Phase 2.5 — `~/.lvis/settings.json` permissions block.
 *
 * Spec ref: docs/architecture/q12-permission-policy-design.md §3 Layer 1.
 *
 * This is a focused store for the Q12 permission settings only — the
 * existing `SettingsService` (lvis-settings.json under Electron's
 * userData) is unchanged. Q12 settings live in `~/.lvis/settings.json`
 * because the spec carves out a permissions namespace there:
 *
 * ```jsonc
 * {
 *   "permissions": {
 *     "additionalDirectories": ["~/workspace/lvis"]
 *   }
 * }
 * ```
 *
 * Atomic cutover: an absent `additionalDirectories` key means "use
 * defaults only" (NOT silent allow). Callers compose with
 * `buildAllowedScope(...)` which adds the host defaults.
 *
 * §11 alias rule: `allowedDirectories` (the v1 working name) is also
 * accepted for one cycle with a deprecation warning. New writes use
 * `additionalDirectories`.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve as pathResolve } from "node:path";
import { withFileLock } from "../lib/with-file-lock.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("permission-settings");

export interface PermissionSettingsBlock {
  additionalDirectories: string[];
}

export interface PermissionSettingsFile {
  permissions: PermissionSettingsBlock;
}

const DEFAULT_FILE: PermissionSettingsFile = {
  permissions: {
    additionalDirectories: [],
  },
};

function defaultPath(): string {
  return pathResolve(homedir(), ".lvis", "settings.json");
}

/**
 * Read `~/.lvis/settings.json`. Missing file → DEFAULT_FILE; malformed
 * file → DEFAULT_FILE + warn (atomic cutover: do NOT silently allow).
 *
 * `pathOverride` is for tests.
 */
export function readPermissionSettings(pathOverride?: string): PermissionSettingsFile {
  const filePath = pathOverride ?? defaultPath();
  if (!existsSync(filePath)) return structuredClone(DEFAULT_FILE);
  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return normalizePermissionSettings(parsed);
  } catch (err) {
    log.warn(
      `failed to read ${filePath}: %s — falling back to defaults`,
      (err as Error).message,
    );
    return structuredClone(DEFAULT_FILE);
  }
}

/**
 * Normalize an arbitrary parsed JSON value into a valid
 * PermissionSettingsFile. Honors the `allowedDirectories` alias for one
 * cycle with a one-shot deprecation warning.
 */
export function normalizePermissionSettings(
  parsed: Record<string, unknown>,
): PermissionSettingsFile {
  const perm = (parsed.permissions ?? {}) as Record<string, unknown>;
  const additional = perm.additionalDirectories;
  const aliased = perm.allowedDirectories;
  let dirs: string[] = [];
  if (Array.isArray(additional)) {
    dirs = additional.filter((s): s is string => typeof s === "string" && s.length > 0);
  } else if (Array.isArray(aliased)) {
    log.warn(
      "permissions.allowedDirectories is deprecated — rename to permissions.additionalDirectories. Aliased entry will be honored for one cycle only.",
    );
    dirs = aliased.filter((s): s is string => typeof s === "string" && s.length > 0);
  }
  return { permissions: { additionalDirectories: dirs } };
}

/**
 * Atomically rewrite `~/.lvis/settings.json` with a fresh
 * `permissions.additionalDirectories` value. Preserves any other
 * top-level keys present in the existing file.
 */
export async function writePermissionSettings(
  patch: { additionalDirectories: string[] },
  pathOverride?: string,
): Promise<void> {
  const filePath = pathOverride ?? defaultPath();
  await withFileLock(filePath, async () => {
    let existing: Record<string, unknown> = {};
    if (existsSync(filePath)) {
      try {
        existing = JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>;
      } catch {
        existing = {};
      }
    }
    const existingPerm = (existing.permissions ?? {}) as Record<string, unknown>;
    // Drop the deprecated alias key on write — settings file converges
    // on the canonical name with each persist.
    delete existingPerm.allowedDirectories;
    const merged = {
      ...existing,
      permissions: {
        ...existingPerm,
        additionalDirectories: [...patch.additionalDirectories],
      },
    };
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    writeFileSync(filePath, JSON.stringify(merged, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
  });
}

/**
 * Append a directory to `permissions.additionalDirectories`. Persists
 * via {@link writePermissionSettings}. De-duplicates by exact string.
 *
 * Returns the post-add list (caller may show in toast).
 */
export async function addAllowedDirectoryPersist(
  dir: string,
  pathOverride?: string,
): Promise<string[]> {
  const current = readPermissionSettings(pathOverride);
  const list = current.permissions.additionalDirectories;
  if (list.includes(dir)) return list;
  const next = [...list, dir];
  await writePermissionSettings({ additionalDirectories: next }, pathOverride);
  return next;
}

/**
 * Remove a directory from `permissions.additionalDirectories`. Returns
 * the post-removal list. No-op when the dir is not present.
 */
export async function removeAllowedDirectoryPersist(
  dir: string,
  pathOverride?: string,
): Promise<string[]> {
  const current = readPermissionSettings(pathOverride);
  const list = current.permissions.additionalDirectories;
  const next = list.filter((d) => d !== dir);
  if (next.length === list.length) return list;
  await writePermissionSettings({ additionalDirectories: next }, pathOverride);
  return next;
}
