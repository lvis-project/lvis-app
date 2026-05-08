/**
 * RoutineEngineV2 — v2-only routine execution engine.
 *
 * Each routine fire creates a dedicated ConversationLoop instance so routine
 * sessions are fully isolated from the main chat session (Q9 isolation).
 * The factory is called per-invocation — no shared state with main chat.
 */
import type { ConversationLoop } from "../../engine/conversation-loop.js";
import { createLogger } from "../../lib/logger.js";
const log = createLogger("routine-engine-v2");

export interface RoutineV2RunInput {
  id: string;
  trigger: "shutdown" | "schedule";
  prePrompt: string;
  title?: string;
}

export interface RoutineV2Result {
  routineId: string;
  trigger: "shutdown" | "schedule";
  summary: string;
  generatedAt: string;
  sessionId?: string;
}

export interface RoutineEngineV2Deps {
  /** Called once per routine fire to produce a fresh, isolated ConversationLoop. */
  createConversationLoop: () => ConversationLoop;
}

export class RoutineEngineV2 {
  constructor(private readonly deps: RoutineEngineV2Deps) {}

  async runRoutine(input: RoutineV2RunInput): Promise<RoutineV2Result> {
    const generatedAt = new Date().toISOString();
    // Q9: each fire gets its own loop — no history sharing with main chat.
    const loop = this.deps.createConversationLoop();
    const sessionId = loop.getSessionId();

    let summary = "";
    try {
      const result = await loop.runTurn(input.prePrompt);
      summary = result.text ?? "";
    } catch (err) {
      log.warn("runRoutine error (id=%s): %s", input.id, err instanceof Error ? err.message : String(err));
      summary = `루틴 실행 중 오류: ${err instanceof Error ? err.message : String(err)}`;
    }

    return {
      routineId: input.id,
      trigger: input.trigger,
      summary,
      generatedAt,
      sessionId,
    };
  }
}
