/**
 * Boot §4.2 Step 6 — Routine engine factory.
 */
import { ConversationLoop } from "../engine/conversation-loop.js";
import { RoutineEngine } from "../core/routine-engine.js";
import type { MemoryManager } from "../memory/memory-manager.js";

export function createRoutineEngine(opts: {
  createConversationLoop: () => ConversationLoop;
  memoryManager?: MemoryManager;
}): RoutineEngine {
  return new RoutineEngine({
    createConversationLoop: opts.createConversationLoop,
    memoryManager: opts.memoryManager,
  });
}
