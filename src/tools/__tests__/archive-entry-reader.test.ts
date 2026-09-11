import { afterEach, describe, expect, it } from "vitest";
import { createReadStream } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex, Readable } from "node:stream";
import { randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import { create, Header, Parser } from "tar";
import { consumeTarArchive } from "../archive-entry-reader.js";
import { FileTransferError } from "../file-transfer-error.js";
import type { FileTransferLimits, TransferTreeSink } from "../file-transfer-types.js";

const LIMITS: Readonly<FileTransferLimits> = {
  bufferBytes: 1024,
  maxPayloadBytes: 4 * 1024 * 1024,
  maxArchiveInputBytes: 8 * 1024 * 1024,
  maxDecodedArchiveBytes: 8 * 1024 * 1024,
  maxEntries: 1000,
  maxDepth: 64,
  maxRelativePathBytes: 4096,
  maxArchiveMetaEntryBytes: 1024 * 1024,
};
const terminal = Buffer.alloc(1024);
const temporaryPaths: string[] = [];

afterEach(async () => {
  for (const path of temporaryPaths.splice(0)) await rm(path, { recursive: true, force: true });
});

interface FixtureEntry { path: string; body?: Buffer; type?: string; link?: string; mode?: number; size?: number }

function checksum(header: Buffer): Buffer {
  header.fill(0x20, 148, 156);
  const sum = header.reduce((total, byte) => total + byte, 0);
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
}

function member({ path, body = Buffer.alloc(0), type = "0", link = "", mode = 0o644, size = body.length }: FixtureEntry): Buffer {
  const header = Buffer.alloc(512);
  header.write(path, 0, 100, "utf8");
  header.write(`${mode.toString(8).padStart(7, "0")}\0`, 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header[156] = type === "" ? 0 : type.charCodeAt(0);
  header.write(link, 157, 100, "utf8");
  header.write("ustar\0" + "00", 257, 8, "ascii");
  const padding = Buffer.alloc((512 - body.length % 512) % 512);
  return Buffer.concat([checksum(header), body, padding]);
}

function paxRecord(key: string, value: string): string {
  const suffix = ` ${key}=${value}\n`;
  let size = Buffer.byteLength(suffix) + 1;
  while (size !== Buffer.byteLength(suffix) + String(size).length) size = Buffer.byteLength(suffix) + String(size).length;
  return `${size}${suffix}`;
}

function pax(key: string, value: string, type = "x"): Buffer {
  return member({ path: "PaxHeader", type, body: Buffer.from(paxRecord(key, value)) });
}

function stream(bytes: Buffer, chunkSize = 173): Readable {
  return Readable.from((function* () {
    for (let offset = 0; offset < bytes.length; offset += chunkSize) yield bytes.subarray(offset, offset + chunkSize);
  })(), { objectMode: false, highWaterMark: 1024 });
}

function recordingSink() {
  const files = new Map<string, Buffer>();
  const directories: string[] = [];
  const attributes = new Map<string, { expectedBytes: number; ownerExecutable: boolean }>();
  const sink: TransferTreeSink = {
    async directory(path) { directories.push(path); },
    async file(path, body, entryAttributes) {
      const chunks: Uint8Array[] = [];
      for await (const chunk of body) chunks.push(Buffer.from(chunk));
      files.set(path, Buffer.concat(chunks));
      attributes.set(path, entryAttributes);
    },
  };
  return { sink, files, directories, attributes };
}

async function consume(bytes: Buffer, limits = LIMITS, signal = new AbortController().signal) {
  const recorded = recordingSink();
  const result = await consumeTarArchive(stream(bytes), recorded.sink, { signal, limits });
  return { ...recorded, ...result };
}

async function failureCode(bytes: Buffer, limits = LIMITS): Promise<string> {
  try { await consume(bytes, limits); } catch (error) {
    expect(error).toBeInstanceOf(FileTransferError);
    return (error as FileTransferError).code;
  }
  throw new Error("Expected archive failure");
}

describe("archive entry streaming", () => {
  it("preserves binary bodies, root metadata, implicit parents and executable ownership", async () => {
    const binary = Buffer.from([0, 255, 254, 13, 10, 0x61, 10, 0, 128]);
    const result = await consume(Buffer.concat([
      member({ path: "./", type: "5" }),
      member({ path: "./folder/.hidden", body: binary, mode: 0o7755 }),
      member({ path: "folder/", type: "5" }),
      member({ path: "empty", type: "", body: Buffer.alloc(0) }), terminal,
    ]));
    expect(result.format).toBe("tar");
    expect(result.directories).toEqual(["", "folder"]);
    expect(result.files.get("folder/.hidden")).toEqual(binary);
    expect(result.files.get("empty")).toEqual(Buffer.alloc(0));
    expect(result.attributes.get("folder/.hidden")).toEqual({ expectedBytes: binary.length, ownerExecutable: true });
  });

  it("reads actual file-backed tar and gzip fixtures by content", async () => {
    const root = await mkdtemp(join(tmpdir(), "archive-reader-")); temporaryPaths.push(root);
    await mkdir(join(root, "input"));
    const bytes = Buffer.from([0, 128, 255, 13, 10]);
    await writeFile(join(root, "input", "data.bin"), bytes);
    for (const gzip of [false, true]) {
      const path = join(root, gzip ? "fixture.data" : "fixture.wrong.gz");
      await create({ cwd: join(root, "input"), file: path, gzip, portable: true }, ["."]);
      const recorded = recordingSink();
      const result = await consumeTarArchive(createReadStream(path, { highWaterMark: 97 }), recorded.sink, { signal: new AbortController().signal, limits: LIMITS });
      expect(result.format).toBe(gzip ? "tar.gz" : "tar");
      expect(recorded.files.get("data.bin")).toEqual(bytes);
      expect(await readFile(join(root, "input", "data.bin"))).toEqual(bytes);
    }
  });

  it("accepts only fully terminated empty tar streams including gzip zero padding", async () => {
    expect((await consume(terminal)).files.size).toBe(0);
    expect((await consume(gzipSync(Buffer.concat([terminal, Buffer.alloc(512)])))).format).toBe("tar.gz");
    for (const bytes of [Buffer.alloc(0), Buffer.alloc(512), Buffer.alloc(1025)]) expect(await failureCode(bytes)).toBe("invalid-archive");
  });

  it("accepts supported long paths and metadata without changing names at block boundaries", async () => {
    for (const longPath of ["p/" + "x".repeat(160), "a".repeat(501) + "한/leaf"]) {
      for (const metadata of [pax("path", longPath), member({ path: "././@LongLink", type: "L", body: Buffer.from(`${longPath}\0`) })]) {
        const result = await consume(Buffer.concat([metadata, member({ path: "placeholder", body: Buffer.from("body") }), terminal]));
        expect(result.files.get(longPath)).toEqual(Buffer.from("body"));
        expect(result.files.has("placeholder")).toBe(false);
      }
    }
  });

  it("uses effective payload size and harmless global metadata", async () => {
    const file = member({ path: "sized", body: Buffer.from("abc"), size: 0 });
    const result = await consume(Buffer.concat([pax("comment", "arbitrary GNU.sparse.size=123 text", "g"), pax("size", "3"), file, terminal]));
    expect(result.files.get("sized")).toEqual(Buffer.from("abc"));
  });

  it("preserves the declared header prefix and accepts varied source chunk boundaries", async () => {
    const entry = member({ path: "leaf", body: Buffer.from("body") });
    entry.write("parent/nested", 345, "utf8"); checksum(entry.subarray(0, 512));
    const bytes = Buffer.concat([entry, terminal]);
    for (const chunkSize of [1, 511, 512, 513, 4097]) {
      for (const encoded of [bytes, gzipSync(bytes)]) {
        const recorded = recordingSink();
        await consumeTarArchive(stream(encoded, chunkSize), recorded.sink, { signal: new AbortController().signal, limits: { ...LIMITS, bufferBytes: 63 } });
        expect(recorded.files.get("parent/nested/leaf")).toEqual(Buffer.from("body"));
      }
    }
  });

  it("uses a valid extended path when a legacy header name cannot represent it", async () => {
    const entry = member({ path: "placeholder", body: Buffer.from("body") });
    entry[0] = 0xff;
    entry.write("legacy-prefix", 345, "utf8");
    checksum(entry.subarray(0, 512));
    const result = await consume(Buffer.concat([pax("path", "경로/파일"), entry, terminal]));
    expect([...result.files.keys()]).toEqual(["경로/파일"]);
    expect(result.files.get("경로/파일")).toEqual(Buffer.from("body"));
  });

  it("accepts multiple gzip members containing one tar and rejects a second tar", async () => {
    const bytes = Buffer.concat([member({ path: "a", body: Buffer.from("a") }), terminal]);
    const split = Buffer.concat([gzipSync(bytes.subarray(0, 700)), gzipSync(bytes.subarray(700)), gzipSync(Buffer.alloc(512))]);
    expect((await consume(split)).files.get("a")).toEqual(Buffer.from("a"));
    expect(await failureCode(Buffer.concat([gzipSync(bytes), gzipSync(bytes)]))).toBe("invalid-archive");
  });

  it("records the pinned parser behavior that the framing layer must constrain", () => {
    const empty = new Parser({ strict: true, brotli: false, zstd: false });
    const errors: Error[] = []; let eof = false;
    empty.on("error", (error) => errors.push(error)); empty.on("eof", () => { eof = true; });
    empty.end(terminal);
    expect(eof).toBe(true); expect(errors).toHaveLength(1);
    const parser = new Parser({ strict: true, brotli: false, zstd: false });
    const events: string[] = []; const extensions: unknown[] = [];
    parser.on("meta", () => events.push("meta"));
    parser.on("entry", (entry) => { extensions.push(entry.extended); entry.resume(); });
    parser.end(Buffer.concat([member({ path: "PaxHeader", type: "x" }), pax("GNU.sparse.size", "123"), member({ path: "a" }), terminal]));
    expect(events).toEqual(["meta"]);
    expect(extensions).toHaveLength(1);
    expect(extensions[0]).not.toHaveProperty("GNU.sparse.size");
    expect(new Header(member({ path: "a" }).subarray(0, 512)).cksumValid).toBe(true);
    const split = new Parser({ strict: true, brotli: false, zstd: false });
    const longPath = "a".repeat(501) + "한/leaf";
    let actual: string | undefined;
    split.on("entry", (entry) => { actual = entry.path; entry.resume(); });
    const splitMetadata = pax("path", longPath);
    for (let offset = 0; offset < splitMetadata.length; offset += 512) split.write(splitMetadata.subarray(offset, offset + 512));
    split.end(Buffer.concat([member({ path: "placeholder" }), terminal]));
    expect(actual).toBe("placeholder");
    const oversized = new Parser({ strict: true, brotli: false, zstd: false, maxMetaEntrySize: 1 });
    let ignored = 0;
    oversized.on("ignoredEntry", () => ignored++);
    oversized.end(Buffer.concat([pax("comment", "ignored"), terminal]));
    expect(ignored).toBe(1);
  });
});

describe("archive rejection after a completed valid member", () => {
  const valid = member({ path: "first", body: Buffer.from("preserved until owner rollback") });

  async function rejectsFollowing(hostile: Buffer, code = "invalid-archive", tail = terminal) {
    const recorded = recordingSink();
    await expect(consumeTarArchive(stream(Buffer.concat([valid, hostile, tail])), recorded.sink, { signal: new AbortController().signal, limits: LIMITS })).rejects.toMatchObject({ name: "FileTransferError", code });
    expect(recorded.files.get("first")).toEqual(Buffer.from("preserved until owner rollback"));
    expect(recorded.files.size).toBe(1);
  }

  it.each(["/absolute", "C:relative", "C:/absolute", "//server/share", "../escape", "a/../escape", "a//b", "a/./b", "a\\b", "a\nb", "a\0hidden", "a.", "a "])("rejects member path %j", async (path) => {
    await rejectsFollowing(member({ path, body: Buffer.from("bad") }));
  });

  it.each(["1", "2", "3", "4", "6", "7", "D", "S", "A", "I", "M", "V", "?", "K"])("rejects unsupported member type %j", async (type) => {
    await rejectsFollowing(member({ path: "unsupported", type, link: ["1", "2"].includes(type) ? "first" : "" }), "unsupported-entry");
  });

  it("rejects duplicate, normalized and parent/file collisions", async () => {
    await rejectsFollowing(member({ path: "./first" }));
    await rejectsFollowing(member({ path: "first/child" }));
    for (const pair of [["a", "a"], ["é", "e\u0301"], ["folder/child", "folder"]]) {
      expect(await failureCode(Buffer.concat([member({ path: pair[0]! }), member({ path: pair[1]! }), terminal]))).toBe("invalid-archive");
    }
    expect(await failureCode(Buffer.concat([member({ path: "é/x" }), member({ path: "e\u0301/y" }), terminal]))).toBe("invalid-archive");
    if (process.platform === "darwin" || process.platform === "win32") {
      expect(await failureCode(Buffer.concat([member({ path: "File" }), member({ path: "file" }), terminal]))).toBe("invalid-archive");
      expect(await failureCode(Buffer.concat([member({ path: "A/x" }), member({ path: "a/y" }), terminal]))).toBe("invalid-archive");
    }
    expect(await failureCode(Buffer.concat([member({ path: "folder/", type: "5" }), member({ path: "./folder/", type: "5" }), terminal]))).toBe("invalid-archive");
  });

  it.each(["GNU.sparse.size", "GNU.sparse.map", "GNU.sparse.major", "SCHILY.realsize", "SUN.holesdata"])("rejects sparse-affecting metadata key %s", async (key) => {
    await rejectsFollowing(Buffer.concat([pax(key, "123"), member({ path: "sparse" })]), "unsupported-entry");
  });

  it("rejects sparse type metadata but permits the same text in an ignored value", async () => {
    await rejectsFollowing(Buffer.concat([pax("SCHILY.filetype", "sparse"), member({ path: "sparse" })]), "unsupported-entry");
    const result = await consume(Buffer.concat([pax("comment", "GNU.sparse.size=123 and SCHILY.filetype=sparse"), member({ path: "ordinary" }), terminal]));
    expect(result.files.has("ordinary")).toBe(true);
  });

  it.each(["../escape", "/absolute", "C:\\absolute", "safe/../escape", "bad\u007fname"])("rejects effective metadata path %j", async (path) => {
    await rejectsFollowing(Buffer.concat([pax("path", path), member({ path: "placeholder" })]));
    await rejectsFollowing(Buffer.concat([member({ path: "long", type: "L", body: Buffer.from(`${path}\0`) }), member({ path: "placeholder" })]));
  });

  it("rejects metadata-backed link semantics", async () => {
    await rejectsFollowing(Buffer.concat([pax("SCHILY.nlink", "2"), member({ path: "linked" })]), "unsupported-entry");
    await rejectsFollowing(Buffer.concat([pax("linkpath", "first"), member({ path: "linked" })]), "unsupported-entry");
  });

  it("rejects malformed byte lengths, incomplete records, invalid UTF-8 and line injection", async () => {
    const correct = paxRecord("path", "target");
    const malformed = [
      correct.replace(/^\d+/, (length) => String(Number(length) - 1)),
      correct.replace(/^\d+/, (length) => String(Number(length) + 1)),
      correct.slice(0, -1), `${correct}extra`, "00 path=x\n", "99999999999999999 path=x\n",
      paxRecord("comment", `value\n${paxRecord("path", "../escape")}`),
    ];
    for (const body of malformed) await rejectsFollowing(Buffer.concat([member({ path: "PaxHeader", type: "x", body: Buffer.from(body) }), member({ path: "placeholder" })]));
    await rejectsFollowing(Buffer.concat([member({ path: "long", type: "L", body: Buffer.from([0xff, 0xfe, 0]) }), member({ path: "placeholder" })]));
    await rejectsFollowing(Buffer.concat([member({ path: "long", type: "L", body: Buffer.from("safe\0../hidden") }), member({ path: "placeholder" })]));
    await rejectsFollowing(Buffer.concat([pax("path", "123"), member({ path: "placeholder" })]));
  });

  it("rejects corrupt checksums, truncated headers/bodies/metadata and missing terminal blocks", async () => {
    const corrupt = member({ path: "checksum" }); corrupt[0] ^= 1;
    await rejectsFollowing(corrupt);
    await rejectsFollowing(member({ path: "short-header" }).subarray(0, 300), "invalid-archive", Buffer.alloc(0));
    await rejectsFollowing(member({ path: "short-body", body: Buffer.from("123"), size: 1024 }), "invalid-archive", Buffer.alloc(0));
    await rejectsFollowing(member({ path: "PaxHeader", type: "x", body: Buffer.from("123"), size: 1024 }), "invalid-archive", Buffer.alloc(0));
    for (const tail of [Buffer.alloc(0), Buffer.alloc(512)]) await rejectsFollowing(Buffer.alloc(0), "invalid-archive", tail);
    await rejectsFollowing(pax("path", "dangling"));
  });

  it("rejects concealed directory payload, nonzero padding, concatenation and nonzero trailing data", async () => {
    await rejectsFollowing(member({ path: "directory", type: "5", body: Buffer.alloc(512) }));
    const badPadding = member({ path: "bad-padding", body: Buffer.from("a") }); badPadding[513] = 1;
    await rejectsFollowing(badPadding);
    const badMetaPadding = pax("path", "target"); badMetaPadding[badMetaPadding.length - 1] = 1;
    await rejectsFollowing(badMetaPadding);
    await rejectsFollowing(Buffer.concat([terminal, member({ path: "concatenated" })]));
    await rejectsFollowing(Buffer.concat([terminal, Buffer.alloc(512, 0x7f)]));
    await rejectsFollowing(Buffer.concat([Buffer.alloc(512), member({ path: "after-zero" })]));
  });
});

describe("archive accounting and owned stream lifecycle", () => {
  it("waits for the readable side alone when the source also has an open writable side", async () => {
    const bytes = Buffer.concat([member({ path: "a" }), terminal]);
    let sent = false;
    const source = new Duplex({
      autoDestroy: false,
      read() { if (!sent) { sent = true; this.push(bytes); this.push(null); } },
      write(_chunk, _encoding, callback) { callback(); },
    });
    try {
      await expect(consumeTarArchive(source, recordingSink().sink, { signal: new AbortController().signal, limits: LIMITS })).resolves.toEqual({ format: "tar" });
      expect(source.writableEnded).toBe(false);
    } finally {
      source.destroy();
    }
  });
  it("enforces exact source, decoded, payload, path, depth and metadata limits", async () => {
    const body = Buffer.from("payload");
    const bytes = Buffer.concat([member({ path: "a/b", body }), terminal]);
    const exact = { ...LIMITS, maxArchiveInputBytes: bytes.length, maxDecodedArchiveBytes: bytes.length, maxPayloadBytes: body.length, maxRelativePathBytes: 3, maxDepth: 2, maxEntries: 2 };
    expect((await consume(bytes, exact)).files.get("a/b")).toEqual(body);
    for (const field of ["maxArchiveInputBytes", "maxDecodedArchiveBytes", "maxPayloadBytes", "maxRelativePathBytes", "maxDepth", "maxEntries"] as const) {
      expect(await failureCode(bytes, { ...exact, [field]: exact[field] - 1 })).toBe("limit-exceeded");
    }
    const meta = paxRecord("path", "renamed");
    const withMeta = Buffer.concat([member({ path: "PaxHeader", type: "x", body: Buffer.from(meta) }), member({ path: "raw" }), terminal]);
    expect((await consume(withMeta, { ...LIMITS, maxArchiveMetaEntryBytes: Buffer.byteLength(meta) })).files.has("renamed")).toBe(true);
    expect(await failureCode(withMeta, { ...LIMITS, maxArchiveMetaEntryBytes: Buffer.byteLength(meta) - 1 })).toBe("limit-exceeded");
    expect(await failureCode(gzipSync(bytes), { ...LIMITS, maxDecodedArchiveBytes: bytes.length - 1 })).toBe("limit-exceeded");
    expect(await failureCode(Buffer.concat([member({ path: "a", body }), member({ path: "b", body }), terminal]), { ...LIMITS, maxPayloadBytes: body.length })).toBe("limit-exceeded");
  });

  it("counts zero-length metadata records and metadata that creates no files", async () => {
    const bytes = Buffer.concat([member({ path: "PaxHeader", type: "x" }), member({ path: "a" }), terminal]);
    expect((await consume(bytes, { ...LIMITS, maxEntries: 2 })).files.has("a")).toBe(true);
    expect(await failureCode(bytes, { ...LIMITS, maxEntries: 1 })).toBe("limit-exceeded");
    expect(await failureCode(Buffer.concat([pax("comment", "one", "g"), pax("comment", "two", "g"), terminal]), { ...LIMITS, maxEntries: 1 })).toBe("limit-exceeded");
  });

  it.each([Buffer.from([0x50, 0x4b, 3, 4]), Buffer.from([0x28, 0xb5, 0x2f, 0xfd])])("rejects unsupported compression and nested compression by content", async (magic) => {
    const bytes = Buffer.concat([magic, Buffer.alloc(1024)]);
    expect(await failureCode(bytes)).toBe("unsupported-archive-format");
    expect(await failureCode(gzipSync(bytes))).toBe("unsupported-archive-format");
  });

  it("rejects nested gzip, corrupt gzip trailers, truncation and compressed trailing garbage", async () => {
    const bytes = gzipSync(Buffer.concat([member({ path: "a", body: Buffer.from("a") }), terminal]));
    expect(await failureCode(gzipSync(bytes))).toBe("unsupported-archive-format");
    const corrupt = Buffer.from(bytes); corrupt[corrupt.length - 8] ^= 1;
    for (const bad of [corrupt, bytes.subarray(0, bytes.length - 1), Buffer.concat([bytes, Buffer.from("garbage")])]) {
      expect(await failureCode(bad)).toBe("invalid-archive");
    }
  });

  it.each([false, true])("keeps source reads and body buffering bounded for a slow sink (gzip=%s)", async (gzip) => {
    const payload = randomBytes(128 * 1024);
    const raw = Buffer.concat([member({ path: "first", body: payload }), member({ path: "second", body: payload }), terminal]);
    const bytes = gzip ? gzipSync(raw) : raw;
    let produced = 0; let firstChunk!: () => void; let release!: () => void;
    const started = new Promise<void>((resolve) => { firstChunk = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const source = Readable.from((function* () {
      for (let offset = 0; offset < bytes.length; offset += 1024) { produced += Math.min(1024, bytes.length - offset); yield bytes.subarray(offset, offset + 1024); }
    })(), { objectMode: false, highWaterMark: 1024 });
    let active = 0; let largest = 0; let received = 0; const order: string[] = [];
    const sink: TransferTreeSink = {
      async directory() {},
      async file(path, body) {
        expect(++active).toBe(1); order.push(path);
        for await (const chunk of body) {
          largest = Math.max(largest, chunk.length); received += chunk.length;
          if (received === chunk.length) { firstChunk(); await gate; }
        }
        active--;
      },
    };
    const operation = consumeTarArchive(source, sink, { signal: new AbortController().signal, limits: LIMITS });
    await started;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(produced).toBeLessThanOrEqual(8 * LIMITS.bufferBytes);
    expect(order).toEqual(["first"]);
    release(); await operation;
    expect(received).toBe(payload.length * 2); expect(largest).toBeLessThanOrEqual(512); expect(active).toBe(0);
    expect(order).toEqual(["first", "second"]);
    expect(source.destroyed).toBe(true);
  });

  it("cancels before reading, while awaiting source input, and between entries", async () => {
    const bytes = Buffer.concat([member({ path: "folder", type: "5" }), member({ path: "late" }), terminal]);
    const already = new AbortController(); already.abort();
    await expect(consume(bytes, LIMITS, already.signal)).rejects.toMatchObject({ code: "cancelled" });
    const controller = new AbortController(); const source = new Readable({ read() {} });
    const waiting = consumeTarArchive(source, recordingSink().sink, { signal: controller.signal, limits: LIMITS });
    controller.abort(); await expect(waiting).rejects.toMatchObject({ code: "cancelled" }); expect(source.destroyed).toBe(true);
    const between = new AbortController(); let admitted = 0;
    const sink: TransferTreeSink = { async directory() { between.abort(); }, async file() { admitted++; } };
    await expect(consumeTarArchive(stream(bytes), sink, { signal: between.signal, limits: LIMITS })).rejects.toMatchObject({ code: "cancelled" });
    expect(admitted).toBe(0);
  });

  it("cancels during a body and waits for the final sink operation to settle", async () => {
    const bytes = Buffer.concat([member({ path: "first", body: Buffer.alloc(4096, 1) }), member({ path: "late" }), terminal]);
    const mid = new AbortController(); let count = 0;
    const sink: TransferTreeSink = { async directory() {}, async file(_path, body) { for await (const chunk of body) { count += chunk.length; mid.abort(); } } };
    await expect(consumeTarArchive(stream(bytes), sink, { signal: mid.signal, limits: LIMITS })).rejects.toMatchObject({ code: "cancelled" });
    expect(count).toBe(512);
    const final = new AbortController(); let closeStarted!: () => void; let release!: () => void;
    const started = new Promise<void>((resolve) => { closeStarted = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let admitted = 0; let settled = false;
    const delayed: TransferTreeSink = { async directory() {}, async file(_path, body) { admitted++; for await (const _chunk of body) { /* drain before final close */ } closeStarted(); await gate; } };
    const operation = consumeTarArchive(stream(bytes), delayed, { signal: final.signal, limits: LIMITS });
    void operation.then(() => { settled = true; }, () => { settled = true; });
    await started; final.abort(); await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false); expect(admitted).toBe(1);
    release(); await expect(operation).rejects.toMatchObject({ code: "cancelled" });
    expect(admitted).toBe(1);
  });

  it("propagates source errors and asynchronous sink failures while closing input", async () => {
    const bytes = Buffer.concat([member({ path: "a", body: Buffer.alloc(2048) }), terminal]);
    const sinkError = new FileTransferError("path-denied", "Synthetic sink denial");
    const source = stream(bytes);
    const failing: TransferTreeSink = { async directory() {}, async file(_path, body) { for await (const _chunk of body) { await Promise.resolve(); throw sinkError; } } };
    await expect(consumeTarArchive(source, failing, { signal: new AbortController().signal, limits: LIMITS })).rejects.toBe(sinkError);
    expect(source.destroyed).toBe(true);
    const readError = new Error("Synthetic source failure");
    const failedSource = Readable.from((async function* () { yield bytes.subarray(0, 1024); throw readError; })(), { objectMode: false });
    await expect(consumeTarArchive(failedSource, recordingSink().sink, { signal: new AbortController().signal, limits: LIMITS })).rejects.toBe(readError);
    expect(failedSource.destroyed).toBe(true);
  });
});
