import { Readable } from "node:stream";
import { finished, pipeline } from "node:stream/promises";
import { createGunzip, type Gunzip } from "node:zlib";
import { Header, Parser, Pax, type ReadEntry } from "tar";
import { caseFoldForMatch } from "../permissions/sensitive-paths.js";
import { FileTransferError } from "./file-transfer-error.js";
import { validateFileTransferLimits } from "./file-transfer-policy.js";
import type {
  ArchiveFormat,
  FileTransferLimits,
  TransferTreeSink,
} from "./file-transfer-types.js";

const TAR_BLOCK_BYTES = 512;
// Prefixing one PAX path with ./ adds two bytes and at most one length digit.
const MAX_PAX_PATH_NORMALIZATION_BYTES = 3;
const META_TYPES = new Set([
  "ExtendedHeader", "OldExtendedHeader", "GlobalExtendedHeader",
  "NextFileHasLongPath", "OldGnuLongPath",
]);
const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function invalid(message: string, cause?: unknown): FileTransferError {
  return new FileTransferError("invalid-archive", message, { cause });
}

function reserve(current: number, bytes: number, limit: number, label: string): number {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw invalid(`Invalid ${label}`);
  if (bytes > limit - current) {
    throw new FileTransferError("limit-exceeded", `Archive ${label} limit exceeded`);
  }
  return current + bytes;
}

function isZero(bytes: Uint8Array): boolean {
  return bytes.every((value) => value === 0);
}

function decodeMetadata(bytes: Buffer): string {
  try {
    return utf8Decoder.decode(bytes);
  } catch (error) {
    throw invalid("Archive metadata is not valid UTF-8", error);
  }
}

function validateHeaderStrings(block: Buffer): void {
  const fields = [block.subarray(0, 100)];
  if (block.subarray(257, 265).toString("ascii") === "ustar\0" + "00") {
    fields.push(block.subarray(345, block[475] ? 500 : 475));
  }
  for (const field of fields) {
    const nul = field.indexOf(0);
    if (nul >= 0 && !isZero(field.subarray(nul))) throw invalid("Archive header path contains an embedded NUL");
    decodeMetadata(nul < 0 ? field : field.subarray(0, nul));
  }
}

function hasZeroSizeField(block: Buffer): boolean {
  const field = block.subarray(124, 136);
  return field[0] === 0x80 ? isZero(field.subarray(1)) : field.every((byte) => byte === 0 || byte === 0x20 || byte === 0x30);
}

function validatePax(bytes: Buffer): { start: number; end: number; valueStart: number } | undefined {
  // Each record is: decimal byte length, space, key=value, newline. Validate
  // boundaries before the maintained decoder discards unrecognized fields.
  let offset = 0;
  let numericPath: { start: number; end: number; valueStart: number } | undefined;
  while (offset < bytes.length) {
    const space = bytes.indexOf(0x20, offset);
    if (space < offset + 1 || space - offset > 16) throw invalid("Invalid extended metadata length");
    const digits = bytes.subarray(offset, space).toString("ascii");
    if (!/^[1-9][0-9]*$/.test(digits)) throw invalid("Invalid extended metadata length");
    const length = Number(digits);
    const end = offset + length;
    if (!Number.isSafeInteger(length) || length < space - offset + 4 || end > bytes.length || bytes[end - 1] !== 0x0a) {
      throw invalid("Invalid extended metadata record boundary");
    }
    const equals = bytes.indexOf(0x3d, space + 1);
    if (equals <= space + 1 || equals >= end - 1) throw invalid("Invalid extended metadata key");
    const key = bytes.subarray(space + 1, equals).toString("utf8");
    if (!/^[A-Za-z0-9_.-]+$/.test(key)) throw invalid("Invalid extended metadata key");
    const value = bytes.subarray(equals + 1, end - 1);
    // The selected decoder is line-based. Embedded newlines could otherwise
    // make part of a value look like a different effective metadata record.
    if (value.includes(0x0a) || value.includes(0)) throw invalid("Unsupported extended metadata value");
    if (/^GNU\.sparse(?:\.|$)/.test(key) || /^SCHILY\.(?:realsize|holes|sparse(?:\..*)?)$/.test(key) || key === "SUN.holesdata" || (key === "SCHILY.filetype" && value.toString("utf8") === "sparse")) {
      throw new FileTransferError("unsupported-entry", "Sparse archive entries are not supported");
    }
    if (key === "path") {
      numericPath = value.length && value.every((byte) => byte >= 0x30 && byte <= 0x39)
        ? { start: offset, end, valueStart: equals + 1 } : undefined;
    }
    offset = end;
  }
  return numericPath;
}

