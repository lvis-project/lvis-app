/**
 * queryLoop — the vendor-abstracted agentic round loop, extracted
 * from conversation-loop.ts as a free function over `self: LoopContext`. All
 * turn state (history, provider, usage, lastRound/lastContext token fields,
 * guidance queue) stays on the ConversationLoop instance, accessed via `self`.
 */
import { randomUUID } from "node:crypto";
/**
 * LoopContext — the turn-local mutable carrier that the run-turn
 * and query-loop free functions operate on. It is the ConversationLoop instance
 * itself: the class owns all turn state (history, provider, the lastRound and
 * lastContext token-projection fields, the guidance queue, compaction flags),
 * and the extracted free functions read/write it through this alias so the
 * implicit cross-method contracts stay on one object.
 */
import type { ConversationLoop as LoopContext } from "../conversation-loop.js";
import type { GuidanceInjectionSource, TurnCallbacks, TurnDecisionEvent, TurnInputRequired, TurnStopReason, ToolScope } from "./types.js";
import type { GenericMessage, LLMProvider, LLMVendor, MessageMeta, TokenUsage, TokenUsageByModel, ToolCallBlock, ToolSchema } from "../llm/types.js";
import type { ChatInputOrigin, RemoteControllerAuthority } from "../../shared/chat-origin.js";
import type { PermissionReviewEvent } from "../../shared/permission-review-status.js";
import type { ToolTrustOrigin } from "../../tools/types.js";
import type { RequestAnchor } from "../../tools/pipeline/rationale-control.js";
import {
  createCancelledSiblingProposalGuard,
  FOREGROUND_RATIONALE_PRODUCTION_ENABLED,
  isForegroundRationaleOrchestrationEnabled,
} from "../../tools/pipeline/rationale-control.js";
import {
  executeRationaleAwareConversationBatch,
  prepareRationaleConversationRuntime,
  RATIONALE_SIBLING_REPLAY_BLOCKED_RESULT,
  RATIONALE_TRIGGER_FAILED_RESULT,
} from "./rationale-conversation-orchestration.js";
import type { ActiveRolePrompt } from "../../data/role-presets.js";
import type {
  ConversationExecuteOptions,
  InterceptedMetaToolHandler,
  ToolCallMeta,
  ToolResult,
  ToolUseBlock,
} from "../../tools/executor.js";
import { TOOL_SEARCH_TOOL_NAME } from "../../tools/registry.js";
import { collectActiveRuntimeRoundStream } from "./stream-collector.js";
import { FallbackProvider } from "../llm/vercel/fallback-chain.js";
import { vendorSupportsLengthContinuation } from "../llm/vendor-capabilities.js";
import { rejectedToolNameFromError, withoutDroppedTools } from "../llm/rejected-tool-schema.js";
import { nextToolTrustOrigin, rationaleProvenanceFor } from "./trust-origin.js";
import { contextBudgetForCurrentRuntime } from "./compaction.js";
import { markStaleToolResults, evictAgedToolResultImages, isContextLengthError } from "../auto-compact.js";
import { stripSuggestedReplies } from "../suggested-replies.js";
import { GUIDE_JOINED_MAX_CHARS, mergeGuidanceApprovalReasonPrefixes } from "./guidance-limits.js";
import { parseStagedEnvelope } from "../../shared/staged-origins.js";
import { t } from "../../i18n/index.js";
import { createLogger } from "../../lib/logger.js";
import { MAX_TOOL_CALLS_PER_ROUND } from "../../shared/subagent-policy.js";
import { activeLlmRouteModel, getLlmVendorSettings } from "../../shared/llm-vendor-defaults.js";
import { isA2AQuestionInputRequiredControl } from "../../tools/agent-send.js";
import {
  isA2AAgentCausalContext,
  mergeA2AAgentCausalContexts,
  type A2AAgentCausalContext,
} from "../a2a-agent-message-envelope.js";
import { createSubscriptionUsageCollector, recordSubscriptionRoundTelemetry } from "./subscription-usage-telemetry.js";
import { errorMessage } from "../../shared/error-message.js";

const log = createLogger("lvis");
// No caller-assigned `maxRounds` = PARENT session: unbounded — a turn ends
// at natural end_turn or user interrupt. Child loops always get a budget.
const PARENT_UNLIMITED_ROUNDS = Number.MAX_SAFE_INTEGER;
/**
 * Hard cap on finish_reason=length CONTINUATIONS per logical assistant answer.
 * Published provider guidance converges on 2–3. AND-ed with: (a) a
 * zero-progress break (a round adding no text AND no reasoning ends the chain),
 * (b) the caller-assigned round budget, and (c) the per-iteration `round < 30`
 * for-bound. Any one tripping stops the chain — defense against a model that
 * always returns "max_tokens".
 */
const MAX_LENGTH_CONTINUATIONS = 3;
/**
 * Hard cap on reasoning-only re-prompts per turn. A round that ends `end_turn`
 * with reasoning but no answer text and no tool call has not finished the turn:
 * the reasoning names the next action the model meant to take, so returning
 * there gives up before the model did. Two: the first re-prompt covers a model
 * that narrated its next action and simply failed to emit it, the second covers
 * one that answers the re-prompt with more reasoning. Past that the model is
 * looping, and every attempt spends a round out of the same budget the real
 * work needs. AND-ed with the caller-assigned round budget — either one
 * tripping ends the turn exactly the way it ends without this branch.
 */
const MAX_REASONING_ONLY_NUDGES = 2;
/**
 * How much of an answer-less round's reasoning the next round replays as that
 * round's assistant text.
 *
 * The replay is what puts the reasoning in front of the model at all: `thought`
 * is mapped to no wire part on any vendor, and a row holding it with neither
 * text nor tool calls is dropped whole rather than sent as an empty assistant
 * turn. Dropping it also collapses the rows either side into two consecutive
 * user turns, which a chat template that asserts role alternation rejects.
 *
 * The TAIL is the part that matters — a reasoning block ends on the action it
 * decided, and the earlier text is the deliberation that led there. 2,000
 * characters is roughly the last few paragraphs: enough to carry the decision
 * and its immediate justification, small enough that a runaway reasoning block
 * cannot push the round over the context budget it just came back under.
 */
const MAX_NUDGE_REASONING_CHARS = 2_000;
/**
 * Defensive cap on provider-as-oracle tool drops per turn. Termination is
 * already guaranteed structurally (each drop strictly shrinks the finite tool
 * set and we only drop a tool the provider named AND that is still present),
 * so this is belt-and-suspenders against pathological churn: if more than this
 * many distinct tools each 400 in one turn, stop dropping and let the error
 * surface normally rather than burning rounds.
 */
const MAX_TOOL_SCHEMA_DROPS_PER_TURN = 5;
/**
 * Vendors already reported as running chat rounds with no output ceiling.
 *
 * An uncapped round can generate until the provider's own maximum, which costs
 * the whole turn's time on one call. The host declines to guess a per-model
 * ceiling, so the only honest reaction is to say the ceiling is absent — once
 * per vendor per process, because it is a configuration fact, not a per-round
 * event, and repeating it per round would bury the runs that matter.
 */
const uncappedChatVendorsLogged = new Set<LLMVendor>();

function noteUncappedChatVendor(vendor: LLMVendor): void {
  if (uncappedChatVendorsLogged.has(vendor)) return;
  uncappedChatVendorsLogged.add(vendor);
  log.info(
    `queryLoop: vendor "${vendor}" has no llm.vendors.${vendor}.outputTokenLimit — chat rounds run at the provider's own output maximum`,
  );
}
/**
 * Tool errors that have to pile up since the last progress notification before
 * one fires ahead of the round cadence. Below this a couple of recoverable
 * failures inside an otherwise healthy turn would trigger a notification the
 * model has no use for.
 */
const PROGRESS_NUDGE_TOOL_ERROR_THRESHOLD = 3;
/**
 * C3(a): per-round cap on the number of tool calls an assistant round can
 * issue. Pathological round-emitting many tool_use blocks at once would
 * otherwise execute every one before the maxRounds guard could intervene.
 * Since `agent_spawn` is a tool call, this is also the model-facing sub-agent
 * fan-out limit: at most MAX_TOOL_CALLS_PER_ROUND sub-agents can be requested
 * in one assistant round.
 * SubAgentRunner also relies on this cap to keep a sub-agent's total tool
 * execution count bounded by `maxRounds * MAX_TOOL_CALLS_PER_ROUND`.
 */
// Intra-turn tool-result stubbing — deep tool loops (e.g. indexer turns of
// 11~19 rounds) otherwise resend the full accumulated tool_result history on
// every round, blowing past the model's per-minute token budget. Between
// rounds we mark older tool_results stale (memory stays verbatim; the wire
// serializer stubs them on the next send), keeping the current + previous
// round's results intact so chained tool calls can still reference recent
// output. The window is count-based to match the markStaleToolResults
// contract: 2 rounds worth of results (current + previous).
const INTRA_TURN_PRESERVE_RECENT_RESULTS = 2 * MAX_TOOL_CALLS_PER_ROUND;
// Only micro-compact between rounds once the projected per-round input is
// already large enough to matter — half the model's preflight threshold —
// so short turns don't pay the mark overhead.
const MICRO_COMPACT_FLOOR_FACTOR = 0.5;
// How much a turn's projected request has to grow, as a fraction of the
// preflight threshold, before the round-loop gate may repeat a compaction that
// a previous attempt in the same turn already failed to deliver. Real
// compaction is an LLM call; without this a turn whose history cannot be
// reduced any further would spend one on every remaining round.
//
// A quarter of the threshold is the same order as the preserve window a
// compaction protects (`preserveRecentTokens` is 0.2–0.4 × preflight), so an
// attempt only repeats once enough new content exists for a boundary to have
// something new to cut.
const ROUND_COMPACT_REARM_GROWTH_FACTOR = 0.25;

