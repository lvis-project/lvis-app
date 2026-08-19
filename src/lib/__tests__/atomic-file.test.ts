import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  replaceUtf8FileAtomicSyncIf,
  writeUtf8FileAtomicSync,
} from "../atomic-file.js";
import {
  BACKGROUND_ATTEMPTS,
  BACKGROUND_BUDGET_MS,
  SYNC_UI_BLOCKING_ATTEMPTS,
  SYNC_UI_BLOCKING_BUDGET_MS,
  transientFsLockDelayMs,
} from "../transient-fs-lock-retry.js";
import { retryOnTransientFsLock } from "../../plugins/plugin-artifact-store.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lvis-atomic-file-"));
});

afterEach(async () => {
  await cleanupTmpDir(dir);
});

describe("writeUtf8FileAtomicSync", () => {
  it("creates a missing parent namespace before the atomic write", () => {
    const target = join(dir, "nested", "settings.json");

    writeUtf8FileAtomicSync(target, "created");

    expect(readFileSync(target, "utf8")).toBe("created");
    if (process.platform !== "win32") {
      expect(statSync(join(dir, "nested")).mode & 0o777).toBe(0o700);
    }
  });

  it("atomically replaces UTF-8 content without leaving a staging file", () => {
    const target = join(dir, "settings.json");
    writeFileSync(target, "old", "utf8");

    writeUtf8FileAtomicSync(target, "새 내용\n", 0o600);

    expect(readFileSync(target, "utf8")).toBe("새 내용\n");
    expect(readdirSync(dir)).toEqual(["settings.json"]);
    if (process.platform !== "win32") {
      expect(statSync(target).mode & 0o777).toBe(0o600);
    }
  });

  it("keeps the destination intact when a final replacement precondition fails", () => {
    const target = join(dir, "AGENTS.md");
    writeFileSync(target, "user edit", "utf8");

    const replaced = replaceUtf8FileAtomicSyncIf(
      target,
      "packaged update",
      () => false,
    );

    expect(replaced).toBe(false);
    expect(readFileSync(target, "utf8")).toBe("user edit");
    expect(readdirSync(dir)).toEqual(["AGENTS.md"]);
  });

  it("residual TOCTOU window stays whole-file: an external write between check and rename is replaced atomically, never partial (#1640)", () => {
    // Accepted Minor residual: precondition() and renameSync() are not a
    // filesystem CAS. Drive the race deterministically — the precondition
    // itself performs a same-user external write inside the window, then still
    // approves — and assert the bounded behavior: the staged content wins as a
    // whole file (no partial/corrupt state, no leftover temp). This pins that
    // the window can only ever be whole-file last-writer-wins.
    const target = join(dir, "AGENTS.md");
    writeFileSync(target, "packaged prior", "utf8");

    const replaced = replaceUtf8FileAtomicSyncIf(target, "migrated content", () => {
      writeFileSync(target, "racing external editor content", "utf8");
      return true;
    });

    expect(replaced).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("migrated content");
    expect(readdirSync(dir)).toEqual(["AGENTS.md"]);
  });

  it("cleans its unique temporary file when the final rename fails", () => {
    const target = join(dir, "existing-directory");
    mkdirSync(target);

    expect(() => writeUtf8FileAtomicSync(target, "not committed")).toThrow();

    expect(readdirSync(dir)).toEqual(["existing-directory"]);
    expect(readdirSync(target)).toEqual([]);
  });

  it("marks a post-rename directory sync failure as already committed", () => {
    const target = join(dir, "committed.json");
    const fakeDirectoryFd = 0x7fff_ffff;
    const writeWithDirectorySyncRuntime = writeUtf8FileAtomicSync as unknown as (
      filePath: string,
      content: string,
      mode: number | undefined,
      runtime: {
        platform: NodeJS.Platform;
        open(parentDir: string): number;
        fsync(fd: number): void;
        close(fd: number): void;
      },
    ) => void;
    let thrown: unknown;

    try {
      writeWithDirectorySyncRuntime(target, "committed", undefined, {
        platform: "linux",
        open: () => fakeDirectoryFd,
        fsync: () => {
          throw Object.assign(new Error("forced directory fsync failure"), { code: "EIO" });
        },
        close: () => undefined,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      code: "ATOMIC_FILE_DIRECTORY_SYNC_FAILED",
      committed: true,
    });
    expect(readFileSync(target, "utf8")).toBe("committed");
    expect(readdirSync(dir)).toEqual(["committed.json"]);
  });

  it("retries transient Windows replacement failures and commits whole bytes", () => {
    const target = join(dir, "windows.json");
    writeFileSync(target, "old", "utf8");
    let attempts = 0;
    const waits: number[] = [];
    const writeWithRuntime = writeUtf8FileAtomicSync as unknown as (
      path: string,
      content: string,
      mode: number | undefined,
      runtime: { platform: NodeJS.Platform; open(path: string): number; fsync(fd: number): void; close(fd: number): void; rename(from: string, to: string): void; wait(ms: number): void },
    ) => void;

    writeWithRuntime(target, "new", undefined, {
      platform: "win32",
      open: () => 0,
      fsync: () => undefined,
      close: () => undefined,
      rename: (from, to) => {
        attempts += 1;
        if (attempts < 3) throw Object.assign(new Error("transient"), { code: "EACCES" });
        renameSync(from, to);
      },
      wait: (ms) => waits.push(ms),
    });

    expect(attempts).toBe(3);
    // Schedule comes from the shared ladder, not a local constant.
    expect(waits).toEqual([transientFsLockDelayMs(1), transientFsLockDelayMs(2)]);
    expect(readFileSync(target, "utf8")).toBe("new");
    expect(readdirSync(dir)).toEqual(["windows.json"]);
  });

  it.each(["EPERM", "EACCES"])("preserves the Windows target after persistent %s", (code) => {
    const target = join(dir, "windows.json");
    writeFileSync(target, "old", "utf8");
    let attempts = 0;
    const writeWithRuntime = writeUtf8FileAtomicSync as unknown as (
      path: string,
      content: string,
      mode: number | undefined,
      runtime: { platform: NodeJS.Platform; open(path: string): number; fsync(fd: number): void; close(fd: number): void; rename(from: string, to: string): void; wait(ms: number): void },
    ) => void;

    expect(() => writeWithRuntime(target, "new", undefined, {
      platform: "win32",
      open: () => 0,
      fsync: () => undefined,
      close: () => undefined,
      rename: () => {
        attempts += 1;
        throw Object.assign(new Error("persistent"), { code });
      },
      wait: () => undefined,
    })).toThrow("persistent");
    expect(attempts).toBe(SYNC_UI_BLOCKING_ATTEMPTS);
    expect(readFileSync(target, "utf8")).toBe("old");
    expect(readdirSync(dir)).toEqual(["windows.json"]);
  });

  it("takes its curve and budget from the shared policy, and so does the async ladder", async () => {
    // The two ladders defend against the same Windows lock class and cannot be
    // merged (this one is sync/Atomics.wait, the other async/setTimeout). They
    // HAD drifted: this side budgeted 60ms against a class its sibling
    // documents as clearing in "a few hundred milliseconds".
    //
    // NOT asserting the two totals are EQUAL — they are deliberately different
    // now, because only this side blocks the caller (the Electron main thread
    // for the settings/secret writers). What must hold is that neither side
    // hardcodes its own schedule: both observed wait sequences have to be the
    // shared curve evaluated over that side's own budget. Hardcoding a
    // different curve on either side breaks its row.
    const target = join(dir, "windows.json");
    writeFileSync(target, "old", "utf8");
    const syncWaits: number[] = [];
    const writeWithRuntime = writeUtf8FileAtomicSync as unknown as (
      path: string,
      content: string,
      mode: number | undefined,
      runtime: { platform: NodeJS.Platform; open(path: string): number; fsync(fd: number): void; close(fd: number): void; rename(from: string, to: string): void; wait(ms: number): void },
    ) => void;

    expect(() => writeWithRuntime(target, "new", undefined, {
      platform: "win32",
      open: () => 0,
      fsync: () => undefined,
      close: () => undefined,
      rename: () => {
        throw Object.assign(new Error("locked"), { code: "EBUSY" });
      },
      wait: (ms) => syncWaits.push(ms),
    })).toThrow("locked");

    // Drive the REAL async ladder over a permanently-locked op and record its
    // sleeps the same way.
    const asyncWaits: number[] = [];
    await expect(
      retryOnTransientFsLock(
        async () => {
          throw Object.assign(new Error("locked"), { code: "EBUSY" });
        },
        { sleep: async (ms) => { asyncWaits.push(ms); } },
      ),
    ).rejects.toThrow("locked");

    const curveOver = (attempts: number) =>
      Array.from({ length: attempts - 1 }, (_, i) => transientFsLockDelayMs(i + 1));

    // Each side rides the SHARED curve over its OWN budget.
    expect(syncWaits).toEqual(curveOver(SYNC_UI_BLOCKING_ATTEMPTS));
    expect(asyncWaits).toEqual(curveOver(BACKGROUND_ATTEMPTS));

    const syncTotal = syncWaits.reduce((sum, ms) => sum + ms, 0);
    const asyncTotal = asyncWaits.reduce((sum, ms) => sum + ms, 0);
    expect(syncTotal).toBe(SYNC_UI_BLOCKING_BUDGET_MS);
    expect(asyncTotal).toBe(BACKGROUND_BUDGET_MS);

    // The property that made the ORIGINAL budget wrong: 60ms could not outlast
    // a lock class documented to clear in a few hundred milliseconds. The 500ms
    // that replaced it could not either — `withFileLock` serializes the
    // settings writers, so back-to-back locked writes are normal and the OS
    // handle outlives the lock release. That lost deterministically under load
    // while succeeding on a quiet machine, so the contention was clearing, just
    // later than documented. A lost settings write silently discards a
    // permission the user granted.
    expect(syncTotal).toBeGreaterThanOrEqual(1000);
    // ...and the property that keeps the fix from becoming a UI freeze. This
    // blocks the main thread, and Windows shows the unresponsive-window prompt
    // at roughly five seconds, so the ceiling is about staying far short of
    // that rather than about any threshold at one second. If someone raises
    // this toward the background budget, this fails.
    expect(syncTotal).toBeLessThanOrEqual(1200);
    expect(syncTotal).toBeLessThan(asyncTotal);
  });
});
