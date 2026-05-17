/**
 * Tool execution timeout policy — single source of truth.
 *
 * Surfaces:
 *  - Built-in shell tools (bash/powershell) use seconds via Zod schema; the
 *    `shellDefaultSeconds` / `shellMaxSeconds` are exposed to the model so it
 *    can pick a value within the cap. The host still enforces `globalCeilingMs`
 *    on top of whatever the model picks.
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
  shellDefaultSeconds: 60,
  shellMaxSeconds: 120,
  globalCeilingMs: 120_000,
  pluginStartupDefaultMs: 10_000,
  pluginStartupMaxMs: 60_000,
  subAgentCeilingMs: 600_000,
  mcpRequestDefaultMs: 60_000,
  mcpRequestMaxMs: 120_000,
  networkFetchDefaultMs: 15_000,
  approvalGateUserWaitMs: 5 * 60 * 1000,
} as const;
