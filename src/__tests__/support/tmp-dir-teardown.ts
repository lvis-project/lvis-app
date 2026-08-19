/**
 * Throwaway-directory teardown for tests, retried against Windows file locks.
 *
 * A bare `rmSync(tmp, { recursive: true, force: true })` in an `afterEach` is
 * not safe on Windows. Another process — an antivirus scanner, the shell
 * indexer — can hold a handle inside the tree microseconds after the test's
 * last write, and the removal is refused until that handle goes. The
 * assertions have already passed at that point, so the suite reports a failure
 * for a test that did its job, and it reproduces only under full-suite load,
 * which is what makes it read as flake rather than as a fixable defect.
 *
 * Two details are worth stating because they are counter-intuitive:
 *
 * 1. An `EPERM` here cannot be one of OUR OWN leaked handles. Node opens files
 *    with `FILE_SHARE_DELETE`, so a descriptor this process still holds never
 *    produces that refusal — measured, not assumed. It can leave the parent
 *    momentarily non-empty, but that is a different and separately retryable
 *    code. The `EPERM` refusal requires a handle opened WITHOUT share-delete,
 *    which only a foreign process does. That is why "await the pending write"
 *    does not fix this class: an outstanding write of ours could not have
 *    produced the error in the first place.
 *
 * 2. `rmSync`'s own `maxRetries`/`retryDelay` does not cover it. Against a
 *    foreign lock it fails immediately — 0ms, no retry — so the budget it
 *    appears to offer is not applied to this error at all.
 *
 * Delegates to the production `retryOnTransientFsLock` rather than open-coding
 * a second ladder: that helper owns the retryable codes and the delay curve,
 * and a divergent copy here is exactly the duplicate authority
 * `src/lib/transient-fs-lock-retry.ts` exists to prevent.
 */
import { rm } from "node:fs/promises";

import { retryOnTransientFsLock } from "../../plugins/plugin-artifact-store.js";

/** Remove a test's scratch directory, retrying the transient lock codes. */
export async function cleanupTmpDir(dir: string): Promise<void> {
  await retryOnTransientFsLock(() => rm(dir, { recursive: true, force: true }));
}
