/**
 * Content-Length stdio framing for MCP JSON-RPC (LSP/MCP standard:
 * `Content-Length: <bytes>\r\n\r\n<utf8-json>`), shared by the out-of-process
 * plugin path (mcp-alignment-design.md §3.1, `untrusted-stdio-isolation`).
 *
 * Byte-accurate: lengths are UTF-8 byte counts (not char counts), so multi-byte
 * bodies frame correctly. Mirrors the framing `mcp-client.ts`'s external
 * `StdioTransport` already uses on the wire, so the two interoperate; this is the
 * reusable, independently-tested extraction used by the subprocess serving loop.
 */

/** Frame one JSON-RPC message for an output stream. */
export function frameMessage(message: unknown): Buffer {
  const json = JSON.stringify(message);
  const header = `Content-Length: ${Buffer.byteLength(json, "utf-8")}\r\n\r\n`;
  return Buffer.concat([Buffer.from(header, "ascii"), Buffer.from(json, "utf-8")]);
}

/**
 * Incremental decoder: feed it stream chunks; it returns every COMPLETE framed
 * message parsed so far, buffering partial frames across `push` calls. Malformed
 * frames (missing/!numeric Content-Length, unparseable body) are skipped, not
 * thrown — a hostile/buggy peer must not crash the loop.
 */
export class StdioFrameDecoder {
  private buffer = Buffer.alloc(0);

  push(chunk: Buffer): Array<Record<string, unknown>> {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const out: Array<Record<string, unknown>> = [];

    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;

      const headerBlock = this.buffer.subarray(0, headerEnd).toString("ascii");
      const match = headerBlock.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        // Unframed/garbage header — drop it and resync past the separator.
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }

      const contentLength = parseInt(match[1], 10);
      const start = headerEnd + 4;
      const end = start + contentLength;
      if (this.buffer.length < end) break; // body not fully arrived yet

      const body = this.buffer.subarray(start, end).toString("utf-8");
      this.buffer = this.buffer.subarray(end);

      try {
        const parsed = JSON.parse(body);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          out.push(parsed as Record<string, unknown>);
        }
      } catch {
        // Skip an unparseable body; the next frame may still be intact.
      }
    }
    return out;
  }
}
