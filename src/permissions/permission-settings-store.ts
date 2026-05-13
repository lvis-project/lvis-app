/**
 * Permission policy Phase 2.5 — `~/.lvis/settings.json` permissions block.
 *
 * Spec ref: docs/architecture/permission-policy-design.md §3 Layer 1.
 *
 * This is a focused store for the Permission policy permission settings only — the
 * existing `SettingsService` (lvis-settings.json under Electron's
 * userData) is unchanged. Permission policy settings live in `~/.lvis/settings.json`
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
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve as pathResolve } from "node:path";
import { withFileLock } from "../lib/with-file-lock.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("permission-settings");

export type ReviewerMode = "disabled" | "rule" | "llm";
export type ReviewerProvider = "openai" | "anthropic" | "google";
export type ReviewerFallbackOnError = "deny" | "rule";

/**
 * Interactive auto-approve policy — issue #690.
 *
 *   - "off"  : reviewer never auto-approves in interactive (foreground)
 *              flow. Every ask hits the modal. Default — safest.
 *   - "low"  : reviewer's LOW verdict in interactive flow silently
 *              allows the call without showing the modal. MEDIUM/HIGH
 *              still surface to the modal.
 *
 * MED/HIGH is intentionally NOT auto-approvable — MEDIUM means
 * "writes to user data dir / idempotent network", which still warrants
 * human confirmation. Adding "low-medium" later would be a follow-up,
 * not a hidden enum value here.
 */
export type ReviewerInteractiveAutoApprove = "off" | "low";

export interface ReviewerInteractiveBlock {
  autoApprove: ReviewerInteractiveAutoApprove;
}

/**
 * Permission policy P3 — `permissions.reviewer` block. Defaults per spec v2.1 §11
 * binding decision: provider="openai", model="gpt-4o-mini",
 * fallbackOnError="deny", interactive.autoApprove="off".
 */
export interface ReviewerSettingsBlock {
  mode: ReviewerMode;
  provider: ReviewerProvider;
  model: string;
  fallbackOnError: ReviewerFallbackOnError;
  interactive: ReviewerInteractiveBlock;
}

export interface PermissionSettingsBlock {
  additionalDirectories: string[];
  reviewer: ReviewerSettingsBlock;
}

export interface PermissionSettingsFile {
  permissions: PermissionSettingsBlock;
}

const DEFAULT_REVIEWER: ReviewerSettingsBlock = {
  mode: "disabled",
  provider: "openai",
  model: "gpt-4o-mini",
  fallbackOnError: "deny",
  interactive: { autoApprove: "off" },
};

const REVIEWER_INTERACTIVE_AUTO_APPROVES: ReadonlySet<ReviewerInteractiveAutoApprove> =
  new Set(["off", "low"]);

const DEFAULT_FILE: PermissionSettingsFile = {
  permissions: {
    additionalDirectories: [],
    reviewer: { ...DEFAULT_REVIEWER },
  },
};

const REVIEWER_MODES: ReadonlySet<ReviewerMode> = new Set(["disabled", "rule", "llm"]);
const REVIEWER_PROVIDERS: ReadonlySet<ReviewerProvider> = new Set([
  "openai",
  "anthropic",
  "google",
]);
const REVIEWER_FALLBACKS: ReadonlySet<ReviewerFallbackOnError> = new Set(["deny", "rule"]);

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
 * PermissionSettingsFile. Only `permissions.additionalDirectories` is
 * accepted as the persisted directory SOT.
 */
export function normalizePermissionSettings(
  parsed: Record<string, unknown>,
): PermissionSettingsFile {
  const perm = (parsed.permissions ?? {}) as Record<string, unknown>;
  const additional = perm.additionalDirectories;
  let dirs: string[] = [];
  if (Array.isArray(additional)) {
    dirs = additional.filter((s): s is string => typeof s === "string" && s.length > 0);
  }
  return {
    permissions: {
      additionalDirectories: dirs,
      reviewer: normalizeReviewerBlock(perm.reviewer),
    },
  };
}

/**
 * Permission policy P3 — normalize `permissions.reviewer` from arbitrary JSON to the
 * canonical block. Unknown enum values fall back to defaults with a
 * warn (per CLAUDE.md No-Fallback: this is the *external boundary* —
 * settings file may be hand-edited with bad values).
 */
