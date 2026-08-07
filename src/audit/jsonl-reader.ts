import { createReadStream, readSync } from "node:fs";
import { join } from "node:path";
import { finished } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
import { createGunzip } from "node:zlib";
import { withFileLock } from "../lib/with-file-lock.js";

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
