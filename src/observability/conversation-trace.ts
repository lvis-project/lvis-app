



import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { lvisHome } from "../shared/lvis-home.js";


export type TraceStepName =
  | "REQUEST_ENTRY"         // 1. renderer → main IPC
  | "INPUT_CLASSIFY" // 2. InputClassifier.classify()
  | "ROUTE_RESOLVE"         // 3. RouteEngine.route()
  | "TURN_ORCHESTRATE"      // 4. Enter runTurn()
  | "HISTORY_APPEND"        // 5. Append user message
  | "PROMPT_ASSEMBLE"       // 6. Assemble system prompt
  | "LLM_STREAM"            // 7. Start provider.streamTurn
  | "LLM_STREAM_ERROR"      // 7b. Structure provider.streamTurn error
  | "TOOL_SCHEMA_REJECTED"  // 7c. provider 400(invalid_function_parameters) -> drop tool and retry round
  | "REASONING_ACCUMULATE"  // 8. Finish accumulating reasoning_delta for the round
  | "TOOL_EXECUTE"          // 9. ToolExecutor.executeAll
  | "ROUND_COMMIT"          // 10. Commit assistant_round
  | "POST_TURN"             // 11. PostTurnHookChain.run
  | "GUIDANCE_INJECTED"     // out-of-band — mid-stream "guide" utterance consumed at round boundary
  | "LENGTH_CONTINUATION";  // out-of-band — finish_reason=length truncation -> continue partial answer verbatim (vLLM continue_final_message)

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
