import type { ConversationLoop } from "../engine/conversation-loop.js";

// ─── Core Routine Types ───────────────────────────────────────────────────────

export type RoutineTriggerType = "wakeup" | "shutdown" | "schedule";

export interface Routine {
  id: string;
  trigger: RoutineTriggerType;
  /** Pre-prompt injected as the user turn that starts the routine session. */
  prePrompt?: string;
}

export interface RoutineResult {
  routineId: string;
  trigger: RoutineTriggerType;
  summary: string;
  generatedAt: string;
}

// ─── Engine ──────────────────────────────────────────────────────────────────

export interface RoutineEngineDeps {
  createConversationLoop: () => ConversationLoop;
}

export class RoutineEngine {
  constructor(private readonly deps: RoutineEngineDeps) {}

  async runRoutine(routine: Routine): Promise<RoutineResult> {
    const loop = this.deps.createConversationLoop();
    const generatedAt = new Date().toISOString();

    let summary = "";
    try {
      const result = await loop.runTurn(routine.prePrompt ?? "");
      summary = result.text ?? "";
    } catch (err) {
      summary = `루틴 실행 중 오류가 발생했습니다: ${err instanceof Error ? err.message : String(err)}`;
    }

    return {
      routineId: routine.id,
      trigger: routine.trigger,
      summary,
      generatedAt,
    };
  }
}