export async function queryLoop(
  self: LoopContext,
    initialSystemPrompt: string,
    scope: ToolScope,
    callbacks: TurnCallbacks | undefined,
    abortSignal: AbortSignal | undefined,
    overlayTriggerOrigin: string | null,
    bounds: {
      maxRounds?: number;
      sessionIdOverride?: string;
      spawnDepth?: number;
      approvalReasonPrefix?: string;
      remoteControllerAuthority?: import("../../shared/chat-origin.js").RemoteControllerAuthority;
      a2aCausalContext?: A2AAgentCausalContext;
      inputOrigin: ChatInputOrigin;
      toolTrustOrigin: ToolTrustOrigin;
      requestAnchor?: RequestAnchor;
      permissionUserIntent?: string;
      rolePrompt?: ActiveRolePrompt;
      onMemoryCaptureTaint?: (reason: "staged-guidance") => void;
      memoryQuery?: string;
    },
  ): Promise<{
    text: string;
    toolCalls: Array<{ name: string; input: Record<string, unknown>; result: string }>;
    usage?: TokenUsage;
    stopReason?: TurnStopReason;
    inputRequired?: TurnInputRequired;
    usageByModel: TokenUsageByModel[];
    subscriptionUsage: ReturnType<typeof createSubscriptionUsageCollector>["values"];
    vendorProvider?: LLMVendor;
    vendorModel?: string;
    finalToolSchemas: ToolSchema[];
    promotedToolNames: string[];
  }> {
    const llmSettings = self.deps.settingsService.get("llm");
    const activeBlock = getLlmVendorSettings(
      llmSettings.vendors,
      llmSettings.provider,
    );
    const activeModel = activeLlmRouteModel(llmSettings);
    const subscriptionRuntime = self.provider?.subscriptionRuntime;
    // Subscription transports have no host-verifiable API-key billing identity.
    // A future runtime must add an explicit subscription telemetry contract
    // before its usage can cross this engine boundary.
    const subscriptionUsageIsOpaque = subscriptionRuntime !== undefined;
    const runtimeContextBudget = contextBudgetForCurrentRuntime(self);
    const model = subscriptionRuntime ? subscriptionRuntime.model ?? "default" : activeModel;
    // Login-backed runtimes own their own reasoning policy. Never project the
    // inactive API vendor's toggle/budget into a subscription prompt.
    const roundLlmSettings = subscriptionRuntime
      ? { streamSmoothing: llmSettings.streamSmoothing, enableThinking: false }
      : { ...activeBlock, streamSmoothing: llmSettings.streamSmoothing };
    if (subscriptionRuntime === undefined && activeBlock.outputTokenLimit === undefined) {
      noteUncappedChatVendor(llmSettings.provider);
    }
    // Subscription transports receive an ordinary serialized prompt for every
    // LVIS round. Until a runtime exposes and proves a native assistant-prefill
    // continuation protocol, a max_tokens response must remain a partial
    // response rather than being host-stitched as if that prompt were a prefill.
    const supportsLengthContinuation = subscriptionRuntime === undefined
      && vendorSupportsLengthContinuation(llmSettings.provider);
    let systemPrompt = initialSystemPrompt;
    let activeApprovalReasonPrefix = bounds.approvalReasonPrefix;
    let servingVendorProvider: LLMVendor | undefined = subscriptionUsageIsOpaque
      ? undefined
      : llmSettings.provider;
    let servingVendorModel: string | undefined = subscriptionUsageIsOpaque
      ? undefined
      : model;
    const usageByModel: TokenUsageByModel[] = [];
    const subscriptionUsage = createSubscriptionUsageCollector();
    // Report a branch the loop just took. Reporting can never change what the
    // loop does, so a listener that throws is swallowed here rather than
    // failing a turn that had already decided.
    const decide = (event: TurnDecisionEvent): void => {
      try {
        callbacks?.onDecision?.(event);
      } catch {
        // Observation must not break the turn it observes.
      }
    };
    // Provider-as-oracle: tools the provider 400'd on (invalid_function_parameters)
    // and we dropped this turn. Turn-scoped — resets naturally each queryLoop call.
    const droppedToolSchemaNames = new Set<string>();
    // Same-anchor replay protection for siblings cancelled by a rationale batch.
    // The digest is host-only and resets with this queryLoop invocation.
    const cancelledSiblingProposalDigests = new Set<string>();
    let cancelledSiblingProposalGuardIncomplete = false;
    // Option C: scope is mutable within the turn. Mutating the caller's Set
    // directly means the next turn's fallback sees every plugin that was
    // activated here. Route EVERY turn rebuild through this so already-dropped
    // tools stay excluded — a mid-turn rebuild (request_plugin / tool_search)
    // must not reintroduce a tool the provider already rejected and re-break
    // the turn.
    const rebuildTurnToolSchemas = (): ToolSchema[] => withoutDroppedTools(self.rebuildToolSchemas(scope), droppedToolSchemaNames);
    let toolSchemas: ToolSchema[] = rebuildTurnToolSchemas();
    const withServingIdentity = (
      result: {
        text: string;
        toolCalls: Array<{ name: string; input: Record<string, unknown>; result: string }>;
        usage?: TokenUsage;
        stopReason?: TurnStopReason;
        inputRequired?: TurnInputRequired;
      },
    ) => ({
      ...result,
      usageByModel: [...usageByModel],
      subscriptionUsage: subscriptionUsage.values,
      ...(servingVendorProvider !== undefined && servingVendorModel !== undefined
        ? {
            vendorProvider: servingVendorProvider,
            vendorModel: servingVendorModel,
          }
        : {}),
      finalToolSchemas: [...toolSchemas],
      promotedToolNames: [...new Set(promotedToolNamesForTurn)],
    });
    const turnProvider = self.provider instanceof FallbackProvider
      ? self.provider.withCallbacks({
        onFallback: callbacks?.onFallback,
        onStatus: (status) => {
          if (
            !subscriptionUsageIsOpaque &&
            (status.phase === "attempt" || status.phase === "retry") &&
            status.provider &&
            status.model
          ) {
            servingVendorProvider = status.provider;
            servingVendorModel = status.model;
          }
          callbacks?.onLlmStatus?.(status);
        },
      })
      : self.provider!;
    const allToolCalls: Array<{ name: string; input: Record<string, unknown>; result: string }> = [];
    const toolMetaByUseId = new Map<string, ToolCallMeta>();
    // Last review event per tool call — the verdict the user saw live, stamped
    // onto the tool_result so reload rebuilds the same row.
    const permissionReviewByUseId = new Map<string, PermissionReviewEvent>();
    let turnUsage: TokenUsage | undefined;
    const recordProviderUsage = (
      usage: TokenUsage,
      updateContextCalibration: boolean,
    ): void => {
      if (subscriptionUsageIsOpaque) {
        return;
      }
      const cacheRead = usage.cacheReadTokens ?? 0;
      const cacheWrite = usage.cacheWriteTokens ?? 0;
      const adjustedInput = Math.max(
        0,
        usage.inputTokens - cacheRead - cacheWrite,
      );

      if (updateContextCalibration) {
        self.lastRoundProviderInputTokens = usage.inputTokens;
        self.lastContextInputTokens = usage.inputTokens;
        self.lastContextInputProjectionTokens =
          self.lastRoundInputProjection?.totalTokens ?? 0;
      }

      turnUsage = {
        inputTokens: (turnUsage?.inputTokens ?? 0) + usage.inputTokens,
        outputTokens: (turnUsage?.outputTokens ?? 0) + usage.outputTokens,
        cacheReadTokens: (turnUsage?.cacheReadTokens ?? 0) + cacheRead,
        cacheWriteTokens: (turnUsage?.cacheWriteTokens ?? 0) + cacheWrite,
      };
      appendUsageForServingModel(
        usageByModel,
        servingVendorProvider,
        servingVendorModel,
        {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadTokens: cacheRead,
          cacheWriteTokens: cacheWrite,
        },
      );
      self.cumulativeUsage.inputTokens += adjustedInput;
      self.cumulativeUsage.outputTokens += usage.outputTokens;
      self.cumulativeUsage.cacheReadTokens =
        (self.cumulativeUsage.cacheReadTokens ?? 0) + cacheRead;
      self.cumulativeUsage.cacheWriteTokens =
        (self.cumulativeUsage.cacheWriteTokens ?? 0) + cacheWrite;
    };
    let pluginExpansions = 0;
    // Tool-Level Deferral — per-turn tool_search counter (mirror pluginExpansions).
    let toolSearches = 0;
    const promotedToolNamesForTurn: string[] = [];
    let roundIndex = 0;
    let toolTrustOrigin = bounds.toolTrustOrigin;
    // The turn's STAGED origin (`overlay:*` / `app:*`), which forces write/shell/network
    // tools to ask. It is a `let` because an MCP App can inject text mid-turn through
    // the guidance queue: from that round on, the turn is no longer purely the user's,
    // so the rest of it runs under the app's origin (see the drain site below). It only
    // ever tightens — a staged origin is never cleared.
    let stagedOrigin = overlayTriggerOrigin;
    // Single source for the session key used by on-demand plugin activation.
    // This MUST equal the value wrapped in `sessionContext.run({ sessionId })`
    // at the runTurn call site (i.e. `options.sessionIdOverride ?? self.sessionId`,
    // exposed here as `bounds.sessionIdOverride ?? self.sessionId`). Gate 4
    // (plugin-runtime-delegate) reads the activation set via
    // `sessionContext.getStore()?.sessionId`, so the WRITE
    // (`setSessionActivated`) and the CLEAR must key on the SAME id — otherwise
    // a caller passing BOTH `allowedPluginIds` AND a `sessionIdOverride` would
    // write under one id and the delegate would read another, silently refusing
    // the activated tool. Today these coincide, but keying on one source removes
    // the future-coincidence dependency.
    const effectiveSessionId = bounds.sessionIdOverride ?? self.sessionId;
    let activeA2ACausalContext =
      isA2AAgentCausalContext(bounds.a2aCausalContext)
      && bounds.a2aCausalContext.recipientChildSessionId === effectiveSessionId
        ? bounds.a2aCausalContext
        : undefined;
    if (activeA2ACausalContext) toolTrustOrigin = "agent-message";

    // C3(a): assistant-round counter — used by the maxRounds break below.
    let assistantRoundsRun = 0;
    // Progress-notification bookkeeping. These three numbers are the only thing
    // the model is told about its own budget, so they are counted here rather
    // than derived from history: history is compacted mid-turn and a compacted
    // prefix would make a long turn look like a short one.
    const turnStartedAtMs = Date.now();
    let toolErrorsRun = 0;
    let toolErrorsAtLastProgressNudge = 0;
    // The assistant-round index the last notification was sent at. `roundIndex`
    // is HELD across a continuation chain and across a schema-drop retry, so
    // without this the same index would arm again on the next iteration and
    // send twice for one assistant round.
    let roundIndexAtLastProgressNudge = -1;
    // Cadence in assistant rounds; `0` disables the notification entirely.
    const progressNudgeRounds =
      self.deps.settingsService.get("chat").progressNudgeRounds;
    // Round-loop compaction re-arm. The projection this turn must exceed
    // before the round-loop preflight gate may attempt another compaction.
    // Zero means armed: the next crossing of the threshold fires. See the gate
    // itself for why a failed attempt raises it and a successful one clears it.
    let roundCompactArmedAbove = 0;
    const roundCompactRearmGrowth = Math.max(
      1_000,
      Math.floor(runtimeContextBudget.preflight * ROUND_COMPACT_REARM_GROWTH_FACTOR),
    );
    // finish_reason=length CONTINUATION carry. While a logical answer is being
    // continued across rounds we accumulate its raw text + reasoning here and
    // DEFER the history append + onAssistantRound until the chain terminates —
    // so the user sees ONE coherent answer and history holds ONE assistant
    // message. `continuationPrefillText !== undefined` ⇒ next round continues.
    let continuationsRun = 0;
    let continuationCarryText = "";
    let continuationCarryThought = "";
    let continuationPrefillText: string | undefined = undefined;
    // Reasoning-only re-prompt state. `reasoningNudgePending` arms exactly one
    // re-prompt for the NEXT round (see MAX_REASONING_ONLY_NUDGES); the round
    // assembly consumes it and spends `reasoningNudgesRun`, the per-turn tally
    // against the cap. The reasoning itself needs no carrying — the assembly
    // replays it off the committed row.
    let reasoningNudgesRun = 0;
    let reasoningNudgePending = false;
    // C3(a): effective round budget. A host-assigned `maxRounds` (the sub-agent
    // runner, carrying the user's configured budget) is HONOURED exactly, above
    // the default too; narrowing it only shows up as an agent stopped mid-task.
    const requestedMaxRounds = bounds?.maxRounds;
    const effectiveMaxRounds =
      typeof requestedMaxRounds === "number" && Number.isFinite(requestedMaxRounds) && requestedMaxRounds > 0
        ? Math.floor(requestedMaxRounds)
        : PARENT_UNLIMITED_ROUNDS;

    type PendingGuidanceDelivery = {
      entries: Array<(typeof self.guidanceQueue)[number]>;
      joined: string;
      historyMessage: ReturnType<typeof self.history.append> | null;
      round: number;
      subAgentSource: GuidanceInjectionSource | undefined;
    };
    let pendingGuidanceDelivery: PendingGuidanceDelivery | null = null;

    const rollbackPendingGuidance = (): void => {
      const delivery = pendingGuidanceDelivery;
      if (!delivery) return;
      pendingGuidanceDelivery = null;
      const injectionId = delivery.historyMessage?.meta?.hostInjectionId;
      if (injectionId !== undefined) {
        // NOT removeExact: a compaction between the append and this rollback
        // replaces message object identities, and a row that survives rollback
        // while its entry goes back on the queue is delivered twice.
        self.history.removeByHostInjectionId(injectionId);
      }
      // Return the drained entries to the turn queue. runTurn's outer finally
      // clears the active controller first, then atomically drops this queue via
      // dropPendingGuidance so producer and renderer dispositions fire once.
      self.guidanceQueue = [...delivery.entries, ...self.guidanceQueue];
    };

    const commitPendingGuidance = async (): Promise<void> => {
      const delivery = pendingGuidanceDelivery;
      if (!delivery) return;
      pendingGuidanceDelivery = null;
      await Promise.allSettled(
        delivery.entries.map((entry) =>
          Promise.resolve().then(() => entry.onInjected?.())),
      );
      // The row is appended before the round whose completion commits this
      // delivery, so a committed batch without one is a broken invariant —
      // surfacing it is the only way it ever gets fixed.
      const committedRow = delivery.historyMessage;
      if (committedRow === null) {
        throw new Error("[guidance] committed a guidance batch that never reached history");
      }
      try {
        callbacks?.onGuidanceInjected?.(delivery.joined, {
          messageId: committedRow.meta.messageId,
          ...(delivery.subAgentSource ? { source: delivery.subAgentSource } : {}),
        });
      } catch {
        // Renderer notification failure must not invalidate a committed round.
      }
      self.tracer.step("GUIDANCE_INJECTED", {
        round: delivery.round,
        len: delivery.joined.length,
      });
    };
    const loopRoundBound = effectiveMaxRounds;
    try {
    for (let round = 0; round < loopRoundBound; round++) {
      // Whether the guidance-injection guard already evaluated the preflight
      // for THIS round. Reset per round, read by the round-loop gate below so
      // one round never runs two compactions.
      let preflightRanThisRound = false;
      // C3(a): hard guard between rounds — if we have already executed
      // `effectiveMaxRounds` assistant turns, stop cleanly and return the
      // last text. This is the loop-boundary defense for agent_spawn
      // turn caps; abortCurrentTurn remains the user-cancel path.
      if (assistantRoundsRun >= effectiveMaxRounds) {
        log.warn(
          `queryLoop: EARLY-EXIT(round-cap) — assistantRoundsRun=${assistantRoundsRun} effectiveMaxRounds=${effectiveMaxRounds} totalToolCalls=${allToolCalls.length}`,
        );
        decide({
          kind: "early_exit",
          branch: "round-cap",
          data: {
            assistantRoundsRun,
            effectiveMaxRounds,
            toolCalls: allToolCalls.length,
          },
        });
        callbacks?.onError?.(
          t("be_conversationLoop.roundCapError", { max: effectiveMaxRounds }),
        );
        // stopReason "round-cap" flags a BUDGET-hit termination, not a natural
        // end_turn: the runner marks the result `incomplete` and the renderer
        // shows "cut off, can continue". `resolveRoundCapText` picks the text.
        const finalized = await finalizeAfterRoundCap({
          provider: turnProvider, model, systemPrompt,
          messages: self.history.getMessages(),
          ...(abortSignal ? { abortSignal } : {}),
        });
        turnUsage = mergeFinalizeUsage(turnUsage, finalized);
        return withServingIdentity({
          text: resolveRoundCapText(
            finalized,
            self.history.getMessages(),
            t("be_conversationLoop.roundCapError", { max: effectiveMaxRounds }),
          ),
          toolCalls: allToolCalls,
          usage: turnUsage,
          stopReason: "round-cap",
        });
      }
      // Round-boundary guidance inject — drain any "guide" utterances
      // queued via `ConversationLoop.queueGuidance` while the previous
      // round was running. Only fires when `round > 0` so the user's
      // initial turn input is never preempted by a stale queue (round 0
      // is the user's original prompt; queue is empty there because
      // `queueGuidance` requires `currentAbortController !== null`, which
      // is set just before the queryLoop starts but a fresh runTurn
      // always starts with the queue drained on the prior turn's finally).
      //
      // Race ordering (critic MAJOR #2): both `queueGuidance` (from IPC
      // handler thread) and this drain run on Node's single-threaded
      // event loop. `queryLoop` awaits between rounds inside
      // `collectRoundStream`, giving the IPC handler an injection point.
      // The atomic `currentAbortController` check inside `queueGuidance`
      // closes the only true race.
      // Do not interrupt an in-flight length-continuation with queued guidance:
      // it would push a user message after the assistant prefill and break the
      // continue_final_message "last message is assistant" precondition.
      if (
        round > 0
        && pendingGuidanceDelivery === null
        && self.guidanceQueue.length > 0
        && continuationPrefillText === undefined
      ) {
        // Guidance that arrives mid-turn from a NON-USER actor is not the user's own
        // mid-stream guide: it carries a provenance envelope, which is the mechanism
        // the whole feature reads. The moment such text enters this turn, the REST of
        // the turn runs under that staged origin — the permission manager then forces
        // every write/shell/network tool to ask, and tool provenance is recorded as
        // the actor's rather than the user's. Checked on the WHOLE queue before
        // head-truncation can drop an entry.
        //
        // Table-driven (shared/staged-origins.ts). This site used to recognize only
        // `<app-message>`: any other staged kind reaching the queue would leave the
        // rest of the turn running with the force-ask gate OFF and the user recorded
        // as the author — a fail-open that a hand-written check cannot be trusted to
        // avoid for the next origin.
        const stagedGuidance = self.guidanceQueue
          .map((entry) => parseStagedEnvelope(entry.text))
          .find((parsed) => parsed !== null);
        if (stagedGuidance) {
          bounds.onMemoryCaptureTaint?.("staged-guidance");
          stagedOrigin = stagedGuidance.source;
          toolTrustOrigin = stagedGuidance.kind.inputOrigin;
        }
        // Head-truncated to GUIDE_JOINED_MAX_CHARS with a marker — see
        // `truncateGuidanceBatch`, which owns the bound and the marker.
        const { kept, dropped, joined } = truncateGuidanceBatch(self.guidanceQueue);
        activeApprovalReasonPrefix = mergeGuidanceApprovalReasonPrefixes(
          activeApprovalReasonPrefix,
          kept.map((entry) => entry.approvalReasonPrefix),
        );
        self.guidanceQueue = [];
        const queuedCausalContexts = kept
          .map((entry) => entry.a2aCausalContext)
          .filter((context): context is A2AAgentCausalContext => context !== undefined);
        if (queuedCausalContexts.length > 0) {
          const mergedCausalContext = mergeA2AAgentCausalContexts(
            effectiveSessionId,
            [
              ...(activeA2ACausalContext ? [activeA2ACausalContext] : []),
              ...queuedCausalContexts,
            ],
          );
          if (mergedCausalContext) {
            activeA2ACausalContext = mergedCausalContext;
            toolTrustOrigin = "agent-message";
          }
        }

        if (dropped.length > 0) {
          await Promise.allSettled(
            dropped.map((entry) =>
              Promise.resolve().then(() => entry.onDropped?.("joined-limit"))),
          );
        }
        const injectedContent = t("be_conversationLoop.guidanceInjectionHeader", { joined });
        const subAgentSource = subAgentSourceForBatch(kept);
        const delivery: PendingGuidanceDelivery = {
          entries: kept,
          joined,
          historyMessage: null,
          round,
          subAgentSource,
        };
        pendingGuidanceDelivery = delivery;
        // Critic round 2 M1: run preflight BEFORE appending the guide so
        // compaction targets the older history and never accidentally
        // summarizes-away the just-injected guide marker. `joined` is
        // capped at GUIDE_MAX_ENTRIES × GUIDE_MAX_CHARS = 128KB chars
        // (≈ 30K tokens worst case) but typical use is < 1K tokens —
        // well below the post-compact preserveRecent budget, so the
        // next round's prompt-assembly will fit.
        if (self.provider && !self.deps.disableSessionPersistence) {
          preflightRanThisRound = true;
          const compacted = await self.runPreflightGuard(
            {
              systemPrompt,
              toolSchemas,
              estimateCurrent: () => self.estimateCurrentRequestProjection({
                systemPrompt: self.buildSystemPromptForScope(
                  scope,
                  stagedOrigin,
                  bounds.rolePrompt,
                  bounds.sessionIdOverride ?? self.sessionId,
                  bounds.memoryQuery,
                ),
                toolSchemas,
              }),
            },
            abortSignal,
            callbacks,
          );
          if (compacted) {
            systemPrompt = self.buildSystemPromptForScope(
              scope,
              stagedOrigin,
              bounds.rolePrompt,
              bounds.sessionIdOverride ?? self.sessionId,
              bounds.memoryQuery,
            );
          }
        }
        const historyMessage = self.history.append({
          role: "user",
          content: injectedContent,
          // Always marked host-minted, like the start-of-turn injection: a
          // batch mixing the user's guide with a child's report is deliberately
          // NOT attributed to the child, so without this stamp the row reads as
          // one the user typed — and readers that decide what the USER said
          // (tier-2 parent-context evidence first) would quote the child's
          // prose as its parent's. The sub-agent meta below is display
          // provenance, so a reload rebuilds the same box.
          meta: {
            hostInjectionId: randomUUID(),
            // The stored content is the injection envelope, which is
            // prompt-bearing but is not what the bubble shows. Recording the
            // bare guide text keeps a reloaded transcript — and anything that
            // hands a row's text back to the user, like restoring it into the
            // composer — showing the same words the live bubble did.
            displayText: joined,
            ...(subAgentHistoryMeta(subAgentSource).meta ?? {}),
          },
        });
        delivery.historyMessage = historyMessage;
      }

      // ─── Progress notification ──────────────────────────────────────────
      // A long turn has no notion of its own budget: nothing in the transcript
      // tells the model how many rounds it has spent, how long it has run, or
      // how many of its tool calls failed. Runs that stop converging therefore
      // keep announcing a next step until an external deadline cuts them off
      // mid tool-call, and runs that are finished declare completion without
      // ever executing the check that would prove it. This is the only thing in
      // the turn that supplies those numbers and asks for either a real
      // verification or a change of approach.
      //
      // It never enters history. The numbers are true only for the round they
      // are sent in, so a persisted row would replay a stale round count into
      // every later turn, draw as a user bubble on reload, and survive
      // compaction as if the user had typed it.
      //
      // The cadence counts `roundIndex`, not the for-loop index: the loop
      // iterates for schema-drop retries and length continuations too, and
      // neither is an assistant round. Counting iterations would make the
      // interval shorter than the setting says and report a number the model
      // cannot reconcile with its own transcript.
      //
      // Nothing is due on a length-continuation round, and no deferral is
      // needed to say so. Both inputs to the question below are FROZEN across a
      // continuation chain: `roundIndex` is deliberately not incremented for a
      // continuation, and a continuation round carries no tool calls (that is
      // the gate it is chosen under), so `toolErrorsRun` cannot move either.
      // `roundIndex` also only ever advances on an iteration that did NOT
      // continue, so the first iteration at any new index has no prefill
      // pending. A notification therefore always falls due on an ordinary
      // round — and `assembleRoundMessages` returns before the append on a
      // continuation anyway, so no separate check is carried here.
      //
      // Decided here and spent just below, next to the re-prompt; the text it
      // produces is what assembleRoundMessages appends, so a recorded
      // notification always corresponds to one the model was actually handed.
      const progressNudgeBranch: "cadence" | "tool-errors" | null =
        progressNudgeRounds === 0
          ? null
          : roundIndex > 0
            && roundIndex % progressNudgeRounds === 0
            && roundIndex !== roundIndexAtLastProgressNudge
            ? "cadence"
            : toolErrorsRun - toolErrorsAtLastProgressNudge >= PROGRESS_NUDGE_TOOL_ERROR_THRESHOLD
              ? "tool-errors"
              : null;

      const repaired = self.history.repairToolPairInvariant();
      if (repaired.removedMessages > 0 || repaired.removedToolCalls > 0) {
        log.warn(
          `queryLoop: repaired invalid tool history before provider call (removedMessages=${repaired.removedMessages}, removedToolCalls=${repaired.removedToolCalls})`,
        );
      }

      // ─── Stream attempt — token preflight 가 사전 압축 처리하므로 mid-loop retry 없음 ───
      // Rows appended for THIS round only. None of them is persisted: history
      // holds what the conversation said, and a host row committed there would
      // replay on every later turn as if the user had typed it.
      //
      // The appended USER text is assembled into ONE row. A second consecutive
      // user row is what a chat template that asserts role alternation rejects,
      // so every host instruction for a round shares the single row rather than
      // adding its own.
      //
      // Both host instructions for the round are spent HERE, once, rather than
      // inside the assembly below: the round-loop preflight re-assembles the
      // round against the history a compaction rewrote, and state consumed
      // inside assembly would be consumed by the assembly that was only
      // measured — leaving the round the model actually receives without the
      // instruction, its cap already charged and its decision already recorded.
      // Both conditions are the ones the assembly appends under, so a spend
      // still cannot stand for an instruction the model was never sent.
      let nudgeTextForRound: string | undefined;
      if (continuationPrefillText === undefined && reasoningNudgePending) {
        reasoningNudgePending = false;
        reasoningNudgesRun += 1;
        nudgeTextForRound = t("be_conversationLoop.reasoningOnlyContinuePrompt");
      }
      let progressNudgeText: string | undefined;
      if (continuationPrefillText === undefined && progressNudgeBranch !== null) {
        const elapsedSeconds = Math.round((Date.now() - turnStartedAtMs) / 1000);
        progressNudgeText = t("be_conversationLoop.progressNudge", {
          round: roundIndex,
          elapsedSeconds,
          toolCalls: allToolCalls.length,
          toolErrors: toolErrorsRun,
        });
        decide({
          kind: "progress.nudge",
          branch: progressNudgeBranch,
          data: {
            round: roundIndex,
            elapsedSeconds,
            toolCalls: allToolCalls.length,
            toolErrors: toolErrorsRun,
          },
        });
        toolErrorsAtLastProgressNudge = toolErrorsRun;
        roundIndexAtLastProgressNudge = roundIndex;
      }
      // Pure over the history handed in, so the gate below can rebuild the same
      // round from the compacted history without re-deciding anything.
      const assembleRoundMessages = (
        base: GenericMessage[],
      ): GenericMessage[] => {
        // finish_reason=length CONTINUATION: a WIRE-ONLY partial assistant turn
        // as the final message. The openai-compatible adapter pairs this with
        // continue_final_message so vLLM resumes it verbatim. For mid-<think>
        // truncation the prefill text is `<think>\n…` (open, no closing tag) so
        // the model finishes reasoning before answering; add_generation_prompt:
        // false blocks a 2nd auto <think>. It IS the last row by contract, so it
        // never shares the round with an appended instruction.
        if (continuationPrefillText !== undefined) {
          return [
            ...base,
            { role: "assistant" as const, content: continuationPrefillText },
          ];
        }
        const rows: GenericMessage[] = [...base];
        // A round whose whole answer went into reasoning leaves an assistant row
        // with no text and no tool calls. `thought` is mapped to no wire part on
        // any vendor, so the adapter drops that row entirely — the model loses
        // the reasoning, AND the rows either side of it collapse into two
        // consecutive user turns. Replay the reasoning as the row's text on the
        // wire: the model sees what it worked out, and alternation holds for
        // whatever follows, the re-prompt below or a delivered guide alike.
        // Bounded because a reasoning block ends on the action it decided.
        for (let i = rows.length - 1; i >= 0; i--) {
          const row = rows[i]!;
          if (row.role !== "assistant") continue;
          const thought = row.thought ?? "";
          if (
            row.content.trim().length === 0 &&
            (row.toolCalls?.length ?? 0) === 0 &&
            thought.trim().length > 0
          ) {
            rows[i] = {
              role: "assistant",
              content: thought.slice(-MAX_NUDGE_REASONING_CHARS),
            };
          }
          break;
        }
        const appendedUserText: string[] = [];
        if (nudgeTextForRound !== undefined) appendedUserText.push(nudgeTextForRound);
        // After the re-prompt: that one says what to do with THIS round, the
        // notification says what the turn has spent so far.
        if (progressNudgeText !== undefined) appendedUserText.push(progressNudgeText);
        if (appendedUserText.length === 0) return rows;
        return [
          ...rows,
          { role: "user" as const, content: appendedUserText.join("\n\n") },
        ];
      };
      const projectRound = (messages: GenericMessage[]) => self.projectProviderRequestInput({
        systemPrompt, messages, toolSchemas,
        continuationPrefill: continuationPrefillText !== undefined,
        enableThinking: roundLlmSettings.enableThinking,
        thinkingBudgetTokens: subscriptionRuntime ? undefined : activeBlock.thinkingBudgetTokens,
      });
      let messagesForRound = assembleRoundMessages(self.history.getMessages());
      self.lastRoundInputProjection = projectRound(messagesForRound);

      // ─── Round-loop token preflight ───
      // The turn-start guard (run-turn.ts) used to be the only place a turn's
      // context was ever measured against the threshold. An agent turn appends
      // its own tool results for as many rounds as it runs, so it could cross
      // the threshold at round 3 and stay over for every round after it —
      // this round's projection was computed and then never compared.
      //
      // This is the same condition and the same compaction, evaluated against
      // the request that is about to go out. It reuses the projection the
      // round already computed, so a turn that stays under the threshold pays
      // nothing for the gate.
      if (
        assistantRoundsRun > 0 &&
        // A length-continuation round is mid-stitch: its wire prefill is an
        // unpersisted assistant message that the provider resumes verbatim.
        // Rewriting the history under it would hand the model a prefill that
        // no longer follows from what precedes it.
        continuationPrefillText === undefined &&
        // A guidance round already ran the guard against this same history a
        // few lines above. Running it twice in one round would spend a second
        // LLM compaction on a history the first one just rewrote.
        !preflightRanThisRound &&
        self.provider &&
        !self.deps.disableSessionPersistence &&
        runtimeContextBudget.preflight > 0
      ) {
        const projected = self.lastRoundInputProjection.totalTokens;
        if (projected >= runtimeContextBudget.preflight) {
          if (projected < roundCompactArmedAbove) {
            decide({
              kind: "compact.auto",
              branch: "rearm-hold",
              data: { threshold: runtimeContextBudget.preflight, projected, armedAbove: roundCompactArmedAbove },
            });
          } else {
            const compacted = await self.runPreflightGuard(
              {
                systemPrompt,
                toolSchemas,
                estimateCurrent: () => self.estimateCurrentRequestProjection({ systemPrompt, toolSchemas }),
              },
              abortSignal,
              callbacks,
              // Mid-turn: the compactor's protected window has to be this
              // turn's own tool rounds, or it protects everything the turn
              // appended and reduces nothing.
              { intraTurn: true },
            );
            decide({
              kind: "compact.auto",
              branch: compacted ? "fired" : "skipped",
              data: { threshold: runtimeContextBudget.preflight, projected },
            });
            if (compacted) {
              systemPrompt = self.buildSystemPromptForScope(
                scope,
                stagedOrigin,
                bounds.rolePrompt,
                bounds.sessionIdOverride ?? self.sessionId,
                bounds.memoryQuery,
              );
              // The round already repaired the history above; compaction has
              // since rewritten it, and a boundary that cut between a tool_use
              // and its result is exactly what the provider rejects.
              const repairedAfterCompact = self.history.repairToolPairInvariant();
              if (repairedAfterCompact.removedMessages > 0 || repairedAfterCompact.removedToolCalls > 0) {
                log.warn(
                  `queryLoop: repaired invalid tool history after round-loop compaction (removedMessages=${repairedAfterCompact.removedMessages}, removedToolCalls=${repairedAfterCompact.removedToolCalls})`,
                );
              }
              messagesForRound = assembleRoundMessages(self.history.getMessages());
              self.lastRoundInputProjection = projectRound(messagesForRound);
              // Re-arm against what the compaction actually achieved, not
              // against zero. A compaction that reduced the history but did
              // not get back under the threshold would otherwise fire again on
              // the very next round; measured from the post-compaction
              // projection, a compaction that DID get back under re-arms as
              // soon as the turn grows into the threshold again.
              roundCompactArmedAbove =
                self.lastRoundInputProjection.totalTokens + roundCompactRearmGrowth;
            } else {
              // A compaction that could not reduce anything leaves the
              // projection over the threshold, so an ungated retry would spend
              // one LLM compaction per round for the rest of the turn. Require
              // real growth before asking again.
              roundCompactArmedAbove = projected + roundCompactRearmGrowth;
            }
          }
        }
      }
      if (subscriptionRuntime) self.lastRoundProviderInputTokens = 0;
      const toolExposure = self.buildToolExposureMetrics(
        scope,
        toolSchemas,
        self.lastRoundInputProjection,
        promotedToolNamesForTurn,
      );
      const requestDiagnostics = self.buildProviderRequestDiagnostics({
        round,
        assistantRoundIndex: roundIndex,
        inputOrigin: bounds.inputOrigin,
        runtimeIdentity: runtimeContextBudget.identity,
        model,
        preflightThresholdTokens: runtimeContextBudget.preflight,
        systemPrompt,
        messages: messagesForRound,
        toolSchemas,
        activePluginIds: [...scope.activePluginIds],
        projection: self.lastRoundInputProjection,
        toolExposure,
      });
      // §4.5.2 step 7 — LLM_STREAM
      self.tracer.step("LLM_STREAM", {
        round,
        assistantRoundIndex: roundIndex,
        model,
        toolCount: toolSchemas.length,
        ...toolExposure,
        request: requestDiagnostics,
      });
      const stream = await collectActiveRuntimeRoundStream(
        {
          provider: turnProvider,
          model,
          systemPrompt,
          messages: messagesForRound,
          toolSchemas,
          llmSettings: roundLlmSettings,
          abortSignal,
          continuationPrefill: continuationPrefillText !== undefined,
          onReasoningDelta: callbacks?.onReasoningDelta,
          onTextDelta: callbacks?.onTextDelta,
        },
        self.deps.settingsService.get("llm").activeChatRuntime,
        () => self.abortCurrentTurn(new Error("active chat runtime changed")),
      );
      // One-shot: clear so a following tool round or terminal round does not
      // re-inject the prefill. The continuation branch below re-sets it when the
      // chain extends. (Carry text/thought persist independently for stitching.)
      continuationPrefillText = undefined;

      // EARLY-EXIT (safety net): token estimator drift 로 context_error 도달 시
      // 사용자 안내 + turn 종료. retry 없음 — mid-loop history mutation 으로 LLM tool-chain
      // 손상되던 silent failure 패턴 영구 제거.
      if (stream.kind === "context_error") {
        log.warn(
          `queryLoop: EARLY-EXIT(context_error after token preflight) — round=${roundIndex} err="${(stream.errorMessage ?? "").slice(0, 100)}" (estimator drift suspected)`,
        );
        decide({
          kind: "early_exit",
          branch: "context_error",
          reason: "estimator-drift",
          data: { round: roundIndex },
        });
        // `stream.kind === "context_error"` 는 `stream-collector.ts` 의
        // `isContextLengthError(raw)` 가 *이미* true 를 판정한 신호 — 이
        // 분기 도달 raw 는 context-window 초과로 확정. TPM rate-limit raw
        // 는 `isContextLengthError` 패턴 (prompt is too long / maximum
        // context length / context window / input token count) 어느 것
        // 에도 매치되지 않으므로 *별도 경로* (`stream_error`, line 1582)
        // 로 도달 — 그쪽에서 새 `classifyProviderError` 가 정확한 TPM
        // 메시지를 전달함 (issue #900).
        const userMsg =
          t("be_conversationLoop.contextErrorUserMessage");
        callbacks?.onError?.(userMsg, "context-error");
        // Issue #911: mark as systemNotice so the UI renders a destructive
        // banner (red border + warning icon) instead of a normal assistant
        // reply. Without this marker the user cannot distinguish a real LLM
        // turn from a host-emitted error notice.
        self.history.append({
          role: "assistant",
          content: userMsg,
          meta: { systemNotice: "context-error" },
        });
        // Issue #910 follow-up — the user-facing message promises "새 메시지를
        // 보내면 자동 압축이 다시 시도됩니다". Set a pending flag so the next
        // runPreflightGuard force-triggers compact regardless of threshold.
        self.contextErrorPending = true;
        return withServingIdentity({ text: userMsg, toolCalls: allToolCalls, usage: turnUsage, stopReason: "context-error" });
      }

      if (stream.kind === "stream_error") {
        // EARLY-EXIT #2: provider stream error. 이미 onError 콜백 + history 에
        // 메시지 push. 추가 진단 로그로 빈도 추적.
        const streamErrorMeta = {
          round,
          assistantRoundIndex: roundIndex,
          classification: stream.classification,
          providerError: stream.providerError,
          request: requestDiagnostics,
        };
        log.warn(
          {
            sessionId: self.sessionId,
            ...streamErrorMeta,
          },
          `queryLoop: EARLY-EXIT(stream-error) — round=${roundIndex} userMessage="${stream.userMessage.slice(0, 100)}"`,
        );
        self.tracer.step("LLM_STREAM_ERROR", streamErrorMeta);

        // Provider-as-oracle recovery (#1182). The provider is the source of
        // truth for "is this tool schema acceptable": when it rejects the whole
        // request with a strict-mode 400 (invalid_function_parameters) naming
        // one offending function, drop just that tool and retry the round with
        // the reduced set — no hand-rolled mirror of the provider's rules. The
        // plugin-load lint catches the common case for free; this catches the
        // rest. `rejectedToolNameFromError` only returns a name still present in
        // `toolSchemas`, so the drop strictly shrinks a finite set and the loop
        // is guaranteed to terminate (the cap is just defensive).
        const rejectedTool = rejectedToolNameFromError(
          stream.providerError,
          toolSchemas.map((s) => s.name),
        );
        if (
          rejectedTool &&
          !droppedToolSchemaNames.has(rejectedTool) &&
          droppedToolSchemaNames.size >= MAX_TOOL_SCHEMA_DROPS_PER_TURN
        ) {
          decide({
            kind: "tool_schema.drop",
            branch: "ceiling",
            data: {
              dropped: droppedToolSchemaNames.size,
              cap: MAX_TOOL_SCHEMA_DROPS_PER_TURN,
            },
          });
        }
        if (
          rejectedTool &&
          !droppedToolSchemaNames.has(rejectedTool) &&
          droppedToolSchemaNames.size < MAX_TOOL_SCHEMA_DROPS_PER_TURN
        ) {
          droppedToolSchemaNames.add(rejectedTool);
          toolSchemas = toolSchemas.filter((s) => s.name !== rejectedTool);
          log.warn(
            {
              sessionId: self.sessionId,
              toolName: rejectedTool,
              providerCode: stream.providerError?.providerCode,
              remainingTools: toolSchemas.length,
            },
            `queryLoop: provider rejected tool inputSchema — dropping '${rejectedTool}' and retrying round (provider-as-oracle)`,
          );
          self.tracer.step("TOOL_SCHEMA_REJECTED", {
            round,
            assistantRoundIndex: roundIndex,
            toolName: rejectedTool,
            providerError: stream.providerError,
          });
          decide({
            kind: "tool_schema.drop",
            branch: "dropped",
            reason: rejectedTool,
            data: {
              dropped: droppedToolSchemaNames.size,
              remainingTools: toolSchemas.length,
            },
          });
          // Retry the round with the offending tool removed. Does NOT count as
          // an assistant round (assistantRoundsRun is unchanged); the for-loop
          // `round` counter + the round budget still bound total iterations.
          continue;
        }

        if (
          self.shouldAutoCompactForRateLimit(stream) &&
          !self.rateLimitRecoveryAttempted &&
          self.provider &&
          !self.deps.disableSessionPersistence
        ) {
          self.rateLimitRecoveryAttempted = true;
          const compacted = await self.runPreflightGuard(
            {
              systemPrompt,
              toolSchemas,
              estimateCurrent: () => self.estimateCurrentRequestProjection({
                systemPrompt,
                toolSchemas,
              }),
            },
            abortSignal,
            callbacks,
            // Also mid-turn: without this the compactor protects everything
            // the turn appended and recovers nothing, which is the whole
            // reason the recovery was attempted.
            { forceReason: "rate-limit", intraTurn: true },
          );
          if (compacted) {
            const recoveredMessage = self.rateLimitCompactMessage(stream);
            callbacks?.onTextDelta?.(recoveredMessage);
            self.history.append({
              role: "assistant",
              content: recoveredMessage,
            });
            return withServingIdentity({
              text: recoveredMessage,
              toolCalls: allToolCalls,
              usage: turnUsage,
              stopReason: "stream-error",
            });
          }
        }
        callbacks?.onError?.(stream.userMessage, "stream-error", stream.classification);
        self.history.append({
          role: "assistant",
          content: stream.userMessage,
          meta: { systemNotice: "stream-error" },
        });
        // Issue #910 round-4 security MED — stream_error covers network /
        // auth / rate-limit / 5xx in addition to context-length. Only set
        // the force-recover flag when the underlying message *actually*
        // matches a context-length pattern; for other stream errors
        // forcing a destructive (preserve=0) compact would just drop the
        // user's working history for no benefit.
        if (isContextLengthError(stream.userMessage)) {
          self.contextErrorPending = true;
        }
        decide({
          kind: "early_exit",
          branch: "stream-error",
          ...(stream.classification ? { reason: stream.classification } : {}),
          data: { round: roundIndex },
        });
        return withServingIdentity({ text: stream.userMessage, toolCalls: allToolCalls, usage: turnUsage, stopReason: "stream-error" });
      }

      if (stream.kind === "interrupted") {
        // EARLY-EXIT #3: 사용자 abort. abortCurrentTurn() 또는 외부 abortSignal.
        // 정상 케이스이지만 빈도 추적용 로그.
        log.info(
          `queryLoop: EARLY-EXIT(interrupted) — round=${roundIndex} priorTextLen=${(stream.text ?? "").length}`,
        );
        decide({
          kind: "early_exit",
          branch: "interrupted",
          data: { round: roundIndex, priorTextChars: (stream.text ?? "").length },
        });
        // Strip suggested-replies block before persistence — otherwise raw
        // `<suggested_replies>` tags would land in ~/.lvis/sessions/*.jsonl
        // and be fed back to the LLM on every subsequent turn.
        //
        // interrupted is user-initiated, not a host error, so no systemNotice:
        // the streamed content is real model output. The boundary is
        // `meta.interrupted` (renderer badge) — a "[중단됨]" text literal put UI
        // state into the transcript the model replays. Continuation carry is
        // prepended so an aborted chain persists the full partial answer.
        const savedText = stripSuggestedReplies(continuationCarryText + (stream.text ?? ""));
        self.history.append({ role: "assistant", content: savedText, meta: { interrupted: true } });
        return withServingIdentity({ text: savedText, toolCalls: allToolCalls, usage: turnUsage, stopReason: "interrupted" });
      }

      // stream.kind === "ok" — usage 반영 + assistant round commit
      //
      // LVIS usage accounting invariant:
      //   AI SDK v6 normalized inputTokens include cached tokens across
      //   providers, so subtract cacheRead/cacheWrite to get fresh input.
      //
      // 1) turnUsage 는 모든 round 의 AI SDK normalized usage 합산
      //    (이전: `=` 으로 마지막 round 만 보존
      //    → multi-round turn 의 turn_summary 가 under-report 되던 버그).
      // 2) cumulativeUsage.inputTokens 는 fresh input 만 누적 (cached 빼서)
      //    → long session 에서 cached prefix 가 매 turn 누적되어 ctxUsage 가
      //    조기에 100% 도달, auto-compact 가 premature 발화하던 root cause 해소.
      // 3) cache read/write 는 별도 누적 — 비용 계산은 다른 가중치 (read 0.1×,
      //    write 1.25×) 적용 가능하도록 분리 보존. Audit/UsageDashboard
      //    경계에서는 `normalizeAiSdkUsageForCost` 로 computeCost 계약에 맞춘다.
      if (stream.usage) recordProviderUsage(stream.usage, true);

      const { text: streamText, thought: thoughtContent, thinkingBlocks: roundThinkingBlocks, toolCalls: pendingToolCalls, stopReason } = stream;
      recordSubscriptionRoundTelemetry(
        self, subscriptionUsage, subscriptionRuntime, stream, stopReason === "end_turn",
      );
      // Strip the suggested-replies block at the single chokepoint between the
      // raw stream and every downstream consumer (history, callbacks, return
      // value). Keeping this stripped here protects: (a) persisted session
      // JSONL — the tag would otherwise be fed back as context on every
      // subsequent turn, (b) sub-agent summaries — sub-agent results flow
      // back to the parent via runTurn's return value, (c) plugin/routine
      // generateText callers — orthogonal strip is also applied in
      // generateText() but defense in depth.
      // finish_reason=length CONTINUATION: carry the RAW (un-stripped) text
      // across rounds so the wire prefill resumes vLLM verbatim — zero seam,
      // trailing whitespace preserved (stripSuggestedReplies trimEnd would
      // otherwise eat the boundary whitespace between a truncated round and its
      // continuation). The suggested-replies block is stripped ONCE on the fully
      // merged answer below — a max_tokens-truncated round never holds a
      // complete block. With no continuation in flight the carry is "" so
      // mergedRawText === streamText and mergedText === stripSuggestedReplies(
      // streamText); every non-continuation path is byte-for-byte unchanged.
      const mergedRawText = continuationCarryText + streamText;
      const mergedThought = continuationCarryThought + thoughtContent;
      const mergedText = stripSuggestedReplies(mergedRawText);

      // ─── finish_reason=length CONTINUATION ──────────────────────────────────
      // A truncated round (stopReason "max_tokens") with NO tool calls is not a
      // finished turn. Instead of terminating (cut-off answer + suspect-
      // truncation notice), re-invoke the model to CONTINUE the partial answer.
      // We DEFER the history append + onAssistantRound here so deltas keep
      // streaming into the SAME open UI card and history ends up with ONE merged
      // assistant message. (`madeProgress` is the zero-progress break.)
      const madeProgress = streamText.length > 0 || thoughtContent.length > 0;
      const willContinue =
        stopReason === "max_tokens" &&
        pendingToolCalls.length === 0 &&
        supportsLengthContinuation &&
        continuationsRun < MAX_LENGTH_CONTINUATIONS &&
        assistantRoundsRun + 1 < effectiveMaxRounds &&
        madeProgress;

      // The continuation branch only exists for a round the provider truncated
      // with nothing left to run, so that is the only shape worth reporting;
      // every other round never reached the question.
      if (stopReason === "max_tokens" && pendingToolCalls.length === 0) {
        decide({
          kind: "length.continuation",
          branch: willContinue ? "continue" : "stop",
          ...(willContinue
            ? {}
            : {
              reason: !supportsLengthContinuation
                ? "unsupported-runtime"
                : continuationsRun >= MAX_LENGTH_CONTINUATIONS
                  ? "cap"
                  : assistantRoundsRun + 1 >= effectiveMaxRounds
                    ? "round-budget"
                    : "no-progress",
            }),
          data: {
            continuationsRun,
            cap: MAX_LENGTH_CONTINUATIONS,
            carryTextChars: mergedRawText.length,
          },
        });
      }

      if (willContinue) {
        continuationCarryText = mergedRawText;
        continuationCarryThought = mergedThought;
        // Wire prefill for the next round. If the answer body has started
        // (mergedRawText non-empty) continue it verbatim — vLLM already split
        // any reasoning into reasoning_content. If we truncated INSIDE <think>
        // (no answer text yet) re-open the think block; the model emits its own
        // closing </think> before answering.
        continuationPrefillText =
          mergedRawText.length > 0 ? mergedRawText : `<think>\n${mergedThought}`;
        continuationsRun += 1;
        assistantRoundsRun += 1; // counts against the global round budget
        self.tracer.step("LENGTH_CONTINUATION", {
          round: roundIndex,
          continuationsRun,
          carryTextLen: continuationCarryText.length,
          reopenedThink: mergedRawText.length === 0,
        });
        // roundIndex is intentionally NOT incremented — the continuation is the
        // SAME logical assistant round from the UI's perspective, and we must
        // NOT fire onAssistantRound (it would close the streaming card and the
        // renderer would drop every subsequent delta).
        continue;
      }

      // Cap BEFORE persisting to history. Anthropic + OpenAI strict
      // APIs reject mismatches between assistant.tool_use blocks and the
      // tool_result blocks in the next user turn. If we keep the un-capped
      // pendingToolCalls in history, blocks 11..N never receive a matching
      // tool_result (executor only runs the capped slice) and the next
      // request 400s. Persist only what will be answered.
      let pendingToolCallsCapped = pendingToolCalls;
      const wasCapped = pendingToolCalls.length > MAX_TOOL_CALLS_PER_ROUND;
      if (wasCapped) {
        log.warn(
          `conversation-loop: round ${roundIndex} emitted ${pendingToolCalls.length} tool_use blocks, capping to ${MAX_TOOL_CALLS_PER_ROUND}`,
        );
        pendingToolCallsCapped = pendingToolCalls.slice(0, MAX_TOOL_CALLS_PER_ROUND);
      }

      // A persisted call must also record WHAT it called. The action panel
      // counts plugin and MCP calls off the transcript, and a reload that kept
      // only id/name/input reports zero of both — the origin lived solely on
      // the live stream's ToolCallMeta. The registry is the authority for a
      // tool's identity, so it is read here rather than inferred from the name;
      // a name with no registry entry (an unloaded plugin) persists unchanged.
      const persistedToolCalls: ToolCallBlock[] = pendingToolCallsCapped.map((toolCall) => {
        const tool = self.deps.toolRegistry.findByName(toolCall.name);
        if (!tool) return toolCall;
        return {
          ...toolCall,
          source: tool.source,
          category: tool.category,
          ...(tool.pluginId ? { pluginId: tool.pluginId } : {}),
          ...(tool.mcpServerId ? { mcpServerId: tool.mcpServerId } : {}),
        };
      });

      // thinkingBlocks는 tool_use 체인이 이어지는 다음 요청에만 signature 그대로 포함되어야 Anthropic이 수락한다.
      const preserveThinkingBlocks = stopReason === "tool_use" && pendingToolCallsCapped.length > 0;
      // Persist the MERGED answer (carry + this round). Non-continued turns have
      // empty carries ⇒ original single-round content.
      const committedAssistantRow = self.history.append({
        role: "assistant",
        content: wasCapped ? `${mergedText}\n\n[capped at ${MAX_TOOL_CALLS_PER_ROUND} of ${pendingToolCalls.length} tool_use blocks]` : mergedText,
        ...(mergedThought && { thought: mergedThought }),
        ...(preserveThinkingBlocks && roundThinkingBlocks.length > 0 && { thinkingBlocks: roundThinkingBlocks }),
        // Persist only the capped slice — these are the only blocks
        // that will receive a matching tool_result. Streaming UI still sees
        // the un-capped count below via the assistant-round callback so the
        // user can observe the original LLM intent (and the cap message).
        ...(persistedToolCalls.length > 0 && { toolCalls: persistedToolCalls }),
      });
      // Continuation chain (if any) terminates HERE — merged message committed.
      continuationCarryText = "";
      continuationCarryThought = "";

      // §4.5.2 step 8 — REASONING_ACCUMULATE
      if (thoughtContent.length > 0) {
        self.tracer.step("REASONING_ACCUMULATE", { round: roundIndex, thoughtLen: thoughtContent.length });
      }
      callbacks?.onAssistantRound?.({
        roundIndex,
        text: mergedText,
        thought: mergedThought,
        stopReason,
        // The row the surface's card stands for. Every round re-announces it,
        // so a card that spans several rounds ends up naming the row that
        // actually holds the answer it is showing.
        messageId: committedAssistantRow.meta.messageId,
        // The UI / telemetry callback receives the un-capped count so the
        // user sees the LLM's full intent — only persisted history is capped.
        hasToolCalls: pendingToolCalls.length > 0,
      });
      // §4.5.2 step 10 — ROUND_COMMIT
      self.tracer.step("ROUND_COMMIT", {
        round: roundIndex,
        stopReason,
        textLen: mergedText.length,
        toolCallCount: pendingToolCalls.length,
      });
      await commitPendingGuidance();
      roundIndex += 1;
      // C3(a): a "round" for cap purposes is any assistant message we
      // committed to history — `end_turn` and `tool_use` both count.
      assistantRoundsRun += 1;

      if (pendingToolCalls.length === 0 || stopReason === "end_turn") {
        // BEFORE returning — "방향 지시는 end-turn 전에 영향을 미치는 거"
        // (user spec). If guide is queued, do NOT end the turn; fall
        // through to another iteration so the round-boundary inject site
        // drains the queue and the LLM gets one more round to respond to
        // the guidance. Round-cap still applies — if we're at the cap, we
        // can't add another round; drop-on-end will surface to the user.
        if (self.guidanceQueue.length > 0 && assistantRoundsRun < effectiveMaxRounds) {
          self.tracer.step("GUIDANCE_INJECTED", {
            round: roundIndex,
            note: "extending turn — guide queued at end-turn boundary",
          });
          continue;
        }
        // A round that ended `end_turn` with reasoning but no answer text and no
        // tool call is not a completed turn. Measured on an agentic run: the
        // reasoning of such rounds states the next action in the first person
        // ("I need to retry the installation") and the loop returned anyway, so
        // the turn ended because the LOOP gave up, not the model. Re-prompt
        // instead, bounded by MAX_REASONING_ONLY_NUDGES so a model that only
        // ever reasons still terminates. A round with no text, no tool call AND
        // no reasoning is genuinely empty and keeps today's behaviour: it falls
        // through to the return below (which also warns when the stop reason was
        // not `end_turn`).
        const reasoningOnlyEnd =
          stopReason === "end_turn" &&
          pendingToolCalls.length === 0 &&
          mergedText.trim().length === 0 &&
          mergedThought.trim().length > 0;
        if (reasoningOnlyEnd) {
          const willNudge =
            reasoningNudgesRun < MAX_REASONING_ONLY_NUDGES &&
            assistantRoundsRun < effectiveMaxRounds;
          decide({
            kind: "reasoning_only.continuation",
            branch: willNudge ? "continue" : "stop",
            ...(willNudge
              ? {}
              : {
                reason: reasoningNudgesRun >= MAX_REASONING_ONLY_NUDGES
                  ? "cap"
                  : "round-budget",
              }),
            data: {
              nudgesRun: reasoningNudgesRun,
              cap: MAX_REASONING_ONLY_NUDGES,
              thoughtChars: mergedThought.length,
            },
          });
          if (willNudge) {
            // Arm the instruction only. The round that sends it replays this
            // round's reasoning off the row just committed, so nothing about it
            // has to be carried across the loop iteration.
            reasoningNudgePending = true;
            self.tracer.step("REASONING_ONLY_CONTINUATION", {
              round: roundIndex,
              nudgesRun: reasoningNudgesRun,
              thoughtLen: mergedThought.length,
            });
            continue;
          }
        }
        // EARLY-EXIT #4: turn 종료. 정상 케이스는 stopReason === "end_turn"
        // 또는 LLM 이 tool 없이 final 답을 내놓은 케이스. *비정상 silent
        // truncation* (예: max_tokens / unknown stopReason 으로 0 tools 반환)
        // 도 같은 분기로 떨어지므로 stopReason 이 end_turn 이 *아닌데* 0 tools
        // 면 WARN 로 명시적 진단 — 28-step abandonment 의 가능한 원인.
        if (stopReason !== "end_turn" && pendingToolCalls.length === 0) {
          log.warn(
            `queryLoop: EARLY-EXIT(suspect-truncation) — stopReason="${stopReason}" pendingTools=0 textLen=${mergedText.length} round=${roundIndex}`,
          );
          callbacks?.onError?.(
            t("be_conversationLoop.suspectTruncationError", { reason: stopReason ?? "unknown reason", round: roundIndex }),
          );
        }
        return withServingIdentity({ text: mergedText, toolCalls: allToolCalls, usage: turnUsage, stopReason });
      }

      // §4.5.6 tool execution — request_plugin 가로채기 + knowledge depth cap + executor 호출
      // (cap already applied above before history commit; pendingToolCallsCapped is the
      //  authoritative slice that flows through executor and produces tool_result blocks.)
      // A call whose arguments never parsed carries no input to execute, so it
      // is answered with an error here instead of reaching the executor. The
      // model reads that error on the next round and re-issues the call — the
      // same recovery it gets from any other failing tool. Without this the
      // malformed call would go on to poison the turn: the wire mapper coerces
      // the missing input to `{}`, and the model would keep waiting for a
      // result that describes a call it never actually made.
      for (const tc of pendingToolCallsCapped) {
        if (!tc.invalidInput) continue;
        const content = t("be_conversationLoop.toolCallInvalidArguments", {
          excerpt: tc.invalidInput.raw,
        });
        self.history.append({
          role: "tool_result",
          toolUseId: tc.id,
          toolName: tc.name,
          content,
          isError: true,
        });
        allToolCalls.push({ name: tc.name, input: {}, result: content });
        decide({
          kind: "tool_call.invalid_arguments",
          branch: tc.invalidInput.reason,
          reason: tc.name,
          data: { round: roundIndex, rawChars: tc.invalidInput.rawChars },
        });
      }

      const toolUses: ToolUseBlock[] = pendingToolCallsCapped
        .filter((tc) => !tc.invalidInput)
        .map((tc) => ({
          id: tc.id, name: tc.name, input: tc.input,
        }));

      const availableRationaleCoordinatorFactory =
        typeof self.deps.rationaleCoordinatorFactory === "function"
          ? self.deps.rationaleCoordinatorFactory
          : undefined;
      const currentRationaleProvenance = rationaleProvenanceFor(
        bounds.requestAnchor !== undefined,
        toolTrustOrigin,
      );
      const rationaleActivationRequested = isForegroundRationaleOrchestrationEnabled({
        productionEnabled: FOREGROUND_RATIONALE_PRODUCTION_ENABLED,
        nodeEnv: process.env.NODE_ENV,
        hostCoordinatorAvailable: availableRationaleCoordinatorFactory !== undefined,
        enableDormantRationaleForTesting:
          self.deps.enableDormantRationaleForTesting,
      });
      // Materialize the runtime before meta-tool ordering changes. A callable
      // factory is not enough: a stale/failed/null factory must leave the full
      // batch on the exact legacy request_plugin/tool_search path.
      const preparedRationaleRuntime = rationaleActivationRequested
        ? await prepareRationaleConversationRuntime({
            coordinatorFactory: availableRationaleCoordinatorFactory,
            requestAnchor: bounds.requestAnchor ?? null,
            rationaleProvenance: currentRationaleProvenance,
            sessionId: effectiveSessionId,
          })
        : null;
      const rationaleOrchestrationEnabled = preparedRationaleRuntime !== null;
      const firstNonMetaIndex = rationaleOrchestrationEnabled
        ? toolUses.findIndex(
            (toolUse) =>
              toolUse.name !== REQUEST_PLUGIN_TOOL &&
              toolUse.name !== TOOL_SEARCH_TOOL,
          )
        : -1;
      const eagerMetaToolUses = firstNonMetaIndex >= 0
        ? toolUses.slice(0, firstNonMetaIndex)
        : toolUses;
      const deferredOrderedToolUses = firstNonMetaIndex >= 0
        ? toolUses.slice(firstNonMetaIndex)
        : [];

      const interceptedMetaGate = await gateCrossAgentInterceptedMetaTools(
        self,
        eagerMetaToolUses,
        activeApprovalReasonPrefix,
        toolTrustOrigin,
        effectiveSessionId,
        bounds.remoteControllerAuthority,
      );
      for (const denied of interceptedMetaGate.denied) {
        self.history.append({
          role: "tool_result",
          toolUseId: denied.toolUseId,
          toolName: denied.toolName,
          content: denied.content,
          isError: true,
        });
        allToolCalls.push({
          name: denied.toolName,
          input: toolUses.find((toolUse) => toolUse.id === denied.toolUseId)?.input ?? {},
          result: denied.content,
        });
      }

      // Snapshot the session-activation set so we can audit exactly the
      // disabled plugins this turn newly session-activated (one event each).
      const sessionActivatedBefore = new Set(self.sessionActivatedPluginIds);
      const pluginExpansionsBefore = pluginExpansions;
      const requestedPluginExpansions = interceptedMetaGate.approved
        .filter((toolUse) => toolUse.name === REQUEST_PLUGIN_TOOL).length;
      const pluginOutcome = handleRequestPlugin(interceptedMetaGate.approved, {
        turnExpansions: pluginExpansions,
        sessionExpansions: self.sessionPluginExpansions,
        activePluginIds: scope.activePluginIds,
        availablePluginIds: self.filterAllowedPluginIds(
          (self.deps.pluginRuntime?.listPluginIds() ?? [])
            // A registry-DISABLED plugin is normally excluded, but a
            // session-scoped allow-list (routine `allowedPluginIds`) may
            // on-demand activate it for THIS session. Main chat has
            // `allowedPluginIds === undefined`, so the right-hand side is
            // always false and disabled plugins stay excluded (unchanged).
            .filter((pluginId) =>
              self.deps.pluginRuntime?.isPluginEnabled?.(pluginId) !== false ||
              self.deps.allowedPluginIds?.has(pluginId) === true),
        ),
        sessionActivatedPluginIds: self.sessionActivatedPluginIds,
        isPluginEnabled: (pluginId) =>
          self.deps.pluginRuntime?.isPluginEnabled?.(pluginId) !== false,
      });
      pluginExpansions = pluginOutcome.nextTurnExpansions;
      self.sessionPluginExpansions = pluginOutcome.nextSessionExpansions;
      if (requestedPluginExpansions > 0) {
        const activatedPlugins = pluginOutcome.activatedPluginIds.length;
        decide({
          kind: "plugin.expansion",
          branch: activatedPlugins > 0
            ? "expanded"
            : pluginExpansionsBefore >= MAX_PLUGIN_EXPANSION
              ? "ceiling"
              : "rejected",
          data: {
            requested: requestedPluginExpansions,
            activated: activatedPlugins,
            turnExpansions: pluginExpansions,
            cap: MAX_PLUGIN_EXPANSION,
          },
        });
      }

      // Audit each NEW session-scoped activation of a registry-DISABLED plugin.
      // This path never persists enabled state (setPluginEnabled is not called),
      // so the audit trail is the only durable record that a disabled plugin was
      // exposed for the session — valuable for the permission/scope review.
      for (const activated of self.sessionActivatedPluginIds) {
        if (!sessionActivatedBefore.has(activated)) {
          // Mirror into PluginRuntime so Gate 4 (plugin-runtime-delegate) allows
          // this plugin's tool calls for the remainder of the session. This is
          // the ONLY way a registry-disabled plugin's tools become executable —
          // setPluginEnabled is deliberately NOT called (non-persistence invariant).
          // Ordering invariant: this fires in the request_plugin interception block,
          // BEFORE the remaining non-request_plugin tool calls are dispatched to the
          // executor, so Gate 4 is already relaxed by the time index_scan (or any
          // other plugin tool) reaches the delegate.
          // Key on `effectiveSessionId` (the value wrapped in sessionContext.run),
          // NOT self.sessionId, so the WRITE matches the delegate's
          // sessionContext.getStore()?.sessionId READ even when a caller passes
          // both allowedPluginIds and a sessionIdOverride.
          self.deps.pluginRuntime?.setSessionActivated?.(effectiveSessionId, activated);
          self.auditLogger.log({
            timestamp: new Date().toISOString(),
            sessionId: effectiveSessionId,
            type: "info",
            input: `session_activated_disabled_plugin pluginId=${activated} (non-persistent; registry stays enabled:false)`,
          });
        }
      }

      // 활성화 성공했으면 tool schema 재빌드 + 추가된 tool 수 보고
      const rebuiltAfterPlugin = pluginOutcome.activatedPluginIds.length > 0;
      if (rebuiltAfterPlugin) {
        scope.deferral = self.shouldDeferToolSchemas(scope.activePluginIds);
        toolSchemas = rebuildTurnToolSchemas();
      }
      const catalogCountAfterPlugin = self.deps.toolRegistry.getToolCatalogForScope(scope).length;
      for (const rr of pluginOutcome.results) {
        // #1176 — in eager mode the activated plugin's full tool suite is
        // already loaded, so there is nothing to discover; tell the model it is
        // ready instead of pointing it at tool_search. Deferred mode keeps the
        // catalog-search guidance.
        const finalContent = !rr.is_error && rebuiltAfterPlugin
          ? scope.deferral
            ? t("be_conversationLoop.pluginToolsDeferred", { content: rr.content, catalogCount: catalogCountAfterPlugin, loadedCount: toolSchemas.length })
            : t("be_conversationLoop.pluginToolsEager", { content: rr.content, loadedCount: toolSchemas.length })
          : rr.content;
        self.history.append({
          role: "tool_result",
          toolUseId: rr.tool_use_id,
          toolName: REQUEST_PLUGIN_TOOL,
          content: finalContent,
          ...(rr.is_error && { isError: true }),
        });
      }
      for (const activated of pluginOutcome.activatedPluginIds) {
        allToolCalls.push({
          name: REQUEST_PLUGIN_TOOL,
          input: { pluginId: activated },
          result: `activated:${activated}`,
        });
      }

      // Tool-Level Deferral — tool_search 가로채기. request_plugin 과 동일
      // 패턴: catalog 매치 → activeToolNames promote → schema rebuild →
      // tool_result 합성 (tool-pair invariant) + round 예산 환불.
      // Assigned unconditionally from searchOutcome.remaining below (never read
      // before then) — declared without the dead initializer (CodeQL).
      let toolUsesForExecutor: ToolUseBlock[];
      let searchPromotedThisRound = false;
      const prevToolCountForSearch = toolSchemas.length;
      const toolSearchesBefore = toolSearches;
      const sessionToolSearchesBefore = self.sessionToolSearches;
      const requestedToolSearches = pluginOutcome.remaining
        .filter((toolUse) => toolUse.name === TOOL_SEARCH_TOOL).length;
      const searchOutcome = handleToolSearch(pluginOutcome.remaining, {
        turnSearches: toolSearches,
        sessionSearches: self.sessionToolSearches,
        activeToolNames: scope.activeToolNames,
        loadedToolNames: new Set(toolSchemas.map((tool) => tool.name)),
        loadedTools: toolSchemas.map((tool) => ({
          name: tool.name,
          description: tool.description,
        })),
        catalog: self.deps.toolRegistry.getToolCatalogForScope(scope),
      });
      toolSearches = searchOutcome.nextTurnSearches;
      self.sessionToolSearches = searchOutcome.nextSessionSearches;
      toolUsesForExecutor = [...searchOutcome.remaining, ...deferredOrderedToolUses];
      searchPromotedThisRound = searchOutcome.promotedToolNames.length > 0;
      promotedToolNamesForTurn.push(...searchOutcome.promotedToolNames);

      const rebuiltAfterSearch = searchOutcome.promotedToolNames.length > 0;
      if (rebuiltAfterSearch) {
        toolSchemas = rebuildTurnToolSchemas();
      }
      const addedBySearch = Math.max(0, toolSchemas.length - prevToolCountForSearch);
      if (requestedToolSearches > 0) {
        decide({
          kind: "tool_search",
          branch: searchOutcome.promotedToolNames.length > 0
            ? "promoted"
            : toolSearchesBefore >= MAX_TOOL_SEARCH_PER_TURN ||
              sessionToolSearchesBefore >= MAX_TOOL_SEARCH_PER_SESSION
              ? "cap"
              : "none",
          data: {
            requested: requestedToolSearches,
            promoted: searchOutcome.promotedToolNames.length,
            addedSchemas: addedBySearch,
            turnSearches: toolSearches,
            cap: MAX_TOOL_SEARCH_PER_TURN,
          },
        });
      }
      for (const rr of searchOutcome.results) {
        const finalContent = !rr.is_error && rebuiltAfterSearch
          ? t("be_conversationLoop.searchToolLoaded", { content: rr.content, loadedCount: toolSchemas.length, added: addedBySearch })
          : rr.content;
        self.history.append({
          role: "tool_result",
          toolUseId: rr.tool_use_id,
          toolName: TOOL_SEARCH_TOOL,
          content: finalContent,
          ...(rr.is_error && { isError: true }),
        });
      }
      for (const promoted of searchOutcome.promotedToolNames) {
        allToolCalls.push({
          name: TOOL_SEARCH_TOOL,
          input: { promoted },
          result: `loaded:${promoted}`,
        });
      }

      // meta-tool (request_plugin / tool_search) 만 있으면 다음 round 로 —
      // 성공 시 round 예산 돌려받기 (C9). 둘 중 하나라도 promote 했으면 환불.
      if (toolUsesForExecutor.length === 0) {
        const promotedSomething =
          pluginOutcome.activatedPluginIds.length > 0 || searchPromotedThisRound;
        if (promotedSomething) round--;
        continue;
      }

      // §4.5.2 step 9 — TOOL_EXECUTE
      self.tracer.step("TOOL_EXECUTE", {
        round: roundIndex,
        toolNames: toolUsesForExecutor.map((tu) => tu.name),
      });
      const executeOptions = {
          callbacks: {
            onToolStart: (name, input, meta) => {
              toolMetaByUseId.set(meta.toolUseId, meta);
              callbacks?.onToolStart?.(name, input, meta);
            },
            onPermissionReview: (event) => {
              permissionReviewByUseId.set(event.toolUseId, event);
              callbacks?.onPermissionReview?.(event);
            },
            onToolEnd: (name, result, isError, meta, uiPayload, durationMs) => {
              toolMetaByUseId.set(meta.toolUseId, meta);
              callbacks?.onToolEnd?.(name, result, isError, meta, uiPayload, durationMs);
            },
          },
          // C3(c): sub-agents pass their childSessionId so audit attribution
          // for tool calls flows to the child, not the parent. Falls back to
          // this loop's sessionId for normal interactive turns.
          sessionId: bounds?.sessionIdOverride ?? self.sessionId,
          // Forward the turn's overlay trigger origin so write/shell/network tools
          // bypass `allow-always` cache and force a user-confirmation
          // approval prompt — the hard gate for the overlay trigger's propose-only contract.
          overlayTriggerOrigin: stagedOrigin ?? null,
          // C3(b): carry spawn depth into ToolExecutionContext.metadata.
          // The executor uses this to refuse `agent_spawn` calls inside an
          // already-spawned sub-agent (depth >= 1).
          spawnDepth: bounds?.spawnDepth,
          supportsA2AParentDelivery: self.deps.supportsA2AParentDelivery === true,
          approvalReasonPrefix: activeApprovalReasonPrefix,
          // Threading the turn's abort signal lets long-blocking tools
          // (`ask_user_question`) honor the user's 중단 button instead of
          a2aCausalContext: activeA2ACausalContext,
          // hanging until their internal timeout.
          abortSignal,
          toolResultChunkReader: (toolUseId) => self.readToolResultForChunk(toolUseId),
          executionCwd: self.getSessionExecutionCwd(),
          permissionContext: {
            headless: self.deps.headless,
            allowedPluginIds: new Set(scope.activePluginIds),
            additionalDirectories: self.getTurnAdditionalDirectories(),
            getAdditionalDirectories: () => self.getTurnAdditionalDirectories(),
            trustOrigin: toolTrustOrigin,
            ...(bounds.remoteControllerAuthority
              ? { remoteControllerAuthority: bounds.remoteControllerAuthority }
              : {}),
            ...(bounds.requestAnchor
              ? {
                  requestAnchor: bounds.requestAnchor,
                  rationaleProvenance: rationaleProvenanceFor(true, toolTrustOrigin),
                }
              : {}),
            ...(bounds.permissionUserIntent ? { userIntent: bounds.permissionUserIntent } : {}),
            onTurnDirectoryGrant: (path) => self.addTurnAdditionalDirectory(path),
            onSessionDirectoryGrant: (path) => self.addSessionAdditionalDirectory(path),
          },
      } satisfies ConversationExecuteOptions;
      const orderedMetaToolHandler: InterceptedMetaToolHandler | undefined =
        rationaleOrchestrationEnabled
          ? async (toolUse) => {
              const gated = await gateCrossAgentInterceptedMetaTools(
                self,
                [toolUse],
                activeApprovalReasonPrefix,
                toolTrustOrigin,
                effectiveSessionId,
                bounds.remoteControllerAuthority,
              );
              const denied = gated.denied[0];
              if (denied) {
                return {
                  tool_use_id: toolUse.id,
                  content: denied.content,
                  is_error: true,
                  durationMs: 0,
                };
              }
              if (gated.approved.length !== 1) return null;

              if (toolUse.name === REQUEST_PLUGIN_TOOL) {
                const sessionActivatedBefore = new Set(self.sessionActivatedPluginIds);
                const outcome = handleRequestPlugin([toolUse], {
                  turnExpansions: pluginExpansions,
                  sessionExpansions: self.sessionPluginExpansions,
                  activePluginIds: scope.activePluginIds,
                  availablePluginIds: self.filterAllowedPluginIds(
                    (self.deps.pluginRuntime?.listPluginIds() ?? [])
                      .filter((pluginId) =>
                        self.deps.pluginRuntime?.isPluginEnabled?.(pluginId) !== false ||
                        self.deps.allowedPluginIds?.has(pluginId) === true),
                  ),
                  sessionActivatedPluginIds: self.sessionActivatedPluginIds,
                  isPluginEnabled: (pluginId) =>
                    self.deps.pluginRuntime?.isPluginEnabled?.(pluginId) !== false,
                });
                pluginExpansions = outcome.nextTurnExpansions;
                self.sessionPluginExpansions = outcome.nextSessionExpansions;

                for (const activated of self.sessionActivatedPluginIds) {
                  if (!sessionActivatedBefore.has(activated)) {
                    self.deps.pluginRuntime?.setSessionActivated?.(
                      effectiveSessionId,
                      activated,
                    );
                    self.auditLogger.log({
                      timestamp: new Date().toISOString(),
                      sessionId: effectiveSessionId,
                      type: "info",
                      input: `session_activated_disabled_plugin pluginId=${activated} (non-persistent; registry stays enabled:false)`,
                    });
                  }
                }

                const rebuilt = outcome.activatedPluginIds.length > 0;
                if (rebuilt) {
                  scope.deferral = self.shouldDeferToolSchemas(scope.activePluginIds);
                  toolSchemas = rebuildTurnToolSchemas();
                }
                const result = outcome.results[0];
                if (!result) return null;
                const catalogCount =
                  self.deps.toolRegistry.getToolCatalogForScope(scope).length;
                const content = !result.is_error && rebuilt
                  ? scope.deferral
                    ? t("be_conversationLoop.pluginToolsDeferred", {
                        content: result.content,
                        catalogCount,
                        loadedCount: toolSchemas.length,
                      })
                    : t("be_conversationLoop.pluginToolsEager", {
                        content: result.content,
                        loadedCount: toolSchemas.length,
                      })
                  : result.content;
                return {
                  tool_use_id: toolUse.id,
                  content,
                  is_error: result.is_error,
                  durationMs: 0,
                };
              }

              if (toolUse.name === TOOL_SEARCH_TOOL) {
                const previousToolCount = toolSchemas.length;
                const outcome = handleToolSearch([toolUse], {
                  turnSearches: toolSearches,
                  sessionSearches: self.sessionToolSearches,
                  activeToolNames: scope.activeToolNames,
                  loadedToolNames: new Set(toolSchemas.map((tool) => tool.name)),
                  loadedTools: toolSchemas.map((tool) => ({
                    name: tool.name,
                    description: tool.description,
                  })),
                  catalog: self.deps.toolRegistry.getToolCatalogForScope(scope),
                });
                toolSearches = outcome.nextTurnSearches;
                self.sessionToolSearches = outcome.nextSessionSearches;
                promotedToolNamesForTurn.push(...outcome.promotedToolNames);
                const rebuilt = outcome.promotedToolNames.length > 0;
                if (rebuilt) toolSchemas = rebuildTurnToolSchemas();
                const result = outcome.results[0];
                if (!result) return null;
                const addedToolCount = Math.max(
                  0,
                  toolSchemas.length - previousToolCount,
                );
                return {
                  tool_use_id: toolUse.id,
                  content: !result.is_error && rebuilt
                    ? t("be_conversationLoop.searchToolLoaded", {
                        content: result.content,
                        loadedCount: toolSchemas.length,
                        added: addedToolCount,
                      })
                    : result.content,
                  is_error: result.is_error,
                  durationMs: 0,
                };
              }

              return null;
            }
          : undefined;
      const replayBlockedResultsById = new Map<string, ToolResult>();
      const executableToolUses = toolUsesForExecutor.filter((toolUse) => {
        if (
          bounds.requestAnchor === undefined ||
          (cancelledSiblingProposalDigests.size === 0 && !cancelledSiblingProposalGuardIncomplete)
        ) {
          return true;
        }
        try {
          const guard = createCancelledSiblingProposalGuard({
            anchorId: bounds.requestAnchor.anchorId,
            toolName: toolUse.name,
            originalInput: toolUse.input,
          });
          if (!cancelledSiblingProposalGuardIncomplete && !cancelledSiblingProposalDigests.has(guard.proposalDigest)) {
            return true;
          }
        } catch {
          // A non-canonical proposal cannot prove that it differs from a
          // cancelled sibling, so fail it closed once this anchor has guards.
        }
        log.warn(
          { sessionId: effectiveSessionId, toolName: toolUse.name },
          "rationale cancelled sibling replay blocked",
        );
        replayBlockedResultsById.set(toolUse.id, {
          tool_use_id: toolUse.id,
          content: RATIONALE_SIBLING_REPLAY_BLOCKED_RESULT,
          is_error: true,
          durationMs: 0,
        });
        return false;
      });
      // What the loop decides here is the SHAPE of the batch it hands the
      // executor; whether a batch's parallel-safe members actually overlap is
      // the executor's segmentation, and the tool spans show it directly by
      // their timestamps. Reporting the dispatch keeps the two claims separate.
      if (toolUsesForExecutor.length > 0) {
        decide({
          kind: "tool_batch",
          branch: executableToolUses.length > 1 ? "batched" : "single",
          data: {
            size: toolUsesForExecutor.length,
            executable: executableToolUses.length,
            replayBlocked: replayBlockedResultsById.size,
          },
        });
      }
      const rationaleBatch = executableToolUses.length === 0
        ? {
            results: [],
            rationaleUsage: null,
            rationaleAttempted: false,
            cancelledSiblingProposalGuards: [],
            cancelledSiblingProposalGuardIncomplete: false,
          }
        : await executeRationaleAwareConversationBatch({
            executor: self.toolExecutor,
            toolUses: executableToolUses,
            executeOptions,
            provider: turnProvider,
            model,
            llmSettings: roundLlmSettings,
            ...(abortSignal ? { abortSignal } : {}),
            requestAnchor: bounds.requestAnchor ?? null,
            rationaleProvenance: currentRationaleProvenance,
            sessionId: effectiveSessionId,
            rationaleRuntime: preparedRationaleRuntime,
            ...(orderedMetaToolHandler
              ? { interceptedMetaToolHandler: orderedMetaToolHandler }
              : {}),
          });
      for (const guard of rationaleBatch.cancelledSiblingProposalGuards) {
        if (guard.anchorId === bounds.requestAnchor?.anchorId) {
          cancelledSiblingProposalDigests.add(guard.proposalDigest);
        }
      }
      cancelledSiblingProposalGuardIncomplete ||=
        rationaleBatch.cancelledSiblingProposalGuardIncomplete;
      const executedResultsById = new Map(
        rationaleBatch.results.map((result) => [result.tool_use_id, result] as const),
      );
      const toolResults = toolUsesForExecutor.map((toolUse): ToolResult =>
        replayBlockedResultsById.get(toolUse.id) ??
        executedResultsById.get(toolUse.id) ?? {
          tool_use_id: toolUse.id,
          content: RATIONALE_TRIGGER_FAILED_RESULT,
          is_error: true,
          durationMs: 0,
        },
      );
      if (rationaleBatch.rationaleUsage) {
        recordProviderUsage(rationaleBatch.rationaleUsage, false);
      }
      toolTrustOrigin = nextToolTrustOrigin(toolTrustOrigin, toolUsesForExecutor, toolResults);

      for (let i = 0; i < toolUsesForExecutor.length; i++) {
        allToolCalls.push({
          name: toolUsesForExecutor[i].name,
          input: toolUsesForExecutor[i].input,
          result: toolResults[i]?.content ?? "(missing)",
        });
      }

      toolErrorsRun += toolResults.filter((tr) => tr.is_error === true).length;

      // tool_result 히스토리 append → loop back
      for (const tr of toolResults) {
        const meta = toolResultMeta(
          tr,
          toolMetaByUseId.get(tr.tool_use_id),
          permissionReviewByUseId.get(tr.tool_use_id),
        );
        self.history.append({
          role: "tool_result",
          toolUseId: tr.tool_use_id,
          toolName: toolUsesForExecutor.find((tu) => tu.id === tr.tool_use_id)?.name,
          content: tr.content,
          ...(tr.is_error && { isError: true }),
          ...("image" in tr && tr.image ? { image: tr.image } : {}),
          ...(meta ? { meta } : {}),
        });
      }
      if (abortSignal?.aborted) {
        log.info(
          `queryLoop: EARLY-EXIT(tool-abort) — round=${roundIndex} toolResults=${toolResults.length}`,
        );
        // No streamed text exists on the tool-abort path: empty prose plus the
        // interrupted marker; the renderer badge carries the whole meaning.
        const savedText = "";
        self.history.append({ role: "assistant", content: savedText, meta: { interrupted: true } });
        return withServingIdentity({
          text: savedText,
          toolCalls: allToolCalls,
          usage: turnUsage,
          stopReason: "interrupted",
        });
      }
      // Intra-turn micro-compact — mark older tool_results stale before the
      // next round assembles its request (`messagesForRound`), so the next
      const inputRequiredControls = toolResults.flatMap((toolResult) => {
        const toolUse = toolUsesForExecutor.find((candidate) =>
          candidate.id === toolResult.tool_use_id);
        const meta = toolMetaByUseId.get(toolResult.tool_use_id);
        return !toolResult.is_error
          && toolUse?.name === "agent_send"
          && meta?.source === "builtin"
          && isA2AQuestionInputRequiredControl(toolResult.rawResult)
          ? [toolResult.rawResult]
          : [];
      });
      if (inputRequiredControls.length === 1) {
        const control = inputRequiredControls[0]!;
        return withServingIdentity({
          text: mergedText,
          toolCalls: allToolCalls,
          usage: turnUsage,
          stopReason: "input-required",
          inputRequired: { reason: "question", prompt: control.prompt },
        });
      }
      if (inputRequiredControls.length > 1) {
        log.error("queryLoop: multiple a2a-input-required controls in one round");
        return withServingIdentity({
          text: mergedText,
          toolCalls: allToolCalls,
          usage: turnUsage,
          stopReason: "stream-error",
        });
      }

      // Aged view_image images are a wire-bandwidth cost (~MBs re-sent every
      // turn), not a token cost, so evict them from history as soon as they age
      // past the preserve window — UNCONDITIONALLY, independent of the token
      // floor that (correctly) gates text stubbing below. The model has already
      // seen the image while it was in-window (per-round call cap < window).
      {
        const { messages: afterEvict, result: ie } = evictAgedToolResultImages(
          self.history.getMessages(),
          INTRA_TURN_PRESERVE_RECENT_RESULTS,
        );
        if (ie.evicted) {
          self.history.clear();
          self.history.restore(afterEvict);
          if (process.env.NODE_ENV !== "production") {
            log.info(
              `image-evict (intra-turn): dropped ${ie.evictedCount} aged image(s), ~${ie.freedChars} base64 chars`,
            );
          }
        }
      }

      // provider send stubs them on the wire. Mirrors the sub-agent fallback
      // mark (clear()/restore() atomic swap). Gated on the already-computed
      // per-round projection to skip short turns; the threshold SOT is
      // contextBudgetForCurrentRuntime so subscription turns never inherit an
      // inactive API-key provider's context budget.
      const microCompactFloor = Math.floor(
        runtimeContextBudget.preflight * MICRO_COMPACT_FLOOR_FACTOR,
      );
      const microCompactProjected = self.lastRoundInputProjection?.totalTokens ?? 0;
      if (microCompactFloor > 0 && microCompactProjected < microCompactFloor) {
        decide({
          kind: "compact.micro",
          branch: "floor-hold",
          data: { floor: microCompactFloor, projected: microCompactProjected },
        });
      }
      if (microCompactFloor > 0 && microCompactProjected >= microCompactFloor) {
        const { messages: afterMark, result: mr } = markStaleToolResults(
          self.history.getMessages(),
          { preserveRecentToolResults: INTRA_TURN_PRESERVE_RECENT_RESULTS },
        );
        decide({
          kind: "compact.micro",
          branch: mr.marked ? "fired" : "nothing-stale",
          data: {
            floor: microCompactFloor,
            projected: microCompactProjected,
            marked: mr.markedCount,
            freedChars: mr.freedCharsOnSerialize,
          },
        });
        if (mr.marked) {
          self.history.clear();
          self.history.restore(afterMark);
          if (process.env.NODE_ENV !== "production") {
            log.info(
              `mark-stale (intra-turn): marked ${mr.markedCount} tool_results, ~${mr.freedCharsOnSerialize} chars saved on serialize`,
            );
          }
        }
      }
      if (toolUsesForExecutor.some((tu) => tu.name === "skill_load")) {
        systemPrompt = self.buildSystemPromptForScope(
          scope,
          stagedOrigin,
          bounds.rolePrompt,
          bounds.sessionIdOverride ?? self.sessionId,
          bounds.memoryQuery,
        );
      }
    }

    // Outer for-loop bound (`loopRoundBound`) exhausted — reachable when
    // meta-tool refunds (`round--`) iterate the loop past 30 while
    // assistantRoundsRun stays under the cap. Same class as the assistantRounds
    // early-exit above: a budget-hit, not a natural end_turn — flag it so the
    // sub-agent runner marks the result incomplete.
    decide({
      kind: "early_exit",
      branch: "round-cap",
      reason: "loop-bound",
      data: {
        assistantRoundsRun,
        effectiveMaxRounds,
        toolCalls: allToolCalls.length,
      },
    });
    return withServingIdentity({ text: t("be_conversationLoop.toolRoundLimitExceeded"), toolCalls: allToolCalls, usage: turnUsage, stopReason: "round-cap" });
    } finally {
      rollbackPendingGuidance();
    }
  }

