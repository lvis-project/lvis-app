import { describe, expect, it, vi } from "vitest";
import { InputClassifier } from "../../core/input-classifier.js";
import { RouteEngine } from "../../core/route-engine.js";
import { A2ATaskState } from "../../shared/a2a.js";
import { fakeLlmSettings } from "../../shared/__tests__/fake-llm-settings.js";
import { createDynamicTool } from "../../tools/base.js";
import { ToolRegistry } from "../../tools/registry.js";
import {
  A2A_INPUT_REQUIRED_CONTROL_KIND,
  A2A_INPUT_REQUIRED_CONTROL_VERSION,
} from "../../tools/agent-send.js";
import { A2AAgentMessageBus } from "../a2a-agent-message-bus.js";
import { A2AAgentMessageMailbox } from "../a2a-agent-message-mailbox.js";
import { ConversationLoop } from "../conversation-loop.js";
import type {
  LLMProvider,
  StreamEvent,
  StreamTurnParams,
} from "../llm/types.js";

class ScriptedProvider implements LLMProvider {
  readonly vendor = "openai" as const;
  turnsServed = 0;

  constructor(private readonly turns: StreamEvent[][]) {}

  async *streamTurn(_params: StreamTurnParams): AsyncIterable<StreamEvent> {
    const turn = this.turns[this.turnsServed] ?? [];
    this.turnsServed += 1;
    yield* turn;
  }
}

function createLoop(
  provider: LLMProvider,
  toolRegistry: ToolRegistry,
  withApprovalGate = false,
  approvalChoice: "allow-once" | "deny-once" = "allow-once",
): ConversationLoop {
  const inputClassifier = new InputClassifier();
  const routeEngine = new RouteEngine();
  const requestAndWait = vi.fn(async (request: { id: string }) => ({
    requestId: request.id,
    choice: approvalChoice,
  }));
  const approvalGate = withApprovalGate ? { requestAndWait } : undefined;
  const loop = new ConversationLoop({
    settingsService: {
      get: () => fakeLlmSettings(),
      getSecret: () => "test-key",
    },
    systemPromptBuilder: {
      build: () => "system",
      setToolScope: () => undefined,
      setOriginSource: () => undefined,
      setActiveSessionId: () => undefined,
      setSummaryPreamble: () => undefined,
    },
    inputClassifier,
    routeEngine,
    toolRegistry,
    approvalGate,
    memoryManager: {
      saveSession: () => Promise.resolve(),
      listSessions: () => [],
    },
  } as never);
  (loop as { provider: LLMProvider | null }).provider = provider;
  (loop as unknown as { testApprovalRequestAndWait: typeof requestAndWait })
    .testApprovalRequestAndWait = requestAndWait;
  return loop;
}

function createInMemoryAgentMailbox() {
  let stored: unknown;
  const mailbox = new A2AAgentMessageMailbox({
    dir: "memory",
    readJson: async (_name: string, fallback: unknown) =>
      structuredClone(stored === undefined ? fallback : stored),
    writeJson: async (_name: string, value: unknown) => {
      stored = structuredClone(value);
    },
    childDir: async (name: string) => name,
  } as never);
  return mailbox;
}

const questionControl = {
  kind: A2A_INPUT_REQUIRED_CONTROL_KIND,
  version: A2A_INPUT_REQUIRED_CONTROL_VERSION,
  reason: "question" as const,
  prompt: "Which option?",
};

