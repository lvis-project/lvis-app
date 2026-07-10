/**
 * Self-contained out-of-process MCP plugin server fixture
 * (untrusted-stdio-isolation test). Speaks the RC wire protocol over
 * Content-Length-framed stdin/stdout — NO project imports, so it runs as a real
 * `node` subprocess without a build step. Mirrors what a real spawned plugin
 * (StdioServerLoop + PluginMcpServer) would do.
 */
let buffer = Buffer.alloc(0);

function write(message) {
  const json = JSON.stringify(message);
  const header = `Content-Length: ${Buffer.byteLength(json, "utf-8")}\r\n\r\n`;
  process.stdout.write(Buffer.from(header, "ascii"));
  process.stdout.write(Buffer.from(json, "utf-8"));
}

function handle(req) {
  const id = req.id;
  switch (req.method) {
    case "server/discover":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          resultType: "complete",
          supportedVersions: ["2026-07-28"],
          serverInfo: { name: "echo", version: "1.0.0", description: "echo" },
          capabilities: { tools: { listChanged: true } },
        },
      };
    case "tools/list":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          resultType: "complete",
          tools: [
            {
              name: "echo_say",
              description: "echo a message",
              inputSchema: {
                $schema: "https://json-schema.org/draft/2020-12/schema",
                type: "object",
                properties: { msg: { type: "string" } },
                required: ["msg"],
              },
              // #885: this self-declared category is DELIBERATELY still sent —
              // the host ignores it (a plugin can lie) and registers the
              // default-strict "write" baseline. Kept to prove the reverse
              // projection does NOT honor a wire-declared category.
              _meta: { "xyz.lvis/category": "read", "xyz.lvis/version": "1.0.0" },
            },
          ],
        },
      };
    case "tools/call": {
      const args = req.params?.arguments ?? {};
      // Special trigger: simulate a plugin crash to prove containment.
      if (args.crash) process.exit(7);
      return {
        jsonrpc: "2.0",
        id,
        result: { resultType: "complete", content: [{ type: "text", text: `echo: ${args.msg}` }] },
      };
    }
    default:
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${req.method}` } };
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) break;
    const header = buffer.subarray(0, headerEnd).toString("ascii");
    const m = header.match(/Content-Length:\s*(\d+)/i);
    if (!m) {
      buffer = buffer.subarray(headerEnd + 4);
      continue;
    }
    const len = parseInt(m[1], 10);
    const start = headerEnd + 4;
    if (buffer.length < start + len) break;
    const body = buffer.subarray(start, start + len).toString("utf-8");
    buffer = buffer.subarray(start + len);
    let req;
    try {
      req = JSON.parse(body);
    } catch {
      continue;
    }
    if (req.method && req.id !== undefined) {
      Promise.resolve(handle(req)).then((res) => write(res));
    }
  }
});