// ---------------------------------------------------------------------------
// Guidance batching — how a mid-turn guidance batch is formed, bounded, and
// attributed.
//
// Guidance reaches the receiver as a user-role message, which is how the model
// must see it — but a sub-agent's report is not something the user wrote, and
// the transcript has to say so. Forming the batch and attributing it live
// together here: the live renderer frame and the persisted history meta are two
// halves of one decision, and splitting them would let a reloaded session render
// a different bubble than the live turn had shown.
// ---------------------------------------------------------------------------

/**
 * Drain the queue into one bounded message, oldest entries first.
 *
 * Truncation is from the HEAD so the most recent guides survive (older ones may
 * already be superseded), and the drop is surfaced by a leading marker so the
 * model is not left reasoning over silently missing context. Callers must still
 * fire `onDropped` for every returned `dropped` entry.
 */
function truncateGuidanceBatch<T extends { text: string }>(
  queue: readonly T[],
): { kept: T[]; dropped: T[]; joined: string } {
  const kept = [...queue];
  const dropped: T[] = [];
  let joined = kept.map((entry) => entry.text).join("\n\n");
  let truncatedCount = 0;
  while (joined.length > GUIDE_JOINED_MAX_CHARS && kept.length > 1) {
    const removed = kept.shift();
    if (removed) dropped.push(removed);
    truncatedCount += 1;
    joined = kept.map((entry) => entry.text).join("\n\n");
  }
  return {
    kept,
    dropped,
    joined: truncatedCount > 0
      ? t("be_conversationLoop.guidanceTruncationMarker", { count: truncatedCount, joined })
      : joined,
  };
}

