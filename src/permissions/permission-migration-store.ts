/**
 * Permission settings migration store — issue #690 follow-up + PR #704 review.
 *
 * SOT for migration provenance. Lives at
 * `~/.lvis/permissions/migration.json` (separate from
 * `~/.lvis/settings.json`) per the CLAUDE.md "Storage Namespace per
 * Feature" rule: permission-domain state belongs under
 * `~/.lvis/permissions/`, not in the cross-cutting settings file.
 *
 * Design properties:
 *
 *  - **Absence-based trigger (issue #704 review C1).** Migration consults
 *    the RAW settings JSON for `permissions.reviewer.interactive` key
 *    presence. A user who explicitly persisted
 *    `reviewer.interactive.autoApprove: "off"` is NOT auto-flipped to
 *    `"low"`, even if their legacy ExecutionMode is `"auto"`. Only
 *    users with no on-disk `reviewer.interactive` key qualify for the
 *    auto-flip.
 *
 *  - **Single-lock critical section (issue #704 review M5).** Read
 *    decision and write happen inside one `withFileLock(migration.json)`
 *    callback. If a second process raced past the initial read, it
 *    re-reads inside the lock and exits as idempotent (`justApplied:false`).
 *
 *  - **Cry-wolf prevention (issue #704 review M5/M9).** `appliedAt` is
 *    written ONLY when the migrator actually changed user-visible
 *    behaviour (i.e. the auto-flip applied). Pure schema-version stamps
 *    still bump `schemaVersion` but leave `appliedAt` undefined; the
 *    renderer banner uses `appliedAt` presence as the visibility
 *    predicate.
 *
 *  - **Malformed refusal (issue #704 review code-reviewer MAJOR).** If
 *    the settings file is corrupt (parse error), the migrator refuses
 *    to write rather than triggering a top-level key wipe via
 *    silent-default fallback.
 *
 *  - **Audit-field preservation (issue #704 review M6).** Read-side
 *    normalisation preserves any positive-integer
 *    `appliedSchemaVersion` so a future v3 build can still see the v2
 *    audit trail.
 *
 *  - **Rollback breadcrumb (issue #704 review M7).** The migrator
 *    snapshots the pre-migration value into `migration.previous` so
 *    operators can correlate forensics and roll back per-setting.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve as pathResolve } from "node:path";
import { withFileLock } from "../lib/with-file-lock.js";
import { createLogger } from "../lib/logger.js";
import {
  readPermissionSettingsResult,
  writePermissionSettings,
  type ReviewerInteractiveAutoApprove,
  type ReviewerSettingsBlock,
} from "./permission-settings-store.js";

const log = createLogger("permission-migration");

/** Canonical schemaVersion this module's migrator targets. */
export const PERMISSION_SETTINGS_SCHEMA_VERSION = 2 as const;
export type PermissionSettingsSchemaVersion = typeof PERMISSION_SETTINGS_SCHEMA_VERSION;

/**
 * Structured rollback snapshot of the values the migrator changed.
 * Future per-version migrations append new optional fields; consumers
 * read what they recognise and ignore the rest.
 */
export interface MigrationPrevious {
  reviewer?: {
    interactive?: {
      autoApprove?: ReviewerInteractiveAutoApprove;
    };
  };
}

export interface PermissionMigrationFile {
  /** Current schema the file was migrated TO. */
  schemaVersion: number;
  /** Same as `schemaVersion` at write time; preserved across future
   *  migrations as audit history (do NOT clamp to current). */
  appliedSchemaVersion: number;
  /** ISO timestamp of the last BEHAVIOUR-CHANGING migration. Schema-only
   *  bumps do NOT set this field, so the renderer banner stays hidden. */
  appliedAt?: string;
  /** Forensic record of what changed (human-readable list). */
  changes?: string[];
  /** Structured pre-migration values for rollback. Absent when no
   *  behaviour changed. */
  previous?: MigrationPrevious;
}

export interface PermissionMigrationStatus {
  schemaVersion?: number;
  appliedSchemaVersion?: number;
  appliedAt?: string;
  changes: string[];
  previous?: MigrationPrevious;
  /** True when this RUN wrote the migration file. False on idempotent
   *  re-entry. */
  justApplied: boolean;
}

function defaultMigrationPath(): string {
  return pathResolve(homedir(), ".lvis", "permissions", "migration.json");
}

