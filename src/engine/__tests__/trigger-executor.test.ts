/**
 * TriggerExecutor — fresh loop per trigger, IPC delivery, dismiss / import.
 *
 * The host gate (`evaluateTriggerSpec`) runs upstream and is tested against
 * the production function in `boot/__tests__/proactive-trigger.test.ts`.
 * Here we focus on the executor's responsibilities:
 *   1. each `run` constructs a fresh loop via the injected factory
 *   2. emits started / completed IPC events with the loop's sessionId
 *   3. caches the captured session for the import path
 *   4. `dismiss` drops the cache; `importIntoChat` hydrates a target loop
 */
import { describe, expect, it, vi } from "vitest";
import {
  TriggerExecutor,
  getCachedTriggerSession,
} from "../trigger-executor.js";
import { ConversationLoop } from "../conversation-loop.js";
import { KeywordEngine } from "../../core/keyword-engine.js";
import { RouteEngine } from "../../core/route-engine.js";
import { ToolRegistry } from "../../tools/registry.js";
import type { LLMProvider, StreamEvent } from "../llm/types.js";

class FakeProvider implements LLMProvider {
  readonly vendor = "openai" as const;
  private index = 0;
  constructor(private readonly turns: StreamEvent[][]) {}
  async *streamTurn(): AsyncIterable<StreamEvent> {
    yield* this.turns[this.index++] ?? [];
  }
}

function makeLoop(text: string): ConversationLoop {
  const toolRegistry = new ToolRegistry();
  const keywordEngine = new KeywordEngine();
  const routeEngine = new RouteEngine({ toolRegistry });
  const loop = new ConversationLoop(({
    settingsService: {
      get: () => ({ provider: "openai", model: "gpt-4o" }),
      getSecret: () => "test-key",
    },
    systemPromptBuilder: { build: () => "system" },
    keywordEngine,
    routeEngine,
    toolRegistry,
    memoryManager: {
      saveSession: () => {},
      listSessions: () => [],
    },
  } as unknown) as ConstructorParameters<typeof ConversationLoop>[0]);
  (loop as { provider: LLMProvider | null }).provider = new FakeProvider([
    [
      { type: "text_delta", text },
      { type: "message_complete", stopReason: "end_turn" },
    ],
  ]);
  return loop;
}

interface FakeWindow {
  webContents: { send: ReturnType<typeof vi.fn> };
  isDestroyed: () => boolean;
}

function makeFakeWindow(): FakeWindow {
  return {
    webContents: { send: vi.fn() },
    isDestroyed: () => false,
  };
}

const auditLogger = { log: vi.fn() };

