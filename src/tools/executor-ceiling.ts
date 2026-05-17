/**
 * Tool execution ceiling — last-resort cap with linked AbortController.
 *
 * The wrapper bridges the executor's parent `abortSignal` and a ceiling
 * timer into a single `AbortSignal` passed to the underlying tool. When the
 * ceiling fires, the tool's signal is aborted so any tool that participates
 * in abortSignal cancellation (built-in shell, MCP adapter, plugin handlers)
 * stops its underlying work instead of being orphaned.
 *
 * Extracted from `executor.ts` Step 6 (Execute) so the ceiling semantics can
 * be unit-tested without instantiating the full 8-step pipeline.
 */

/** Termination reason recorded for audit and error message branching. */
export type ToolCeilingTerminationReason = "ceiling" | "user-abort" | "error";

/** Result of a ceiling-wrapped execution. Discriminated by `ok`. */
export type ToolCeilingOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; reason: ToolCeilingTerminationReason; error: Error };

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
  let ceilingFired = false;
  const timer = setTimeout(() => {
    ceilingFired = true;
    ceilingController.abort(
      new Error(`tool execution exceeded global ceiling (${ceilingMs}ms): ${taskName}`),
    );
  }, ceilingMs);

  // Fast path: parent already aborted at entry. Skip calling `task` entirely
  // — many tools subscribe to abort via `addEventListener("abort", ...)`,
  // which is a no-op on an already-aborted signal, so the tool would hang.
  if (parentAbortSignal?.aborted) {
    clearTimeout(timer);
    const reason =
      parentAbortSignal.reason instanceof Error
        ? parentAbortSignal.reason
        : new Error(String(parentAbortSignal.reason ?? "parent aborted"));
    return { ok: false, reason: "user-abort", error: reason };
  }

  let parentAbortListener: (() => void) | undefined;
  if (parentAbortSignal) {
    parentAbortListener = () =>
      ceilingController.abort(parentAbortSignal.reason ?? new Error("parent aborted"));
    parentAbortSignal.addEventListener("abort", parentAbortListener, { once: true });
  }

  try {
    const value = await task(ceilingController.signal);
    return { ok: true, value };
  } catch (err) {
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
  } finally {
    clearTimeout(timer);
    if (parentAbortListener && parentAbortSignal) {
      parentAbortSignal.removeEventListener("abort", parentAbortListener);
    }
  }
}
