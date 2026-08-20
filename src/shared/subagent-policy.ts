/**
 * Sub-agent orchestration policy — every numeric budget a sub-agent run is
 * allowed, in one place. Two files (fan-out cap here, round budget there) meant
 * a reader tuning sub-agent limits had to already know which knob lived where.
 *
 * The engine spends these budgets (`turn/query-loop.ts`, `subagent-runner.ts`,
 * `tools/agent-spawn.ts`) and the settings surface configures them
 * (`ChatTab.tsx`, `use-settings-orchestration.ts`, `data/settings-defaults.ts`),
 * so this module stays import-free: it is read from both the main process and
 * the renderer bundle.
 */

/**
 * `agent_spawn` is still a normal tool call at the conversation-loop boundary.
 * Keeping the sub-agent fan-out limit tied to the per-round tool-call cap makes
 * the host enforce one visible invariant instead of separate drift-prone knobs.
 */
export const MAX_AGENT_SPAWNS_PER_ROUND = 5;

export const MAX_TOOL_CALLS_PER_ROUND = MAX_AGENT_SPAWNS_PER_ROUND;

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
 *
 * Fewer rounds than this minimum and an agent cannot finish even a trivial
 * tool round-trip.
 */
export const SUBAGENT_MAX_ROUNDS_MIN = 1;

/** Shipped default when the user has not configured a budget. */
export const SUBAGENT_MAX_ROUNDS_DEFAULT = 60;
