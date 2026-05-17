/**
 * Tool execution timeout policy — single source of truth.
 *
 * Surfaces:
 *  - Built-in shell tools (bash/powershell) use seconds via Zod schema; the
 *    `shellDefaultSeconds` / `shellMaxSeconds` are exposed to the model so it
 *    can pick a value within the cap. The host still enforces `globalCeilingMs`
 *    on top of whatever the model picks.
 *  - The executor wraps every `tool.execute()` in a Promise.race with
 *    `globalCeilingMs` as a last-resort cap so runaway tools cannot hang the
 *    conversation loop.
 *  - `hostApi.callTool` (plugin tool invocation from host code or another
 *    plugin) is wrapped in the same ceiling — plugin tools cannot expose a
 *    `timeout` parameter to the model directly, so the host is the only
 *    enforcement point.
 *  - MCP requests have their own default + max ceiling (separate from the
 *    in-process executor path).
 *  - Plugin `instance.start()` falls back to `pluginStartupDefaultMs` when the
 *    manifest doesn't declare `startupTimeoutMs`, so an undeclared plugin
 *    cannot block boot indefinitely.
 *
 * Values were derived from the external average of Claude Code / Codex CLI /
 * OpenCode / Cline (60s default median, 120s ceiling matching Claude Code's
 * documented max). The user-facing principle: never let the user wait
 * indefinitely; an LLM judging a task as long-running can pick up to the cap.
 */
export const TOOL_TIMEOUT_POLICY = {
  shellDefaultSeconds: 60,
  shellMaxSeconds: 120,
  globalCeilingMs: 120_000,
  pluginCallToolCeilingMs: 120_000,
  pluginStartupDefaultMs: 10_000,
  mcpRequestDefaultMs: 60_000,
  mcpRequestMaxMs: 120_000,
} as const;
