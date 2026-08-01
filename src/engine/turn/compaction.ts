/**
 * Compaction path.
 *
 * manualCompact (`/compact`) / runPreflightGuard (token preflight + force-
 * recover + rate-limit recovery) / applyBoundaryToSession (boundary apply +
 * checkpoint persist). Free functions over a `self: ConversationLoop`
 * this-shaped param — all mutable compaction state stays on the instance.
 */
import type { ConversationLoop } from "../conversation-loop.js";
import type {
  CompactTriggerSource,
  PreflightGuardOptions,
  RequestProjectionContext,
  TurnCallbacks,
} from "./types.js";
import { compactWithBoundary, DEFAULT_PRESERVE_RECENT_TURNS, renderBoundaryAsPreamble } from "../structured-compact.js";
import { CompressionStatus } from "../../shared/compact-status.js";
import { estimateMessagesTokens, getModelPreflightThreshold, getModelUsableContext } from "../auto-compact.js";
import { compactedHistoryWithContextCarrier, contentTruncatedHistoryWithContextCarrier } from "./context-carrier.js";
import { t } from "../../i18n/index.js";
import { createLogger } from "../../lib/logger.js";
import { getLlmVendorSettings } from "../../shared/llm-vendor-defaults.js";
import { getPreflightThreshold, getUsableContext } from "../../shared/context-budget.js";
import type { SubscriptionChatRuntimeSelection } from "../../shared/subscription-runtime.js";

const log = createLogger("lvis");

// ACP runtimes do not expose a trustworthy model-context descriptor. Keep a
// conservative independent budget rather than accidentally inheriting an
// inactive API-key provider's potentially much larger context window.
const SUBSCRIPTION_FALLBACK_CONTEXT_WINDOW = 64_000;
const SUBSCRIPTION_FALLBACK_PREFLIGHT = getPreflightThreshold(
  SUBSCRIPTION_FALLBACK_CONTEXT_WINDOW,
);
const SUBSCRIPTION_FALLBACK_USABLE_CONTEXT = getUsableContext(
  SUBSCRIPTION_FALLBACK_CONTEXT_WINDOW,
);

interface RuntimeContextBudget {
  readonly model: string;
  readonly preflight: number;
  readonly usableContext: number;
  readonly identity: string;
}

function safeReportedContextBudget(
  contextWindow: number | undefined,
): Pick<RuntimeContextBudget, "preflight" | "usableContext"> | undefined {
  if (typeof contextWindow !== "number" || !Number.isSafeInteger(contextWindow) || contextWindow <= 0) return undefined;
  const usableContext = getUsableContext(contextWindow);
  const preflight = getPreflightThreshold(contextWindow);
  // A malformed tiny provider window must not turn the preflight guard off.
  return usableContext > 0 && preflight > 0 ? { preflight, usableContext } : undefined;
}

/**
 * A Codex sub-agent may carry a profile-model candidate paired with the active
 * Codex selection as its same-runtime fallback. The engine's provider marker
 * cannot receive the asynchronous live-catalog resolution result, so both
 * valid and stale candidates deliberately use the 64K subscription budget for
 * the whole child loop. This prevents candidate pricing metadata from ever
 * deferring compaction beyond the verified parent model's unknown capacity.
 */
function hasPendingCodexProfileFallback(
  self: ConversationLoop,
  subscriptionRuntime: SubscriptionChatRuntimeSelection,
): boolean {
  if (subscriptionRuntime.provider !== "codex" || subscriptionRuntime.model === undefined) return false;
  const activeChatRuntime = self.deps.settingsService.get("llm").activeChatRuntime;
  return activeChatRuntime?.kind === "subscription"
    && activeChatRuntime.provider === "codex"
    && activeChatRuntime.model !== subscriptionRuntime.model;
}

