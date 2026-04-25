/**
 * P0 — `ConversationLoop.runTriggerTurn` smoke test.
 *
 * The proactive-brain entry point delegates to `runTurn` after writing an
 * audit row; this test verifies the templated prompt + delegation path.
 */
import { describe, expect, it } from "vitest";

import { KeywordEngine } from "../../core/keyword-engine.js";
import { RouteEngine } from "../../core/route-engine.js";
import { ConversationLoop } from "../conversation-loop.js";
import type { LLMProvider, StreamEvent } from "../llm/types.js";
import { ToolRegistry } from "../../tools/registry.js";

class FakeProvider implements LLMProvider {
  readonly vendor = "openai" as const;
  private index = 0;
  constructor(private readonly turns: StreamEvent[][]) {}
  async *streamTurn(): AsyncIterable<StreamEvent> {
    yield* this.turns[this.index++] ?? [];
  }
}

interface OriginSourceLog {
  calls: Array<string | null>;
}

function makeLoop(turns: StreamEvent[][], originLog?: OriginSourceLog) {
  const toolRegistry = new ToolRegistry();
  const keywordEngine = new KeywordEngine();
  const routeEngine = new RouteEngine({ toolRegistry });
  const loop = new ConversationLoop(({
    settingsService: {
      get: () => ({ provider: "openai", model: "gpt-4o" }),
      getSecret: () => "test-key",
    },
    systemPromptBuilder: {
      build: () => "system",
      setOriginSource: (source: string | null) => {
        originLog?.calls.push(source);
      },
    },
    keywordEngine,
    routeEngine,
    toolRegistry,
    memoryManager: {
      saveSession: () => {},
      listSessions: () => [],
    },
  } as unknown) as ConstructorParameters<typeof ConversationLoop>[0]);
  (loop as { provider: LLMProvider | null }).provider = new FakeProvider(turns);
  return loop;
}

describe("ConversationLoop.runTriggerTurn", () => {
  it("delegates the templated prompt to runTurn and returns its result", async () => {
    const loop = makeLoop([
      [
        { type: "text_delta", text: "확인해드릴게요." },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);

    const result = await loop.runTriggerTurn({
      prompt: "회의실 예약 도와드릴까요?",
      source: "proactive:meeting-detection",
      visibility: "summary-only",
      priority: "normal",
      context: { emailId: "abc-123" },
    });

    expect(result.text).toBe("확인해드릴게요.");
    // The trigger-side prompt becomes the user turn — not the raw email body,
    // demonstrating the templated-only contract.
    const messages = loop.getHistory().getMessages();
    expect(messages[0]).toMatchObject({
      role: "user",
      content: "회의실 예약 도와드릴까요?",
    });
  });

  it("supports silent / user-visible visibilities transparently (audit-tagged, behaviour identical)", async () => {
    const loop = makeLoop([
      [
        { type: "text_delta", text: "ok" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);

    const result = await loop.runTriggerTurn({
      prompt: "silent observation",
      source: "proactive:silent-watch",
      visibility: "silent",
      priority: "low",
    });

    // P0 deliberately leaves silent/user-visible UI behaviour for P2 — the
    // turn still runs end-to-end; this test pins the no-special-case contract
    // so a future P2 change is intentional.
    expect(result.text).toBe("ok");
  });

  it("sets origin source on system-prompt-builder and clears it after the turn", async () => {
    const originLog: OriginSourceLog = { calls: [] };
    const loop = makeLoop(
      [
        [
          { type: "text_delta", text: "done" },
          { type: "message_complete", stopReason: "end_turn" },
        ],
      ],
      originLog,
    );

    await loop.runTriggerTurn({
      prompt: "x",
      source: "proactive:meeting-detection",
      visibility: "summary-only",
      priority: "normal",
    });

    expect(originLog.calls).toEqual(["proactive:meeting-detection", null]);
  });

  it("clears origin source even when the delegated runTurn rejects (no leakage to next turn)", async () => {
    const originLog: OriginSourceLog = { calls: [] };
    const loop = makeLoop([], originLog);
    // Force the underlying turn to reject by clearing the provider — runTurn
    // throws "LLM 프로바이더가 설정되지 않았습니다." before any streaming.
    (loop as { provider: unknown }).provider = null;

    await expect(
      loop.runTriggerTurn({
        prompt: "x",
        source: "proactive:meeting-detection",
        visibility: "summary-only",
        priority: "normal",
      }),
    ).rejects.toBeDefined();

    // Origin must still be cleared so the next user-initiated turn does not
    // accidentally inherit the proactive guidance section.
    expect(originLog.calls).toEqual(["proactive:meeting-detection", null]);
  });
});
