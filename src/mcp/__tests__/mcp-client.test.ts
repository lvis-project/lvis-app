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
import { PermissionManager } from "../../permissions/permission-manager.js";
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
      url: "https://api.example.com/mcp",
      headers: { "x-tenant": "lge" },
    };
    expect(cfg.transport).toBe("http");
    if (cfg.transport === "http") {
      expect(cfg.url).toBe("https://api.example.com/mcp");
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
      buildPolicy([httpApproval("hr", "https://api.example.com/mcp")]),
    );
    const registry = new ToolRegistry();
    const client = new McpClient(
      {
        id: "hr",
        transport: "http",
        url: "https://api.example.com/mcp",
      },
      gov,
      registry,
    );

    await client.connect();
    expect(client.getState().status).toBe("connected");
    expect(client.getState().registeredTools).toEqual(["mcp_hr_query"]);

    const out = await client.callTool("query", { q: "hello" });
    expect(out).toEqual({ text: "result-ok", uiPayload: undefined });

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

  it("enforces maxConcurrentRequests for overlapping tool calls", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);

    let resolveFirstCall: (() => void) | undefined;
    const firstCallSettled = new Promise<void>((resolve) => {
      resolveFirstCall = resolve;
    });
    let toolsCallCount = 0;

    const fetchMock = vi.fn(
      async (_url: string, init?: RequestInit): Promise<Response> => {
        const method = readRpcMethod(init);
        const id = readRpcId(init) ?? 0;
        switch (method) {
          case "initialize":
            return jsonRpcResponse(id, {
              protocolVersion: "2024-11-05",
              capabilities: { tools: {} },
              serverInfo: { name: "limited-mcp", version: "1.0.0" },
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
            toolsCallCount += 1;
            if (toolsCallCount === 1) {
              await firstCallSettled;
            }
            return jsonRpcResponse(id, {
              content: [{ type: "text", text: `result-${toolsCallCount}` }],
            });
          default:
            return new Response("unexpected", { status: 500 });
        }
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const gov = governanceWithPolicy(
      buildPolicy([
        httpApproval("limited", "https://limited.example.com/mcp", {
          maxConcurrentRequests: 1,
        }),
      ]),
    );
    const client = new McpClient(
      {
        id: "limited",
        transport: "http",
        url: "https://limited.example.com/mcp",
      },
      gov,
      new ToolRegistry(),
    );

    await client.connect();

    const firstCall = client.callTool("query", { q: "first" });
    await Promise.resolve();

    await expect(client.callTool("query", { q: "second" })).rejects.toThrow(
      /동시 요청 제한 초과 \(1\)/,
    );

    resolveFirstCall?.();
    await expect(firstCall).resolves.toEqual({
      text: "result-1",
      uiPayload: undefined,
    });
    await client.disconnect();
  });

  it("scrubs secrets from HTTP error bodies before surfacing them", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);

    const leakedToken = "sk-proj-secretvalue123456";
    const leakedApiKey = "topsecretapikey123456";
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit): Promise<Response> =>
        new Response(
          JSON.stringify({
            error: `Invalid token: ${leakedToken}`,
            next: `https://api.example.com/mcp?api_key=${leakedApiKey}`,
            header: `X-API-Key: ${leakedApiKey}`,
          }),
          {
            status: 401,
            headers: { "content-type": "application/json" },
          },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const gov = governanceWithPolicy(
      buildPolicy([httpApproval("secure", "https://secure.example.com/mcp")]),
    );
    const client = new McpClient(
      {
        id: "secure",
        transport: "http",
        url: "https://secure.example.com/mcp",
      },
      gov,
      new ToolRegistry(),
    );

    await expect(client.connect()).rejects.toThrow(/\[redacted]/i);
    await expect(client.connect()).rejects.not.toThrow(leakedToken);
    await expect(client.connect()).rejects.not.toThrow(leakedApiKey);
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

  it("allows a private-IP URL when allowPrivateNetworks is true and admin policy agrees", async () => {
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

    // Per-server approval opts the server into the private-network escape
    // hatch; the client config then additionally sets `allowPrivateNetworks`.
    // Both gates must be aligned.
    const gov = governanceWithPolicy(
      buildPolicy([
        httpApproval("local", "http://localhost:4040/mcp", {
          allowedUrls: ["localhost"],
          allowPrivateNetworks: true,
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

  it("rejects allowPrivateNetworks when admin policy has not authorised it", async () => {
    // Client config sets allowPrivateNetworks=true but governance approval
    // / globalRules have not opted in — governance must reject with a
    // message that names the `allowPrivateNetworks` gate so operators can
    // tell why the connection was refused.
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const gov = governanceWithPolicy(
      buildPolicy([
        httpApproval("rogue", "http://localhost:4040/mcp", {
          allowedUrls: ["localhost"],
        }),
      ]),
    );
    const client = new McpClient(
      {
        id: "rogue",
        transport: "http",
        url: "http://localhost:4040/mcp",
        allowPrivateNetworks: true,
      },
      gov,
      new ToolRegistry(),
    );

    await expect(client.connect()).rejects.toThrow(/allowPrivateNetworks/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(client.getState().status).toBe("error");
  });

  it("rolls back partially registered tools and overrides when registration throws", async () => {
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
              serverInfo: { name: "rollback-mcp", version: "1.0.0" },
            });
          case "notifications/initialized":
            return new Response(null, { status: 202 });
          case "tools/list":
            return jsonRpcResponse(id, {
              tools: [
                {
                  name: "first",
                  description: "First tool",
                  inputSchema: { type: "object", properties: {}, required: [] },
                },
                {
                  name: "second",
                  description: "Second tool",
                  inputSchema: { type: "object", properties: {}, required: [] },
                },
              ],
            });
          default:
            return new Response("unexpected", { status: 500 });
        }
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const gov = governanceWithPolicy(
      buildPolicy([
        httpApproval("rollback", "https://rollback.example.com/mcp", {
          toolPermissionMode: "strict",
        }),
      ]),
    );
    const registry = new ToolRegistry();
    const permissionManager = new PermissionManager("/nonexistent/permissions.json");
    const actualRegister = registry.register.bind(registry);
    let registerCalls = 0;
    vi.spyOn(registry, "register").mockImplementation((tool) => {
      registerCalls += 1;
      if (registerCalls === 2) {
        throw new Error("simulated registration race");
      }
      return actualRegister(tool);
    });

    const client = new McpClient(
      {
        id: "rollback",
        transport: "http",
        url: "https://rollback.example.com/mcp",
      },
      gov,
      registry,
      permissionManager,
    );

    await expect(client.connect()).rejects.toThrow("simulated registration race");
    expect(client.getState().registeredTools).toEqual([]);
    expect(registry.listAll()).toEqual([]);
    expect(
      (
        permissionManager as unknown as {
          toolModeOverrides: Map<string, "default" | "strict" | "auto">;
        }
      ).toolModeOverrides.size,
    ).toBe(0);
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

    const result = await client.callTool("read", { path: "/tmp/a.txt" });
    expect(result).toEqual({ text: "file-contents", uiPayload: undefined });

    await client.disconnect();
    expect(client.getState().status).toBe("disconnected");
  });

  it("SIGKILL fallback fires when the subprocess ignores SIGTERM", async () => {
    // Build a FakeChildProcess that REFUSES to exit on SIGTERM so we can
    // verify the SIGKILL fallback timer (mcp-client.ts close()) actually
    // reaches `proc.kill("SIGKILL")`. Previous regression: `this.process`
    // was nulled synchronously before the 3-second timer fired.
    vi.useFakeTimers();
    try {
      const killCalls: string[] = [];
      class StubbornChild extends EventEmitter {
        stdout = new PassThrough();
        stderr = new PassThrough();
        stdin = {
          writable: true,
          write: (_chunk: string) => true,
          end: () => {
            this.stdin.writable = false;
          },
        };
        exitCode: number | null = null;

        kill(signal?: string): boolean {
          killCalls.push(signal ?? "SIGTERM");
          // Do NOT emit exit — simulate a stuck child.
          return true;
        }
      }
      const fake = new StubbornChild();
      // Respond to the initial handshake so connect() can succeed. We stuff
      // framed JSON-RPC responses into `stdout` manually.
      spawnMock.mockReturnValueOnce(fake);

      const gov = governanceWithPolicy(
        buildPolicy([stdioApproval("stubborn", "lvis-mcp-stubborn")]),
      );
      const client = new McpClient(
        {
          id: "stubborn",
          transport: "stdio",
          command: "lvis-mcp-stubborn",
        },
        gov,
        new ToolRegistry(),
      );

      // connect() pends on `initialize` — resolve it asynchronously.
      const connectPromise = client.connect();
      // Wait one microtask for the send() to hit stdin.write, then feed
      // canned responses back.
      await Promise.resolve();
      const reply = (id: number, result: unknown): void => {
        const payload = JSON.stringify({ jsonrpc: "2.0", id, result });
        const frame = `Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`;
        fake.stdout.write(frame);
      };
      // initialize → id 1, tools/list → id 2
      reply(1, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "stubborn", version: "0.0.1" },
      });
      // Allow the pending promise to resolve before we advance to tools/list.
      await vi.advanceTimersByTimeAsync(0);
      reply(2, { tools: [] });
      await vi.advanceTimersByTimeAsync(0);
      await connectPromise;

      // Now ask it to disconnect — triggers StdioTransport.close().
      const disconnectPromise = client.disconnect();
      // SIGTERM should have been sent synchronously.
      expect(killCalls).toContain("SIGTERM");
      // Advance time past the 3-second SIGKILL fallback.
      await vi.advanceTimersByTimeAsync(3_500);
      expect(killCalls).toContain("SIGKILL");

      // disconnect() resolves regardless — simulate the process finally exiting.
      fake.exitCode = 0;
      fake.emit("exit", 0, "SIGKILL");
      await disconnectPromise;
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── 6. CRLF header rejection at governance ────────────────

describe("McpGovernance — header validation", () => {
  it("rejects http config whose headers contain CR/LF", async () => {
    const gov = governanceWithPolicy(
      buildPolicy([httpApproval("inj", "https://good.example.com/mcp")]),
    );
    const result = gov.validateServer({
      id: "inj",
      transport: "http",
      url: "https://good.example.com/mcp",
      headers: {
        "x-legit": "ok",
        "x-injected": "value\r\nX-Smuggled: attacker",
      },
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.layer).toBe(1);
      expect(result.reason).toMatch(/CR\/LF/);
    }
  });

  it("rejects http config whose header values contain raw control bytes", async () => {
    const gov = governanceWithPolicy(
      buildPolicy([httpApproval("ctl", "https://good.example.com/mcp")]),
    );
    const result = gov.validateServer({
      id: "ctl",
      transport: "http",
      url: "https://good.example.com/mcp",
      headers: { "x-ctrl": "bad\x01value" },
    });
    expect(result.valid).toBe(false);
  });

  it("accepts http config with plain, well-formed headers", async () => {
    const gov = governanceWithPolicy(
      buildPolicy([httpApproval("ok", "https://good.example.com/mcp")]),
    );
    const result = gov.validateServer({
      id: "ok",
      transport: "http",
      url: "https://good.example.com/mcp",
      headers: { "x-tenant": "lge", authorization: "Bearer redacted" },
    });
    expect(result.valid).toBe(true);
  });
});

// ─── 7. DNS rebinding on send() ─────────────────────────────

describe("HttpTransport — per-request DNS rebinding defense", () => {
  it("rejects a send() after DNS flips to a private IP mid-session", async () => {
    // First lookup (during open()) returns a public IP → connect succeeds.
    // Subsequent lookups (during send()) return a private IP → fetch must
    // never be issued on the rebinding hop.
    lookupMock.mockImplementation(async () => {
      if (lookupMock.mock.calls.length === 1) {
        return [{ address: "93.184.216.34", family: 4 }];
      }
      return [{ address: "169.254.169.254", family: 4 }];
    });

    let fetchCallCount = 0;
    const fetchMock = vi.fn(
      async (_url: string, init?: RequestInit): Promise<Response> => {
        fetchCallCount += 1;
        const method = readRpcMethod(init);
        const id = readRpcId(init) ?? 0;
        if (method === "initialize") {
          return jsonRpcResponse(id, {
            protocolVersion: "2024-11-05",
            capabilities: {},
            serverInfo: { name: "rebind", version: "0.0.1" },
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
      buildPolicy([httpApproval("rebind", "https://rebind.example.com/mcp")]),
    );
    const client = new McpClient(
      {
        id: "rebind",
        transport: "http",
        url: "https://rebind.example.com/mcp",
      },
      gov,
      new ToolRegistry(),
    );

    // Connect expects initialize/tools-list to succeed; those also go through
    // `send()` which re-validates DNS. The second lookup (send path) is the
    // rebinding attempt and should reject BEFORE fetch is called for that
    // request. Capture the outcome through the thrown error.
    await expect(client.connect()).rejects.toThrow(/network guard:/);
    // The first fetch (initialize) should never have fired because DNS
    // rebinding is caught on every hop now — fetchPublicHttpResponse calls
    // ensurePublicHttpUrl before each hop.
    expect(fetchCallCount).toBe(0);
  });
});

// ─── 8. SSE stream-death transitions transport to dead ──────

describe("HttpTransport — SSE stream death", () => {
  it("marks transport dead and rejects pending requests when SSE body errors out", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);

    // First call: initialize — normal JSON response so the handshake finishes.
    // Second call (notifications/initialized): 202, third (tools/list): JSON.
    // Fourth call (tools/call): SSE stream that errors mid-flight.
    const fetchMock = vi.fn(
      async (_url: string, init?: RequestInit): Promise<Response> => {
        const method = readRpcMethod(init);
        const id = readRpcId(init) ?? 0;
        if (method === "initialize") {
          return jsonRpcResponse(id, {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "dying", version: "0.1.0" },
          });
        }
        if (method === "notifications/initialized") {
          return new Response(null, { status: 202 });
        }
        if (method === "tools/list") {
          return jsonRpcResponse(id, {
            tools: [
              {
                name: "stream",
                description: "streaming tool",
                inputSchema: {
                  type: "object",
                  properties: {},
                },
              },
            ],
          });
        }
        // tools/call → SSE stream that throws on read.
        const failingStream = new ReadableStream<Uint8Array>({
          start(controller) {
            // Queue an initial partial event, then error the stream.
            const enc = new TextEncoder();
            controller.enqueue(enc.encode("event: message\ndata: {\"jsonrpc\""));
            controller.error(new Error("connection reset by peer"));
          },
        });
        return new Response(failingStream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const gov = governanceWithPolicy(
      buildPolicy([httpApproval("dying", "https://dying.example.com/mcp")]),
    );
    const client = new McpClient(
      {
        id: "dying",
        transport: "http",
        url: "https://dying.example.com/mcp",
      },
      gov,
      new ToolRegistry(),
    );

    await client.connect();
    expect(client.getState().status).toBe("connected");

    // Fire the streaming tool call. The SSE body errors during read →
    // transport should transition to dead and the pending tools/call should
    // reject with the stream-termination reason (not wait for timeout).
    await expect(client.callTool("stream", {})).rejects.toThrow();
    // Transport is now reported dead by the client state machine.
    expect(client.getState().status).toBe("error");
  });
});

// ─── 9. Timeout path honours AbortController ──────────────

describe("HttpTransport — timeout path", () => {
  it("aborts the underlying fetch when the request times out", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);

    vi.useFakeTimers();
    try {
      // Capture the signal passed to fetch so we can assert abort propagated.
      let capturedSignal: AbortSignal | undefined;
      const fetchMock = vi.fn(
        (_url: string, init?: RequestInit): Promise<Response> => {
          capturedSignal = init?.signal ?? undefined;
          // Never resolve — only an abort can terminate this request.
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new Error("AbortError"));
            });
          });
        },
      );
      vi.stubGlobal("fetch", fetchMock);

      const gov = governanceWithPolicy(
        buildPolicy([httpApproval("slow", "https://slow.example.com/mcp")]),
      );
      const client = new McpClient(
        {
          id: "slow",
          transport: "http",
          url: "https://slow.example.com/mcp",
        },
        gov,
        new ToolRegistry(),
      );

      // Fire connect() but do NOT await yet — it will hang on initialize.
      const connectPromise = client.connect().catch((e) => e);
      // Let open() + initial send() fire.
      await vi.advanceTimersByTimeAsync(0);
      expect(capturedSignal).toBeDefined();
      expect(capturedSignal?.aborted).toBe(false);
      // Advance past the default 30s request timeout so the abort timer fires.
      await vi.advanceTimersByTimeAsync(31_000);
      // The AbortController must have propagated to the fetch signal.
      expect(capturedSignal?.aborted).toBe(true);
      // And the connect() promise resolves (to rejection) because the
      // transport now surfaces a fetch failure.
      const err = await connectPromise;
      expect(err).toBeInstanceOf(Error);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("McpClient buffered response safety", () => {
  it("caps unmatched buffered responses to a bounded size", () => {
    const gov = governanceWithPolicy(
      buildPolicy([httpApproval("buffered", "https://buffered.example.com/mcp")]),
    );
    const client = new McpClient(
      {
        id: "buffered",
        transport: "http",
        url: "https://buffered.example.com/mcp",
      },
      gov,
      new ToolRegistry(),
    );

    for (let id = 1; id <= 256; id += 1) {
      (client as unknown as {
        handleResponse: (response: { jsonrpc: "2.0"; id: number; result: unknown }) => void;
      }).handleResponse({
        jsonrpc: "2.0",
        id,
        result: { ok: true },
      });
    }

    const buffered = (client as unknown as { bufferedResponses: Map<number, unknown> }).bufferedResponses;
    expect(buffered.size).toBeLessThanOrEqual(128);
    expect(buffered.has(1)).toBe(false);
    expect(buffered.has(256)).toBe(true);
  });
});