export function contextBudgetForCurrentRuntime(self: ConversationLoop): RuntimeContextBudget {
  const subscriptionRuntime = self.provider?.subscriptionRuntime;
  if (subscriptionRuntime) {
    const model = subscriptionRuntime.model ?? "default";
    if (subscriptionRuntime.provider === "codex" && subscriptionRuntime.model) {
      if (hasPendingCodexProfileFallback(self, subscriptionRuntime)) {
        return {
          model,
          preflight: SUBSCRIPTION_FALLBACK_PREFLIGHT,
          usableContext: SUBSCRIPTION_FALLBACK_USABLE_CONTEXT,
          identity: `subscription:codex/${model}`,
        };
      }
      // Codex catalog model IDs are OpenAI model IDs, but remain isolated from
      // the user's inactive API-key configuration and pricing accounting.
      const catalogPreflight = getModelPreflightThreshold("openai", model);
      const catalogUsableContext = getModelUsableContext("openai", model);
      const reported = self.lastReportedSubscriptionContextWindow;
      const reportedBudget = safeReportedContextBudget(
        reported?.provider === "codex" && reported.model === model
          ? reported.contextWindow
          : undefined,
      );
      // A matching terminal Codex report may make the catalog budget more
      // conservative, never larger. Invalid/tiny reports retain the catalog
      // threshold so a malformed external value cannot disable preflight.
      return {
        model,
        preflight: reportedBudget
          ? Math.min(catalogPreflight, reportedBudget.preflight)
          : catalogPreflight,
        usableContext: reportedBudget
          ? Math.min(catalogUsableContext, reportedBudget.usableContext)
          : catalogUsableContext,
        identity: `subscription:codex/${model}`,
      };
    }
    return {
      model,
      preflight: SUBSCRIPTION_FALLBACK_PREFLIGHT,
      usableContext: SUBSCRIPTION_FALLBACK_USABLE_CONTEXT,
      identity: `subscription:${subscriptionRuntime.provider}/${model}`,
    };
  }

  const llmSettings = self.deps.settingsService.get("llm");
  const provider = llmSettings.provider;
  const model = getLlmVendorSettings(llmSettings.vendors, provider).model;
  return {
    model,
    preflight: getModelPreflightThreshold(provider, model),
    usableContext: getModelUsableContext(provider, model),
    identity: `${provider}/${model}`,
  };
}




const MAX_FORCE_RECOVER_PER_SESSION = 3;

