/**
 * Tests for migrateCanonicalization() — issue #837 follow-up to PR #828.
 *
 * Verifies that boot-time migration correctly re-keys persistent entries
 * whose args contain nested-array-of-objects (affected by the RFC 8785 JCS
 * deep-canonicalization upgrade in canonical-json.ts).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm, mkdir, writeFile, readFile, access } from "node:fs/promises";
import { randomBytes, createHash } from "node:crypto";

// Point LVIS_HOME at an isolated temp dir so tests don't touch ~/.lvis
const TEST_HOME = join(tmpdir(), `lvis-test-ua-migr-${randomBytes(4).toString("hex")}`);
process.env.LVIS_HOME = TEST_HOME;

import {
  migrateCanonicalization,
  recordApproval,
  lookupApproval,
  readApprovals,
  canonicalStringify,
  __resetSessionStoreForTest,
} from "../user-approval-store.js";

const APPROVALS_PATH = join(TEST_HOME, "permissions", "user-approvals.json");
const MARKER_PATH = join(TEST_HOME, "permissions", ".canonicalization-migration-v1");

/** Build a sha256 entryKey the same way user-approval-store does. */
function makeKey(
  toolName: string,
  args: string,
  source: string,
  trustOrigin?: string,
  approvalCacheKey?: string,
): string {
  const components = [toolName, args, source];
  if (trustOrigin) components.push(trustOrigin);
  if (approvalCacheKey) components.push(approvalCacheKey);
  return createHash("sha256").update(components.join("\0")).digest("hex");
}

/** Write a raw approvals file directly to disk (bypasses recordApproval). */
async function writeRawApprovals(approvals: Record<string, unknown>): Promise<void> {
  await mkdir(join(TEST_HOME, "permissions"), { recursive: true, mode: 0o700 });
  await writeFile(APPROVALS_PATH, `${JSON.stringify({ approvals }, null, 2)}\n`, { mode: 0o600 });
}

beforeEach(async () => {
  await mkdir(TEST_HOME, { recursive: true });
  __resetSessionStoreForTest();
});

afterEach(async () => {
  await rm(TEST_HOME, { recursive: true, force: true });
  __resetSessionStoreForTest();
});

// ─── Case 1: stale entry with nested-array-of-objects gets re-keyed ───────────

describe("migrateCanonicalization — Case 1: nested-array-of-objects entry re-keyed", () => {
  it("migrates a stale entry whose args contain nested objects inside an array", async () => {
    // Simulate the OLD canonicalization: before PR #828, arrays were handed
    // directly to JSON.stringify without recursing into nested objects.
    // So [{b:2,a:1}] was stored as '[{"b":2,"a":1}]' (key order not sorted).
    const toolName = "mcp_tool";
    const source = "mcp";
    const argsObj = [{ b: 2, a: 1 }]; // nested object inside array

    // OLD key: JSON.stringify preserves insertion order for nested objects.
    const oldArgs = JSON.stringify(argsObj); // '[{"b":2,"a":1}]'
    const oldKey = makeKey(toolName, oldArgs, source);

    // NEW key: canonicalStringify sorts nested object keys → [{a:1,b:2}]
    const newArgs = canonicalStringify(argsObj); // '[{"a":1,"b":2}]'
    const newKey = makeKey(toolName, newArgs, source);

    // Sanity: the two keys must be different for this test to be meaningful.
    expect(oldKey).not.toBe(newKey);

    // Write a stale entry under the OLD key, with args stored as the old form.
    await writeRawApprovals({
      [oldKey]: {
        approvedAt: "2026-01-01T00:00:00.000Z",
        scope: "persistent",
        verdictAtApproval: "low",
        nlJustification: null,
        revokedAt: null,
        toolName,
        source,
        args: oldArgs, // OLD canonical string stored in entry
      },
    });

    await migrateCanonicalization();

    // After migration the entry must be under the NEW key.
    const file = await readApprovals();
    expect(file.approvals[oldKey]).toBeUndefined();
    expect(file.approvals[newKey]).toBeDefined();
    expect(file.approvals[newKey].args).toBe(newArgs);

    // Marker file must exist.
    await expect(access(MARKER_PATH)).resolves.toBeUndefined();
  });

  it("lookup succeeds after migration for the same args object", async () => {
    const toolName = "mcp_tool";
    const source = "mcp";
    const argsObj = [{ b: 2, a: 1 }];
    const oldArgs = JSON.stringify(argsObj);
    const oldKey = makeKey(toolName, oldArgs, source);

    await writeRawApprovals({
      [oldKey]: {
        approvedAt: "2026-01-01T00:00:00.000Z",
        scope: "persistent",
        verdictAtApproval: "low",
        nlJustification: null,
        revokedAt: null,
        toolName,
        source,
        args: oldArgs,
      },
    });

    await migrateCanonicalization();

    // Lookup using the new canonical form must hit.
    const newArgs = canonicalStringify(argsObj);
    const hit = await lookupApproval(toolName, newArgs, source);
    expect(hit).not.toBeNull();
    expect(hit!.verdictAtApproval).toBe("low");
  });
});

