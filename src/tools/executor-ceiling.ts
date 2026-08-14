/**
 * Tool execution ceiling — last-resort cap with linked AbortController.
 *
 * The wrapper bridges the executor's parent `abortSignal` and a ceiling
 * timer into a single `AbortSignal` passed to the underlying tool. The wrapper
 * also returns as soon as either abort boundary fires, even when the underlying
 * tool ignores the signal and leaves its Promise pending.
 *
 * Extracted from `executor.ts` Step 6 (Execute) so the ceiling semantics can
 * be unit-tested without instantiating the full 8-step pipeline.
 */

import type { Tool } from "./base.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";

/** Termination reason recorded for audit and error message branching. */
export type ToolCeilingTerminationReason = "ceiling" | "user-abort" | "error";

/**
 * Head-room between a shell tool's own `timeoutSeconds` expiry and the
 * executor ceiling. The tool kills the child itself and then formats a
 * retryable "timed out after N seconds" result; without this margin the
 * ceiling would race that formatting and replace a retryable tool error with
 * an opaque ceiling abort.
 */
const SHELL_CEILING_GRACE_MS = 10_000;

/**
 * Ceiling for one tool invocation.
 *
 * Two host-owned escalation paths exist, and BOTH are gated on
 * `source === "builtin"`:
 *
 *  - A builtin that runs a bounded loop of its own declares
 *    `resolveHostCeilingMs` (today: `agent_spawn`, whose wall clock scales
 *    with the configured sub-agent round budget). The value is host-derived,
 *    never read from tool input.
 *  - Builtin shell tools carry their own `timeoutSeconds`, which is unbounded
 *    above the default on purpose (see TOOL_TIMEOUT_POLICY): when the model
 *    escalates past `globalCeilingMs` the ceiling follows, otherwise the retry
 *    that names a larger budget would still be cut at the old ceiling.
 *
 * Every other tool keeps `globalCeilingMs`. A plugin or MCP tool cannot raise
 * its own ceiling — not by declaring a `timeoutSeconds` field (only builtin
 * shell inputs are read) and not by declaring `resolveHostCeilingMs` (neither
 * adapter can produce a builtin `Tool`). Its expiry is not a dead end either:
 * the executor turns it into a retryable tool error naming the host bound, so
 * the model can narrow the work and call again.
 */
export function resolveEffectiveCeilingMs(
  tool: Pick<Tool, "name" | "source" | "category" | "resolveHostCeilingMs">,
  input: Record<string, unknown>,
): number {
  if (tool.source === "builtin" && tool.resolveHostCeilingMs) {
    return tool.resolveHostCeilingMs();
  }
  if (tool.source !== "builtin" || tool.category !== "shell") {
    return TOOL_TIMEOUT_POLICY.globalCeilingMs;
  }
  const requested = input.timeoutSeconds;
  if (typeof requested !== "number" || !Number.isFinite(requested) || requested <= 0) {
    return TOOL_TIMEOUT_POLICY.globalCeilingMs;
  }
  return Math.max(
    TOOL_TIMEOUT_POLICY.globalCeilingMs + SHELL_CEILING_GRACE_MS,
    Math.ceil(requested * 1000) + SHELL_CEILING_GRACE_MS,
  );
}

/** Actual underlying task settlement. Discriminated by `ok`. */
type ToolTaskOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; reason: ToolCeilingTerminationReason; error: Error };

/**
 * Prompt caller-facing outcome. When interruption wins before a
 * signal-ignoring task settles, `settlement` remains pending until that actual
 * task finishes so authority owners can keep their lease poisoned meanwhile.
 */
export type ToolCeilingOutcome<T> = ToolTaskOutcome<T> & {
  readonly settlement?: Promise<ToolTaskOutcome<T>>;
};

/**
 * Run `task` under a ceiling. The task receives a signal that aborts when:
 *   (a) the ceiling timer fires (`reason: "ceiling"`),
 *   (b) the caller-supplied `parentAbortSignal` aborts (`reason: "user-abort"`),
 *   (c) the task throws on its own (`reason: "error"`).
 *
 * The ceiling timer is always cleared, and any listener attached to the
 * parent signal is detached in the `finally` block so the wrapper does not
 * leak timers or event listeners on the long-lived parent signal.
 */
export async function runWithCeiling<T>(
  task: (signal: AbortSignal) => Promise<T>,
  ceilingMs: number,
  parentAbortSignal: AbortSignal | undefined,
  taskName: string,
): Promise<ToolCeilingOutcome<T>> {
  const ceilingController = new AbortController();
  let resolveInterruption: (outcome: ToolTaskOutcome<T>) => void = () => {};
  let interruptionSettled = false;
  const interruptionOutcome = new Promise<ToolTaskOutcome<T>>((resolve) => {
    resolveInterruption = (outcome) => {
      if (interruptionSettled) return;
      interruptionSettled = true;
      resolve(outcome);
    };
  });
  const parentAbortError = (): Error =>
    parentAbortSignal?.reason instanceof Error
      ? parentAbortSignal.reason
      : new Error(String(parentAbortSignal?.reason ?? "parent aborted"));
  let ceilingFired = false;
  const timer = setTimeout(() => {
    ceilingFired = true;
    const err = new Error(`tool execution exceeded global ceiling (${ceilingMs}ms): ${taskName}`);
    resolveInterruption({ ok: false, reason: "ceiling", error: err });
    ceilingController.abort(err);
  }, ceilingMs);

  // Fast path: parent already aborted at entry. Skip calling `task` entirely
  // — many tools subscribe to abort via `addEventListener("abort", ...)`,
  // which is a no-op on an already-aborted signal, so the tool would hang.
  if (parentAbortSignal?.aborted) {
    clearTimeout(timer);
    return { ok: false, reason: "user-abort", error: parentAbortError() };
  }

  let parentAbortListener: (() => void) | undefined;
  if (parentAbortSignal) {
    parentAbortListener = () => {
      const err = parentAbortError();
      resolveInterruption({ ok: false, reason: "user-abort", error: err });
      ceilingController.abort(err);
    };
    parentAbortSignal.addEventListener("abort", parentAbortListener, { once: true });
  }

  const taskOutcome: Promise<ToolTaskOutcome<T>> = Promise.resolve()
    .then(() => task(ceilingController.signal))
    .then((value): ToolTaskOutcome<T> => ({ ok: true, value }))
    .catch((err): ToolTaskOutcome<T> => {
      if (ceilingFired) {
        return {
          ok: false,
          reason: "ceiling",
          error: new Error(
            `tool execution exceeded global ceiling (${ceilingMs}ms): ${taskName}`,
          ),
        };
      }
      if (parentAbortSignal?.aborted) {
        return {
          ok: false,
          reason: "user-abort",
          error: err instanceof Error ? err : new Error(String(err)),
        };
      }
      return {
        ok: false,
        reason: "error",
        error: err instanceof Error ? err : new Error(String(err)),
      };
    });

  try {
    const winner = await Promise.race([
      taskOutcome.then((outcome) => ({ source: "task" as const, outcome })),
      interruptionOutcome.then((outcome) => ({
        source: "interruption" as const,
        outcome,
      })),
    ]);
    return winner.source === "task"
      ? winner.outcome
      : { ...winner.outcome, settlement: taskOutcome };
  } finally {
    interruptionSettled = true;
    clearTimeout(timer);
    if (parentAbortListener && parentAbortSignal) {
      parentAbortSignal.removeEventListener("abort", parentAbortListener);
    }
  }
}
