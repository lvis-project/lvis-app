import { describe, expect, it, vi } from "vitest";
import type { PermissionCheckResult } from "../../../permissions/permission-manager.js";
import { canonicalStringify } from "../../../shared/canonical-json.js";
import { TOOL_TIMEOUT_POLICY } from "../../../shared/tool-timeout-policy.js";
import {
  InMemoryHostAnchorRoundCasStore,
  RATIONALE_RESPONSE_SCHEMA,
  RATIONALE_RESPONSE_TOOL,
  createActionIdentity,
  createRationaleRequiredControl,
  createRequestAnchor,
  createTriggeringBatchDisposition,
  toRationaleProviderEnvelope,
  type RationaleRequiredControl,
} from "../../../tools/pipeline/rationale-control.js";
import { rationaleResponseFor } from "../../../tools/pipeline/__tests__/rationale-fixtures.js";
import type {
  LLMProvider,
  StreamEvent,
  StreamTurnParams,
} from "../../llm/types.js";
import {
  RATIONALE_ONLY_SYSTEM_INSTRUCTION,
  runRationaleOnlyRound,
  type RationaleOnlyRoundBatchResult,
  type RationaleOnlyRoundResult,
} from "../rationale-round.js";
import * as streamCollector from "../stream-collector.js";

const NOW = Date.now();
const LLM_SETTINGS = {
  streamSmoothing: "none",
  enableThinking: false,
  thinkingBudgetTokens: 1_024,
} as const;

const ELIGIBILITY_CONTEXT = {
  headless: false,
  forceModal: false,
  approvalReasonPrefix: null,
} as const;

const PERMISSION = {
  decision: "ask",
  reason: "reviewer threshold",
  layer: 5,
  reviewer: {
    route: "foreground-auto",
    verdict: { level: "high", reason: "bounded workspace deletion" },
    outcome: "fresh",
  },
} as const satisfies PermissionCheckResult;

function fixture(): RationaleRequiredControl {
  const anchor = createRequestAnchor({
    sessionId: "session-1",
    turnId: "turn-1",
    inputMessageId: "message-1",
    inputOrigin: "user-keyboard",
    rawIntent: "clean the build output",
    now: NOW,
    ttlMs: 10 * 60_000,
  });
  if (!anchor) throw new Error("expected request anchor");

  const finalInput = { command: "Remove-Item -Recurse build" };
  const action = createActionIdentity({
    anchorId: anchor.anchorId,
    invocationTrustOrigin: "llm-tool-arg",
    rationaleProvenance: { startedFromUserKeyboard: true, taint: "none" },
    toolName: "bash",
    toolVersion: "1",
    source: "builtin",
    category: "shell",
    finalInput,
    canonicalTargets: ["workspace/build"],
    requestedEffects: ["delete-files"],
    affectedResources: ["workspace/build"],
    requiredAuthority: "shell",
    policyEpoch: "policy-1",
    registryGeneration: "registry-1",
    sandboxGeneration: "sandbox-1",
    sandboxExecutionPlan: { cwd: "workspace", filesystem: "workspace-only" },
  });
  const triggeringBatchDisposition = createTriggeringBatchDisposition({
    batchId: "provider-batch-1",
    originalToolUseIds: ["tool-use-1", "tool-use-cancelled"],
    triggeringToolUseId: "tool-use-1",
    completedToolUseIds: [],
  });
  const hostAnchorRoundCas = new InMemoryHostAnchorRoundCasStore();
  const anchorRoundReservation = hostAnchorRoundCas.tryReserve({
    anchor,
    action,
    triggeringBatchDisposition,
    round: 1,
    now: NOW,
  });
  if (!anchorRoundReservation) throw new Error("expected anchor round reservation");

  return createRationaleRequiredControl({
    anchor,
    action,
    triggeringBatchDisposition,
    anchorRoundReservation,
    hostAnchorRoundCas,
    eligibilityContext: ELIGIBILITY_CONTEXT,
    permission: PERMISSION,
    now: NOW,
    sealedAction: {
      toolUseId: "tool-use-1",
      toolName: "bash",
      originalInput: finalInput,
      finalInput,
    },
  });
}

