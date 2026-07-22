import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
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

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lvis-atomic-file-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
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
});
