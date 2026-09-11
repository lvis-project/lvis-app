import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile, lstat, open, opendir, rmdir, unlink, type FileHandle } from "node:fs/promises";
import { read } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { copyPath, runOwnedTransfer } from "../guarded-file-transfer.js";
import { FILE_TRANSFER_LIMITS } from "../file-transfer-policy.js";
import type { ToolExecutionContext } from "../types.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open), opendir: vi.fn(actual.opendir), rmdir: vi.fn(actual.rmdir), unlink: vi.fn(actual.unlink) };
});
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, read: vi.fn(actual.read) };
});

const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
let root: string;
let source: string;
let destination: string;
let context: ToolExecutionContext;
const bytes = Buffer.from([0, 255, 192, 10, 13, 128, 9, 8, 7, 6]);
const attributes = { expectedBytes: bytes.length, ownerExecutable: false };
async function* body() { for (const byte of bytes) yield Uint8Array.of(byte); }
const turn = () => new Promise<void>((done) => setImmediate(done));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(async () => {
  vi.mocked(open).mockImplementation(actual.open);
  vi.mocked(opendir).mockImplementation(actual.opendir);
  vi.mocked(rmdir).mockImplementation(actual.rmdir);
  vi.mocked(unlink).mockImplementation(actual.unlink);
  vi.mocked(read).mockImplementation(actualFs.read);
  root = await realpath(await mkdtemp(join(tmpdir(), "owned-transfer-failures-")));
  source = join(root, "input.bin");
  destination = join(root, "output");
  context = { cwd: root, extraAllowedDirectories: [], metadata: {} };
  await writeFile(source, bytes);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});
function transfer(produce: Parameters<typeof runOwnedTransfer>[2], kind: "file" | "directory" = "directory") {
  return runOwnedTransfer({ sourcePath: source, destinationPath: destination, destinationKind: kind }, context, produce, { ...FILE_TRANSFER_LIMITS, bufferBytes: 4 });
}
function observeHandles(observe: (handle: FileHandle, path: string) => void): void {
  vi.mocked(open).mockImplementation(async (...args) => {
    const handle = await actual.open(...args);
    observe(handle, String(args[0]));
    return handle;
  });
}

function interceptWrites(
  handle: FileHandle,
  write: (buffer: Uint8Array, offset: number, length: number, position: number | null) => Promise<{ bytesWritten: number; buffer: Uint8Array }>,
): void {
  vi.spyOn(handle, "write").mockImplementation(write as FileHandle["write"]);
}

