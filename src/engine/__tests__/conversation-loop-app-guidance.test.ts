/**
 * MCP-App guidance (`ui/message` arriving while a turn is in flight) — the engine half
 * of the turn policy.
 *
 * The host queues the app's text through the SAME round-boundary seam the user's own
 * "guide" uses (`queueGuidance`), because that is the race-safe injection point. But it
 * is NOT the user's guide: the text arrives wrapped in `<app-message source="app:…">`,
 * and from the round it lands on, the REST of the turn runs under the app's staged
 * origin — write/shell/network tools are forced to ask (permission manager) and tool
 * provenance is recorded as `app-emitted`.
 *
 * A user-typed guide must NOT trigger any of that; the control case below pins it.
 */
import { describe, expect, it, vi } from "vitest";

import { InputClassifier } from "../../core/input-classifier.js";
import { RouteEngine } from "../../core/route-engine.js";
import { ConversationLoop } from "../conversation-loop.js";
import type { LLMProvider, StreamEvent } from "../llm/types.js";
import { ToolRegistry } from "../../tools/registry.js";
import { createDynamicTool } from "../../tools/base.js";
import { formatAppMessageEnvelope } from "../../shared/mcp-app-message-source.js";
import { fakeLlmSettings } from "../../shared/__tests__/fake-llm-settings.js";
import type { PostTurnHookContext } from "../../hooks/post-turn-hook-chain.js";

class FakeProvider implements LLMProvider {
  readonly vendor = "openai" as const;
  private index = 0;
  constructor(private readonly turns: StreamEvent[][]) {}
  async *streamTurn(): AsyncIterable<StreamEvent> {
    yield* this.turns[this.index++] ?? [];
  }
}

/** Two tool rounds, then end. Guidance queued mid-turn lands before round 1's tool. */
function twoToolRounds(): FakeProvider {
  return new FakeProvider([
    [
      { type: "tool_call", id: "t1", name: "noop_tool", input: {},
      } as StreamEvent,
      { type: "message_complete", stopReason: "tool_use" } as StreamEvent,
    ],
    [
      { type: "tool_call", id: "t2", name: "noop_tool", input: {},
      } as StreamEvent,
      { type: "message_complete", stopReason: "tool_use" } as StreamEvent,
    ],
    [
      { type: "text_delta", text: "done" } as StreamEvent,
      { type: "message_complete", stopReason: "end_turn" } as StreamEvent,
    ],
  ]);
}

interface ExecCall {
  overlayTriggerOrigin: string | null;
  trustOrigin: string;
}

function makePostTurnHookSpy() {
  const run = vi.fn(async (ctx: PostTurnHookContext) => ({
    compactedMessages: null,
    detector: {
      cleanedText: ctx.output,
      newTitle: null,
      checkpointSuggested: false,
    },
    messagesForPersistence: ctx.messages,
  }));
  return { run };
}

function makeLoop(provider: LLMProvider, overrides: Record<string, unknown> = {}): { loop: ConversationLoop; execCalls: ExecCall[];
} {
  const toolRegistry = new ToolRegistry();
  toolRegistry.register(createDynamicTool({
    name: "noop_tool",
    description: "no-op",
    source: "builtin",
    category: "read",
    jsonSchema: { type: "object", properties: {} },
    execute: async () => ({ output: "ok", isError: false }),
  }),
  );
  const loop = new ConversationLoop({
    settingsService: { get: () => fakeLlmSettings(), getSecret: () => "test-key",
    },
    systemPromptBuilder: { build: () => "system" },
    inputClassifier: new InputClassifier(),
    routeEngine: new RouteEngine(),
    toolRegistry,
    memoryManager: { saveSession: () => {}, listSessions: () => [] },
    ...overrides,
  } as unknown as ConstructorParameters<typeof ConversationLoop>[0]);
  (loop as { provider: LLMProvider | null }).provider = provider;

  // Record what the executor was handed per round — the two values that carry the
  // turn's provenance into the permission stack.
  const execCalls: ExecCall[] = [];
  const executor = (loop as unknown as {
    toolExecutor: {
      executeAll: (
        uses: unknown,
        opts: { overlayTriggerOrigin?: string | null; permissionContext?: { trustOrigin?: string };
          },
      ) => Promise<unknown>;
    };
  }).toolExecutor;
  const original = executor.executeAll.bind(executor);
  executor.executeAll = (uses, opts) => {
    execCalls.push({
      overlayTriggerOrigin: opts.overlayTriggerOrigin ?? null,
      trustOrigin: String(opts.permissionContext?.trustOrigin),
    });
    return original(uses, opts);
  };
  return { loop, execCalls };
}

