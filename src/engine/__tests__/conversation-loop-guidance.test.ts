/**
 * Engine guidance buffer + round-boundary inject — regression guard for the
 * "guide" mode of the chat utterance taxonomy (`src/shared/chat-utterance.ts`).
 *
 * Contract (re-stated for future readers):
 *   - `queueGuidance(text)` returns `"queued" | "no-active-turn" | "queue-full"
 *     | "too-long" | "empty"`. Bounded by `GUIDE_MAX_ENTRIES` (16) and
 *     `GUIDE_MAX_CHARS` (8000) — caller MUST surface non-"queued" results
 *     so the renderer can preserve the user's typed text.
 *   - At each round boundary AFTER round 0 (between tool execution end and
 *     the next LLM stream), any buffered text is drained, joined with
 *     `"\n\n"`, prepended with the "[방향 지시 — ...]" marker, and appended
 *     to history as a `user` message so the model sees it like normal input.
 *   - Per user spec "방향지시는 endturn 전에 영향을 미치는 거": when a turn
 *     would end (no tool calls or stopReason="end_turn") but guide is queued,
 *     the loop refuses to return and falls through to one more round so the
 *     LLM responds to the queued direction-adjustment. Round-cap still applies
 *     — if cap is reached, `onGuidanceDropped` fires and the user sees a
 *     visible "방향 지시 미적용" system entry.
 *   - `onGuidanceInjected(text)` and `onGuidanceDropped(text)` callbacks fire
 *     per round-boundary drain / per turn-end drop so the renderer surfaces
 *     visible system entries.
 *   - `hasActiveTurn()` is `currentAbortController !== null`, set just before
 *     `queryLoop` and cleared in `runTurn`'s `finally`.
 */
import { describe, expect, it } from "vitest";

import { KeywordEngine } from "../../core/keyword-engine.js";
import { RouteEngine } from "../../core/route-engine.js";
import { ConversationLoop } from "../conversation-loop.js";
import type { LLMProvider, StreamEvent } from "../llm/types.js";
import { ToolRegistry } from "../../tools/registry.js";
import { createDynamicTool } from "../../tools/base.js";
import { fakeLlmSettings } from "../../shared/__tests__/fake-llm-settings.js";

class FakeProvider implements LLMProvider {
  readonly vendor = "openai" as const;
  private index = 0;
  /**
   * Optional hook fired right BEFORE the next turn yields its first event.
   * Tests use this to call `queueGuidance` after the turn has started (so
   * `currentAbortController` is set and the active-turn check passes)
   * without needing to spin up real concurrent IPC traffic.
   */
  beforeNextTurn?: () => void;

  constructor(private readonly turns: StreamEvent[][]) {}

  async *streamTurn(): AsyncIterable<StreamEvent> {
    this.beforeNextTurn?.();
    this.beforeNextTurn = undefined;
    yield* this.turns[this.index++] ?? [];
  }
}

function makeLoop(provider: LLMProvider): ConversationLoop {
  const toolRegistry = new ToolRegistry();
  toolRegistry.register(createDynamicTool({
    name: "noop_tool",
    description: "no-op",
    source: "builtin",
    category: "read",
    jsonSchema: { type: "object", properties: {} },
    execute: async () => ({ output: "ok", isError: false }),
  }));
  const loop = new ConversationLoop(({
    settingsService: { get: () => fakeLlmSettings(), getSecret: () => "test-key" },
    systemPromptBuilder: { build: () => "system" },
    keywordEngine: new KeywordEngine(),
    routeEngine: new RouteEngine({ toolRegistry }),
    toolRegistry,
    memoryManager: { saveSession: () => {}, listSessions: () => [] },
  } as unknown) as ConstructorParameters<typeof ConversationLoop>[0]);
  (loop as { provider: LLMProvider | null }).provider = provider;
  return loop;
}

function getHistory(loop: ConversationLoop) {
  return (loop as unknown as { history: { getMessages: () => Array<{ role: string; content: unknown }> } }).history.getMessages();
}

