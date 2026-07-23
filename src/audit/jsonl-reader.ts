import { createReadStream } from "node:fs";
import { finished } from "node:stream/promises";

/**
 * Iterate a UTF-8 JSONL file without retaining the file's lines in memory.
 * The stream is always torn down, including when a consumer exits early.
 */
export async function* iterateJsonlLines(
  filePath: string,
  maxLineBytes = Number.POSITIVE_INFINITY,
): AsyncGenerator<string> {
  const input = createReadStream(filePath, { encoding: "utf-8" });
  let pending = "";
  try {
    for await (const chunk of input) {
      pending += chunk;
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        let line = pending.slice(0, newline);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (
          Number.isFinite(maxLineBytes)
          && Buffer.byteLength(line, "utf-8") > maxLineBytes
        ) {
          throw new Error("JSONL line exceeds the maximum size");
        }
        yield line;
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
      if (
        Number.isFinite(maxLineBytes)
        && Buffer.byteLength(pending, "utf-8") > maxLineBytes
      ) {
        throw new Error("JSONL line exceeds the maximum size");
      }
    }
    if (pending.length > 0) yield pending;
  } finally {
    input.destroy();
    await finished(input, { cleanup: true }).catch(() => undefined);
  }
}
