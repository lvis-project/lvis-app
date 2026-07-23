import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { finished } from "node:stream/promises";

/**
 * Iterate a UTF-8 JSONL file without retaining the file's lines in memory.
 * The stream is always torn down, including when a consumer exits early.
 */
export async function* iterateJsonlLines(filePath: string): AsyncGenerator<string> {
  const input = createReadStream(filePath, { encoding: "utf-8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      yield line;
    }
  } finally {
    lines.close();
    input.destroy();
    await finished(input, { cleanup: true }).catch(() => undefined);
  }
}
