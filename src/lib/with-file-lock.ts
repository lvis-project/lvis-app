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
import { dirname, resolve } from "node:path";
import { errorMessage } from "../shared/error-message.js";

/**
 * Serialize `fn` against every other call for the same path IN THIS PROCESS.
 *
 * NOT a lock, and named so that no one reads it as one. Five modules had this
 * exact six-line promise chain, and three of them called it `withFileLock` --
 * the name of the cross-process lock defined below in this same file. A reader
 * who sees `await withFileLock(this.filePath, ...)` in a store and assumes the
 * imported helper is wrong about what is protecting the file.
 *
 * WHAT IT GIVES: read-modify-write on a JSON store cannot interleave with
 * another read-modify-write issued from the same module instance. That is the
 * whole guarantee.
 *
 * WHAT IT DOES NOT GIVE: anything at all against a second process -- the CLI, a
 * utility process, a plugin child, a second app instance -- or against another
 * copy of the same module loaded into a different JS realm. The queue is a
 * module-local Map; a second realm gets a second Map and the two writers do not
 * see each other. Callers relying on this are relying on the file having ONE
 * writer process, which is a real property of the host-owned `~/.lvis` stores
 * and is stated here so it can be checked rather than assumed.
 *
 * Use {@link withFileLock} instead when a second process can write the file.
 *
 * A rejected `fn` does not wedge the queue: the chain stored for the next
 * caller swallows both settlement paths, while the rejection itself is returned
 * to the caller that produced it.
 */
export async function withInProcessFileQueue<T>(
  filePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = resolve(filePath);
  let queue = inProcessFileQueues.get(key);
  if (!queue) {
    queue = createSerialQueue();
    inProcessFileQueues.set(key, queue);
  }
  return queue(fn);
}

const inProcessFileQueues = new Map<string, SerialQueue>();

/** Runs `work` after every previously queued `work` has settled. */
export type SerialQueue = <T>(work: () => Promise<T>) => Promise<T>;

/**
 * One in-process FIFO. The promise chain that every "mutex" in the tree was
 * re-typing by hand: a caller's `work` starts only after the previous caller's
 * `work` has settled, in submission order, and a rejection is handed back to
 * the caller that produced it without wedging the queue for the next one.
 *
 * Same scope caveat as {@link withInProcessFileQueue}: this orders callers
 * inside ONE module instance of ONE process and nothing else.
 */
export function createSerialQueue(): SerialQueue {
  let tail: Promise<void> = Promise.resolve();
  return <T>(work: () => Promise<T>): Promise<T> => {
    const next = tail.then(() => work());
    tail = next.then(() => undefined, () => undefined);
    return next;
  };
}


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
 * The protected callback completed, but proper-lockfile could not confirm
 * release. Callers that durably committed inside the callback may reconcile
 * their exact output before deciding whether the operation succeeded.
 */
export class FileLockReleaseError<T> extends Error {
  readonly callbackCompleted = true;

  constructor(
    readonly result: T,
    readonly releaseError: unknown,
  ) {
    super(`file lock callback completed but release failed: ${errorMessage(releaseError)}`);
    this.name = "FileLockReleaseError";
    this.cause = releaseError;
  }
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

  let result: T;
  try {
    result = await fn();
  } catch (callbackError) {
    try {
      await release();
    } catch (releaseError) {
      throw new AggregateError(
        [callbackError, releaseError],
        "file lock callback and release both failed",
      );
    }
    throw callbackError;
  }

  try {
    await release();
  } catch (releaseError) {
    throw new FileLockReleaseError(result, releaseError);
  }
  return result;
}
