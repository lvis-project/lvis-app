/**
 * MCP Client — Transport tests.
 *
 * Covers (§9.5):
 *   1. `McpServerConfig` discriminated-union typing.
 *   2. Streamable HTTP happy path (`initialize` → `tools/list` → `tools/call`).
 *   3. NetworkGuard rejection when an HTTP URL resolves to a private IP
 *      and `allowPrivateNetworks` is not set.
 *   4. SSE streaming path: a multi-chunk `text/event-stream` body is
 *      reassembled into one JSON-RPC response.
 *   5. stdio transport regression: existing Content-Length framed
 *      handshake still succeeds.
 *
 * No live network / process I/O — `fetch`, `dns.lookup`, and
 * `child_process.spawn` are stubbed.
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";

// ─── dns mock — configurable per test ───────────────────────
type LookupResult = { address: string; family: number };
const lookupMock = vi.fn<
  (host: string, opts: unknown) => Promise<LookupResult[]>
>();
vi.mock("node:dns", () => ({
  promises: {
    lookup: (host: string, opts: unknown) => lookupMock(host, opts),
  },
}));

// ─── child_process mock — stdio path ────────────────────────
const spawnMock = vi.fn<
  (cmd: string, args?: readonly string[], opts?: unknown) => unknown
>();
vi.mock("node:child_process", () => ({
  spawn: (cmd: string, args?: readonly string[], opts?: unknown) =>
    spawnMock(cmd, args, opts),
}));

// Module imports must come AFTER the mocks above.
import { McpClient } from "../mcp-client.js";
import { McpGovernance } from "../mcp-governance.js";
import { ToolRegistry } from "../../tools/registry.js";
import type {
  McpGovernancePolicy,
  McpHttpServerConfig,
  McpServerConfig,
  McpStdioServerConfig,
} from "../types.js";

// ─── Helpers ────────────────────────────────────────────────

/**
 * Build a governance instance whose internal policy is swapped out to the
 * in-memory one we provide. Avoids any filesystem dependency.
 */
function governanceWithPolicy(policy: McpGovernancePolicy): McpGovernance {
  // Constructing with a path that does not exist → default policy is loaded;
  // then we override via the untyped `policy` field. This mirrors how the
  // governance layer behaves when IT Admin updates the file in place.
  const gov = new McpGovernance("/nonexistent/mcp-policy.json");
  (gov as unknown as { policy: McpGovernancePolicy }).policy = policy;
  return gov;
}

function httpApproval(
  id: string,
  url: string,
  overrides: Partial<McpGovernancePolicy["servers"][number]> = {},
): McpGovernancePolicy["servers"][number] {
  return {
    id,
    name: id,
    status: "approved",
    transport: "http",
    allowedUrls: [new URL(url).hostname],
    requiredAuth: "none",
    tlsRequired: false,
    allowedCapabilities: ["tools"],
    maxTools: 16,
    toolNamePrefix: id,
    toolPermissionMode: "default",
    maxResponseSizeBytes: 1_000_000,
    connectionTimeoutMs: 5_000,
    maxConcurrentRequests: 4,
    ...overrides,
  };
}

function stdioApproval(
  id: string,
  command: string,
): McpGovernancePolicy["servers"][number] {
  return {
    id,
    name: id,
    status: "approved",
    transport: "stdio",
    allowedCommands: [command],
    requiredAuth: "none",
    tlsRequired: false,
    allowedCapabilities: ["tools"],
    maxTools: 16,
    toolNamePrefix: id,
    toolPermissionMode: "default",
    maxResponseSizeBytes: 1_000_000,
    connectionTimeoutMs: 5_000,
    maxConcurrentRequests: 4,
  };
}

function buildPolicy(
  approvals: McpGovernancePolicy["servers"],
): McpGovernancePolicy {
  return {
    version: "1.0-test",
    defaultPolicy: "deny",
    servers: approvals,
    globalRules: {
      maxServersTotal: 10,
      blockedUrlPatterns: [],
      allowedUrlPatterns: [],
      auditLevel: "errors-only",
      killSwitchEnabled: true,
      policyRefreshIntervalMs: 60_000,
    },
  };
}

