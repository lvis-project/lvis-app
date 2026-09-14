import { StringDecoder } from "node:string_decoder";

export type JsonLineReadFailure = "frame-too-large" | "invalid-json";

/** Incremental JSONL framing with a byte ceiling on each individual line. */
export class JsonLineReader {
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  private bufferBytes = 0;
  private closed = false;

  constructor(private readonly options: {
    maxLineBytes: number;
    onMessage: (value: unknown) => void;
    onError: (failure: JsonLineReadFailure) => void;
  }) {
    if (!Number.isSafeInteger(options.maxLineBytes) || options.maxLineBytes <= 0) {
      throw new Error("Invalid JSON line byte limit");
    }
  }

  write(chunk: Buffer | string): void {
    if (this.closed) return;
    const text = this.decoder.write(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
    let start = 0;
    while (start < text.length && !this.closed) {
      const newline = text.indexOf("\n", start);
      const fragment = text.slice(start, newline < 0 ? undefined : newline);
      const bytes = this.bufferBytes + Buffer.byteLength(fragment, "utf8");
      if (bytes > this.options.maxLineBytes) {
        this.fail("frame-too-large");
        return;
      }
      this.buffer += fragment;
      this.bufferBytes = bytes;
      if (newline < 0) return;
      const line = this.buffer.trim();
      this.buffer = "";
      this.bufferBytes = 0;
      start = newline + 1;
      if (!line) continue;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        this.fail("invalid-json");
        return;
      }
      this.options.onMessage(message);
    }
  }

  close(): void {
    this.closed = true;
    this.buffer = "";
    this.bufferBytes = 0;
  }

  private fail(failure: JsonLineReadFailure): void {
    this.close();
    this.options.onError(failure);
  }
}
