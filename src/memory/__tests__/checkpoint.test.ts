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
    trigger: "hard-token",
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
    const second = makeCheckpoint({ id: "ckpt-0002", messageCountAtTrigger: 60, trigger: "semantic-llm" });
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
    expect(loaded!.checkpoints![0].trigger).toBe("hard-token");
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
            trigger: "hard-token",
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