/** Simple JSON-RPC body matcher. */
function readRpcMethod(init: RequestInit | undefined): string | undefined {
  if (!init?.body) return undefined;
  try {
    return JSON.parse(String(init.body)).method as string;
  } catch {
    return undefined;
  }
}

function readRpcId(init: RequestInit | undefined): number | undefined {
  if (!init?.body) return undefined;
  try {
    return JSON.parse(String(init.body)).id as number;
  } catch {
    return undefined;
  }
}

function jsonRpcResponse(id: number, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Construct a streaming SSE response from a list of byte chunks. */
function sseResponse(chunks: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

// ─── Lifecycle ──────────────────────────────────────────────

beforeEach(() => {
  lookupMock.mockReset();
  spawnMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── 1. Discriminated union typing ──────────────────────────

describe("McpServerConfig discriminated union", () => {
  it("accepts a stdio config with command/args", () => {
    const cfg: McpServerConfig = {
      id: "fs",
      transport: "stdio",
      command: "lvis-mcp-fs",
      args: ["--root", "/tmp"],
      env: { NODE_ENV: "production" },
    };
    expect(cfg.transport).toBe("stdio");
    // Narrowing: `command` is required on the stdio branch.
    if (cfg.transport === "stdio") {
      expect(cfg.command).toBe("lvis-mcp-fs");
    }
  });

  it("accepts an http config with url/headers", () => {
    const cfg: McpServerConfig = {
      id: "hr",
      transport: "http",
      url: "https://hr-api.lge.com/mcp",
      headers: { "x-tenant": "lge" },
    };
    expect(cfg.transport).toBe("http");
    if (cfg.transport === "http") {
      expect(cfg.url).toBe("https://hr-api.lge.com/mcp");
      expect(cfg.headers?.["x-tenant"]).toBe("lge");
    }
  });

  it("accepts allowPrivateNetworks escape hatch on http", () => {
    const cfg: McpHttpServerConfig = {
      id: "onprem",
      transport: "http",
      url: "http://10.0.0.5/mcp",
      allowPrivateNetworks: true,
    };
    expect(cfg.allowPrivateNetworks).toBe(true);
  });
});

// ─── 2. HTTP happy path ─────────────────────────────────────

describe("HttpTransport — happy path", () => {
  it("performs initialize → tools/list → tools/call over JSON responses", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);

    const fetchMock = vi.fn(
      async (_url: string, init?: RequestInit): Promise<Response> => {
        const method = readRpcMethod(init);
        const id = readRpcId(init) ?? 0;
        switch (method) {
          case "initialize":
            return jsonRpcResponse(id, {
              protocolVersion: "2024-11-05",
              capabilities: { tools: {} },
              serverInfo: { name: "hr-mcp", version: "1.0.0" },
            });
          case "notifications/initialized":
            return new Response(null, { status: 202 });
          case "tools/list":
            return jsonRpcResponse(id, {
              tools: [
                {
                  name: "query",
                  description: "Run an HR query",
                  inputSchema: {
                    type: "object",
                    properties: { q: { type: "string" } },
                    required: ["q"],
                  },
                },
              ],
            });
          case "tools/call":
            return jsonRpcResponse(id, {
              content: [{ type: "text", text: "result-ok" }],
            });
          default:
            return new Response("unexpected", { status: 500 });
        }
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const gov = governanceWithPolicy(
      buildPolicy([httpApproval("hr", "https://hr-api.lge.com/mcp")]),
    );
    const registry = new ToolRegistry();
    const client = new McpClient(
      {
        id: "hr",
        transport: "http",
        url: "https://hr-api.lge.com/mcp",
      },
      gov,
      registry,
    );

    await client.connect();
    expect(client.getState().status).toBe("connected");
    expect(client.getState().registeredTools).toEqual(["mcp_hr_query"]);

    const out = await client.callTool("query", { q: "hello" });
    expect(out).toBe("result-ok");

    await client.disconnect();

    // Verify the round-trip: initialize, initialized notification, tools/list,
    // then one tools/call.
    const methods = fetchMock.mock.calls
      .map(([, init]) => readRpcMethod(init as RequestInit))
      .filter(Boolean);
    expect(methods).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/call",
    ]);
  });
});

// ─── 3. NetworkGuard rejection ──────────────────────────────

describe("HttpTransport — NetworkGuard", () => {
  it("rejects a URL whose host resolves to a private IP when allowPrivateNetworks is not set", async () => {
    // Governance passes (https, allowed host); DNS then resolves the host
    // to an RFC1918 address — NetworkGuard must reject with the
    // "network guard:" prefix before any fetch is issued.
    lookupMock.mockResolvedValueOnce([{ address: "10.0.0.5", family: 4 }]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const gov = governanceWithPolicy(
      buildPolicy([httpApproval("internal", "https://internal.example.com/mcp")]),
    );
    const client = new McpClient(
      {
        id: "internal",
        transport: "http",
        url: "https://internal.example.com/mcp",
      },
      gov,
      new ToolRegistry(),
    );

    await expect(client.connect()).rejects.toThrow(/network guard:/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(client.getState().status).toBe("error");
  });

  it("allows a private-IP URL when allowPrivateNetworks is true", async () => {
    const fetchMock = vi.fn(
      async (_url: string, init?: RequestInit): Promise<Response> => {
        const method = readRpcMethod(init);
        const id = readRpcId(init) ?? 0;
        if (method === "initialize") {
          return jsonRpcResponse(id, {
            protocolVersion: "2024-11-05",
            capabilities: {},
            serverInfo: { name: "local", version: "0.0.1" },
          });
        }
        if (method === "notifications/initialized") {
          return new Response(null, { status: 202 });
        }
        if (method === "tools/list") {
          return jsonRpcResponse(id, { tools: [] });
        }
        return new Response("x", { status: 500 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const gov = governanceWithPolicy(
      buildPolicy([
        httpApproval("local", "http://localhost:4040/mcp", {
          allowedUrls: ["localhost"],
        }),
      ]),
    );
    const client = new McpClient(
      {
        id: "local",
        transport: "http",
        url: "http://localhost:4040/mcp",
        allowPrivateNetworks: true,
      },
      gov,
      new ToolRegistry(),
    );

    await client.connect();
    expect(client.getState().status).toBe("connected");
    await client.disconnect();
  });
});

// ─── 4. SSE streaming path ──────────────────────────────────

describe("HttpTransport — SSE streaming", () => {
  it("reassembles a multi-chunk text/event-stream response", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);

    // The server answers `initialize` via SSE across three TCP chunks:
    //   chunk 1: "event: message\ndata: {\"jsonrpc\""
    //   chunk 2: ":\"2.0\",\"id\":1,"
    //   chunk 3: "\"result\":{...}}\n\n"
    const initResult = {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "stream-mcp", version: "0.1.0" },
    };
    const initPayload = JSON.stringify({ jsonrpc: "2.0", id: 1, result: initResult });

    const fetchMock = vi.fn(
      async (_url: string, init?: RequestInit): Promise<Response> => {
        const method = readRpcMethod(init);
        const id = readRpcId(init) ?? 0;
        if (method === "initialize") {
          // Split the JSON payload in half to prove the SSE reader
          // concatenates chunks before parsing.
          const midpoint = Math.floor(initPayload.length / 2);
          const head = initPayload.slice(0, midpoint);
          const tail = initPayload.slice(midpoint);
          return sseResponse([
            "event: message\ndata: ",
            head,
            tail + "\n\n",
          ]);
        }
        if (method === "notifications/initialized") {
          return new Response(null, { status: 202 });
        }
        if (method === "tools/list") {
          return jsonRpcResponse(id, { tools: [] });
        }
        return new Response("x", { status: 500 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const gov = governanceWithPolicy(
      buildPolicy([httpApproval("stream", "https://stream.example.com/mcp")]),
    );
    const client = new McpClient(
      {
        id: "stream",
        transport: "http",
        url: "https://stream.example.com/mcp",
      },
      gov,
      new ToolRegistry(),
    );

    await client.connect();
    expect(client.getState().status).toBe("connected");
    await client.disconnect();
  });
});

// ─── 5. stdio regression ────────────────────────────────────

/**
 * Fake ChildProcess that lets us drive stdout from the test and captures
 * stdin writes so we can observe Content-Length framed traffic.
 */
class FakeChildProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = {
    writable: true,
    write: (chunk: string) => {
      this.stdinBuffer += chunk;
      this.parseAndRespond();
      return true;
    },
    end: () => {
      this.stdin.writable = false;
    },
  };
  exitCode: number | null = null;
  private stdinBuffer = "";

  // Prepared responses keyed by method name.
  responses: Record<string, (id: number) => unknown> = {};

  kill(_signal?: string): boolean {
    this.exitCode = 0;
    this.emit("exit", 0, null);
    return true;
  }

  /**
   * Walks `stdinBuffer`, extracts every complete Content-Length framed
   * JSON-RPC request, and writes a framed response back on stdout.
   */
  private parseAndRespond(): void {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const headerEnd = this.stdinBuffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const header = this.stdinBuffer.slice(0, headerEnd);
      const m = header.match(/Content-Length:\s*(\d+)/i);
      if (!m) {
        this.stdinBuffer = this.stdinBuffer.slice(headerEnd + 4);
        continue;
      }
      const len = parseInt(m[1], 10);
      const bodyStart = headerEnd + 4;
      if (this.stdinBuffer.length < bodyStart + len) return;
      const body = this.stdinBuffer.slice(bodyStart, bodyStart + len);
      this.stdinBuffer = this.stdinBuffer.slice(bodyStart + len);
      try {
        const req = JSON.parse(body) as {
          method: string;
          id?: number;
        };
        // Notifications have no id → do not reply.
        if (req.id === undefined) continue;
        const builder = this.responses[req.method];
        if (!builder) continue;
        const result = builder(req.id);
        const payload = JSON.stringify({ jsonrpc: "2.0", id: req.id, result });
        const frame = `Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`;
        // Defer slightly so the client's Promise has time to register.
        queueMicrotask(() => this.stdout.write(frame));
      } catch {
        /* ignore malformed */
      }
    }
  }
}

describe("StdioTransport — regression", () => {
  it("connects via subprocess with Content-Length framed JSON-RPC", async () => {
    const fake = new FakeChildProcess();
    fake.responses = {
      initialize: (id) => ({
        id,
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "fs", version: "0.1.0" },
      }),
      "tools/list": () => ({
        tools: [
          {
            name: "read",
            description: "Read a file",
            inputSchema: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
            },
          },
        ],
      }),
      "tools/call": () => ({
        content: [{ type: "text", text: "file-contents" }],
      }),
    };
    spawnMock.mockReturnValueOnce(fake);

    const gov = governanceWithPolicy(
      buildPolicy([stdioApproval("fs", "lvis-mcp-fs")]),
    );
    const registry = new ToolRegistry();
    const client = new McpClient(
      {
        id: "fs",
        transport: "stdio",
        command: "lvis-mcp-fs",
        args: ["--root", "/tmp"],
      },
      gov,
      registry,
    );

    await client.connect();
    expect(client.getState().status).toBe("connected");
    expect(client.getState().registeredTools).toEqual(["mcp_fs_read"]);

    const text = await client.callTool("read", { path: "/tmp/a.txt" });
    expect(text).toBe("file-contents");

    await client.disconnect();
    expect(client.getState().status).toBe("disconnected");
  });
});
