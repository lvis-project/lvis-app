/**
 * Tiny helpers for clearing one-shot/interval timers without repeating the
 * `if (timer) { clearX(timer); timer = null; }` boilerplate at every cleanup
 * site. Why: dangling-timer bugs are easy to introduce by forgetting either
 * the null-guard or the post-clear nulling — both matter for tests that
 * advance fake timers and for stop()/dispose() idempotency.
 */

export function clearTimeoutSafe(handle: NodeJS.Timeout | null): null {
  if (handle != null) clearTimeout(handle);
  return null;
}

export function clearIntervalSafe(handle: NodeJS.Timeout | null): null {
  if (handle != null) clearInterval(handle);
  return null;
}
