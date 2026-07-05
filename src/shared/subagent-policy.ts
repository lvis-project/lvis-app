/**
 * Sub-agent orchestration policy.
 *
 * `agent_spawn` is still a normal tool call at the conversation-loop boundary.
 * Keeping the sub-agent fan-out limit tied to the per-round tool-call cap makes
 * the host enforce one visible invariant instead of separate drift-prone knobs.
 */
export const MAX_AGENT_SPAWNS_PER_ROUND = 10;

export const MAX_TOOL_CALLS_PER_ROUND = MAX_AGENT_SPAWNS_PER_ROUND;
