/**
 * Teardown for the OS resources a test leaves behind — scratch directories and
 * the child processes it spawned. Both leak for the same reason: the cleanup was
 * written on the happy path, and the happy path is the one a loaded machine does
 * not take.
 *
 * Directory teardown, retried against Windows file locks:
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
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { rm } from "node:fs/promises";

import { retryOnTransientFsLock } from "../../plugins/plugin-artifact-store.js";

/** Remove a test's scratch directory, retrying the transient lock codes. */
export async function cleanupTmpDir(dir: string): Promise<void> {
  await retryOnTransientFsLock(() => rm(dir, { recursive: true, force: true }));
}

/**
 * Reap the child processes a test spawned.
 *
 * The kills these tests were written with sit inline, after the awaits they
 * follow. That is correct on the happy path and wrong on every other one: a
 * rejected wait or a failed `expect` jumps straight past the kill, and the child
 * outlives the test that owns it.
 *
 * Under full-suite load that is not hypothetical, it is the common case. A test's
 * inner liveness timeout — "the child did not report in within N seconds" — is
 * the first thing to fire on a saturated machine, so the leak opens exactly when
 * the machine can least afford another process. Worse, the children these
 * fixtures spawn are not idle: they hold file locks. One leaked lock owner makes
 * the next test wait out its own timeout, which leaks in turn. That feedback is
 * what turns a slow run into a runaway rather than merely a late one.
 *
 * Tracking is per-tracker rather than module-global so two suites in one worker
 * can never reap each other's children.
 */
export function createChildTracker(): ChildTracker {
  const tracked: ChildProcess[] = [];
  return {
    track(child) {
      tracked.push(child);
      return child;
    },
    async reap() {
      const pending = tracked.splice(0);
      await Promise.all(pending.map(stopChild));
    },
  };
}

export interface ChildTracker {
  /** Register a spawned child; returns it so a spawn call can be wrapped in place. */
  track: <T extends ChildProcess>(child: T) => T;
  /** Stop every registered child and wait for it to be gone. Safe to call twice. */
  reap: () => Promise<void>;
}

/**
 * SIGTERM, then SIGKILL if the child does not go.
 *
 * The escalation is not politeness. A child blocked in a lock acquisition may be
 * inside a syscall when the signal arrives, and waiting forever for it to exit
 * would move the hang from the test into the teardown, where it is harder to see.
 */
async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const escalation = setTimeout(() => child.kill("SIGKILL"), CHILD_TERM_GRACE_MS);
  try {
    await exited;
  } finally {
    clearTimeout(escalation);
  }
}

const CHILD_TERM_GRACE_MS = 2_000;

/**
 * Track the scratch directories a suite creates and remove them together.
 *
 * The four boot-step suites each kept a module-level `Set` plus a `trackTmpDir`
 * that added to it and an `afterEach` that drained it — the same three lines,
 * four times. Per-tracker rather than module-global for the reason
 * {@link createChildTracker} gives: two suites in one worker must never sweep
 * each other's directories.
 */
export function createTmpDirTracker(): TmpDirTracker {
  const dirs = new Set<string>();
  return {
    track(dir) {
      dirs.add(dir);
      return dir;
    },
    async cleanup() {
      const pending = [...dirs];
      dirs.clear();
      for (const dir of pending) await cleanupTmpDir(dir);
    },
  };
}

export interface TmpDirTracker {
  /** Register a scratch directory; returns it so `mkdtempSync(...)` can be wrapped in place. */
  track: (dir: string) => string;
  /** Remove every registered directory (retrying transient locks). Safe to call twice. */
  cleanup: () => Promise<void>;
}
