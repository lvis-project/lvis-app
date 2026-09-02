/**
 * Single authority for the Windows transient-file-lock retry policy.
 *
 * On Windows another process — a plugin webview/worker, an antivirus scanner,
 * the shell indexer — can hold a handle to a file we are trying to `rename()`
 * or `rm()`, and the call is rejected until the lock clears. That typically
 * happens within a few hundred milliseconds.
 *
 * Three ladders defend against this class and they CANNOT be merged into one:
 * `replaceStagedFile` (lib/atomic-file.ts) is synchronous and waits with
 * `Atomics.wait`; `retryOnTransientFsLock` (plugins/plugin-artifact-store.ts)
 * is asynchronous and waits with `setTimeout`; `renameWithTransientRetry`
 * (tools/file-tools.ts) is asynchronous inside a tool turn. This module owns
 * what they can share — the delay curve, the attempt budgets, and the
 * retryable code sets — so they can never again disagree by accident. They
 * previously did: the sync side budgeted 60ms against a class documented to
 * clear in a few hundred milliseconds, i.e. it could not outlast the thing it
 * existed for; the tool side kept a private 10/25/50/100/200 curve.
 *
 * The budgets are DIFFERENT ON PURPOSE, and that is not the same failure as
 * the drift this module exists to prevent. Drift is two copies nobody
 * reconciled; this is one authority expressing justified budgets, each named
 * for the constraint that sets it (the tool-turn budget lives beside its
 * ladder, since only that caller has the constraint).
 */

/** Delay before retry `attempt` (1-based): 50/100/150/200 then held at 250. */
export function transientFsLockDelayMs(attempt: number): number {
  return Math.min(50 * attempt, 250);
}

function totalWaitFor(attempts: number): number {
  let total = 0;
  for (let attempt = 1; attempt < attempts; attempt += 1) {
    total += transientFsLockDelayMs(attempt);
  }
  return total;
}

/**
 * Budget for a SYNCHRONOUS caller — 5 attempts, 500ms of total wait.
 *
 * Deliberately far smaller than the background budget because this blocks the
 * calling thread, and for `writeUtf8FileAtomicSync` that thread is the Electron
 * main thread: the whole UI including window chrome stops, and a block of
 * ~1s+ is what earns the Windows "not responding" ghost-window treatment. That
 * is a worse outcome than the failed write it would prevent, and a silent one —
 * the failure at least surfaces an error the user can act on.
 *
 * 1000ms, not the 500ms this shipped with. That number rested on "a lock still
 * held past a few hundred milliseconds is a process holding the handle
 * indefinitely, and no budget rescues that" — which the settings store then
 * falsified. `withFileLock` already serializes its writers, so back-to-back
 * locked writes are the normal case, and the OS handle from the previous write
 * outlives the lock release. Under load that lost the race at 500ms
 * deterministically, and the same write succeeds when the machine is quiet: the
 * contention clears, just later than the documented figure.
 *
 * A lost settings write silently discards a permission the user granted, which
 * is worse than the delay. 1000ms is still far short of the point where an
 * unresponsive-window prompt appears, so the reason the budget is small — this
 * blocks the caller, and for the settings/secret/session writers that caller is
 * the Electron main thread — is unchanged.
 */
export const SYNC_UI_BLOCKING_ATTEMPTS = 7;
export const SYNC_UI_BLOCKING_BUDGET_MS = totalWaitFor(SYNC_UI_BLOCKING_ATTEMPTS);

/**
 * Budget for an ASYNCHRONOUS caller — 10 attempts, ~1750ms of total wait.
 *
 * Nothing blocks while these sleeps run, so the install/rollback paths can
 * afford to outlast a slow scanner. Still bounded so an install can never hang
 * the user indefinitely.
 */
export const BACKGROUND_ATTEMPTS = 10;
export const BACKGROUND_BUDGET_MS = totalWaitFor(BACKGROUND_ATTEMPTS);

/**
 * Retryable codes when renaming ONE FILE onto another (`replaceStagedFile`).
 *
 * `ENOTEMPTY`/`EEXIST` are absent on purpose rather than by oversight: they are
 * directory-shaped and unreachable here, so listing them would advertise
 * coverage that does not exist. `ENOENT` is absent from both sets — an absent
 * source is a legitimate "first install" signal callers must be able to tell
 * apart from a locked one.
 */
export const RENAME_FILE_LOCK_CODES: ReadonlySet<string> = new Set([
  "EPERM",
  "EACCES",
  "EBUSY",
]);

/**
 * Retryable codes for directory-level swaps and `rm()`
 * (`retryOnTransientFsLock`). Superset of {@link RENAME_FILE_LOCK_CODES}: a
 * non-empty or already-existing directory target is reachable on these paths.
 */
export const DIRECTORY_OP_LOCK_CODES: ReadonlySet<string> = new Set([
  ...RENAME_FILE_LOCK_CODES,
  "ENOTEMPTY",
  "EEXIST",
]);