function relativeMemberPath(raw: string, directory: boolean, limits: Readonly<FileTransferLimits>): string {
  if (typeof raw !== "string" || /[\x00-\x1f\x7f-\x9f\ufffd\\:]/u.test(raw) || raw.startsWith("/")) {
    throw invalid("Archive member has an unsupported path");
  }
  let path = raw;
  while (path.startsWith("./")) path = path.slice(2);
  if (directory && (path === "." || path === "")) return "";
  if (directory && path.endsWith("/")) path = path.slice(0, -1);
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || /[. ]$/.test(part))) {
    throw invalid("Archive member has an aliased or traversing path");
  }
  if (parts.length > limits.maxDepth || Buffer.byteLength(path) > limits.maxRelativePathBytes) {
    throw new FileTransferError("limit-exceeded", "Archive member path limit exceeded");
  }
  return path;
}

function rejectCompressionMagic(bytes: Buffer): void {
  if ((bytes[0] === 0x1f && bytes[1] === 0x8b) ||
      (bytes[0] === 0x28 && bytes[1] === 0xb5 && bytes[2] === 0x2f && bytes[3] === 0xfd) ||
      (bytes[0] === 0x50 && bytes[1] === 0x4b && [0x03, 0x05, 0x07].includes(bytes[2] ?? -1))) {
    throw new FileTransferError("unsupported-archive-format", "Only tar or gzip-compressed tar archives are supported");
  }
}

/**
 * Reads one complete tar stream. The sink owns filesystem authority, descriptor
 * closure, cancellation-aware writes and rollback of any earlier output.
 * Every body must be consumed; cancellation waits for sink operations to settle.
 */
