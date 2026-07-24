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

/** Termination reason recorded for audit and error message branching. */
export type ToolCeilingTerminationReason = "ceiling" | "user-abort" | "error";

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