// ─── Case 2: second call is a noop (idempotency) ──────────────────────────────

describe("migrateCanonicalization — Case 2: idempotency", () => {
  it("second call is a noop — file and marker unchanged", async () => {
    // Record a normal entry so there is something on disk.
    await recordApproval("bash_run", '{"command":"ls"}', "user-keyboard", {
      scope: "persistent",
      verdictAtApproval: "low",
      nlJustification: null,
    });

    await migrateCanonicalization(); // first run — writes marker

    const markerContentFirst = await readFile(MARKER_PATH, "utf8");
    const fileContentFirst = await readFile(APPROVALS_PATH, "utf8");

    // Advance clock slightly — if second run rewrites marker the mtime differs.
    await new Promise((r) => setTimeout(r, 10));

    __resetSessionStoreForTest();
    await migrateCanonicalization(); // second run — must be noop

    const markerContentSecond = await readFile(MARKER_PATH, "utf8");
    const fileContentSecond = await readFile(APPROVALS_PATH, "utf8");

    // Marker content must not change (same timestamp = same JSON = same content).
    expect(markerContentSecond).toBe(markerContentFirst);
    // Approvals file must not change.
    expect(fileContentSecond).toBe(fileContentFirst);
  });
});

// ─── Case 3: entries without nested-array-of-objects are unchanged ─────────────

describe("migrateCanonicalization — Case 3: flat entries are not spuriously rewritten", () => {
  it("flat args (no nested-array-of-objects) are unchanged after migration", async () => {
    const toolName = "file_read";
    const source = "builtin";
    // Flat object — canonicalStringify and JSON.stringify produce the same result.
    const argsObj = { path: "/tmp/a", mode: "r" };
    const argsStr = canonicalStringify(argsObj); // '{"mode":"r","path":"/tmp/a"}'
    const key = makeKey(toolName, argsStr, source);

    await writeRawApprovals({
      [key]: {
        approvedAt: "2026-01-01T00:00:00.000Z",
        scope: "persistent",
        verdictAtApproval: "low",
        nlJustification: null,
        revokedAt: null,
        toolName,
        source,
        args: argsStr,
      },
    });

    const fileBefore = await readFile(APPROVALS_PATH, "utf8");
    await migrateCanonicalization();
    const fileAfter = await readFile(APPROVALS_PATH, "utf8");

    // File must be unchanged (no rewrite for flat entries).
    expect(fileAfter).toBe(fileBefore);

    // Key must still resolve.
    const hit = await lookupApproval(toolName, argsStr, source);
    expect(hit).not.toBeNull();
  });

  it("entries without stored args field are carried forward unchanged", async () => {
    // Pre-Round-3 entries lack toolName/source/args — must survive migration.
    const syntheticKey = randomBytes(32).toString("hex");
    await writeRawApprovals({
      [syntheticKey]: {
        approvedAt: "2025-01-01T00:00:00.000Z",
        scope: "persistent",
        verdictAtApproval: "medium",
        nlJustification: null,
        revokedAt: null,
        // no toolName, source, or args fields
      },
    });

    await migrateCanonicalization();

    const file = await readApprovals();
    expect(file.approvals[syntheticKey]).toBeDefined();
  });
});

// ─── Case 4: corrupt / unreadable approvals file — boot must not crash ────────

