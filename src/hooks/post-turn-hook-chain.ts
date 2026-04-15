/**
 * Post-Turn Hook Chain — §4.5 11단계 후 실행
 *
 * compact → saveSession → extractMemory → auditLog → idle-poke 순차 실행.
 * 각 단계는 독립적이며 한 단계 실패가 다음을 차단하지 않음.
 *
 * conversation-loop.ts의 기존 5개 post-turn 로직을 흡수:
 *   1. shouldCompact / compactMessages (§4.5.4)
 *   2. memoryManager.saveSession (§4.5.7)
 *   3. extractMemory "기억해" 패턴 (§4.5.5 Hook 3)
 *   4. auditLogger.logTurn (§14.2)
 *   5. idleScheduler.signalConversation (Agent 5 §6.1)
 */

import { shouldCompact, compactMessages } from "../engine/auto-compact.js";
import type { GenericMessage, TokenUsage } from "../engine/llm/types.js";
import type { MemoryManager } from "../memory/memory-manager.js";
import type { AuditLogger } from "../audit/audit-logger.js";
import type { IdleSchedulerService } from "../main/idle-scheduler.js";

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
}

export interface PostTurnHookChainDeps {
  memoryManager?: MemoryManager;
  auditLogger?: AuditLogger;
  idleScheduler?: IdleSchedulerService;
}

export class PostTurnHookChain {
  constructor(private readonly deps: PostTurnHookChainDeps) {}

  /**
   * 5단계 순차 실행. 각 단계는 독립적 try/catch.
   *
   * @returns 컴팩션이 발생한 경우 새 메시지 배열 (호출자가 history.restore()에 사용),
   *          컴팩션 없으면 null
   */
  async run(ctx: PostTurnHookContext): Promise<GenericMessage[] | null> {
    let compactedMessages: GenericMessage[] | null = null;

    // 1. Auto-Compact (§4.5.4)
    // shouldCompact()는 cumulativeUsage.inputTokens ≥ thresholdTokens 판단
    try {
      if (shouldCompact(ctx.cumulativeUsage)) {
        const { messages: compacted, result: cr } = compactMessages(ctx.messages);
        if (cr.compacted) {
          compactedMessages = compacted;
          console.log(
            `[post-turn] auto-compact: removed ${cr.removedMessages} msgs, freed ~${cr.freedTokens} tokens`,
          );
        }
      }
    } catch (err) {
      console.warn("[post-turn] compact failed:", err);
    }

    // 2. 세션 영속화 (§4.5.7)
    try {
      const messagesToSave = compactedMessages ?? ctx.messages;
      this.deps.memoryManager?.saveSession(ctx.sessionId, messagesToSave);
    } catch (err) {
      console.warn("[post-turn] saveSession failed:", err);
    }

    // 3. Memory Extraction — "기억해" 패턴 감지 시 notes/ 자동 저장
    try {
      if (this.deps.memoryManager) {
        const memoryPatterns = /기억해|기억하|잊지\s*마|remember|don't forget|메모해/i;
        if (memoryPatterns.test(ctx.input)) {
          const confirmPatterns = /기억하겠|메모.*저장|기록.*했|noted|remembered|saved/i;
          if (confirmPatterns.test(ctx.output)) {
            const title = ctx.input.slice(0, 40).replace(/\n/g, " ").trim();
            if (title.length >= 3) {
              this.deps.memoryManager.saveNote(
                `자동-${title}`,
                `[사용자 요청]\n${ctx.input}\n\n[어시스턴트 응답]\n${ctx.output.slice(0, 500)}`,
              );
              console.log(`[post-turn] memory-extraction: auto-saved note "${title}"`);
            }
          }
        }
      }
    } catch (err) {
      console.warn("[post-turn] extractMemory failed:", err);
    }

    // 4. Audit Log (§14.2)
    try {
      this.deps.auditLogger?.logTurn({
        sessionId: ctx.sessionId,
        input: ctx.input,
        output: ctx.output,
        toolCalls: ctx.toolCalls,
        tokenUsage: ctx.tokenUsage,
        route: ctx.route,
      });
    } catch (err) {
      console.warn("[post-turn] audit failed:", err);
    }

    // 5. Idle poke (Agent 5 §6.1 신호 흡수)
    try {
      this.deps.idleScheduler?.signalConversation();
    } catch (err) {
      console.warn("[post-turn] idle poke failed:", err);
    }

    return compactedMessages;
  }
}
