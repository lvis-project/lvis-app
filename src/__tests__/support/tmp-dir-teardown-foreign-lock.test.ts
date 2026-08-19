/**
 * The teardown helper against a REAL Windows lock, not an injected error code.
 *
 * `artifact-store-test-helpers.test.ts` already proves the retry rule by
 * mocking `rm` to reject. What it cannot show is that the rule is aimed at the
 * condition that actually occurs, and two things about that condition are
 * counter-intuitive enough to be worth pinning against the OS:
 *
 *   - a handle THIS process holds never produces the `EPERM` refusal, so "we
 *     forgot to await a write" cannot be the cause of the reported failures;
 *   - `rmSync`'s own `maxRetries`/`retryDelay` does not apply to it, so the
 *     ~500ms budget the old teardown appeared to have was never spent.
 *
 * The lock is taken by a separate process with `FileShare.None`, which is what
 * a scanner does and what Node's `fs` never does. Windows-only by nature: the
 * failure mode does not exist on the other platforms, so there is nothing to
 * assert there.
 */
import { describe, it, expect } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  closeSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cleanupTmpDir } from "./tmp-dir-teardown.js";

const isWindows = process.platform === "win32";

/** A scratch tree shaped like the audit fixtures: a file a few levels down. */
function makeTree(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "lvis-teardown-lock-"));
  const inner = join(dir, ".lvis", "audit");
  mkdirSync(inner, { recursive: true });
  const file = join(inner, "permission-audit.jsonl");
  writeFileSync(file, "line\n", "utf-8");
  return { dir, file };
}

/** Stop the lock owner and wait until its non-share-delete handle is gone. */
async function stopForeignLock(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill();
  await exited;
}

/**
 * Hold `file` from another process without sharing delete, then poll until the
 * lock is observably in force. Polling rather than sleeping is what makes this
 * deterministic: the assertions never run before the condition exists.
 */
async function holdForeignLock(file: string, holdMs: number): Promise<ChildProcess> {
  const child = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$f=[System.IO.File]::Open('${file}','Open','ReadWrite','None');`
        + ` Start-Sleep -Milliseconds ${holdMs}; $f.Close()`,
    ],
    { stdio: "ignore" },
  );
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      closeSync(openSync(file, "r+"));
    } catch {
      return child; // the foreign handle is in force
    }
    if (Date.now() > deadline) throw new Error("foreign lock never took hold");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe.skipIf(!isWindows)("scratch-directory teardown under a foreign lock", () => {
  it("is refused outright by a bare rmSync, retries included", async () => {
    const { dir, file } = makeTree();
    let child: ChildProcess | undefined;
    try {
      child = await holdForeignLock(file, 1_500);
      const started = Date.now();
      // Intentional behavior probe; fixture teardown stays in the finally block.
      expect(() =>
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
      ).toThrow(/EPERM|EBUSY|EACCES/);
      // The tell from the bug reports: it gives up at once. Whatever budget
      // `maxRetries` implies, none of it is spent on this error.
      expect(Date.now() - started).toBeLessThan(200);
      expect(existsSync(dir)).toBe(true);
    } finally {
      if (child) await stopForeignLock(child);
      await cleanupTmpDir(dir);
    }
  });

  it("succeeds through the retry ladder once the lock clears", async () => {
    const { dir, file } = makeTree();
    // Long enough to outlast what the old teardown could wait for, short
    // enough to sit inside the ladder's budget.
    let child: ChildProcess | undefined;
    try {
      child = await holdForeignLock(file, 800);
      await cleanupTmpDir(dir);
      expect(existsSync(dir)).toBe(false);
    } finally {
      if (child) await stopForeignLock(child);
      await cleanupTmpDir(dir);
    }
  });

  it("is never the EPERM signature when the open handle is this process's own", async () => {
    // Node opens with FILE_SHARE_DELETE, so our own descriptor cannot produce
    // the refusal above. It can still leave the parent momentarily non-empty —
    // that is a DIFFERENT, retryable code, and one the old teardown's
    // `maxRetries` did cover. The distinction is the whole diagnosis: an
    // unawaited write of ours would have to show up as that code, not as EPERM,
    // so awaiting harder was never going to fix the reported failures.
    const { dir, file } = makeTree();
    const fd = openSync(file, "a");
    let code: string | undefined;
    try {
      try {
        // Intentional behavior probe; fixture teardown stays in the finally block.
        rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        code = (err as NodeJS.ErrnoException).code;
      }
    } finally {
      closeSync(fd);
      await cleanupTmpDir(dir);
    }

    expect(code).not.toBe("EPERM");
    expect(existsSync(dir)).toBe(false);
  });
});
