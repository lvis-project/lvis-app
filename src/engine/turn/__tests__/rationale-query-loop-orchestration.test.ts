import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeywordEngine } from "../../../core/keyword-engine.js";
import { RouteEngine } from "../../../core/route-engine.js";
import { createDynamicTool } from "../../../tools/base.js";
import type { ToolExecutor, ToolResult, ToolUseBlock } from "../../../tools/executor.js";
import type { RationaleExecutorControlOutcome } from "../../../tools/pipeline/rationale-pr1-contract.js";
import type { SealedRationaleResumeRequest } from "../../../tools/pipeline/rationale-resume-contract.js";
import { ToolRegistry } from "../../../tools/registry.js";
import { fakeLlmSettings } from "../../../shared/__tests__/fake-llm-settings.js";
import { ConversationLoop } from "../../conversation-loop.js";
import type { LLMProvider, StreamEvent, StreamTurnParams } from "../../llm/types.js";
import {
  RATIONALE_SIBLING_CANCELLED_RESULT,
  RATIONALE_SIBLING_REPLAY_BLOCKED_RESULT,
  type RationaleConversationCoordinator,
  type RationaleCoordinatorFactory,
  type RationaleCoordinatorFactoryInput,
} from "../rationale-conversation-orchestration.js";
import { runRationaleOnlyRound } from "../rationale-round.js";

vi.mock("../rationale-round.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../rationale-round.js")>()),
  runRationaleOnlyRound: vi.fn(),
}));

class Provider implements LLMProvider {
  readonly vendor = "openai" as const;
  readonly inputs: StreamTurnParams[] = [];
  private index = 0;
  constructor(private readonly turns: StreamEvent[][]) {}
  async *streamTurn(input: StreamTurnParams): AsyncIterable<StreamEvent> {
    this.inputs.push(input);
    yield* this.turns[this.index++] ?? [];
  }
}

function makeLoop(
  turns: StreamEvent[][],
  factory?: RationaleCoordinatorFactory,
  enabled = false,
) {
  const registry = new ToolRegistry();
  for (const [name, category, readOnly] of [
    ["read_file", "read", true],
    ["bash", "shell", false],
    ["write_file", "write", false],
  ] as const) {
    registry.register(createDynamicTool({
      name,
      description: name,
      source: "builtin",
      category,
      version: "1",
      jsonSchema: { type: "object", properties: {} },
      isReadOnly: () => readOnly,
      execute: async () => ({ output: "unused", isError: false }),
    }));
  }
  const provider = new Provider(turns);
  const loop = new ConversationLoop(({
    settingsService: { get: () => fakeLlmSettings(), getSecret: () => "key" },
    systemPromptBuilder: { build: () => "system", setToolScope: vi.fn() },
    keywordEngine: new KeywordEngine(),
    routeEngine: new RouteEngine({ toolRegistry: registry }),
    toolRegistry: registry,
    memoryManager: { saveSession: () => {}, listSessions: () => [] },
    disableSessionPersistence: true,
    ...(factory ? { rationaleCoordinatorFactory: factory } : {}),
    ...(enabled ? { enableDormantRationaleForTesting: true } : {}),
  } as unknown) as ConstructorParameters<typeof ConversationLoop>[0]);
  (loop as { provider: LLMProvider | null }).provider = provider;
  return { loop, provider };
}

const tr = (id: string, content: string): ToolResult => ({
  tool_use_id: id, content, is_error: false, durationMs: 1,
});
const toolRound = (
  calls: Array<{
    id: string;
    name: "read_file" | "bash" | "write_file" | "request_plugin";
    input?: Record<string, unknown>;
  }>,
  usage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number },
): StreamEvent[] => [
  ...calls.map(({ id, name, input }) => ({
    type: "tool_call" as const, id, name, input: input ?? {},
  })),
  { type: "message_complete", stopReason: "tool_use", ...(usage ? { usage } : {}) },
];
const endRound = (usage?: { inputTokens: number; outputTokens: number }): StreamEvent[] => [
  { type: "text_delta", text: "done" },
  { type: "message_complete", stopReason: "end_turn", ...(usage ? { usage } : {}) },
];