function normalizeAppliedSchemaVersion(value: unknown): number | undefined {
  // Audit field — accept any positive integer so future v3 builds
  // preserve the v2 audit trail.
  if (typeof value !== "number") return undefined;
  if (!Number.isInteger(value) || value <= 0) return undefined;
  return value;
}

function normalizeSchemaVersion(value: unknown): number | undefined {
  // File-level current version — same shape as the audit field for
  // round-trip read/write idempotency.
  return normalizeAppliedSchemaVersion(value);
}

function normalizePrevious(parsed: unknown): MigrationPrevious | undefined {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const obj = parsed as Record<string, unknown>;
  const reviewer = obj.reviewer && typeof obj.reviewer === "object" && !Array.isArray(obj.reviewer)
    ? obj.reviewer as Record<string, unknown>
    : undefined;
  if (!reviewer) return undefined;
  const interactive = reviewer.interactive && typeof reviewer.interactive === "object" && !Array.isArray(reviewer.interactive)
    ? reviewer.interactive as Record<string, unknown>
    : undefined;
  if (!interactive) return undefined;
  const autoApprove = interactive.autoApprove === "off" || interactive.autoApprove === "low"
    ? interactive.autoApprove as ReviewerInteractiveAutoApprove
    : undefined;
  if (!autoApprove) return undefined;
  return { reviewer: { interactive: { autoApprove } } };
}

function normalizeMigrationFile(parsed: unknown): PermissionMigrationFile | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const schemaVersion = normalizeSchemaVersion(obj.schemaVersion);
  const appliedSchemaVersion = normalizeAppliedSchemaVersion(obj.appliedSchemaVersion);
  if (schemaVersion === undefined || appliedSchemaVersion === undefined) return null;
  const appliedAt = typeof obj.appliedAt === "string" && obj.appliedAt.length > 0
    ? obj.appliedAt
    : undefined;
  const changes = Array.isArray(obj.changes)
    ? obj.changes.filter((s): s is string => typeof s === "string")
    : undefined;
  const previous = normalizePrevious(obj.previous);
  return {
    schemaVersion,
    appliedSchemaVersion,
    ...(appliedAt !== undefined ? { appliedAt } : {}),
    ...(changes && changes.length > 0 ? { changes } : {}),
    ...(previous ? { previous } : {}),
  };
}

/**
 * Read-only accessor used by the renderer (via IPC) to decide whether to
 * surface the one-time "권한 정책이 업데이트되었습니다" banner.
 */
