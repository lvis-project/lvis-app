/**
 * Boot §4.2 Step 6 — Routine engine factory (v2-only).
 */
import { ConversationLoop } from "../engine/conversation-loop.js";
import { RoutineEngine } from "../core/routine-engine.js";
import type { RoutineV2RunInput } from "../routines/v2/routine-engine-v2.js";

export function createRoutineEngine(opts: {
  createConversationLoop: (input: RoutineV2RunInput) => ConversationLoop;
  /** Permission policy Layer 4 — snapshot host's active plugin set when scope=inherit. */
  getActivePluginIds?: () => string[];
}): RoutineEngine {
  return new RoutineEngine({
    createConversationLoop: opts.createConversationLoop,
    getActivePluginIds: opts.getActivePluginIds,
  });
}
