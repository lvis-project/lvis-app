/**
 * Sub-agent round budget bounds — one definition shared by the engine, which
 * clamps what it actually runs, and the settings UI, which clamps what it
 * persists. Two copies would drift, and the drift is invisible: a stored value
 * outside the engine's range still *looks* honoured in the settings file while
 * the engine quietly runs something else.
 *
 * The maximum equals the ConversationLoop's own per-turn ceiling
 * (`MAX_TOOL_ROUNDS`), which a child can never exceed because it runs on that
 * same loop. Raising one without the other is what this module exists to
 * prevent.
 */

/** Fewer than this and an agent cannot finish even a trivial tool round-trip. */
export const SUBAGENT_MAX_ROUNDS_MIN = 1;

/** Hard ceiling; mirrors `MAX_TOOL_ROUNDS` in engine/turn/query-loop.ts. */
export const SUBAGENT_MAX_ROUNDS_MAX = 60;

/** Shipped default — the full budget, since running short is the failure mode. */
export const SUBAGENT_MAX_ROUNDS_DEFAULT = 60;
