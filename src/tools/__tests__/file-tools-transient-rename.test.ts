/**
 * Own file because it mocks `node:fs/promises` and the retry sleep for the
 * whole module graph; `file-tools.test.ts` exercises the real filesystem.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { transientFsLockDelayMs } from "../../lib/transient-fs-lock-retry.js";

const renameFailures: string[] = [];
const sleeps: number[] = [];

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      const code = renameFailures.shift();
      if (code) {
        throw Object.assign(new Error(`${code}: locked`), { code });
      }
      return actual.rename(from, to);
    },
  };
});

vi.mock("../../shared/abortable-deadline.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../shared/abortable-deadline.js")>();
  return {
    ...actual,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  };
});

const { WriteFileTool } = await import("../file-tools.js");

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "lvis-file-tools-rename-"));
  renameFailures.length = 0;
  sleeps.length = 0;
});

afterEach(async () => {
  await cleanupTmpDir(workDir);
});

describe("write_file transient rename retry", () => {
  it("waits on the shared transient-lock curve, not a private one", async () => {
    // Before consolidation this ladder slept 10ms then 25ms — a third curve
    // beside the sync and background ladders that share transient-fs-lock-retry.
    renameFailures.push("EBUSY", "EPERM");
    const result = await new WriteFileTool().execute(
      { path: "notes.txt", content: "hello" },
      { cwd: workDir, extraAllowedDirectories: [], metadata: {} },
    );
    expect(result.isError).toBe(false);
    expect(readFileSync(join(workDir, "notes.txt"), "utf8")).toBe("hello");
    expect(sleeps).toEqual([transientFsLockDelayMs(1), transientFsLockDelayMs(2)]);
  });

  it("does not retry a code outside the shared retryable set", async () => {
    renameFailures.push("ENOENT");
    await expect(new WriteFileTool().execute(
      { path: "notes.txt", content: "hello" },
      { cwd: workDir, extraAllowedDirectories: [], metadata: {} },
    )).rejects.toMatchObject({ code: "ENOENT" });
    expect(sleeps).toEqual([]);
  });
});