export async function consumeTarArchive(
  source: Readable,
  sink: TransferTreeSink,
  options: { signal: AbortSignal; limits: Readonly<FileTransferLimits> },
): Promise<{ format: ArchiveFormat }> {
  const { signal, limits } = options;
  validateFileTransferLimits(limits);
  const parser = new Parser({ strict: true, brotli: false, zstd: false, maxMetaEntrySize: limits.maxArchiveMetaEntryBytes });
  let failure: Error | undefined;
  let activeEntry: ReadEntry | undefined;
  let activeWriter: Promise<void> | undefined;
  let gunzip: Gunzip | undefined;
  let compressedInput: Readable | undefined;
  let compressedWriter: Promise<void> | undefined;
  const failureWaiters = new Set<() => void>();
  let sourceBytes = 0;
  let decodedBytes = 0;
  let payloadBytes = 0;
  let records = 0;
  let terminalBlocks = 0;
  let parserEof = false;
  let parserEnded = false;
  let extended: Pax | undefined;
  let globalExtended: Pax | undefined;
  let pendingLocalMetadata = false;
  let header: Header | undefined;
  let bodyRemaining = 0;
  let payloadRemaining = 0;
  let metadata: { buffer: Buffer; offset: number; inputBodyBytes: number; header: Header; block: Buffer } | undefined;
  let emittedMeta: string | undefined;
  const members = new Map<string, { kind: "file" | "directory" | "implicit"; spelling: string }>();

  function checkFailure(): void {
    if (failure) throw failure;
  }

  function fail(error: unknown): void {
    if (failure) return;
    failure = error instanceof Error ? error : new Error(String(error));
    for (const wake of failureWaiters) wake();
    parser.abort(new Error("Archive parsing stopped", { cause: failure }));
    activeEntry?.destroy(failure);
    gunzip?.destroy(failure);
    compressedInput?.destroy(failure);
    source.destroy(failure);
  }

  const handleAbort = () => fail(new FileTransferError("cancelled", "Archive extraction was cancelled"));
  const handleSourceError = (error: Error) => fail(error);
  parser.on("error", (error: Error) => fail(invalid("Archive parser rejected the input", error)));
  parser.on("abort", (error: Error) => fail(error));
  parser.on("ignoredEntry", (entry: ReadEntry) => fail(new FileTransferError(
    entry.meta && entry.size > limits.maxArchiveMetaEntryBytes ? "limit-exceeded" : "unsupported-entry",
    "Archive contains a skipped or unsupported entry",
  )));
  parser.on("eof", () => { parserEof = true; });
  parser.on("end", () => { parserEnded = true; });
  parser.on("meta", (value: string) => { emittedMeta = value; });
  source.on("error", handleSourceError);
  const sourceSettled = finished(source, { readable: true, writable: false, cleanup: true }).catch(fail);
  signal.addEventListener("abort", handleAbort, { once: true });
  if (signal.aborted) handleAbort();

  function registerMember(path: string, directory: boolean): void {
    const identity = caseFoldForMatch(path.normalize("NFC"));
    const previous = members.get(identity);
    if (previous && !(previous.kind === "implicit" && directory && previous.spelling === path)) {
      throw invalid("Archive contains duplicate or colliding member paths");
    }
    let prefix = "";
    const parts = path.split("/");
    for (let index = 0; index < parts.length - 1; index++) {
      prefix = prefix ? `${prefix}/${parts[index]}` : parts[index]!;
      const prefixIdentity = caseFoldForMatch(prefix.normalize("NFC"));
      const parent = members.get(prefixIdentity);
      if (parent && (parent.kind === "file" || parent.spelling !== prefix)) {
        throw invalid("Archive member traverses a file or aliased directory");
      }
      if (!parent) {
        reserve(members.size, 1, limits.maxEntries, "entry count");
        members.set(prefixIdentity, { kind: "implicit", spelling: prefix });
      }
    }
    if (!previous) reserve(members.size, 1, limits.maxEntries, "entry count");
    members.set(identity, { kind: directory ? "directory" : "file", spelling: path });
  }

  parser.on("entry", (entry: ReadEntry) => {
    activeEntry = entry;
    entry.on("error", fail);
    activeWriter = (async () => {
      checkFailure();
      if (!header || entry.size !== (header.size ?? 0) || entry.remain !== entry.size || entry.type !== header.type) {
        throw invalid("Archive entry framing disagrees with effective metadata");
      }
      const directory = entry.type === "Directory";
      if (!directory && entry.type !== "File" && entry.type !== "OldFile") {
        throw new FileTransferError("unsupported-entry", "Archive entry type is not supported");
      }
      if (entry.linkpath || (entry.nlink !== undefined && entry.nlink > 1)) {
        throw new FileTransferError("unsupported-entry", "Linked archive entries are not supported");
      }
      const path = relativeMemberPath(entry.path, directory, limits);
      registerMember(path, directory);
      if (directory) {
        entry.resume();
        await sink.directory(path);
      } else {
        reserve(payloadBytes, entry.size, limits.maxPayloadBytes, "payload bytes");
        let received = 0;
        let exhausted = false;
        async function* body(): AsyncGenerator<Uint8Array> {
          for await (const chunk of entry) {
            checkFailure();
            if (!(chunk instanceof Uint8Array)) throw invalid("Archive entry produced nonbinary content");
            received = reserve(received, chunk.byteLength, entry.size, "member bytes");
            payloadBytes = reserve(payloadBytes, chunk.byteLength, limits.maxPayloadBytes, "payload bytes");
            yield chunk;
          }
          checkFailure();
          if (received !== entry.size || entry.invalid) throw invalid("Archive member body is truncated");
          exhausted = true;
        }
        await sink.file(path, body(), { expectedBytes: entry.size, ownerExecutable: Boolean((entry.mode ?? 0) & 0o100) });
        if (!exhausted) throw new Error("Archive sink did not consume the complete entry body");
      }
      checkFailure();
    })().catch(fail);
  });

  async function writeParser(bytes: Buffer): Promise<void> {
    checkFailure();
    let drained = false;
    let wake: (() => void) | undefined;
    const handleDrain = () => { drained = true; wake?.(); };
    parser.on("drain", handleDrain);
    try {
      const writable = parser.write(bytes);
      checkFailure();
      if (!writable && !drained) {
        await new Promise<void>((resolve) => {
          wake = resolve;
          failureWaiters.add(resolve);
          if (failure || drained) resolve();
        });
        checkFailure();
      }
    } finally {
      parser.off("drain", handleDrain);
      if (wake) failureWaiters.delete(wake);
    }
  }

  async function settleEntry(): Promise<void> {
    await activeWriter;
    checkFailure();
    activeWriter = undefined;
    activeEntry = undefined;
  }

  async function acceptBlock(block: Buffer): Promise<void> {
    checkFailure();
    if (metadata) {
      block.copy(metadata.buffer, metadata.offset);
      metadata.offset += TAR_BLOCK_BYTES;
      if (metadata.offset === metadata.inputBodyBytes) {
        const { buffer, header: metaHeader, inputBodyBytes } = metadata;
        let metaBlock = metadata.block;
        let size = metaHeader.size ?? 0;
        if (!isZero(buffer.subarray(size, inputBodyBytes))) throw invalid("Archive metadata padding is nonzero");
        const contents = buffer.subarray(0, size);
        let text = decodeMetadata(contents);
        if (["ExtendedHeader", "OldExtendedHeader", "GlobalExtendedHeader"].includes(metaHeader.type)) {
          const numericPath = validatePax(contents);
          if (numericPath && metaHeader.type !== "GlobalExtendedHeader") {
            // Pax.parse coerces digit-only values to Number. Preserve the exact
            // last local path using a harmless prefix in both maintained decoders.
            const path = contents.subarray(numericPath.valueStart, numericPath.end - 1).toString("ascii");
            relativeMemberPath(path, false, limits);
            const replacement = Buffer.from(new Pax({ path: `./${path}` }).encodeField("path"));
            const growth = replacement.length - (numericPath.end - numericPath.start);
            if (growth < 2 || growth > MAX_PAX_PATH_NORMALIZATION_BYTES) throw invalid("Invalid normalized metadata length");
            const normalizedSize = reserve(size, growth, buffer.length, "normalized metadata bytes");
            buffer.copy(buffer, numericPath.end + growth, numericPath.end, size);
            replacement.copy(buffer, numericPath.start);
            buffer.fill(0, normalizedSize);
            size = normalizedSize;
            validatePax(buffer.subarray(0, size));
            text = decodeMetadata(buffer.subarray(0, size));
            metaBlock = Buffer.alloc(TAR_BLOCK_BYTES);
            new Header({ ...metaHeader, type: metaHeader.type, size }).encode(metaBlock);
          }
          if (metaHeader.type === "GlobalExtendedHeader") globalExtended = Pax.parse(text, globalExtended, true);
          else extended = Pax.parse(text, extended, false);
        } else {
          const nul = contents.indexOf(0);
          if (nul >= 0 && !isZero(contents.subarray(nul))) throw invalid("Archive long path contains an embedded NUL");
          const path = nul < 0 ? text : decodeMetadata(contents.subarray(0, nul));
          relativeMemberPath(path, true, limits);
          extended = Object.assign(extended ?? new Pax({}), { path });
        }
        emittedMeta = undefined;
        // Metadata is bounded separately. One write preserves UTF-8 code points
        // across block boundaries without admitting any subsequent header.
        // Only this validated record may exceed the original metadata ceiling,
        // by the derived representation overhead. Source counters stay original.
        parser.maxMetaEntrySize = Math.max(limits.maxArchiveMetaEntryBytes, size);
        try {
          await writeParser(metaBlock);
          await writeParser(buffer.subarray(0, Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES));
        } finally {
          parser.maxMetaEntrySize = limits.maxArchiveMetaEntryBytes;
        }
        if (emittedMeta !== text) throw invalid("Archive metadata decoder changed the input");
        metadata = undefined;
      }
      return;
    }
    if (bodyRemaining) {
      const payload = Math.min(payloadRemaining, TAR_BLOCK_BYTES);
      if (!isZero(block.subarray(payload))) throw invalid("Archive member padding is nonzero");
      payloadRemaining -= payload;
      bodyRemaining -= TAR_BLOCK_BYTES;
      await writeParser(block);
      if (!bodyRemaining) await settleEntry();
      return;
    }
    if (terminalBlocks) {
      if (!isZero(block)) throw invalid("Archive has nonzero data after its terminal blocks");
      terminalBlocks++;
      if (records && terminalBlocks === 2) await writeParser(block);
      return;
    }
    await settleEntry();
    if (isZero(block)) {
      if (pendingLocalMetadata) throw invalid("Archive ends with unapplied entry metadata");
      terminalBlocks = 1;
      if (records) await writeParser(block);
      return;
    }
    try {
      header = new Header(block, 0, extended, globalExtended);
    } catch (error) {
      throw invalid("Archive header is malformed", error);
    }
    if (!header.cksumValid || !header.path) throw invalid("Archive header checksum or path is invalid");
    records = reserve(records, 1, limits.maxEntries, "record count");
    const size = reserve(0, header.size ?? 0, limits.maxDecodedArchiveBytes, "member size");
    if (META_TYPES.has(header.type)) {
      reserve(0, size, limits.maxArchiveMetaEntryBytes, "metadata bytes");
      if (header.type !== "GlobalExtendedHeader") pendingLocalMetadata = true;
      if (!size && !["ExtendedHeader", "OldExtendedHeader", "GlobalExtendedHeader"].includes(header.type)) {
        throw invalid("Archive long path metadata is empty");
      }
      if (size) {
        const overhead = header.type === "ExtendedHeader" || header.type === "OldExtendedHeader" ? MAX_PAX_PATH_NORMALIZATION_BYTES : 0;
        const capacity = reserve(size, overhead, Number.MAX_SAFE_INTEGER, "metadata buffer bytes");
        metadata = {
          buffer: Buffer.alloc(Math.ceil(capacity / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES),
          offset: 0, inputBodyBytes: Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES, header, block,
        };
      } else {
        await writeParser(block);
      }
      return;
    }
    if (!["File", "OldFile", "Directory"].includes(header.type)) {
      throw new FileTransferError("unsupported-entry", "Archive entry type is not supported");
    }
    // A local extended path replaces the header's legacy name and prefix.
    // Validate it before the entry decoder normalizes platform separators.
    relativeMemberPath(extended?.path ?? header.path, header.type === "Directory", limits);
    if (!extended?.path) validateHeaderStrings(block);
    // The maintained decoder normalizes directory size to zero. Require a
    // zero source field so a declared directory body cannot masquerade as EOF.
    if (header.type === "Directory" && !hasZeroSizeField(block)) throw invalid("Archive directory declares a body");
    pendingLocalMetadata = false;
    extended = undefined;
    bodyRemaining = Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
    payloadRemaining = size;
    await writeParser(block);
    if (!bodyRemaining) await settleEntry();
  }

  async function* sourceChunks(): AsyncGenerator<Buffer> {
    for await (const chunk of source) {
      checkFailure();
      if (!(chunk instanceof Uint8Array)) throw invalid("Archive source must be a binary stream");
      sourceBytes = reserve(sourceBytes, chunk.byteLength, limits.maxArchiveInputBytes, "input bytes");
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      for (let offset = 0; offset < bytes.length; offset += limits.bufferBytes) {
        checkFailure();
        yield bytes.subarray(offset, offset + limits.bufferBytes);
      }
    }
  }

  try {
    checkFailure();
    const chunks = sourceChunks();
    let initial: Buffer = Buffer.alloc(0);
    while (initial.length < 4) {
      const next = await chunks.next();
      if (next.done) break;
      initial = initial.length ? Buffer.concat([initial, next.value]) : next.value;
    }
    const format: ArchiveFormat = initial[0] === 0x1f && initial[1] === 0x8b ? "tar.gz" : "tar";
    async function* input(): AsyncGenerator<Buffer> {
      yield initial;
      yield* chunks;
    }
    let decoded: AsyncIterable<Buffer> = input();
    if (format === "tar.gz") {
      const gunzipOptions = { chunkSize: Math.max(64, limits.bufferBytes), readableHighWaterMark: limits.bufferBytes, writableHighWaterMark: limits.bufferBytes };
      gunzip = createGunzip(gunzipOptions);
      gunzip.on("error", (error) => fail(invalid("Gzip stream is corrupt or incomplete", error)));
      compressedInput = Readable.from(input(), { objectMode: false, highWaterMark: limits.bufferBytes });
      compressedWriter = pipeline(compressedInput, gunzip).catch(fail);
      decoded = gunzip;
    } else {
      rejectCompressionMagic(initial);
    }
    let block = Buffer.alloc(TAR_BLOCK_BYTES);
    let used = 0;
    let firstBlock = true;
    for await (const bytes of decoded) {
      checkFailure();
      decodedBytes = reserve(decodedBytes, bytes.byteLength, limits.maxDecodedArchiveBytes, "decoded bytes");
      for (let offset = 0; offset < bytes.length;) {
        const amount = Math.min(TAR_BLOCK_BYTES - used, bytes.length - offset);
        bytes.copy(block, used, offset, offset + amount);
        used += amount;
        offset += amount;
        if (firstBlock && used >= 4) rejectCompressionMagic(block.subarray(0, used));
        if (used === TAR_BLOCK_BYTES) {
          if (firstBlock) { rejectCompressionMagic(block); firstBlock = false; }
          await acceptBlock(block);
          block = Buffer.alloc(TAR_BLOCK_BYTES);
          used = 0;
        }
      }
    }
    await compressedWriter;
    await sourceSettled;
    checkFailure();
    // Gunzip can stop at a NUL and ignore subsequent compressed input. The
    // native consumed-input count must cover every byte of the settled source.
    if (gunzip && gunzip.bytesWritten !== sourceBytes) throw invalid("Gzip stream contains unconsumed trailing data");
    if (used || metadata || bodyRemaining || terminalBlocks < 2) throw invalid("Archive is truncated or lacks complete terminal blocks");
    await settleEntry();
    // A structurally proven all-zero tar has no parser entries. Ending the
    // selected parser would incorrectly report it as an unrecognized format.
    if (records) {
      if (!parserEof) throw invalid("Archive parser did not reach its terminal blocks");
      parser.end();
      checkFailure();
      if (!parserEnded) throw invalid("Archive parser did not finish");
    }
    checkFailure();
    return { format };
  } catch (error) {
    fail(error);
    throw failure;
  } finally {
    if (failure) {
      await activeWriter;
      await compressedWriter;
      await sourceSettled;
    }
    signal.removeEventListener("abort", handleAbort);
    source.off("error", handleSourceError);
  }
}