describe("A2A question control and causal propagation", () => {
  it("accepts one exact builtin agent_send control, commits initial guidance, and stops before another provider round", async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(createDynamicTool({
      name: "agent_send",
      description: "question sender",
      source: "builtin",
      category: "meta",
      modelVisible: true,
      decisionOverride: "always-allow-with-audit",
      jsonSchema: { type: "object", properties: {} },
      execute: async () => ({
        output: "sent",
        isError: false,
        metadata: { rawResult: questionControl },
      }),
    }),
    );
    const provider = new ScriptedProvider([
      [
        { type: "tool_call", id: "send-question", name: "agent_send", input: {},
        },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "must not run" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = createLoop(provider, toolRegistry, true);

    const result = await loop.runTurn("continue", undefined, undefined, {
      sessionIdOverride: "sub-recipient",
      spawnDepth: 1,
      inputOrigin: "llm-tool-arg",
      initialGuidance: "idle sibling guidance",
      approvalReasonPrefix: "[Sub-Agent: sender-worker]",
      a2aCausalContext: {
        kind: "a2a-causal-hop",
        version: 1,
        originSessionId: "parent-session",
        recipientChildSessionId: "sub-recipient",
        hopCount: 3,
      },
    });

    expect(result.stopReason).toBe("input-required");
    expect(result.inputRequired).toEqual({
      reason: "question",
      prompt: "Which option?",
    });
    expect(provider.turnsServed).toBe(1);
    expect(JSON.stringify(loop.history.getMessages()))
      .toContain("idle sibling guidance",
    );
    const gate = (loop as unknown as {
      testApprovalRequestAndWait: ReturnType<typeof vi.fn>;
    }).testApprovalRequestAndWait;
    expect(gate).toHaveBeenCalledWith(expect.objectContaining({
      reason: expect.stringContaining("[Sub-Agent: sender-worker]"),
      trustOrigin: "agent-message",
    }),
    );
  });

  it.each([
    { label: "other tool", name: "spoof_control", source: "builtin" as const },
    { label: "other source", name: "agent_send", source: "plugin" as const },
  ])("ignores a question-control spoof from $label", async ({ name, source }) => {
    const execute = vi.fn(async () => ({
      output: "spoof",
      isError: false,
      metadata: { rawResult: questionControl },
    }));
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(createDynamicTool({
      name,
      description: "spoof sender",
      source,
      ...(source === "plugin" ? { pluginId: "spoof-plugin" } : {}),
      category: "read",
      modelVisible: true,
      isReadOnly: () => true,
      jsonSchema: { type: "object", properties: {} },
      execute,
    }),
      );
    const provider = new ScriptedProvider([
      [
        { type: "tool_call", id: "spoof-question", name, input: {} },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "normal completion" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = createLoop(provider, toolRegistry);

    const result = await loop.runTurn("continue", undefined, undefined, {
      inputOrigin: "user-keyboard",
    });

    if (source === "builtin") {
      expect(execute).toHaveBeenCalledOnce();
    } else {
      expect(execute).not.toHaveBeenCalled();
    }
    expect(result.stopReason).toBe("end_turn");
    expect(result.inputRequired).toBeUndefined();
    expect(provider.turnsServed).toBe(2);
  },
  );

  it("exposes host causal context only to builtin agent_send", async () => {
    const observed = new Map<string, unknown>();
    const observedTrust = new Map<string, unknown>();
    const toolRegistry = new ToolRegistry();
    for (const name of ["agent_send", "ordinary_tool"]) {
      toolRegistry.register(createDynamicTool({
        name,
        description: name,
        source: "builtin",
        category: "read",
        modelVisible: true,
        isReadOnly: () => true,
        jsonSchema: { type: "object", properties: {} },
        execute: async (_input, context) => {
          observed.set(name, context.metadata?.a2aCausalContext);
          observedTrust.set(name, context.metadata?.trustOrigin);
          return { output: "ok", isError: false };
        },
      }),
      );
    }
    const provider = new ScriptedProvider([
      [
        { type: "tool_call", id: "causal-send", name: "agent_send", input: {} },
        { type: "tool_call", id: "causal-other", name: "ordinary_tool", input: {},
        },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "done" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = createLoop(provider, toolRegistry, true);
    const causalContext = {
      kind: "a2a-causal-hop" as const,
      version: 1 as const,
      originSessionId: "parent-session",
      recipientChildSessionId: "sub-recipient",
      hopCount: 4,
    };

    const result = await loop.runTurn("continue", undefined, undefined, {
      sessionIdOverride: "sub-recipient",
      spawnDepth: 1,
      inputOrigin: "llm-tool-arg",
      approvalReasonPrefix: "[Sub-Agent: sender-worker]",
      a2aCausalContext: causalContext,
    });

    expect(result.stopReason).toBe("end_turn");
    expect(observed.get("agent_send")).toEqual(causalContext);
    expect(observed.get("ordinary_tool")).toBeUndefined();
    expect(observedTrust.get("agent_send")).toBe("agent-message");
    expect(observedTrust.get("ordinary_tool")).toBe("agent-message");
  });
  it("monotonically degrades active round-boundary guidance to agent-message trust", async () => {
    const observed = vi.fn();
    const toolRegistry = new ToolRegistry();
    for (const name of ["first_tool", "ordinary_tool"]) {
      toolRegistry.register(createDynamicTool({
        name,
        description: name,
        source: "builtin",
        category: "read",
        modelVisible: true,
        isReadOnly: () => true,
        jsonSchema: { type: "object", properties: {} },
        execute: async (_input, context) => {
          if (name === "ordinary_tool") {
            observed(context.metadata?.trustOrigin);
          }
          return { output: "ok", isError: false };
        },
      }),
      );
    }
    let loop!: ConversationLoop;
    let turn = 0;
    const provider: LLMProvider = {
      vendor: "openai",
      async *streamTurn(): AsyncIterable<StreamEvent> {
        turn += 1;
        if (turn === 1) {
          expect(loop.queueGuidanceWithDisposition("active sibling guidance", {
            approvalReasonPrefix: "[Sub-Agent: sender-worker]",
            a2aCausalContext: {
              kind: "a2a-causal-hop",
              version: 1,
              originSessionId: "parent-session",
              recipientChildSessionId: "sub-recipient",
              hopCount: 2,
            },
          }),
          ).toBe("queued");
          yield { type: "tool_call", id: "first", name: "first_tool", input: {},
          };
          yield { type: "message_complete", stopReason: "tool_use" };
          return;
        }
        if (turn === 2) {
          yield { type: "tool_call", id: "ordinary", name: "ordinary_tool", input: {},
          };
          yield { type: "message_complete", stopReason: "tool_use" };
          return;
        }
        yield { type: "text_delta", text: "done" };
        yield { type: "message_complete", stopReason: "end_turn" };
      },
    };
    loop = createLoop(provider, toolRegistry, true);

    const result = await loop.runTurn("start", undefined, undefined, {
      sessionIdOverride: "sub-recipient",
      spawnDepth: 1,
      inputOrigin: "user-keyboard",
    });

    expect(result.stopReason).toBe("end_turn");
    expect(observed).toHaveBeenCalledWith("agent-message");
    const gate = (loop as unknown as {
      testApprovalRequestAndWait: ReturnType<typeof vi.fn>;
    }).testApprovalRequestAndWait;
    expect(gate).toHaveBeenCalledWith(expect.objectContaining({
      toolName: "ordinary_tool",
      reason: expect.stringContaining("[Sub-Agent: sender-worker]"),
      trustOrigin: "agent-message",
    }),
    );
  });

  it("awaits real active-sibling mailbox ACK on round commit and retains it on round-cap", async () => {
    const startScenario = (args: {
      messageId: string;
      maxRounds: number;
      holdAcknowledge: boolean;
    }) => {
      const senderChildSessionId = "sub-sender";
      const recipientChildSessionId = "sub-recipient";
      const originSessionId = "parent-session";
      const mailbox = createInMemoryAgentMailbox();
      const toolRegistry = new ToolRegistry();
      toolRegistry.register(createDynamicTool({
        name: "first_tool",
        description: "first tool",
        source: "builtin",
        category: "read",
        modelVisible: true,
        isReadOnly: () => true,
        jsonSchema: { type: "object", properties: {} },
        execute: async () => ({ output: "ok", isError: false }),
      }),
      );

      let releaseAcknowledge = () => undefined;
      const acknowledgeGate = args.holdAcknowledge
        ? new Promise<void>((resolve) => {
            releaseAcknowledge = resolve;
          })
        : Promise.resolve();
      let markAcknowledgeStarted!: () => void;
      const acknowledgeStarted = new Promise<void>((resolve) => {
        markAcknowledgeStarted = resolve;
      });
      const originalAcknowledge = mailbox.acknowledge.bind(mailbox);
      const acknowledge = vi.spyOn(mailbox, "acknowledge").mockImplementation(
        async (childSessionId, ids) => {
          markAcknowledgeStarted();
          await acknowledgeGate;
          return originalAcknowledge(childSessionId, ids);
        });

      let loop!: ConversationLoop;
      let bus!: A2AAgentMessageBus;
      let resolveQueuedEntry!: (entry: unknown) => void;
      const queuedEntry = new Promise<unknown>((resolve) => {
        resolveQueuedEntry = resolve;
      });
      let providerTurn = 0;
      const provider: LLMProvider = {
        vendor: "openai",
        async *streamTurn(params: StreamTurnParams,
        ): AsyncIterable<StreamEvent> {
          providerTurn += 1;
          if (providerTurn === 1) {
            await expect(bus.send({
              senderChildSessionId,
              recipient: recipientChildSessionId,
              messageId: args.messageId,
              parts: [{ text: "durable active sibling guidance" }],
            }),
            ).resolves.toMatchObject({
              ok: true,
              disposition: "queued",
            });
            const stored = await mailbox.peekWithDiagnostics(recipientChildSessionId,
            );
            expect(stored.entries).toHaveLength(1);
            resolveQueuedEntry(structuredClone(stored.entries[0]));
            yield { type: "tool_call", id: "first", name: "first_tool", input: {},
            };
            yield { type: "message_complete", stopReason: "tool_use" };
            return;
          }
          expect(JSON.stringify(params.messages))
            .toContain("durable active sibling guidance",
          );
          yield { type: "text_delta", text: "done" };
          yield { type: "message_complete", stopReason: "end_turn" };
        },
      };
      loop = createLoop(provider, toolRegistry, true);
      bus = new A2AAgentMessageBus({
        parentBus: { deliverToParent: vi.fn() } as never,
        mailbox,
        auditLogger: { log: vi.fn() } as never,
        resolveSender: async () => ({
          childSessionId: senderChildSessionId,
          originSessionId,
          title: "sender-worker",
          background: true,
          taskState: A2ATaskState.WORKING,
        }),
        resolvePeer: async () => ({
          ok: true,
          originSessionId,
          sender: {
            childSessionId: senderChildSessionId,
            title: "sender-worker",
          },
          recipient: {
            childSessionId: recipientChildSessionId,
            title: "recipient-worker",
            taskState: A2ATaskState.WORKING,
            activeLoop: loop,
          },
        }),
      });

      const runPromise = loop.runTurn("start", undefined, undefined, {
        sessionIdOverride: recipientChildSessionId,
        spawnDepth: 1,
        inputOrigin: "user-keyboard",
        maxRounds: args.maxRounds,
      });
      return {
        acknowledge,
        acknowledgeStarted,
        mailbox,
        queuedEntry,
        recipientChildSessionId,
        releaseAcknowledge,
        runPromise,
      };
    };

    const committed = startScenario({
      messageId: "message-commit-ack",
      maxRounds: 3,
      holdAcknowledge: true,
    });
    const committedEntry = await committed.queuedEntry;
    await committed.acknowledgeStarted;
    let runSettled = false;
    void committed.runPromise.then(
      () => { runSettled = true; },
      () => { runSettled = true; },
    );
    await Promise.resolve();
    expect(runSettled).toBe(false);
    expect((await committed.mailbox.peekWithDiagnostics(
      committed.recipientChildSessionId,
    )).entries,
    ).toEqual([committedEntry]);

    committed.releaseAcknowledge();
    await expect(committed.runPromise).resolves.toMatchObject({
      stopReason: "end_turn",
    });
    expect((await committed.mailbox.peekWithDiagnostics(
      committed.recipientChildSessionId,
    )).entries,
    ).toEqual([]);

    const capped = startScenario({
      messageId: "message-round-cap-retained",
      maxRounds: 1,
      holdAcknowledge: false,
    });
    const cappedEntry = await capped.queuedEntry;
    await expect(capped.runPromise).resolves.toMatchObject({
      stopReason: "round-cap",
    });
    expect(capped.acknowledge).not.toHaveBeenCalled();
    expect((await capped.mailbox.peekWithDiagnostics(
      capped.recipientChildSessionId)).entries,
    ).toEqual([cappedEntry]);
  });

  it.each(["request_plugin", "tool_search"])(
    "gates intercepted %s under A2A provenance and denies it before handling",
    async (name) => {
      const toolRegistry = new ToolRegistry();
      toolRegistry.register(createDynamicTool({
        name,
        description: name,
        source: "builtin",
        category: "meta",
        modelVisible: true,
        decisionOverride: "always-allow-with-audit",
        jsonSchema: { type: "object", properties: {} },
        execute: async () => ({ output: "must not execute", isError: false }),
      }),
      );
      const provider = new ScriptedProvider([
        [
          { type: "tool_call", id: "intercepted", name, input: {} },
          { type: "message_complete", stopReason: "tool_use" },
        ],
        [
          { type: "text_delta", text: "done" },
          { type: "message_complete", stopReason: "end_turn" },
        ],
      ]);
      const loop = createLoop(provider, toolRegistry, true, "deny-once");

      const result = await loop.runTurn("continue", undefined, undefined, {
        sessionIdOverride: "sub-recipient",
        spawnDepth: 1,
        inputOrigin: "agent-message",
        approvalReasonPrefix: "[Sub-Agent: sender-worker]",
        a2aCausalContext: {
          kind: "a2a-causal-hop",
          version: 1,
          originSessionId: "parent-session",
          recipientChildSessionId: "sub-recipient",
          hopCount: 2,
        },
      });

      const gate = (loop as unknown as {
        testApprovalRequestAndWait: ReturnType<typeof vi.fn>;
      }).testApprovalRequestAndWait;
      expect(gate).toHaveBeenCalledWith(expect.objectContaining({
        toolName: name,
        reason: expect.stringContaining("[Sub-Agent: sender-worker]"),
        trustOrigin: "agent-message",
      }),
      );
      expect(result.toolCalls).toContainEqual(expect.objectContaining({
        name,
        result: expect.stringContaining("cross-agent-approval-denied"),
      }),
      );
      expect(provider.turnsServed).toBe(2);
    },
  );
});
