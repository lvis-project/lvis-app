/**
 * §PR-5 Layer 3 View-Mode + Branch — ConversationLoop unit tests.
 *
 * Tests:
 *  1. enterViewMode returns null when checkpoint not found
 *  2. enterViewMode returns messageIndexAtCreation for a known checkpoint
 *  3. exitViewMode is a no-op (does not throw)
 *  4. branchFromCheckpoint throws when checkpoint not found
 *  5. branchFromCheckpoint persists sliced history + metadata with parentSessionId
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
  metaCheckpoints?: Array<{ compactNum: number; messageCountAtTrigger: number }>,
  diskMessages?: unknown[] | null,
) {
  const toolRegistry = new ToolRegistry();

  const savedSessions = new Map<string, unknown[]>();
  const savedMetadata = new Map<string, unknown>();

  // By default simulate a disk that has FAKE_DISK_MESSAGES (3 messages),
  // unless the caller explicitly passes null (session not found) or a custom array.
  const resolvedDisk = diskMessages === undefined ? FAKE_DISK_MESSAGES : diskMessages;

  const memoryManager = {
    saveSession: vi.fn(async (id: string, msgs: unknown[]) => { savedSessions.set(id, msgs); }),
    saveSessionMetadata: vi.fn(async (id: string, meta: unknown) => { savedMetadata.set(id, meta); }),
    loadSessionMetadata: vi.fn((_id: string) => {
      if (!metaCheckpoints) return null;
      return { checkpoints: metaCheckpoints };
    }),
    loadSession: vi.fn((_id: string) => resolvedDisk),
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

describe("ConversationLoop §PR-5 enterViewMode", () => {
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

describe("ConversationLoop §PR-5 exitViewMode", () => {
  it("is a no-op and does not throw", () => {
    const { loop } = makeLoop();
    expect(() => loop.exitViewMode()).not.toThrow();
  });
});

describe("ConversationLoop §PR-5 branchFromCheckpoint", () => {
  it("throws when the checkpoint is not found", async () => {
    const { loop } = makeLoop([]);
    await expect(loop.branchFromCheckpoint(5)).rejects.toThrow("Checkpoint #5 not found");
  });

  it("throws when session is not on disk", async () => {
    const { loop } = makeLoop([{ compactNum: 1, messageCountAtTrigger: 2 }], null);
    await expect(loop.branchFromCheckpoint(1)).rejects.toThrow("not found on disk");
  });

  it("throws when disk transcript is shorter than messageCountAtTrigger", async () => {
    // Disk has only 1 message, checkpoint expects 10
    const { loop } = makeLoop(
      [{ compactNum: 1, messageCountAtTrigger: 10 }],
      [{ role: "user", content: "only one msg" }],
    );
    await expect(loop.branchFromCheckpoint(1)).rejects.toThrow("disk transcript length");
  });

  it("loads from disk, slices to messageCountAtTrigger, and persists branch metadata", async () => {
    // FAKE_DISK_MESSAGES has 3 messages; checkpoint at messageCountAtTrigger=2
    const { loop, memoryManager, savedSessions, savedMetadata } = makeLoop([
      { compactNum: 1, messageCountAtTrigger: 2 },
    ]);
    // In-memory history is intentionally empty (simulates post-compaction state)
    // to confirm the implementation reads from disk, not this.history

    const { newSessionId } = await loop.branchFromCheckpoint(1);

    // loadSession was called for the current session
    expect(memoryManager.loadSession).toHaveBeenCalledWith(loop.getSessionId());

    // New session id is a UUID
    expect(newSessionId).toMatch(/^[0-9a-f-]{36}$/);

    // Saved messages are sliced to exactly messageCountAtTrigger (2) from disk
    const saved = savedSessions.get(newSessionId) as unknown[] | undefined;
    expect(saved).toBeDefined();
    expect(saved!.length).toBe(2);

    // Metadata includes parentSessionId and branchedFromCompactNum
    const meta = savedMetadata.get(newSessionId) as Record<string, unknown> | undefined;
    expect(meta).toBeDefined();
    expect(meta!.parentSessionId).toBe(loop.getSessionId());
    expect(meta!.branchedFromCompactNum).toBe(1);
    expect(typeof meta!.branchedAt).toBe("string");
  });
});