const responseFor = (control: RationaleRequiredControl) =>
  rationaleResponseFor(control, "This removes the sealed workspace build output.");

class RecordingProvider implements LLMProvider {
  readonly vendor = "openai" as const;
  readonly requests: StreamTurnParams[] = [];

  constructor(private readonly events: readonly StreamEvent[]) {}

  async *streamTurn(params: StreamTurnParams): AsyncIterable<StreamEvent> {
    this.requests.push(params);
    yield* this.events;
  }
}

class ThrowingProvider implements LLMProvider {
  readonly vendor = "openai" as const;
  readonly requests: StreamTurnParams[] = [];

  constructor(private readonly error: Error) {}

  // eslint-disable-next-line require-yield
  async *streamTurn(params: StreamTurnParams): AsyncIterable<StreamEvent> {
    this.requests.push(params);
    throw this.error;
  }
}

class HangingProvider implements LLMProvider {
  readonly vendor = "openai" as const;
  readonly requests: StreamTurnParams[] = [];

  // eslint-disable-next-line require-yield
  async *streamTurn(params: StreamTurnParams): AsyncIterable<StreamEvent> {
    this.requests.push(params);
    await new Promise<never>(() => {});
  }
}

class AbortAwareProvider implements LLMProvider {
  readonly vendor = "openai" as const;
  readonly requests: StreamTurnParams[] = [];

