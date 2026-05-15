/**
 * Conversation Trace — §4.5 11-step Debug Tracer (K4)
 *
 * Architecture §4.5.2 메시지 라이프사이클 11-step 경로를 dev 모드에서
 * timestamp + payload JSONL 로 수집한다. 프로덕션 모드에서는 no-op.
 *
 * 출력: `~/.lvis/traces/<session-id>.jsonl`
 * 활성화 조건:
 *   - `process.env.NODE_ENV !== "production"`, 또는
 *   - `process.env.LVIS_TRACE === "1"` (강제 활성화, sampling override)
 *
 * Renderer 뷰어: 기존 audit viewer 패턴(JSONL 스트리밍 readLine)을 그대로 재사용.
 */
import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { lvisHome } from "../shared/lvis-home.js";

/** §4.5.2 11-step 경로 — canonical step 이름. */
export type TraceStepName =
  | "REQUEST_ENTRY"         // 1. renderer → main IPC
  | "KEYWORD_CLASSIFY"      // 2. KeywordEngine.classify()
  | "ROUTE_RESOLVE"         // 3. RouteEngine.route()
  | "TURN_ORCHESTRATE"      // 4. runTurn() 진입
  | "HISTORY_APPEND"        // 5. user 메시지 append
  | "PROMPT_ASSEMBLE"       // 6. system prompt 조립
  | "LLM_STREAM"            // 7. provider.streamTurn 시작
  | "REASONING_ACCUMULATE"  // 8. reasoning_delta 누적 완료 (round 단위)
  | "TOOL_EXECUTE"          // 9. ToolExecutor.executeAll
  | "ROUND_COMMIT"          // 10. assistant_round 확정
  | "POST_TURN"             // 11. PostTurnHookChain.run
  | "GUIDANCE_INJECTED";    // out-of-band — mid-stream "guide" utterance consumed at round boundary

export interface TraceEntry {
  ts: string;
  sessionId: string;
  step: TraceStepName;
  meta?: Record<string, unknown>;
}

export interface ConversationTracer {
  step(name: TraceStepName, meta?: Record<string, unknown>): void;
  readonly enabled: boolean;
  readonly filePath?: string;
}

class NullTracer implements ConversationTracer {
  readonly enabled = false;
  step(): void {
    /* no-op */
  }
}

class FileTracer implements ConversationTracer {
  readonly enabled = true;
  readonly filePath: string;
  private readonly sessionId: string;

  constructor(sessionId: string, traceDir: string) {
    this.sessionId = sessionId;
    if (!existsSync(traceDir)) {
      mkdirSync(traceDir, { recursive: true });
    }
    this.filePath = join(traceDir, `${sessionId}.jsonl`);
  }

  step(name: TraceStepName, meta?: Record<string, unknown>): void {
    try {
      const entry: TraceEntry = {
        ts: new Date().toISOString(),
        sessionId: this.sessionId,
        step: name,
        ...(meta && { meta }),
      };
      appendFileSync(this.filePath, JSON.stringify(entry) + "\n", "utf-8");
    } catch {
      // Trace 실패가 대화 흐름을 차단하면 안 됨
    }
  }
}

/**
 * Tracer 활성 여부 — dev 모드 또는 LVIS_TRACE=1 환경변수.
 * 프로덕션에서는 기본 no-op. sampling 은 상위 호출자가 결정.
 */
export function isTraceEnabled(): boolean {
  if (process.env.LVIS_TRACE === "1") return true;
  return process.env.NODE_ENV !== "production";
}

/**
 * 세션별 tracer 생성. 비활성화 시 NullTracer 반환.
 * 테스트 주입을 위해 traceDir override 가능.
 */
export function createTracer(
  sessionId: string,
  opts?: { enabled?: boolean; traceDir?: string },
): ConversationTracer {
  const enabled = opts?.enabled ?? isTraceEnabled();
  if (!enabled) return new NullTracer();
  const dir = opts?.traceDir ?? join(lvisHome(), "traces");
  return new FileTracer(sessionId, dir);
}
