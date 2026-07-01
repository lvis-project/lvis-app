/**
 * LoopContext (C9 Wave 4) — the turn-local mutable carrier that the run-turn
 * and query-loop free functions operate on. It is the ConversationLoop instance
 * itself: the class owns all turn state (history, provider, the lastRound and
 * lastContext token-projection fields, the guidance queue, compaction flags),
 * and the extracted free functions read/write it through this alias so the
 * implicit cross-method contracts stay on one object.
 */
import type { ConversationLoop } from "../conversation-loop.js";

export type LoopContext = ConversationLoop;
