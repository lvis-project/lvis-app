import type { LLMProvider, TokenUsage } from "../llm/types.js";
import type {
  ConversationExecuteOptions,
  InterceptedMetaToolHandler,
  ToolExecutor,
  ToolResult,
  ToolUseBlock,
} from "../../tools/executor.js";
import {
  createCancelledSiblingProposalGuard,
  type CancelledSiblingProposalGuard,
  type HostRationaleEligibilityContext,
  type RationaleEligibilityProvenance,
  type RequestAnchor,
} from "../../tools/pipeline/rationale-control.js";
import type { RationaleHostRuntime } from "../../tools/pipeline/rationale-orchestrator.js";
import type { RationaleResumeHostRuntime } from "../../tools/pipeline/rationale-resume-runner.js";
import type { SealedRationaleResumeRequest } from "../../tools/pipeline/rationale-resume-contract.js";
import {
  runRationaleOnlyRound,
  type RationaleOnlyRoundResult,
  type RunRationaleOnlyRoundInput,
} from "./rationale-round.js";

export const RATIONALE_TRIGGER_DENIED_RESULT =
  "Rationale approval was denied; the action was not executed.";
export const RATIONALE_TRIGGER_CANCELLED_RESULT =
  "Rationale approval was cancelled; the action was not executed.";
export const RATIONALE_TRIGGER_TIMED_OUT_RESULT =
  "Rationale approval timed out; the action was not executed.";
export const RATIONALE_TRIGGER_FAILED_RESULT =
  "Rationale orchestration failed closed; the action was not executed.";
export const RATIONALE_TRIGGER_INTERRUPTED_RESULT =
  "Rationale approval was interrupted; the action was not executed.";
export const RATIONALE_SIBLING_CANCELLED_RESULT =
  "Cancelled because another action in this tool batch required rationale approval.";
export const RATIONALE_SIBLING_REPLAY_BLOCKED_RESULT =
  "This cancelled action must be proposed again from a new user-keyboard turn.";

export interface RationaleConversationCoordinator extends
  RationaleHostRuntime,
  RationaleResumeHostRuntime {
  handleRationaleRoundResult(input: {
    readonly ticketId: string;
    readonly result: RationaleOnlyRoundResult;
    readonly abortSignal?: AbortSignal;
    readonly now?: number;
  }): Promise<unknown | null>;
  promptForApproval(
    ticketId: string,
    input?: { readonly abortSignal?: AbortSignal; readonly now?: number },
  ): Promise<{
    readonly outcome: "allowed-once" | "denied" | "cancelled" | "timed-out";
  } | null>;
  createSealedResume(input: {
    readonly ticketId: string;
    readonly currentEligibilityContext: HostRationaleEligibilityContext;
    readonly now?: number;
  }): Promise<{ readonly resumeRequest: SealedRationaleResumeRequest } | null>;
  abort(ticketId: string, now?: number): unknown;
}

export type RationaleConversationRuntime = RationaleConversationCoordinator;

export interface RationaleCoordinatorFactoryInput {
  readonly requestAnchor: RequestAnchor;
  /** Snapshot at this executable batch boundary, after any prior tool taint. */
  readonly rationaleProvenance: RationaleEligibilityProvenance;
  readonly sessionId: string;
}

export type RationaleCoordinatorFactory = (
  input: RationaleCoordinatorFactoryInput,
) => Promise<RationaleConversationRuntime | null> | RationaleConversationRuntime | null;

/**
 * The query loop prepares a runtime before it changes meta-tool ordering.
 * A null/throwing factory must therefore be observable before the legacy
 * batch is split, while the executor still revalidates every actual action.
 */
export interface RationaleRuntimePreparationInput {
  readonly coordinatorFactory?: RationaleCoordinatorFactory;
  readonly requestAnchor: RequestAnchor | null;
  readonly rationaleProvenance: RationaleEligibilityProvenance;
  readonly sessionId: string;
}

export interface ExecuteRationaleAwareBatchInput {
  readonly executor: ToolExecutor;
  readonly toolUses: ToolUseBlock[];
  readonly executeOptions: ConversationExecuteOptions;
  readonly interceptedMetaToolHandler?: InterceptedMetaToolHandler;
  readonly provider: LLMProvider;
  readonly model: string;
  readonly llmSettings: RunRationaleOnlyRoundInput["llmSettings"];
  readonly abortSignal?: AbortSignal;
  readonly requestAnchor: RequestAnchor | null;
  readonly rationaleProvenance: RationaleEligibilityProvenance;
  readonly sessionId: string;
  /**
   * A runtime prepared before query-loop meta-tool ordering changed. `null`
   * explicitly preserves the legacy executor path and avoids retrying a
   * failed factory after the split.
   */
  readonly rationaleRuntime?: RationaleConversationRuntime | null;
  readonly coordinatorFactory?: RationaleCoordinatorFactory;
}

