/**
 * Tool execution timeout policy — single source of truth.
 *
 * All values are milliseconds for direct comparison without unit conversion.
 * Only `shellDefaultMs` / `shellMaxMs` are model-facing: the bash/powershell
 * Zod schema does `/ 1000` at the boundary to expose `timeoutSeconds` to
 * the model. Every other key is host-internal and consumed as ms directly —
 * no other surface should do the `/ 1000` conversion.
 *
 * The module-level invariant block at the bottom of this file enforces
 * `shellDefaultMs % 1000 === 0` and `shellMaxMs % 1000 === 0` at load time
 * so a non-divisible value would crash the host at startup rather than
 * silently floor the model-facing cap (Zod `.int().max(120.5)` admits 120,
 * not 121 — the cap silently desyncs from the declared policy).
 *
 * Surfaces:
 *  - Built-in shell tools (bash/powershell) — `shellDefaultMs` / `shellMaxMs`
 *    are exposed to the model (as `timeoutSeconds` after `/ 1000`) so it
 *    can pick a value within the cap. The host still enforces
 *    `globalCeilingMs` on top of whatever the model picks.
 *  - The executor caps every `tool.execute()` with an AbortController linked
 *    to a ceiling timer so the underlying work actually stops (tools that
 *    participate in `executionContext.abortSignal` propagate the
 *    cancellation), not just gets ignored.
 *  - `hostApi.callTool` (plugin tool invocation from host code or another
 *    plugin) routes through the same executor and inherits `globalCeilingMs`
 *    — there is no separate plugin-callTool key (single SoT).
 *  - MCP requests have their own default + max ceiling with an absolute
 *    wall-clock deadline so streaming activity reset cannot extend a request
 *    beyond `mcpRequestMaxMs`.
 *  - Plugin `instance.start()` falls back to `pluginStartupDefaultMs` when
 *    the manifest doesn't declare `startupTimeoutMs`, and any declared value
 *    is clamped to `pluginStartupMaxMs`.
 *  - `agent_spawn` carries its own sub-agent execution loop and is capped by
 *    `subAgentCeilingMs` instead of `globalCeilingMs`.
 *  - User-input gates (e.g. ApprovalGate) are exempt from the tool execution
 *    cap — they have their own `approvalGateUserWaitMs` because the user is
 *    actively present, not the runtime hanging.
 *
 * Values were derived from a survey of external OSS agent runtimes (≈60s
 * default median, 120s ceiling as the upper bound). The user-facing
 * principle: never let the user wait indefinitely; an LLM judging a task as
 * long-running can pick a value up to the cap.
 */
export const TOOL_TIMEOUT_POLICY = {
  shellDefaultMs: 60_000,
  shellMaxMs: 120_000,
  globalCeilingMs: 120_000,
  pluginStartupDefaultMs: 10_000,
  pluginStartupMaxMs: 60_000,
  subAgentCeilingMs: 600_000,
  mcpRequestDefaultMs: 60_000,
  mcpRequestMaxMs: 120_000,
  networkFetchDefaultMs: 15_000,
  approvalGateUserWaitMs: 5 * 60 * 1000,
} as const;

// Load-time invariant — fail loudly if the shell keys drift to a non-divisible
// value. The bash/powershell Zod schema does `.max(shellMaxMs / 1000)`; if
// `shellMaxMs` is e.g. 120_500, the schema's `.int().max(120.5)` silently
// floors the model-facing cap to 120, an 8% policy desync with no error.
// Crashing at module load is the only way to make this drift visible.
for (const key of ["shellDefaultMs", "shellMaxMs"] as const) {
  if (TOOL_TIMEOUT_POLICY[key] % 1000 !== 0) {
    throw new Error(
      `TOOL_TIMEOUT_POLICY.${key} (${TOOL_TIMEOUT_POLICY[key]}) must be divisible by 1000 — ` +
        "the bash/powershell Zod schema does `/ 1000` to expose seconds to the model, " +
        "and a non-divisible ms value silently floors the model-facing cap.",
    );
  }
}
