/**
 * Tool execution timeout policy — single source of truth.
 *
 * All values are milliseconds for direct comparison without unit conversion.
 * Only `shellDefaultMs` is model-facing: the bash/powershell Zod schema does
 * `/ 1000` at the boundary to expose `timeoutSeconds` to the model. Every
 * other key is host-internal and consumed as ms directly — no other surface
 * should do the `/ 1000` conversion.
 *
 * The module-level invariant block at the bottom of this file enforces
 * `shellDefaultMs % 1000 === 0` at load time so a non-divisible value would
 * crash the host at startup rather than yield a fractional model-facing
 * default that the `.int()` schema then rejects.
 *
 * Shell timeout semantics: a timeout ALWAYS exists (the field is optional but
 * defaulted, and non-positive / non-finite values are rejected), so no call
 * can wait forever. There is deliberately NO upper bound: expiry is a clean,
 * retryable tool error, and the retry's whole point is to name a LARGER
 * budget. A cap would make that retry impossible and would fail input
 * validation for the entire turn rather than for the one tool call.
 *
 * Surfaces:
 *  - Built-in shell tools (bash/powershell) — `shellDefaultMs` is exposed to
 *    the model (as `timeoutSeconds` after `/ 1000`) as the value it gets when
 *    it says nothing.
 *  - The executor caps every `tool.execute()` with an AbortController linked
 *    to a ceiling timer so the underlying work actually stops (tools that
 *    participate in `executionContext.abortSignal` propagate the
 *    cancellation), not just gets ignored. A builtin shell invocation whose
 *    own `timeoutSeconds` exceeds that ceiling raises it for that invocation
 *    (`resolveEffectiveCeilingMs`), so the tool's own retryable timeout — not
 *    an opaque ceiling abort — is what the model sees.
 *  - Plugin-owned UI and MCP tool execution routes through the same executor
 *    and inherits `globalCeilingMs` — there is no separate plugin timeout
 *    key (single SoT).
 *  - MCP requests have their own default + max ceiling with an absolute
 *    wall-clock deadline so streaming activity reset cannot extend a request
 *    beyond `mcpRequestMaxMs`.
 *  - Plugin `instance.start()` falls back to `pluginStartupDefaultMs` when
 *    the manifest doesn't declare `startupTimeoutMs`, and any declared value
 *    is clamped to `pluginStartupMaxMs`.
 *  - Plugin module import is capped by `pluginImportMs`. Since JavaScript ESM
 *    evaluation cannot be cancelled in-process, an import timeout also
 *    quarantines that plugin id for the remainder of the host process.
 *  - Plugin factory execution is capped by `pluginFactoryMs`; a late factory
 *    result is never committed and is stopped by the runtime cleanup callback.
 *  - `PluginRuntime.readUiResource` (the plugin hook that serves a declared
 *    `ui://` MCP App card) is capped by `pluginUiResourceReadMs` — a render-path
 *    call, not a tool execution.
 *  - `agent_spawn` carries its own sub-agent execution loop and is capped by
 *    `subAgentCeilingMs` instead of `globalCeilingMs`.
 *  - User-input gates (e.g. ApprovalGate) are exempt from the tool execution
 *    cap — they have their own `approvalGateUserWaitMs` because the user is
 *    actively present, not the runtime hanging.
 *
 * The user-facing principle: never let the user wait indefinitely, and never
 * kill work the model explicitly budgeted for. An unspecified call gets
 * `shellDefaultMs`; a model that times out escalates by retrying with a
 * larger `timeoutSeconds`.
 */
export const TOOL_TIMEOUT_POLICY = {
  shellDefaultMs: 120_000,
  globalCeilingMs: 120_000,
  pluginImportMs: 10_000,
  pluginFactoryMs: 10_000,
  pluginStartupDefaultMs: 10_000,
  pluginStartupMaxMs: 60_000,
  // Ceiling for `RuntimePlugin.readUiResource` — the plugin hook that serves one
  // of its manifest-declared `ui://` MCP App cards. It sits on the RENDER path
  // (the user is waiting on a card, not on work a tool was asked to do), so it is
  // bounded far tighter than `globalCeilingMs`. Fail-closed on expiry: no card.
  pluginUiResourceReadMs: 10_000,
  subAgentCeilingMs: 600_000,
  mcpRequestDefaultMs: 60_000,
  mcpRequestMaxMs: 120_000,
  networkFetchDefaultMs: 15_000,
  // Host-owned LLM boundaries for the permission-rationale path. These are
  // separate from ordinary tool execution and the interactive user wait.
  rationaleGenerationMs: 15_000,
  rationaleScopeReviewMs: 15_000,
  approvalGateUserWaitMs: 5 * 60 * 1000,
  // Hard ceiling for the Electron `before-quit` cleanup chain
  // (runShutdownRoutines → svc.shutdown → pluginRuntime.stopAll →
  //  windowManager.persistAll). On expiry the host force-kills tracked
  //  child processes and calls `app.exit(0)`. Override via env
  //  `LVIS_SHUTDOWN_CLEANUP_TIMEOUT_MS` (legacy alias
  //  `LVIS_SHUTDOWN_TIMEOUT_MS` deprecated, removed by 2026-08-01).
  shutdownCleanupMs: 15_000,
  // Inner timeout for `forceKillProcessTree` between SIGTERM and SIGKILL on
  // a single tracked child. Bounded so shutdown never hangs on a stubborn
  // grandchild while still giving graceful exits a window.
  processTreeKillMs: 1_000,
  // Polling interval for detached process-group disposal. The total wall
  // clock for retries is bounded by `processGroupDisposalMaxMs` below.
  processGroupPollMs: 1_000,
  // Maximum wall-clock for `scheduleProcessGroupDisposal` retries before
  // forcing dispose. Prevents the managed-children Map from leaking entries
  // when a detached process group becomes orphaned into an unkillable
  // foreign uid.
  processGroupDisposalMaxMs: 5 * 60 * 1000,
} as const;

// Load-time invariant — fail loudly if the shell default drifts to a
// non-divisible value. The bash/powershell Zod schema does
// `.default(shellDefaultMs / 1000)`; if `shellDefaultMs` were e.g. 120_500,
// that default is 120.5 and the `.int()` schema rejects its OWN default at
// parse time. Crashing at module load makes the drift visible immediately.
for (const key of ["shellDefaultMs"] as const) {
  if (TOOL_TIMEOUT_POLICY[key] % 1000 !== 0) {
    throw new Error(
      `TOOL_TIMEOUT_POLICY.${key} (${TOOL_TIMEOUT_POLICY[key]}) must be divisible by 1000 — ` +
        "the bash/powershell Zod schema does `/ 1000` to expose seconds to the model, " +
        "and a non-divisible ms value yields a fractional default the integer schema rejects.",
    );
  }
}
