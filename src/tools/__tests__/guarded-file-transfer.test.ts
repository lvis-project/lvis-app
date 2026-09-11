import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { chmod, lstat, link, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyPath, runOwnedTransfer } from "../guarded-file-transfer.js";
import { FILE_TRANSFER_LIMITS } from "../file-transfer-policy.js";
import type { FileTransferLimits, TransferSession } from "../file-transfer-types.js";
import type { ToolExecutionContext } from "../types.js";

let root: string;
let source: string;
let destination: string;
let context: ToolExecutionContext;
const bytes = Buffer.from([0, 255, 128, 192, 13, 10, 65, 10, 13, 0]);
const digest = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");
async function* chunks(data: Uint8Array, size = 1): AsyncIterable<Uint8Array> {
  for (let offset = 0; offset < data.length; offset += size) yield data.subarray(offset, offset + size);
}
function limits(overrides: Partial<FileTransferLimits> = {}): FileTransferLimits {
  return { ...FILE_TRANSFER_LIMITS, bufferBytes: 4, ...overrides };
}
function transfer(produce: (session: TransferSession) => Promise<void>, overrides: Partial<FileTransferLimits> = {}, kind: "file" | "directory" = "directory") {
  return runOwnedTransfer({ sourcePath: source, destinationPath: destination, destinationKind: kind }, context, produce, limits(overrides));
}
async function absent(path: string): Promise<void> { await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" }); }

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "owned-file-transfer-")));
  source = join(root, "source.bin");
  destination = join(root, "destination");
  context = { cwd: root, extraAllowedDirectories: [], metadata: {} };
  await writeFile(source, bytes);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("complete binary copy", () => {
  it("copies actual binary bytes at the exact path without modifying the source", async () => {
    await chmod(source, 0o775);
    const before = await lstat(source);
    const result = await copyPath({ sourcePath: "source.bin", destinationPath: "destination" }, context);
    expect(result).toEqual({ ok: true, summary: { sourcePath: source, destinationPath: destination, files: 1, directories: 0, bytesWritten: bytes.length } });
    expect(digest(await readFile(destination))).toBe(digest(bytes));
    expect(await readFile(source)).toEqual(bytes);
    const after = await lstat(source);
    expect([after.mtimeMs, after.ctimeMs, after.mode, after.ino]).toEqual([before.mtimeMs, before.ctimeMs, before.mode, before.ino]);
    expect((await lstat(destination)).mode & 0o7777).toBe(0o700);
  });

  it("includes empty, nested, hidden and ordinarily skipped directories", async () => {
    source = join(root, "tree");
    await mkdir(source);
    for (const directory of ["empty", ".hidden", "node_modules", "dist", ".git"]) {
      await mkdir(join(source, directory));
      if (directory !== "empty") await writeFile(join(source, directory, "data.bin"), bytes);
    }
    await mkdir(join(source, ".hidden", "nested"));
    await writeFile(join(source, "empty.bin"), "");
    const result = await copyPath({ sourcePath: source, destinationPath: destination }, context);
    expect(result).toMatchObject({ ok: true, summary: { files: 5, directories: 7, bytesWritten: bytes.length * 4 } });
    expect(await readdir(join(destination, "empty"))).toEqual([]);
    for (const directory of [".hidden", "node_modules", "dist", ".git"]) expect(await readFile(join(destination, directory, "data.bin"))).toEqual(bytes);
    expect((await lstat(destination)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(destination, "empty.bin"))).mode & 0o777).toBe(0o600);
  });

  it("admits ancestor aliases while rejecting a source leaf link", async () => {
    await mkdir(join(root, "real"));
    await writeFile(join(root, "real", "input"), bytes);
    await symlink(join(root, "real"), join(root, "alias"));
    const result = await copyPath({ sourcePath: join(root, "alias", "input"), destinationPath: join(root, "alias", "output") }, context);
    expect(result).toMatchObject({ ok: true, summary: { destinationPath: join(root, "real", "output") } });
    await symlink(source, join(root, "link"));
    expect(await copyPath({ sourcePath: join(root, "link"), destinationPath: destination }, context)).toMatchObject({ ok: false, code: "unsupported-entry", cleanup: "not-created" });
  });
});

