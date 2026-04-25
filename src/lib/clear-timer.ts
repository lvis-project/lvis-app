/**
 * Tiny helpers for clearing one-shot/interval timers without repeating the
 * `if (timer) { clearX(timer); timer = null; }` boilerplate at every cleanup
 * site. Why: dangling-timer bugs are easy to introduce by forgetting either
 * the null-guard or the post-clear nulling — both matter for tests that
 * advance fake timers and for stop()/dispose() idempotency.
 *
 * Two callable shapes are supported so callers can pass either a raw handle
 * (when the variable is mutable in the caller's scope) or a holder object
 * with a single `value` field (when the timer lives on `this`).
 */

export type TimerHolder<T> = { value: T | null };

export function clearTimeoutSafe(handle: NodeJS.Timeout | null): null {
  if (handle != null) clearTimeout(handle);
  return null;
}

export function clearIntervalSafe(handle: NodeJS.Timeout | null): null {
  if (handle != null) clearInterval(handle);
  return null;
}
