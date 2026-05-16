/**
 * Checkpoint view-mode and branch — ConversationLoop unit tests.
 *
 * Tests:
 *  1. enterViewMode returns null when checkpoint not found
 *  2. enterViewMode returns messageIndexAtCreation for a known checkpoint
 *  3. exitViewMode is a no-op (does not throw)
 *  4. branchFromCheckpoint throws when checkpoint not found
 *  5. branchFromCheckpoint throws when snapshot is null (not saved yet)
 *  6. branchFromCheckpoint throws when snapshot is shorter than messageCountAtTrigger
 *  7. branchFromCheckpoint loads from snapshot, slices to messageCountAtTrigger, persists branch metadata
 */
import { describe, it, expect, vi } from "vitest";

import { KeywordEngine } from "../../core/keyword-engine.js";
import { RouteEngine } from "../../core/route-engine.js";
import { ConversationLoop } from "../conversation-loop.js";
import { ToolRegistry } from "../../tools/registry.js";
import { fakeLlmSettings } from "../../shared/__tests__/fake-llm-settings.js";
import { SessionTodoStore } from "../../main/session-todo-store.js";

const FAKE_DISK_MESSAGES = [
  { role: "user" as const, content: [{ type: "text" as const, text: "q1" }] },
  { role: "assistant" as const, content: "a1" },
  { role: "user" as const, content: [{ type: "text" as const, text: "q2" }] },
];

function makeLoop(
  metaCheckpoints?: Array<{ compactNum: number; messageCountAtTrigger: number; summary?: string | null }>,
  snapshotMessages?: unknown[] | null,
) {
  const toolRegistry = new ToolRegistry();

  const savedSessions = new Map<string, unknown[]>();
  const savedMetadata = new Map<string, unknown>();

  // By default simulate a snapshot that has FAKE_DISK_MESSAGES (3 messages),
  // unless the caller explicitly passes null (snapshot not found) or a custom array.
  const resolvedSnapshot = snapshotMessages === undefined ? FAKE_DISK_MESSAGES : snapshotMessages;

  const memoryManager = {
    saveSession: vi.fn(async (id: string, msgs: unknown[]) => { savedSessions.set(id, msgs); }),
    saveSessionMetadata: vi.fn(async (id: string, meta: unknown) => { savedMetadata.set(id, meta); }),
    loadSessionMetadata: vi.fn((_id: string) => {
      if (!metaCheckpoints) return null;
      return { checkpoints: metaCheckpoints };
    }),
    loadCheckpointSnapshot: vi.fn((_id: string, _num: number) => resolvedSnapshot),
    listSessions: vi.fn(() => []),
  };

  const loop = new ConversationLoop(({
    settingsService: {
      get: () => fakeLlmSettings(),
      getSecret: () => "test-key",
    },
    systemPromptBuilder: {
      build: () => "system",
    },
    keywordEngine: new KeywordEngine(),
    routeEngine: new RouteEngine({ toolRegistry }),
    toolRegistry,
    memoryManager,
    sessionTodoStore: new SessionTodoStore(),
  } as unknown) as ConstructorParameters<typeof ConversationLoop>[0]);

  return { loop, memoryManager, savedSessions, savedMetadata };
}

describe("ConversationLoop enterViewMode", () => {
  it("returns null when no checkpoints exist in session metadata", () => {
    const { loop } = makeLoop([]);
    expect(loop.enterViewMode(1)).toBeNull();
  });

  it("returns null when the requested compactNum is not in checkpoints", () => {
    const { loop } = makeLoop([{ compactNum: 2, messageCountAtTrigger: 10 }]);
    expect(loop.enterViewMode(99)).toBeNull();
  });

  it("returns messageIndexAtCreation for a known checkpoint", () => {
    const { loop } = makeLoop([
      { compactNum: 1, messageCountAtTrigger: 4 },
      { compactNum: 2, messageCountAtTrigger: 10 },
    ]);
    expect(loop.enterViewMode(2)).toEqual({ messageIndexAtCreation: 10 });
  });
});

describe("ConversationLoop exitViewMode", () => {
  it("is a no-op and does not throw", () => {
    const { loop } = makeLoop();
    expect(() => loop.exitViewMode()).not.toThrow();
  });
});

