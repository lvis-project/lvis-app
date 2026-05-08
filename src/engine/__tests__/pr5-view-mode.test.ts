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

function makeLoop(metaCheckpoints?: Array<{ compactNum: number; messageCountAtTrigger: number }>) {
  const toolRegistry = new ToolRegistry();

  const savedSessions = new Map<string, unknown[]>();
  const savedMetadata = new Map<string, unknown>();

  const memoryManager = {
    saveSession: vi.fn(async (id: string, msgs: unknown[]) => { savedSessions.set(id, msgs); }),
    saveSessionMetadata: vi.fn(async (id: string, meta: unknown) => { savedMetadata.set(id, meta); }),
    loadSessionMetadata: vi.fn((_id: string) => {
      if (!metaCheckpoints) return null;
      return { checkpoints: metaCheckpoints };
    }),
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

  it("persists sliced history and branch metadata", async () => {
    const { loop, savedSessions, savedMetadata } = makeLoop([
      { compactNum: 1, messageCountAtTrigger: 2 },
    ]);

    // Restore some fake messages into the loop's history
    const fakeMessages = [
      { role: "user" as const, content: [{ type: "text" as const, text: "q1" }] },
      { role: "assistant" as const, content: "a1" },
      { role: "user" as const, content: [{ type: "text" as const, text: "q2" }] },
    ];
    (loop as { history: { restore: (m: unknown[]) => void } }).history.restore(fakeMessages);

    const { newSessionId } = await loop.branchFromCheckpoint(1);

    // New session id is a UUID
    expect(newSessionId).toMatch(/^[0-9a-f-]{36}$/);

    // Saved messages are sliced to messageCountAtTrigger (2)
    const saved = savedSessions.get(newSessionId) as unknown[] | undefined;
    expect(saved).toBeDefined();
    expect(saved!.length).toBeLessThanOrEqual(2);

    // Metadata includes parentSessionId and branchedFromCompactNum
    const meta = savedMetadata.get(newSessionId) as Record<string, unknown> | undefined;
    expect(meta).toBeDefined();
    expect(meta!.parentSessionId).toBe(loop.getSessionId());
    expect(meta!.branchedFromCompactNum).toBe(1);
    expect(typeof meta!.branchedAt).toBe("string");
  });
});