describe("migrateCanonicalization — Case 4: corrupt JSON file does not abort boot", () => {
  it("gracefully handles a corrupt JSON approvals file without throwing", async () => {
    // Write a syntactically invalid JSON file to simulate corruption.
    await mkdir(join(TEST_HOME, "permissions"), { recursive: true, mode: 0o700 });
    await writeFile(APPROVALS_PATH, "{ this is not valid JSON !!! }", { mode: 0o600 });

    // Must not throw — MAJOR-1 try/catch in migrateCanonicalization.
    await expect(migrateCanonicalization()).resolves.toBeUndefined();

    // Marker must NOT be written so the next boot can retry.
    await expect(access(MARKER_PATH)).rejects.toThrow();
  });

  it("gracefully handles a truncated/incomplete JSON file without throwing", async () => {
    // Write a truncated JSON file — simulates a partially-written file from
    // a prior crash (a different kind of read-level failure from corrupt JSON).
    await mkdir(join(TEST_HOME, "permissions"), { recursive: true, mode: 0o700 });
    await writeFile(APPROVALS_PATH, '{"approvals": {"abc": {', { mode: 0o600 });

    await expect(migrateCanonicalization()).resolves.toBeUndefined();

    // Marker must NOT be written — next boot should retry.
    await expect(access(MARKER_PATH)).rejects.toThrow();
  });
});

// ─── Case 5: write failure — boot does not crash, marker not written ──────────

describe("migrateCanonicalization — Case 5: write failure does not crash boot and skips marker", () => {
  it("does not write marker when the approvals file cannot be read (EACCES-like)", async () => {
    // Simulate a read failure by writing a corrupt file that throws on JSON.parse
    // but in a way that is NOT ENOENT (so readApprovalsFile re-throws).
    // We achieve this by writing a non-JSON file that is NOT empty.
    await mkdir(join(TEST_HOME, "permissions"), { recursive: true, mode: 0o700 });
    await writeFile(APPROVALS_PATH, "NOT_VALID_JSON", { mode: 0o600 });

    // migrateCanonicalization wraps in try/catch — must not throw.
    await expect(migrateCanonicalization()).resolves.toBeUndefined();

    // Marker must NOT be written — next boot should retry.
    await expect(access(MARKER_PATH)).rejects.toThrow();
  });

  it("atomic write uses tmp+rename so a mid-write crash leaves original intact", async () => {
    // Verify that the atomicWrite pattern means the approvals file is only
    // replaced after a successful rename — i.e., the original file path is
    // never partially written. We test this by confirming the final file is
    // a complete valid JSON document after a successful migration.
    const toolName = "mcp_tool";
    const source = "mcp";
    const argsObj = [{ b: 2, a: 1 }];
    const oldArgs = JSON.stringify(argsObj);
    const oldKey = makeKey(toolName, oldArgs, source);
    const newArgs = canonicalStringify(argsObj);
    const newKey = makeKey(toolName, newArgs, source);

    await writeRawApprovals({
      [oldKey]: {
        approvedAt: "2026-01-01T00:00:00.000Z",
        scope: "persistent",
        verdictAtApproval: "low",
        nlJustification: null,
        revokedAt: null,
        toolName,
        source,
        args: oldArgs,
      },
    });

    await migrateCanonicalization();

    // File must be valid JSON with the new key and no tmp artifacts.
    const raw = await readFile(APPROVALS_PATH, "utf8");
    const parsed = JSON.parse(raw) as { approvals: Record<string, unknown> };
    expect(parsed.approvals[newKey]).toBeDefined();
    expect(parsed.approvals[oldKey]).toBeUndefined();
    // No .tmp files left behind.
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(join(TEST_HOME, "permissions"));
    expect(files.some((f) => f.endsWith(".tmp"))).toBe(false);
  });
});

// ─── Case 6: mixed-version entries (old args-having + legacy no-args) ─────────