describe("authority and exclusive destinations", () => {
  it("preserves every existing destination type", async () => {
    for (const kind of ["file", "empty-directory", "nonempty-directory", "dangling-link"]) {
      const target = join(root, kind);
      if (kind === "file") await writeFile(target, "foreign");
      else if (kind === "dangling-link") await symlink(join(root, "missing"), target);
      else {
        await mkdir(target);
        if (kind === "nonempty-directory") await writeFile(join(target, "foreign"), "keep");
      }
      const before = await lstat(target);
      const result = await copyPath({ sourcePath: source, destinationPath: target }, context);
      expect(result).toMatchObject({ ok: false, cleanup: "not-created" });
      expect((await lstat(target)).ino).toBe(before.ino);
      if (kind === "file") expect(await readFile(target, "utf8")).toBe("foreign");
      if (kind === "nonempty-directory") expect(await readFile(join(target, "foreign"), "utf8")).toBe("keep");
    }
  });

  it("lets exactly one of two simultaneous creators keep its complete output", async () => {
    const results = await Promise.all([1, 2].map(() => copyPath({ sourcePath: source, destinationPath: destination }, context)));
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)).toMatchObject({ code: "destination-exists", cleanup: "not-created" });
    expect(await readFile(destination)).toEqual(bytes);
  });

  it("rejects all overlap directions and an absent destination parent before creation", async () => {
    source = join(root, "tree");
    await mkdir(source);
    await mkdir(join(source, "nested"));
    for (const [from, to] of [[source, source], [source, join(source, "new")], [join(source, "nested"), source]]) {
      expect(await copyPath({ sourcePath: from, destinationPath: to }, context)).toMatchObject({ ok: false, code: "source-destination-overlap", cleanup: "not-created" });
    }
    expect(await copyPath({ sourcePath: source, destinationPath: join(root, "absent", "new") }, context)).toMatchObject({ ok: false, code: "invalid-destination-parent", cleanup: "not-created" });
  });

  it("confines both endpoints and denies sensitive descendants", async () => {
    await mkdir(join(root, "workspace"));
    const narrowed = { ...context, cwd: join(root, "workspace") };
    expect(await copyPath({ sourcePath: source, destinationPath: join(narrowed.cwd, "copy") }, narrowed)).toMatchObject({ ok: false, code: "path-denied", cleanup: "not-created" });
    expect(await copyPath({ sourcePath: source, destinationPath: join(narrowed.cwd, "copy") }, { ...narrowed, extraAllowedDirectories: [root] })).toMatchObject({ ok: true });
    source = join(root, "tree");
    await mkdir(source);
    await writeFile(join(source, ".env"), "synthetic-only");
    expect(await copyPath({ sourcePath: source, destinationPath: destination }, context)).toMatchObject({ ok: false, code: "path-denied", cleanup: "removed" });
    await absent(destination);
  });

  it("rejects hardlinks and nested links without changing their targets", async () => {
    await link(source, join(root, "hardlink"));
    expect(await copyPath({ sourcePath: source, destinationPath: destination }, context)).toMatchObject({ ok: false, code: "unsupported-entry", cleanup: "not-created" });
    await rm(join(root, "hardlink"));
    source = join(root, "tree");
    await mkdir(source);
    await symlink(join(root, "source.bin"), join(source, "linked"));
    expect(await copyPath({ sourcePath: source, destinationPath: destination }, context)).toMatchObject({ ok: false, code: "unsupported-entry", cleanup: "removed" });
    expect(await readFile(join(root, "source.bin"))).toEqual(bytes);
  });
});

