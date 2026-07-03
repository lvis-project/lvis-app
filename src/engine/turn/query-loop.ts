/**
 * queryLoop — the vendor-abstracted agentic round loop, extracted
 * from conversation-loop.ts as a free function over `self: LoopContext`. All
 * turn state (history, provider, usage, lastRound/lastContext token fields,
 * guidance queue) stays on the ConversationLoop instance, accessed via `self`.
 */
import type { LoopContext } from "./loop-context.js";
import type { TurnCallbacks, TurnStopReason, ToolScope } from "./types.js";
import type { LLMVendor, TokenUsage, TokenUsageByModel, ToolSchema } from "../llm/types.js";
import type { ChatInputOrigin } from "../../shared/chat-origin.js";
import type { ToolTrustOrigin } from "../../tools/types.js";
import type { ActiveRolePrompt } from "../../data/role-presets.js";
import type { ToolCallMeta, ToolUseBlock } from "../../tools/executor.js";
import { collectRoundStream } from "./stream-collector.js";
import { FallbackProvider } from "../llm/vercel/fallback-chain.js";
import { vendorSupportsLengthContinuation } from "../llm/vendor-capabilities.js";
import { rejectedToolNameFromError, withoutDroppedTools } from "../llm/rejected-tool-schema.js";
import { handleRequestPlugin, REQUEST_PLUGIN_TOOL } from "./plugin-expansion.js";
import { handleToolSearch, TOOL_SEARCH_TOOL } from "./tool-search.js";
import { applyKnowledgeDepthCap } from "./knowledge-cap.js";
import { nextToolTrustOrigin } from "./trust-origin.js";
import { markStaleToolResults, getModelPreflightThreshold, isContextLengthError } from "../auto-compact.js";
import { estimateRequestInputProjection } from "../request-input-projection.js";
import { stripSuggestedReplies } from "../suggested-replies.js";
import { GUIDE_JOINED_MAX_CHARS } from "./guidance-limits.js";
import { t } from "../../i18n/index.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger("lvis");

// 사용자가 *26 step* 작업에서 cap hit 으로 *조용히 끊긴* 사례 (2026-05-07) 후
// 10 → 30 으로 상향. 사용자 task 의 자연 round 분포 (~13 rounds for 26 steps) 를
// 수용하면서 *진정한 무한 루프* 는 여전히 차단. SubAgentRunner 는 자기 maxRounds
// 로 clamp 하므로 영향 없음 (line 902 `Math.min`).
const MAX_TOOL_ROUNDS = 30;
/**
 * Hard cap on finish_reason=length CONTINUATIONS per logical assistant answer.
 * Codex/Anthropic/OpenAI guidance converge on 2–3. AND-ed with: (a) a
 * zero-progress break (a round adding no text AND no reasoning ends the chain),
 * (b) the global MAX_TOOL_ROUNDS budget, and (c) the per-iteration `round < 30`
 * for-bound. Any one tripping stops the chain — defense against a model that
 * always returns "max_tokens".
 */
const MAX_LENGTH_CONTINUATIONS = 3;
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
 * C3(a): per-round cap on the number of tool calls an assistant round can
 * issue. Pathological round-emitting many tool_use blocks at once would
 * otherwise execute every one in parallel before the maxRounds guard could
 * intervene. SubAgentRunner relies on this cap to keep a sub-agent's total
 * tool execution count bounded by `maxRounds * MAX_TOOL_CALLS_PER_ROUND`.
 */