describe("TriggerExecutor.run", () => {
  it("creates a fresh loop per call (factory invoked each time)", async () => {
    const create = vi.fn(() => makeLoop("ok"));
    const win = makeFakeWindow();
    const exec = new TriggerExecutor({
      createLoop: create,
      getMainWindow: () => win as never,
      auditLogger: auditLogger as never,
    });

    await exec.run({
      prompt: "x",
      source: "proactive:meeting-detection",
      visibility: "summary-only",
      priority: "normal",
    });
    await exec.run({
      prompt: "y",
      source: "proactive:meeting-detection",
      visibility: "summary-only",
      priority: "normal",
    });

    expect(create).toHaveBeenCalledTimes(2);
  });

  it("emits started + completed IPC events with the loop's sessionId", async () => {
    const win = makeFakeWindow();
    const exec = new TriggerExecutor({
      createLoop: () => makeLoop("회의실 예약했습니다"),
      getMainWindow: () => win as never,
      auditLogger: auditLogger as never,
    });

    await exec.run({
      prompt: "회의실 예약 도와드릴까요?",
      source: "proactive:meeting-detection",
      visibility: "user-visible",
      priority: "normal",
    });

    const calls = (win.webContents.send as ReturnType<typeof vi.fn>).mock.calls;
    const channels = calls.map((c) => c[0]);
    expect(channels).toContain("lvis:trigger:started");
    expect(channels).toContain("lvis:trigger:completed");

    const completed = calls.find((c) => c[0] === "lvis:trigger:completed");
    expect(completed?.[1]).toMatchObject({
      source: "proactive:meeting-detection",
      visibility: "user-visible",
      priority: "normal",
      summary: "회의실 예약했습니다",
    });
    // sessionId is opaque but must be present + non-empty.
    expect(typeof completed?.[1].sessionId).toBe("string");
    expect((completed?.[1].sessionId as string).length).toBeGreaterThan(0);
  });

  it("caches the trigger session for the import path", async () => {
    const win = makeFakeWindow();
    const exec = new TriggerExecutor({
      createLoop: () => makeLoop("done"),
      getMainWindow: () => win as never,
      auditLogger: auditLogger as never,
    });

    await exec.run({
      prompt: "x",
      source: "proactive:meeting-detection",
      visibility: "summary-only",
      priority: "normal",
    });

    const completed = (win.webContents.send as ReturnType<typeof vi.fn>).mock.calls
      .find((c) => c[0] === "lvis:trigger:completed");
    const sessionId = completed?.[1].sessionId as string;
    const cached = getCachedTriggerSession(sessionId);
    expect(cached).not.toBeNull();
    expect(cached?.summary).toBe("done");
  });

  it("emits failed IPC event when the loop rejects", async () => {
    const win = makeFakeWindow();
    const brokenLoop = makeLoop("");
    (brokenLoop as { provider: unknown }).provider = null; // forces runTurn throw
    const exec = new TriggerExecutor({
      createLoop: () => brokenLoop,
      getMainWindow: () => win as never,
      auditLogger: auditLogger as never,
    });

    await expect(
      exec.run({
        prompt: "x",
        source: "proactive:fail",
        visibility: "summary-only",
        priority: "normal",
      }),
    ).rejects.toBeDefined();

    const channels = (win.webContents.send as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(channels).toContain("lvis:trigger:failed");
    // No `completed` row on the failure path.
    expect(channels).not.toContain("lvis:trigger:completed");
  });
});

describe("TriggerExecutor.importIntoChat", () => {
  it("appends captured trigger messages onto the target chat history", async () => {
    const win = makeFakeWindow();
    const exec = new TriggerExecutor({
      createLoop: () => makeLoop("응답 본문"),
      getMainWindow: () => win as never,
      auditLogger: auditLogger as never,
    });
    await exec.run({
      prompt: "사용자에게 보일 templated 메시지",
      source: "proactive:meeting-detection",
      visibility: "user-visible",
      priority: "normal",
    });
    const sessionId = (win.webContents.send as ReturnType<typeof vi.fn>).mock.calls
      .find((c) => c[0] === "lvis:trigger:completed")?.[1].sessionId as string;

    const chat = makeLoop("unused");
    expect(chat.getHistory().getMessages()).toHaveLength(0);

    const result = exec.importIntoChat(sessionId, chat);
    expect(result.ok).toBe(true);
    expect(result.imported).toBeGreaterThan(0);
    expect(chat.getHistory().getMessages().length).toBe(result.imported);
    // Cache is consumed — second import returns not_found.
    const second = exec.importIntoChat(sessionId, chat);
    expect(second.ok).toBe(false);
    expect(second.reason).toBe("not_found");
  });

  it("rejects unknown sessionIds without mutating the chat history", () => {
    const win = makeFakeWindow();
    const exec = new TriggerExecutor({
      createLoop: () => makeLoop(""),
      getMainWindow: () => win as never,
      auditLogger: auditLogger as never,
    });
    const chat = makeLoop("");
    const result = exec.importIntoChat("nonexistent-id", chat);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("not_found");
    expect(chat.getHistory().getMessages()).toHaveLength(0);
  });
});

describe("TriggerExecutor.dismiss", () => {
  it("drops a cached session so subsequent imports fail with not_found", async () => {
    const win = makeFakeWindow();
    const exec = new TriggerExecutor({
      createLoop: () => makeLoop("x"),
      getMainWindow: () => win as never,
      auditLogger: auditLogger as never,
    });
    await exec.run({
      prompt: "x",
      source: "proactive:dismiss",
      visibility: "summary-only",
      priority: "normal",
    });
    const sessionId = (win.webContents.send as ReturnType<typeof vi.fn>).mock.calls
      .find((c) => c[0] === "lvis:trigger:completed")?.[1].sessionId as string;

    expect(exec.dismiss(sessionId)).toBe(true);
    expect(exec.dismiss(sessionId)).toBe(false); // already gone
    const importResult = exec.importIntoChat(sessionId, makeLoop(""));
    expect(importResult.reason).toBe("not_found");
  });
});

describe("TriggerExecutor isolation invariant", () => {
  it("trigger run does NOT mutate the chat loop's history", async () => {
    const win = makeFakeWindow();
    const chat = makeLoop("unused");
    const exec = new TriggerExecutor({
      createLoop: () => makeLoop("trigger output"),
      getMainWindow: () => win as never,
      auditLogger: auditLogger as never,
    });
    await exec.run({
      prompt: "회의실 예약 도와드릴까요?",
      source: "proactive:meeting-detection",
      visibility: "user-visible",
      priority: "normal",
    });
    // The chat loop is wholly untouched: factory returned a separate
    // ConversationLoop instance, so chat's ConversationHistory is empty.
    expect(chat.getHistory().getMessages()).toHaveLength(0);
  });
});
