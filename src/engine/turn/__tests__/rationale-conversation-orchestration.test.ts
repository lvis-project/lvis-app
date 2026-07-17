import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LLMProvider } from "../../llm/types.js";
import type {
  ConversationBatchExecutionOutcome,
  ToolExecutor,
  ToolResult,
  ToolUseBlock,
} from "../../../tools/executor.js";
import {
  createRequestAnchor,
  type RationaleEligibilityProvenance,
  type RationaleRequiredControl,
} from "../../../tools/pipeline/rationale-control.js";
import type { RationaleExecutorControlOutcome } from "../../../tools/pipeline/rationale-pr1-contract.js";
import type { SealedRationaleResumeRequest } from "../../../tools/pipeline/rationale-resume-contract.js";
import {
  RATIONALE_SIBLING_CANCELLED_RESULT,
  RATIONALE_TRIGGER_DENIED_RESULT,
  RATIONALE_TRIGGER_FAILED_RESULT,
  RATIONALE_TRIGGER_INTERRUPTED_RESULT,
  RATIONALE_TRIGGER_TIMED_OUT_RESULT,
  createTerminalRationaleBatchResults,
  executeRationaleAwareConversationBatch,
  type RationaleConversationCoordinator,
} from "../rationale-conversation-orchestration.js";
import { runRationaleOnlyRound } from "../rationale-round.js";

vi.mock("../rationale-round.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../rationale-round.js")>();
  return {
    ...actual,
    runRationaleOnlyRound: vi.fn(),
  };
});

const provenance: RationaleEligibilityProvenance = {
  startedFromUserKeyboard: true,
  taint: "none",
};
const anchor = createRequestAnchor({
  sessionId: "session-1",
  turnId: "turn-1",
  inputMessageId: "message-1",
  inputOrigin: "user-keyboard",
  rawIntent: "run the requested action",
  now: 1_000,
})!;

const toolUses: ToolUseBlock[] = [
  { id: "prefix", name: "read_file", input: { path: "a.txt" } },
  { id: "trigger", name: "bash", input: { command: "echo ok" } },
  { id: "sibling", name: "write_file", input: { path: "b.txt" } },
];

function result(toolUseId: string, content: string): ToolResult {
  return { tool_use_id: toolUseId, content, is_error: false, durationMs: 1 };
}

const control = {
  ticketId: "ticket-1",
  sealedAction: { toolUseId: "trigger" },
  eligibilityContext: {
    headless: false,
    forceModal: false,
    approvalReasonPrefix: null,
  },
} as unknown as RationaleRequiredControl;
const executorControl = {
  control,
  channel: "executor-control",
  outcome: "rationale-required",
  transcriptVisibility: "hidden",
  ordinaryToolResult: null,
} as unknown as RationaleExecutorControlOutcome;
const sealedResume = {
  ticketId: "ticket-1",
  control,
} as unknown as SealedRationaleResumeRequest;

function makeCoordinator(
  overrides: Partial<RationaleConversationCoordinator> = {},
): RationaleConversationCoordinator {
  return {
    requestAnchor: anchor,
    rationaleProvenance: provenance,
    materializeRationaleControl: vi.fn(),
    onInvocationAudit: vi.fn(),
    handleRationaleRoundResult: vi.fn(async () => ({ status: "ready" })),
    promptForApproval: vi.fn(async () => ({ outcome: "allowed-once" as const })),
    createSealedResume: vi.fn(async () => ({ resumeRequest: sealedResume })),
    abort: vi.fn(),
    ...overrides,
  };
}

function makeExecutor(input?: {
  batch?: ConversationBatchExecutionOutcome;
  resumed?: ToolResult;
}) {
  const executeConversationBatch = vi.fn(async () =>
    input?.batch ?? {
      outcome: "rationale-required" as const,
      completedResults: [result("prefix", "prefix-ok")],
      control: executorControl,
    });
  const executeSealedRationaleResume = vi.fn(async () =>
    input?.resumed ?? result("trigger", "trigger-ok"));
  return {
    executor: {
      executeConversationBatch,
      executeSealedRationaleResume,
    } as unknown as ToolExecutor,
    executeConversationBatch,
    executeSealedRationaleResume,
  };
}

const provider = {
  vendor: "openai",
  async *streamTurn() {
    yield { type: "message_complete" as const, stopReason: "end_turn" as const };
  },
} satisfies LLMProvider;