const MAX_TOOL_CALLS_PER_ROUND = 10;

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
      inputOrigin: ChatInputOrigin;
      toolTrustOrigin: ToolTrustOrigin;
      permissionUserIntent?: string;
      permissionExplicitAuthorizationIntent?: string;
      rolePrompt?: ActiveRolePrompt;
    },
  ): Promise<{
    text: string;
    toolCalls: Array<{ name: string; input: Record<string, unknown>; result: string }>;
    usage?: TokenUsage;
    stopReason?: TurnStopReason;
    usageByModel: TokenUsageByModel[];
    vendorProvider: LLMVendor;
    vendorModel: string;
    finalToolSchemas: ToolSchema[];
    promotedToolNames: string[];
  }> {
    const llmSettings = self.deps.settingsService.get("llm");
    const activeBlock = llmSettings.vendors[llmSettings.provider];
    const model = activeBlock.model;
    let systemPrompt = initialSystemPrompt;
    let servingVendorProvider: LLMVendor = llmSettings.provider;
    let servingVendorModel = model;
    const usageByModel: TokenUsageByModel[] = [];
    const addUsageForServingModel = (usage: TokenUsage): void => {
      usageByModel.push({
        vendorProvider: servingVendorProvider,
        vendorModel: servingVendorModel,
        tokenUsage: {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          ...(usage.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
          ...(usage.cacheWriteTokens !== undefined ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
        },
      });
    };
    // Provider-as-oracle: tools the provider 400'd on (invalid_function_parameters)
    // and we dropped this turn. Turn-scoped — resets naturally each queryLoop call.
    const droppedToolSchemaNames = new Set<string>();
    // Option C: scope is mutable within the turn. Mutating the caller's Set
    // directly means the next turn's fallback sees every plugin that was
    // activated here. Route EVERY turn rebuild through this so already-dropped
    // tools stay excluded — a mid-turn rebuild (request_plugin / tool_search)
    // must not reintroduce a tool the provider already rejected and re-break
    // the turn.
    const rebuildTurnToolSchemas = (): ToolSchema[] =>
      withoutDroppedTools(self.rebuildToolSchemas(scope), droppedToolSchemaNames);
    let toolSchemas: ToolSchema[] = rebuildTurnToolSchemas();
    const withServingIdentity = (
      result: {
        text: string;
        toolCalls: Array<{ name: string; input: Record<string, unknown>; result: string }>;
        usage?: TokenUsage;
        stopReason?: TurnStopReason;
      },
    ) => ({
      ...result,
      usageByModel: [...usageByModel],
      vendorProvider: servingVendorProvider,
      vendorModel: servingVendorModel,
      finalToolSchemas: [...toolSchemas],
      promotedToolNames: [...new Set(promotedToolNamesForTurn)],
    });
    const turnProvider = self.provider instanceof FallbackProvider
      ? self.provider.withCallbacks({
        onFallback: callbacks?.onFallback,
        onStatus: (status) => {
          if (
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
    let turnUsage: TokenUsage | undefined;
    let pluginExpansions = 0;
    // Tool-Level Deferral — per-turn tool_search counter (mirror pluginExpansions).
    let toolSearches = 0;
    const promotedToolNamesForTurn: string[] = [];
    let knowledgeCallCount = 0;
    let roundIndex = 0;
    let toolTrustOrigin = bounds.toolTrustOrigin;
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
    // C3(a): assistant-round counter — used by the maxRounds break below.
    let assistantRoundsRun = 0;
    // finish_reason=length CONTINUATION carry. While a logical answer is being
    // continued across rounds we accumulate its raw text + reasoning here and
    // DEFER the history append + onAssistantRound until the chain terminates —
    // so the user sees ONE coherent answer and history holds ONE assistant
    // message. `continuationPrefillText !== undefined` ⇒ next round continues.
    let continuationsRun = 0;
    let continuationCarryText = "";
    let continuationCarryThought = "";
    let continuationPrefillText: string | undefined = undefined;
    // C3(a): effective round budget. Default = MAX_TOOL_ROUNDS (30); when a
    // caller supplies maxRounds (sub-agent runner) clamp to it. Negative or
    // zero falls back to default so callers keep working unchanged.
    const requestedMaxRounds = bounds?.maxRounds;
    const effectiveMaxRounds =
      typeof requestedMaxRounds === "number" && Number.isFinite(requestedMaxRounds) && requestedMaxRounds > 0
        ? Math.min(MAX_TOOL_ROUNDS, Math.floor(requestedMaxRounds))
        : MAX_TOOL_ROUNDS;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      // C3(a): hard guard between rounds — if we have already executed
      // `effectiveMaxRounds` assistant turns, stop cleanly and return the
      // last text. This is the loop-boundary defense for agent_spawn
      // turn caps; abortCurrentTurn remains the user-cancel path.
      if (assistantRoundsRun >= effectiveMaxRounds) {
        // EARLY-EXIT #1: round cap hit. 이 자리에서 *조용히* synthetic 텍스트
        // 를 반환하면 사용자는 "왜 갑자기 끊겼지?" 의문. WARN 로그 + UI 콜백으로
        // 명시적 신호.
        log.warn(
          `queryLoop: EARLY-EXIT(round-cap) — assistantRoundsRun=${assistantRoundsRun} effectiveMaxRounds=${effectiveMaxRounds} totalToolCalls=${allToolCalls.length}`,
        );
        callbacks?.onError?.(
          t("be_conversationLoop.roundCapError", { max: effectiveMaxRounds }),
        );
        // stopReason "round-cap" flags this as a BUDGET-hit termination, not a
        // natural end_turn: the returned text is the partial work so far. The
        // sub-agent runner reads this to mark its result `incomplete`, and the
        // main-chat renderer / notification path can treat it as "cut off, can
        // continue" rather than a finished answer. Return the last real
        // assistant text verbatim (not a synthetic wrapper) so the partial
        // output is preserved for the parent / a follow-up round.
        const lastAssistantText =
          self.history
            .getMessages()
            .filter((m) => m.role === "assistant")
            .slice(-1)[0]?.content ?? "";
        return withServingIdentity({
          text: typeof lastAssistantText === "string" && lastAssistantText.length > 0
            ? lastAssistantText
            : t("be_conversationLoop.roundCapError", { max: effectiveMaxRounds }),
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
      if (round > 0 && self.guidanceQueue.length > 0 && continuationPrefillText === undefined) {
        // Truncate from the head — preserve the user's MOST RECENT guides
        // since older queued items may have been superseded. Worst case
        // (16 × 8000 chars = 128KB joined) is capped at
        // `GUIDE_JOINED_MAX_CHARS` and the truncation is surfaced via a
        // leading marker so the LLM doesn't get confused by missing
        // context.
        let joined = self.guidanceQueue.join("\n\n");
        let truncatedCount = 0;
        const kept = [...self.guidanceQueue];
        while (joined.length > GUIDE_JOINED_MAX_CHARS && kept.length > 1) {
          kept.shift();
          truncatedCount += 1;
          joined = kept.join("\n\n");
        }
        if (truncatedCount > 0) {
          joined = t("be_conversationLoop.guidanceTruncationMarker", { count: truncatedCount, joined });
        }
        self.guidanceQueue = [];
        const injectedContent = t("be_conversationLoop.guidanceInjectionHeader", { joined });
        // Critic round 2 M1: run preflight BEFORE appending the guide so
        // compaction targets the older history and never accidentally
        // summarizes-away the just-injected guide marker. `joined` is
        // capped at GUIDE_MAX_ENTRIES × GUIDE_MAX_CHARS = 128KB chars
        // (≈ 30K tokens worst case) but typical use is < 1K tokens —
        // well below the post-compact preserveRecent budget, so the
        // next round's prompt-assembly will fit.
        if (self.provider && !self.deps.disableSessionPersistence) {
          const compacted = await self.runPreflightGuard(
            {
              systemPrompt,
              toolSchemas,
              estimateCurrent: () => self.estimateCurrentRequestProjection({
                systemPrompt: self.buildSystemPromptForScope(
                  scope,
                  overlayTriggerOrigin,
                  bounds.rolePrompt,
                  bounds.sessionIdOverride ?? self.sessionId,
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
              overlayTriggerOrigin,
              bounds.rolePrompt,
              bounds.sessionIdOverride ?? self.sessionId,
            );
          }
        }
        self.history.append({
          role: "user",
          content: injectedContent,
        });
        callbacks?.onGuidanceInjected?.(joined);
        self.tracer.step("GUIDANCE_INJECTED", { round, len: joined.length });
      }

      const repaired = self.history.repairToolPairInvariant();
      if (repaired.removedMessages > 0 || repaired.removedToolCalls > 0) {
        log.warn(
          `queryLoop: repaired invalid tool history before provider call (removedMessages=${repaired.removedMessages}, removedToolCalls=${repaired.removedToolCalls})`,
        );
      }

      // ─── Stream attempt — token preflight 가 사전 압축 처리하므로 mid-loop retry 없음 ───
      const baseMessagesForRound = self.history.getMessages();
      // finish_reason=length CONTINUATION: when continuing, append a WIRE-ONLY
      // partial assistant turn (NOT persisted to history) as the final message.
      // The openai-compatible adapter pairs this with continue_final_message so
      // vLLM resumes it verbatim. For mid-<think> truncation the prefill text is
      // `<think>\n…` (open, no closing tag) so the model finishes reasoning
      // before answering; add_generation_prompt:false blocks a 2nd auto <think>.
      const messagesForRound =
        continuationPrefillText !== undefined
          ? [
              ...baseMessagesForRound,
              { role: "assistant" as const, content: continuationPrefillText },
            ]
          : baseMessagesForRound;
      self.lastRoundInputProjection = estimateRequestInputProjection({
        systemPrompt,
        messages: messagesForRound,
        toolSchemas,
      });
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
        configuredProvider: llmSettings.provider,
        model,
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
      const stream = await collectRoundStream({
        provider: turnProvider,
        model,
        systemPrompt,
        messages: messagesForRound,
        toolSchemas,
        llmSettings: { ...activeBlock, streamSmoothing: llmSettings.streamSmoothing },
        abortSignal,
        continuationPrefill: continuationPrefillText !== undefined,
        onReasoningDelta: callbacks?.onReasoningDelta,
        onTextDelta: callbacks?.onTextDelta,
      });
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
          // Retry the round with the offending tool removed. Does NOT count as
          // an assistant round (assistantRoundsRun is unchanged); the for-loop
          // `round` counter + MAX_TOOL_ROUNDS still bound total iterations.
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
            { forceReason: "rate-limit" },
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
        callbacks?.onError?.(stream.userMessage, "stream-error");
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
        return withServingIdentity({ text: stream.userMessage, toolCalls: allToolCalls, usage: turnUsage, stopReason: "stream-error" });
      }

      if (stream.kind === "interrupted") {
        // EARLY-EXIT #3: 사용자 abort. abortCurrentTurn() 또는 외부 abortSignal.
        // 정상 케이스이지만 빈도 추적용 로그.
        log.info(
          `queryLoop: EARLY-EXIT(interrupted) — round=${roundIndex} priorTextLen=${(stream.text ?? "").length}`,
        );
        // Strip suggested-replies block before persistence — otherwise raw
        // `<suggested_replies>` tags would land in ~/.lvis/sessions/*.jsonl
        // and be fed back to the LLM on every subsequent turn.
        //
        // interrupted is *user-initiated* not a host error, so we do NOT
        // attach systemNotice — the assistant content that was streamed
        // before the abort is real model output and stays styled normally;
        // only the "[중단됨]" suffix marks the boundary.
        const interruptedSuffix = t("be_conversationLoop.interruptedSuffix");
        // length-continuation: if the user aborts mid-chain, prepend the raw
        // accumulated prefix so the persisted + returned text is the full
        // partial answer, not just the last continuation round. Strip the
        // suggested-replies block ONCE on the merged raw text (carry is "" on a
        // non-continued turn ⇒ identical to the prior behavior).
        const savedText = stripSuggestedReplies(continuationCarryText + (stream.text ?? "")) + interruptedSuffix;
        self.history.append({ role: "assistant", content: savedText });
        callbacks?.onTextDelta?.(interruptedSuffix);
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
      if (stream.usage) {
        const u = stream.usage;
        const cacheRead = u.cacheReadTokens ?? 0;
        const cacheWrite = u.cacheWriteTokens ?? 0;
        const adjustedIn = Math.max(0, u.inputTokens - cacheRead - cacheWrite);

        // Last-round overwrite. runTurn uses this as the provider-calibration
        // anchor for turn_summary.tokensIn; billing 합산은 turnUsage.inputTokens /
        // cumulativeUsage 가 별도 추적.
        self.lastRoundProviderInputTokens = u.inputTokens;
        self.lastContextInputTokens = u.inputTokens;
        self.lastContextInputProjectionTokens = self.lastRoundInputProjection?.totalTokens ?? 0;

        turnUsage = {
          inputTokens: (turnUsage?.inputTokens ?? 0) + u.inputTokens,
          outputTokens: (turnUsage?.outputTokens ?? 0) + u.outputTokens,
          cacheReadTokens: (turnUsage?.cacheReadTokens ?? 0) + cacheRead,
          cacheWriteTokens: (turnUsage?.cacheWriteTokens ?? 0) + cacheWrite,
        };
        addUsageForServingModel({
          inputTokens: u.inputTokens,
          outputTokens: u.outputTokens,
          cacheReadTokens: cacheRead,
          cacheWriteTokens: cacheWrite,
        });

        self.cumulativeUsage.inputTokens += adjustedIn;
        self.cumulativeUsage.outputTokens += u.outputTokens;
        self.cumulativeUsage.cacheReadTokens =
          (self.cumulativeUsage.cacheReadTokens ?? 0) + cacheRead;
        self.cumulativeUsage.cacheWriteTokens =
          (self.cumulativeUsage.cacheWriteTokens ?? 0) + cacheWrite;
      }

      const { text: streamText, thought: thoughtContent, thinkingBlocks: roundThinkingBlocks, toolCalls: pendingToolCalls, stopReason } = stream;
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
        vendorSupportsLengthContinuation(llmSettings.provider) &&
        continuationsRun < MAX_LENGTH_CONTINUATIONS &&
        assistantRoundsRun + 1 < effectiveMaxRounds &&
        madeProgress;

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

      // thinkingBlocks는 tool_use 체인이 이어지는 다음 요청에만 signature 그대로 포함되어야 Anthropic이 수락한다.
      const preserveThinkingBlocks = stopReason === "tool_use" && pendingToolCallsCapped.length > 0;
      // Persist the MERGED answer (carry + this round). Non-continued turns have
      // empty carries ⇒ original single-round content.
      self.history.append({
        role: "assistant",
        content: wasCapped ? `${mergedText}\n\n[capped at ${MAX_TOOL_CALLS_PER_ROUND} of ${pendingToolCalls.length} tool_use blocks]` : mergedText,
        ...(mergedThought && { thought: mergedThought }),
        ...(preserveThinkingBlocks && roundThinkingBlocks.length > 0 && { thinkingBlocks: roundThinkingBlocks }),
        // Persist only the capped slice — these are the only blocks
        // that will receive a matching tool_result. Streaming UI still sees
        // the un-capped count below via the assistant-round callback so the
        // user can observe the original LLM intent (and the cap message).
        ...(pendingToolCallsCapped.length > 0 && { toolCalls: pendingToolCallsCapped }),
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
      const toolUses: ToolUseBlock[] = pendingToolCallsCapped.map((tc) => ({
        id: tc.id, name: tc.name, input: tc.input,
      }));

      // Snapshot the session-activation set so we can audit exactly the
      // disabled plugins this turn newly session-activated (one event each).
      const sessionActivatedBefore = new Set(self.sessionActivatedPluginIds);
      const pluginOutcome = handleRequestPlugin(toolUses, {
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
      toolUsesForExecutor = searchOutcome.remaining;
      searchPromotedThisRound = searchOutcome.promotedToolNames.length > 0;
      promotedToolNamesForTurn.push(...searchOutcome.promotedToolNames);

      const rebuiltAfterSearch = searchOutcome.promotedToolNames.length > 0;
      if (rebuiltAfterSearch) {
        toolSchemas = rebuildTurnToolSchemas();
      }
      const addedBySearch = Math.max(0, toolSchemas.length - prevToolCountForSearch);
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

      // §11 knowledge depth cap
      const capResult = applyKnowledgeDepthCap(toolUsesForExecutor, knowledgeCallCount);
      knowledgeCallCount = capResult.nextCount;

      // §4.5.2 step 9 — TOOL_EXECUTE
      self.tracer.step("TOOL_EXECUTE", {
        round: roundIndex,
        toolNames: capResult.allowed.map((tu) => tu.name),
        capped: capResult.blocked.length,
      });
      const toolResults = await self.toolExecutor.executeAll(
        capResult.allowed,
        {
          callbacks: {
            onToolStart: (name, input, meta) => {
              toolMetaByUseId.set(meta.toolUseId, meta);
              callbacks?.onToolStart?.(name, input, meta);
            },
            onPermissionReview: callbacks?.onPermissionReview,
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
          // modal — the hard gate for the overlay trigger's propose-only contract.
          overlayTriggerOrigin: overlayTriggerOrigin ?? null,
          // C3(b): carry spawn depth into ToolExecutionContext.metadata.
          // The executor uses this to refuse `agent_spawn` calls inside an
          // already-spawned sub-agent (depth >= 1).
          spawnDepth: bounds?.spawnDepth,
          // Threading the turn's abort signal lets long-blocking tools
          // (`ask_user_question`) honor the user's 중단 button instead of
          // hanging until their internal timeout.
          abortSignal,
          toolResultChunkReader: (toolUseId) => self.readToolResultForChunk(toolUseId),
          permissionContext: {
            headless: self.deps.headless,
            allowedPluginIds: new Set(scope.activePluginIds),
            additionalDirectories: self.getTurnAdditionalDirectories(),
            getAdditionalDirectories: () => self.getTurnAdditionalDirectories(),
            trustOrigin: toolTrustOrigin,
            ...(bounds.permissionUserIntent ? { userIntent: bounds.permissionUserIntent } : {}),
            ...(bounds.permissionExplicitAuthorizationIntent
              ? { explicitAuthorizationIntent: bounds.permissionExplicitAuthorizationIntent }
              : {}),
            onTurnDirectoryGrant: (path) => self.addTurnAdditionalDirectory(path),
            onSessionDirectoryGrant: (path) => self.addSessionAdditionalDirectory(path),
          },
        },
      );
      toolTrustOrigin = nextToolTrustOrigin(toolTrustOrigin, capResult.allowed, toolResults);

      for (let i = 0; i < capResult.allowed.length; i++) {
        allToolCalls.push({
          name: capResult.allowed[i].name,
          input: capResult.allowed[i].input,
          result: toolResults[i]?.content ?? "(missing)",
        });
      }
      for (const blocked of capResult.blocked) {
        const origTool = toolUsesForExecutor.find((tu) => tu.id === blocked.tool_use_id);
        if (origTool) {
          allToolCalls.push({ name: origTool.name, input: origTool.input, result: blocked.content });
        }
      }

      // tool_result 히스토리 append → loop back
      const allResults = [...toolResults, ...capResult.blocked];
      for (const tr of allResults) {
        const meta = toolMetaByUseId.get(tr.tool_use_id);
        const toolDisplay = "durationMs" in tr
          ? {
              durationMs: tr.durationMs,
              ...(meta?.source ? { source: meta.source } : {}),
              ...(meta?.category ? { category: meta.category } : {}),
              ...(meta?.pluginId ? { pluginId: meta.pluginId } : {}),
              ...(meta?.mcpServerId ? { mcpServerId: meta.mcpServerId } : {}),
              ...("uiPayload" in tr && tr.uiPayload ? { uiPayload: tr.uiPayload } : {}),
            }
          : undefined;
        self.history.append({
          role: "tool_result",
          toolUseId: tr.tool_use_id,
          toolName: toolUsesForExecutor.find((tu) => tu.id === tr.tool_use_id)?.name,
          content: tr.content,
          ...(tr.is_error && { isError: true }),
          ...(toolDisplay ? { meta: { toolDisplay } } : {}),
        });
      }
      if (abortSignal?.aborted) {
        log.info(
          `queryLoop: EARLY-EXIT(tool-abort) — round=${roundIndex} toolResults=${allResults.length}`,
        );
        const savedText = t("be_conversationLoop.interruptedText");
        self.history.append({ role: "assistant", content: savedText });
        callbacks?.onTextDelta?.(t("be_conversationLoop.interruptedSuffix"));
        return withServingIdentity({
          text: savedText,
          toolCalls: allToolCalls,
          usage: turnUsage,
          stopReason: "interrupted",
        });
      }
      // Intra-turn micro-compact — mark older tool_results stale before the
      // next round assembles its request (`messagesForRound`), so the next
      // provider send stubs them on the wire. Mirrors the sub-agent fallback
      // mark (clear()/restore() atomic swap). Gated on the already-computed
      // per-round projection to skip short turns; the threshold SOT is
      // getModelPreflightThreshold so no literal is introduced.
      const microCompactFloor = Math.floor(
        getModelPreflightThreshold(llmSettings.provider, model) * MICRO_COMPACT_FLOOR_FACTOR,
      );
      if (
        microCompactFloor > 0 &&
        (self.lastRoundInputProjection?.totalTokens ?? 0) >= microCompactFloor
      ) {
        const { messages: afterMark, result: mr } = markStaleToolResults(
          self.history.getMessages(),
          { preserveRecentToolResults: INTRA_TURN_PRESERVE_RECENT_RESULTS },
        );
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
      if (capResult.allowed.some((tu) => tu.name === "skill_load")) {
        systemPrompt = self.buildSystemPromptForScope(
          scope,
          overlayTriggerOrigin,
          bounds.rolePrompt,
          bounds.sessionIdOverride ?? self.sessionId,
        );
      }
    }

    // Outer for-loop bound (MAX_TOOL_ROUNDS) exhausted — reachable when
    // meta-tool refunds (`round--`) iterate the loop past 30 while
    // assistantRoundsRun stays under the cap. Same class as the assistantRounds
    // early-exit above: a budget-hit, not a natural end_turn — flag it so the
    // sub-agent runner marks the result incomplete.
    return withServingIdentity({ text: t("be_conversationLoop.toolRoundLimitExceeded"), toolCalls: allToolCalls, usage: turnUsage, stopReason: "round-cap" });
  }