/**
 * Attribute a batch to a sub-agent only when EVERY entry came from one.
 *
 * A batch that also carried the user's own mid-turn guide is still the user's
 * message; labelling it a child report would credit the wrong author for text
 * the user typed.
 */
function subAgentSourceForBatch(
  entries: readonly { subAgentTitle?: string }[],
): GuidanceInjectionSource | undefined {
  if (entries.length === 0) return undefined;
  const titles = [...new Set(entries.map((entry) => entry.subAgentTitle))];
  if (titles.includes(undefined)) return undefined;
  return {
    kind: "sub-agent",
    // Several children in one batch: report it as a child report, unnamed,
    // rather than crediting one child for another's work.
    ...(titles.length === 1 ? { title: titles[0]! } : {}),
  };
}

/** Persisted counterpart of {@link subAgentSourceForBatch}, for reload replay. */
function subAgentHistoryMeta(
  source: GuidanceInjectionSource | undefined,
): { meta: MessageMeta } | Record<string, never> {
  if (!source) return {};
  return {
    meta: {
      subAgentReport: source.title === undefined ? {} : { title: source.title },
    },
  };
}

// ---------------------------------------------------------------------------
// Persisted tool_result renderer metadata.
// ---------------------------------------------------------------------------

/**
 * Renderer metadata for one persisted tool_result: display fields for the tool
 * row plus the permission verdict for that call. Both are what a reloaded
 * transcript rebuilds the row from, so they are assembled in one place.
 */
