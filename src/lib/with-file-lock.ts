/**
 * Cross-process file lock helper — wraps `proper-lockfile`.
 *
 * Usage:
 *   const result = await withFileLock("/path/to/file.json", async () => {
 *     // read-modify-write
 *     return result;
 *   });
 *
 * - Acquires a `.lock` lockfile next to `path` before calling `fn`.
 * - Releases unconditionally in a finally block.
 * - Stale lock detection: `stale` option (default 10 s) auto-removes locks
 *   left behind by crashed processes.
 * - `retries` option: default 5 attempts with exponential back-off (proper-lockfile built-in).
 */
import lockfile from "proper-lockfile";
import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";

export interface FileLockOptions {
  /**
   * Duration in ms after which a lock is considered stale (crashed process).
   * Defaults to 10_000 ms.
   */
  stale?: number;
  /**
   * Number of retry attempts when lock is already held.
   * Defaults to 5 (proper-lockfile exponential back-off).
   */
  retries?: number;
}

/**
 * Acquire a cross-process file lock on `targetPath`, execute `fn`, then
 * release the lock.  The target file is created as an empty file if it
 * does not yet exist so that proper-lockfile can stat() it.
 */
export async function withFileLock<T>(
  targetPath: string,
  fn: () => Promise<T>,
  opts: FileLockOptions = {},
): Promise<T> {
  const { stale = 10_000, retries = 5 } = opts;

  // Ensure parent directory and a placeholder file exist so lockfile can stat it.
  await mkdir(dirname(targetPath), { recursive: true });
  // Touch the file without overwriting existing content. `open(..., "a")`
  // atomically creates it if absent, avoiding check-then-create races.
  const handle = await open(targetPath, "a", 0o600);
  await handle.close();

  const release = await lockfile.lock(targetPath, {
    stale,
    retries: {
      retries,
      minTimeout: 50,
      maxTimeout: 500,
      factor: 2,
    },
    realpath: false,
  });

  try {
    return await fn();
  } finally {
    await release();
  }
}