describe("descriptor and stream settlement", () => {
  it("coalesces byte chunks, waits for short writes and closes every descriptor once", async () => {
    const closes: ReturnType<typeof vi.spyOn>[] = [];
    const requests: number[] = [];
    let yielded = 0;
    observeHandles((handle, path) => {
      closes.push(vi.spyOn(handle, "close"));
      if (path === destination) {
        const write = handle.write.bind(handle);
        interceptWrites(handle, async (buffer, offset, length, position) => {
          requests.push(length as number);
          expect(yielded).toBeLessThanOrEqual(4 + requests.length * 2);
          return write(buffer as Buffer, offset as number, Math.min(length as number, 2), position as number | null);
        });
      }
    });
    const result = await transfer(async ({ sink }) => {
      await sink.file("", (async function* () { for (const byte of bytes) { yielded += 1; yield Uint8Array.of(byte); } })(), attributes);
    }, "file");
    expect(result).toMatchObject({ ok: true, summary: { bytesWritten: bytes.length } });
    expect(requests).toEqual([4, 2, 4, 2, 2]);
    expect(await readFile(destination)).toEqual(bytes);
    for (const close of closes) expect(close).toHaveBeenCalledTimes(1);
  });

  it("waits for an in-flight write, then rolls back before cancellation returns", async () => {
    const controller = new AbortController();
    context.abortSignal = controller.signal;
    const started = deferred();
    const release = deferred();
    let activeWrites = 0;
    let completed = false;
    const closes: ReturnType<typeof vi.spyOn>[] = [];
    observeHandles((handle, path) => {
      closes.push(vi.spyOn(handle, "close"));
      if (path === destination) {
        const write = handle.write.bind(handle);
        interceptWrites(handle, async (buffer, offset, length, position) => {
          activeWrites += 1;
          started.resolve();
          await release.promise;
          try { return await write(buffer as Buffer, offset as number, length as number, position as number | null); }
          finally { activeWrites -= 1; }
        });
      }
    });
    const pending = transfer(async ({ sink }) => { await sink.file("", body(), attributes); }, "file").then((result) => { completed = true; return result; });
    await started.promise;
    controller.abort();
    await turn();
    expect(completed).toBe(false);
    expect(activeWrites).toBe(1);
    release.resolve();
    expect(await pending).toMatchObject({ ok: false, code: "cancelled", cleanup: "removed" });
    expect(activeWrites).toBe(0);
    for (const close of closes) expect(close).toHaveBeenCalledTimes(1);
    await turn();
    await expect(lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("waits for a pending source read and releases its descriptor once", async () => {
    const controller = new AbortController();
    context.abortSignal = controller.signal;
    const started = deferred();
    const release = deferred();
    const closes: ReturnType<typeof vi.spyOn>[] = [];
    let reads = 0;
    let completed = false;
    observeHandles((handle) => { closes.push(vi.spyOn(handle, "close")); });
    vi.mocked(read).mockImplementation((...args: Parameters<typeof actualFs.read>) => {
      reads += 1;
      started.resolve();
      void release.promise.then(() => {
        reads -= 1;
        actualFs.read(...args);
      });
    });
    const pending = copyPath({ sourcePath: source, destinationPath: destination }, context).then((result) => { completed = true; return result; });
    await started.promise;
    controller.abort();
    await turn();
    expect(completed).toBe(false);
    release.resolve();
    expect(await pending).toMatchObject({ ok: false, code: "cancelled", cleanup: "removed" });
    expect(reads).toBe(0);
    for (const close of closes) expect(close).toHaveBeenCalledTimes(1);
    await turn();
    await expect(lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("propagates an actual source stream read failure and still closes both handles", async () => {
    const closes: ReturnType<typeof vi.spyOn>[] = [];
    observeHandles((handle) => { closes.push(vi.spyOn(handle, "close")); });
    vi.mocked(read).mockImplementation((...args: Parameters<typeof actualFs.read>) => {
      const callback = args[args.length - 1] as (error: Error) => void;
      queueMicrotask(() => callback(Object.assign(new Error("synthetic read failure"), { code: "EIO" })));
    });
    expect(await copyPath({ sourcePath: source, destinationPath: destination }, context)).toMatchObject({ ok: false, code: "io-error", cleanup: "removed" });
    for (const close of closes) expect(close).toHaveBeenCalledTimes(1);
    await expect(lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rolls back partial writes after disk-full failure and rejects zero-progress writes", async () => {
    for (const failure of ["disk-full", "zero-progress"]) {
      observeHandles((handle, path) => {
        if (path !== destination) return;
        const write = handle.write.bind(handle);
        let count = 0;
        interceptWrites(handle, async (buffer, offset, _length, position) => {
          count += 1;
          if (count === 1) return write(buffer as Buffer, offset as number, 1, position as number | null);
          if (failure === "zero-progress") return { buffer, bytesWritten: 0 };
          throw Object.assign(new Error("synthetic disk full"), { code: "ENOSPC" });
        });
      });
      expect(await transfer(async ({ sink }) => { await sink.file("", body(), attributes); }, "file")).toMatchObject({ ok: false, code: "io-error", cleanup: "removed" });
      await expect(lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("reports close failure as incomplete even after removable files are gone", async () => {
    observeHandles((handle, path) => {
      if (path !== destination) return;
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "close").mockImplementation(async () => { await close(); throw new Error("synthetic close acknowledgement failure"); });
    });
    const result = await transfer(async ({ sink }) => { await sink.file("", body(), attributes); }, "file");
    expect(result).toMatchObject({ ok: false, code: "io-error", cleanup: "incomplete" });
    if (!result.ok) expect(result.cleanupErrors?.join(" ")).toContain("Descriptor close failed");
    await expect(lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cancels during descriptor finalization before returning success", async () => {
    const controller = new AbortController();
    context.abortSignal = controller.signal;
    observeHandles((handle, path) => {
      if (path !== destination) return;
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "close").mockImplementation(async () => { controller.abort(); await close(); });
    });
    expect(await transfer(async ({ sink }) => { await sink.file("", body(), attributes); }, "file")).toMatchObject({ ok: false, code: "cancelled", cleanup: "removed" });
    await expect(lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves an exclusively created file when descriptor identity cannot be captured", async () => {
    const closes: ReturnType<typeof vi.spyOn>[] = [];
    observeHandles((handle, path) => {
      closes.push(vi.spyOn(handle, "close"));
      if (path === destination) vi.spyOn(handle, "stat").mockRejectedValue(new Error("synthetic identity read failure"));
    });
    expect(await transfer(async ({ sink }) => { await sink.file("", body(), attributes); }, "file")).toMatchObject({ ok: false, code: "io-error", cleanup: "incomplete", residualPaths: [destination] });
    expect(await readFile(destination)).toEqual(Buffer.alloc(0));
    for (const close of closes) expect(close).toHaveBeenCalledTimes(1);
  });

  it("surfaces a source directory close failure after its traversal settles", async () => {
    source = join(root, "directory");
    await mkdir(source);
    await writeFile(join(source, "bytes"), bytes);
    vi.mocked(opendir).mockImplementation(async (...args) => {
      const directory = await actual.opendir(...args);
      const close = directory.close.bind(directory);
      vi.spyOn(directory, "close").mockImplementation(async () => {
        await close();
        throw new Error("synthetic directory close acknowledgement failure");
      });
      return directory;
    });
    const result = await copyPath({ sourcePath: source, destinationPath: destination }, context);
    expect(result).toMatchObject({ ok: false, code: "io-error", cleanup: "incomplete" });
    if (!result.ok) expect(result.cleanupErrors?.join(" ")).toContain("Source directory close failed");
    await expect(lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("awaits an admitted sink operation even if its producer forgets to await it", async () => {
    const started = deferred();
    const release = deferred();
    let completed = false;
    const pending = transfer(async ({ sink }) => {
      void sink.file("file", (async function* () { started.resolve(); await release.promise; yield bytes; })(), attributes);
    }).then((result) => { completed = true; return result; });
    await started.promise;
    await turn();
    expect(completed).toBe(false);
    release.resolve();
    expect(await pending).toMatchObject({ ok: true });
    expect(await readFile(join(destination, "file"))).toEqual(bytes);
  });
});

describe("detected replacement and cleanup faults", () => {
  it("never removes a replaced owned file", async () => {
    const result = await transfer(async ({ sink }) => {
      await sink.file("owned", body(), attributes);
      await rename(join(destination, "owned"), join(root, "moved-owned"));
      await writeFile(join(destination, "owned"), "foreign replacement");
      throw new Error("synthetic producer failure");
    });
    expect(result).toMatchObject({ ok: false, cleanup: "incomplete" });
    expect(await readFile(join(destination, "owned"), "utf8")).toBe("foreign replacement");
    expect(await readFile(join(root, "moved-owned"))).toEqual(bytes);
    expect(vi.mocked(unlink)).not.toHaveBeenCalledWith(join(destination, "owned"));
  });

  it("detects a swapped destination parent before another mutation", async () => {
    const parent = join(root, "parent");
    await mkdir(parent);
    destination = join(parent, "output");
    const foreign = join(root, "foreign");
    await mkdir(foreign);
    await mkdir(join(foreign, "output"));
    await writeFile(join(foreign, "output", "first"), "foreign");
    const result = await transfer(async ({ sink }) => {
      await sink.file("first", body(), attributes);
      await rename(parent, join(root, "moved-parent"));
      await symlink(foreign, parent);
      await sink.file("second", body(), attributes);
    });
    expect(result).toMatchObject({ ok: false, code: "source-changed", cleanup: "incomplete" });
    expect(await readFile(join(foreign, "output", "first"), "utf8")).toBe("foreign");
    await expect(lstat(join(foreign, "output", "second"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports failed cleanup syscalls and retains a bounded residual list", async () => {
    vi.mocked(unlink).mockRejectedValue(Object.assign(new Error("synthetic cleanup permission failure"), { code: "EACCES" }));
    const result = await transfer(async ({ sink }) => {
      for (let index = 0; index < 23; index += 1) await sink.file(`file-${index}`, body(), attributes);
      throw new Error("synthetic transfer failure");
    });
    expect(result).toMatchObject({ ok: false, cleanup: "incomplete" });
    if (!result.ok) {
      expect(result.residualPaths).toHaveLength(20);
      expect(result.cleanupErrors).toHaveLength(20);
      for (const path of result.residualPaths!) await expect(lstat(path)).resolves.toBeDefined();
    }
    for (const call of vi.mocked(rmdir).mock.calls) expect(call).toHaveLength(1);
    expect(await readFile(join(destination, "file-0"))).toEqual(bytes);
  });
});
