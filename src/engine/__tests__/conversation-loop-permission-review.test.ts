/**
 * The permission review verdict the user saw live must survive a session
 * reload. The renderer rebuilds a reloaded transcript from persisted messages
 * only, so the turn stamps each review onto the tool_result it belongs to —
 * without that stamp, the verdict exists in the live stream and nowhere else.
 */
import { describe, expect, it } from "vitest";

import { InputClassifier } from "../../core/input-classifier.js";
import { RouteEngine } from "../../core/route-engine.js";
import { ConversationLoop } from "../conversation-loop.js";
import type { GenericMessage, LLMProvider, StreamEvent } from "../llm/types.js";
import { ToolRegistry } from "../../tools/registry.js";
import { createDynamicTool } from "../../tools/base.js";
import { fakeLlmSettings } from "../../shared/__tests__/fake-llm-settings.js";
import type { PermissionReviewEvent } from "../../shared/permission-review-status.js";

class FakeProvider implements LLMProvider {
  readonly vendor = "openai" as const;
  private index = 0;
  constructor(private readonly turns: StreamEvent[][]) {}
  async *streamTurn(): AsyncIterable<StreamEvent> {
    yield* this.turns[this.index++] ?? [];
  }
}

function oneToolRound(): FakeProvider {
  return new FakeProvider([
    [
      { type: "tool_call", id: "t1", name: "noop_tool", input: {} } as StreamEvent,
      { type: "message_complete", stopReason: "tool_use" } as StreamEvent,
    ],
    [
      { type: "text_delta", text: "done" } as StreamEvent,
      { type: "message_complete", stopReason: "end_turn" } as StreamEvent,
    ],
  ]);
}

/** Builds a loop whose executor emits `review` for the round's single tool. */
function makeLoop(review: PermissionReviewEvent): ConversationLoop {
  const toolRegistry = new ToolRegistry();
  toolRegistry.register(
    createDynamicTool({
      name: "noop_tool",
      description: "no-op",
      source: "builtin",
      category: "read",
      jsonSchema: { type: "object", properties: {} },
      execute: async () => ({ output: "ok", isError: false }),
    }),
  );
  const loop = new ConversationLoop({
    settingsService: { get: () => fakeLlmSettings(), getSecret: () => "test-key" },
    systemPromptBuilder: { build: () => "system" },
    inputClassifier: new InputClassifier(),
    routeEngine: new RouteEngine(),
    toolRegistry,
    memoryManager: { saveSession: () => {}, listSessions: () => [] },
    disableSessionPersistence: true,
  } as unknown as ConstructorParameters<typeof ConversationLoop>[0]);
  (loop as { provider: LLMProvider | null }).provider = oneToolRound();

  const executor = (
    loop as unknown as {
      toolExecutor: {
        executeAll: (
          uses: unknown,
          opts: { callbacks?: { onPermissionReview?: (event: PermissionReviewEvent) => void } },
        ) => Promise<unknown>;
      };
    }
  ).toolExecutor;
  const original = executor.executeAll.bind(executor);
  executor.executeAll = (uses, opts) => {
    opts.callbacks?.onPermissionReview?.(review);
    return original(uses, opts);
  };
  return loop;
}

function toolResults(loop: ConversationLoop): GenericMessage[] {
  return (loop as unknown as { history: { getMessages: () => GenericMessage[] } })
    .history.getMessages()
    .filter((message) => message.role === "tool_result");
}

describe("permission review verdict persistence", () => {
  it("stamps the review onto the tool_result it belongs to", async () => {
    const loop = makeLoop({
      status: "auto_approved",
      toolName: "noop_tool",
      groupId: "g1",
      toolUseId: "t1",
      displayOrder: 0,
      verdictLevel: "low",
      reason: "read-only",
    });

    await loop.runTurn("도구 써줘", {}, undefined, { inputOrigin: "user-keyboard" });

    const results = toolResults(loop);
    expect(results).toHaveLength(1);
    expect(results[0]?.meta?.permissionReview).toEqual({
      status: "auto_approved",
      verdictLevel: "low",
      reason: "read-only",
    });
  });

  it("leaves tool results untouched when no review ran", async () => {
    const loop = makeLoop({
      status: "auto_approved",
      toolName: "noop_tool",
      groupId: "g1",
      toolUseId: "other-tool",
      displayOrder: 0,
    });

    await loop.runTurn("도구 써줘", {}, undefined, { inputOrigin: "user-keyboard" });

    const results = toolResults(loop);
    expect(results).toHaveLength(1);
    expect(results[0]?.meta).not.toHaveProperty("permissionReview");
  });
});
