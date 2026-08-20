/**
 * Test support: count the `sync()` (fsync) calls a write path makes.
 *
 * Wraps `fs.promises.open` so every FileHandle it hands back tallies its
 * `sync()` invocations. A durability-claiming write that routes through the
 * feature-namespace atomic-write authority opens its staging file and fsyncs
 * the bytes (and, on POSIX, the parent directory) before the rename, so the
 * counter lands >= 1. A pre-convergence `writeFile`+`rename` copy fsyncs
 * nothing, so the counter stays 0 — which is what makes a `>= 1` assertion go
 * red when the fix is reverted.
 *
 * Shared rather than inlined per test so the three converged stores assert the
 * same guarantee against one observer, and so the duplicate-body test gate does
 * not see the same ~10-line wrapper copied across files.
 */
import { promises as fsp } from "node:fs";

export interface FileHandleSyncObserver {
  /** Number of FileHandle.sync() calls counted so far. */
  calls(): number;
  /** Restore the original `fs.promises.open`. Always call in a `finally`. */
  restore(): void;
}

export function observeFileHandleSyncs(): FileHandleSyncObserver {
  const realOpen = fsp.open.bind(fsp);
  let calls = 0;
  const patched = (async (...args: Parameters<typeof fsp.open>) => {
    const handle = await realOpen(...(args as [never]));
    const realSync = handle.sync.bind(handle);
    (handle as { sync: () => Promise<void> }).sync = async () => {
      calls += 1;
      return realSync();
    };
    return handle;
  }) as typeof fsp.open;
  (fsp as { open: typeof fsp.open }).open = patched;
  return {
    calls: () => calls,
    restore: () => {
      (fsp as { open: typeof fsp.open }).open = realOpen;
    },
  };
}