function toolResultMeta(
  result: ToolResult,
  callMeta: ToolCallMeta | undefined,
  review: PermissionReviewEvent | undefined,
): MessageMeta | undefined {
  const toolDisplay = "durationMs" in result
    ? {
        durationMs: result.durationMs,
        ...(callMeta?.source ? { source: callMeta.source } : {}),
        ...(callMeta?.category ? { category: callMeta.category } : {}),
        ...(callMeta?.pluginId ? { pluginId: callMeta.pluginId } : {}),
        ...(callMeta?.mcpServerId ? { mcpServerId: callMeta.mcpServerId } : {}),
        ...(callMeta?.cancelled ? { cancelled: true } : {}),
        ...("uiPayload" in result && result.uiPayload ? { uiPayload: result.uiPayload } : {}),
      }
    : undefined;
  const permissionReview = review
    ? {
        status: review.status,
        ...(review.verdictLevel ? { verdictLevel: review.verdictLevel } : {}),
        ...(review.reason ? { reason: review.reason } : {}),
      }
    : undefined;
  if (!toolDisplay && !permissionReview) return undefined;
  return {
    ...(toolDisplay ? { toolDisplay } : {}),
    ...(permissionReview ? { permissionReview } : {}),
  };
}

// ---------------------------------------------------------------------------
// API-key usage segments.
// ---------------------------------------------------------------------------