describe("ConversationLoop branchFromCheckpoint", () => {
  it("throws when the checkpoint is not found", async () => {
    const { loop } = makeLoop([]);
    await expect(loop.branchFromCheckpoint(5)).rejects.toThrow("Checkpoint #5 not found");
  });

  it("throws when checkpoint snapshot is null (not saved yet)", async () => {
    const { loop } = makeLoop([{ compactNum: 1, messageCountAtTrigger: 2 }], null);
    await expect(loop.branchFromCheckpoint(1)).rejects.toThrow("no snapshot found");
  });

  it("throws when snapshot is shorter than messageCountAtTrigger", async () => {
    // Snapshot has only 1 message, checkpoint expects 10
    const { loop } = makeLoop(
      [{ compactNum: 1, messageCountAtTrigger: 10 }],
      [{ role: "user", content: "only one msg" }],
    );
    await expect(loop.branchFromCheckpoint(1)).rejects.toThrow("snapshot length");
  });

  it("repairs orphaned tool_call/tool_result pairs from a malformed snapshot before persisting", async () => {
    // Snapshot simulates a malformed JSONL that skipped a tool_result line,
    // leaving an orphaned tool_call (no matching tool_result partner).
    // GenericMessage format uses message.toolCalls[] for assistant tool calls
    // and role="tool_result" messages for results.
    // normalizeToolPairInvariant should strip the dangling toolCall so the
    // branched session has a valid paired history.
    const orphanedSnapshot = [
      { role: "user" as const, content: [{ type: "text" as const, text: "hello" }] },
      // Assistant message with a tool_call whose tool_result was skipped (malformed JSONL)
      { role: "assistant" as const, content: "ok", toolCalls: [{ id: "t1", name: "foo", input: {} }] },
      // tool_result for "t1" deliberately omitted — simulates malformed JSONL skip
      { role: "user" as const, content: [{ type: "text" as const, text: "next question" }] },
    ];
    // messageCountAtTrigger covers all 3 messages from the snapshot
    const { loop, savedSessions } = makeLoop(
      [{ compactNum: 2, messageCountAtTrigger: 3 }],
      orphanedSnapshot,
    );

    const { newSessionId } = await loop.branchFromCheckpoint(2);

    const saved = savedSessions.get(newSessionId) as unknown[] | undefined;
    expect(saved).toBeDefined();
    // normalizeToolPairInvariant strips toolCalls with no matching tool_result.
    // The assistant message had visible content ("ok"), so it is kept but with toolCalls removed.
    // Verify no saved message retains toolCalls referencing the orphaned id "t1".
    const hasOrphanedToolCall = (saved ?? []).some((msg: unknown) => {
      const m = msg as { role: string; toolCalls?: Array<{ id: string }> };
      return m.role === "assistant" && Array.isArray(m.toolCalls) && m.toolCalls.some((tc) => tc.id === "t1");
    });
    expect(hasOrphanedToolCall).toBe(false);
  });

  it("loads from snapshot, slices to messageCountAtTrigger, and persists branch metadata", async () => {
    // FAKE_DISK_MESSAGES has 3 messages; checkpoint at messageCountAtTrigger=2
    const { loop, memoryManager, savedSessions, savedMetadata } = makeLoop([
      { compactNum: 1, messageCountAtTrigger: 2 },
    ]);
    // In-memory history is intentionally empty (simulates post-compaction state)
    // to confirm the implementation reads from snapshot, not this.history

    const { newSessionId } = await loop.branchFromCheckpoint(1);

    // loadCheckpointSnapshot was called for the current session and compactNum
    expect(memoryManager.loadCheckpointSnapshot).toHaveBeenCalledWith(loop.getSessionId(), 1);

    // New session id is a UUID
    expect(newSessionId).toMatch(/^[0-9a-f-]{36}$/);

    // Saved messages are sliced to exactly messageCountAtTrigger (2) from snapshot
    const saved = savedSessions.get(newSessionId) as unknown[] | undefined;
    expect(saved).toBeDefined();
    expect(saved!.length).toBe(2);

    // Metadata includes checkpoint provenance and prior summary.
    const meta = savedMetadata.get(newSessionId) as Record<string, unknown> | undefined;
    expect(meta).toBeDefined();
    expect(meta!.parentSessionId).toBe(loop.getSessionId());
    expect(meta!.branchedFromCompactNum).toBe(1);
    expect(typeof meta!.branchedAt).toBe("string");
  });

  it("persists checkpoint summary as branch summaryPreamble", async () => {
    const { loop, savedMetadata } = makeLoop([
      { compactNum: 1, messageCountAtTrigger: 2, summary: "요약된 이전 맥락" },
    ]);

    const { newSessionId } = await loop.branchFromCheckpoint(1);

    const meta = savedMetadata.get(newSessionId) as Record<string, unknown> | undefined;
    expect(meta?.summaryPreamble).toBe("요약된 이전 맥락");
  });
});
