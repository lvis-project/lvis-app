/**
 * Sub-agent round budget bounds — one definition shared by the engine, which
 * runs what the user configured, and the settings UI, which persists it. Two
 * copies would drift, and the drift is invisible: a stored value outside the
 * engine's range still *looks* honoured in the settings file while the engine
 * quietly runs something else.
 *
 * There is deliberately NO maximum. An absolute ceiling above the configured
 * budget can only express itself as an agent that stops mid-task with partial
 * work — the exact failure the budget setting exists to let the user avoid.
 * The child ConversationLoop honours the host-assigned `maxRounds` instead of
 * narrowing it to its own default bound.
 */

/** Fewer than this and an agent cannot finish even a trivial tool round-trip. */
export const SUBAGENT_MAX_ROUNDS_MIN = 1;

/** Shipped default when the user has not configured a budget. */
export const SUBAGENT_MAX_ROUNDS_DEFAULT = 60;
