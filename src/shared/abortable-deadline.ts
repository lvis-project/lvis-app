/** Neutral async deadline boundary with a linked AbortController. */
export type AbortableDeadlineTerminationReason =
  | "deadline"
  | "caller-abort"
  | "error";

export type AbortableDeadlineOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly reason: AbortableDeadlineTerminationReason;
      readonly error: Error;
    };

export interface AbortableDeadlineOptions {
  readonly deadlineMs: number;
  readonly callerAbortSignal?: AbortSignal;
  readonly createDeadlineError?: (deadlineMs: number) => Error;
}

function errorFrom(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(String(value ?? fallback));
}

/**
 * Run one task under a caller-linked, hard wall-clock deadline. The linked
 * signal lets cooperative work stop; Promise.race also bounds work that ignores
 * AbortSignal. Boundary causes are typed instead of inferred from error text.
 */
export async function runWithAbortableDeadline<T>(
  task: (signal: AbortSignal) => Promise<T>,
  options: AbortableDeadlineOptions,
): Promise<AbortableDeadlineOutcome<T>> {
  const controller = new AbortController();
  const callerSignal = options.callerAbortSignal;
  const callerAbortError = (): Error =>
    errorFrom(callerSignal?.reason, "caller aborted");
  const deadlineError = (): Error =>
    options.createDeadlineError?.(options.deadlineMs) ??
    new Error(`deadline exceeded after ${options.deadlineMs}ms`);

  if (callerSignal?.aborted) {
    return { ok: false, reason: "caller-abort", error: callerAbortError() };
  }

  let boundaryReason: "deadline" | "caller-abort" | null = null;
  let interruptionSettled = false;
  let resolveInterruption: (outcome: AbortableDeadlineOutcome<T>) => void = () => {};
  const interruptionOutcome = new Promise<AbortableDeadlineOutcome<T>>((resolve) => {
    resolveInterruption = (outcome) => {
      if (interruptionSettled) return;
      interruptionSettled = true;
      resolve(outcome);
    };
  });

  const interrupt = (
    reason: "deadline" | "caller-abort",
    error: Error,
  ): void => {
    if (boundaryReason !== null) return;
    boundaryReason = reason;
    resolveInterruption({ ok: false, reason, error });
    controller.abort(error);
  };

  const timer = setTimeout(
    () => interrupt("deadline", deadlineError()),
    options.deadlineMs,
  );
  const onCallerAbort = (): void => {
    interrupt("caller-abort", callerAbortError());
  };
  callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  // Close the subscribe-after-check race.
  if (callerSignal?.aborted) onCallerAbort();

  const taskOutcome = Promise.resolve()
    .then(() => task(controller.signal))
    .then((value): AbortableDeadlineOutcome<T> => ({ ok: true, value }))
    .catch((error): AbortableDeadlineOutcome<T> => {
      if (boundaryReason !== null) {
        return {
          ok: false,
          reason: boundaryReason,
          error: boundaryReason === "caller-abort"
            ? callerAbortError()
            : deadlineError(),
        };
      }
      if (callerSignal?.aborted) {
        return { ok: false, reason: "caller-abort", error: callerAbortError() };
      }
      return {
        ok: false,
        reason: "error",
        error: errorFrom(error, "task failed"),
      };
    });

  try {
    return await Promise.race([taskOutcome, interruptionOutcome]);
  } finally {
    interruptionSettled = true;
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", onCallerAbort);
  }
}
