/**
 * Boot §4.2 Step 6 — Routine engine factory.
 */
import { ConversationLoop } from "../engine/conversation-loop.js";
import { RoutineEngine } from "../core/routine-engine.js";
import type { Routine } from "../core/routine-engine.js";

export function createRoutineEngine(opts: {
  createConversationLoop: (input: Routine) => ConversationLoop;
  /** Permission policy Layer 4 — snapshot host's active plugin set when scope=inherit. */
  getActivePluginIds?: () => string[];
}): RoutineEngine {
  return new RoutineEngine({
    createConversationLoop: opts.createConversationLoop,
    getActivePluginIds: opts.getActivePluginIds,
  });
}