export async function manualCompact(self: ConversationLoop, callbacks?: Pick<TurnCallbacks, "onCompactOccurred" | "onCompactStarted">): Promise<{
    compacted: boolean;
    compactedAt: string | null;
    summary: string;
    removedMessageCount: number;
  }> {
    if (!self.provider) {
      return {
        compacted: false,
        compactedAt: null,
        summary: t("be_conversationLoop.manualCompactNoProvider"),
        removedMessageCount: 0,
      };
    }
    if (self.isCompacting) {
      return {
        compacted: false,
        compactedAt: null,
        summary: t("be_conversationLoop.manualCompactAlreadyRunning"),
        removedMessageCount: 0,
      };
    }

    const { model, preflight } = contextBudgetForCurrentRuntime(self);
    const preserveRecentTokens = Math.max(1_000, Math.floor(preflight * 0.4));

    self.isCompacting = true;
    try {
      const messagesBefore = self.history.getMessages();
      const scope = self.resolveToolScope("");
      const toolSchemas = self.rebuildToolSchemas(scope);
      const projectionContext = self.createRequestProjectionContext(scope, null, undefined, toolSchemas);
      const requestProjection = projectionContext.estimateCurrent();
      // Mirror runPreflightGuard's pre-compact UX hint so slash-`/compact`

      // potentially long-running LLM summarization.
      callbacks?.onCompactStarted?.({
        triggerSource: "manual",
        estimatedBefore: requestProjection.totalTokens,
        preflight,
      });
      // ── #811 m2: PreCompact (NON-BLOCKING) ── manual `/compact` path.
      await self.fireLifecycleEvent("PreCompact", {
        reason: "manual",
        tokenEstimate: requestProjection.totalTokens,
      });
      const messagesBeforeCount = messagesBefore.length;
      const tokensBefore = requestProjection.totalTokens;
      const result = await compactWithBoundary({
        messages: messagesBefore,
        llm: self.provider,
        model,
        preserveRecentTokens,
        preserveRecentTurns: DEFAULT_PRESERVE_RECENT_TURNS,
        compactNum: self.compactNum + 1,
        sessionId: self.sessionId,
        preflightTokens: preflight,
      });

      if (result.status === CompressionStatus.NOOP) {
        return {
          compacted: false,
          compactedAt: null,
          summary: t("be_conversationLoop.manualCompactNoop"),
          removedMessageCount: 0,
        };
      }

      await applyBoundaryToSession(self,
        result,
        "manual",
        requestProjection.totalTokens,
        callbacks,
        messagesBefore.length,
        messagesBefore,
        projectionContext,
      );

      // ── #811 m2: PostCompact (NON-BLOCKING) ── manual path, after apply.
      await self.fireLifecycleEvent("PostCompact", {
        messagesBefore: messagesBeforeCount,
        messagesAfter: self.history.getMessages().length,
        tokensBefore,
        tokensAfter: self.lastContextInputTokens,
      });


      void Promise.resolve(
        self.deps.memoryManager?.saveSession(self.sessionId, self.history.getMessages()),
      ).catch((err: unknown) => {
        log.warn("manualCompact saveSession failed: %s", (err as Error).message);
      });

      const compactedAt = result.boundary?.createdAt ?? new Date().toISOString();
      const summary = result.status === CompressionStatus.CONTENT_TRUNCATED
        ? t("be_conversationLoop.manualCompactSummaryTruncated", { count: result.removedCount })
        : result.status === CompressionStatus.REDUCED_INSUFFICIENT_FORCED
        ? t("be_conversationLoop.manualCompactSummaryForced", { count: result.removedCount, num: self.compactNum })
        : t("be_conversationLoop.manualCompactSummarySummarized", { count: result.removedCount, num: self.compactNum });
      return {
        compacted: true,
        compactedAt,
        summary,
        removedMessageCount: result.removedCount,
      };
    } catch (err) {
      log.error("manualCompact failed: %s", (err as Error).message);
      // Return safe result rather than bubbling — prevents unhandled IPC rejection.
      // `/compact` command handler and callers get a user-visible failure message.
      return {
        compacted: false,
        compactedAt: null,
        summary: t("be_conversationLoop.manualCompactFailed", { message: (err as Error).message }),
        removedMessageCount: 0,
      };
    } finally {
      self.isCompacting = false;
    }
  }

