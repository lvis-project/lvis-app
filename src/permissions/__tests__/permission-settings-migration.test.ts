/**
 * Tests for the v1→v2 permission-settings migration (issue #690 follow-up).
 *
 * Covers:
 *   - Fresh install (no file) → migrator writes schemaVersion=2 + migration.appliedAt
 *   - Legacy `auto` exec mode → reviewer.interactive.autoApprove flipped to "low"
 *   - Legacy non-auto exec mode → reviewer.interactive.autoApprove unchanged
 *   - Idempotency: second run is a no-op (justApplied=false, no rewrite of appliedAt)
 *   - Read-only status accessor reflects on-disk state without mutating
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  migratePermissionSettings,
  readPermissionMigrationStatus,
  readPermissionSettings,
  PERMISSION_SETTINGS_SCHEMA_VERSION,
} from "../permission-settings-store.js";

let tmp: string;
let path: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "lvis-perm-migrate-"));
  path = join(tmp, "settings.json");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("migratePermissionSettings (v1 → v2)", () => {
  it("writes schemaVersion + appliedAt on a fresh install", async () => {
    const status = await migratePermissionSettings("default", path);
    expect(status.justApplied).toBe(true);
    expect(status.schemaVersion).toBe(PERMISSION_SETTINGS_SCHEMA_VERSION);
    expect(typeof status.appliedAt).toBe("string");
    expect(existsSync(path)).toBe(true);
    const onDisk = readPermissionSettings(path);
    expect(onDisk.permissions.schemaVersion).toBe(PERMISSION_SETTINGS_SCHEMA_VERSION);
    expect(onDisk.permissions.migration?.appliedAt).toBe(status.appliedAt);
    expect(onDisk.permissions.migration?.appliedSchemaVersion).toBe(
      PERMISSION_SETTINGS_SCHEMA_VERSION,
    );
  });

  it("flips reviewer.interactive.autoApprove to 'low' when legacy mode === 'auto'", async () => {
    await migratePermissionSettings("auto", path);
    const onDisk = readPermissionSettings(path);
    expect(onDisk.permissions.reviewer.interactive.autoApprove).toBe("low");
  });

  it("leaves reviewer.interactive.autoApprove='off' when legacy mode is non-auto", async () => {
    await migratePermissionSettings("strict", path);
    const onDisk = readPermissionSettings(path);
    expect(onDisk.permissions.reviewer.interactive.autoApprove).toBe("off");
  });

  it("does NOT downgrade an existing reviewer.interactive.autoApprove='low' to 'off'", async () => {
    // Hand-author a v1 file where the user already set autoApprove=low.
    // The migrator must preserve that even when legacy mode is non-auto.
    writeFileSync(
      path,
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
    await migratePermissionSettings("strict", path);
    const onDisk = readPermissionSettings(path);
    expect(onDisk.permissions.reviewer.interactive.autoApprove).toBe("low");
  });

  it("is idempotent — second run reports justApplied=false and preserves appliedAt", async () => {
    const first = await migratePermissionSettings("auto", path);
    expect(first.justApplied).toBe(true);
    const before = readFileSync(path, "utf-8");

    const second = await migratePermissionSettings("auto", path);
    expect(second.justApplied).toBe(false);
    expect(second.schemaVersion).toBe(PERMISSION_SETTINGS_SCHEMA_VERSION);
    expect(second.appliedAt).toBe(first.appliedAt);

    // No file rewrite on the idempotent path → content unchanged.
    const after = readFileSync(path, "utf-8");
    expect(after).toBe(before);
  });

  it("readPermissionMigrationStatus reflects on-disk state without mutating", async () => {
    const beforeStatus = readPermissionMigrationStatus(path);
    expect(beforeStatus.appliedAt).toBeUndefined();
    expect(beforeStatus.schemaVersion).toBeUndefined();

    await migratePermissionSettings("auto", path);

    const afterStatus = readPermissionMigrationStatus(path);
    expect(afterStatus.appliedAt).toBeDefined();
    expect(afterStatus.schemaVersion).toBe(PERMISSION_SETTINGS_SCHEMA_VERSION);
    expect(afterStatus.justApplied).toBe(false);
  });
});