function invoke(input: {
  coordinator?: RationaleConversationCoordinator;
  executor?: ReturnType<typeof makeExecutor>;
  abortSignal?: AbortSignal;
} = {}) {
  const executor = input.executor ?? makeExecutor();
  const coordinator = input.coordinator ?? makeCoordinator();
  const coordinatorFactory = vi.fn(async () => coordinator);
  return {
    coordinator,
    coordinatorFactory,
    executor,
    promise: executeRationaleAwareConversationBatch({
      executor: executor.executor,
      toolUses,
      executeOptions: { executionCwd: "C:\\workspace" },
      provider,
      model: "test-model",
      llmSettings: {
        streamSmoothing: "none",
        enableThinking: false,
        thinkingBudgetTokens: 1_024,
      },
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
      requestAnchor: anchor,
      rationaleProvenance: provenance,
      sessionId: "session-1",
      coordinatorFactory,
    }),
  };
}

beforeEach(() => {
  vi.mocked(runRationaleOnlyRound).mockReset();
  vi.mocked(runRationaleOnlyRound).mockResolvedValue({
    kind: "batch-decision",
    decision: {} as never,
    usage: {
      inputTokens: 17,
      outputTokens: 3,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
    },
  });
});

describe("executeRationaleAwareConversationBatch", () => {
  it("preserves the completed prefix, resumes the trigger once, cancels siblings, and hides the control", async () => {
    const fixture = invoke();
    const outcome = await fixture.promise;

    expect(outcome.results.map((item) => item.tool_use_id)).toEqual([
      "prefix",
      "trigger",
      "sibling",
    ]);
    expect(outcome.results.map((item) => item.content)).toEqual([
      "prefix-ok",
      "trigger-ok",
      RATIONALE_SIBLING_CANCELLED_RESULT,
    ]);
    expect(outcome.results[2]).toMatchObject({ is_error: true, durationMs: 0 });
    expect(outcome.rationaleUsage).toEqual({
      inputTokens: 17,
      outputTokens: 3,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
    });
    expect(fixture.coordinator.promptForApproval).toHaveBeenCalledTimes(1);
    expect(fixture.coordinator.createSealedResume).toHaveBeenCalledTimes(1);
    expect(fixture.executor.executeSealedRationaleResume).toHaveBeenCalledTimes(1);
    expect(
      fixture.executor.executeSealedRationaleResume.mock.calls[0]?.[1]
        ?.rationaleResumeRuntime,
    ).toBe(fixture.coordinator);
    expect(JSON.stringify(outcome.results)).not.toContain("ticket-1");
    expect(JSON.stringify(outcome.results)).not.toContain("rationale-required");
  });

  it("uses one deny decision as the trigger terminal result and never resumes", async () => {
    const coordinator = makeCoordinator({
      promptForApproval: vi.fn(async () => ({ outcome: "denied" as const })),
    });
    const fixture = invoke({ coordinator });
    const outcome = await fixture.promise;

    expect(outcome.results.map((item) => item.content)).toEqual([
      "prefix-ok",
      RATIONALE_TRIGGER_DENIED_RESULT,
      RATIONALE_SIBLING_CANCELLED_RESULT,
    ]);
    expect(coordinator.promptForApproval).toHaveBeenCalledTimes(1);
    expect(coordinator.createSealedResume).not.toHaveBeenCalled();
    expect(fixture.executor.executeSealedRationaleResume).not.toHaveBeenCalled();
  });

  it("keeps a host modal timeout distinct and never resumes", async () => {
    const coordinator = makeCoordinator({
      promptForApproval: vi.fn(async () => ({ outcome: "timed-out" as const })),
    });
    const fixture = invoke({ coordinator });
    const outcome = await fixture.promise;

    expect(outcome.results.map((item) => item.content)).toEqual([
      "prefix-ok",
      RATIONALE_TRIGGER_TIMED_OUT_RESULT,
      RATIONALE_SIBLING_CANCELLED_RESULT,
    ]);
    expect(coordinator.createSealedResume).not.toHaveBeenCalled();
    expect(fixture.executor.executeSealedRationaleResume).not.toHaveBeenCalled();
  });

  it("aborts the live ticket and completes every pairing when orchestration throws", async () => {
    const coordinator = makeCoordinator({
      handleRationaleRoundResult: vi.fn(async () => {
        throw new Error("unexpected coordinator failure");
      }),
    });
    const fixture = invoke({ coordinator });
    const outcome = await fixture.promise;

    expect(coordinator.abort).toHaveBeenCalledWith("ticket-1");
    expect(outcome.results).toHaveLength(toolUses.length);
    expect(outcome.results.map((item) => item.content)).toEqual([
      "prefix-ok",
      RATIONALE_TRIGGER_FAILED_RESULT,
      RATIONALE_SIBLING_CANCELLED_RESULT,
    ]);
  });

  it("swallows abort callback failures and still completes every pairing", async () => {
    const coordinator = makeCoordinator({
      handleRationaleRoundResult: vi.fn(async () => {
        throw new Error("unexpected coordinator failure");
      }),
      abort: vi.fn(() => {
        throw new Error("abort callback failure");
      }),
    });
    const fixture = invoke({ coordinator });
    const outcome = await fixture.promise;

    expect(coordinator.abort).toHaveBeenCalledWith("ticket-1");
    expect(outcome.results).toHaveLength(toolUses.length);
    expect(outcome.results.map((item) => item.content)).toEqual([
      "prefix-ok",
      RATIONALE_TRIGGER_FAILED_RESULT,
      RATIONALE_SIBLING_CANCELLED_RESULT,
    ]);
    expect(JSON.stringify(outcome.results)).not.toContain("abort callback failure");
  });

  it("terminalizes caller abort without opening the modal", async () => {
    const abort = new AbortController();
    abort.abort();
    vi.mocked(runRationaleOnlyRound).mockResolvedValueOnce({
      kind: "interrupted",
      usage: null,
    });
    const fixture = invoke({ abortSignal: abort.signal });
    const outcome = await fixture.promise;

    expect(fixture.coordinator.abort).toHaveBeenCalledWith("ticket-1");
    expect(fixture.coordinator.promptForApproval).not.toHaveBeenCalled();
    expect(outcome.results[1]?.content).toBe(RATIONALE_TRIGGER_INTERRUPTED_RESULT);
    expect(outcome.results).toHaveLength(toolUses.length);
  });

  it("fails closed when resume returns a result for a different tool_use id", async () => {
    const executor = makeExecutor({ resumed: result("forged-id", "forged") });
    const fixture = invoke({ executor });
    const outcome = await fixture.promise;

    expect(fixture.coordinator.abort).toHaveBeenCalledWith("ticket-1");
    expect(outcome.results[1]?.content).toBe(RATIONALE_TRIGGER_FAILED_RESULT);
    expect(JSON.stringify(outcome.results)).not.toContain("forged-id");
    expect(JSON.stringify(outcome.results)).not.toContain("forged");
  });

  it("rejects a factory runtime bound to a different provenance and keeps the legacy batch path", async () => {
    const mismatched = makeCoordinator({
      rationaleProvenance: {
        startedFromUserKeyboard: true,
        taint: "file-content",
      },
    });
    const executor = makeExecutor({
      batch: {
        outcome: "completed",
        results: toolUses.map((toolUse) => result(toolUse.id, "legacy")),
      },
    });
    const coordinatorFactory = vi.fn(async () => mismatched);
    const outcome = await executeRationaleAwareConversationBatch({
      executor: executor.executor,
      toolUses,
      executeOptions: { executionCwd: "C:\\workspace" },
      provider,
      model: "test-model",
      llmSettings: {
        streamSmoothing: "none",
        enableThinking: false,
        thinkingBudgetTokens: 1_024,
      },
      requestAnchor: anchor,
      rationaleProvenance: provenance,
      sessionId: "session-1",
      coordinatorFactory,
    });

    expect(outcome.rationaleAttempted).toBe(false);
    expect(
      executor.executeConversationBatch.mock.calls[0]?.[1]?.rationaleRuntime,
    ).toBeUndefined();
  });
});

describe("createTerminalRationaleBatchResults", () => {
  it("reconstructs every original id in order without duplicating completed results", () => {
    expect(createTerminalRationaleBatchResults({
      toolUses,
      completedResults: [result("prefix", "done")],
      triggeringToolUseId: "trigger",
      triggeringContent: RATIONALE_TRIGGER_FAILED_RESULT,
    })).toEqual([
      result("prefix", "done"),
      {
        tool_use_id: "trigger",
        content: RATIONALE_TRIGGER_FAILED_RESULT,
        is_error: true,
        durationMs: 0,
      },
      {
        tool_use_id: "sibling",
        content: RATIONALE_SIBLING_CANCELLED_RESULT,
        is_error: true,
        durationMs: 0,
      },
    ]);
  });
});
