/**
 * Post-Turn Hook Chain — §4.5 11단계 후 실행
 *
 * compact → detect-checkpoint → saveSession → extractMemory → update-title → auditLog → idle-poke 순차 실행.
 * 각 단계는 독립적이며 한 단계 실패가 다음을 차단하지 않음.
 *
 * §PR-3 확장:
 *   2. detect-checkpoint — detectFromStream() 호출, [checkpoint] 발견 시 checkpoint-suggested 이벤트 emit
 *   5. update-title — newTitle 있으면 session metadata 업데이트, 없으면 chainTitle LLM fallback (옵션)
 *
 * conversation-loop.ts의 기존 5개 post-turn 로직을 흡수:
 *   1. shouldCompact / compactMessages (§4.5.4)
 *   2. memoryManager.saveSession (§4.5.7)
 *   3. extractMemory "기억해" 패턴 (§4.5.5 Hook 3)
 *   4. auditLogger.logTurn (§14.2)
 *   5. idleScheduler.signalConversation (Agent 5 §6.1)
 */

import { markStaleToolResults } from "../engine/auto-compact.js";
import { detectFromStream, type DetectorResult } from "../engine/checkpoint-detector.js";
import { chainTitle } from "../engine/title-chainer.js";
import type { GenericMessage, TokenUsage, LLMProvider } from "../engine/llm/types.js";
import type { MemoryManager } from "../memory/memory-manager.js";
import type { AuditLogger } from "../audit/audit-logger.js";
import type { IdleSchedulerService } from "../main/idle-scheduler.js";
import type { SettingsService } from "../data/settings-store.js";
import { createLogger } from "../lib/logger.js";
import { EMPTY_ASSISTANT_RESPONSE_TEXT } from "../lib/chat-stream-state.js";
const log = createLogger("post-turn");

export interface PostTurnHookContext {
  sessionId: string;
  /** 현재 대화 이력 메시지 배열 */
  messages: GenericMessage[];
  /** 누적 토큰 사용량 — shouldCompact() 판단에 사용 */
  cumulativeUsage: TokenUsage;
  input: string;
  output: string;
  toolCalls: Array<{ name: string; isError: boolean }>;
  tokenUsage?: TokenUsage;
  route: string;
  /**
   * Snapshot of the LLM vendor/model that actually served this turn —
   * captured at runTurn entry so that post-turn audit attribution is
   * stable even if the user mutates settings mid-flight (e.g. retry-effort
   * temporarily patches thinking config and reverts in finally). The audit
   * step uses these to emit `${provider}/${model}` for "llm" routes; usage
   * stats then attribute cost to the model that actually consumed tokens.
   * Optional so non-LLM-route callers (skill / command) can omit them.
   */
  vendorProvider?: string;
  vendorModel?: string;
}

export interface PostTurnHookChainDeps {
  memoryManager?: MemoryManager;
  auditLogger?: AuditLogger;
  idleScheduler?: IdleSchedulerService;
  settingsService?: SettingsService;
  /**
   * §PR-3: optional LLM provider for chainTitle fallback.
   * When supplied and detectFromStream returns no newTitle, chainTitle is
   * called as a mini-call to generate a session title from existing title +
   * final answer. Omit in tests / lightweight setups to skip the fallback.
   */
  llmProvider?: LLMProvider;
  /**
   * §PR-3: optional callback invoked when [checkpoint] is detected.
   * Caller (typically conversation-loop or IPC bridge) can trigger PR-4 summary.
   */
  onCheckpointSuggested?: (sessionId: string, cleanedOutput: string) => void;
}

export interface PostTurnHookResult {
  /** 컴팩션이 발생한 경우 새 메시지 배열. 없으면 null. */
  compactedMessages: GenericMessage[] | null;
  /** §PR-3: detect-checkpoint 결과. output에 마커가 없으면 default 값. */
  detector: DetectorResult;
}

export class PostTurnHookChain {
  constructor(private readonly deps: PostTurnHookChainDeps) {}

