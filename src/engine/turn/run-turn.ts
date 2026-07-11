/**
 * runTurn — the top-level turn orchestration, extracted from
 * conversation-loop.ts as a free function over `self: LoopContext`. It threads
 * the turn through classify/route, lifecycle hooks, queryLoop, the post-turn
 * hook chain, and the turn_summary projection. The lastRound/lastContext
 * token-projection fields it reads/writes live on the ConversationLoop
 * instance (via `self`), so turn_summary.tokensIn is computed exactly as before.
 */
import type { LoopContext } from "./loop-context.js";
import type { TurnCallbacks, TurnResult } from "./types.js";
import type { ChatInputOrigin } from "../../shared/chat-origin.js";
import type { ActiveRolePrompt } from "../../data/role-presets.js";
import type { MessageMeta } from "../llm/types.js";
import { queryLoop } from "./query-loop.js";
import { initialToolTrustOrigin, summarizePermissionUserIntent } from "./trust-origin.js";
import { estimateRequestInputProjection, projectNextTurnInputTokens } from "../request-input-projection.js";
import { markStaleToolResults } from "../auto-compact.js";
import { normalizeAiSdkUsageForCost } from "../llm/pricing.js";
import { stripLeadingSlash } from "../../shared/slash-sanitizer.js";
import { isUserKeyboardOrigin } from "../../shared/chat-origin.js";
import { parseImportedTriggerEnvelopePayload } from "../../shared/overlay-trigger-source.js";
import { sessionContext } from "../session-context.js";
import { t } from "../../i18n/index.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger("lvis");

