/**
 * Tests for withFileLock:
 * - Concurrent writes are serialised (no interleaving).
 * - Stale lock recovery: a leftover .lock dir is cleaned up automatically.
 * - Reads during an active write see the pre-write value (lock excludes them
 *   from the critical section, not from plain reads — this is by design).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import lockfile from "proper-lockfile";
import { FileLockReleaseError, createSerialQueue, withFileLock, withInProcessFileQueue } from "../with-file-lock.js";

import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

let tmpDir: string;
let testFile: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "with-file-lock-test-"));
  testFile = join(tmpDir, "shared.json");
  writeFileSync(testFile, JSON.stringify({ counter: 0 }), "utf-8");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTmpDir(tmpDir);
});

// Helper: read counter from testFile
function readCounter(): number {
  return (JSON.parse(readFileSync(testFile, "utf-8")) as { counter: number }).counter;
}

// Helper: increment counter inside lock
async function incrementUnderLock(): Promise<void> {
  await withFileLock(testFile, async () => {
    const current = readCounter();
    // Yield so that other concurrent tasks can interleave (they must not).
    await new Promise((r) => setTimeout(r, 5));
    writeFileSync(testFile, JSON.stringify({ counter: current + 1 }), "utf-8");
  }, { retries: 20 });
}

describe("withFileLock", () => {
  it("serialises concurrent writes — no lost updates", async () => {
    const N = 5;
    await Promise.all(Array.from({ length: N }, () => incrementUnderLock()));
    expect(readCounter()).toBe(N);
  });

  it("creates target file if it does not exist", async () => {
    const newFile = join(tmpDir, "nonexistent.json");
    await withFileLock(newFile, async () => {
      writeFileSync(newFile, JSON.stringify({ created: true }), "utf-8");
    });
    expect(existsSync(newFile)).toBe(true);
  });

  it("stale lock recovery — removes leftover .lock dir and acquires fresh lock", async () => {
    // Simulate a stale lock: proper-lockfile uses a .lock *directory* next to the file.
    // We must backdate mtime so proper-lockfile considers it stale.
    const staleLockDir = `${testFile}.lock`;
    mkdirSync(staleLockDir);
    const pastSec = (Date.now() - 2000) / 1000;
    const { utimesSync } = await import("node:fs");
    utimesSync(staleLockDir, pastSec, pastSec);

    let executed = false;
    // stale: 500 ms — the lock dir is 2s old, so it will be considered stale
    await withFileLock(
      testFile,
      async () => {
        executed = true;
      },
      { stale: 500, retries: 3 },
    );
    expect(executed).toBe(true);
  });

  it("propagates errors from fn and releases the lock", async () => {
    await expect(
      withFileLock(testFile, async () => {
        throw new Error("test-error");
      }),
    ).rejects.toThrow("test-error");

    // Lock should be released — a subsequent lock attempt must succeed.
    let ran = false;
    await withFileLock(testFile, async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it("distinguishes callback completion from a release failure", async () => {
    const realLock = lockfile.lock.bind(lockfile);
    vi.spyOn(lockfile, "lock").mockImplementationOnce(async (...args) => {
      const release = await realLock(...args);
      return async () => {
        await release();
        throw new Error("injected release failure");
      };
    });

    const error = await withFileLock(testFile, async () => "committed-result").catch(
      (caught) => caught,
    );
    expect(error).toBeInstanceOf(FileLockReleaseError);
    expect((error as FileLockReleaseError<string>).result).toBe("committed-result");
    expect((error as FileLockReleaseError<string>).releaseError).toEqual(
      new Error("injected release failure"),
    );
  });
});

describe("withInProcessFileQueue", () => {
  it("serializes read-modify-write against the same path", async () => {
    // The property the five copied queues existed for: two interleaved
    // read-modify-writes must not both read 0 and both write 1.
    const order: string[] = [];
    const bump = (tag: string) => withInProcessFileQueue(testFile, async () => {
      const current = JSON.parse(readFileSync(testFile, "utf-8")) as { counter: number };
      order.push(`${tag}:read=${current.counter}`);
      await new Promise((r) => setTimeout(r, 5));
      writeFileSync(testFile, JSON.stringify({ counter: current.counter + 1 }), "utf-8");
      order.push(`${tag}:wrote=${current.counter + 1}`);
    });
    await Promise.all([bump("a"), bump("b")]);
    expect(JSON.parse(readFileSync(testFile, "utf-8"))).toEqual({ counter: 2 });
    expect(order).toEqual(["a:read=0", "a:wrote=1", "b:read=1", "b:wrote=2"]);
  });

  it("does not serialize across different paths", async () => {
    const other = join(tmpDir, "other.json");
    let releaseFirst: (() => void) | undefined;
    const first = withInProcessFileQueue(testFile, () => new Promise<void>((resolve) => {
      releaseFirst = resolve;
    }));
    let secondRan = false;
    const second = withInProcessFileQueue(other, async () => {
      secondRan = true;
    });
    await second;
    expect(secondRan).toBe(true);
    releaseFirst?.();
    await first;
  });

  it("keeps the queue moving after a rejected callback", async () => {
    // A poisoned entry that wedged the chain would take the store offline for
    // the rest of the session, so the stored link swallows both settlements
    // while the rejection still reaches the caller that caused it.
    await expect(
      withInProcessFileQueue(testFile, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(withInProcessFileQueue(testFile, async () => "after")).resolves.toBe("after");
  });

  it("is not the cross-process lock and creates no lockfile", async () => {
    // The three stores that named this `withFileLock` sat next to thirteen
    // modules importing the real one. Nothing here touches proper-lockfile.
    await withInProcessFileQueue(testFile, async () => undefined);
    expect(existsSync(`${testFile}.lock`)).toBe(false);
    await withFileLock(testFile, async () => undefined);
    expect(existsSync(`${testFile}.lock`)).toBe(false);
  });
});

describe("createSerialQueue", () => {
  it("runs work in submission order, one at a time", async () => {
    const queue = createSerialQueue();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const first = queue(() => new Promise<string>((resolve) => {
      releaseFirst = () => { order.push("first:done"); resolve("first"); };
    }));
    const second = queue(async () => { order.push("second:start"); return "second"; });
    await new Promise((r) => setTimeout(r, 5));
    expect(order).toEqual([]);
    releaseFirst();
    expect(await Promise.all([first, second])).toEqual(["first", "second"]);
    expect(order).toEqual(["first:done", "second:start"]);
  });

  it("hands a rejection to its own caller without wedging the queue", async () => {
    const queue = createSerialQueue();
    const failed = queue(async () => { throw new Error("boom"); });
    const next = queue(async () => "after");
    await expect(failed).rejects.toThrow("boom");
    expect(await next).toBe("after");
  });
});