function runtime(
  input: RationaleCoordinatorFactoryInput,
  prompt = vi.fn(async () => ({ outcome: "allowed-once" as const })),
): RationaleConversationCoordinator {
  return {
    requestAnchor: input.requestAnchor,
    rationaleProvenance: input.rationaleProvenance,
    materializeRationaleControl: vi.fn(),
    onInvocationAudit: vi.fn(),
    handleRationaleRoundResult: vi.fn(async () => ({ status: "ready" })),
    promptForApproval: prompt,
    createSealedResume: vi.fn(async () => ({
      resumeRequest: { ticketId: "hidden-ticket" } as unknown as SealedRationaleResumeRequest,
    })),
    abort: vi.fn(),
  };
}

const control = (id: string) => ({
  control: {
    ticketId: "hidden-ticket",
    sealedAction: { toolUseId: id },
    eligibilityContext: { headless: false, forceModal: false, approvalReasonPrefix: null },
  },
  channel: "executor-control",
  outcome: "rationale-required",
  transcriptVisibility: "hidden",
  ordinaryToolResult: null,
} as unknown as RationaleExecutorControlOutcome);

beforeEach(() => vi.mocked(runRationaleOnlyRound).mockReset());
afterEach(() => vi.unstubAllEnvs());

describe("ConversationLoop rationale orchestration", () => {
  it("activates guarded production when a host coordinator factory is available", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const factory = vi.fn((input: RationaleCoordinatorFactoryInput) => runtime(input));
    const fixture = makeLoop([
      toolRound([{ id: "prod-bash", name: "bash" }]),
      endRound(),
    ], factory);
    const executeConversationBatch = vi.fn(async (toolUses: ToolUseBlock[]) => ({
      outcome: "completed" as const,
      results: toolUses.map(({ id }) => tr(id, "legacy")),
    }));
    (
      fixture.loop.toolExecutor as unknown as {
        executeConversationBatch: typeof executeConversationBatch;
      }
    ).executeConversationBatch = executeConversationBatch;

    await fixture.loop.runTurn("run it", undefined, undefined, {
      inputOrigin: "user-keyboard",
      requestAnchorRawIntent: "run it",
    });

    expect(factory).toHaveBeenCalledTimes(1);
    expect(executeConversationBatch).toHaveBeenCalledTimes(1);
    expect(executeConversationBatch.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ rationaleRuntime: expect.any(Object) }),
    );
  });

  it("retains legacy batch orchestration when boot did not publish a factory", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const fixture = makeLoop([
      toolRound([{ id: "legacy-bash", name: "bash" }]),
      endRound(),
    ]);
    const executeConversationBatch = vi.fn(async (toolUses: ToolUseBlock[]) => ({
      outcome: "completed" as const,
      results: toolUses.map(({ id }) => tr(id, "legacy")),
    }));
    (
      fixture.loop.toolExecutor as unknown as {
        executeConversationBatch: typeof executeConversationBatch;
      }
    ).executeConversationBatch = executeConversationBatch;

    await fixture.loop.runTurn("run it", undefined, undefined, {
      inputOrigin: "user-keyboard",
      requestAnchorRawIntent: "run it",
    });

    expect(executeConversationBatch).toHaveBeenCalledTimes(1);
    expect(executeConversationBatch.mock.calls[0]?.[1]).not.toHaveProperty(
      "rationaleRuntime",
    );
    expect(executeConversationBatch.mock.calls[0]?.[1]).not.toHaveProperty(
      "interceptedMetaToolHandler",
    );
  });

  it("keeps a production shell-plus-meta batch on the legacy path when the factory returns null", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const factory = vi.fn(() => null);
    const fixture = makeLoop([
      toolRound([
        { id: "shell", name: "bash" },
        { id: "late-plugin", name: "request_plugin", input: { pluginId: "missing" } },
      ]),
      endRound(),
    ], factory);
    const executeConversationBatch = vi.fn(async (toolUses: ToolUseBlock[]) => ({
      outcome: "completed" as const,
      results: toolUses.map(({ id }) => tr(id, "legacy")),
    }));
    (
      fixture.loop.toolExecutor as unknown as {
        executeConversationBatch: typeof executeConversationBatch;
      }
    ).executeConversationBatch = executeConversationBatch;

    await fixture.loop.runTurn("run it", undefined, undefined, {
      inputOrigin: "user-keyboard",
      requestAnchorRawIntent: "run it",
    });

    expect(factory).toHaveBeenCalledTimes(1);
    expect(executeConversationBatch.mock.calls[0]?.[0]).toEqual([
      { id: "shell", name: "bash", input: {} },
    ]);
    expect(executeConversationBatch.mock.calls[0]?.[1]).not.toHaveProperty(
      "rationaleRuntime",
    );
    expect(executeConversationBatch.mock.calls[0]?.[1]).not.toHaveProperty(
      "interceptedMetaToolHandler",
    );
  });

  it("keeps a production shell-plus-meta batch on the legacy path when the factory throws", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const factory = vi.fn(() => {
      throw new Error("host factory unavailable");
    });
    const fixture = makeLoop([
      toolRound([
        { id: "shell", name: "bash" },
        { id: "late-plugin", name: "request_plugin", input: { pluginId: "missing" } },
      ]),
      endRound(),
    ], factory);
    const executeConversationBatch = vi.fn(async (toolUses: ToolUseBlock[]) => ({
      outcome: "completed" as const,
      results: toolUses.map(({ id }) => tr(id, "legacy")),
    }));
    (
      fixture.loop.toolExecutor as unknown as {
        executeConversationBatch: typeof executeConversationBatch;
      }
    ).executeConversationBatch = executeConversationBatch;

    await fixture.loop.runTurn("run it", undefined, undefined, {
      inputOrigin: "user-keyboard",
      requestAnchorRawIntent: "run it",
    });

    expect(factory).toHaveBeenCalledTimes(1);
    expect(executeConversationBatch.mock.calls[0]?.[0]).toEqual([
      { id: "shell", name: "bash", input: {} },
    ]);
    expect(executeConversationBatch.mock.calls[0]?.[1]).not.toHaveProperty(
      "rationaleRuntime",
    );
    expect(executeConversationBatch.mock.calls[0]?.[1]).not.toHaveProperty(
      "interceptedMetaToolHandler",
    );
  });

  it("accounts ephemeral rationale usage, preserves order, and exposes no hidden control", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const prompt = vi.fn(async () => ({ outcome: "allowed-once" as const }));
    const factory = vi.fn((input: RationaleCoordinatorFactoryInput) =>
      runtime(input, prompt));
    const fixture = makeLoop([
      toolRound([
        { id: "prefix", name: "read_file" },
        { id: "trigger", name: "bash" },
        { id: "sibling", name: "write_file" },
      ], { inputTokens: 10, outputTokens: 2 }),
      endRound({ inputTokens: 4, outputTokens: 1 }),
    ], factory, true);
    const executeConversationBatch = vi.fn(async () => ({
      outcome: "rationale-required" as const,
      completedResults: [tr("prefix", "prefix-ok")],
      control: control("trigger"),
    }));
    const executeSealedRationaleResume = vi.fn(async () =>
      tr("trigger", "trigger-ok"));
    (
      fixture.loop.toolExecutor as unknown as {
        executeConversationBatch: typeof executeConversationBatch;
        executeSealedRationaleResume: typeof executeSealedRationaleResume;
      }
    ).executeConversationBatch = executeConversationBatch;
    (
      fixture.loop.toolExecutor as unknown as {
        executeSealedRationaleResume: typeof executeSealedRationaleResume;
      }
    ).executeSealedRationaleResume = executeSealedRationaleResume;
    vi.mocked(runRationaleOnlyRound).mockResolvedValueOnce({
      kind: "batch-decision",
      decision: {} as never,
      usage: {
        inputTokens: 17,
        outputTokens: 3,
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
      },
    });

    const result = await fixture.loop.runTurn("run the batch", undefined, undefined, {
      inputOrigin: "user-keyboard",
      requestAnchorRawIntent: "run the batch",
    });

    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory.mock.calls[0]?.[0].rationaleProvenance).toEqual({
      startedFromUserKeyboard: true,
      taint: "none",
    });
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(executeSealedRationaleResume).toHaveBeenCalledTimes(1);
    expect(result.toolCalls.map((call) => call.result)).toEqual([
      "prefix-ok",
      "trigger-ok",
      RATIONALE_SIBLING_CANCELLED_RESULT,
    ]);
    expect(result.usage).toMatchObject({
      inputTokens: 31,
      outputTokens: 6,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
    });
    expect(JSON.stringify(result)).not.toContain("hidden-ticket");
    expect(JSON.stringify(result)).not.toContain("rationale-required");
  });

  it("rebuilds the coordinator per batch from the current monotonic taint", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const factory = vi.fn((input: RationaleCoordinatorFactoryInput) => runtime(input));
    const fixture = makeLoop([
      toolRound([{ id: "read", name: "read_file" }]),
      toolRound([{ id: "shell", name: "bash" }]),
      endRound(),
    ], factory, true);
    const executeConversationBatch = vi.fn(async (toolUses: ToolUseBlock[]) => ({
      outcome: "completed" as const,
      results: toolUses.map(({ id, name }) =>
        tr(id, name === "read_file" ? "untrusted file content" : "shell-ok")),
    }));
    (
      fixture.loop.toolExecutor as unknown as {
        executeConversationBatch: typeof executeConversationBatch;
      }
    ).executeConversationBatch = executeConversationBatch;

    await fixture.loop.runTurn("inspect then act", undefined, undefined, {
      inputOrigin: "user-keyboard",
      requestAnchorRawIntent: "inspect then act",
    });

    expect(factory).toHaveBeenCalledTimes(2);
    expect(factory.mock.calls.map(([input]) => input.rationaleProvenance)).toEqual([
      { startedFromUserKeyboard: true, taint: "none" },
      { startedFromUserKeyboard: true, taint: "file-content" },
    ]);
    expect(runRationaleOnlyRound).not.toHaveBeenCalled();
  });
  it("defers a later intercepted meta-tool until the preceding rationale action resolves", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const factory = vi.fn((input: RationaleCoordinatorFactoryInput) => runtime(input));
    const fixture = makeLoop([
      toolRound([
        { id: "trigger", name: "bash" },
        { id: "later-meta", name: "request_plugin" },
      ]),
      endRound(),
    ], factory, true);
    const executeConversationBatch = vi.fn(
      async (toolUses: ToolUseBlock[], _options?: unknown) => ({
        outcome: "rationale-required" as const,
        completedResults: [],
        control: control(toolUses[0]!.id),
      }),
    );
    const executeSealedRationaleResume = vi.fn(async () =>
      tr("trigger", "trigger-ok"));
    (
      fixture.loop.toolExecutor as unknown as {
        executeConversationBatch: typeof executeConversationBatch;
        executeSealedRationaleResume: typeof executeSealedRationaleResume;
      }
    ).executeConversationBatch = executeConversationBatch;
    (
      fixture.loop.toolExecutor as unknown as {
        executeSealedRationaleResume: typeof executeSealedRationaleResume;
      }
    ).executeSealedRationaleResume = executeSealedRationaleResume;
    vi.mocked(runRationaleOnlyRound).mockResolvedValueOnce({
      kind: "batch-decision",
      decision: {} as never,
    });

    const result = await fixture.loop.runTurn(
      "run then expand",
      undefined,
      undefined,
      {
        inputOrigin: "user-keyboard",
        requestAnchorRawIntent: "run then expand",
      },
    );

    expect(executeConversationBatch).toHaveBeenCalledWith(
      [
        { id: "trigger", name: "bash", input: {} },
        { id: "later-meta", name: "request_plugin", input: {} },
      ],
      expect.objectContaining({
        interceptedMetaToolHandler: expect.any(Function),
        rationaleRuntime: expect.any(Object),
      }),
    );
    expect(result.toolCalls.map((call) => call.result)).toEqual([
      "trigger-ok",
      RATIONALE_SIBLING_CANCELLED_RESULT,
    ]);
  });

  it("blocks every cancelled sibling when ids and sibling order change", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const factory = vi.fn((input: RationaleCoordinatorFactoryInput) => runtime(input));
    const siblingA = { path: "a.txt", content: "alpha" };
    const siblingB = { path: "b.txt", content: "beta" };
    const fixture = makeLoop([
      toolRound([
        { id: "trigger", name: "bash", input: { command: "prepare" } },
        { id: "sibling-a", name: "write_file", input: siblingA },
        { id: "sibling-b", name: "write_file", input: siblingB },
      ]),
      toolRound([
        { id: "replay-b-new-id", name: "write_file", input: siblingB },
        { id: "replay-a-new-id", name: "write_file", input: siblingA },
      ]),
      endRound(),
    ], factory, true);
    let batchCalls = 0;
    const executeConversationBatch = vi.fn(async (toolUses: ToolUseBlock[]) => {
      batchCalls += 1;
      if (batchCalls === 1) {
        return {
          outcome: "rationale-required" as const,
          completedResults: [],
          control: control(toolUses[0]!.id),
        };
      }
      return {
        outcome: "completed" as const,
        results: toolUses.map(({ id }) => tr(id, "unexpected execution")),
      };
    });
    const executeSealedRationaleResume = vi.fn(async () =>
      tr("trigger", "trigger-ok"));
    (
      fixture.loop.toolExecutor as unknown as {
        executeConversationBatch: typeof executeConversationBatch;
        executeSealedRationaleResume: typeof executeSealedRationaleResume;
      }
    ).executeConversationBatch = executeConversationBatch;
    (
      fixture.loop.toolExecutor as unknown as {
        executeSealedRationaleResume: typeof executeSealedRationaleResume;
      }
    ).executeSealedRationaleResume = executeSealedRationaleResume;
    vi.mocked(runRationaleOnlyRound).mockResolvedValueOnce({
      kind: "batch-decision",
      decision: {} as never,
    });

    const result = await fixture.loop.runTurn(
      "prepare both files",
      undefined,
      undefined,
      {
        inputOrigin: "user-keyboard",
        requestAnchorRawIntent: "prepare both files",
      },
    );

    expect(executeConversationBatch).toHaveBeenCalledTimes(1);
    expect(result.toolCalls.map((call) => call.result)).toEqual([
      "trigger-ok",
      RATIONALE_SIBLING_CANCELLED_RESULT,
      RATIONALE_SIBLING_CANCELLED_RESULT,
      RATIONALE_SIBLING_REPLAY_BLOCKED_RESULT,
      RATIONALE_SIBLING_REPLAY_BLOCKED_RESULT,
    ]);
  });

  it("allows a cancelled sibling when its actual input changes", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const factory = vi.fn((input: RationaleCoordinatorFactoryInput) => runtime(input));
    const changedInput = { path: "changed.txt", content: "new content" };
    const fixture = makeLoop([
      toolRound([
        { id: "trigger", name: "bash", input: { command: "prepare" } },
        {
          id: "cancelled-write",
          name: "write_file",
          input: { path: "original.txt", content: "old content" },
        },
      ]),
      toolRound([
        { id: "changed-write", name: "write_file", input: changedInput },
      ]),
      endRound(),
    ], factory, true);
    let batchCalls = 0;
    const executeConversationBatch = vi.fn(async (toolUses: ToolUseBlock[]) => {
      batchCalls += 1;
      if (batchCalls === 1) {
        return {
          outcome: "rationale-required" as const,
          completedResults: [],
          control: control(toolUses[0]!.id),
        };
      }
      return {
        outcome: "completed" as const,
        results: toolUses.map(({ id }) => tr(id, "changed-input-ok")),
      };
    });
    const executeSealedRationaleResume = vi.fn(async () =>
      tr("trigger", "trigger-ok"));
    (
      fixture.loop.toolExecutor as unknown as {
        executeConversationBatch: typeof executeConversationBatch;
        executeSealedRationaleResume: typeof executeSealedRationaleResume;
      }
    ).executeConversationBatch = executeConversationBatch;
    (
      fixture.loop.toolExecutor as unknown as {
        executeSealedRationaleResume: typeof executeSealedRationaleResume;
      }
    ).executeSealedRationaleResume = executeSealedRationaleResume;
    vi.mocked(runRationaleOnlyRound).mockResolvedValueOnce({
      kind: "batch-decision",
      decision: {} as never,
    });

    const result = await fixture.loop.runTurn(
      "prepare a file",
      undefined,
      undefined,
      {
        inputOrigin: "user-keyboard",
        requestAnchorRawIntent: "prepare a file",
      },
    );

    expect(executeConversationBatch).toHaveBeenCalledTimes(2);
    expect(executeConversationBatch.mock.calls[1]?.[0]).toEqual([
      { id: "changed-write", name: "write_file", input: changedInput },
    ]);
    expect(result.toolCalls.map((call) => call.result)).toEqual([
      "trigger-ok",
      RATIONALE_SIBLING_CANCELLED_RESULT,
      "changed-input-ok",
    ]);
  });

  it("resets cancelled-sibling guards for a new user-keyboard turn", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const factory = vi.fn((input: RationaleCoordinatorFactoryInput) => runtime(input));
    const repeatedInput = { path: "same.txt", content: "same content" };
    const fixture = makeLoop([
      toolRound([
        { id: "trigger", name: "bash", input: { command: "prepare" } },
        { id: "cancelled-write", name: "write_file", input: repeatedInput },
      ]),
      endRound(),
      toolRound([
        { id: "fresh-turn-write", name: "write_file", input: repeatedInput },
      ]),
      endRound(),
    ], factory, true);
    let batchCalls = 0;
    const executeConversationBatch = vi.fn(async (toolUses: ToolUseBlock[]) => {
      batchCalls += 1;
      if (batchCalls === 1) {
        return {
          outcome: "rationale-required" as const,
          completedResults: [],
          control: control(toolUses[0]!.id),
        };
      }
      return {
        outcome: "completed" as const,
        results: toolUses.map(({ id }) => tr(id, "fresh-turn-ok")),
      };
    });
    const executeSealedRationaleResume = vi.fn(async () =>
      tr("trigger", "trigger-ok"));
    (
      fixture.loop.toolExecutor as unknown as {
        executeConversationBatch: typeof executeConversationBatch;
        executeSealedRationaleResume: typeof executeSealedRationaleResume;
      }
    ).executeConversationBatch = executeConversationBatch;
    (
      fixture.loop.toolExecutor as unknown as {
        executeSealedRationaleResume: typeof executeSealedRationaleResume;
      }
    ).executeSealedRationaleResume = executeSealedRationaleResume;
    vi.mocked(runRationaleOnlyRound).mockResolvedValueOnce({
      kind: "batch-decision",
      decision: {} as never,
    });

    const firstTurn = await fixture.loop.runTurn(
      "first request",
      undefined,
      undefined,
      {
        inputOrigin: "user-keyboard",
        requestAnchorRawIntent: "first request",
      },
    );
    const secondTurn = await fixture.loop.runTurn(
      "second request",
      undefined,
      undefined,
      {
        inputOrigin: "user-keyboard",
        requestAnchorRawIntent: "second request",
      },
    );

    expect(executeConversationBatch).toHaveBeenCalledTimes(2);
    expect(firstTurn.toolCalls.map((call) => call.result)).toEqual([
      "trigger-ok",
      RATIONALE_SIBLING_CANCELLED_RESULT,
    ]);
    expect(secondTurn.toolCalls.map((call) => call.result)).toEqual([
      "fresh-turn-ok",
    ]);
  });

  it("fails later same-anchor proposals closed when sibling fingerprints are incomplete", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const factory = vi.fn((input: RationaleCoordinatorFactoryInput) => runtime(input));
    const secretMarker = "raw-secret-sentinel";
    const oversizedInput = {
      payload: secretMarker + "x".repeat((1024 * 1024) + 1),
    };
    const noncanonicalInput: Record<string, unknown> = {
      path: "noncanonical.txt",
      invalid: undefined,
    };
    const fixture = makeLoop([
      toolRound([
        { id: "trigger", name: "bash", input: { command: "prepare" } },
        { id: "oversized-sibling", name: "write_file", input: oversizedInput },
        {
          id: "noncanonical-sibling",
          name: "write_file",
          input: noncanonicalInput,
        },
      ]),
      toolRound([
        {
          id: "later-safe-looking-write",
          name: "write_file",
          input: { path: "safe-target.txt", content: "changed" },
        },
      ]),
      endRound(),
    ], factory, true);
    const executeConversationBatch = vi.fn(async (toolUses: ToolUseBlock[]) => ({
      outcome: "rationale-required" as const,
      completedResults: [],
      control: control(toolUses[0]!.id),
    }));
    const executeSealedRationaleResume = vi.fn(async () =>
      tr("trigger", "trigger-ok"));
    (
      fixture.loop.toolExecutor as unknown as {
        executeConversationBatch: typeof executeConversationBatch;
        executeSealedRationaleResume: typeof executeSealedRationaleResume;
      }
    ).executeConversationBatch = executeConversationBatch;
    (
      fixture.loop.toolExecutor as unknown as {
        executeSealedRationaleResume: typeof executeSealedRationaleResume;
      }
    ).executeSealedRationaleResume = executeSealedRationaleResume;
    vi.mocked(runRationaleOnlyRound).mockResolvedValueOnce({
      kind: "batch-decision",
      decision: {} as never,
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const result = await fixture.loop.runTurn(
        "prepare guarded files",
        undefined,
        undefined,
        {
          inputOrigin: "user-keyboard",
          requestAnchorRawIntent: "prepare guarded files",
        },
      );

      expect(executeConversationBatch).toHaveBeenCalledTimes(1);
      expect(result.toolCalls.map((call) => call.result)).toEqual([
        "trigger-ok",
        RATIONALE_SIBLING_CANCELLED_RESULT,
        RATIONALE_SIBLING_CANCELLED_RESULT,
        RATIONALE_SIBLING_REPLAY_BLOCKED_RESULT,
      ]);
      const warningText = JSON.stringify(warnSpy.mock.calls);
      expect(warningText).toContain("rationale cancelled sibling replay blocked");
      expect(warningText).not.toContain(secretMarker);
      expect(warningText).not.toContain("safe-target.txt");
    } finally {
      warnSpy.mockRestore();
    }
  });

});