function normalizeReviewerBlock(parsed: unknown): ReviewerSettingsBlock {
  if (!parsed || typeof parsed !== "object") return structuredClone(DEFAULT_REVIEWER);
  const obj = parsed as Record<string, unknown>;
  const mode =
    typeof obj.mode === "string" && REVIEWER_MODES.has(obj.mode as ReviewerMode)
      ? (obj.mode as ReviewerMode)
      : DEFAULT_REVIEWER.mode;
  const provider =
    typeof obj.provider === "string" &&
    REVIEWER_PROVIDERS.has(obj.provider as ReviewerProvider)
      ? (obj.provider as ReviewerProvider)
      : DEFAULT_REVIEWER.provider;
  const model =
    typeof obj.model === "string" && obj.model.length > 0
      ? obj.model
      : DEFAULT_REVIEWER.model;
  const fallbackOnError =
    typeof obj.fallbackOnError === "string" &&
    REVIEWER_FALLBACKS.has(obj.fallbackOnError as ReviewerFallbackOnError)
      ? (obj.fallbackOnError as ReviewerFallbackOnError)
      : DEFAULT_REVIEWER.fallbackOnError;
  const interactive = normalizeInteractiveBlock(obj.interactive);
  return { mode, provider, model, fallbackOnError, interactive };
}

function normalizeInteractiveBlock(parsed: unknown): ReviewerInteractiveBlock {
  if (!parsed || typeof parsed !== "object") {
    return { ...DEFAULT_REVIEWER.interactive };
  }
  const obj = parsed as Record<string, unknown>;
  const autoApprove =
    typeof obj.autoApprove === "string" &&
    REVIEWER_INTERACTIVE_AUTO_APPROVES.has(obj.autoApprove as ReviewerInteractiveAutoApprove)
      ? (obj.autoApprove as ReviewerInteractiveAutoApprove)
      : DEFAULT_REVIEWER.interactive.autoApprove;
  return { autoApprove };
}

/**
 * Atomically rewrite `~/.lvis/settings.json` with a fresh
 * `permissions.additionalDirectories` value. Preserves any other
 * top-level keys present in the existing file.
 *
 * Permission policy P3: also accepts a `reviewer` patch (partial). Provided keys
 * overwrite; missing keys preserve existing values.
 */
export async function writePermissionSettings(
  patch: {
    additionalDirectories?: string[];
    reviewer?: Partial<ReviewerSettingsBlock>;
  },
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
    const existingReviewer = normalizeReviewerBlock(existingPerm.reviewer);
    const nextReviewer: ReviewerSettingsBlock = patch.reviewer
      ? validateReviewerPatch({ ...existingReviewer, ...patch.reviewer })
      : existingReviewer;
    const nextDirs =
      patch.additionalDirectories !== undefined
        ? [...patch.additionalDirectories]
        : Array.isArray(existingPerm.additionalDirectories)
          ? (existingPerm.additionalDirectories as string[])
          : [];
    const merged = {
      ...existing,
      permissions: {
        ...existingPerm,
        additionalDirectories: nextDirs,
        reviewer: nextReviewer,
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
 * Strict validate a candidate reviewer block. Used by the slash
 * handler / IPC writes — invalid input rejected with an error message
 * (no silent default-substitution at write time, only at read time
 * for hand-edited files).
 */
function validateReviewerPatch(patch: ReviewerSettingsBlock): ReviewerSettingsBlock {
  if (!REVIEWER_MODES.has(patch.mode)) {
    throw new Error(
      `permissions.reviewer.mode invalid: '${patch.mode}'. Allowed: ${[...REVIEWER_MODES].join("|")}`,
    );
  }
  if (!REVIEWER_PROVIDERS.has(patch.provider)) {
    throw new Error(
      `permissions.reviewer.provider invalid: '${patch.provider}'. Allowed: ${[...REVIEWER_PROVIDERS].join("|")}`,
    );
  }
  if (!REVIEWER_FALLBACKS.has(patch.fallbackOnError)) {
    throw new Error(
      `permissions.reviewer.fallbackOnError invalid: '${patch.fallbackOnError}'. Allowed: ${[...REVIEWER_FALLBACKS].join("|")}`,
    );
  }
  if (typeof patch.model !== "string" || patch.model.length === 0) {
    throw new Error("permissions.reviewer.model must be a non-empty string");
  }
  if (
    !patch.interactive ||
    !REVIEWER_INTERACTIVE_AUTO_APPROVES.has(patch.interactive.autoApprove)
  ) {
    throw new Error(
      `permissions.reviewer.interactive.autoApprove invalid: '${patch.interactive?.autoApprove}'. ` +
      `Allowed: ${[...REVIEWER_INTERACTIVE_AUTO_APPROVES].join("|")}`,
    );
  }
  return patch;
}

/**
 * Permission policy P3 — persist a reviewer-block partial. Convenience helper for
 * `/permission reviewer ...` slash dispatchers.
 */
export async function setReviewerSettingsPersist(
  patch: Partial<ReviewerSettingsBlock>,
  pathOverride?: string,
): Promise<ReviewerSettingsBlock> {
  await writePermissionSettings({ reviewer: patch }, pathOverride);
  return readPermissionSettings(pathOverride).permissions.reviewer;
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
