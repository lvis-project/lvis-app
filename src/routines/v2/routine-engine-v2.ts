/**
 * RoutineEngineV2 — v2-only routine execution engine.
 *
 * Each routine fire creates a dedicated ConversationLoop instance so routine
 * sessions are fully isolated from the main chat session (Q9 isolation).
 * The factory is called per-invocation — no shared state with main chat.
 */
import { writeFile } from "node:fs/promises";
import type { ConversationLoop } from "../../engine/conversation-loop.js";
import { createLogger } from "../../lib/logger.js";
const log = createLogger("routine-engine-v2");

export interface RoutineV2RunInput {
  id: string;
  trigger: "shutdown" | "schedule";
  prePrompt: string;
  title?: string;
  /**
   * Q9: absolute path to the pre-created JSONL file for this routine fire.
   * When provided, the engine appends history messages here so
   * RoutineSessionView can display the full conversation.
   * File is created by RoutineSessionStore.createSession() before runRoutine().
   */
  storagePath?: string;
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

    // Q9: write history to the isolated session JSONL file so RoutineSessionView
    // can display the full conversation. The ConversationLoop's own memoryManager
    // saves to ~/.lvis/sessions/ (main chat area) — we write the routine-specific
    // copy to storagePath so the two paths stay isolated.
    if (input.storagePath) {
      try {
        const history = loop.getHistory().getMessages();
        const lines = history.map((m: unknown) => JSON.stringify(m)).join("\n");
        if (lines.length > 0) {
          await writeFile(input.storagePath, lines + "\n", { encoding: "utf-8", flag: "w" });
        }
      } catch (err) {
        log.warn("runRoutine session write failed (non-fatal, id=%s): %s", input.id, err instanceof Error ? err.message : String(err));
      }
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