  /**
   * 7단계 순차 실행. 각 단계는 독립적 try/catch.
   *
   * @returns PostTurnHookResult — compactedMessages (nullable) + detector result
   */
  async run(ctx: PostTurnHookContext): Promise<PostTurnHookResult> {
    let compactedMessages: GenericMessage[] | null = null;

    // 1. Layer 1 — markStaleToolResults (LLM-free, lazy, 항상).
    // PR-2-F-3 정정: Stage 1b (post-turn full compact) 제거. Layer 0 preflight
    // (`runPreflightGuard`) 가 *next turn 진입 전* 동등한 구조적 압축을 더 보수적
    // 임계 (50/55/60/65%) 로 수행하므로 post-turn 추가 압축 불필요.
    try {
      const autoCompactEnabled = this.deps.settingsService?.get("chat").autoCompact ?? true;
      if (!autoCompactEnabled) {
        log.info("post-turn compact: SKIPPED (autoCompact 설정 OFF)");
      } else {
        const beforeMarkCount = ctx.messages.length;
        const { messages: afterMark, result: mr } = markStaleToolResults(ctx.messages);
        if (mr.stripped) {
          compactedMessages = afterMark;
          log.info(
            `mark-stale: stripped ${mr.strippedCount} tool_results, freed ~${mr.freedChars} chars (msgCount ${beforeMarkCount} → ${afterMark.length}, content stub-replaced)`,
          );
        } else {
          log.info(`mark-stale: SKIPPED — no stale tool_result content found (msgCount=${beforeMarkCount})`);
        }
      }
    } catch (err) {
      log.warn({ err }, "mark-stale failed");
    }

    // 2. §PR-3: Detect Checkpoint — detectFromStream 호출
    //    Run before persistence so durable session history stores the same
    //    cleaned assistant output that the caller and renderer receive.
    let detector: DetectorResult = { cleanedText: ctx.output, newTitle: null, checkpointSuggested: false };
    const continuousBackendEnabled =
      this.deps.settingsService?.get("features")?.experimentalContinuousBackend ?? false;
    if (continuousBackendEnabled) {
      try {
        detector = detectFromStream(ctx.output);
        if (detector.checkpointSuggested) {
          log.info(`detect-checkpoint: [checkpoint] detected for session ${ctx.sessionId}`);
          try {
            this.deps.onCheckpointSuggested?.(ctx.sessionId, detector.cleanedText);
          } catch (cbErr) {
            log.warn("onCheckpointSuggested callback failed: %s", cbErr);
          }
        }
      } catch (err) {
        log.warn("detect-checkpoint failed: %s", err);
      }
    }
    const outputForHooks = detector.cleanedText;
    const outputForPersistence =
      outputForHooks.trim().length > 0
        ? outputForHooks
        : ctx.output.trim().length > 0
          ? EMPTY_ASSISTANT_RESPONSE_TEXT
          : outputForHooks;

    // 3. 세션 영속화 (§4.5.7)
    try {
      const baseMessages = compactedMessages ?? ctx.messages;
      const messagesToSave =
        outputForPersistence !== ctx.output
          ? replaceLastAssistantOutput(baseMessages, ctx.output, outputForPersistence)
          : baseMessages;
      await this.deps.memoryManager?.saveSession(ctx.sessionId, messagesToSave);
    } catch (err) {
      log.warn("saveSession failed: %s", err);
    }

    // 4. Memory Extraction — "기억해" 패턴 감지 시 memory/ 자동 저장
    try {
      if (this.deps.memoryManager) {
        const memoryPatterns = /기억해|기억하|잊지\s*마|remember|don't forget|메모해/i;
        if (memoryPatterns.test(ctx.input)) {
          const confirmPatterns = /기억하겠|메모.*저장|기록.*했|noted|remembered|saved/i;
          if (confirmPatterns.test(outputForHooks)) {
            const title = ctx.input.slice(0, 40).replace(/\n/g, " ").trim();
            if (title.length >= 3) {
              await this.deps.memoryManager.saveMemory(
                `자동-${title}`,
                `[사용자 요청]\n${ctx.input}\n\n[어시스턴트 응답]\n${outputForHooks.slice(0, 500)}`,
              );
              log.info(`memory-extraction: auto-saved note "${title}"`);
            }
          }
        }
      }
    } catch (err) {
      log.warn("extractMemory failed: %s", err);
    }

    // 5. §PR-3: Update Title — newTitle 있으면 session metadata 업데이트
    //    없으면 chainTitle LLM fallback (llmProvider 주입된 경우에만)
    //    Skipped when experimentalContinuousBackend feature flag is OFF.
    if (continuousBackendEnabled) {
      try {
        if (this.deps.memoryManager) {
          let titleToStore: string | null = detector.newTitle;

          // Load metadata once and reuse for both chainTitle input and saveSessionMetadata.
          const sessionMeta = this.deps.memoryManager.loadSessionMetadata(ctx.sessionId) ?? {};

          if (!titleToStore && this.deps.llmProvider) {
            // chainTitle fallback: 현재 세션 메타데이터에서 직접 제목 조회 (listSessions I/O 비용 회피)
            const existingTitle = sessionMeta.title ?? `세션 ${ctx.sessionId.slice(0, 8)}`;
            titleToStore = await chainTitle(this.deps.llmProvider, existingTitle, detector.cleanedText);
          }

          if (titleToStore) {
            await this.deps.memoryManager.saveSessionMetadata(ctx.sessionId, {
              ...sessionMeta,
              title: titleToStore,
            });
            log.info(`update-title: session ${ctx.sessionId} title set to "${titleToStore}"`);
          }
        }
      } catch (err) {
        log.warn("update-title failed: %s", err);
      }
    }

    // 6. Audit Log (§14.2)
    //    Emit `${provider}/${model}` for "llm" routes (usage-stats.parseRoute
    //    splits on `/`); non-LLM routes (skill/command/agent-hub) keep the
    //    classification verbatim. Snapshot fields on ctx win over live
    //    settings — see PostTurnHookContext docs for the drift rationale.
    try {
      const llmSettings = this.deps.settingsService?.get("llm");
      const provider = ctx.vendorProvider ?? llmSettings?.provider;
      const model =
        ctx.vendorModel ??
        (llmSettings ? llmSettings.vendors[llmSettings.provider].model : undefined);
      const auditRoute =
        ctx.route === "llm" && provider && model
          ? `${provider}/${model}`
          : ctx.route;
      this.deps.auditLogger?.logTurn({
        sessionId: ctx.sessionId,
        input: ctx.input,
        output: outputForHooks,
        toolCalls: ctx.toolCalls,
        tokenUsage: ctx.tokenUsage,
        route: auditRoute,
      });
    } catch (err) {
      log.warn("audit failed: %s", err);
    }

    // 7. Idle poke (Agent 5 §6.1 신호 흡수)
    try {
      this.deps.idleScheduler?.signalConversation();
    } catch (err) {
      log.warn("idle poke failed: %s", err);
    }

    return { compactedMessages, detector };
  }
}

function replaceLastAssistantOutput(
  messages: GenericMessage[],
  rawOutput: string,
  cleanedOutput: string,
): GenericMessage[] {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== "assistant") continue;
    const next = [...messages];
    next[i] = {
      ...message,
      content: message.content === rawOutput ? cleanedOutput : message.content.replace(rawOutput, cleanedOutput),
    };
    return next;
  }
  return messages;
}