export interface RationaleAwareBatchResult {
  readonly results: ToolResult[];
  /** Ephemeral provider usage, accounted by the caller but never persisted as text. */
  readonly rationaleUsage: TokenUsage | null;
  readonly rationaleAttempted: boolean;
  /** Host-only replay guards; never append these values to provider-visible history. */
  readonly cancelledSiblingProposalGuards: readonly CancelledSiblingProposalGuard[];
  /** True when at least one cancelled sibling could not be safely fingerprinted. */
  readonly cancelledSiblingProposalGuardIncomplete: boolean;
}

function syntheticTerminalResult(toolUseId: string, content: string): ToolResult {
  return {
    tool_use_id: toolUseId,
    content,
    is_error: true,
    durationMs: 0,
  };
}

function abortSafely(
  runtime: RationaleConversationRuntime,
  ticketId: string,
): void {
  try {
    runtime.abort(ticketId);
  } catch {
    // Abort is cleanup-only. A broken cleanup callback must never prevent the
    // host from reconstructing every original tool_use/result pairing.
  }
}

export function createTerminalRationaleBatchResults(input: {
  readonly toolUses: readonly ToolUseBlock[];
  readonly completedResults: readonly ToolResult[];
  readonly triggeringToolUseId: string;
  readonly triggeringContent: string;
}): ToolResult[] {
  const completedById = new Map(
    input.completedResults.map((result) => [result.tool_use_id, result] as const),
  );
  return input.toolUses.map((toolUse) => {
    const completed = completedById.get(toolUse.id);
    if (completed) return completed;
    return syntheticTerminalResult(
      toolUse.id,
      toolUse.id === input.triggeringToolUseId
        ? input.triggeringContent
        : RATIONALE_SIBLING_CANCELLED_RESULT,
    );
  });
}

function runtimeMatchesBatch(
  runtime: RationaleConversationRuntime,
  requestAnchor: RequestAnchor,
  provenance: RationaleEligibilityProvenance,
): boolean {
  const runtimeAnchor = runtime.requestAnchor;
  return runtimeAnchor !== null &&
    runtimeAnchor.anchorId === requestAnchor.anchorId &&
    runtimeAnchor.sessionId === requestAnchor.sessionId &&
    runtimeAnchor.turnId === requestAnchor.turnId &&
    runtimeAnchor.inputMessageId === requestAnchor.inputMessageId &&
    runtimeAnchor.intentDigest === requestAnchor.intentDigest &&
    runtime.rationaleProvenance.startedFromUserKeyboard ===
      provenance.startedFromUserKeyboard &&
    runtime.rationaleProvenance.taint === provenance.taint;
}

export async function prepareRationaleConversationRuntime(
  input: Readonly<RationaleRuntimePreparationInput>,
): Promise<RationaleConversationRuntime | null> {
  if (!input.coordinatorFactory || input.requestAnchor === null) return null;
  try {
    const runtime = await input.coordinatorFactory({
      requestAnchor: input.requestAnchor,
      rationaleProvenance: input.rationaleProvenance,
      sessionId: input.sessionId,
    });
    return runtime && runtimeMatchesBatch(
      runtime,
      input.requestAnchor,
      input.rationaleProvenance,
    )
      ? runtime
      : null;
  } catch {
    // No control was materialized. Preserve the existing permission/modal path.
    return null;
  }
}

function preparedRuntimeMatchesBatch(
  input: ExecuteRationaleAwareBatchInput,
): RationaleConversationRuntime | null | undefined {
  if (input.rationaleRuntime === undefined) return undefined;
  return input.rationaleRuntime !== null && input.requestAnchor !== null &&
      runtimeMatchesBatch(
        input.rationaleRuntime,
        input.requestAnchor,
        input.rationaleProvenance,
      )
    ? input.rationaleRuntime
    : null;
}

/**
 * Resolve one executable tool batch without ever exposing the host control as
 * an ordinary result. Once a control exists, every exit completes the original
 * tool_use/result pairing and retires the live ticket on exceptional paths.
 */