/** Appends an API-key usage segment only when the serving identity is known. */
function appendUsageForServingModel(
  usageByModel: TokenUsageByModel[],
  vendorProvider: LLMVendor | undefined,
  vendorModel: string | undefined,
  usage: TokenUsage,
): void {
  if (vendorProvider === undefined || vendorModel === undefined) {
    return;
  }
  usageByModel.push({
    vendorProvider,
    vendorModel,
    tokenUsage: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      ...(usage.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
      ...(usage.cacheWriteTokens !== undefined ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
    },
  });
}

// ---------------------------------------------------------------------------
// Round-cap finalization — one bounded, tool-free model call issued when a turn
// exhausts its round budget.
//
// Without it, `round-cap` returns the last assistant message verbatim. When the
// final round was a pure tool-call round that text is empty or a mid-thought
// fragment, so a sub-agent that ran out of budget mid-investigation returns
// nothing its parent can act on — the "agent stopped without reporting" symptom.
// The budget is spent either way; what is missing is a readable hand-off.
//
// Deliberately NOT a normal round: no tools are offered, so it cannot extend the
// work it is summarizing, and `outputTokenLimit` bounds it. It reports; it does
// not continue.
// ---------------------------------------------------------------------------

/** Enough for a dense hand-off, small enough that the call cannot run away. */
const FINALIZE_OUTPUT_TOKEN_LIMIT = 1024;

export interface RoundCapFinalizeParams {
  provider: LLMProvider;
  model: string;
  systemPrompt: string;
  /** Turn history as it stood when the budget ran out. */
  messages: GenericMessage[];
  abortSignal?: AbortSignal;
}

export interface RoundCapFinalizeResult {
  text: string;
  usage?: TokenUsage;
}

/**
 * Ask the model to state what it established and what remains.
 *
 * Returns `null` when the call cannot produce text — provider error, abort, or
 * an empty completion. The caller keeps whatever partial text it already had;
 * a failed hand-off must never be worse than no hand-off.
 */
export async function finalizeAfterRoundCap(
  params: RoundCapFinalizeParams,
): Promise<RoundCapFinalizeResult | null> {
  if (params.abortSignal?.aborted) return null;

  const messages: GenericMessage[] = [
    ...params.messages,
    { role: "user", content: t("be_conversationLoop.roundCapFinalizePrompt") },
  ];

  let text = "";
  let usage: TokenUsage | undefined;
  try {
    for await (const event of params.provider.streamTurn({
      model: params.model,
      systemPrompt: params.systemPrompt,
      messages,
      // No `tools`: the call must summarize the work, never extend it.
      outputTokenLimit: FINALIZE_OUTPUT_TOKEN_LIMIT,
      ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
    })) {
      if (event.type === "text_delta") text += event.text;
      else if (event.type === "message_complete") usage = event.usage;
      else if (event.type === "error") {
        log.warn({ error: event.error }, "round-cap finalize: provider error");
        return null;
      }
    }
  } catch (err) {
    log.warn(
      { err: errorMessage(err) },
      "round-cap finalize: call failed",
    );
    return null;
  }

  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  return usage ? { text: trimmed, usage } : { text: trimmed };
}

/**
 * What a round-capped turn returns, in order of preference:
 *
 *  1. the finalize hand-off — written knowing the work stopped, so it states
 *     findings and remaining steps rather than trailing off mid-thought;
 *  2. the last assistant message verbatim — the pre-existing behavior, kept as
 *     the fallback because a real partial answer beats a synthetic notice;
 *  3. the round-cap notice — only when there is no assistant text at all, which
 *     is exactly the tool-only-final-round case that read as silent failure.
 */
export function resolveRoundCapText(
  finalized: RoundCapFinalizeResult | null,
  messages: readonly GenericMessage[],
  roundCapNotice: string,
): string {
  if (finalized?.text) return finalized.text;
  const lastAssistant = messages
    .filter((m) => m.role === "assistant")
    .slice(-1)[0]?.content ?? "";
  return lastAssistant.length > 0 ? lastAssistant : roundCapNotice;
}

/** Fold the finalize call's usage into the turn total. Identity when absent. */
export function mergeFinalizeUsage(
  turnUsage: TokenUsage | undefined,
  finalized: RoundCapFinalizeResult | null,
): TokenUsage | undefined {
  const extra = finalized?.usage;
  if (!extra) return turnUsage;
  return {
    inputTokens: (turnUsage?.inputTokens ?? 0) + extra.inputTokens,
    outputTokens: (turnUsage?.outputTokens ?? 0) + extra.outputTokens,
    cacheReadTokens: (turnUsage?.cacheReadTokens ?? 0) + (extra.cacheReadTokens ?? 0),
    cacheWriteTokens: (turnUsage?.cacheWriteTokens ?? 0) + (extra.cacheWriteTokens ?? 0),
  };
}

// ---------------------------------------------------------------------------
// `request_plugin` meta-tool — promotes a whole plugin into scope.
// ---------------------------------------------------------------------------

const REQUEST_PLUGIN_TOOL = "request_plugin";

const MAX_PLUGIN_EXPANSION = 2;

const MAX_SESSION_PLUGIN_EXPANSION = 6;

interface PluginExpansionState {

  turnExpansions: number;

  sessionExpansions: number;

  activePluginIds: Set<string>;

  availablePluginIds: string[];
  /**
   * Session-scoped on-demand activation sink. When a registry-DISABLED plugin
   * (per {@link isPluginEnabled}) is activated, its id is recorded here so the
   * caller's scope resolver skips the disabled-drop for THIS session only —
   * never persisting enabled state (setPluginEnabled is NOT called). A
   * disabled id can only reach the activation branch if it already passed the
   * caller's allow-list gate (it would not be in {@link availablePluginIds}
   * otherwise). Omitted for main chat.
   */
  sessionActivatedPluginIds?: Set<string>;
  /** Registry active-state predicate; `false` ⇒ the plugin is disabled. */
  isPluginEnabled?: (pluginId: string) => boolean;
}

interface PluginExpansionOutcome {

  results: Array<{ tool_use_id: string; content: string; is_error: boolean }>;

  remaining: ToolUseBlock[];

  activatedPluginIds: string[];

  nextTurnExpansions: number;

  nextSessionExpansions: number;
}

function handleRequestPlugin(
  toolUses: ToolUseBlock[],
  state: PluginExpansionState,
): PluginExpansionOutcome {
  const results: PluginExpansionOutcome["results"] = [];
  const remaining: ToolUseBlock[] = [];
  const activatedPluginIds: string[] = [];
  let turnExpansions = state.turnExpansions;
  let sessionExpansions = state.sessionExpansions;

  for (const tu of toolUses) {
    if (tu.name !== REQUEST_PLUGIN_TOOL) {
      remaining.push(tu);
      continue;
    }
    const pluginId = (tu.input as { pluginId?: unknown })?.pluginId;
    const availableIds = state.availablePluginIds;
    if (typeof pluginId !== "string" || pluginId.length === 0) {
      results.push({
        tool_use_id: tu.id,
        content: t("be_pluginExpansion.missingPluginId", { available: availableIds.join(", ") || t("be_pluginExpansion.noneAvailable") }),
        is_error: true,
      });
    } else if (!availableIds.includes(pluginId)) {
      results.push({
        tool_use_id: tu.id,
        content: t("be_pluginExpansion.unknownPluginId", { pluginId, available: availableIds.join(", ") || t("be_pluginExpansion.noneAvailable") }),
        is_error: true,
      });
    } else if (turnExpansions >= MAX_PLUGIN_EXPANSION) {
      results.push({
        tool_use_id: tu.id,
        content: t("be_pluginExpansion.turnLimitExceeded", { max: String(MAX_PLUGIN_EXPANSION), pluginId }),
        is_error: true,
      });
    } else if (sessionExpansions >= MAX_SESSION_PLUGIN_EXPANSION) {
      log.warn(
        `request_plugin session cap reached (${MAX_SESSION_PLUGIN_EXPANSION}). ` +
        `Rejecting '${pluginId}'.`,
      );
      results.push({
        tool_use_id: tu.id,
        content: t("be_pluginExpansion.sessionLimitExceeded", { max: String(MAX_SESSION_PLUGIN_EXPANSION), pluginId }),
        is_error: true,
      });
    } else {
      state.activePluginIds.add(pluginId);
      // Session-scoped on-demand activation — a registry-disabled plugin that
      // cleared the caller's allow-list gate (else it would not be in
      // availablePluginIds) is activated for THIS session only. Record it so
      // the scope resolver keeps its tools WITHOUT persisting enabled=true.
      if (state.isPluginEnabled?.(pluginId) === false) {
        state.sessionActivatedPluginIds?.add(pluginId);
      }
      turnExpansions += 1;
      sessionExpansions += 1;
      activatedPluginIds.push(pluginId);
      results.push({
        tool_use_id: tu.id,
        // 실제 추가된 도구 수는 호출자가 rebuild 후 보강 가능하지만
        // 초기 메시지는 activation 사실만 보고한다 — 호출자가 replace 하기도 한다.
        content: t("be_pluginExpansion.activated", { pluginId }),
        is_error: false,
      });
    }
  }

  return {
    results,
    remaining,
    activatedPluginIds,
    nextTurnExpansions: turnExpansions,
    nextSessionExpansions: sessionExpansions,
  };
}

// ---------------------------------------------------------------------------
// Tool-Level Deferral — `tool_search` meta-tool handler.
//
// Mirror of `request_plugin` one layer down: where `request_plugin` promotes a
// whole *plugin* into scope, `tool_search` promotes individual *tools* from the
// per-turn catalog into the live `tools[]` for the next round.
//
// When the LLM emits `tool_search({ query })` the loop does not pass it to the
// tool executor; instead this section ranks catalog tools by `query`, promotes a
// small top-N result set into `activeToolNames`, and synthesizes a `tool_result`
// per intercepted `tool_use` (tool-pair invariant). The caller rebuilds tool
// schemas and refunds the round, exactly like the plugin path.
//
// Pure logic — the caller owns side effects (history append, schema rebuild).
// ---------------------------------------------------------------------------

/** Name of the meta-tool. SOT is the registry; re-exported here for the loop. */
export const TOOL_SEARCH_TOOL = TOOL_SEARCH_TOOL_NAME;

export const MAX_TOOL_SEARCH_PER_TURN = 4;

export const MAX_TOOL_SEARCH_PER_SESSION = 20;

export const MAX_TOOL_SEARCH_PROMOTIONS_PER_SEARCH = 5;

export const MIN_CATALOG_MATCH_TOKEN_LENGTH = 2;

/** Catalog entry the loop supplies (from `getToolCatalogForScope`). */
interface ToolSearchCatalogEntry {
  name: string;
  description: string;
}

export interface ToolSearchState {

  turnSearches: number;

  sessionSearches: number;

  activeToolNames: Set<string>;

  loadedToolNames?: Set<string>;

  loadedTools?: ToolSearchCatalogEntry[];

  catalog: ToolSearchCatalogEntry[];
}

interface ToolSearchOutcome {

  results: Array<{ tool_use_id: string; content: string; is_error: boolean }>;

  remaining: ToolUseBlock[];

  promotedToolNames: string[];

  nextTurnSearches: number;

  nextSessionSearches: number;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function tokenizeQuery(query: string): string[] {
  const normalized = query.toLowerCase().trim();
  if (normalized.length === 0) return [];
  return uniqueStrings([
    normalized,
    ...normalized.split(/[\s,.;:()[\]{}"'`/\\|]+/),
    ...normalized.split(/[\s,.;:()[\]{}"'`/\\|_-]+/),
  ].map((token) => token.trim()).filter((token) => token.length >= MIN_CATALOG_MATCH_TOKEN_LENGTH));
}

function tokenizeName(name: string): string[] {
  return name.toLowerCase().split(/[_\-\s.]+/).filter((token) => token.length > 0);
}

function entrySearchText(entry: ToolSearchCatalogEntry): string {
  return `${entry.name} ${entry.description}`.toLowerCase();
}

/**
 * IDF weight per query token over the current catalog corpus: a rare token
 * weighs ~1.0, a token that appears in most entries (get/list/file) is damped
 * toward a 0.2 floor (kept above 0 so a common-token match still counts).
 * Normalized by log(1+N) so the range is stable regardless of catalog size and
 * clamped to [0.2, 1]. This is the discriminative core of the ranking upgrade:
 * a match on a distinctive token now outranks a match on boilerplate.
 */
function computeIdfWeights(
  catalog: ToolSearchCatalogEntry[],
  queryTokens: string[],
): Map<string, number> {
  const weights = new Map<string, number>();
  const total = catalog.length;
  if (total === 0) return weights;
  const texts = catalog.map(entrySearchText);
  const denom = Math.log(1 + total) || 1;
  for (const token of queryTokens) {
    if (weights.has(token)) continue;
    let documentFrequency = 0;
    for (const text of texts) {
      if (text.includes(token)) documentFrequency += 1;
    }
    const idf = documentFrequency > 0 ? Math.log(1 + total / documentFrequency) : Math.log(1 + total);
    weights.set(token, Math.min(1, Math.max(0.2, idf / denom)));
  }
  return weights;
}

function scoreCatalogEntry(
  query: string,
  tokens: string[],
  entry: ToolSearchCatalogEntry,
  idfWeights?: Map<string, number>,
): number {
  const name = entry.name.toLowerCase();
  const description = entry.description.toLowerCase();
  const nameTokens = tokenizeName(entry.name);
  // Exact whole-query name match is an un-weighted strong signal (still requires
  // the query to clear the minimum token length so a 1-char query cannot promote
  // a 1-char tool name).
  let score = name === query && query.length >= MIN_CATALOG_MATCH_TOKEN_LENGTH ? 1_000 : 0;

  for (const token of tokens) {
    // Defense at the scoring boundary: sub-minimum tokens never contribute,
    // even if a future caller bypasses tokenizeQuery's length filter.
    if (token.length < MIN_CATALOG_MATCH_TOKEN_LENGTH) continue;
    let tokenScore = 0;
    if (name === token) {
      tokenScore = 700;
    } else if (name.startsWith(token)) {
      tokenScore = 350;
    } else if (nameTokens.includes(token)) {
      tokenScore = 300;
    } else if (name.includes(token)) {
      tokenScore = 120;
    }

    if (description.includes(token)) {
      tokenScore += 30;
    }

    // IDF weighting: dampen contributions from tokens common across the catalog.
    // Absent weights (default 1) preserve the pre-IDF behavior.
    score += tokenScore * (idfWeights?.get(token) ?? 1);
  }

  return score;
}

/**
 * Test-only export — allows unit tests to drive `scoreCatalogEntry` directly
 * so the scoring-side MIN_CATALOG_MATCH_TOKEN_LENGTH guards (lines above) are
 * covered independently of the tokenizeQuery pre-filter. The function is pure
 * and has no side effects; exporting it does not affect production behaviour.
 *
 * @internal Do not import outside of `__tests__/`.
 */
export { scoreCatalogEntry as _scoreCatalogEntryForTest };
/** @internal Test-only — IDF weighting is pure; do not import outside `__tests__/`. */
export { computeIdfWeights as _computeIdfWeightsForTest };

function matchCatalog(
  query: string,
  catalog: ToolSearchCatalogEntry[],
): ToolSearchCatalogEntry[] {
  const normalizedQuery = query.toLowerCase().trim();
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) return [];
  const idfWeights = computeIdfWeights(catalog, tokens);
  return catalog
    .map((entry) => ({ entry, score: scoreCatalogEntry(normalizedQuery, tokens, entry, idfWeights) }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name))
    .slice(0, MAX_TOOL_SEARCH_PROMOTIONS_PER_SEARCH)
    .map((candidate) => candidate.entry);
}

export function handleToolSearch(
  toolUses: ToolUseBlock[],
  state: ToolSearchState,
): ToolSearchOutcome {
  const results: ToolSearchOutcome["results"] = [];
  const remaining: ToolUseBlock[] = [];
  const promotedToolNames: string[] = [];
  let turnSearches = state.turnSearches;
  let sessionSearches = state.sessionSearches;

  for (const tu of toolUses) {
    if (tu.name !== TOOL_SEARCH_TOOL) {
      remaining.push(tu);
      continue;
    }
    const query = (tu.input as { query?: unknown })?.query;
    if (typeof query !== "string" || query.trim().length === 0) {
      results.push({
        tool_use_id: tu.id,
        content: t("be_toolSearch.queryRequired"),
        is_error: true,
      });
    } else if (tokenizeQuery(query).length === 0) {
      results.push({
        tool_use_id: tu.id,
        content: t("be_toolSearch.queryTokenTooShort", { minLen: String(MIN_CATALOG_MATCH_TOKEN_LENGTH) }),
        is_error: true,
      });
    } else if (turnSearches >= MAX_TOOL_SEARCH_PER_TURN) {
      results.push({
        tool_use_id: tu.id,
        content: t("be_toolSearch.turnLimitExceeded", { max: String(MAX_TOOL_SEARCH_PER_TURN), query }),
        is_error: true,
      });
    } else if (sessionSearches >= MAX_TOOL_SEARCH_PER_SESSION) {
      log.warn(
        `tool_search session cap reached (${MAX_TOOL_SEARCH_PER_SESSION}). ` +
        `Rejecting query '${query}'.`,
      );
      results.push({
        tool_use_id: tu.id,
        content: t("be_toolSearch.sessionLimitExceeded", { max: String(MAX_TOOL_SEARCH_PER_SESSION), query }),
        is_error: true,
      });
    } else {
      const normalizedQuery = query.trim().toLowerCase();
      const loadedCatalog = state.loadedTools ?? [...(state.loadedToolNames ?? state.activeToolNames)]
        .map((name) => ({ name, description: "" }));
      const exactLoaded = loadedCatalog.find(
        (tool) => tool.name.toLowerCase() === normalizedQuery,
      );
      if (exactLoaded) {
        results.push({
          tool_use_id: tu.id,
          content: t("be_toolSearch.alreadyLoaded", { name: exactLoaded.name }),
          is_error: false,
        });
      } else {
        const matches = matchCatalog(query, state.catalog).filter(
          (m) => !state.activeToolNames.has(m.name),
        );
        if (matches.length === 0) {
          const loadedMatches = matchCatalog(query, loadedCatalog);
          if (loadedMatches.length > 0) {
            results.push({
              tool_use_id: tu.id,
              content: t("be_toolSearch.alreadyLoadedMultiple", { names: loadedMatches.map((m) => m.name).join(", ") }),
              is_error: false,
            });
          } else {
            results.push({
              tool_use_id: tu.id,
              content: t("be_toolSearch.noMatchFound", {
                query,
                catalog: state.catalog.map((c) => c.name).join(", ") || t("be_toolSearch.catalogEmpty"),
              }),
              is_error: true,
            });
          }
        } else {
          for (const m of matches) {
            state.activeToolNames.add(m.name);
            promotedToolNames.push(m.name);
          }
          turnSearches += 1;
          sessionSearches += 1;
          results.push({
            tool_use_id: tu.id,
            content: t("be_toolSearch.toolsPromoted", { count: String(matches.length), names: matches.map((m) => m.name).join(", ") }),
            is_error: false,
          });
        }
      }
    }
  }

  return {
    results,
    remaining,
    promotedToolNames,
    nextTurnSearches: turnSearches,
    nextSessionSearches: sessionSearches,
  };
}

// ---------------------------------------------------------------------------
// Cross-agent gate for the intercepted meta tools (`request_plugin`,
// `tool_search`). Both mutate the active tool/session surface while bypassing
// the ordinary ToolExecutor, so a message that did not come from the local user
// has to clear an approval before either can run.
// ---------------------------------------------------------------------------

interface InterceptedMetaGateResult {
  approved: ToolUseBlock[];
  denied: Array<{
    toolUseId: string;
    toolName: string;
    content: string;
  }>;
}

function isApprovalChoiceAllowed(choice: string): boolean {
  return choice === "allow-once" || choice === "allow-session" || choice === "allow-always";
}

export async function gateCrossAgentInterceptedMetaTools(
  self: LoopContext,
  toolUses: ToolUseBlock[],
  approvalReasonPrefix: string | undefined,
  trustOrigin: ToolTrustOrigin,
  sessionId: string,
  remoteControllerAuthority?: RemoteControllerAuthority,
): Promise<InterceptedMetaGateResult> {
  if (!approvalReasonPrefix && !remoteControllerAuthority) {
    return { approved: toolUses, denied: [] };
  }

  const approved: ToolUseBlock[] = [];
  const denied: InterceptedMetaGateResult["denied"] = [];
  for (const toolUse of toolUses) {
    if (toolUse.name !== REQUEST_PLUGIN_TOOL && toolUse.name !== TOOL_SEARCH_TOOL) {
      approved.push(toolUse);
      continue;
    }

    // These meta commands mutate the active tool/session surface while
    // bypassing the ordinary ToolExecutor. A P1 Tailnet controller cannot
    // create a cross-turn capability; retain a narrow send/read/write model
    // until an actor-scoped continuation protocol exists.
    if (remoteControllerAuthority !== undefined) {
      denied.push({
        toolUseId: toolUse.id,
        toolName: toolUse.name,
        content: `remote-controller-meta-disabled: ${toolUse.name}`,
      });
      continue;
    }

    const gate = self.deps.approvalGate;
    let allowed = false;
    if (!gate) {
      self.auditLogger.log({
        timestamp: new Date().toISOString(),
        sessionId,
        type: "error",
        input: `cross-agent-meta-approval-unavailable:${toolUse.name}`,
      });
    } else {
      try {
        const decision = await gate.requestAndWait({
          id: randomUUID(),
          category: "tool",
          kind: "tool",
          toolName: toolUse.name,
          toolCategory: "meta",
          // Same conversation this gate already audits under.
          sessionId,
          args: toolUse.input,
          reason: `${approvalReasonPrefix} cross-agent message requested ${toolUse.name}`,
          source: "builtin",
          createdAt: Date.now(),
          isReadOnly: false,
          mode: "ask_all",
          trustOrigin,
          // This ask parks the turn like any other, so the turn's Stop has to
          // be able to end it rather than leave it on the gate's own timer.
          // Read from the loop rather than threaded in: this is the same
          // controller `runTurn` installed and the same signal it handed the
          // executor, and the caller has no third one to offer.
          ...(self.currentAbortController === null
            ? {}
            : { abortSignal: self.currentAbortController.signal }),
        });
        allowed = isApprovalChoiceAllowed(decision.choice);
      } catch {
        self.auditLogger.log({
          timestamp: new Date().toISOString(),
          sessionId,
          type: "error",
          input: `cross-agent-meta-approval-failed:${toolUse.name}`,
        });
      }
    }

    if (allowed) {
      approved.push(toolUse);
    } else {
      denied.push({
        toolUseId: toolUse.id,
        toolName: toolUse.name,
        content: `cross-agent-approval-denied: ${toolUse.name}`,
      });
    }
  }

  return { approved, denied };
}