export async function applyBoundaryToSession(
  self: ConversationLoop,
    result: import("../structured-compact.js").CompactWithBoundaryResult,
    trigger: "auto-compact" | "manual",
    estimatedBefore: number,
    callbacks: TurnCallbacks | undefined,

    prevMessageCount: number,
    /** §C1: verbatim pre-compact messages — persisted as checkpoint snapshot for branchFromCheckpoint. */
    messagesBefore: import("../llm/types.js").GenericMessage[],
    projectionContext: RequestProjectionContext,
  ): Promise<void> {


    if (result.boundary === null) {
      self.compactNum += 1;
      let truncated = contentTruncatedHistoryWithContextCarrier({
        messages: result.newHistory,
        compactNum: self.compactNum,
        trigger,
        removedCount: result.removedCount,
        estimatedAfter: result.estimatedAfter,
        freedTokens: Math.max(0, estimatedBefore - result.estimatedAfter),
        ...(result.truncatedDir !== undefined ? { truncatedDir: result.truncatedDir } : {}),
      });
      self.history.clear();
      self.history.restore(truncated.history);
      const contextTokensAfter = projectionContext.estimateCurrent().totalTokens;
      const freedTokens = Math.max(0, estimatedBefore - contextTokensAfter);
      truncated = contentTruncatedHistoryWithContextCarrier({
        messages: result.newHistory,
        compactNum: self.compactNum,
        trigger,
        removedCount: result.removedCount,
        freedTokens,
        estimatedAfter: contextTokensAfter,
        ...(result.truncatedDir !== undefined ? { truncatedDir: result.truncatedDir } : {}),
      });
      try {
        await self.deps.memoryManager.saveCheckpointSnapshot(
          self.sessionId,
          self.compactNum,
          messagesBefore,
        );
        const { usableContext: usable } = contextBudgetForCurrentRuntime(self);
        const ctxUsageAtTrigger = usable > 0 ? Math.min(1.0, estimatedBefore / usable) : 0;
        const checkpointEntry: import("../../memory/memory-manager.js").Checkpoint = {
          id: crypto.randomUUID(),
          triggeredAt: truncated.createdAt,
          trigger,
          ctxUsageAtTrigger,
          summary: t("be_conversationLoop.contentTruncatedSummary", { count: result.removedCount }),
          messageCountAtTrigger: prevMessageCount,
          compactNum: self.compactNum,
        };
        const existingMeta = self.deps.memoryManager.loadSessionMetadata(self.sessionId) ?? {};
        const updatedMeta = self.deps.memoryManager.appendCheckpoint(existingMeta, checkpointEntry);
        await self.deps.memoryManager.saveSessionMetadata(self.sessionId, updatedMeta);
      } catch (storageErr) {
        log.warn(`applyBoundaryToSession: content-truncated checkpoint persist failed — ${(storageErr as Error).message}`);
      }
      self.history.clear();
      self.history.restore(truncated.history);
      self.cumulativeUsage = {
        ...self.cumulativeUsage,
        inputTokens: truncated.contextTokensAfter,
      };
      self.lastContextInputTokens = truncated.contextTokensAfter;
      self.lastContextInputProjectionTokens = truncated.contextTokensAfter;
      callbacks?.onCompactOccurred?.({
        removedMessages: result.removedCount,
        freedTokens,
        trigger,
        compactNum: self.compactNum,
        summary: t("be_conversationLoop.contentTruncatedSummary", { count: result.removedCount }),
        estimatedAfter: truncated.contextTokensAfter,
        compactStatus: result.status,
        ...(result.truncatedDir !== undefined ? { truncatedDir: result.truncatedDir } : {}),
      });
      return;
    }

    self.compactNum = result.boundary.compactNum;

    // Persist pre-compact history so branchFromCheckpoint can replay. saveCheckpointSnapshot
    // owns JSONL stubbing and file-backed artifacts for oversized tool results.
    // Failure is non-fatal — warn and continue; branch-from-checkpoint will surface the
    // "no snapshot found" error at use-time rather than silently corrupting a compact.
    try {
      await self.deps.memoryManager.saveCheckpointSnapshot(
        self.sessionId,
        self.compactNum,
        messagesBefore,
      );
    } catch (snapshotErr) {
      log.warn(`applyBoundaryToSession: saveCheckpointSnapshot failed — ${(snapshotErr as Error).message}`);
    }

    const preamble = renderBoundaryAsPreamble(result.boundary);
    let compactedHistory = compactedHistoryWithContextCarrier(result.newHistory, result.estimatedAfter);
    self.history.clear();
    self.history.restore(compactedHistory);
    self.deps.systemPromptBuilder.setSummaryPreamble?.(preamble);
    const contextTokensAfter = projectionContext.estimateCurrent().totalTokens;
    compactedHistory = compactedHistoryWithContextCarrier(result.newHistory, contextTokensAfter);
    self.history.clear();
    self.history.restore(compactedHistory);
    self.cumulativeUsage = {
      inputTokens: contextTokensAfter,
      outputTokens: self.cumulativeUsage.outputTokens,
      ...(self.cumulativeUsage.cacheReadTokens !== undefined && { cacheReadTokens: 0 }),
      ...(self.cumulativeUsage.cacheWriteTokens !== undefined && { cacheWriteTokens: 0 }),
    };
    self.lastContextInputTokens = contextTokensAfter;
    self.lastContextInputProjectionTokens = contextTokensAfter;

    // Same-session checkpoint chain.
    // ctxUsageAtTrigger 분모는 *usable context window* (LVIS reservation 적용).
    try {
      const { usableContext: usable } = contextBudgetForCurrentRuntime(self);
      const ctxUsageAtTrigger = usable > 0 ? Math.min(1.0, estimatedBefore / usable) : 0;
      const checkpointEntry: import("../../memory/memory-manager.js").Checkpoint = {
        id: crypto.randomUUID(),
        triggeredAt: result.boundary.createdAt,
        trigger,
        ctxUsageAtTrigger,
        summary: preamble,
        messageCountAtTrigger: prevMessageCount,
        compactNum: self.compactNum,
      };
      const existingMeta = self.deps.memoryManager.loadSessionMetadata(self.sessionId) ?? {};
      const updatedMeta = self.deps.memoryManager.appendCheckpoint(existingMeta, checkpointEntry);
      await self.deps.memoryManager.saveSessionMetadata(self.sessionId, {
        ...updatedMeta,
        summaryPreamble: preamble,
      });
    } catch (storageErr) {
      log.warn(`applyBoundaryToSession: checkpoint persist failed — ${(storageErr as Error).message}`);
    }

    callbacks?.onCompactOccurred?.({
      removedMessages: result.removedCount,
      freedTokens: Math.max(0, estimatedBefore - contextTokensAfter),
      estimatedAfter: contextTokensAfter,
      trigger,
      summary: preamble,
      compactNum: self.compactNum,
      compactStatus: result.status,
      ...(result.truncatedDir !== undefined ? { truncatedDir: result.truncatedDir } : {}),
    });
  }