describe("bounded sink accounting", () => {
  it("accepts exact cumulative payload, entry, depth and path limits", async () => {
    const result = await transfer(async ({ sink }) => {
      await sink.file("a/b", chunks(bytes), { expectedBytes: bytes.length, ownerExecutable: false });
      await sink.directory("a");
    }, { maxPayloadBytes: bytes.length, maxEntries: 3, maxDepth: 2, maxRelativePathBytes: 3 });
    expect(result).toMatchObject({ ok: true, summary: { files: 1, directories: 2, bytesWritten: bytes.length } });
    expect(await readFile(join(destination, "a", "b"))).toEqual(bytes);
  });

  it.each([
    ["payload", { maxPayloadBytes: bytes.length - 1 }],
    ["entries", { maxEntries: 2 }],
    ["depth", { maxDepth: 1 }],
    ["path", { maxRelativePathBytes: 2 }],
  ] as const)("rolls back at the %s boundary plus one", async (_name, overrides) => {
    expect(await transfer(async ({ sink }) => {
      await sink.file("a/b", chunks(bytes), { expectedBytes: bytes.length, ownerExecutable: false });
    }, overrides)).toMatchObject({ ok: false, code: "limit-exceeded", cleanup: "removed" });
    await absent(destination);
  });

  it("counts cumulative payload and actual bytes, including zero-size declarations", async () => {
    expect(await transfer(async ({ sink }) => {
      await sink.file("first", chunks(bytes), { expectedBytes: bytes.length, ownerExecutable: false });
      await sink.file("second", chunks(bytes), { expectedBytes: bytes.length, ownerExecutable: false });
    }, { maxPayloadBytes: bytes.length })).toMatchObject({ ok: false, code: "limit-exceeded", cleanup: "removed" });
    for (const expectedBytes of [0, bytes.length - 1, bytes.length + 1]) {
      expect(await transfer(async ({ sink }) => {
        await sink.file("file", chunks(bytes), { expectedBytes, ownerExecutable: false });
      })).toMatchObject({ ok: false, code: "source-changed", cleanup: "removed" });
    }
  });

  it.each(["../escape", "/absolute", "a/../escape", "a//b", "a/./b", "a\\b", "C:drive", "a\0b"])("rejects invalid member %j", async (path) => {
    expect(await transfer(async ({ sink }) => { await sink.directory(path); })).toMatchObject({ ok: false, code: "path-denied", cleanup: "removed" });
    await absent(destination);
  });

  it("rejects duplicate files, directories and explicit implicit-parent repeats", async () => {
    for (const mode of ["file", "directory", "implicit"]) {
      expect(await transfer(async ({ sink }) => {
        if (mode === "file") {
          await sink.file("a", chunks(bytes), { expectedBytes: bytes.length, ownerExecutable: false });
          await sink.file("a", chunks(bytes), { expectedBytes: bytes.length, ownerExecutable: false });
        } else {
          if (mode === "implicit") await sink.file("a/b", chunks(bytes), { expectedBytes: bytes.length, ownerExecutable: false });
          await sink.directory("a");
          await sink.directory("a");
        }
      })).toMatchObject({ ok: false, code: "destination-exists", cleanup: "removed" });
    }
  });

  it("counts UTF-8 path bytes and rejects normalized path aliases", async () => {
    expect(await transfer(async ({ sink }) => { await sink.directory("é"); }, { maxRelativePathBytes: 1 })).toMatchObject({ ok: false, code: "limit-exceeded", cleanup: "removed" });
    expect(await transfer(async ({ sink }) => { await sink.directory("é"); }, { maxRelativePathBytes: 2 })).toMatchObject({ ok: true });
    await rm(destination, { recursive: true });
    expect(await transfer(async ({ sink }) => {
      await sink.file("é", chunks(bytes), { expectedBytes: bytes.length, ownerExecutable: false });
      await sink.file("e\u0301", chunks(bytes), { expectedBytes: bytes.length, ownerExecutable: false });
    })).toMatchObject({ ok: false, code: "destination-exists", cleanup: "removed" });
  });
});