  // eslint-disable-next-line require-yield
  async *streamTurn(params: StreamTurnParams): AsyncIterable<StreamEvent> {
    this.requests.push(params);
    const signal = params.abortSignal;
    if (!signal) throw new Error("expected a linked abort signal");
    await new Promise<never>((_resolve, reject) => {
      const onAbort = () => {
        const error = new Error("operation was aborted");
        error.name = "AbortError";
        reject(error);
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

function batchResult(result: RationaleOnlyRoundResult): RationaleOnlyRoundBatchResult {
  if (result.kind !== "batch-decision") {
    throw new Error(`expected batch decision, got ${result.kind}`);
  }
  return result;
}

async function run(
  provider: LLMProvider,
  control: RationaleRequiredControl,
  abortSignal?: AbortSignal,
) {
  return runRationaleOnlyRound({
    provider,
    model: "test-model",
    control,
    llmSettings: LLM_SETTINGS,
    abortSignal,
    now: NOW,
  });
}

describe("runRationaleOnlyRound", () => {
  it("uses one fixed ephemeral data message, one rationale schema, and returns usage", async () => {
    const control = fixture();
    const usage = {
      inputTokens: 17,
      outputTokens: 9,
      cacheReadTokens: 3,
    };
    const provider = new RecordingProvider([
      { type: "reasoning_delta", text: "hidden reasoning" },
      { type: "text_delta", text: "hidden provider prose" },
      {
        type: "tool_call",
        id: "rationale-call",
        name: RATIONALE_RESPONSE_TOOL,
        input: responseFor(control),
      },
      { type: "message_complete", stopReason: "tool_use", usage },
    ]);

    const result = batchResult(await run(provider, control));
    expect(result.decision).toMatchObject({
      accepted: true,
      generationOutcome: "accepted-rationale",
      ticketCreationAllowed: true,
      sideEffectsAllowed: false,
    });
    expect(result.usage).toEqual(usage);
    expect(JSON.stringify(result)).not.toContain("hidden reasoning");
    expect(JSON.stringify(result)).not.toContain("hidden provider prose");

    expect(provider.requests).toHaveLength(1);
    const request = provider.requests[0]!;
    expect(request.systemPrompt).toBe(RATIONALE_ONLY_SYSTEM_INSTRUCTION);
    expect(request.systemPrompt).toContain(RATIONALE_RESPONSE_TOOL);
    expect(request.systemPrompt).not.toContain(control.anchor.sanitizedIntent);
    expect(request.systemPrompt).not.toContain(control.action.toolName);
    expect(request.tools).toEqual([RATIONALE_RESPONSE_SCHEMA]);
    expect(request.messages).toEqual([{
      role: "user",
      content: canonicalStringify(toRationaleProviderEnvelope(control)),
    }]);
    expect(request.messages).toHaveLength(1);
    expect(request).not.toHaveProperty("onTextDelta");
    expect(request).not.toHaveProperty("onReasoningDelta");
  });

  it.each([
    ["zero-call", [] as StreamEvent[]],
    ["text-only", [
      { type: "text_delta", text: "I will not use the response tool." },
    ] as StreamEvent[]],
  ])("maps %s output to missing-rationale-call without surfacing prose", async (_label, prefix) => {
    const control = fixture();
    const provider = new RecordingProvider([
      ...prefix,
      { type: "message_complete", stopReason: "end_turn" },
    ]);

    const result = batchResult(await run(provider, control));
    expect(result.decision).toMatchObject({
      accepted: false,
      generationOutcome: "missing-rationale-call",
      ticketCreationAllowed: false,
      sideEffectsAllowed: false,
    });
    expect(result.decision.rejectedCallIds).toEqual([]);
    expect(result.usage).toBeNull();
    expect(JSON.stringify(result)).not.toContain("I will not use");
  });

  it("rejects malformed rationale data through the PR1 evaluator", async () => {
    const control = fixture();
    const provider = new RecordingProvider([
      {
        type: "tool_call",
        id: "malformed-call",
        name: RATIONALE_RESPONSE_TOOL,
        input: {
          ...responseFor(control),
          actionDigest: "0".repeat(64),
        },
      },
      { type: "message_complete", stopReason: "tool_use" },
    ]);

    const result = batchResult(await run(provider, control));
    expect(result.decision).toMatchObject({
      accepted: false,
      generationOutcome: "malformed-rationale",
      rejectedCallIds: ["malformed-call"],
      ticketCreationAllowed: false,
      sideEffectsAllowed: false,
    });
  });

  it("rejects an ordinary tool call without any executor or ticket authority", async () => {
    const control = fixture();
    const provider = new RecordingProvider([
      {
        type: "tool_call",
        id: "ordinary-call",
        name: "bash",
        input: { command: "Write-Output should-never-run" },
      },
      { type: "message_complete", stopReason: "tool_use" },
    ]);

    const result = batchResult(await run(provider, control));
    expect(result.decision).toMatchObject({
      accepted: false,
      generationOutcome: "ordinary-tool-call-rejected",
      rejectedCallIds: ["ordinary-call"],
      cancelledRationaleOnlySiblingCallIds: [],
      ticketCreationAllowed: false,
      sideEffectsAllowed: false,
    });
    expect(provider.requests[0]!.tools).toEqual([RATIONALE_RESPONSE_SCHEMA]);
  });

  it("rejects one of multiple rationale calls and cancels every sibling", async () => {
    const control = fixture();
    const provider = new RecordingProvider([
      {
        type: "tool_call",
        id: "rationale-1",
        name: RATIONALE_RESPONSE_TOOL,
        input: responseFor(control),
      },
      {
        type: "tool_call",
        id: "rationale-2",
        name: RATIONALE_RESPONSE_TOOL,
        input: responseFor(control),
      },
      { type: "message_complete", stopReason: "tool_use" },
    ]);

    const result = batchResult(await run(provider, control));
    expect(result.decision).toMatchObject({
      accepted: false,
      generationOutcome: "multiple-calls-rejected",
      rejectedCallIds: ["rationale-1"],
      cancelledRationaleOnlySiblingCallIds: ["rationale-2"],
      ticketCreationAllowed: false,
      sideEffectsAllowed: false,
    });
  });

  it.each([
    ["ECONNREFUSED provider", "generation-unavailable", "network"],
    ["provider request timed out", "generation-timeout", "unknown"],
    ["unexpected provider corruption", "generation-error", "unknown"],
    ["context window exceeded", "generation-error", "context-length"],
  ] as const)(
    "maps stream failure %s to %s",
    async (message, generationOutcome, classification) => {
      const control = fixture();
      const result = await run(
        new RecordingProvider([{ type: "error", error: message }]),
        control,
      );

      expect(result).toEqual({
        kind: "generation-failure",
        generationOutcome,
        streamKind: classification === "context-length"
          ? "context_error"
          : "stream_error",
        classification,
        usage: null,
      });
    },
  );

  it("keeps a caller abort distinct from generation timeout", async () => {
    const control = fixture();
    const abortController = new AbortController();
    abortController.abort(new Error("caller cancelled"));
    const provider = new RecordingProvider([
      { type: "message_complete", stopReason: "end_turn" },
    ]);

    await expect(run(provider, control, abortController.signal)).resolves.toEqual({
      kind: "interrupted",
      usage: null,
    });
    expect(provider.requests).toHaveLength(0);
  });

  it.each(["operation was aborted", "provider deadline"])(
    "does not infer a timeout from an unsolicited provider AbortError: %s",
    async (message) => {
      const control = fixture();
      const error = new Error(message);
      error.name = "AbortError";
      const provider = new ThrowingProvider(error);

      await expect(run(provider, control)).resolves.toEqual({
        kind: "generation-failure",
        generationOutcome: "generation-error",
        streamKind: "stream_error",
        classification: "unknown",
        usage: null,
      });
      expect(provider.requests[0]!.abortSignal?.aborted).toBe(false);
    },
  );

  it.each([
    ["provider request timed out", "unknown"],
    ["provider deadline exceeded", "unknown"],
    ["provider stream idle timeout", "network"],
  ] as const)("preserves explicit provider timeout evidence: %s", async (message, classification) => {
    const control = fixture();
    const error = new Error(message);
    error.name = "AbortError";
    const provider = new ThrowingProvider(error);

    await expect(run(provider, control)).resolves.toEqual({
      kind: "generation-failure",
      generationOutcome: "generation-timeout",
      streamKind: "stream_error",
      classification,
      usage: null,
    });
    expect(provider.requests[0]!.abortSignal?.aborted).toBe(false);
  });

  it("rejects a collector interruption without a host boundary owner", async () => {
    const collect = vi.spyOn(streamCollector, "collectRoundStream").mockResolvedValueOnce({
      kind: "interrupted",
      text: "",
    });
    try {
      await expect(run(new RecordingProvider([]), fixture())).rejects.toThrow(
        "Rationale stream interrupted without a deadline or caller abort",
      );
      expect(collect.mock.calls[0]![0].abortSignal?.aborted).toBe(false);
    } finally {
      collect.mockRestore();
    }
  });

  it.each([
    ["ignores abort", () => new HangingProvider()],
    ["throws AbortError on abort", () => new AbortAwareProvider()],
  ] as const)("enforces the host generation deadline when the provider %s", async (_label, createProvider) => {
    vi.useFakeTimers();
    try {
      const control = fixture();
      const provider = createProvider();
      const pending = run(provider, control);
      await vi.advanceTimersByTimeAsync(0);
      expect(provider.requests).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(
        TOOL_TIMEOUT_POLICY.rationaleGenerationMs - 1,
      );
      expect(provider.requests[0]!.abortSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toEqual({
        kind: "generation-failure",
        generationOutcome: "generation-timeout",
        streamKind: "interrupted",
        classification: "timeout",
        usage: null,
      });
      expect(provider.requests[0]!.abortSignal?.aborted).toBe(true);
      expect(provider.requests[0]!.abortSignal?.reason.message).toBe(
        `deadline exceeded after ${TOOL_TIMEOUT_POLICY.rationaleGenerationMs}ms`,
      );
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["ignores abort", () => new HangingProvider()],
    ["throws AbortError on abort", () => new AbortAwareProvider()],
  ] as const)("keeps caller cancellation distinct when the provider %s", async (_label, createProvider) => {
    vi.useFakeTimers();
    try {
      const control = fixture();
      const provider = createProvider();
      const caller = new AbortController();
      const pending = run(provider, control, caller.signal);
      await vi.advanceTimersByTimeAsync(0);
      const reason = new Error("caller cancelled");
      caller.abort(reason);

      await expect(pending).resolves.toEqual({
        kind: "interrupted",
        usage: null,
      });
      expect(provider.requests[0]!.abortSignal?.aborted).toBe(true);
      expect(provider.requests[0]!.abortSignal?.reason).toBe(reason);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
