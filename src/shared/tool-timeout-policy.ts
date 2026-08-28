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
 *    `resolveSubAgentCeilingMs(configured round budget)` instead of
 *    `globalCeilingMs`. The round budget is user-configurable and has no
 *    maximum (see shared/subagent-policy.ts), so a fixed wall clock would
 *    silently re-impose the cap the round setting exists to remove: at 600s
 *    and a 600-round budget the agent dies of the clock long before its
 *    rounds. The ceiling therefore scales with the budget.
 *  - User-input gates (e.g. ApprovalGate) are exempt from the tool execution
 *    cap — they have their own `approvalGateUserWaitMs` because the user is
 *    actively present, not the runtime hanging.
 *
 * The user-facing principle: never let the user wait indefinitely, and never
 * kill work the model explicitly budgeted for. An unspecified call gets
 * `shellDefaultMs`; a model that times out escalates by retrying with a
 * larger `timeoutSeconds`.
 */
import { SUBAGENT_MAX_ROUNDS_DEFAULT } from "./subagent-policy.js";

/**
 * Largest delay a Node `setTimeout` can actually hold.
 *
 * Node stores the delay as a SIGNED 32-BIT integer. A delay above this
 * overflows, and Node's documented response is to warn and substitute `1` —
 * so a ceiling of 2_147_483_648ms does not mean "a very long deadline", it
 * means the timer fires ~immediately and aborts the call it was armed to
 * protect. Both scaled ceilings can cross the bound from ordinary settings:
 * `resolveSubAgentCeilingMs` at a `subAgentMaxRounds` of 214_749, and a shell
 * `timeoutSeconds` of 2_147_474 — neither of which the round budget nor the
 * shell timeout caps, both deliberately (see the notes above).
 *
 * The resolution is therefore a CLAMP, not a rejection: every resolved ceiling
 * passes through `Math.min` against this bound in `resolveEffectiveCeilingMs`
 * (the one place all executor timer arms are computed), so an oversized budget
 * degrades to "the longest deadline Node can arm" — ~24.9 days — instead of to
 * no deadline at all.
 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

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
  // FLOOR for the `agent_spawn` wall clock — see `resolveSubAgentCeilingMs`.
  // A sub-agent whose configured round budget is small still gets this much
  // wall clock, so shrinking the budget never shrinks the deadline below the
  // value every release before the scaling change shipped with.
  subAgentCeilingFloorMs: 600_000,
  // Wall clock granted per configured sub-agent round. Derived from the pair
  // this policy already shipped: the 600s ceiling was chosen against the 60-
  // round default budget (SUBAGENT_MAX_ROUNDS_DEFAULT), i.e. 10s per round.
  // Keeping that ratio is what makes the scaled ceiling a generalization of
  // the old constant rather than a new number: at the default budget the two
  // agree exactly.
  subAgentPerRoundAllowanceMs: 10_000,
  mcpRequestDefaultMs: 60_000,
  mcpRequestMaxMs: 120_000,
  networkFetchDefaultMs: 15_000,
  // How long a model provider may stay silent. Two waits share this one
  // number: the provider fetch's transport deadline (the response headers)
  // and the adapter's idle re-arm (each delta once the body is streaming).
  // Model responses are not web fetches: a self-hosted gateway that answers
  // only when generation is complete legitimately stays silent for well over
  // `networkFetchDefaultMs` while it prefills and reasons.
  modelStreamIdleCeilingMs: 300_000,
  // Host-owned LLM boundaries for the permission-rationale path. These are
  // separate from ordinary tool execution and the interactive user wait.
  rationaleGenerationMs: 15_000,
  rationaleScopeReviewMs: 15_000,
  approvalGateUserWaitMs: 5 * 60 * 1000,
  // Hard ceiling for the Electron `before-quit` cleanup chain
  // (runShutdownRoutines → svc.shutdown → pluginRuntime.stopAll →
  //  windowManager.persistAll). On expiry the host force-kills tracked
  //  child processes and calls `app.exit(0)`. Override via env
  //  `LVIS_SHUTDOWN_CLEANUP_TIMEOUT_MS`.
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

/**
 * The one rule for what counts as a usable shutdown cleanup window.
 *
 * Three surfaces ask it — the `system.shutdownCleanupTimeoutMs` setting as it
 * is read off disk, the same setting as it arrives in an update patch, and
 * `LVIS_SHUTDOWN_CLEANUP_TIMEOUT_MS` (registered in ENV_BACKED_SETTINGS, which
 * calls this as its `forcedValue`) — so it is written once rather than three
 * times that could disagree about, say, whether `"0"` is a value.
 *
 * `undefined` means "not usable", which every caller reads as "fall through to
 * the next source", never as "no timeout": a shutdown with no deadline is the
 * hang this policy exists to prevent.
 *
 * The upper clamp is not cosmetic. The resolved value is handed to
 * `setTimeout`, and a delay above {@link MAX_TIMER_DELAY_MS} overflows Node's
 * signed 32-bit store — Node warns and substitutes `1`, so an operator asking
 * for a month-long grace period would get a cleanup killed after one
 * millisecond. Clamping degrades that to the longest window Node can arm.
 */
export function normalizeShutdownCleanupTimeoutMs(value: unknown): number | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value.trim())
        : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.min(Math.floor(parsed), MAX_TIMER_DELAY_MS);
}

/**
 * Wall-clock ceiling for ONE `agent_spawn` invocation, scaled to the round
 * budget that invocation may actually run.
 *
 * `max(floor, rounds × allowance)` — never below the shipped 600s, so this is
 * a widening of the previous constant and can only turn a killed-by-the-clock
 * run into a completed one. A deadline still always exists and is still
 * finite: the budget is a bounded host setting, not model input, so a tool
 * call cannot buy itself unbounded wall clock by asking for it.
 */
export function resolveSubAgentCeilingMs(configuredRounds: number): number {
  const rounds = Number.isFinite(configuredRounds) ? Math.floor(configuredRounds) : 0;
  return Math.max(
    TOOL_TIMEOUT_POLICY.subAgentCeilingFloorMs,
    rounds * TOOL_TIMEOUT_POLICY.subAgentPerRoundAllowanceMs,
  );
}

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

// Load-time invariant — the per-round allowance is DERIVED from the shipped
// pair (600s ceiling for the 60-round default budget), not independently
// chosen. If either side is retuned without the other, `resolveSubAgentCeilingMs`
// silently stops agreeing with the constant it generalizes at the default
// budget, so pin the derivation here rather than in a comment alone.
if (
  TOOL_TIMEOUT_POLICY.subAgentPerRoundAllowanceMs * SUBAGENT_MAX_ROUNDS_DEFAULT
  !== TOOL_TIMEOUT_POLICY.subAgentCeilingFloorMs
) {
  throw new Error(
    "TOOL_TIMEOUT_POLICY.subAgentPerRoundAllowanceMs "
      + `(${TOOL_TIMEOUT_POLICY.subAgentPerRoundAllowanceMs}) × SUBAGENT_MAX_ROUNDS_DEFAULT `
      + `(${SUBAGENT_MAX_ROUNDS_DEFAULT}) must equal subAgentCeilingFloorMs `
      + `(${TOOL_TIMEOUT_POLICY.subAgentCeilingFloorMs}) — the per-round allowance is derived `
      + "from that pair, so the scaled ceiling must agree with the floor at the default budget.",
  );
}