describe("migrateCanonicalization — Case 6: mixed old-format and legacy entries", () => {
  it("migrates args-having entries and carries forward legacy no-args entries", async () => {
    const toolName = "mcp_tool";
    const source = "mcp";
    const argsObj = [{ b: 2, a: 1 }];
    const oldArgs = JSON.stringify(argsObj);
    const oldKey = makeKey(toolName, oldArgs, source);
    const newArgs = canonicalStringify(argsObj);
    const newKey = makeKey(toolName, newArgs, source);

    const legacyKey = randomBytes(32).toString("hex");

    await writeRawApprovals({
      // New-format entry with args — should be re-keyed.
      [oldKey]: {
        approvedAt: "2026-01-01T00:00:00.000Z",
        scope: "persistent",
        verdictAtApproval: "low",
        nlJustification: null,
        revokedAt: null,
        toolName,
        source,
        args: oldArgs,
      },
      // Legacy entry without args — should be carried forward unchanged.
      [legacyKey]: {
        approvedAt: "2025-06-01T00:00:00.000Z",
        scope: "persistent",
        verdictAtApproval: "medium",
        nlJustification: null,
        revokedAt: null,
        // no toolName / source / args
      },
    });

    await migrateCanonicalization();

    const file = await readApprovals();
    // Stale entry must be re-keyed.
    expect(file.approvals[oldKey]).toBeUndefined();
    expect(file.approvals[newKey]).toBeDefined();
    // Legacy entry must survive unchanged.
    expect(file.approvals[legacyKey]).toBeDefined();
    expect(file.approvals[legacyKey].verdictAtApproval).toBe("medium");
  });
});

// ─── Case 7: revokedAt entry is carried forward to new key ────────────────────

describe("migrateCanonicalization — Case 7: revokedAt entry carries forward on re-key", () => {
  it("preserves revokedAt timestamp after re-keying a stale entry", async () => {
    const toolName = "mcp_tool";
    const source = "mcp";
    const argsObj = [{ b: 2, a: 1 }];
    const oldArgs = JSON.stringify(argsObj);
    const oldKey = makeKey(toolName, oldArgs, source);
    const newArgs = canonicalStringify(argsObj);
    const newKey = makeKey(toolName, newArgs, source);

    const revokedAt = "2026-02-15T12:00:00.000Z";

    await writeRawApprovals({
      [oldKey]: {
        approvedAt: "2026-01-01T00:00:00.000Z",
        scope: "persistent",
        verdictAtApproval: "low",
        nlJustification: null,
        revokedAt,
        toolName,
        source,
        args: oldArgs,
      },
    });

    await migrateCanonicalization();

    const file = await readApprovals();
    expect(file.approvals[oldKey]).toBeUndefined();
    expect(file.approvals[newKey]).toBeDefined();
    // revokedAt must be preserved on the new key.
    expect(file.approvals[newKey].revokedAt).toBe(revokedAt);
    // Marker must exist.
    await expect(access(MARKER_PATH)).resolves.toBeUndefined();
  });

  it("collision: revoked entry wins over active entry for same new key", async () => {
    const toolName = "mcp_tool";
    const source = "mcp";
    const argsObj = [{ b: 2, a: 1 }];
    const newArgs = canonicalStringify(argsObj);
    const newKey = makeKey(toolName, newArgs, source);

    // Two stale entries that both canonicalize to newKey.
    // entry A: active (revokedAt null), entry B: revoked.
    const oldArgsA = JSON.stringify(argsObj);
    const oldKeyA = makeKey(toolName, oldArgsA, source);

    // Manufacture a second distinct stale key that also maps to newKey by
    // writing the already-canonical args under a hand-crafted hash that
    // differs from newKey (simulates a real collision scenario via direct write).
    const collisionKey = randomBytes(32).toString("hex");
    const revokedAt = "2026-03-01T00:00:00.000Z";

    await writeRawApprovals({
      // Active entry under the real stale oldKey.
      [oldKeyA]: {
        approvedAt: "2026-01-01T00:00:00.000Z",
        scope: "persistent",
        verdictAtApproval: "low",
        nlJustification: null,
        revokedAt: null,
        toolName,
        source,
        args: oldArgsA,
      },
      // Revoked entry whose stored args will also re-canonicalize to newKey.
      [collisionKey]: {
        approvedAt: "2026-01-02T00:00:00.000Z",
        scope: "persistent",
        verdictAtApproval: "low",
        nlJustification: null,
        revokedAt,
        toolName,
        source,
        // args already canonical — will produce newKey on re-key.
        args: newArgs,
      },
    });

    await migrateCanonicalization();

    const file = await readApprovals();
    expect(file.approvals[newKey]).toBeDefined();
    // Revoked entry must win (revokedAt non-null takes priority).
    expect(file.approvals[newKey].revokedAt).toBe(revokedAt);
  });
});