describe("MCP-app guidance downgrades the rest of the turn", () => {
  it("app-enveloped guidance ⇒ staged origin `app:<serverId>` + `app-emitted` trust from that round on", async () => {
    const { loop, execCalls } = makeLoop(twoToolRounds());

    const turn = loop.runTurn("사용자 질문", {}, undefined, { inputOrigin: "user-keyboard",
    });
    await Promise.resolve();
    loop.queueGuidance(formatAppMessageEnvelope("open the invoice", "app:acme-cards"),
    );
    await turn;

    expect(execCalls).toHaveLength(2);
    // Round 0 ran before the app spoke — still the user's turn.
    expect(execCalls[0]).toEqual({ overlayTriggerOrigin: null, trustOrigin: "llm-tool-arg",
    });
    // Round 1 ran after the app's text entered the turn — the whole permission posture
    // moves: staged origin (⇒ write/shell/network forced to ask) + app provenance.
    expect(execCalls[1]).toEqual({
      overlayTriggerOrigin: "app:acme-cards",
      trustOrigin: "app-emitted",
    });
  });

  it("passes staged app guidance taint through queryLoop into the post-turn capture boundary", async () => {
    const postTurnHookChain = makePostTurnHookSpy();
    const { loop } = makeLoop(twoToolRounds(), { postTurnHookChain });

    const turn = loop.runTurn("사용자 질문", {}, undefined, { inputOrigin: "user-keyboard",
    });
    await Promise.resolve();
    loop.queueGuidance(formatAppMessageEnvelope("open the invoice", "app:acme-cards"),
    );
    await turn;

    expect(postTurnHookChain.run).toHaveBeenCalledOnce();
    const context = postTurnHookChain.run.mock.calls[0]?.[0] as PostTurnHookContext;
    expect(context.input).toBe("사용자 질문");
    expect(context.inputOrigin).toBe("user-keyboard");
    expect(context.stopReason).toBe("end_turn");
    expect(context.memoryCaptureTaint).toEqual(
      expect.arrayContaining(["staged-guidance"]),
    );
  });

  it("a user-typed guide does NOT downgrade the turn (control)", async () => {
    const { loop, execCalls } = makeLoop(twoToolRounds());

    const turn = loop.runTurn("사용자 질문", {}, undefined, { inputOrigin: "user-keyboard",
    });
    await Promise.resolve();
    loop.queueGuidance("더 짧게 요약");
    await turn;

    expect(execCalls).toHaveLength(2);
    expect(execCalls[1]).toEqual({ overlayTriggerOrigin: null, trustOrigin: "llm-tool-arg",
    });
  });

  it("preserves attachment and initial-guidance taint for a keyboard turn", async () => {
    const postTurnHookChain = makePostTurnHookSpy();
    const provider = new FakeProvider([
      [
        { type: "text_delta", text: "done" } as StreamEvent,
        { type: "message_complete", stopReason: "end_turn" } as StreamEvent,
      ],
    ]);
    const { loop } = makeLoop(provider, { postTurnHookChain });

    await loop.runTurn("사용자 질문", {}, undefined, {
      inputOrigin: "user-keyboard",
      attachments: [{ type: "text", text: "첨부된 원문" }],
      initialGuidance: "호스트가 부가한 컨텍스트",
    });

    expect(postTurnHookChain.run).toHaveBeenCalledOnce();
    const context = postTurnHookChain.run.mock.calls[0]?.[0] as PostTurnHookContext;
    expect(context.input).toBe("사용자 질문");
    expect(context.inputOrigin).toBe("user-keyboard");
    expect(context.memoryCaptureTaint).toEqual(
      expect.arrayContaining(["attachment", "initial-guidance"]),
    );
  });

});