export async function executeRationaleAwareConversationBatch(
  input: ExecuteRationaleAwareBatchInput,
): Promise<RationaleAwareBatchResult> {
  const preparedRuntime = preparedRuntimeMatchesBatch(input);
  const runtime = preparedRuntime === undefined
    ? await prepareRationaleConversationRuntime(input)
    : preparedRuntime;
  const batch = await input.executor.executeConversationBatch(input.toolUses, {
    ...input.executeOptions,
    ...(runtime ? { rationaleRuntime: runtime } : {}),
    ...(input.interceptedMetaToolHandler
      ? { interceptedMetaToolHandler: input.interceptedMetaToolHandler }
      : {}),
  });
  if (batch.outcome === "completed") {
    return {
      results: batch.results,
      rationaleUsage: null,
      rationaleAttempted: false,
      cancelledSiblingProposalGuards: [],
      cancelledSiblingProposalGuardIncomplete: false,
    };
  }

  const control = batch.control.control;
  const ticketId = control.ticketId;
  const triggeringToolUseId = control.sealedAction.toolUseId;
  const completedToolUseIds = new Set(
    batch.completedResults.map((result) => result.tool_use_id),
  );
  const cancelledSiblingToolUses = input.toolUses.filter(
    (toolUse) =>
      toolUse.id !== triggeringToolUseId &&
      !completedToolUseIds.has(toolUse.id),
  );
  const cancelledSiblingProposalGuards: CancelledSiblingProposalGuard[] = [];
  let cancelledSiblingProposalGuardIncomplete = false;
  for (const toolUse of cancelledSiblingToolUses) {
    try {
      cancelledSiblingProposalGuards.push(createCancelledSiblingProposalGuard({
        anchorId: input.requestAnchor!.anchorId,
        toolName: toolUse.name,
        originalInput: toolUse.input,
      }));
    } catch {
      cancelledSiblingProposalGuardIncomplete = true;
    }
  }
  let rationaleUsage: TokenUsage | null = null;
  const terminal = (content: string): RationaleAwareBatchResult => ({
    results: createTerminalRationaleBatchResults({
      toolUses: input.toolUses,
      completedResults: batch.completedResults,
      triggeringToolUseId,
      triggeringContent: content,
    }),
    rationaleUsage,
    rationaleAttempted: true,
    cancelledSiblingProposalGuards,
    cancelledSiblingProposalGuardIncomplete,
  });

  // A rationale-required outcome can only be produced with a bound runtime.
  if (!runtime) return terminal(RATIONALE_TRIGGER_FAILED_RESULT);

  try {
    const roundResult = await runRationaleOnlyRound({
      provider: input.provider,
      model: input.model,
      control,
      llmSettings: input.llmSettings,
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    });
    rationaleUsage = roundResult.usage;
    if (roundResult.kind === "interrupted") {
      abortSafely(runtime, ticketId);
      return terminal(RATIONALE_TRIGGER_INTERRUPTED_RESULT);
    }

    const roundResolution = await runtime.handleRationaleRoundResult({
      ticketId,
      result: roundResult,
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    });
    if (roundResolution === null || input.abortSignal?.aborted) {
      abortSafely(runtime, ticketId);
      return terminal(
        input.abortSignal?.aborted
          ? RATIONALE_TRIGGER_INTERRUPTED_RESULT
          : RATIONALE_TRIGGER_FAILED_RESULT,
      );
    }

    // Exactly one host ApprovalGate request is made for this ticket.
    const approval = await runtime.promptForApproval(ticketId, {
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    });
    if (approval?.outcome !== "allowed-once") {
      if (approval === null) abortSafely(runtime, ticketId);
      return terminal(
        approval?.outcome === "denied"
          ? RATIONALE_TRIGGER_DENIED_RESULT
          : approval?.outcome === "timed-out"
            ? RATIONALE_TRIGGER_TIMED_OUT_RESULT
            : RATIONALE_TRIGGER_CANCELLED_RESULT,
      );
    }

    if (input.abortSignal?.aborted) {
      abortSafely(runtime, ticketId);
      return terminal(RATIONALE_TRIGGER_INTERRUPTED_RESULT);
    }

    const sealed = await runtime.createSealedResume({
      ticketId,
      currentEligibilityContext: control.eligibilityContext,
    });
    if (sealed === null || input.abortSignal?.aborted) {
      abortSafely(runtime, ticketId);
      return terminal(
        input.abortSignal?.aborted
          ? RATIONALE_TRIGGER_INTERRUPTED_RESULT
          : RATIONALE_TRIGGER_FAILED_RESULT,
      );
    }

    const resumed = await input.executor.executeSealedRationaleResume(
      sealed.resumeRequest,
      {
        ...input.executeOptions,
        rationaleResumeRuntime: runtime,
      },
    );
    if (resumed.tool_use_id !== triggeringToolUseId) {
      abortSafely(runtime, ticketId);
      return terminal(RATIONALE_TRIGGER_FAILED_RESULT);
    }
    const completedResults = [...batch.completedResults, resumed];
    return {
      results: createTerminalRationaleBatchResults({
        toolUses: input.toolUses,
        completedResults,
        triggeringToolUseId,
        triggeringContent: RATIONALE_TRIGGER_FAILED_RESULT,
      }),
      rationaleUsage,
      rationaleAttempted: true,
      cancelledSiblingProposalGuards,
      cancelledSiblingProposalGuardIncomplete,
    };
  } catch {
    abortSafely(runtime, ticketId);
    return terminal(
      input.abortSignal?.aborted
        ? RATIONALE_TRIGGER_INTERRUPTED_RESULT
        : RATIONALE_TRIGGER_FAILED_RESULT,
    );
  }
}
