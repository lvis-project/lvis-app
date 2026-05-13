/**
 * Tests for the v1→v2 permission-settings migration (issue #690
 * follow-up + PR #704 review).
 *
 * Covers:
 *   - Idempotency (second run is a no-op).
 *   - Absence-based trigger: only flips `autoApprove` when the user has
 *     NO explicit `reviewer.interactive` key on disk. Default-from-
 *     normalisation does NOT trigger the flip (critic C1 fix).
 *   - Schema-only bumps leave `appliedAt` undefined (cry-wolf fix).
 *   - Behaviour-changing migration writes structured `previous`
 *     snapshot for rollback (rollback breadcrumb).
 *   - Malformed settings.json → migrator refuses; settings file is
 *     NOT rewritten.
 *   - Concurrent invocation (Promise.all) ends with exactly one
 *     `justApplied:true` outcome (single-lock critical section).
 *   - Audit field `appliedSchemaVersion` is preserved across re-reads.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runPermissionMigration,
  readPermissionMigrationStatus,
  PERMISSION_SETTINGS_SCHEMA_VERSION,
} from "../permission-migration-store.js";
import { readPermissionSettings } from "../permission-settings-store.js";

let tmp: string;
let settingsPath: string;
let migrationPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "lvis-perm-migrate-"));
  settingsPath = join(tmp, "settings.json");
  migrationPath = join(tmp, "permissions", "migration.json");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("runPermissionMigration (v1 → v2)", () => {
  it("fresh install (no settings.json) → schema-only bump, appliedAt absent", async () => {
    const status = await runPermissionMigration({
      legacyExecutionMode: "default",
      settingsPathOverride: settingsPath,
      migrationPathOverride: migrationPath,
    });
    expect(status.justApplied).toBe(true);
    expect(status.schemaVersion).toBe(PERMISSION_SETTINGS_SCHEMA_VERSION);
    expect(status.appliedSchemaVersion).toBe(PERMISSION_SETTINGS_SCHEMA_VERSION);
    expect(status.appliedAt).toBeUndefined();
    expect(status.previous).toBeUndefined();
    expect(existsSync(migrationPath)).toBe(true);
  });

  it("legacy executionMode=auto + no on-disk interactive block → auto-flip applied, appliedAt set, previous snapshotted", async () => {
    // No settings.json at all simulates a v1 user who never opened
    // PermissionsTab. Their executionMode=auto carried the LOW
    // silent-allow UX before PR #698.
    const status = await runPermissionMigration({
      legacyExecutionMode: "auto",
      settingsPathOverride: settingsPath,
      migrationPathOverride: migrationPath,
    });
    expect(status.justApplied).toBe(true);
    expect(status.appliedAt).toBeTypeOf("string");
    expect(status.previous).toEqual({
      reviewer: { interactive: { autoApprove: "off" } },
    });
    const onDiskSettings = readPermissionSettings(settingsPath);
    expect(onDiskSettings.permissions.reviewer.interactive.autoApprove).toBe("low");
  });

  it("legacy executionMode=auto BUT user explicitly persisted interactive.autoApprove='off' → NO flip (critic C1 fix)", async () => {
    // The user opened PermissionsTab post-#698 and deliberately left
    // their foreground reviewer 'off'. The migrator must respect that
    // signal — flipping it to 'low' silently is exactly the security
    // regression critic C1 surfaced.
    writeFileSync(
      settingsPath,
      JSON.stringify({
        permissions: {
          additionalDirectories: [],
          reviewer: {
            mode: "disabled",
            provider: "openai",
            model: "gpt-4o-mini",
            fallbackOnError: "deny",
            interactive: { autoApprove: "off" },
          },
        },
      }),
    );
    const status = await runPermissionMigration({
      legacyExecutionMode: "auto",
      settingsPathOverride: settingsPath,
      migrationPathOverride: migrationPath,
    });
    expect(status.justApplied).toBe(true);
    expect(status.appliedAt).toBeUndefined();
    expect(status.previous).toBeUndefined();
    const onDiskSettings = readPermissionSettings(settingsPath);
    expect(onDiskSettings.permissions.reviewer.interactive.autoApprove).toBe("off");
  });

  it("legacy executionMode=auto + user explicitly persisted interactive.autoApprove='low' → no change (idempotent for explicit set)", async () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        permissions: {
          additionalDirectories: [],
          reviewer: {
            mode: "disabled",
            provider: "openai",
            model: "gpt-4o-mini",
            fallbackOnError: "deny",
            interactive: { autoApprove: "low" },
          },
        },
      }),
    );
    const status = await runPermissionMigration({
      legacyExecutionMode: "auto",
      settingsPathOverride: settingsPath,
      migrationPathOverride: migrationPath,
    });
    expect(status.appliedAt).toBeUndefined();
    const onDiskSettings = readPermissionSettings(settingsPath);
    expect(onDiskSettings.permissions.reviewer.interactive.autoApprove).toBe("low");
  });

  it("legacy executionMode=strict (non-auto) → schema bump only, never auto-flip", async () => {
    const status = await runPermissionMigration({
      legacyExecutionMode: "strict",
      settingsPathOverride: settingsPath,
      migrationPathOverride: migrationPath,
    });
    expect(status.appliedAt).toBeUndefined();
    const onDiskSettings = readPermissionSettings(settingsPath);
    expect(onDiskSettings.permissions.reviewer.interactive.autoApprove).toBe("off");
  });

  it("malformed settings.json → migrator no-ops AND leaves the corrupt file untouched", async () => {
    const corrupt = "{not valid JSON";
    writeFileSync(settingsPath, corrupt);
    const status = await runPermissionMigration({
      legacyExecutionMode: "auto",
      settingsPathOverride: settingsPath,
      migrationPathOverride: migrationPath,
    });
    expect(status.justApplied).toBe(false);
    expect(status.appliedAt).toBeUndefined();
    // Corrupt file byte-for-byte preserved.
    expect(readFileSync(settingsPath, "utf-8")).toBe(corrupt);
    // No provenance was written. `withFileLock` may touch
    // migration.json as a 0-byte placeholder so it can be locked,
    // but the file MUST stay empty — i.e. the migrator did not
    // serialise any state to it.
    const migrationBytes = existsSync(migrationPath)
      ? readFileSync(migrationPath, "utf-8")
      : "";
    expect(migrationBytes.trim()).toBe("");
  });

  it("idempotent — second run reports justApplied=false and preserves appliedAt", async () => {
    const first = await runPermissionMigration({
      legacyExecutionMode: "auto",
      settingsPathOverride: settingsPath,
      migrationPathOverride: migrationPath,
    });
    expect(first.justApplied).toBe(true);
    const before = readFileSync(migrationPath, "utf-8");

    const second = await runPermissionMigration({
      legacyExecutionMode: "auto",
      settingsPathOverride: settingsPath,
      migrationPathOverride: migrationPath,
    });
    expect(second.justApplied).toBe(false);
    expect(second.appliedAt).toBe(first.appliedAt);
    expect(readFileSync(migrationPath, "utf-8")).toBe(before);
  });

  it("concurrent invocation (Promise.all) → exactly one justApplied:true (single-lock critical section)", async () => {
    const [a, b] = await Promise.all([
      runPermissionMigration({
        legacyExecutionMode: "auto",
        settingsPathOverride: settingsPath,
        migrationPathOverride: migrationPath,
      }),
      runPermissionMigration({
        legacyExecutionMode: "auto",
        settingsPathOverride: settingsPath,
        migrationPathOverride: migrationPath,
      }),
    ]);
    const applied = [a, b].filter((s) => s.justApplied);
    const idempotent = [a, b].filter((s) => !s.justApplied);
    expect(applied.length).toBe(1);
    expect(idempotent.length).toBe(1);
    expect(idempotent[0].appliedAt).toBe(applied[0].appliedAt);
  });

  it("readPermissionMigrationStatus reflects on-disk state without mutating", async () => {
    expect(readPermissionMigrationStatus(migrationPath).schemaVersion).toBeUndefined();

    await runPermissionMigration({
      legacyExecutionMode: "auto",
      settingsPathOverride: settingsPath,
      migrationPathOverride: migrationPath,
    });

    const status = readPermissionMigrationStatus(migrationPath);
    expect(status.schemaVersion).toBe(PERMISSION_SETTINGS_SCHEMA_VERSION);
    expect(status.appliedSchemaVersion).toBe(PERMISSION_SETTINGS_SCHEMA_VERSION);
    expect(status.appliedAt).toBeTypeOf("string");
    expect(status.previous).toEqual({
      reviewer: { interactive: { autoApprove: "off" } },
    });
    expect(status.justApplied).toBe(false);
  });

  it("audit field preservation: appliedSchemaVersion survives reading a file written by a hypothetically future build", async () => {
    // Write a future-build provenance file by hand: schemaVersion=2
    // (current), but appliedSchemaVersion=3 (audit history claim).
    // The reader must NOT clamp the audit field to the current
    // constant — that would erase a forensic record.
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(tmp, "permissions"), { recursive: true });
    writeFileSync(
      migrationPath,
      JSON.stringify({
        schemaVersion: PERMISSION_SETTINGS_SCHEMA_VERSION,
        appliedSchemaVersion: 3,
        appliedAt: "2099-01-01T00:00:00.000Z",
      }),
    );
    const status = readPermissionMigrationStatus(migrationPath);
    expect(status.schemaVersion).toBe(PERMISSION_SETTINGS_SCHEMA_VERSION);
    expect(status.appliedSchemaVersion).toBe(3); // preserved
  });
});