describe("owned rollback and settlement", () => {
  it("preserves foreign additions and reports incomplete cleanup", async () => {
    const result = await transfer(async ({ sink, destinationPath }) => {
      await sink.file("owned", chunks(bytes), { expectedBytes: bytes.length, ownerExecutable: false });
      await writeFile(join(destinationPath, "foreign"), "preserve");
      throw new Error("synthetic producer failure");
    });
    expect(result).toMatchObject({ ok: false, code: "io-error", cleanup: "incomplete", residualPaths: [destination] });
    await absent(join(destination, "owned"));
    expect(await readFile(join(destination, "foreign"), "utf8")).toBe("preserve");
  });

  it("preserves substituted files and roots without traversing a replacement link", async () => {
    const moved = join(root, "moved");
    const result = await transfer(async ({ sink }) => {
      await sink.file("owned", chunks(bytes), { expectedBytes: bytes.length, ownerExecutable: false });
      await rename(destination, moved);
      await mkdir(join(root, "foreign-root"));
      await writeFile(join(root, "foreign-root", "owned"), "foreign");
      await symlink(join(root, "foreign-root"), destination);
      await sink.directory("next");
    });
    expect(result).toMatchObject({ ok: false, code: "source-changed", cleanup: "incomplete" });
    expect(await readFile(join(root, "foreign-root", "owned"), "utf8")).toBe("foreign");
    await absent(join(root, "foreign-root", "next"));
    expect(await readFile(join(moved, "owned"))).toEqual(bytes);
  });

  it("detects source growth after opening and removes the partial destination", async () => {
    expect(await transfer(async ({ openSourceFile, sink }) => {
      const body = await openSourceFile(source);
      await writeFile(source, Buffer.concat([bytes, Buffer.from([1])]));
      await sink.file("file", body, { expectedBytes: bytes.length, ownerExecutable: false });
    })).toMatchObject({ ok: false, code: "source-changed", cleanup: "removed" });
    await absent(destination);
  });

  it("cancels before creation and midway through body consumption with no late work", async () => {
    const controller = new AbortController();
    context.abortSignal = controller.signal;
    controller.abort();
    expect(await copyPath({ sourcePath: source, destinationPath: destination }, context)).toMatchObject({ ok: false, code: "cancelled", cleanup: "not-created" });
    const active = new AbortController();
    context.abortSignal = active.signal;
    let finalized = false;
    let saved: TransferSession | undefined;
    expect(await transfer(async (session) => {
      saved = session;
      const body = (async function* () {
        try { yield bytes.subarray(0, 4); active.abort(); yield bytes.subarray(4); }
        finally { finalized = true; }
      })();
      await session.sink.file("partial", body, { expectedBytes: bytes.length, ownerExecutable: false });
    })).toMatchObject({ ok: false, code: "cancelled", cleanup: "removed" });
    expect(finalized).toBe(true);
    await absent(destination);
    await expect(saved!.sink.directory("late")).rejects.toThrow("no longer accepts work");
    await new Promise<void>((done) => setImmediate(done));
    await absent(destination);
  });

  it("settles an opened but unconsumed source before reporting failure", async () => {
    let sourceStream: Awaited<ReturnType<TransferSession["openSourceFile"]>> | undefined;
    expect(await transfer(async (session) => { sourceStream = await session.openSourceFile(source); })).toMatchObject({ ok: false, code: "io-error", cleanup: "removed" });
    expect(sourceStream!.closed).toBe(true);
    await absent(destination);
  });

  it("rejects simultaneous source files and settles the already admitted stream", async () => {
    let first: Awaited<ReturnType<TransferSession["openSourceFile"]>> | undefined;
    expect(await transfer(async (session) => {
      first = await session.openSourceFile(source);
      await session.openSourceFile(source);
    })).toMatchObject({ ok: false, code: "io-error", cleanup: "removed" });
    expect(first!.closed).toBe(true);
  });

  it("cancels between entries without admitting a following file", async () => {
    const controller = new AbortController();
    context.abortSignal = controller.signal;
    expect(await transfer(async ({ sink }) => {
      await sink.file("first", chunks(bytes), { expectedBytes: bytes.length, ownerExecutable: false });
      controller.abort();
      await sink.file("second", chunks(bytes), { expectedBytes: bytes.length, ownerExecutable: false });
    })).toMatchObject({ ok: false, code: "cancelled", cleanup: "removed" });
    await absent(destination);
  });

  it("does not adopt external errno values as transfer failure codes", async () => {
    expect(await transfer(async () => { throw Object.assign(new Error("external failure"), { code: "cancelled" }); })).toMatchObject({ ok: false, code: "io-error", cleanup: "removed" });
  });
});
