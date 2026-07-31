import { createReadStream } from "node:fs";
import { join } from "node:path";
import { finished } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
import { createGunzip } from "node:zlib";
import { withFileLock } from "../lib/with-file-lock.js";

const AUDIT_SNAPSHOT_LOCK_FILE = ".audit-snapshot";
const AUDIT_SNAPSHOT_LOCK_OPTIONS = { stale: 5 * 60_000, retries: 20 };

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
  const decoder = new StringDecoder("utf-8");
  let pending = "";

  const assertLineSize = (line: string): void => {
    if (Number.isFinite(maxLineBytes) && Buffer.byteLength(line, "utf-8") > maxLineBytes) {
      throw new Error("JSONL line exceeds the maximum size");
    }
  };

  try {
    for await (const chunk of content) {
      pending += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
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
    }
    pending += decoder.end();
    if (pending.length > 0) {
      assertLineSize(pending);
      yield pending;
    }
  } finally {
    content.destroy();
    if (content !== input) input.destroy();
    await Promise.all([
      finished(content, { cleanup: true }).catch(() => undefined),
      ...(content === input ? [] : [finished(input, { cleanup: true }).catch(() => undefined)]),
    ]);
  }
}
