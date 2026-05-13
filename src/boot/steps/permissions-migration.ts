/**
 * Boot step: idempotent permission settings migration.
 *
 * Thin orchestrator that:
 *
 *  1. Invokes {@link runPermissionMigration} (single-lock critical
 *     section, absence-based trigger).
 *  2. Emits an HMAC-chained audit row on the permission audit channel
 *     when a behaviour-changing migration applied. Schema-only bumps
 *     are NOT auditable rows (the chain is reserved for policy
 *     mutations; a pure version stamp is captured in the app log only).
 *  3. Emits an error audit row when the migration throws — fail-soft;
 *     boot continues even if the migrator failed.
 *
 * The step does NOT throw on migration failure: a corrupt settings
 * file should not prevent the app from launching. The migrator's
 * `justApplied: false` return already covers the malformed-file
 * refusal path; this wrapper just makes the audit emission paired
 * with the migration outcome.
 *
 * Spec ref: docs/architecture/permission-policy-design.md §3 Layer 7
 * (audit invariants).
 */
import { randomUUID } from "node:crypto";
import {
  runPermissionMigration,
  type PermissionMigrationStatus,
} from "../../permissions/permission-migration-store.js";
import type { AuditLogger } from "../../audit/audit-logger.js";
import type { PermissionMode } from "../../audit/audit-schema.js";
import type pino from "pino";

type Logger = pino.Logger;

export interface RunPermissionMigrationStepInput {
  legacyExecutionMode: string | null;
  auditLogger?: Pick<
    AuditLogger,
    "isPermissionAuditChainReady" | "appendPermissionAuditEntry"
  >;
  log: Pick<Logger, "info" | "warn">;
  /** Test override. Forwarded to {@link runPermissionMigration}. */
  settingsPathOverride?: string;
  /** Test override. Forwarded to {@link runPermissionMigration}. */
  migrationPathOverride?: string;
}

/**
 * Boot-time entry point for the permission settings migrator. Always
 * resolves; never throws. Returns the migration status so test code
 * can assert on the outcome.
 */
export async function runPermissionMigrationStep(
  input: RunPermissionMigrationStepInput,
): Promise<PermissionMigrationStatus> {
  let status: PermissionMigrationStatus;
  try {
    status = await runPermissionMigration({
      legacyExecutionMode: input.legacyExecutionMode,
      settingsPathOverride: input.settingsPathOverride,
      migrationPathOverride: input.migrationPathOverride,
    });
  } catch (err) {
    const message = (err as Error).message;
    input.log.warn(`permissions migration failed: ${message}`);
    await emitMigrationError(input.auditLogger, message, input.legacyExecutionMode);
    return {
      schemaVersion: undefined,
      justApplied: false,
      changes: [],
    };
  }

  if (!status.justApplied) {
    return status;
  }

  if (status.appliedAt) {
    // Behaviour-changing migration — log via app logger + audit chain.
    input.log.info(
      `permissions: schemaVersion migrated → v${status.schemaVersion} ` +
      `(${status.changes.join("; ")})`,
    );
    await emitMigrationApplied(input.auditLogger, status, input.legacyExecutionMode);
  } else {
    // Schema-only bump (no behaviour change). App log only.
    input.log.info(
      `permissions: schema bump → v${status.schemaVersion} (no behaviour change)`,
    );
  }
  return status;
}

async function emitMigrationApplied(
  auditLogger: RunPermissionMigrationStepInput["auditLogger"],
  status: PermissionMigrationStatus,
  legacyExecutionMode: string | null,
): Promise<void> {
  if (!auditLogger) return;
  if (!auditLogger.isPermissionAuditChainReady()) return;
  if (status.appliedAt === undefined) return;
  if (status.schemaVersion === undefined || status.appliedSchemaVersion === undefined) return;
  try {
    await auditLogger.appendPermissionAuditEntry({
      decision: "settings_migration",
      auditId: randomUUID(),
      ts: status.appliedAt,
      trustOrigin: "user-keyboard",
      schemaVersion: status.schemaVersion,
      appliedSchemaVersion: status.appliedSchemaVersion,
      appliedAt: status.appliedAt,
      legacyExecutionMode: coerceMode(legacyExecutionMode),
      changes: status.changes,
      previous: status.previous ? toPlainPrevious(status.previous) : null,
    });
  } catch {
    // Audit write failure must not crash boot. The app log line is
    // still emitted by the caller above.
  }
}

async function emitMigrationError(
  auditLogger: RunPermissionMigrationStepInput["auditLogger"],
  message: string,
  legacyExecutionMode: string | null,
): Promise<void> {
  if (!auditLogger) return;
  if (!auditLogger.isPermissionAuditChainReady()) return;
  try {
    await auditLogger.appendPermissionAuditEntry({
      decision: "settings_migration_error",
      auditId: randomUUID(),
      ts: new Date().toISOString(),
      trustOrigin: "user-keyboard",
      error: message,
      legacyExecutionMode: coerceMode(legacyExecutionMode),
    });
  } catch {
    // Best-effort.
  }
}

function coerceMode(value: string | null): PermissionMode | null {
  if (value === "default" || value === "strict" || value === "auto" || value === "allow") {
    return value;
  }
  return null;
}

function toPlainPrevious(
  previous: NonNullable<PermissionMigrationStatus["previous"]>,
): Record<string, unknown> {
  return JSON.parse(JSON.stringify(previous)) as Record<string, unknown>;
}