export async function runTurn(
  self: LoopContext,
    input: string,
    callbacks?: TurnCallbacks,
    abortSignal?: AbortSignal,
    options?: {
      /**
       * Multimodal user content parts — appended after the text input as
       * additional content blocks (vision images, files). When omitted the
       * user message is a plain string (current behavior).
       */
      attachments?: import("../llm/types.js").UserContentPart[];
      originSource?: string | null;
      /**
       * C3(a): hard cap on assistant rounds for this turn. When set,
       * queryLoop terminates cleanly between rounds once the cap is hit
       * regardless of tool_use chains the LLM still wants to run. Used by
       * SubAgentRunner to enforce the host-assigned `maxRounds` budget at
       * the loop boundary instead of using user-cancel semantics.
       */
      maxRounds?: number;
      /**
       * C3(c): override session id used by the executor's
       * ToolExecutionContext.metadata.sessionId. SubAgentRunner threads
       * the child session id here so audit entries from the sub-agent's
       * tool calls are attributed to the child, not the parent.
       */
      sessionIdOverride?: string;
      /**
       * C3(b): spawn depth carried through to the executor's metadata.
       * Sub-agents see depth >= 1 and reject any nested agent_spawn call
       * before it reaches the LLM-visible registry.
       */
      spawnDepth?: number;
      /** Internal provenance label prepended to ApprovalGate reasons. */
      approvalReasonPrefix?: string;
      /** DLP-masked durable child messages joined to this turn after the prompt gate. */
      initialGuidance?: string;
      inputOrigin: ChatInputOrigin;
      rolePrompt?: ActiveRolePrompt;
    },
  ): Promise<TurnResult> {
    const effectiveSessionId = options?.sessionIdOverride ?? self.sessionId;
    if (!options?.inputOrigin) {
      throw new Error("ConversationLoop.runTurn requires an explicit inputOrigin");
    }
    const inputOrigin: ChatInputOrigin = options.inputOrigin;
    const turnInput = isUserKeyboardOrigin(inputOrigin) ? input : stripLeadingSlash(input);
    const toolTrustOrigin = initialToolTrustOrigin(inputOrigin, turnInput);
    const permissionUserIntent = summarizePermissionUserIntent(inputOrigin, turnInput);
    const permissionExplicitAuthorizationIntent = isUserKeyboardOrigin(inputOrigin)
      ? permissionUserIntent
      : undefined;
    // Deterministic completed-plan clear: execute any clear the post-turn hook
    // marked for this session. Unconditional (no input-origin gate) so
    // routine/headless turns clear too; unfinished plans were never marked.
    self.deps.sessionTodoStore?.clearIfPending?.(effectiveSessionId);
    self.deps.skillOverlay?.clear(effectiveSessionId);


    self.tracer.step("REQUEST_ENTRY", { inputLen: turnInput.length, inputOrigin });
    if (!self.provider) {
      const err = t("be_conversationLoop.llmProviderNotConfigured");
      callbacks?.onError?.(err);
      throw new Error(err);
    }

    // B4: set up abort controller for this turn
    const ac = new AbortController();
    self.currentAbortController = ac;
    if (abortSignal?.aborted) {
      ac.abort(abortSignal.reason ?? new Error("parent aborted turn"));
    } else {
      abortSignal?.addEventListener(
        "abort",
        () => ac.abort(abortSignal.reason ?? new Error("parent aborted turn")),
        { once: true },
      );
    }
    const turnSignal = ac.signal;



    // §4.5.2 step 2 — KEYWORD_CLASSIFY
    const classification = self.deps.keywordEngine.classify(turnInput);
    self.tracer.step("KEYWORD_CLASSIFY", { type: classification.type });
    // §4.5.2 step 3 — ROUTE_RESOLVE
    const routeResult = self.deps.routeEngine.route(classification);
    self.tracer.step("ROUTE_RESOLVE", { route: routeResult.route });

    if (routeResult.route === "command") {
      self.currentAbortController = null;
      return self.handleCommand(routeResult.command, routeResult.args, inputOrigin, callbacks);
    }

    // §4.5.2 step 4 — TURN_ORCHESTRATE
    self.tracer.step("TURN_ORCHESTRATE", { sessionId: self.sessionId });

    // ── #811 m2: SessionStart (NON-BLOCKING) ──
    // Fired ONCE per session, on its first real conversation turn (past the
    // command-route short-circuit). OBSERVE-ONLY — the dispatch result is
    // discarded. The once-per-session guard keeps "SessionStart" semantics even
    // though runTurn runs every turn.
    if (self.sessionStartFiredFor !== effectiveSessionId) {
      self.sessionStartFiredFor = effectiveSessionId;
      await self.fireLifecycleEvent(
        "SessionStart",
        { sessionMeta: self.sessionMetaForLifecycle() },
        effectiveSessionId,
      );
    }

    // ── #811 m2: UserPromptSubmit (BLOCKING, FAIL-CLOSED) ──
    // Fired AFTER classify/route (above) and BEFORE queryLoop. A trusted
    // `hooks.json` UserPromptSubmit hook can REFUSE this prompt: on a `deny`
    // (or a fail-closed timeout/error/bad-json/spawn-error) the turn is refused
    // and queryLoop NEVER runs. With NO matching trusted hook the dispatch
    // returns `allow` and the turn proceeds byte-identically to today.
    const promptGateInput = options?.initialGuidance
      ? `${turnInput}\n\n${options.initialGuidance}`
      : turnInput;
    const promptGate = await self.fireUserPromptSubmit({
      inputText: promptGateInput,
      inputOrigin,
      route: routeResult.route,
      classification: classification.type,
    }, effectiveSessionId);
    if (promptGate.decision === "deny") {
      // Refuse the turn. Mirror handleCommand's blocked return: surface the
      // refusal text to the renderer, append nothing to history (the prompt
      // was not accepted), and return a TurnResult marked `blocked`. queryLoop
      // is never entered.
      self.currentAbortController = null;
      const refusal = t("be_conversationLoop.userPromptBlocked", {
        reason: promptGate.reason,
      });
      callbacks?.onTextDelta?.(refusal);
      callbacks?.onTurnComplete?.(refusal);
      log.warn(
        `runTurn: UserPromptSubmit hook REFUSED the prompt (turn blocked) — ${promptGate.reason}`,
      );
      return {
        text: refusal,
        toolCalls: [],
        route: routeResult.route,
        stopReason: "blocked",
      };
    }

    // Turn aggregate footer tracking — see TurnCallbacks.onTurnSummary.
    // Wrap the caller-supplied tool callbacks so per-call durationMs (when
    // available on the executor's `meta`) feeds into the cumulative slice
    // without forcing every caller to instrument tool callbacks. The
    // start-time map keys on `toolUseId` so parallel tool calls within a
    // round don't clobber each other. When the executor PR (companion)
    // attaches a `durationMs` field directly to `meta`, we prefer that;
    // otherwise we synthesize ms from start→end wall-clock.
    const turnStartedAt = Date.now();
    let turnTokensIn = 0;
    let turnTokensOut = 0;
    // queryLoop 가 별 method 라 마지막 round 의 provider inputTokens 와
    // request-input projection 을 instance field 로 share. runTurn 은 이
    // provider 값에 post-turn projection delta 를 더해 context-fill SOT 를 만든다.
    self.lastRoundProviderInputTokens = 0;
    self.lastRoundInputProjection = null;
    let turnToolCount = 0;
    let turnCumulativeToolMs = 0;
    const turnToolStarts = new Map<string, number>();
    const turnToolBreakdown = new Map<string, { count: number; ms: number }>();
    const wrappedCallbacks: TurnCallbacks | undefined = callbacks
      ? {
          ...callbacks,
          onToolStart: (name, input, meta) => {
            turnToolStarts.set(meta.toolUseId, Date.now());
            callbacks.onToolStart?.(name, input, meta);
          },
          onToolEnd: (name, result, isError, meta, uiPayload, durationMs) => {
            const startedAt = turnToolStarts.get(meta.toolUseId);
            turnToolStarts.delete(meta.toolUseId);
            // Prefer the executor-provided durationMs (companion PR
            // `feat/tool-execution-duration-display`, now merged); fall
            // back to wall-clock between start/end if absent. When start
            // was never recorded (mid-turn instrumentation) we contribute
            // 0 ms.
            const elapsed =
              typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0
                ? durationMs
                : startedAt !== undefined
                  ? Math.max(0, Date.now() - startedAt)
                  : 0;
            turnToolCount += 1;
            turnCumulativeToolMs += elapsed;
            const prev = turnToolBreakdown.get(name) ?? { count: 0, ms: 0 };
            turnToolBreakdown.set(name, { count: prev.count + 1, ms: prev.ms + elapsed });
            callbacks.onToolEnd?.(name, result, isError, meta, uiPayload, elapsed);
          },
        }
      : undefined;
    const callbacksForLoop = wrappedCallbacks ?? callbacks;

    const baseText = routeResult.route === "skill"
      ? t("be_conversationLoop.skillRoutePrefix", { skillId: routeResult.skillId, input: turnInput })
      : turnInput;
    const attachmentParts = options?.attachments ?? [];
    const userContent: string | import("../llm/types.js").UserContentPart[] =
      attachmentParts.length > 0
        ? [{ type: "text" as const, text: baseText }, ...attachmentParts]
        : baseText;
    const personaPromptMeta = options?.rolePrompt?.id
      ? {
          id: options.rolePrompt.id,
          name: options.rolePrompt.name,
        }
      : undefined;
    const importedTrigger = inputOrigin === "plugin-emitted"
      ? parseImportedTriggerEnvelopePayload(turnInput)
      : null;
    const userMeta: MessageMeta = {
      ...(personaPromptMeta ? { activePersonaPrompt: personaPromptMeta } : {}),
      ...(routeResult.route === "skill"
        ? { displayText: turnInput, routeSkill: { skillId: routeResult.skillId } }
        : {}),
      ...(importedTrigger
        ? {
            displayText: importedTrigger.body,
            importedTrigger: {
              sessionId: `history-imported-${self.sessionId}-${turnStartedAt}`,
              source: importedTrigger.source,
              prompt: turnInput,
              summary: importedTrigger.body,
              toolCallCount: 0,
              importedAt: new Date(turnStartedAt).toISOString(),
            },
          }
        : {}),
    };

    self.history.append({
      role: "user",
      content: userContent,
      ...(Object.keys(userMeta).length > 0 ? { meta: userMeta } : {}),
    });
    if (options?.initialGuidance) {
      self.history.append({
        role: "user",
        content: t("be_conversationLoop.guidanceInjectionHeader", {
          joined: options.initialGuidance,
        }),
      });
    }
    // §4.5.2 step 5 — HISTORY_APPEND
    self.tracer.step("HISTORY_APPEND", { role: "user", historySize: self.history.length });

    // Lazy Tool Scoping — 이 턴에서 노출할 plugin 집합 결정.
    // SystemPromptBuilder Tool Schemas 섹션도 동일 scope로 필터링되도록
    // build() 호출 전에 setToolScope 수행.
    const scope = self.resolveToolScope(input);
    const initialToolSchemas = self.rebuildToolSchemas(scope);

    // ─── Token Preflight (same-session checkpoint compaction) ───
    // step 5 (HISTORY_APPEND) 직후 / step 6 (PROMPT_ASSEMBLE) 직전. The
    // projection is built from the same system prompt, provider-wire history,
    // and tool schemas that the provider request will carry. If compaction
    // mutates the summary preamble/history, prompt assembly runs again below.
    if (self.provider && !self.deps.disableSessionPersistence) {
      await self.runPreflightGuard(
        self.createRequestProjectionContext(
          scope,
          options?.originSource ?? null,
          options?.rolePrompt,
          initialToolSchemas,
          effectiveSessionId,
        ),
        turnSignal,
        callbacks,
      );
    }

    const systemPrompt = self.buildSystemPromptForScope(
      scope,
      options?.originSource ?? null,
      options?.rolePrompt,
      effectiveSessionId,
    );
    // §4.5.2 step 6 — PROMPT_ASSEMBLE
    self.tracer.step("PROMPT_ASSEMBLE", { promptLen: systemPrompt.length, activePlugins: scope.activePluginIds.size });
    let result: Awaited<ReturnType<typeof queryLoop>>;
    try {
      // Establish per-session ALS context so Gate 4 (plugin-runtime-delegate)
      // can consult the CALLING session's on-demand activation set. The context
      // uses effectiveSessionId (respects sessionIdOverride for sub-agents) and
      // propagates through all await chains inside queryLoop, including the
      // in-process MCP loopback path (LoopbackTransport → PluginMcpServer →
      // pluginRuntimeToolDelegate). Clearing session B never wipes session A's
      // activation because the Map is keyed per sessionId.
      result = await sessionContext.run({ sessionId: effectiveSessionId }, () =>
        queryLoop(self,
          systemPrompt,
          scope,
          callbacksForLoop,
          turnSignal,
          options?.originSource ?? null,
          {
            maxRounds: options?.maxRounds,
            sessionIdOverride: options?.sessionIdOverride,
            spawnDepth: options?.spawnDepth,
            approvalReasonPrefix: options?.approvalReasonPrefix,
            inputOrigin,
            toolTrustOrigin,
            permissionUserIntent,
            permissionExplicitAuthorizationIntent,
            rolePrompt: options?.rolePrompt,
          },
        ),
      );
    } finally {
      // Always clear the controller, even when `queryLoop` throws (provider
      // error / abort / tool error). Otherwise the loop looks "mid-turn"
      // forever to anyone consulting `currentAbortController` (e.g.
      // TriggerExecutor's chat-busy guard), and a single failed chat turn
      // would permanently block trigger imports.
      self.currentAbortController = null;
      // "이번 1회만" out-of-allowed-dir grants live only for the duration
      // of one user message. Clearing here (queryLoop terminal regardless
      // of success/error/abort) ensures the next turn re-prompts for the
      // same path — the user's "1회" intent.
      self.turnAdditionalDirectories = [];
      self.deps.skillOverlay?.clear(effectiveSessionId);
      // Drain any guidance that never reached a round boundary (single-
      // round turn, or guidance queued after the last round closed). It
      // cannot be applied to a future turn safely — the next turn's user
      // intent should not be silently prefixed with stale mid-stream
      // guidance — so drop and surface to the renderer via
      // `onGuidanceDropped` (critic MAJOR #3) so the user knows their
      // direction-adjustment was NOT applied. A `log.warn` alone made the
      // drop invisible to end users and worse-UX than the old abort-and-
      // restart flow.
      if (self.guidanceQueue.length > 0) {
        const dropped = self.guidanceQueue;
        const droppedJoined = dropped.map((entry) => entry.text).join("\n\n");
        log.warn(
          `runTurn: ${self.guidanceQueue.length} guide utterance(s) queued but never reached a round boundary — dropping`,
        );
        self.guidanceQueue = [];
        await Promise.allSettled(
          dropped.map((entry) => entry.onDropped?.("turn-ended")),
        );
        callbacks?.onGuidanceDropped?.(droppedJoined);
      }
    }
    // lastTurnScope must reflect any Option C request_plugin expansions so
    // the next turn's keyword-miss fallback keeps those plugins visible.
    self.lastTurnScope = new Set(scope.activePluginIds);
    // Tool-Level Deferral — carry only intentional plugin/MCP tool surface
    // forward. Unused tool_search promotions should not stick to unrelated
    // follow-up/meta questions as if they were builtins.
    self.lastTurnToolNames = self.nextCarryForwardToolNames(scope, result.toolCalls);
    const postTurnToolExposure = self.buildToolExposureMetrics(
      scope,
      result.finalToolSchemas,
      estimateRequestInputProjection({
        systemPrompt,
        messages: self.history.getMessages(),
        toolSchemas: result.finalToolSchemas,
      }),
      result.promotedToolNames,
    );

    // ── #811 m2: Stop (NON-BLOCKING) ──
    // Fired when the turn's query loop has resolved, BEFORE the internal
    // post-turn hook chain — a user lifecycle hook must never block the
    // hardcoded persistence chain (design §1.4). OBSERVE-ONLY: result discarded.
    // Payload: stopReason, toolCount, durationMs.
    await self.fireLifecycleEvent(
      "Stop",
      {
        ...(result.stopReason !== undefined ? { stopReason: result.stopReason } : {}),
        toolCount: result.toolCalls.length,
        durationMs: Math.max(0, Date.now() - turnStartedAt),
      },
      effectiveSessionId,
    );

    // §4.5.2 step 11 — POST_TURN
    self.tracer.step("POST_TURN", {
      toolCallCount: result.toolCalls.length,
      stopReason: result.stopReason,
      ...postTurnToolExposure,
    });
    // §4.5.5 Post-Turn Hook Chain (Agent 6: compact → saveSession → extractMemory → detect-checkpoint → update-title → audit → idle-poke)
    if (self.deps.postTurnHookChain) {
      const hookResult = await self.deps.postTurnHookChain.run({
        sessionId: self.sessionId,
        ...self.getSessionProjectContext(),
        messages: self.history.getMessages(),
        input,
        output: result.text,
        toolCalls: result.toolCalls.map((tc) => ({ name: tc.name, isError: false })),
        tokenUsage: result.usage,
        usageByModel: result.usageByModel,
        toolExposure: postTurnToolExposure,
        route: routeResult.route,
        vendorProvider: result.vendorProvider,
        vendorModel: result.vendorModel,
      });
      // PostTurnHookChain owns the durable transcript projection: mark-stale
      // compaction plus marker-stripped assistant output. Keep in-memory history
      // aligned before the turn_summary final save, otherwise that final save can
      // reintroduce raw <title>/[checkpoint] output over the cleaned transcript.
      const shouldRestoreHookHistory =
        hookResult.compactedMessages !== null ||
        hookResult.detector.cleanedText !== result.text;
      if (shouldRestoreHookHistory) {
        const beforeCount = self.history.getMessages().length;
        const afterCount = hookResult.messagesForPersistence.length;
        log.info(
          `post-turn: history mutation — ${beforeCount} → ${afterCount} msgs (canonical persistence applied to history reference)`,
        );
        self.history.clear();
        self.history.restore(hookResult.messagesForPersistence);
      }
      // Cleaned text (markers stripped) replaces raw output for caller.
      if (hookResult.detector.cleanedText !== result.text) {
        result = { ...result, text: hookResult.detector.cleanedText };
      }
    } else {
      // fallback: PostTurnHookChain 미주입 시 기존 inline 로직 유지.
      // SubAgentRunner 의 child loop 가 이 경로를 사용 (`postTurnHookChain: undefined`)
      // — isolation contract 보존 (parent session 의 audit/extractMemory/idle-poke 미터치) +
      // markStaleToolResults 만 child 에도 적용하여 child tool_result 가 parent
      // 로 surface 되어 history 부풀리는 문제 방지.
      // cycle 1 MED: extractMemory 중복 제거 — memory-extract hook이
      // PostTurnHookChain에서 이미 처리하므로 fallback에서도 호출하지 않는다.
      // PostTurnHookChain을 주입한 경우와 fallback 모두 memory 추출은
      // hook chain의 memory-extract 단계에서만 일어난다.
      // Tool-result marking — 항상 실행, 저비용. child loop 에서도 작동.
      // token preflight (next turn) 가 동등 압축 처리.
      // child loop 은 fire-and-forget 이라 turn budget 짧음 → markStaleToolResults 만으로 충분.
      const { messages: afterMark, result: mr } = markStaleToolResults(self.history.getMessages());
      if (mr.marked) {
        self.history.clear();
        self.history.restore(afterMark);
        if (process.env.NODE_ENV !== "production") {
          log.info(`mark-stale (fallback): marked ${mr.markedCount} tool_results, ~${mr.freedCharsOnSerialize} chars saved on serialize`);
        }
      }
      if (!self.deps.disableSessionPersistence) {
        await self.deps.memoryManager.saveSession(self.sessionId, self.history.getMessages());
      }
      // Mirror PostTurnHookChain's audit-route format so usage attribution
      // stays consistent across both code paths. SubAgentRunner constructs
      // child loops with `postTurnHookChain: undefined`, which would
      // otherwise log every sub-agent LLM turn as the bare `"llm"` route
      // and lose vendor/model granularity in `~/.lvis/audit.jsonl`.
      const auditRoute =
        result.usage
          ? `${result.vendorProvider}/${result.vendorModel}`
          : routeResult.route;
      const auditTokenUsage = normalizeAiSdkUsageForCost(result.usage, result.vendorProvider);
      const auditUsageByModel = result.usageByModel?.map((segment) => ({
        ...segment,
        tokenUsage: normalizeAiSdkUsageForCost(segment.tokenUsage, segment.vendorProvider),
      }));
      self.auditLogger.logTurn({
        sessionId: self.sessionId,
        input,
        output: result.text,
        toolCalls: result.toolCalls.map((tc) => ({ name: tc.name, isError: false })),
        tokenUsage: auditTokenUsage,
        usageByModel: auditUsageByModel,
        toolExposure: postTurnToolExposure,
        route: auditRoute,
      });
      self.deps.idleScheduler?.signalConversation();
    }

    // Same-session compact checkpoints run inside `runPreflightGuard`.
    // No post-turn hook is needed; the next user turn re-evaluates token usage.

    // Turn aggregate footer — see TurnCallbacks.onTurnSummary doc above.
    // Tokens come from the LLM provider's usage report (Vercel AI SDK
    // exposes prompt_tokens + completion_tokens via the provider's
    // streamText/onFinish equivalent — see `engine/llm/vercel/adapter.ts`
    // and `engine/llm/vercel/stream-mapper.ts` which forward the values
    // into the round stream's `usage` field). Suppressed for interrupted
    // turns and turns without a real assistant response (mirrors the
    // turn-end notification gate so dropped turns don't render footers).
    // Production diagnostic — turn_summary 가 사용자 UI (TokenCostBadge 배지
     // + TokenProgressRing) 의 단일 source 라 *emit 되지 않으면* 두 표면 모두
     // 0 표시. 어느 단계에서 끊겼는지 정확히 가시화.
    const willEmitSummary =
      result.stopReason !== "interrupted" &&
      result.stopReason !== "context-error" &&
      // Stream errors push an *error* message as the assistant content;
      // attaching turn-aggregate stats to it would render a TokenCostBadge
      // under a user-facing failure notice with stats that belong to the
      // PARTIAL (failed) round, not a completed turn. Exclude explicitly.
      result.stopReason !== "stream-error" &&
      typeof result.text === "string" &&
      result.text.trim().length > 0;
    log.info(
      `turn_summary: emit decision — stopReason="${result.stopReason}" textLen=${result.text?.trim().length ?? 0} usage=${result.usage ? `in=${result.usage.inputTokens} out=${result.usage.outputTokens}` : "MISSING"} → willEmit=${willEmitSummary}`,
    );
    if (willEmitSummary) {
      // tokensIn = turn-end projected context input. It is calibrated from
      //   provider-truth last-round raw input plus the local wire-shape delta
      //   produced after that provider request. This is the single context-fill
      //   SOT used by both TokenProgressRing and the footer.
      // tokensOut / cacheRead / cacheWrite = turn 전체 합산 (billing 누적).
      // freshInputTokens = turn 전체 fresh 합산 (TokenCostBadge headline +
      //   cost 계산용 — 라운드별 (inputTokens − cacheRead − cacheWrite) 의 합).
      //   `result.usage` 는 turn-aggregate (queryLoop:1098 turnUsage), 그러므로
      //   여기서 단순 산수만 하면 정확. 이전 badge 버그는 last-round raw 와
      //   turn-aggregate cache 를 빼느라 음수 → 0 으로 잘리던 mismatch.
      const postTurnProjection = estimateRequestInputProjection({
        systemPrompt,
        messages: self.history.getMessages(),
        toolSchemas: result.finalToolSchemas,
      });
      const lastRoundProjection = self.lastRoundInputProjection ?? postTurnProjection;
      turnTokensIn = projectNextTurnInputTokens({
        providerInputTokens: self.lastRoundProviderInputTokens,
        lastRoundProjection,
        postTurnProjection,
      });
      self.lastContextInputTokens = turnTokensIn;
      self.lastContextInputProjectionTokens = postTurnProjection.totalTokens;
      turnTokensOut = result.usage?.outputTokens ?? 0;
      const turnCacheRead = result.usage?.cacheReadTokens ?? 0;
      const turnCacheWrite = result.usage?.cacheWriteTokens ?? 0;
      const turnFreshInput = Math.max(
        0,
        (result.usage?.inputTokens ?? 0) - turnCacheRead - turnCacheWrite,
      );
      const breakdown =
        turnToolBreakdown.size > 0
          ? Object.fromEntries(turnToolBreakdown.entries())
          : undefined;
      const uniqueUsageModelKeys = new Set(
        result.usageByModel?.map((segment) => `${segment.vendorProvider}\u0000${segment.vendorModel}`) ?? [],
      );
      const singleUsageModel =
        uniqueUsageModelKeys.size === 1 && result.usageByModel?.[0]
          ? result.usageByModel[0]
          : undefined;
      const turnSummaryPayload = {
        turnDurationMs: Math.max(0, Date.now() - turnStartedAt),
        toolCount: turnToolCount,
        cumulativeToolMs: turnCumulativeToolMs,
        tokensIn: turnTokensIn,
        freshInputTokens: turnFreshInput,
        tokensOut: turnTokensOut,
        ...(turnCacheRead > 0 ? { cacheReadTokens: turnCacheRead } : {}),
        ...(turnCacheWrite > 0 ? { cacheWriteTokens: turnCacheWrite } : {}),
        ...(singleUsageModel
          ? {
              vendorProvider: singleUsageModel.vendorProvider,
              vendorModel: singleUsageModel.vendorModel,
            }
          : {}),
        ...(result.usageByModel.length > 0 ? { usageByModel: result.usageByModel } : {}),
        ...(breakdown ? { breakdown } : {}),
      };
      // Persist turn-aggregate stats onto the turn-final assistant message so
      // a reload reconstructs the same TokenCostBadge / TurnSummaryFooter
      // numbers without re-running the loop. historyToEntries reads this
      // meta and emits a `kind: "turn_summary"` ChatEntry after the last
      // assistant entry of the turn. Silent on history with no assistant
      // (rare tool-only termination) — nothing to attach to.
      let attachedTurnSummary = false;
      try {
        attachedTurnSummary = self.history.attachTurnSummaryToLastAssistant(turnSummaryPayload);
      } catch {
        // Meta attach must never break turn completion either.
      }
      let turnSummaryDurable =
        attachedTurnSummary && self.deps.disableSessionPersistence === true;
      if (attachedTurnSummary && !self.deps.disableSessionPersistence) {
        try {
          await self.deps.memoryManager.saveSession(self.sessionId, self.history.getMessages());
          turnSummaryDurable = true;
        } catch (err) {
          log.warn("turn_summary final save failed: %s", err);
        }
      }
      if (turnSummaryDurable) {
        try {
          callbacks?.onTurnSummary?.(turnSummaryPayload);
        } catch {
          // Summary emission must never break turn completion.
        }
      }
    }

    callbacks?.onTurnComplete?.(result.text);

    // Re-arm recovery budgets after a clean turn. If the turn completed
    // without a context_error / stream_error, the structural failure that
    // exhausted force-recover or TPM recovery is resolved.
    if (
      result.stopReason !== "context-error" &&
      result.stopReason !== "stream-error" &&
      result.stopReason !== "interrupted"
    ) {
      // A genuinely-completed turn (not interrupted/aborted, not a
      // context/stream error) means the structural failure that drove
      // force-recover / TPM recovery is resolved. Reset the CONSECUTIVE
      // force-recover counter so separate, each-recovered context errors over a
      // long session do NOT accumulate to the cap and permanently block
      // compaction. (Previously this reset was also gated behind
      // recoveryExhausted||rateLimitRecoveryAttempted — which a single
      // successful recovery never sets — so the counter stuck and 3 separate
      // recoveries exhausted the budget mid-session.) Interrupted turns are
      // EXCLUDED so a user / misbehaving UI cannot abort turns to reset the
      // force-recover DoS hard-cap budget.
      self.contextErrorRecoveryCount = 0;
      if (self.recoveryExhausted || self.rateLimitRecoveryAttempted) {
        const wasRecoveryExhausted = self.recoveryExhausted;
        self.recoveryExhausted = false;
        self.rateLimitRecoveryAttempted = false;
        log.info(
          wasRecoveryExhausted
            ? "runTurn: recoveryExhausted reset — clean turn, recovery re-armed"
            : "runTurn: rate-limit recovery reset — clean turn, recovery re-armed",
        );
      }
    }

    // Issue #260 — fire system notification on turn-end. Skip if the turn
    // was interrupted (user aborted), hit context_error / stream_error, or
    // produced no assistant text (rare tool-only termination). Body is the
    // leading slice of the assistant response — NotificationService caps +
    // ellipses it.
    if (
      result.stopReason !== "interrupted" &&
      result.stopReason !== "context-error" &&
      result.stopReason !== "stream-error" &&
      typeof result.text === "string" &&
      result.text.trim().length > 0
    ) {
      try {
        self.deps.notificationService?.fire({
          kind: "turn-end",
          title: t("be_conversationLoop.notificationTurnEndTitle"),
          body: result.text,
          contextRef: { sessionId: self.sessionId },
        });
      } catch {
        // notification failure must never block turn completion
      }
    }

    return { ...result, route: routeResult.route };
  }