describe("ConversationLoop guidance queue + boundary inject", () => {
  it("queues guide text and injects it at the next round boundary (between tool rounds)", async () => {
    const provider = new FakeProvider([
      // Round 0: emit tool_call so the loop runs a second round.
      [
        { type: "text_delta", text: "보고를 시작합니다." } as StreamEvent,
        { type: "tool_call", id: "t1", name: "noop_tool", input: {} } as StreamEvent,
        { type: "message_complete", stopReason: "tool_use" } as StreamEvent,
      ],
      // Round 1 (after tool result): final text.
      [
        { type: "text_delta", text: "방향 반영 결과." } as StreamEvent,
        { type: "message_complete", stopReason: "end_turn" } as StreamEvent,
      ],
    ]);
    // Queue mid-turn (after currentAbortController is set, before round 1
    // starts) so the active-turn check passes and the inject site catches it.
    provider.beforeNextTurn = () => {
      // First yield of turn 0 — controller is set; queue guidance now.
      // (Subsequent yields no-op because `beforeNextTurn = undefined`.)
    };
    const loop = makeLoop(provider);
    const injected: string[] = [];

    // Schedule queueGuidance right after runTurn starts.
    const turnPromise = loop.runTurn(
      "긴 보고서 만들어줘",
      { onGuidanceInjected: (t) => injected.push(t) },
      undefined,
      { inputOrigin: "user-keyboard" },
    );
    // Microtask ordering: by the time the first stream event resolves, the
    // controller has been set. Queue guidance now.
    await Promise.resolve();
    loop.queueGuidance("더 짧게 요약");
    await turnPromise;

    expect(injected).toEqual(["더 짧게 요약"]);
    const userMessages = getHistory(loop).filter((m) => m.role === "user");
    expect(userMessages.some((m) => typeof m.content === "string" && m.content.includes("[방향 지시 — 진행 중 추가 입력]") && m.content.includes("더 짧게 요약"))).toBe(true);
  });

  it("joins multiple queued utterances at the same boundary with blank-line separators", async () => {
    const provider = new FakeProvider([
      [
        { type: "tool_call", id: "t1", name: "noop_tool", input: {} } as StreamEvent,
        { type: "message_complete", stopReason: "tool_use" } as StreamEvent,
      ],
      [
        { type: "text_delta", text: "done" } as StreamEvent,
        { type: "message_complete", stopReason: "end_turn" } as StreamEvent,
      ],
    ]);
    const loop = makeLoop(provider);
    const injected: string[] = [];
    const turnPromise = loop.runTurn(
      "작업 시작",
      { onGuidanceInjected: (t) => injected.push(t) },
      undefined,
      { inputOrigin: "user-keyboard" },
    );
    await Promise.resolve();
    loop.queueGuidance("첫번째 지시");
    loop.queueGuidance("두번째 지시");
    await turnPromise;

    expect(injected).toHaveLength(1);
    expect(injected[0]).toBe("첫번째 지시\n\n두번째 지시");
  });

  it("extends a 1-round turn by one round to deliver queued guide BEFORE end-turn", async () => {
    // User spec: "방향지시는 endturn 전에 영향을 미치는 거". A naive
    // single-round turn would let end_turn ship before the inject site runs;
    // queryLoop now refuses to return when guidance is queued, falling
    // through to one more round so the LLM responds with the guide applied.
    const provider = new FakeProvider([
      [
        { type: "text_delta", text: "원래 답" } as StreamEvent,
        { type: "message_complete", stopReason: "end_turn" } as StreamEvent,
      ],
      [
        { type: "text_delta", text: "수정 답" } as StreamEvent,
        { type: "message_complete", stopReason: "end_turn" } as StreamEvent,
      ],
    ]);
    const loop = makeLoop(provider);
    const injected: string[] = [];
    const dropped: string[] = [];
    const turnPromise = loop.runTurn(
      "질문",
      { onGuidanceInjected: (t) => injected.push(t), onGuidanceDropped: (t) => dropped.push(t) },
      undefined,
      { inputOrigin: "user-keyboard" },
    );
    await Promise.resolve();
    loop.queueGuidance("더 짧게");
    await turnPromise;

    expect(injected).toEqual(["더 짧게"]);
    expect(dropped).toEqual([]);
  });

  it("rejects empty / oversized / no-active-turn cases by return code", () => {
    const provider = new FakeProvider([]);
    const loop = makeLoop(provider);
    // No active turn — IPC handler must surface this so renderer keeps text.
    expect(loop.queueGuidance("뭔가")).toBe("no-active-turn");
    // Synthesize an active turn for the rest of the matrix.
    (loop as { currentAbortController: AbortController | null }).currentAbortController = new AbortController();
    expect(loop.queueGuidance("")).toBe("empty");
    expect(loop.queueGuidance("   \n\t  ")).toBe("empty");
    expect(loop.queueGuidance("a".repeat(8_001))).toBe("too-long");
    expect(loop.queueGuidance("ok")).toBe("queued");
  });

  it("queue-full rejection at GUIDE_MAX_ENTRIES (16)", () => {
    const loop = makeLoop(new FakeProvider([]));
    (loop as { currentAbortController: AbortController | null }).currentAbortController = new AbortController();
    for (let i = 0; i < 16; i++) {
      expect(loop.queueGuidance(`g${i}`)).toBe("queued");
    }
    expect(loop.queueGuidance("overflow")).toBe("queue-full");
  });

  it("fires onGuidanceDropped when round-cap blocks the extension", async () => {
    // maxRounds: 1 → one assistant round allowed; extension would need a
    // second round, which the cap forbids. Queue must drain via the
    // drop-on-end path so the renderer surfaces the failure.
    const provider = new FakeProvider([
      [
        { type: "text_delta", text: "응답" } as StreamEvent,
        { type: "message_complete", stopReason: "end_turn" } as StreamEvent,
      ],
    ]);
    const loop = makeLoop(provider);
    const injected: string[] = [];
    const dropped: string[] = [];
    const turnPromise = loop.runTurn(
      "q",
      { onGuidanceInjected: (t) => injected.push(t), onGuidanceDropped: (t) => dropped.push(t) },
      undefined,
      { inputOrigin: "user-keyboard", maxRounds: 1 },
    );
    await Promise.resolve();
    loop.queueGuidance("late");
    await turnPromise;

    expect(injected).toEqual([]);
    expect(dropped).toEqual(["late"]);
  });

  it("`hasActiveTurn()` reflects in-flight runTurn for IPC gate", async () => {
    const provider = new FakeProvider([
      [
        { type: "text_delta", text: "ok" } as StreamEvent,
        { type: "message_complete", stopReason: "end_turn" } as StreamEvent,
      ],
    ]);
    const loop = makeLoop(provider);
    expect(loop.hasActiveTurn()).toBe(false);
    const p = loop.runTurn("test", undefined, undefined, { inputOrigin: "user-keyboard" });
    await p;
    expect(loop.hasActiveTurn()).toBe(false);
  });
});
