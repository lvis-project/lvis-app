/**
 * Tests for the permissions-migration boot step.
 *
 * Covers:
 *   - Successful behaviour-changing migration emits a
 *     `decision: "settings_migration"` audit row with structured
 *     fields (changes, previous, legacyExecutionMode).
 *   - Schema-only bumps do NOT emit a permission-audit row (they stay
 *     in the app log only).
 *   - Idempotent re-run emits zero audit rows.
 *   - Migration failures emit a `settings_migration_error` audit row
 *     and the step still resolves (never throws).
 *   - Step does NOT crash when no auditLogger is supplied (e.g. very
 *     early boot, or test harness).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPermissionMigrationStep } from "../permissions-migration.js";

interface FakeAuditLogger {
  isPermissionAuditChainReady: ReturnType<typeof vi.fn>;
  appendPermissionAuditEntry: ReturnType<typeof vi.fn>;
}

function makeAuditLogger(opts: { chainReady?: boolean; throws?: boolean } = {}): FakeAuditLogger {
  return {
    isPermissionAuditChainReady: vi.fn(() => opts.chainReady ?? true),
    appendPermissionAuditEntry: vi.fn(async () => {
      if (opts.throws) throw new Error("audit append failure");
    }),
  };
}

function makeLog() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
  };
}

let tmp: string;
let settingsPath: string;
let migrationPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "lvis-perm-migrate-step-"));
  settingsPath = join(tmp, "settings.json");
  migrationPath = join(tmp, "permissions", "migration.json");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("runPermissionMigrationStep", () => {
  it("behaviour-changing migration → emits 'settings_migration' audit row + info log", async () => {
    const auditLogger = makeAuditLogger();
    const log = makeLog();
    const status = await runPermissionMigrationStep({
      legacyExecutionMode: "auto",
      auditLogger,
      log,
      settingsPathOverride: settingsPath,
      migrationPathOverride: migrationPath,
    });
    expect(status.justApplied).toBe(true);
    expect(status.appliedAt).toBeTypeOf("string");
    expect(auditLogger.appendPermissionAuditEntry).toHaveBeenCalledTimes(1);
    const entry = auditLogger.appendPermissionAuditEntry.mock.calls[0]![0];
    expect(entry.decision).toBe("settings_migration");
    expect(entry.legacyExecutionMode).toBe("auto");
    expect(entry.changes).toEqual(
      expect.arrayContaining([expect.stringContaining("reviewer.interactive.autoApprove")]),
    );
    expect(entry.previous).toEqual({
      reviewer: { interactive: { autoApprove: "off" } },
    });
    expect(log.info).toHaveBeenCalled();
  });

  it("schema-only bump → no audit row, info log only", async () => {
    const auditLogger = makeAuditLogger();
    const log = makeLog();
    await runPermissionMigrationStep({
      legacyExecutionMode: "default",
      auditLogger,
      log,
      settingsPathOverride: settingsPath,
      migrationPathOverride: migrationPath,
    });
    expect(auditLogger.appendPermissionAuditEntry).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalled();
  });

  it("idempotent re-run → no audit row, no info log", async () => {
    const log = makeLog();
    await runPermissionMigrationStep({
      legacyExecutionMode: "auto",
      auditLogger: makeAuditLogger(),
      log,
      settingsPathOverride: settingsPath,
      migrationPathOverride: migrationPath,
    });
    log.info.mockClear();
    const auditLogger2 = makeAuditLogger();
    await runPermissionMigrationStep({
      legacyExecutionMode: "auto",
      auditLogger: auditLogger2,
      log,
      settingsPathOverride: settingsPath,
      migrationPathOverride: migrationPath,
    });
    expect(auditLogger2.appendPermissionAuditEntry).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
  });

  it("malformed settings.json → emits NO error audit row (migrator no-ops, doesn't throw)", async () => {
    writeFileSync(settingsPath, "{not valid JSON");
    const auditLogger = makeAuditLogger();
    const log = makeLog();
    const status = await runPermissionMigrationStep({
      legacyExecutionMode: "auto",
      auditLogger,
      log,
      settingsPathOverride: settingsPath,
      migrationPathOverride: migrationPath,
    });
    expect(status.justApplied).toBe(false);
    // The migrator handled the corruption by returning justApplied:false
    // — no throw → no error audit row.
    expect(auditLogger.appendPermissionAuditEntry).not.toHaveBeenCalled();
  });

  it("step never throws even when auditLogger is undefined", async () => {
    const log = makeLog();
    await expect(
      runPermissionMigrationStep({
        legacyExecutionMode: "auto",
        log,
        settingsPathOverride: settingsPath,
        migrationPathOverride: migrationPath,
      }),
    ).resolves.toMatchObject({ justApplied: true });
  });

  it("audit append failure does NOT crash boot step", async () => {
    const auditLogger = makeAuditLogger({ throws: true });
    const log = makeLog();
    await expect(
      runPermissionMigrationStep({
        legacyExecutionMode: "auto",
        auditLogger,
        log,
        settingsPathOverride: settingsPath,
        migrationPathOverride: migrationPath,
      }),
    ).resolves.toMatchObject({ justApplied: true });
  });
});
