import type { ConversationLoop } from "../engine/conversation-loop.js";
import type { MemoryManager } from "../memory/memory-manager.js";

// ─── Core Routine Types ───────────────────────────────────────────────────────

export type RoutineTriggerType = "wakeup" | "shutdown" | "schedule";

export interface Routine {
  id: string;
  trigger: RoutineTriggerType;
  /** Pre-prompt injected as the user turn that starts the routine session. */
  prePrompt?: string;
  /** Display title for the session (shown in RoutinePanel routine 대화 list). */
  title?: string;
}

export interface RoutineResult {
  routineId: string;
  trigger: RoutineTriggerType;
  summary: string;
  generatedAt: string;
  /** Conversation session id captured during this routine run (for jump-to-session). */
  sessionId?: string;
}

// ─── Engine ──────────────────────────────────────────────────────────────────

export interface RoutineEngineDeps {
  createConversationLoop: () => ConversationLoop;
  /**
   * Optional memoryManager for tagging the routine session with routineId so
   * RoutinePanel can list per-routine 대화. Without this, routine conversations
   * still save (via the loop's fallback memoryManager.saveSession) but are not
   * surfaced in the routine sidebar.
   */
  memoryManager?: MemoryManager;
}

export class RoutineEngine {
  constructor(private readonly deps: RoutineEngineDeps) {}

  async runRoutine(routine: Routine): Promise<RoutineResult> {
    const loop = this.deps.createConversationLoop();
    const generatedAt = new Date().toISOString();
    const sessionId = loop.getSessionId();

    let summary = "";
    try {
      const result = await loop.runTurn(routine.prePrompt ?? "");
      summary = result.text ?? "";
    } catch (err) {
      summary = `루틴 실행 중 오류가 발생했습니다: ${err instanceof Error ? err.message : String(err)}`;
    }

    // Tag session metadata so RoutinePanel.listSessionsByRoutine surfaces it.
    if (this.deps.memoryManager) {
      try {
        await this.deps.memoryManager.saveSessionMetadata(sessionId, {
          routineId: routine.id,
          routineTitle: routine.title,
        });
      } catch (err) {
        // Non-fatal — routine result still returns even if metadata persist fails.
        console.warn("[routine-engine] saveSessionMetadata failed:", err instanceof Error ? err.message : String(err));
      }
    }

    return {
      routineId: routine.id,
      trigger: routine.trigger,
      summary,
      generatedAt,
      sessionId,
    };
  }
}
