/**
 * Tests for checkpoint chain fields (parentSessionId, summaryPreamble, checkpoints[]).
 * Spec: PR-1 — session DB checkpoint chain fields.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "../memory-manager.js";
import type { Checkpoint, SessionMetadata } from "../memory-manager.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeCheckpoint(overrides?: Partial<Checkpoint>): Checkpoint {
  return {
    id: "ckpt-0001",
    triggeredAt: "2026-05-01T10:00:00.000Z",
    trigger: "auto-compact",
    ctxUsageAtTrigger: 0.85,
    summary: "We discussed the quarterly review.",
    messageCountAtTrigger: 40,
    ...overrides,
  };
}

const SESSION_A = "aaaaaaaa-0000-1111-2222-333333333333";
const SESSION_B = "bbbbbbbb-0000-1111-2222-333333333333";
const SESSION_C = "cccccccc-0000-1111-2222-333333333333";

// ── Setup ─────────────────────────────────────────────────────────────────────

let dir: string;
let mm: MemoryManager;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lvis-ckpt-"));
  mm = new MemoryManager({ lvisDir: dir });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ── 1. appendCheckpoint ───────────────────────────────────────────────────────

describe("appendCheckpoint", () => {
  it("adds a checkpoint to metadata with no prior checkpoints", () => {
    const meta: SessionMetadata = { routineId: "r1" };
    const ckpt = makeCheckpoint();
    const updated = mm.appendCheckpoint(meta, ckpt);
    expect(updated.checkpoints).toHaveLength(1);
    expect(updated.checkpoints![0]).toEqual(ckpt);
  });

  it("preserves existing checkpoints when appending a new one", () => {
    const first = makeCheckpoint({ id: "ckpt-0001", messageCountAtTrigger: 20 });
    const second = makeCheckpoint({ id: "ckpt-0002", messageCountAtTrigger: 60, trigger: "auto-compact" });
    const meta: SessionMetadata = { checkpoints: [first] };
    const updated = mm.appendCheckpoint(meta, second);
    expect(updated.checkpoints).toHaveLength(2);
    expect(updated.checkpoints![0]).toEqual(first);
    expect(updated.checkpoints![1]).toEqual(second);
  });

  it("does not mutate the original metadata object", () => {
    const meta: SessionMetadata = { checkpoints: [makeCheckpoint()] };
    const original = JSON.stringify(meta);
    mm.appendCheckpoint(meta, makeCheckpoint({ id: "ckpt-new" }));
    expect(JSON.stringify(meta)).toBe(original);
  });

  it("persists checkpoints correctly through saveSessionMetadata + loadSessionMetadata", async () => {
    const sessionId = SESSION_A;
    await mm.saveSession(sessionId, [{ role: "user", content: "hello" }]);
    const ckpt = makeCheckpoint();
    const meta: SessionMetadata = { routineId: "r1" };
    const updated = mm.appendCheckpoint(meta, ckpt);
    await mm.saveSessionMetadata(sessionId, updated);

    const loaded = mm.loadSessionMetadata(sessionId);
    expect(loaded).not.toBeNull();
    expect(loaded!.checkpoints).toHaveLength(1);
    expect(loaded!.checkpoints![0].id).toBe("ckpt-0001");
    expect(loaded!.checkpoints![0].trigger).toBe("auto-compact");
    expect(loaded!.checkpoints![0].summary).toBe("We discussed the quarterly review.");
  });
});

// ── 2. setSummaryPreamble ─────────────────────────────────────────────────────

describe("setSummaryPreamble", () => {
  it("stores the preamble in metadata", () => {
    const meta: SessionMetadata = {};
    const updated = mm.setSummaryPreamble(meta, "Summary of prior discussion.");
    expect(updated.summaryPreamble).toBe("Summary of prior discussion.");
  });

  it("replaces an existing preamble", () => {
    const meta: SessionMetadata = { summaryPreamble: "old preamble" };
    const updated = mm.setSummaryPreamble(meta, "new preamble");
    expect(updated.summaryPreamble).toBe("new preamble");
  });

  it("truncates preamble exceeding 8000 chars", () => {
    const long = "x".repeat(10_000);
    const updated = mm.setSummaryPreamble({}, long);
    expect(updated.summaryPreamble!.length).toBe(8_000);
  });

  it("does not truncate preamble at exactly 8000 chars", () => {
    const exact = "y".repeat(8_000);
    const updated = mm.setSummaryPreamble({}, exact);
    expect(updated.summaryPreamble!.length).toBe(8_000);
  });

  it("does not mutate the original metadata object", () => {
    const meta: SessionMetadata = { summaryPreamble: "original" };
    mm.setSummaryPreamble(meta, "new value");
    expect(meta.summaryPreamble).toBe("original");
  });

  it("persists and loads preamble round-trip", async () => {
    const sessionId = SESSION_B;
    await mm.saveSession(sessionId, [{ role: "user", content: "hello" }]);
    const updated = mm.setSummaryPreamble({}, "context from previous session");
    await mm.saveSessionMetadata(sessionId, updated);

    const loaded = mm.loadSessionMetadata(sessionId);
    expect(loaded!.summaryPreamble).toBe("context from previous session");
  });
});

// ── 3. getCheckpointChain ─────────────────────────────────────────────────────

describe("getCheckpointChain", () => {
  it("returns empty array when session has no metadata", async () => {
    const chain = await mm.getCheckpointChain("no-metadata-session");
    expect(chain).toEqual([]);
  });

  it("returns single-element chain for a root session (no parentSessionId)", async () => {
    await mm.saveSession(SESSION_A, [{ role: "user", content: "root" }]);
    await mm.saveSessionMetadata(SESSION_A, { routineId: "r1" });
    const chain = await mm.getCheckpointChain(SESSION_A);
    expect(chain).toHaveLength(1);
    expect(chain[0].routineId).toBe("r1");
  });

  it("traverses a 3-node chain (root → mid → leaf) in correct order", async () => {
    // Setup 3 sessions: A is root, B is child of A, C is child of B
    await mm.saveSession(SESSION_A, [{ role: "user", content: "root msg" }]);
    await mm.saveSessionMetadata(SESSION_A, { routineId: "r1", summaryPreamble: "root summary" });

    await mm.saveSession(SESSION_B, [{ role: "user", content: "mid msg" }]);
    await mm.saveSessionMetadata(SESSION_B, {
      parentSessionId: SESSION_A,
      summaryPreamble: "mid summary",
    });

    await mm.saveSession(SESSION_C, [{ role: "user", content: "leaf msg" }]);
    await mm.saveSessionMetadata(SESSION_C, {
      parentSessionId: SESSION_B,
      summaryPreamble: "leaf summary",
    });

    const chain = await mm.getCheckpointChain(SESSION_C);
    expect(chain).toHaveLength(3);
    // Order: oldest (A/root) first
    expect(chain[0].summaryPreamble).toBe("root summary");
    expect(chain[1].summaryPreamble).toBe("mid summary");
    expect(chain[2].summaryPreamble).toBe("leaf summary");
  });

  it("stops at the first missing session in the chain", async () => {
    // B → A, but A has no metadata file
    await mm.saveSession(SESSION_B, [{ role: "user", content: "msg" }]);
    await mm.saveSessionMetadata(SESSION_B, { parentSessionId: SESSION_A });

    const chain = await mm.getCheckpointChain(SESSION_B);
    // B is included, but traversal stops when A metadata is not found
    expect(chain).toHaveLength(1);
    expect(chain[0].parentSessionId).toBe(SESSION_A);
  });

  it("guards against infinite cycles", async () => {
    // A → B → A (cycle)
    await mm.saveSession(SESSION_A, [{ role: "user", content: "a" }]);
    await mm.saveSessionMetadata(SESSION_A, { parentSessionId: SESSION_B });
    await mm.saveSession(SESSION_B, [{ role: "user", content: "b" }]);
    await mm.saveSessionMetadata(SESSION_B, { parentSessionId: SESSION_A });

    const chain = await mm.getCheckpointChain(SESSION_B);
    // Should not loop forever — stops when cycle is detected
    expect(chain.length).toBeLessThanOrEqual(3);
  });
});

// ── 4. Backward compatibility ─────────────────────────────────────────────────

describe("backward compatibility — loading old-format metadata", () => {
  it("loads legacy metadata (routineId/routineTitle only) without crashing", async () => {
    const sessionId = SESSION_A;
    await mm.saveSession(sessionId, [{ role: "user", content: "legacy" }]);
    // Write metadata in old format (no new fields)
    const sessionsDir = join(dir, "sessions");
    writeFileSync(
      join(sessionsDir, `${sessionId}.meta.json`),
      JSON.stringify({ routineId: "legacy-r1", routineTitle: "Legacy Routine" }),
      "utf-8",
    );

    const meta = mm.loadSessionMetadata(sessionId);
    expect(meta).not.toBeNull();
    expect(meta!.routineId).toBe("legacy-r1");
    expect(meta!.routineTitle).toBe("Legacy Routine");
    expect(meta!.parentSessionId).toBeUndefined();
    expect(meta!.summaryPreamble).toBeUndefined();
    expect(meta!.checkpoints).toBeUndefined();
  });

  it("silently drops checkpoint entries with invalid trigger values", async () => {
    const sessionId = SESSION_B;
    await mm.saveSession(sessionId, [{ role: "user", content: "msg" }]);
    const sessionsDir = join(dir, "sessions");
    writeFileSync(
      join(sessionsDir, `${sessionId}.meta.json`),
      JSON.stringify({
        checkpoints: [
          {
            id: "ckpt-valid",
            triggeredAt: "2026-05-01T10:00:00.000Z",
            trigger: "auto-compact",
            ctxUsageAtTrigger: 0.9,
            summary: null,
            messageCountAtTrigger: 30,
          },
          {
            id: "ckpt-invalid",
            triggeredAt: "2026-05-01T11:00:00.000Z",
            trigger: "unknown-trigger",  // invalid
            ctxUsageAtTrigger: 0.5,
            summary: null,
            messageCountAtTrigger: 50,
          },
        ],
      }),
      "utf-8",
    );

    const meta = mm.loadSessionMetadata(sessionId);
    expect(meta!.checkpoints).toHaveLength(1);
    expect(meta!.checkpoints![0].id).toBe("ckpt-valid");
  });
});

// ── 5b. normalizeCheckpoint range validation ──────────────────────────────────

describe("normalizeCheckpoint range validation", () => {
  it("drops checkpoint with ctxUsageAtTrigger below 0", async () => {
    const sessionId = SESSION_A;
    await mm.saveSession(sessionId, [{ role: "user", content: "msg" }]);
    const sessionsDir = join(dir, "sessions");
    writeFileSync(
      join(sessionsDir, `${sessionId}.meta.json`),
      JSON.stringify({
        checkpoints: [
          {
            id: "ckpt-neg-ctx",
            triggeredAt: "2026-05-01T10:00:00.000Z",
            trigger: "auto-compact",
            ctxUsageAtTrigger: -0.5,
            summary: null,
            messageCountAtTrigger: 10,
          },
        ],
      }),
      "utf-8",
    );
    const meta = mm.loadSessionMetadata(sessionId);
    expect(meta!.checkpoints).toBeUndefined();
  });

  it("drops checkpoint with ctxUsageAtTrigger above 1", async () => {
    const sessionId = SESSION_B;
    await mm.saveSession(sessionId, [{ role: "user", content: "msg" }]);
    const sessionsDir = join(dir, "sessions");
    writeFileSync(
      join(sessionsDir, `${sessionId}.meta.json`),
      JSON.stringify({
        checkpoints: [
          {
            id: "ckpt-over-ctx",
            triggeredAt: "2026-05-01T10:00:00.000Z",
            trigger: "auto-compact",
            ctxUsageAtTrigger: 1.5,
            summary: null,
            messageCountAtTrigger: 10,
          },
        ],
      }),
      "utf-8",
    );
    const meta = mm.loadSessionMetadata(sessionId);
    expect(meta!.checkpoints).toBeUndefined();
  });

  it("drops checkpoint with ctxUsageAtTrigger = NaN", async () => {
    const sessionId = SESSION_C;
    await mm.saveSession(sessionId, [{ role: "user", content: "msg" }]);
    const sessionsDir = join(dir, "sessions");
    // Test JSON-encoded null (representing NaN that was JSON.stringify'd, since JSON has no NaN literal)
    writeFileSync(
      join(sessionsDir, `${sessionId}.meta.json`),
      JSON.stringify({
        checkpoints: [
          {
            id: "ckpt-nan-ctx",
            triggeredAt: "2026-05-01T10:00:00.000Z",
            trigger: "auto-compact",
            ctxUsageAtTrigger: null,
            summary: null,
            messageCountAtTrigger: 10,
          },
        ],
      }),
      "utf-8",
    );
    const meta = mm.loadSessionMetadata(sessionId);
    expect(meta!.checkpoints).toBeUndefined();
  });

  it("drops checkpoint with negative messageCountAtTrigger", async () => {
    const sessionId = SESSION_A;
    await mm.saveSession(sessionId, [{ role: "user", content: "msg" }]);
    const sessionsDir = join(dir, "sessions");
    writeFileSync(
      join(sessionsDir, `${sessionId}.meta.json`),
      JSON.stringify({
        checkpoints: [
          {
            id: "ckpt-neg-msg",
            triggeredAt: "2026-05-01T10:00:00.000Z",
            trigger: "auto-compact",
            ctxUsageAtTrigger: 0.5,
            summary: null,
            messageCountAtTrigger: -1,
          },
        ],
      }),
      "utf-8",
    );
    const meta = mm.loadSessionMetadata(sessionId);
    expect(meta!.checkpoints).toBeUndefined();
  });

  it("drops checkpoint with fractional messageCountAtTrigger", async () => {
    const sessionId = SESSION_B;
    await mm.saveSession(sessionId, [{ role: "user", content: "msg" }]);
    const sessionsDir = join(dir, "sessions");
    writeFileSync(
      join(sessionsDir, `${sessionId}.meta.json`),
      JSON.stringify({
        checkpoints: [
          {
            id: "ckpt-float-msg",
            triggeredAt: "2026-05-01T10:00:00.000Z",
            trigger: "auto-compact",
            ctxUsageAtTrigger: 0.5,
            summary: null,
            messageCountAtTrigger: 1.5,
          },
        ],
      }),
      "utf-8",
    );
    const meta = mm.loadSessionMetadata(sessionId);
    expect(meta!.checkpoints).toBeUndefined();
  });
});

// ── 5c. getCheckpointChain O(n) order + path-traversal safety ────────────────

describe("getCheckpointChain — O(n) order + path traversal guard", () => {
  it("returns root-first order for a 100-node chain", async () => {
    // Build a chain of 100 sessions: s0 (root) → s1 → … → s99 (leaf).
    // Then call getCheckpointChain(s99) and verify the result is ordered s0..s99.
    const ids: string[] = Array.from({ length: 100 }, (_, i) =>
      `test-chain-${String(i).padStart(3, "0")}-aaaa-bbbb-cccc-dddddddddddd`,
    );
    for (let i = 0; i < ids.length; i++) {
      await mm.saveSession(ids[i], [{ role: "user", content: `msg ${i}` }]);
      const meta: SessionMetadata = {
        summaryPreamble: `summary-${i}`,
        ...(i > 0 ? { parentSessionId: ids[i - 1] } : {}),
      };
      await mm.saveSessionMetadata(ids[i], meta);
    }
    const chain = await mm.getCheckpointChain(ids[99]);
    expect(chain).toHaveLength(100);
    // Root first, leaf last
    expect(chain[0].summaryPreamble).toBe("summary-0");
    expect(chain[99].summaryPreamble).toBe("summary-99");
    // Spot-check middle
    expect(chain[50].summaryPreamble).toBe("summary-50");
  });

  it("stops traversal when parentSessionId contains path-traversal characters", async () => {
    const sessionsDir = join(dir, "sessions");
    await mm.saveSession(SESSION_A, [{ role: "user", content: "leaf" }]);
    // Write metadata directly with a malicious parentSessionId
    writeFileSync(
      join(sessionsDir, `${SESSION_A}.meta.json`),
      JSON.stringify({ parentSessionId: "../../../etc/passwd" }),
      "utf-8",
    );
    const chain = await mm.getCheckpointChain(SESSION_A);
    // SESSION_A itself is included, but traversal stops — no external file read attempted.
    // normalizeSessionMetadata drops the malicious parentSessionId so it is undefined here.
    expect(chain).toHaveLength(1);
    expect(chain[0].parentSessionId).toBeUndefined();
  });

  it("stops traversal when parentSessionId contains a slash-only segment", async () => {
    const sessionsDir = join(dir, "sessions");
    await mm.saveSession(SESSION_B, [{ role: "user", content: "leaf" }]);
    writeFileSync(
      join(sessionsDir, `${SESSION_B}.meta.json`),
      JSON.stringify({ parentSessionId: "../etc" }),
      "utf-8",
    );
    const chain = await mm.getCheckpointChain(SESSION_B);
    expect(chain).toHaveLength(1);
  });

  it("returns empty array when caller-provided sessionId contains path-traversal characters", async () => {
    // Fix 1: caller-provided sessionId must be validated before any file I/O.
    const chain = await mm.getCheckpointChain("../etc/passwd");
    expect(chain).toEqual([]);
  });
});

// ── 5e. normalizeSessionMetadata parentSessionId validation ──────────────────

describe("normalizeSessionMetadata — parentSessionId regex validation", () => {
  it("drops parentSessionId with path-traversal characters during normalize", async () => {
    const sessionId = SESSION_A;
    await mm.saveSession(sessionId, [{ role: "user", content: "msg" }]);
    const sessionsDir = join(dir, "sessions");
    writeFileSync(
      join(sessionsDir, `${sessionId}.meta.json`),
      JSON.stringify({ routineId: "r1", parentSessionId: "../../../etc/passwd" }),
      "utf-8",
    );
    // normalizeSessionMetadata must drop the invalid parentSessionId
    const meta = mm.loadSessionMetadata(sessionId);
    expect(meta).not.toBeNull();
    expect(meta!.routineId).toBe("r1");
    expect(meta!.parentSessionId).toBeUndefined();
  });

  it("preserves a valid parentSessionId through normalize", async () => {
    const sessionId = SESSION_B;
    await mm.saveSession(sessionId, [{ role: "user", content: "msg" }]);
    const sessionsDir = join(dir, "sessions");
    writeFileSync(
      join(sessionsDir, `${sessionId}.meta.json`),
      JSON.stringify({ parentSessionId: SESSION_A }),
      "utf-8",
    );
    const meta = mm.loadSessionMetadata(sessionId);
    expect(meta!.parentSessionId).toBe(SESSION_A);
  });
});

// ── 5d. saveSessionMetadata truncation enforcement ────────────────────────────

describe("saveSessionMetadata — summaryPreamble truncation invariant", () => {
  it("truncates summaryPreamble exceeding 8000 chars even when setSummaryPreamble was bypassed", async () => {
    const sessionId = SESSION_C;
    await mm.saveSession(sessionId, [{ role: "user", content: "hello" }]);
    // Bypass setSummaryPreamble by setting summaryPreamble directly in the metadata object
    const overlong = "z".repeat(12_000);
    await mm.saveSessionMetadata(sessionId, { summaryPreamble: overlong });

    const loaded = mm.loadSessionMetadata(sessionId);
    expect(loaded!.summaryPreamble!.length).toBe(8_000);
  });

  it("does not mutate original metadata passed to saveSessionMetadata", async () => {
    const sessionId = SESSION_A;
    await mm.saveSession(sessionId, [{ role: "user", content: "hello" }]);
    const overlong = "z".repeat(12_000);
    const original: SessionMetadata = { summaryPreamble: overlong };
    await mm.saveSessionMetadata(sessionId, original);
    // The original object must not be mutated
    expect(original.summaryPreamble!.length).toBe(12_000);
  });

  it("does not alter summaryPreamble that is exactly at the limit", async () => {
    const sessionId = SESSION_B;
    await mm.saveSession(sessionId, [{ role: "user", content: "hello" }]);
    const exact = "a".repeat(8_000);
    await mm.saveSessionMetadata(sessionId, { summaryPreamble: exact });
    const loaded = mm.loadSessionMetadata(sessionId);
    expect(loaded!.summaryPreamble!.length).toBe(8_000);
  });
});

// ── 5f. isValidSessionId helper (3rd-pass: unified helper) ───────────────────

describe("isValidSessionId helper — valid/invalid boundaries", () => {
  // Access the helper indirectly via normalizeSessionMetadata by using loadSessionMetadata
  // with injected parentSessionId values.

  it("accepts a standard UUID-format parentSessionId", async () => {
    const sessionsDir = join(dir, "sessions");
    await mm.saveSession(SESSION_A, [{ role: "user", content: "msg" }]);
    writeFileSync(
      join(sessionsDir, `${SESSION_A}.meta.json`),
      JSON.stringify({ parentSessionId: SESSION_B }),
      "utf-8",
    );
    const meta = mm.loadSessionMetadata(SESSION_A);
    expect(meta!.parentSessionId).toBe(SESSION_B);
  });

  it("accepts alphanumeric-plus-dash ID (non-UUID-shaped)", async () => {
    const sessionsDir = join(dir, "sessions");
    await mm.saveSession(SESSION_A, [{ role: "user", content: "msg" }]);
    writeFileSync(
      join(sessionsDir, `${SESSION_A}.meta.json`),
      JSON.stringify({ parentSessionId: "test-chain-000-aaaa-bbbb" }),
      "utf-8",
    );
    const meta = mm.loadSessionMetadata(SESSION_A);
    expect(meta!.parentSessionId).toBe("test-chain-000-aaaa-bbbb");
  });

  it("rejects parentSessionId with slash (path-traversal)", async () => {
    const sessionsDir = join(dir, "sessions");
    await mm.saveSession(SESSION_A, [{ role: "user", content: "msg" }]);
    writeFileSync(
      join(sessionsDir, `${SESSION_A}.meta.json`),
      JSON.stringify({ parentSessionId: "../evil" }),
      "utf-8",
    );
    const meta = mm.loadSessionMetadata(SESSION_A);
    expect(meta!.parentSessionId).toBeUndefined();
  });

  it("rejects parentSessionId with space", async () => {
    const sessionsDir = join(dir, "sessions");
    await mm.saveSession(SESSION_B, [{ role: "user", content: "msg" }]);
    writeFileSync(
      join(sessionsDir, `${SESSION_B}.meta.json`),
      JSON.stringify({ parentSessionId: "session id" }),
      "utf-8",
    );
    const meta = mm.loadSessionMetadata(SESSION_B);
    expect(meta!.parentSessionId).toBeUndefined();
  });

  it("rejects empty string parentSessionId", async () => {
    const sessionsDir = join(dir, "sessions");
    await mm.saveSession(SESSION_C, [{ role: "user", content: "msg" }]);
    writeFileSync(
      join(sessionsDir, `${SESSION_C}.meta.json`),
      JSON.stringify({ parentSessionId: "" }),
      "utf-8",
    );
    const meta = mm.loadSessionMetadata(SESSION_C);
    expect(meta!.parentSessionId).toBeUndefined();
  });
});

// ── 5g. normalizeSessionMetadata read-side preamble truncation ────────────────

describe("normalizeSessionMetadata — read-side summaryPreamble truncation (defense-in-depth)", () => {
  it("truncates summaryPreamble exceeding 8000 chars on read (corrupted file)", async () => {
    const sessionId = SESSION_A;
    await mm.saveSession(sessionId, [{ role: "user", content: "msg" }]);
    const sessionsDir = join(dir, "sessions");
    // Write a meta file with an overlong preamble directly — simulates a corrupted/externally-written file
    const overlong = "x".repeat(10_000);
    writeFileSync(
      join(sessionsDir, `${sessionId}.meta.json`),
      JSON.stringify({ summaryPreamble: overlong }),
      "utf-8",
    );
    const meta = mm.loadSessionMetadata(sessionId);
    expect(meta!.summaryPreamble!.length).toBe(8_000);
  });

  it("does not alter preamble at exactly 8000 chars on read", async () => {
    const sessionId = SESSION_B;
    await mm.saveSession(sessionId, [{ role: "user", content: "msg" }]);
    const sessionsDir = join(dir, "sessions");
    const exact = "y".repeat(8_000);
    writeFileSync(
      join(sessionsDir, `${sessionId}.meta.json`),
      JSON.stringify({ summaryPreamble: exact }),
      "utf-8",
    );
    const meta = mm.loadSessionMetadata(sessionId);
    expect(meta!.summaryPreamble!.length).toBe(8_000);
  });
});

// ── §PR-5: saveCheckpointSnapshot / loadCheckpointSnapshot ───────────────────

describe("saveCheckpointSnapshot / loadCheckpointSnapshot — §PR-5", () => {
  const SESSION_SNAP = "dddddddd-0000-1111-2222-333333333333";

  it("round-trips messages through save and load", async () => {
    const messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "world" },
    ];
    await mm.saveCheckpointSnapshot(SESSION_SNAP, 1, messages);
    const loaded = mm.loadCheckpointSnapshot(SESSION_SNAP, 1);
    expect(loaded).toEqual(messages);
  });

  it("returns null when snapshot does not exist", () => {
    const result = mm.loadCheckpointSnapshot(SESSION_SNAP, 99);
    expect(result).toBeNull();
  });

  it("snapshot files do NOT appear in listSessions", async () => {
    // Create a real session so listSessions has at least one entry
    await mm.saveSession(SESSION_SNAP, [{ role: "user", content: "real session" }]);
    // Save a checkpoint snapshot for that session
    await mm.saveCheckpointSnapshot(SESSION_SNAP, 1, [{ role: "user", content: "pre-compact" }]);

    const sessions = mm.listSessions();
    const ids = sessions.map((s) => s.id);

    // The real session must appear
    expect(ids).toContain(SESSION_SNAP);
    // No snapshot-derived id (e.g. containing ".cp" or housed in ".checkpoints") should appear
    expect(ids.every((id) => !id.includes(".cp") && !id.includes(".checkpoints"))).toBe(true);
    // Exactly one entry — snapshot did not add a ghost session
    const matchingReal = ids.filter((id) => id === SESSION_SNAP);
    expect(matchingReal).toHaveLength(1);
  });

  it("snapshot files do NOT appear in listSessionsPage", async () => {
    await mm.saveSession(SESSION_SNAP, [{ role: "user", content: "real" }]);
    await mm.saveCheckpointSnapshot(SESSION_SNAP, 2, [{ role: "user", content: "snap" }]);

    const page = mm.listSessionsPage({ limit: 100 });
    const ids = page.map((s) => s.id);
    expect(ids).toContain(SESSION_SNAP);
    expect(ids.every((id) => !id.includes(".cp") && !id.includes(".checkpoints"))).toBe(true);
  });

  it("multiple compactNums are all independently loadable", async () => {
    const m1 = [{ role: "user", content: "snap1" }];
    const m2 = [{ role: "user", content: "snap2" }, { role: "assistant", content: "a2" }];
    await mm.saveCheckpointSnapshot(SESSION_SNAP, 1, m1);
    await mm.saveCheckpointSnapshot(SESSION_SNAP, 2, m2);
    expect(mm.loadCheckpointSnapshot(SESSION_SNAP, 1)).toEqual(m1);
    expect(mm.loadCheckpointSnapshot(SESSION_SNAP, 2)).toEqual(m2);
  });

  it("rejects invalid sessionId without throwing fs errors", async () => {
    await expect(
      mm.saveCheckpointSnapshot("../evil/path", 1, []),
    ).rejects.toThrow(/invalid sessionId/);
    expect(mm.loadCheckpointSnapshot("../evil/path", 1)).toBeNull();
  });
});

// ── §PR-5: branchFromCheckpoint post-compaction simulation ────────────────────

describe("saveCheckpointSnapshot post-compaction simulation — §PR-5", () => {
  const SESSION_BRANCH = "eeeeeeee-0000-1111-2222-333333333333";

  it("snapshot survives a subsequent saveSession overwrite (simulates PostTurnHookChain)", async () => {
    const preCompact = [
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "q2" },
    ];
    const postCompact = [{ role: "assistant", content: "compact summary only" }];

    // Save snapshot at compact #1 (pre-compact state)
    await mm.saveCheckpointSnapshot(SESSION_BRANCH, 1, preCompact);

    // Simulate PostTurnHookChain.saveSession overwriting main JSONL with post-compact data
    await mm.saveSession(SESSION_BRANCH, postCompact);

    // Snapshot must still return the original pre-compact messages
    const loaded = mm.loadCheckpointSnapshot(SESSION_BRANCH, 1);
    expect(loaded).toEqual(preCompact);

    // Main session now reflects post-compact state
    const main = mm.loadSession(SESSION_BRANCH);
    expect(main).toEqual(postCompact);
  });
});

// ── 5h. saveSessionMetadata / loadSessionMetadata — IPC input validation ──────

describe("saveSessionMetadata — invalid sessionId throws", () => {
  it("throws for path-traversal sessionId (../etc/passwd)", async () => {
    await expect(mm.saveSessionMetadata("../etc/passwd", {})).rejects.toThrow(
      /invalid sessionId/,
    );
  });

  it("throws for sessionId with a slash", async () => {
    await expect(mm.saveSessionMetadata("a/b", {})).rejects.toThrow(/invalid sessionId/);
  });

  it("throws for empty string sessionId", async () => {
    await expect(mm.saveSessionMetadata("", {})).rejects.toThrow(/invalid sessionId/);
  });
});

describe("loadSessionMetadata — invalid sessionId throws", () => {
  it("throws for path-traversal sessionId (../etc/passwd)", () => {
    expect(() => mm.loadSessionMetadata("../etc/passwd")).toThrow(/invalid sessionId/);
  });

  it("throws for sessionId with a slash", () => {
    expect(() => mm.loadSessionMetadata("a/b")).toThrow(/invalid sessionId/);
  });

  it("throws for empty string sessionId", () => {
    expect(() => mm.loadSessionMetadata("")).toThrow(/invalid sessionId/);
  });
});

// ── 5. Round-trip ─────────────────────────────────────────────────────────────

describe("round-trip — write then read preserves all new fields", () => {
  it("persists all new fields and reads them back identically", async () => {
    const sessionId = SESSION_C;
    await mm.saveSession(sessionId, [{ role: "user", content: "hello" }]);

    const ckpt = makeCheckpoint({
      id: "ckpt-rt-01",
      trigger: "manual",
      ctxUsageAtTrigger: 0.42,
      summary: null,
      messageCountAtTrigger: 10,
    });
    const meta: SessionMetadata = {
      routineId: "r2",
      parentSessionId: SESSION_A,
      summaryPreamble: "prior context summary",
      checkpoints: [ckpt],
    };

    await mm.saveSessionMetadata(sessionId, meta);
    const loaded = mm.loadSessionMetadata(sessionId);

    expect(loaded).not.toBeNull();
    expect(loaded!.routineId).toBe("r2");
    expect(loaded!.parentSessionId).toBe(SESSION_A);
    expect(loaded!.summaryPreamble).toBe("prior context summary");
    expect(loaded!.checkpoints).toHaveLength(1);
    expect(loaded!.checkpoints![0]).toEqual(ckpt);
  });
});
