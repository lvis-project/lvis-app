/**
 * Boot §4.2 Step 6 — Routine engine factory.
 */
import { ConversationLoop } from "../engine/conversation-loop.js";
import { RoutineEngine } from "../core/routine-engine.js";

export function createRoutineEngine(opts: {
  createConversationLoop: () => ConversationLoop;
}): RoutineEngine {
  return new RoutineEngine({
    createConversationLoop: opts.createConversationLoop,
  });
}
