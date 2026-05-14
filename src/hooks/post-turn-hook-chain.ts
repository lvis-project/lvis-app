/**
 * Post-Turn Hook Chain — §4.5 11단계 후 실행
 *
 * mark-stale → detect-checkpoint → saveSession → extractMemory → update-title → auditLog → idle-poke 순차 실행.
 * 각 단계는 독립적이며 한 단계 실패가 다음을 차단하지 않음.
 *
 * PR-2-F-3 정정: Stage 1b (post-turn full compact) 제거. Layer 0 preflight (`runPreflightGuard`,
 * conversation-loop.ts) 가 *next turn 진입 전* 동등한 LLM-based 압축을 더 보수적 임계로 처리.
 * 이 hook chain 은 Layer 1 (markStaleToolResults) + 5 개 housekeeping step 만 담당.
 */

import { markStaleToolResults } from "../engine/auto-compact.js";
import { stubMarkedToolResults } from "../engine/wire-serialize.js";
import { detectFromStream, type DetectorResult } from "../engine/checkpoint-detector.js";
import type { GenericMessage, TokenUsage } from "../engine/llm/types.js";
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
   * §PR-3: optional callback invoked when a legacy [checkpoint] marker is detected.
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
        if (mr.marked) {
          compactedMessages = afterMark;
          log.info(
            `mark-stale: marked ${mr.markedCount} tool_results, ~${mr.freedCharsOnSerialize} chars saved on serialize (msgCount=${beforeMarkCount}, memory verbatim)`,
          );
        } else {
          log.info(`mark-stale: SKIPPED — no stale tool_result content found (msgCount=${beforeMarkCount})`);
        }
      }
    } catch (err) {
      log.warn({ err }, "mark-stale failed");
    }

    // 2. §PR-3: Detect legacy checkpoint/title markers — detectFromStream 호출
    //    Run before persistence so durable session history stores the same
    //    cleaned assistant output that the caller and renderer receive.
    let detector: DetectorResult = { cleanedText: ctx.output, newTitle: null, checkpointSuggested: false };
    try {
      detector = detectFromStream(ctx.output);
      if (detector.checkpointSuggested) {
        log.info(`detect-checkpoint: legacy [checkpoint] marker stripped for session ${ctx.sessionId}`);
        try {
          this.deps.onCheckpointSuggested?.(ctx.sessionId, detector.cleanedText);
        } catch (cbErr) {
          log.warn("onCheckpointSuggested callback failed: %s", cbErr);
        }
      }
    } catch (err) {
      log.warn("detect-checkpoint failed: %s", err);
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
      // PR-3 (v3 §4.2): JSONL 영속화 직전 marked tool_result 를 stub 으로 변환 — disk 무한
      // 성장 방지 (R4 mitigation 유지). caller (engine) 의 in-memory verbatim 은 변경 안 됨.
      await this.deps.memoryManager?.saveSession(ctx.sessionId, stubMarkedToolResults(messagesToSave));
    } catch (err) {
      log.warn("saveSession failed: %s", err);
    }

    // 4. Memory Extraction — "기억해" 패턴 감지 시 memories/ 자동 저장
    try {
      if (this.deps.memoryManager) {
        const memoryPatterns = /기억해|기억하|잊지\s*마|remember|don't forget/i;
        if (memoryPatterns.test(ctx.input)) {
          const confirmPatterns = /기억하겠|기억.*저장|기록.*했|noted|remembered|saved/i;
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

    // 5. Legacy [title] marker handling — newTitle 가 detector 에서 추출되면
    //    session metadata 에 저장. LLM-based title chaining 은 PR #729 에서
    //    완전 제거됨 (호출처가 없는 dead code 였음 — No Fallback Code 룰).
    //    LLM title chaining 을 재도입하려면 별도 PR 에서 llmProvider 주입 +
    //    빈도 게이트 (e.g. "N turn 마다") 를 함께 설계.
    try {
      if (this.deps.memoryManager && detector.newTitle) {
        const sessionMeta = this.deps.memoryManager.loadSessionMetadata(ctx.sessionId) ?? {};
        await this.deps.memoryManager.saveSessionMetadata(ctx.sessionId, {
          ...sessionMeta,
          title: detector.newTitle,
        });
        log.info(`update-title: session ${ctx.sessionId} title set to "${detector.newTitle}"`);
      }
    } catch (err) {
      log.warn("update-title failed: %s", err);
    }

    // 6. Audit Log (§14.2)
    //    Emit `${provider}/${model}` for "llm" routes (usage-stats.parseRoute
    //    splits on `/`); non-LLM routes (skill/command/agent-message) keep the
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