export function readPermissionMigrationStatus(
  pathOverride?: string,
): PermissionMigrationStatus {
  const filePath = pathOverride ?? defaultMigrationPath();
  if (!existsSync(filePath)) {
    return { schemaVersion: undefined, justApplied: false, changes: [] };
  }
  const text = readFileSync(filePath, "utf-8");
  // Empty placeholder (left by an interrupted lock acquisition or by
  // `withFileLock`'s touch) is equivalent to "no migration yet".
  if (text.trim().length === 0) {
    return { schemaVersion: undefined, justApplied: false, changes: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    log.warn(`failed to read ${filePath}: %s`, (err as Error).message);
    return { schemaVersion: undefined, justApplied: false, changes: [] };
  }
  const file = normalizeMigrationFile(parsed);
  if (!file) return { schemaVersion: undefined, justApplied: false, changes: [] };
  return {
    schemaVersion: file.schemaVersion,
    appliedSchemaVersion: file.appliedSchemaVersion,
    appliedAt: file.appliedAt,
    previous: file.previous,
    changes: file.changes ?? [],
    justApplied: false,
  };
}

function readMigrationFileInsideLock(filePath: string): PermissionMigrationFile | null {
  if (!existsSync(filePath)) return null;
  const text = readFileSync(filePath, "utf-8");
  // `withFileLock` touches `targetPath` with `flag: "a"` so it can be
  // locked. The very first migration run sees an empty placeholder
  // here — treat it as "no prior migration" rather than a parse error.
  if (text.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(text);
    return normalizeMigrationFile(parsed);
  } catch {
    return null;
  }
}

function writeMigrationFile(filePath: string, file: PermissionMigrationFile): void {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  writeFileSync(filePath, `${JSON.stringify(file, null, 2)}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
}

/**
 * Decide whether the user has an EXPLICIT
 * `permissions.reviewer.interactive` block on disk. Absence-based
 * trigger — distinguishes "user typed default" from "user typed off
 * deliberately".
 */
function hasExplicitInteractiveBlock(raw: Record<string, unknown> | null): boolean {
  if (!raw) return false;
  const perm = raw.permissions;
  if (!perm || typeof perm !== "object" || Array.isArray(perm)) return false;
  const reviewer = (perm as Record<string, unknown>).reviewer;
  if (!reviewer || typeof reviewer !== "object" || Array.isArray(reviewer)) return false;
  return Object.prototype.hasOwnProperty.call(reviewer, "interactive");
}

export interface RunPermissionMigrationInput {
  legacyExecutionMode: string | null;
  settingsPathOverride?: string;
  migrationPathOverride?: string;
}

/**
 * Idempotent one-shot migration to
 * {@link PERMISSION_SETTINGS_SCHEMA_VERSION}.
 *
 * The full read → decide → write cycle runs inside
 * `withFileLock(migration.json)` to close the multi-process
 * read-before-write TOCTOU window.
 *
 * Behaviour:
 *
 *  - Migration file already at current schemaVersion → no-op
 *    (justApplied:false).
 *  - Settings file malformed → refuse to migrate (justApplied:false +
 *    log.warn). Caller may emit an audit error entry.
 *  - User has no explicit `reviewer.interactive` block on disk AND
 *    legacy mode is `"auto"` → flip `interactive.autoApprove` to
 *    `"low"`, snapshot previous, write `appliedAt`.
 *  - Otherwise → schema-only bump: write `schemaVersion` + audit
 *    breadcrumb, leave `appliedAt` undefined so the banner stays hidden.
 */
export async function runPermissionMigration(
  input: RunPermissionMigrationInput,
): Promise<PermissionMigrationStatus> {
  const migrationPath = input.migrationPathOverride ?? defaultMigrationPath();
  return withFileLock(migrationPath, async () => {
    const existing = readMigrationFileInsideLock(migrationPath);
    if (existing && existing.schemaVersion === PERMISSION_SETTINGS_SCHEMA_VERSION) {
      return {
        schemaVersion: existing.schemaVersion,
        appliedSchemaVersion: existing.appliedSchemaVersion,
        appliedAt: existing.appliedAt,
        previous: existing.previous,
        changes: existing.changes ?? [],
        justApplied: false,
      };
    }

    const settingsResult = readPermissionSettingsResult(input.settingsPathOverride);
    if (settingsResult.malformed) {
      log.warn(
        "permission settings file is malformed — refusing to migrate. " +
        "Resolve the JSON syntax error or move the file aside before retrying.",
      );
      return {
        schemaVersion: undefined,
        justApplied: false,
        changes: [],
      };
    }

    const reviewerPatch: Partial<ReviewerSettingsBlock> = {};
    const changes: string[] = [];
    let previous: MigrationPrevious | undefined;
    let behaviourChanged = false;

    const shouldFlipInteractive =
      input.legacyExecutionMode === "auto" &&
      !hasExplicitInteractiveBlock(settingsResult.raw);
    if (shouldFlipInteractive) {
      const prior = settingsResult.file.permissions.reviewer.interactive.autoApprove;
      reviewerPatch.interactive = { autoApprove: "low" };
      previous = { reviewer: { interactive: { autoApprove: prior } } };
      changes.push(
        `reviewer.interactive.autoApprove: ${prior} → low (absence-based; legacy executionMode=auto)`,
      );
      behaviourChanged = true;
    }

    changes.push(
      `schemaVersion: ${existing?.schemaVersion ?? "v1"} → ${PERMISSION_SETTINGS_SCHEMA_VERSION}`,
    );

    if (Object.keys(reviewerPatch).length > 0) {
      await writePermissionSettings({ reviewer: reviewerPatch }, input.settingsPathOverride);
    }

    const appliedAt = behaviourChanged ? new Date().toISOString() : undefined;
    const file: PermissionMigrationFile = {
      schemaVersion: PERMISSION_SETTINGS_SCHEMA_VERSION,
      appliedSchemaVersion: PERMISSION_SETTINGS_SCHEMA_VERSION,
      ...(appliedAt ? { appliedAt } : {}),
      changes,
      ...(previous ? { previous } : {}),
    };
    writeMigrationFile(migrationPath, file);

    log.info(
      `permission settings migrated to v${PERMISSION_SETTINGS_SCHEMA_VERSION}: ${changes.join("; ")}`,
    );
    return {
      schemaVersion: file.schemaVersion,
      appliedSchemaVersion: file.appliedSchemaVersion,
      appliedAt: file.appliedAt,
      previous: file.previous,
      changes,
      justApplied: true,
    };
  });
}
