import { appendFileSync, chmodSync, createReadStream, existsSync, mkdirSync, readFileSync, readSync } from "node:fs";
import { dirname, join } from "node:path";
import { finished } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
import { createGunzip } from "node:zlib";
import { withFileLock } from "../lib/with-file-lock.js";
import { writeUtf8FileAtomicSync } from "../lib/atomic-file.js";

const AUDIT_SNAPSHOT_LOCK_FILE = ".audit-snapshot";
const AUDIT_SNAPSHOT_LOCK_OPTIONS = { stale: 5 * 60_000, retries: 20 };
const FD_READ_CHUNK_BYTES = 64 * 1024;

/**
 * Serialize archive rotation and aggregate reads so a usage snapshot cannot
 * observe both a raw file and its gzip archive (or neither).
 */
export function withAuditSnapshotLock<T>(
  auditDir: string,
  operation: () => Promise<T>,
): Promise<T> {
  return withFileLock(
    join(auditDir, AUDIT_SNAPSHOT_LOCK_FILE),
    operation,
    AUDIT_SNAPSHOT_LOCK_OPTIONS,
  );
}

/**
 * Split an already-read JSONL document into its non-blank lines. Same line
 * contract as the streaming splitter below (LF-delimited, a trailing CR is
 * dropped) for callers that hold the whole file in memory. Lines are returned
 * as written — not trimmed — because HMAC chains hash the exact bytes.
 */
export function parseJsonlLines(raw: string): string[] {
  const lines: string[] = [];
  for (let line of raw.split("\n")) {
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line.trim().length === 0) continue;
    lines.push(line);
  }
  return lines;
}

export interface JsonlRecordFileOptions<T> {
  /** Keeps a parsed line as a record; anything else is silently dropped. */
  accept: (parsed: unknown) => parsed is T;
  /** A line that is not JSON at all. */
  onMalformedLine: (line: string) => void;
  /** The file exists but could not be read; the store starts empty. */
  onReadFailure: (err: unknown) => void;
}

/**
 * One private JSONL record file (`0o600` under a `0o700` directory) with the
 * three operations every host-owned record store needs: load the records once,
 * append one record, rewrite the whole file from memory. Both writers hold the
 * cross-process file lock, and the rewrite goes through the atomic
 * temp+rename writer so a crash mid-rewrite can never leave a truncated store.
 */
export class JsonlRecordFile<T> {
  constructor(
    readonly filePath: string,
    private readonly options: JsonlRecordFileOptions<T>,
  ) {}

  /** Missing file reads as an empty store. */
  loadSync(): T[] {
    if (!existsSync(this.filePath)) return [];
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf-8");
    } catch (err) {
      this.options.onReadFailure(err);
      return [];
    }
    const records: T[] = [];
    for (const line of parseJsonlLines(raw)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        this.options.onMalformedLine(line);
        continue;
      }
      if (this.options.accept(parsed)) records.push(parsed);
    }
    return records;
  }

  /** O(1) append of one record. */
  async append(record: T): Promise<void> {
    await withFileLock(this.filePath, async () => {
      mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
      appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, { encoding: "utf-8", mode: 0o600 });
      try {
        // `mode` only applies when append creates the file; an existing file keeps its bits.
        chmodSync(this.filePath, 0o600);
      } catch {
        // Non-fatal — chmod failure must not block record writes.
      }
    });
  }

  /** Replace the file with exactly `records`, atomically. */
  async rewrite(records: readonly T[]): Promise<void> {
    await withFileLock(this.filePath, async () => {
      mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
      const body = records.map((record) => JSON.stringify(record)).join("\n") + (records.length > 0 ? "\n" : "");
      writeUtf8FileAtomicSync(this.filePath, body, 0o600);
    });
  }
}

/**
 * Split UTF-8 JSONL bytes into lines. The single authority for the line
 * contract shared by the pathname and descriptor readers below.
 */
function createJsonlLineSplitter(maxLineBytes: number) {

  const decoder = new StringDecoder("utf-8");
  let pending = "";

  const assertLineSize = (line: string): void => {
    if (Number.isFinite(maxLineBytes) && Buffer.byteLength(line, "utf-8") > maxLineBytes) {
      throw new Error("JSONL line exceeds the maximum size");
    }
  };

  return {
    *push(chunk: Buffer): Generator<string> {
      pending += decoder.write(chunk);
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        let line = pending.slice(0, newline);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        assertLineSize(line);
        yield line;
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
      assertLineSize(pending);
    },
    *end(): Generator<string> {
      pending += decoder.end();
      if (pending.length > 0) {
        assertLineSize(pending);
        yield pending;
      }
    },
  };
}

/**
 * Iterate a UTF-8 JSONL file without retaining the file's lines in memory.
 * `.gz` archives use the same line contract as active files. The stream is
 * always torn down, including when a consumer exits early.
 */
export async function* iterateJsonlLines(
  filePath: string,
  maxLineBytes = Number.POSITIVE_INFINITY,
): AsyncGenerator<string> {
  const input = createReadStream(filePath);
  const gunzip = filePath.endsWith(".gz") ? createGunzip() : undefined;
  const content = gunzip ? input.pipe(gunzip) : input;
  const splitter = createJsonlLineSplitter(maxLineBytes);

  try {
    for await (const chunk of content) {
      yield* splitter.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    yield* splitter.end();
  } finally {
    content.destroy();
    if (content !== input) input.destroy();
    await Promise.all([
      finished(content, { cleanup: true }).catch(() => undefined),
      ...(content === input ? [] : [finished(input, { cleanup: true }).catch(() => undefined)]),
    ]);
  }
}

/**
 * Iterate the first `byteLength` bytes of an already-open descriptor, using the
 * same line contract as {@link iterateJsonlLines}.
 *
 * A caller that must not re-resolve the pathname it is reading — because
 * another process may replace the file underneath it between verification and
 * use — reads through its own descriptor instead. Reads are positional, so the
 * descriptor's own offset is untouched, and the descriptor is left open for the
 * caller to close.
 */
export async function* iterateJsonlLinesFromFd(
  fd: number,
  byteLength: number,
  maxLineBytes = Number.POSITIVE_INFINITY,
): AsyncGenerator<string> {
  const splitter = createJsonlLineSplitter(maxLineBytes);
  const chunk = Buffer.allocUnsafe(FD_READ_CHUNK_BYTES);
  let position = 0;
  while (position < byteLength) {
    const bytesRead = readSync(
      fd,
      chunk,
      0,
      Math.min(chunk.length, byteLength - position),
      position,
    );
    if (bytesRead === 0) throw new Error("JSONL descriptor ended before its expected length");
    position += bytesRead;
    yield* splitter.push(chunk.subarray(0, bytesRead));
  }
  yield* splitter.end();
}