export async function runPreflightGuard(
  self: ConversationLoop,
    projectionContext: RequestProjectionContext,
    abortSignal?: AbortSignal,
    callbacks?: TurnCallbacks,
    options?: PreflightGuardOptions,
  ): Promise<boolean> {
    // Issue #910 follow-up — prior turn ended with context_error / stream_error
    // and the user-facing message promised auto-compact on the next send.
    // Force-trigger compact regardless of threshold + autoCompact setting:
    // the host's promise overrides the user's compact-off preference for this
    // single recovery cycle (otherwise the conversation is unrecoverable
    // without manual /compact). Flag clears in `finally` so every path
    // (success / NOOP / throw) keeps the "single cycle = single clear"
    // invariant.
    //
    // DoS guard (round-4 security MED): if the same session has already
    // burned through MAX_FORCE_RECOVER_PER_SESSION recovery attempts without
    // the user being able to make progress, stop force-triggering — the
    // failure is structural (compact cannot reduce, or input pattern keeps
    // hitting the limit) and further attempts just multiply API cost.
    const overRecoveryBudget = self.contextErrorRecoveryCount >= MAX_FORCE_RECOVER_PER_SESSION;
    const forceRecover = self.contextErrorPending && !overRecoveryBudget;
    const forceRateLimit = options?.forceReason === "rate-limit";
    if (self.contextErrorPending && overRecoveryBudget) {
      log.warn(
        `preflight: force-recover BUDGET EXHAUSTED (count=${self.contextErrorRecoveryCount}/${MAX_FORCE_RECOVER_PER_SESSION}) — blocking all compact API calls`,
      );
      // Issue #917: budget 소진은 compact 가 context 를 줄이지 못하는 구조적
      // 실패이므로 이후 API 호출을 완전 차단한다 (force + normal 모두). 이전
      // 코드는 normal threshold gate 로 fallthrough 해서 여전히 compactWithBoundary
      // 를 호출했는데 이는 DoS hard-cap 을 무력화하는 갭.
      self.contextErrorPending = false;
      self.recoveryExhausted = true;
      callbacks?.onRecoveryExhausted?.();
      return false;
    }
    // Budget 소진 상태면 compact 완전 차단 (re-arm 은 정상 turn 완료 후 reset).
    if (self.recoveryExhausted) {
      log.warn("preflight: recoveryExhausted — all compact API calls blocked until normal turn completes");
      return false;
    }
    if (!forceRecover && !forceRateLimit && !self.isAutoCompactEnabled()) {
    log.debug("runPreflightGuard: skipped (autoCompact setting OFF)");
      return false;
    }
    if (self.isCompacting) {
      log.info("preflight: SKIPPED — isCompacting lock held (concurrent turn race avoided)");
      return false;
    }
    if (!self.provider) return false;

    const { model, preflight, identity } = contextBudgetForCurrentRuntime(self);
    if (!forceRecover && !forceRateLimit && preflight <= 0) return false;

    const messagesBefore = self.history.getMessages();
    const requestProjection = projectionContext.estimateCurrent();
    const estimated = requestProjection.totalTokens;
    // Two-signal preflight: local request projection can drift from provider
    // tokenization. Pair it with the latest provider-calibrated context-fill
    // SOT. Do not use cumulativeUsage here: session billing sums grow every
    // turn and are not a context-window fill metric.
    const pendingInputDelta = self.lastContextInputProjectionTokens > 0
      ? Math.max(0, estimated - self.lastContextInputProjectionTokens)
      : 0;
    const contextTokensIn = self.lastContextInputTokens > 0
      ? self.lastContextInputTokens + pendingInputDelta
      : estimated;
    if (!forceRecover && !forceRateLimit && estimated < preflight && contextTokensIn < preflight) return false;
    const triggerSource: Exclude<CompactTriggerSource, "manual"> = forceRecover
      ? "force-recover"
      : forceRateLimit
        ? "rate-limit"
        : estimated >= preflight
          ? "estimate"
          : "context-tokens";

    self.isCompacting = true;
    // Notify renderer immediately so it can show a "자동 압축 중..." indicator
    // before the blocking LLM compaction call. `onCompactOccurred` fires on
    // completion; this fires at start so there is no silent wait.
    callbacks?.onCompactStarted?.({
      triggerSource,
      estimatedBefore: estimated,
      preflight,
    });
    try {
      log.info(
        `preflight: TRIGGER — source=${triggerSource} estimated=${estimated} contextTokensIn=${contextTokensIn} preflight=${preflight} (model=${identity}) → LLM compact #${self.compactNum + 1}`,
      );
      // Adaptive token-budget preserve — usagePct 가 높을수록 줄인다. 별도 invariant 로
      // compactWithBoundary 가 최근 5 user turn (+ 현재 pending user question)
      // 을 verbatim 보존한다.
      //
      // forceRecover (context_error pending) 및 rate-limit 복구도 동일하게
      // preserve=0 — provider 가
      // 직접 거부한 상황이므로 보수적 preserve 가 의미 없음. 약속한 compact
      // 를 가장 공격적으로 수행하는 게 사용자 약속 정합.
      const preflightPressure = Math.max(estimated, contextTokensIn);
      const usagePct = preflight > 0 ? preflightPressure / preflight : 0;
      const basePreserveRecentTokens = forceRecover || forceRateLimit || usagePct >= 1.0
        ? 0
        : usagePct >= 0.8
          ? Math.max(1_000, Math.floor(preflight * 0.2))
          : Math.max(1_000, Math.floor(preflight * 0.4));
      const latestMessage = messagesBefore.at(-1);
      const currentUserPreserveTokens = latestMessage?.role === "user"
        ? Math.max(1, estimateMessagesTokens([latestMessage]))
        : 0;
      // Step 5 appends the current user turn before preflight runs. Even in
      // red-zone / force-recover compaction, that just-entered user message is
      // part of the visible transcript contract and must survive as verbatim
      // context; otherwise the UI can show an assistant answer with no question.
      const preserveRecentTokens = Math.max(basePreserveRecentTokens, currentUserPreserveTokens);
      // ── #811 m2: PreCompact (NON-BLOCKING) ──
      // Fired right before the blocking LLM compaction. OBSERVE-ONLY — the
      // dispatch result is discarded; a hook can never veto compaction.
      // Payload: reason (auto-compact threshold here) + tokenEstimate.
      await self.fireLifecycleEvent("PreCompact", {
        reason: "auto-compact",
        tokenEstimate: estimated,
      });
      const messagesBeforeCount = messagesBefore.length;
      const tokensBefore = estimated;
      const compactResult = await compactWithBoundary({
        messages: messagesBefore,
        llm: self.provider,
        model,
        preserveRecentTokens,
        preserveRecentTurns: DEFAULT_PRESERVE_RECENT_TURNS,
        compactNum: self.compactNum + 1,
        sessionId: self.sessionId,
        preflightTokens: preflight,
        ...(abortSignal !== undefined && { abortSignal }),
      });

      if (compactResult.status === CompressionStatus.NOOP) {
        log.info("preflight: LLM compact returned NOOP (history within preserveRecentTokens) — no mutation");
        self.lastContextInputTokens = contextTokensIn;
        self.lastContextInputProjectionTokens = estimated;
        // NOOP ⇒ no compaction applied ⇒ no PostCompact (mirrors onCompactOccurred,
        // which only emits when applyBoundaryToSession runs).
        return false;
      }

      // 다음 prompt assembly 가 새 boundary 를 read 해야 함.
      // onCompactOccurred (compactNum 포함) 은 applyBoundaryToSession 안에서 단일 emit.
      // 여기서 두 번째 emit 을 제거해 CheckpointDivider 중복 방지.
      await applyBoundaryToSession(self,
        compactResult,
        "auto-compact",
        estimated,
        callbacks,
        messagesBefore.length,
        messagesBefore,
        projectionContext,
      );

      log.info(
        `preflight: APPLIED — removed=${compactResult.removedCount} estimatedAfter=${compactResult.estimatedAfter} compactNum=${self.compactNum}`,
      );
      // ── #811 m2: PostCompact (NON-BLOCKING) ──
      // Fired AFTER auto-compact applied. OBSERVE-ONLY. Payload: before/after
      // message + token counts. After-counts are read post-mutation.
      await self.fireLifecycleEvent("PostCompact", {
        messagesBefore: messagesBeforeCount,
        messagesAfter: self.history.getMessages().length,
        tokensBefore,
        tokensAfter: self.lastContextInputTokens,
      });
      return true;
    } catch (err) {
      // LLM compact 실패 시 turn 자체는 계속 진행 — compact 미적용 history 로 stream attempt.
      // context_error 도달 시 stream-collector 의 safety net 이 사용자 안내 처리.
      log.warn(`preflight: LLM compact failed — ${(err as Error).message}. Delegating to context_error safety net.`);
      return false;
    } finally {
      self.isCompacting = false;
      // Single-cycle invariant — every force-recover attempt (success /
      // NOOP / throw) clears the flag and bumps the recovery counter.
      // Without this in `finally`, a `compactWithBoundary` throw would
      // leave the flag set and the next turn would force-recover again
      // → indistinguishable from infinite retry (round-4 architect MAJOR).
      if (forceRecover) {
        self.contextErrorPending = false;
        self.contextErrorRecoveryCount += 1;
      }
    }
  }
