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
vi.mock("../../main/uv-runtime.js", () => ({
  resolveBundledUvBinaryPath: vi.fn(() => "/test-runtime/uv"),
}));

// Module imports must come AFTER the mocks above.
import { McpClient } from "../mcp-client.js";
import { ToolRegistry } from "../../tools/registry.js";
import {
  MCP_RESOURCE_MAX_CHARS,
  MCP_RESOURCE_MAX_PER_SERVER,
} from "../../shared/mcp-resource-bounds.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import type {
  McpGovernancePolicy,
  McpHttpServerConfig,
  McpServerConfig,
  McpStdioServerConfig,
} from "../types.js";
import {
  governanceWithPolicy,
  stdioApproval,
  buildPolicy,
  FakeChildProcess,
} from "./test-helpers.js";

// ─── Helpers ────────────────────────────────────────────────

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
    connectionTimeoutMs: 5_000,
    maxConcurrentRequests: 4,
    ...overrides,
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

/**
 * #1230 — golden `server/discover` result for the RC stateless handshake. The
 * client now probes `server/discover` first; these mock servers answer it as
 * RC servers (so the connect path runs in "rc" mode, not the dual-era legacy
 * fallback). Tool-call mocks below omit `resultType` ⇒ treated as "complete".
 */
const RC_DISCOVER_RESULT = {
  resultType: "complete",
  ttlMs: 0,
  cacheScope: "public" as const,
  supportedVersions: ["2026-07-28"],
  capabilities: { tools: {} },
  serverInfo: { name: "rc-mcp", version: "1.0.0" },
};

function jsonRpcErrorResponse(id: number, code: number, message: string): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function readRpcParams(init: RequestInit | undefined): Record<string, unknown> | undefined {
  if (!init?.body) return undefined;
  try {
    return JSON.parse(String(init.body)).params as Record<string, unknown>;
  } catch {
    return undefined;
  }
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
      headers: { "x-tenant": "example" },
    };
    expect(cfg.transport).toBe("http");
    if (cfg.transport === "http") {
      expect(cfg.url).toBe("https://api.example.com/mcp");
      expect(cfg.headers?.["x-tenant"]).toBe("example");
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
          case "server/discover":
            return jsonRpcResponse(id, RC_DISCOVER_RESULT);
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

    // RC round-trip (#1230): server/discover → tools/list → tools/call. The
    // stateless RC handshake has no initialize / notifications/initialized.
    const methods = fetchMock.mock.calls
      .map(([, init]) => readRpcMethod(init as RequestInit))
      .filter(Boolean);
    expect(methods).toEqual([
      "server/discover",
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
          case "server/discover":
            return jsonRpcResponse(id, RC_DISCOVER_RESULT);
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

    await expect(client.connect()).rejects.toThrow(/\[REDACTED:/i);
    await expect(client.connect()).rejects.not.toThrow(leakedToken);
    await expect(client.connect()).rejects.not.toThrow(leakedApiKey);
  });

  it("sends apiKey through a configured custom HTTP header", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);

    const fetchMock = vi.fn(
      async (_url: string, init?: RequestInit): Promise<Response> => {
        const headers = new Headers(init?.headers);
        expect(headers.get("x-browser-use-api-key")).toBe("browser-use-secret");
        expect(headers.get("authorization")).toBeNull();
        const method = readRpcMethod(init);
        const id = readRpcId(init) ?? 0;
        if (method === "server/discover") {
          return jsonRpcResponse(id, RC_DISCOVER_RESULT);
        }
        if (method === "initialize") {
          return jsonRpcResponse(id, {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "browser-use", version: "1.0.0" },
          });
        }
        if (method === "notifications/initialized") {
          return new Response(null, { status: 202 });
        }
        if (method === "tools/list") {
          return jsonRpcResponse(id, { tools: [] });
        }
        return new Response("unexpected", { status: 500 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const gov = governanceWithPolicy(
      buildPolicy([
        httpApproval("browser-use", "https://api.browser-use.com/v3/mcp", {
          requiredAuth: "api-key",
          apiKeyHeader: "x-browser-use-api-key",
        }),
      ]),
    );
    const client = new McpClient(
      {
        id: "browser-use",
        transport: "http",
        url: "https://api.browser-use.com/v3/mcp",
        auth: "api-key",
        apiKey: "browser-use-secret",
        apiKeyHeader: "x-browser-use-api-key",
      },
      gov,
      new ToolRegistry(),
    );

    await client.connect();
    expect(client.getState().status).toBe("connected");
    await client.disconnect();
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
        if (method === "server/discover") {
          return jsonRpcResponse(id, RC_DISCOVER_RESULT);
        }
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
          case "server/discover":
            return jsonRpcResponse(id, RC_DISCOVER_RESULT);
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
        if (method === "server/discover") {
          return jsonRpcResponse(id, RC_DISCOVER_RESULT);
        }
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

describe("StdioTransport — regression", () => {
  it("connects via subprocess with Content-Length framed JSON-RPC", async () => {
    const fake = new FakeChildProcess();
    fake.responses = {
      "server/discover": () => RC_DISCOVER_RESULT,
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

  it("injects apiKey into the configured stdio environment variable", async () => {
    const fake = new FakeChildProcess();
    fake.responses = {
      "server/discover": () => RC_DISCOVER_RESULT,
      initialize: (id) => ({
        id,
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "browser-use", version: "0.12.6" },
      }),
      "tools/list": () => ({ tools: [] }),
    };
    spawnMock.mockReturnValueOnce(fake);

    const gov = governanceWithPolicy(
      buildPolicy([
        stdioApproval("browser-use", "uvx", {
          requiredAuth: "api-key",
          apiKeyEnv: "OPENAI_API_KEY",
        }),
      ]),
    );
    const client = new McpClient(
      {
        id: "browser-use",
        transport: "stdio",
        command: "uvx",
        args: ["--from", "browser-use[cli]==0.12.6", "browser-use", "--mcp"],
        auth: "api-key",
        apiKey: "openai-secret",
        apiKeyEnv: "OPENAI_API_KEY",
      },
      gov,
      new ToolRegistry(),
    );

    await client.connect();
    expect(spawnMock).toHaveBeenCalledWith(
      "/test-runtime/uv",
      ["tool", "run", "--from", "browser-use[cli]==0.12.6", "browser-use", "--mcp"],
      expect.objectContaining({
        env: expect.objectContaining({
          OPENAI_API_KEY: "openai-secret",
        }),
      }),
    );
    await client.disconnect();
  });

  it("stdio — apiKey does NOT leak into environment when apiKeyEnv is absent (HIGH-3/HIGH-4)", async () => {
    const fake = new FakeChildProcess();
    fake.responses = {
      "server/discover": () => RC_DISCOVER_RESULT,
      initialize: (id) => ({
        id,
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "no-env-key", version: "1.0" },
      }),
      "tools/list": () => ({ tools: [] }),
    };
    spawnMock.mockReturnValueOnce(fake);

    const gov = governanceWithPolicy(
      buildPolicy([stdioApproval("no-env-key", "uvx")]),
    );
    const client = new McpClient(
      {
        id: "no-env-key",
        transport: "stdio",
        command: "uvx",
        auth: "none",
        apiKey: "secret-should-not-appear",
        // intentionally no apiKeyEnv — apiKey must NOT appear in the spawn env
      } as McpStdioServerConfig,
      gov,
      new ToolRegistry(),
    );

    await client.connect();
    const spawnEnv = (spawnMock.mock.calls[0]?.[2] as { env?: Record<string, unknown> })?.env ?? {};
    // apiKey value must not appear in any env-var value
    const envValues = Object.values(spawnEnv).map(String);
    expect(envValues).not.toContain("secret-should-not-appear");
    await client.disconnect();
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
        signalCode: NodeJS.Signals | null = null;

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

  it("still terminates when closing stdin throws", async () => {
    vi.useFakeTimers();
    try {
      const killCalls: string[] = [];
      class BrokenStdinChild extends EventEmitter {
        stdout = new PassThrough();
        stderr = new PassThrough();
        stdin = {
          writable: true,
          write: (_chunk: string) => true,
          end: () => {
            throw new Error("stdin already destroyed");
          },
        };
        exitCode: number | null = null;
        signalCode: NodeJS.Signals | null = null;
        kill(signal?: string): boolean {
          killCalls.push(signal ?? "SIGTERM");
          return true;
        }
      }
      const fake = new BrokenStdinChild();
      spawnMock.mockReturnValueOnce(fake);
      const client = new McpClient(
        { id: "broken-stdin", transport: "stdio", command: "lvis-mcp-broken-stdin" },
        governanceWithPolicy(buildPolicy([stdioApproval("broken-stdin", "lvis-mcp-broken-stdin")])),
        new ToolRegistry(),
      );

      const connectPromise = client.connect();
      await Promise.resolve();
      const reply = (id: number, result: unknown): void => {
        const payload = JSON.stringify({ jsonrpc: "2.0", id, result });
        fake.stdout.write(`Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`);
      };
      reply(1, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "broken-stdin", version: "0.0.1" },
      });
      await vi.advanceTimersByTimeAsync(0);
      reply(2, { tools: [] });
      await vi.advanceTimersByTimeAsync(0);
      await connectPromise;

      await client.disconnect();
      expect(killCalls).toContain("SIGTERM");
      await vi.advanceTimersByTimeAsync(3_500);
      expect(killCalls).toContain("SIGKILL");
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
      headers: { "x-tenant": "example", authorization: "Bearer redacted" },
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
        if (method === "server/discover") {
          return jsonRpcResponse(id, RC_DISCOVER_RESULT);
        }
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
        if (method === "server/discover") {
          return jsonRpcResponse(id, RC_DISCOVER_RESULT);
        }
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

describe("McpClient — 2026-07-28 RC stateless handshake (#1230)", () => {
  function rcHttpClient(
    id: string,
    responder: (method: string | undefined, rid: number) => Response,
    inputResolver?: (rid: string, request: Record<string, unknown>) => Promise<unknown>,
    capabilityProvider?: () => { elicitation?: Record<string, unknown>; extensions?: Record<string, unknown> },
  ) {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const url = `https://api.example.com/${id}/mcp`;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit): Promise<Response> =>
      responder(readRpcMethod(init), readRpcId(init) ?? 0),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new McpClient(
      { id, transport: "http", url },
      governanceWithPolicy(buildPolicy([httpApproval(id, url)])),
      new ToolRegistry(),
      undefined,
      undefined,
      inputResolver,
      capabilityProvider,
    );
    return { client, fetchMock };
  }

  it("stamps the three reserved _meta keys + RC protocol version on every request", async () => {
    const { client, fetchMock } = rcHttpClient("rc", (method, id) => {
      if (method === "server/discover") return jsonRpcResponse(id, RC_DISCOVER_RESULT);
      if (method === "tools/list") return jsonRpcResponse(id, { tools: [] });
      return new Response("unexpected", { status: 500 });
    });

    await client.connect();
    expect(client.getState().status).toBe("connected");

    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
    for (const [, init] of fetchMock.mock.calls) {
      const meta = readRpcParams(init as RequestInit)?._meta as Record<string, unknown> | undefined;
      expect(meta?.["io.modelcontextprotocol/protocolVersion"]).toBe("2026-07-28");
      expect(meta?.["io.modelcontextprotocol/clientInfo"]).toMatchObject({ name: "lvis-app" });
      expect(meta?.["io.modelcontextprotocol/clientCapabilities"]).toMatchObject({ elicitation: {} });
    }
    await client.disconnect();
  });

  it("retries ONCE after HeaderMismatch by refreshing tools/list and rebuilding the mirrors", async () => {
    // The server rotates its x-mcp-header name between discovery and the call.
    const toolWithHeader = (headerName: string) => ({
      name: "q",
      description: "q",
      inputSchema: {
        type: "object",
        properties: { region: { type: "string", "x-mcp-header": headerName } },
      },
    });
    let listCalls = 0;
    let callCalls = 0;
    const { client, fetchMock } = rcHttpClient("hm", (method, id) => {
      if (method === "server/discover") return jsonRpcResponse(id, RC_DISCOVER_RESULT);
      if (method === "tools/list") {
        listCalls += 1;
        return jsonRpcResponse(id, {
          tools: [toolWithHeader(listCalls === 1 ? "Region" : "Zone")],
        });
      }
      if (method === "tools/call") {
        callCalls += 1;
        if (callCalls === 1) return jsonRpcErrorResponse(id, -32020, "Header mismatch");
        return jsonRpcResponse(id, {
          resultType: "complete",
          content: [{ type: "text", text: "ok" }],
        });
      }
      return new Response("unexpected", { status: 500 });
    });

    await client.connect();
    const result = await client.callTool("q", { region: "us-west1" });
    expect(result.text).toBe("ok");
    // One refresh between the two calls, and the SECOND call mirrors the
    // renamed header from the refreshed schema.
    expect(listCalls).toBe(2);
    expect(callCalls).toBe(2);
    const toolCallInits = fetchMock.mock.calls.filter(
      ([, i]) => readRpcMethod(i as RequestInit) === "tools/call",
    );
    const secondCall = toolCallInits[toolCallInits.length - 1]?.[1];
    const headers = (secondCall as RequestInit | undefined)?.headers as
      | Record<string, string>
      | undefined;
    expect(headers?.["mcp-param-zone"]).toBe("us-west1");
    expect(headers?.["mcp-param-region"]).toBeUndefined();
    await client.disconnect();
  });

  it("propagates a second HeaderMismatch instead of retrying again", async () => {
    const TOOL = {
      name: "q",
      description: "q",
      inputSchema: {
        type: "object",
        properties: { region: { type: "string", "x-mcp-header": "Region" } },
      },
    };
    let callCalls = 0;
    const { client } = rcHttpClient("hm2", (method, id) => {
      if (method === "server/discover") return jsonRpcResponse(id, RC_DISCOVER_RESULT);
      if (method === "tools/list") return jsonRpcResponse(id, { tools: [TOOL] });
      if (method === "tools/call") {
        callCalls += 1;
        return jsonRpcErrorResponse(id, -32020, "Header mismatch");
      }
      return new Response("unexpected", { status: 500 });
    });

    await client.connect();
    await expect(client.callTool("q", { region: "x" })).rejects.toThrow(/-32020|Header mismatch/);
    expect(callCalls).toBe(2);
    await client.disconnect();
  });

  it("re-discovers on snapshot expiry and honors the server's CURRENT advertisement", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      let discoverCalls = 0;
      const { client } = rcHttpClient("snap", (method, id) => {
        if (method === "server/discover") {
          discoverCalls += 1;
          return jsonRpcResponse(id, {
            ...RC_DISCOVER_RESULT,
            ttlMs: 1, // clamped to the 30s floor
            // Apps advertised only from the SECOND discover on.
            capabilities:
              discoverCalls === 1
                ? { tools: {} }
                : { tools: {}, extensions: { "io.modelcontextprotocol/ui": {} } },
          });
        }
        if (method === "tools/list") return jsonRpcResponse(id, { tools: [] });
        if (method === "tools/call")
          return jsonRpcResponse(id, {
            resultType: "complete",
            content: [{ type: "text", text: "ok" }],
            _meta: { ui: { resourceUri: "ui://snap/card.html" } },
          });
        return new Response("unexpected", { status: 500 });
      });

      await client.connect();
      // Fresh snapshot, no Apps advertised → the ui payload is dropped.
      expect((await client.callTool("t", {})).uiPayload).toBeUndefined();
      expect(discoverCalls).toBe(1);

      vi.setSystemTime(Date.now() + 31_000);
      // Expired → single-flight re-discover; the NEW advertisement wins.
      const result = await client.callTool("t", {});
      expect(discoverCalls).toBe(2);
      expect(result.uiPayload?.resourceUri).toBe("ui://snap/card.html");
      await client.disconnect();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails the Apps gate closed when the snapshot is expired and refresh fails", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      let discoverCalls = 0;
      const { client } = rcHttpClient("snapfail", (method, id) => {
        if (method === "server/discover") {
          discoverCalls += 1;
          if (discoverCalls > 1) return new Response("boom", { status: 500 });
          return jsonRpcResponse(id, {
            ...RC_DISCOVER_RESULT,
            capabilities: { tools: {}, extensions: { "io.modelcontextprotocol/ui": {} } },
          });
        }
        if (method === "tools/list") return jsonRpcResponse(id, { tools: [] });
        if (method === "tools/call")
          return jsonRpcResponse(id, {
            resultType: "complete",
            content: [{ type: "text", text: "ok" }],
            _meta: { ui: { resourceUri: "ui://snapfail/card.html" } },
          });
        return new Response("unexpected", { status: 500 });
      });

      await client.connect();
      expect((await client.callTool("t", {})).uiPayload?.resourceUri).toBe(
        "ui://snapfail/card.html",
      );

      vi.setSystemTime(Date.now() + 31_000);
      // Security gate: a stale-and-unrefreshable advertisement is NOT honored —
      // the card is dropped, but the text result still flows.
      const result = await client.callTool("t", {});
      expect(result.text).toBe("ok");
      expect(result.uiPayload).toBeUndefined();
      await client.disconnect();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shares one in-flight refresh across concurrent expired reads (single-flight)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      let discoverCalls = 0;
      const { client } = rcHttpClient("snapsf", (method, id) => {
        if (method === "server/discover") {
          discoverCalls += 1;
          return jsonRpcResponse(id, {
            ...RC_DISCOVER_RESULT,
            capabilities: { tools: {}, extensions: { "io.modelcontextprotocol/ui": {} } },
          });
        }
        if (method === "tools/list") return jsonRpcResponse(id, { tools: [] });
        if (method === "tools/call")
          return jsonRpcResponse(id, {
            resultType: "complete",
            content: [{ type: "text", text: "ok" }],
          });
        return new Response("unexpected", { status: 500 });
      });

      await client.connect();
      vi.setSystemTime(Date.now() + 31_000);
      await Promise.all([client.callTool("t", {}), client.callTool("t", {})]);
      // Initial discover + exactly ONE shared refresh, not one per read.
      expect(discoverCalls).toBe(2);
      await client.disconnect();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stamps the Streamable HTTP request-metadata headers on every POST (final spec)", async () => {
    const TOOL = {
      name: "get_weather",
      description: "weather",
      inputSchema: {
        type: "object",
        properties: {
          region: { type: "string", "x-mcp-header": "Region" },
          query: { type: "string" },
        },
      },
    };
    const { client, fetchMock } = rcHttpClient("hdr", (method, id) => {
      if (method === "server/discover") return jsonRpcResponse(id, RC_DISCOVER_RESULT);
      if (method === "tools/list") return jsonRpcResponse(id, { tools: [TOOL] });
      if (method === "tools/call")
        return jsonRpcResponse(id, { resultType: "complete", content: [{ type: "text", text: "ok" }] });
      return new Response("unexpected", { status: 500 });
    });

    await client.connect();
    // `callTool` takes the WIRE tool name (the adapter's execute callback passes
    // `schema.name`, not the namespaced registry name).
    await client.callTool("get_weather", { region: "us-west1", query: "rain" });

    const headerOf = (init: unknown, name: string) =>
      ((init as RequestInit | undefined)?.headers as Record<string, string> | undefined)?.[name];
    for (const [, init] of fetchMock.mock.calls) {
      const method = readRpcMethod(init as RequestInit);
      if (!method) continue;
      // Mcp-Method mirrors the body's method; the version header mirrors _meta.
      expect(headerOf(init, "mcp-method")).toBe(method);
      expect(headerOf(init, "mcp-protocol-version")).toBe("2026-07-28");
    }
    const callInit = fetchMock.mock.calls.find(
      ([, i]) => readRpcMethod(i as RequestInit) === "tools/call",
    )?.[1];
    // Mcp-Name mirrors params.name; the x-mcp-header-designated argument rides
    // as an Mcp-Param-* header.
    expect(headerOf(callInit, "mcp-name")).toBe("get_weather");
    expect(headerOf(callInit, "mcp-param-region")).toBe("us-west1");
    expect(headerOf(callInit, "mcp-param-query")).toBeUndefined();
    await client.disconnect();
  });

  it("excludes a tool whose x-mcp-header annotations are invalid, keeping the rest", async () => {
    const BAD = {
      name: "bad_tool",
      description: "malformed annotation",
      inputSchema: {
        type: "object",
        properties: { n: { type: "number", "x-mcp-header": "N" } },
      },
    };
    const GOOD = {
      name: "good_tool",
      description: "fine",
      inputSchema: { type: "object", properties: { q: { type: "string" } } },
    };
    const { client } = rcHttpClient("xh", (method, id) => {
      if (method === "server/discover") return jsonRpcResponse(id, RC_DISCOVER_RESULT);
      if (method === "tools/list") return jsonRpcResponse(id, { tools: [BAD, GOOD] });
      return new Response("unexpected", { status: 500 });
    });

    await client.connect();
    // Failure isolation (spec MUST): only the malformed tool is rejected.
    expect(client.getState().registeredTools).toEqual(["mcp_xh_good_tool"]);
    await client.disconnect();
  });

  it("falls back to the legacy initialize handshake when server/discover answers -32601 (dual-era exception)", async () => {
    const { client, fetchMock } = rcHttpClient("legacy", (method, id) => {
      if (method === "server/discover") return jsonRpcErrorResponse(id, -32601, "Method not found");
      if (method === "initialize")
        return jsonRpcResponse(id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "old", version: "0.9" } });
      if (method === "notifications/initialized") return new Response(null, { status: 202 });
      if (method === "tools/list") return jsonRpcResponse(id, { tools: [] });
      return new Response("unexpected", { status: 500 });
    });

    await client.connect();
    expect(client.getState().status).toBe("connected");

    const methods = fetchMock.mock.calls.map(([, i]) => readRpcMethod(i as RequestInit)).filter(Boolean);
    expect(methods).toEqual(["server/discover", "initialize", "notifications/initialized", "tools/list"]);
    // legacy mode strips the RC _meta from the request envelope.
    const initInit = fetchMock.mock.calls.find(([, i]) => readRpcMethod(i as RequestInit) === "initialize")?.[1];
    expect(readRpcParams(initInit as RequestInit)?._meta).toBeUndefined();
    await client.disconnect();
  });

  it("falls back to initialize when a session-enforcing legacy server answers the probe with a bare 400", async () => {
    // Pre-final Streamable HTTP servers reject ANY request before initialize
    // with a non-JSON-RPC 400 ("Bad Request: no session") — never -32601. The
    // final spec's detection rule: 4xx + non-modern body ⇒ legacy server.
    const SESSION = "sess-legacy-1";
    const { client, fetchMock } = rcHttpClient("sess", (method, id) => {
      if (method === "server/discover")
        return new Response("Bad Request: Server not initialized", { status: 400 });
      if (method === "initialize")
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: "legacy-sess", version: "1.2" },
            },
          }),
          { status: 200, headers: { "content-type": "application/json", "mcp-session-id": SESSION } },
        );
      if (method === "notifications/initialized") return new Response(null, { status: 202 });
      if (method === "tools/list") return jsonRpcResponse(id, { tools: [] });
      return new Response("unexpected", { status: 500 });
    });

    await client.connect();
    expect(client.getState().status).toBe("connected");

    // The initialize request proposes the newest legacy revision we implement,
    // and every request AFTER the server minted the session echoes it.
    const initInit = fetchMock.mock.calls.find(
      ([, i]) => readRpcMethod(i as RequestInit) === "initialize",
    )?.[1];
    expect(readRpcParams(initInit as RequestInit)?.protocolVersion).toBe("2025-03-26");
    const listInit = fetchMock.mock.calls.find(
      ([, i]) => readRpcMethod(i as RequestInit) === "tools/list",
    )?.[1];
    expect(
      ((listInit as RequestInit | undefined)?.headers as Record<string, string> | undefined)?.[
        "mcp-session-id"
      ],
    ).toBe(SESSION);
    await client.disconnect();
  });

  it("does NOT fall back when the 400 body is a recognized modern JSON-RPC error", async () => {
    const { client } = rcHttpClient("modern400", (method, id) => {
      if (method === "server/discover")
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: { code: -32022, message: "unsupported", data: { supported: ["2026-01-01"] } },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      return new Response("unexpected", { status: 500 });
    });

    // A modern server rejecting the probe is a REAL failure — no initialize.
    await expect(client.connect()).rejects.toThrow(/unsupported/);
  });

  it("refuses a legacy counter-version outside the supported set", async () => {
    const { client } = rcHttpClient("oldold", (method, id) => {
      if (method === "server/discover")
        return new Response("Not Found", { status: 404 });
      if (method === "initialize")
        return jsonRpcResponse(id, {
          protocolVersion: "2019-01-01",
          capabilities: {},
          serverInfo: { name: "ancient", version: "0.1" },
        });
      return new Response("unexpected", { status: 500 });
    });

    await expect(client.connect()).rejects.toThrow(/unsupported protocol '2019-01-01'/);
  });

  it("routes an SSE-delivered tools/list_changed notification into a debounced tools refresh", async () => {
    const TOOL_V1 = {
      name: "alpha",
      description: "v1",
      inputSchema: { type: "object", properties: {} },
    };
    const TOOL_V2 = {
      name: "beta",
      description: "v2",
      inputSchema: { type: "object", properties: {} },
    };
    let listCalls = 0;
    const { client } = rcHttpClient("lc", (method, id) => {
      if (method === "server/discover")
        return jsonRpcResponse(id, {
          ...RC_DISCOVER_RESULT,
          capabilities: { tools: { listChanged: true } },
        });
      if (method === "tools/list") {
        listCalls += 1;
        return jsonRpcResponse(id, { tools: listCalls === 1 ? [TOOL_V1] : [TOOL_V2] });
      }
      if (method === "tools/call")
        // Request-scoped SSE stream: a list_changed notification precedes the
        // final response — previously both were silently dropped.
        return sseResponse([
          `data: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n`,
          `data: {"jsonrpc":"2.0","id":${id},"result":{"resultType":"complete","content":[{"type":"text","text":"ok"}]}}\n\n`,
        ]);
      return new Response("unexpected", { status: 500 });
    });

    await client.connect();
    expect(client.getState().registeredTools).toEqual(["mcp_lc_alpha"]);

    await client.callTool("alpha", {});
    // Debounce (500ms) + refresh round-trip.
    await new Promise((resolve) => setTimeout(resolve, 900));

    expect(listCalls).toBe(2);
    expect(client.getState().registeredTools).toEqual(["mcp_lc_beta"]);
    await client.disconnect();
  }, 10000);

  it("keeps the previous registration when a list_changed-driven refresh fails", async () => {
    const TOOL_V1 = {
      name: "alpha",
      description: "v1",
      inputSchema: { type: "object", properties: {} },
    };
    let listCalls = 0;
    const { client } = rcHttpClient("lcf", (method, id) => {
      if (method === "server/discover") return jsonRpcResponse(id, RC_DISCOVER_RESULT);
      if (method === "tools/list") {
        listCalls += 1;
        if (listCalls === 1) return jsonRpcResponse(id, { tools: [TOOL_V1] });
        return new Response("boom", { status: 500 });
      }
      if (method === "tools/call")
        return sseResponse([
          `data: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n`,
          `data: {"jsonrpc":"2.0","id":${id},"result":{"resultType":"complete","content":[{"type":"text","text":"ok"}]}}\n\n`,
        ]);
      return new Response("unexpected", { status: 500 });
    });

    await client.connect();
    await client.callTool("alpha", {});
    await new Promise((resolve) => setTimeout(resolve, 900));

    // The notification is advisory: a failed re-fetch must not tear down
    // working tools.
    expect(listCalls).toBe(2);
    expect(client.getState().registeredTools).toEqual(["mcp_lcf_alpha"]);
    await client.disconnect();
  }, 10000);

  it("fails closed on input_required when no MRTR resolver is wired (No-Fallback)", async () => {
    const { client } = rcHttpClient("ir", (method, id) => {
      if (method === "server/discover") return jsonRpcResponse(id, RC_DISCOVER_RESULT);
      if (method === "tools/list") return jsonRpcResponse(id, { tools: [] });
      if (method === "tools/call") return jsonRpcResponse(id, { resultType: "input_required", inputRequests: {} });
      return new Response("unexpected", { status: 500 });
    });

    await client.connect();
    // No resolver injected → the client cannot satisfy input_required and never
    // fabricates a response.
    await expect(client.callTool("q", {})).rejects.toThrow(/input_required/);
    await client.disconnect();
  });

  it("MRTR loop: resolves input_required, echoes requestState verbatim, retries to complete", async () => {
    const calls: Array<Record<string, unknown> | undefined> = [];
    const resolver = vi.fn(async (_rid: string, _request: Record<string, unknown>) => ({
      action: "accept",
      content: { token: "abc" },
    }));
    const { client, fetchMock } = rcHttpClient(
      "mrtr",
      (method, id) => {
        if (method === "server/discover") return jsonRpcResponse(id, RC_DISCOVER_RESULT);
        if (method === "tools/list") return jsonRpcResponse(id, { tools: [] });
        if (method === "tools/call") {
          // First call → input_required; second (retry) → complete.
          const toolCalls = calls.filter(Boolean).length;
          if (toolCalls === 0) {
            calls.push({});
            return jsonRpcResponse(id, {
              resultType: "input_required",
              inputRequests: { q1: { method: "elicitation/create", message: "need a token" } },
              requestState: "opaque-state-xyz",
            });
          }
          return jsonRpcResponse(id, { resultType: "complete", content: [{ type: "text", text: "done" }] });
        }
        return new Response("unexpected", { status: 500 });
      },
      resolver,
    );

    await client.connect();
    const out = await client.callTool("q", { a: 1 });
    expect(out.text).toBe("done");

    // Resolver was invoked with the inputRequest keyed by its opaque id.
    expect(resolver).toHaveBeenCalledWith("q1", { method: "elicitation/create", message: "need a token" });

    // The retry (2nd tools/call) carried inputResponses + the echoed requestState.
    const toolCallInits = fetchMock.mock.calls
      .filter(([, i]) => readRpcMethod(i as RequestInit) === "tools/call")
      .map(([, i]) => readRpcParams(i as RequestInit));
    expect(toolCallInits).toHaveLength(2);
    expect(toolCallInits[1]).toMatchObject({
      name: "q",
      arguments: { a: 1 },
      inputResponses: { q1: { action: "accept", content: { token: "abc" } } },
      requestState: "opaque-state-xyz",
    });
    await client.disconnect();
  });

  it("derives clientCapabilities per request from the injected provider (governance-per-request)", async () => {
    // The active turn flips from interactive (can elicit) to headless (cannot)
    // between requests; each request's _meta must reflect the value at send time.
    let turn = 0;
    const provider = vi.fn(() =>
      turn++ === 0
        ? { elicitation: { form: {}, url: {} }, extensions: {} }
        : { extensions: {} }, // headless: no elicitation advertised
    );
    const { client, fetchMock } = rcHttpClient(
      "perreq",
      (method, id) => {
        if (method === "server/discover") return jsonRpcResponse(id, RC_DISCOVER_RESULT);
        if (method === "tools/list") return jsonRpcResponse(id, { tools: [] });
        return new Response("unexpected", { status: 500 });
      },
      undefined,
      provider,
    );

    await client.connect();

    const caps = fetchMock.mock.calls.map(
      ([, i]) => readRpcParams(i as RequestInit)?._meta as Record<string, unknown>,
    );
    // discover (turn 0) advertised elicitation; tools/list (turn 1) did not.
    expect(caps[0]["io.modelcontextprotocol/clientCapabilities"]).toMatchObject({ elicitation: {} });
    expect(caps[1]["io.modelcontextprotocol/clientCapabilities"]).not.toHaveProperty("elicitation");
    expect(provider).toHaveBeenCalledTimes(caps.length);
    await client.disconnect();
  });

  it("Tasks: polls a CreateTaskResult to completion and returns the completed result", async () => {
    let taskGets = 0;
    const { client } = rcHttpClient("task", (method, id) => {
      if (method === "server/discover") return jsonRpcResponse(id, RC_DISCOVER_RESULT);
      if (method === "tools/list") return jsonRpcResponse(id, { tools: [] });
      if (method === "tools/call")
        return jsonRpcResponse(id, { resultType: "task", taskId: "t1", status: "working", pollIntervalMs: 1 });
      if (method === "tasks/get") {
        taskGets += 1;
        return jsonRpcResponse(
          id,
          taskGets >= 2
            ? { resultType: "task", taskId: "t1", status: "completed", content: [{ type: "text", text: "task done" }] }
            : { resultType: "task", taskId: "t1", status: "working", pollIntervalMs: 1 },
        );
      }
      return new Response("unexpected", { status: 500 });
    });

    await client.connect();
    const out = await client.callTool("q", {});
    expect(out.text).toBe("task done");
    expect(taskGets).toBeGreaterThanOrEqual(2);
    await client.disconnect();
  });

  it("Tasks: a failed task throws", async () => {
    const { client } = rcHttpClient("taskfail", (method, id) => {
      if (method === "server/discover") return jsonRpcResponse(id, RC_DISCOVER_RESULT);
      if (method === "tools/list") return jsonRpcResponse(id, { tools: [] });
      if (method === "tools/call")
        return jsonRpcResponse(id, { resultType: "task", taskId: "t2", status: "failed" });
      return new Response("unexpected", { status: 500 });
    });

    await client.connect();
    await expect(client.callTool("q", {})).rejects.toThrow(/ended 'failed'/);
    await client.disconnect();
  });

  it("MCP Apps gate: honors _meta.ui only when the server advertised the ui extension", async () => {
    const uiResult = {
      resultType: "complete",
      content: [{ type: "text", text: "x" }],
      _meta: {
        ui: {
          resourceUri: "ui://app/p.html",
          csp: { connectSrc: ["https://api.example.com"] },
        },
      },
    };
    const discoverWithApps = {
      ...RC_DISCOVER_RESULT,
      capabilities: { tools: {}, extensions: { "io.modelcontextprotocol/ui": {} } },
    };

    // Server WITH the ui extension → _meta.ui is honored.
    const withApps = rcHttpClient("apps", (method, id) => {
      if (method === "server/discover") return jsonRpcResponse(id, discoverWithApps);
      if (method === "tools/list") return jsonRpcResponse(id, { tools: [] });
      if (method === "tools/call") return jsonRpcResponse(id, uiResult);
      return new Response("unexpected", { status: 500 });
    });
    await withApps.client.connect();
    const uiPayload = (await withApps.client.callTool("q", {})).uiPayload;
    expect(uiPayload).toMatchObject({ resourceUri: "ui://app/p.html" });
    // A `csp` on the TOOL result is IGNORED. Per spec it lives on the RESOURCE
    // (`resources/read` content item `_meta.ui`), and main derives the sandbox-proxy
    // CSP header from there — never from a tool result, and never from the renderer.
    expect(uiPayload).not.toHaveProperty("csp");
    await withApps.client.disconnect();

    // Same _meta.ui from a server that did NOT advertise Apps → ignored (gate).
    const noApps = rcHttpClient("noapps", (method, id) => {
      if (method === "server/discover") return jsonRpcResponse(id, RC_DISCOVER_RESULT);
      if (method === "tools/list") return jsonRpcResponse(id, { tools: [] });
      if (method === "tools/call") return jsonRpcResponse(id, uiResult);
      return new Response("unexpected", { status: 500 });
    });
    await noApps.client.connect();
    expect((await noApps.client.callTool("q", {})).uiPayload).toBeUndefined();
    await noApps.client.disconnect();
  });

  it("readResource: surfaces the RESOURCE's own _meta.ui (csp/permissions), gated by advertise", async () => {
    // The CSP main builds comes from HERE — the resources/read content item's
    // `_meta.ui` — not from the tool result. And it is fail-closed: a server that did
    // not advertise the ui extension has its csp/permissions dropped, so it cannot
    // open its own containment envelope.
    const readResult = {
      contents: [
        {
          uri: "ui://app/p.html",
          mimeType: "text/html;profile=mcp-app",
          text: "<h1>app</h1>",
          _meta: {
            ui: {
              csp: { connectDomains: ["https://api.example.com"] },
              permissions: { clipboardWrite: {} },
            },
          },
        },
      ],
    };
    const discoverWithApps = {
      ...RC_DISCOVER_RESULT,
      capabilities: { tools: {}, extensions: { "io.modelcontextprotocol/ui": {} } },
    };

    const withApps = rcHttpClient("apps-res", (method, id) => {
      if (method === "server/discover") return jsonRpcResponse(id, discoverWithApps);
      if (method === "tools/list") return jsonRpcResponse(id, { tools: [] });
      if (method === "resources/read") return jsonRpcResponse(id, readResult);
      return new Response("unexpected", { status: 500 });
    });
    await withApps.client.connect();
    const advertised = await withApps.client.readResource("ui://app/p.html");
    // An ADVERTISED server's `_meta.ui` is surfaced faithfully into the read model —
    // csp AND permissions. Whether a given permission is HONORED is a separate layer
    // (`shared/mcp-app-permissions.ts`): clipboardWrite is not in the capability table,
    // so it survives here on the wire but is never delegated or granted downstream.
    expect(advertised).toEqual({
      html: "<h1>app</h1>",
      csp: { connectDomains: ["https://api.example.com"] },
      permissions: { clipboardWrite: {} },
    });
    await withApps.client.disconnect();

    // Same content from a server that did NOT advertise Apps → csp/permissions DROPPED.
    const noApps = rcHttpClient("noapps-res", (method, id) => {
      if (method === "server/discover") return jsonRpcResponse(id, RC_DISCOVER_RESULT);
      if (method === "tools/list") return jsonRpcResponse(id, { tools: [] });
      if (method === "resources/read") return jsonRpcResponse(id, readResult);
      return new Response("unexpected", { status: 500 });
    });
    await noApps.client.connect();
    const unadvertised = await noApps.client.readResource("ui://app/p.html");
    expect(unadvertised).toEqual({ html: "<h1>app</h1>", csp: undefined, permissions: undefined });
    await noApps.client.disconnect();
  });

  it("drops a tool result's ui card when its resourceUri is unusable, keeping the text", async () => {
    // Fail-closed at extraction, mirroring the plugin arm. Before this the card mounted,
    // installed a partition policy, and failed later at `readResource` with a message a
    // user cannot connect to the server's declaration. The TEXT must still come through —
    // a tool result is never withheld because its optional UI declaration was malformed.
    const discoverWithApps = {
      ...RC_DISCOVER_RESULT,
      capabilities: { tools: {}, extensions: { "io.modelcontextprotocol/ui": {} } },
    };
    for (const [resourceUri, shouldRender] of [
      ["ui://app/card.html", true],
      ["file:///etc/passwd", false],
      ["UI://app/card.html", false],
      ["ui:///card.html", false],
      ["ui://", false],
    ] as const) {
      const { client } = rcHttpClient(`uimeta-${shouldRender}-${resourceUri.length}`, (method, id) => {
        if (method === "server/discover") return jsonRpcResponse(id, discoverWithApps);
        if (method === "tools/list") return jsonRpcResponse(id, { tools: [] });
        if (method === "tools/call") {
          return jsonRpcResponse(id, {
            content: [{ type: "text", text: "TOOL TEXT" }],
            _meta: { ui: { resourceUri, slot: "chat" } },
          });
        }
        return new Response("unexpected", { status: 500 });
      });
      await client.connect();
      const out = await client.callTool("t", {});
      expect(out.text, resourceUri).toBe("TOOL TEXT");
      expect(Boolean(out.uiPayload), resourceUri).toBe(shouldRender);
      await client.disconnect();
    }
  });

  it("readResource: refuses any URI that is not the Apps path, before the request", async () => {
    // The hole a cluster review found, closed here. `resources/read` is ONE wire method
    // serving two host paths: `readDeclaredResource`, gated on the listed set, and this
    // one. The renderer picks the URI on this path, and nothing in MAIN checked it — the
    // `ui://` restriction lived only in the renderer's bridge handler, which is the side
    // the threat model assumes is compromised. Governance could not close it either: it
    // sees one method and cannot tell the callers apart, so a non-`ui:` URI fell through
    // to requiring `resources`, which any resource-publishing server holds.
    //
    // Net effect before the fix: a compromised renderer could read ANY URI from ANY
    // connected external server.
    // The fixture server holds `resources`, deliberately. `rcHttpClient` approves only
    // `tools`, and on such a server governance already denied `file:`/`https:`/`doc:`
    // for lacking the capability — so a tools-only fixture would have "passed" against
    // the pre-fix code for a reason that has nothing to do with this gate. The
    // exploitable class was a server approved for `resources`, which is most of them.
    let reads = 0;
    const url = "https://api.example.com/apps-scheme/mcp";
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit): Promise<Response> => {
      const method = readRpcMethod(init);
      const id = readRpcId(init) ?? 0;
      if (method === "server/discover") return jsonRpcResponse(id, RC_DISCOVER_RESULT);
      if (method === "tools/list") return jsonRpcResponse(id, { tools: [] });
      if (method === "resources/list") return jsonRpcResponse(id, { resources: [] });
      if (method === "resources/read") {
        reads += 1;
        return jsonRpcResponse(id, {
          contents: [{ uri: "ui://app/p.html", text: "<h1>app</h1>" }],
        });
      }
      return new Response("unexpected", { status: 500 });
    }));
    const client = new McpClient(
      { id: "apps-scheme", transport: "http", url },
      governanceWithPolicy(buildPolicy([httpApproval("apps-scheme", url, {
        allowedCapabilities: ["tools", "resources"] as McpGovernancePolicy["servers"][number]["allowedCapabilities"],
      })])),
      new ToolRegistry(),
    );
    await client.connect();

    for (const uri of [
      "file:///etc/passwd",
      "file:///C:/Users/me/.ssh/id_rsa",
      "https://internal.example.com/admin",
      "doc:1",
      "UI://app/p.html",
      "ui:///p.html",
    ]) {
      await expect(client.readResource(uri), uri).rejects.toThrow(/ui:\/\/ resources only/);
    }
    // Not one request left the host for any of them — and on THIS server governance
    // would have let every one of them through.
    expect(reads).toBe(0);

    // …and the path it exists to serve still works.
    const ok = await client.readResource("ui://app/p.html");
    expect(ok.html).toBe("<h1>app</h1>");
    expect(reads).toBe(1);
    await client.disconnect();
  });

  it("MRTR runaway guard: a server stuck on input_required fails after the round bound", async () => {
    const resolver = vi.fn(async () => ({ action: "accept" }));
    const { client } = rcHttpClient(
      "runaway",
      (method, id) => {
        if (method === "server/discover") return jsonRpcResponse(id, RC_DISCOVER_RESULT);
        if (method === "tools/list") return jsonRpcResponse(id, { tools: [] });
        if (method === "tools/call")
          return jsonRpcResponse(id, { resultType: "input_required", inputRequests: { q: {} }, requestState: "s" });
        return new Response("unexpected", { status: 500 });
      },
      resolver,
    );

    await client.connect();
    await expect(client.callTool("q", {})).rejects.toThrow(/exceeded .* input_required rounds/);
    await client.disconnect();
  });

  it("maps a -32021 missing-required-client-capability error on a tool call", async () => {
    // Final `2026-07-28` numbering (the draft's -32003 moved to -32021).
    const { client } = rcHttpClient("mc", (method, id) => {
      if (method === "server/discover") return jsonRpcResponse(id, RC_DISCOVER_RESULT);
      if (method === "tools/list") return jsonRpcResponse(id, { tools: [] });
      if (method === "tools/call") return jsonRpcErrorResponse(id, -32021, "missing capability");
      return new Response("unexpected", { status: 500 });
    });

    await client.connect();
    await expect(client.callTool("q", {})).rejects.toThrow(/-32021/);
    await client.disconnect();
  });
});

describe("MCP prompts discovery", () => {
  function connectWith(opts: {
    advertisePrompts: boolean;
    approveCapabilities: string[];
    instructions?: string;
    promptPages?: Array<{ prompts: unknown[]; nextCursor?: string }>;
  }): { client: McpClient; promptsCalls: unknown[] } {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const promptsCalls: unknown[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit): Promise<Response> => {
      const method = readRpcMethod(init);
      const id = readRpcId(init) ?? 0;
      switch (method) {
        case "server/discover":
          return jsonRpcResponse(id, {
            ...RC_DISCOVER_RESULT,
            capabilities: opts.advertisePrompts ? { tools: {}, prompts: {} } : { tools: {} },
            ...(opts.instructions !== undefined ? { instructions: opts.instructions } : {}),
          });
        case "notifications/initialized":
          return new Response(null, { status: 202 });
        case "tools/list":
          return jsonRpcResponse(id, { tools: [] });
        case "prompts/list": {
          const params = (JSON.parse(String(init?.body)).params ?? {}) as Record<string, unknown>;
          promptsCalls.push(params);
          const page = opts.promptPages?.[promptsCalls.length - 1] ?? { prompts: [] };
          return jsonRpcResponse(id, page);
        }
        default:
          return new Response("unexpected", { status: 500 });
      }
    });
    vi.stubGlobal("fetch", fetchMock);
    const gov = governanceWithPolicy(
      buildPolicy([
        httpApproval("psrv", "https://psrv.example.com/mcp", {
          allowedCapabilities: opts.approveCapabilities as McpGovernancePolicy["servers"][number]["allowedCapabilities"],
        }),
      ]),
    );
    const client = new McpClient(
      { id: "psrv", transport: "http", url: "https://psrv.example.com/mcp" },
      gov,
      new ToolRegistry(),
    );
    return { client, promptsCalls };
  }

  it("discovers prompts + instructions when advertised AND approved", async () => {
    const { client, promptsCalls } = connectWith({
      advertisePrompts: true,
      approveCapabilities: ["tools", "prompts"],
      instructions: "Use the review prompt for PRs.",
      promptPages: [
        {
          prompts: [
            { name: "code_review", description: "Review a diff", arguments: [{ name: "diff", required: true }] },
          ],
        },
      ],
    });
    await client.connect();
    expect(promptsCalls).toHaveLength(1);
    expect(client.getState().prompts).toEqual([
      {
        name: "code_review",
        title: undefined,
        description: "Review a diff",
        arguments: [{ name: "diff", description: undefined, required: true }],
      },
    ]);
    expect(client.getState().instructions).toBe("Use the review prompt for PRs.");
    await client.disconnect();
    expect(client.getState().prompts).toBeUndefined();
  });

  // `prompts/list` output is wire data: the declared types are casts. A non-string
  // name reaches the renderer and throws when React renders it, and a name main
  // would later reject for length renders a field the user can fill but the host
  // silently drops. Both are filtered HERE so one shape reaches every consumer.
  it("drops prompts and arguments whose declared names are unusable", async () => {
    const { client } = connectWith({
      advertisePrompts: true,
      approveCapabilities: ["tools", "prompts"],
      promptPages: [
        {
          prompts: [
            { name: 42 },
            { name: "" },
            { name: "x".repeat(200) },
            {
              name: "ok",
              arguments: [
                { name: "good", required: true },
                { name: { nested: true }, required: true },
                { name: "y".repeat(65), required: false },
              ],
            },
          ],
        },
      ],
    });
    await client.connect();
    expect(client.getState().prompts).toEqual([
      { name: "ok", arguments: [{ name: "good", required: true }] },
    ]);
    await client.disconnect();
  });

  it("does NOT call prompts/list when advertised but not approved", async () => {
    const { client, promptsCalls } = connectWith({ advertisePrompts: true, approveCapabilities: ["tools"] });
    await client.connect();
    expect(promptsCalls).toHaveLength(0);
    expect(client.getState().prompts).toBeUndefined();
    await client.disconnect();
  });

  it("does NOT call prompts/list when approved but not advertised", async () => {
    const { client, promptsCalls } = connectWith({
      advertisePrompts: false,
      approveCapabilities: ["tools", "prompts"],
    });
    await client.connect();
    expect(promptsCalls).toHaveLength(0);
    await client.disconnect();
  });

  it("follows nextCursor with bounded pagination", async () => {
    const { client, promptsCalls } = connectWith({
      advertisePrompts: true,
      approveCapabilities: ["tools", "prompts"],
      promptPages: [
        { prompts: [{ name: "a" }], nextCursor: "c1" },
        { prompts: [{ name: "b" }] },
      ],
    });
    await client.connect();
    expect(promptsCalls).toHaveLength(2);
    expect(client.getState().prompts?.map((p) => p.name)).toEqual(["a", "b"]);
    await client.disconnect();
  });
});

describe("MCP getPrompt gating", () => {
  it("refuses a prompt the server never declared, and serves a declared one", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit): Promise<Response> => {
      const method = readRpcMethod(init);
      const id = readRpcId(init) ?? 0;
      switch (method) {
        case "server/discover":
          return jsonRpcResponse(id, { ...RC_DISCOVER_RESULT, capabilities: { tools: {}, prompts: {} } });
        case "notifications/initialized":
          return new Response(null, { status: 202 });
        case "tools/list":
          return jsonRpcResponse(id, { tools: [] });
        case "prompts/list":
          return jsonRpcResponse(id, { prompts: [{ name: "code_review", description: "Review" }] });
        case "prompts/get":
          return jsonRpcResponse(id, {
            description: "Review",
            messages: [{ role: "user", content: { type: "text", text: "REVIEW BODY" } }],
          });
        default:
          return new Response("unexpected", { status: 500 });
      }
    });
    vi.stubGlobal("fetch", fetchMock);
    const gov = governanceWithPolicy(
      buildPolicy([
        httpApproval("psrv2", "https://psrv2.example.com/mcp", {
          allowedCapabilities: ["tools", "prompts"] as McpGovernancePolicy["servers"][number]["allowedCapabilities"],
        }),
      ]),
    );
    const client = new McpClient(
      { id: "psrv2", transport: "http", url: "https://psrv2.example.com/mcp" },
      gov,
      new ToolRegistry(),
    );
    await client.connect();

    // A name the host never saw at discovery is refused BEFORE any request.
    await expect(client.getPrompt("not_declared", {})).rejects.toThrow(/did not declare prompt/);

    const got = await client.getPrompt("code_review", { diff: "x" });
    expect(got.description).toBe("Review");
    expect(got.blocks).toEqual([{ role: "user", type: "text", text: "REVIEW BODY" }]);
    await client.disconnect();
  });

  it("refuses getPrompt when the server never advertised prompts", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit): Promise<Response> => {
      const method = readRpcMethod(init);
      const id = readRpcId(init) ?? 0;
      if (method === "server/discover") return jsonRpcResponse(id, RC_DISCOVER_RESULT);
      if (method === "tools/list") return jsonRpcResponse(id, { tools: [] });
      if (method === "notifications/initialized") return new Response(null, { status: 202 });
      return new Response("unexpected", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const gov = governanceWithPolicy(
      buildPolicy([httpApproval("psrv3", "https://psrv3.example.com/mcp")]),
    );
    const client = new McpClient(
      { id: "psrv3", transport: "http", url: "https://psrv3.example.com/mcp" },
      gov,
      new ToolRegistry(),
    );
    await client.connect();
    await expect(client.getPrompt("anything", {})).rejects.toThrow(/did not advertise prompts/);
    await client.disconnect();
  });
});

describe("MCP resources discovery and read", () => {
  function connectWith(opts: {
    advertiseResources: boolean;
    approveCapabilities: string[];
    resourcePages?: Array<{ resources: unknown[]; nextCursor?: string }>;
    templatePages?: Array<{ resourceTemplates: unknown[]; nextCursor?: string }>;
    readResult?: unknown;
  }): { client: McpClient; listCalls: unknown[]; readCalls: unknown[]; templateListCalls: unknown[] } {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const listCalls: unknown[] = [];
    const templateListCalls: unknown[] = [];
    const readCalls: unknown[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit): Promise<Response> => {
      const method = readRpcMethod(init);
      const id = readRpcId(init) ?? 0;
      switch (method) {
        case "server/discover":
          return jsonRpcResponse(id, {
            ...RC_DISCOVER_RESULT,
            capabilities: opts.advertiseResources
              ? { tools: {}, resources: {} }
              : { tools: {} },
          });
        case "notifications/initialized":
          return new Response(null, { status: 202 });
        case "tools/list":
          return jsonRpcResponse(id, { tools: [] });
        case "resources/templates/list": {
          const params = (JSON.parse(String(init?.body)).params ?? {}) as Record<string, unknown>;
          templateListCalls.push(params);
          const page = opts.templatePages?.[templateListCalls.length - 1]
            ?? { resourceTemplates: [] };
          return jsonRpcResponse(id, page);
        }
        case "resources/list": {
          const params = (JSON.parse(String(init?.body)).params ?? {}) as Record<string, unknown>;
          listCalls.push(params);
          const page = opts.resourcePages?.[listCalls.length - 1] ?? { resources: [] };
          return jsonRpcResponse(id, page);
        }
        case "resources/read": {
          const params = (JSON.parse(String(init?.body)).params ?? {}) as Record<string, unknown>;
          readCalls.push(params);
          return jsonRpcResponse(id, opts.readResult ?? { contents: [] });
        }
        default:
          return new Response("unexpected", { status: 500 });
      }
    });
    vi.stubGlobal("fetch", fetchMock);
    const gov = governanceWithPolicy(
      buildPolicy([
        httpApproval("rsrv", "https://rsrv.example.com/mcp", {
          allowedCapabilities:
            opts.approveCapabilities as McpGovernancePolicy["servers"][number]["allowedCapabilities"],
        }),
      ]),
    );
    const client = new McpClient(
      { id: "rsrv", transport: "http", url: "https://rsrv.example.com/mcp" },
      gov,
      new ToolRegistry(),
    );
    return { client, listCalls, readCalls, templateListCalls };
  }

  it("discovers resources when advertised AND approved", async () => {
    const { client, listCalls } = connectWith({
      advertiseResources: true,
      approveCapabilities: ["tools", "resources"],
      resourcePages: [
        {
          resources: [
            {
              uri: "file:///project/README.md",
              name: "README.md",
              title: "Project Documentation",
              mimeType: "text/markdown",
              size: 1234,
            },
          ],
        },
      ],
    });
    await client.connect();
    expect(listCalls).toHaveLength(1);
    expect(client.getState().resources).toEqual([
      {
        uri: "file:///project/README.md",
        name: "README.md",
        title: "Project Documentation",
        mimeType: "text/markdown",
        size: 1234,
      },
    ]);
    await client.disconnect();
  });

  // Two keys, same as prompts: a capability the server never advertised, or one the
  // user never approved, means nothing leaves the host.
  it("does NOT call resources/list when advertised but not approved", async () => {
    const { client, listCalls, templateListCalls } = connectWith({
      advertiseResources: true,
      approveCapabilities: ["tools"],
    });
    await client.connect();
    expect(listCalls).toHaveLength(0);
    // TEMPLATES ride the same key, and asserting it here is the point: the gate is
    // one capability, so a template discovery that quietly used a different rule
    // would be a second answer to a question the user already answered once.
    expect(templateListCalls).toHaveLength(0);
    expect(client.getState().resources).toBeUndefined();
    expect(client.getState().resourceTemplates).toBeUndefined();
    await client.disconnect();
  });

  it("does NOT call resources/list when approved but not advertised", async () => {
    const { client, listCalls, templateListCalls } = connectWith({
      advertiseResources: false,
      approveCapabilities: ["tools", "resources"],
    });
    await client.connect();
    expect(listCalls).toHaveLength(0);
    // The half of the two-key gate that `sendRequest` does NOT back up: governance
    // re-checks the capability on every request, but nothing re-checks that the
    // server advertised it. If this line goes, so does the only thing asserting it
    // for templates.
    expect(templateListCalls).toHaveLength(0);
    expect(client.getState().resourceTemplates).toBeUndefined();
    await client.disconnect();
  });

  // Wire data is typed but not checked. Anything the host would later have to
  // render, log, or hand back to the server is filtered at this boundary.
  it("drops unusable entries and de-duplicates by URI", async () => {
    const { client } = connectWith({
      advertiseResources: true,
      approveCapabilities: ["tools", "resources"],
      resourcePages: [
        {
          resources: [
            { uri: 42, name: "numeric uri" },
            { uri: "ui://widget/main.html", name: "app scheme" },
            { uri: "javascript:alert(1)", name: "dangerous scheme" },
            { uri: "no-scheme", name: "not a uri" },
            { uri: "file:///dup", name: "first" },
            { uri: "file:///dup", name: "second" },
            { uri: "file:///ok", name: 42, title: "falls back to the uri" },
          ],
        },
      ],
    });
    // `createLogger` proxies to console.log for info in test mode (lib/logger.ts).
    const info = vi.spyOn(console, "log").mockImplementation(() => {});
    await client.connect();
    const resources = client.getState().resources ?? [];
    expect(resources.map((r) => r.uri)).toEqual(["file:///dup", "file:///ok"]);
    expect(resources[0].name).toBe("first");
    // A non-string name falls back to the URI rather than dropping the resource.
    expect(resources[1].name).toBe("file:///ok");
    // The whole point of the count is that a user can ask where their resource went
    // and read an answer that adds up. 7 published, 2 catalogued, so it must say 5 —
    // counting only the malformed ones (4 here) would report a number that leaves the
    // duplicate unexplained and reads as "everything else made it".
    const line = info.mock.calls.map((c) => c.join(" ")).find((l) => l.includes("discovered"));
    expect(line).toContain("discovered 2 resource(s)");
    expect(line).toContain("5 of 7 published not catalogued");
    info.mockRestore();
    await client.disconnect();
  });

  it("discovers URI templates and derives their variables once", async () => {
    const { client, templateListCalls } = connectWith({
      advertiseResources: true,
      approveCapabilities: ["tools", "resources"],
      templatePages: [
        {
          resourceTemplates: [
            {
              uriTemplate: "file:///project/{path}",
              name: "Project file",
              title: "Any file in the project",
              mimeType: "text/plain",
            },
            { uriTemplate: "github://repos/{owner}/{repo}/issues/{number}", name: "Issue" },
          ],
        },
      ],
    });
    await client.connect();

    expect(templateListCalls).toHaveLength(1);
    expect(client.getState().resourceTemplates).toEqual([
      {
        uriTemplate: "file:///project/{path}",
        name: "Project file",
        title: "Any file in the project",
        mimeType: "text/plain",
        variables: ["path"],
      },
      {
        uriTemplate: "github://repos/{owner}/{repo}/issues/{number}",
        name: "Issue",
        variables: ["owner", "repo", "number"],
      },
    ]);
    await client.disconnect();
  });

  // The operator cases matter more here than in the predicate's own suite: this is
  // where a `{+path}` template would become an offer to the user, and reserved
  // expansion does not percent-encode what they type into it.
  it("drops templates the host will not expand, and says how many", async () => {
    const { client } = connectWith({
      advertiseResources: true,
      approveCapabilities: ["tools", "resources"],
      templatePages: [
        {
          resourceTemplates: [
            { uriTemplate: "file:///project/{+path}", name: "reserved expansion" },
            { uriTemplate: "file:///project/{path*}", name: "explode" },
            { uriTemplate: "ui://widget/{id}", name: "reserved scheme" },
            { uriTemplate: "file:///project/README.md", name: "not a template" },
            { uriTemplate: 42, name: "not a string" },
            { uriTemplate: "file:///ok/{path}", name: "first" },
            { uriTemplate: "file:///ok/{path}", name: "duplicate" },
          ],
        },
      ],
    });
    const info = vi.spyOn(console, "log").mockImplementation(() => {});
    await client.connect();

    const templates = client.getState().resourceTemplates ?? [];
    expect(templates.map((template) => template.uriTemplate)).toEqual(["file:///ok/{path}"]);
    expect(templates[0].name).toBe("first");
    // 7 published, 1 catalogued — the line has to say 6, not just the malformed ones.
    const line = info.mock.calls.map((c) => c.join(" "))
      .find((l) => l.includes("resource template(s)"));
    expect(line).toContain("discovered 1 resource template(s)");
    expect(line).toContain("6 of 7 published not catalogued");
    info.mockRestore();
    await client.disconnect();
  });

  it("flags a template whose LITERAL scheme the host will not fetch", async () => {
    // Not a guess: the literal part is fixed at discovery, so if the scheme is literally
    // `https:` then every expansion of it is too. The picker disables the row on this,
    // which is what stops a user filling a form whose only outcome is a refusal.
    const { client } = connectWith({
      advertiseResources: true,
      approveCapabilities: ["tools", "resources"],
      templatePages: [
        {
          resourceTemplates: [
            { uriTemplate: "https://example.com/{doc}", name: "web" },
            { uriTemplate: "file:///project/{path}", name: "local" },
          ],
        },
      ],
    });
    await client.connect();

    const templates = client.getState().resourceTemplates ?? [];
    expect(templates[0]).toMatchObject({ uriTemplate: "https://example.com/{doc}", hostFetchRefused: true });
    // …and the flag is ABSENT rather than false on a template the host will fetch, so a
    // consumer cannot read "we checked and it is fine" off a missing property.
    expect(templates[1]).not.toHaveProperty("hostFetchRefused");
    await client.disconnect();
  });

  it("refuses at READ time when the flag could not have known", async () => {
    // The discovery flag is display-only, and this is what proves it: a variable in
    // scheme position is honestly UNflagged (the literal scheme is not known until
    // expansion), the picker therefore offers the row, and the read refuses anyway
    // because it re-derives from the expansion rather than consulting the flag. If it
    // ever started trusting the flag, this is the case that would leak.
    const { client, readCalls } = connectWith({
      advertiseResources: true,
      approveCapabilities: ["tools", "resources"],
      templatePages: [
        { resourceTemplates: [{ uriTemplate: "{scheme}://example.com/{path}", name: "any" }] },
      ],
    });
    await client.connect();

    expect(client.getState().resourceTemplates?.[0]).not.toHaveProperty("hostFetchRefused");
    await expect(client.readDeclaredResourceTemplate(
      "{scheme}://example.com/{path}",
      new Map([["scheme", "https"], ["path", "r.pdf"]]),
    )).rejects.toThrow(/does not fetch/);
    expect(readCalls).toHaveLength(0);
    await client.disconnect();
  });

  it("expands a declared template host-side and reads the produced URI", async () => {
    const { client, readCalls } = connectWith({
      advertiseResources: true,
      approveCapabilities: ["tools", "resources"],
      templatePages: [{ resourceTemplates: [{ uriTemplate: "file:///project/{path}", name: "f" }] }],
      readResult: { contents: [{ uri: "file:///project/a.md", text: "BODY" }] },
    });
    await client.connect();

    const read = await client.readDeclaredResourceTemplate(
      "file:///project/{path}",
      new Map([["path", "a.md"]]),
    );

    expect(read.uri).toBe("file:///project/a.md");
    // The wire request carries the host's expansion — `toMatchObject` because every
    // request also carries the handshake `_meta` envelope.
    expect(readCalls).toMatchObject([{ uri: "file:///project/a.md" }]);
    expect(read.blocks[0].text).toBe("BODY");
    await client.disconnect();
  });

  it("cannot be walked out of the published path by what the user types", async () => {
    // The reason expansion is host-side at all. The value is percent-encoded, so the
    // server receives one segment — not a traversal — and the URI on the wire is the
    // one the host produced rather than one the renderer chose.
    const { client, readCalls } = connectWith({
      advertiseResources: true,
      approveCapabilities: ["tools", "resources"],
      templatePages: [{ resourceTemplates: [{ uriTemplate: "file:///project/{path}", name: "f" }] }],
    });
    await client.connect();

    const read = await client.readDeclaredResourceTemplate(
      "file:///project/{path}",
      new Map([["path", "../../etc/passwd"]]),
    );

    expect(read.uri).toBe("file:///project/..%2F..%2Fetc%2Fpasswd");
    expect(readCalls).toMatchObject([{ uri: "file:///project/..%2F..%2Fetc%2Fpasswd" }]);
    await client.disconnect();
  });

  it("refuses a template it never listed, before any request", async () => {
    // Same gate as the plain read, on the pattern rather than the URI: matching an
    // expanded URI back against a template would need a matcher, and a matcher for
    // `file:///{path}` accepts `file:///../../etc/passwd`.
    const { client, readCalls } = connectWith({
      advertiseResources: true,
      approveCapabilities: ["tools", "resources"],
      templatePages: [{ resourceTemplates: [{ uriTemplate: "file:///listed/{path}", name: "f" }] }],
    });
    await client.connect();

    await expect(client.readDeclaredResourceTemplate(
      "file:///other/{path}",
      new Map([["path", "a.md"]]),
    )).rejects.toThrow(/did not declare/);
    expect(readCalls).toHaveLength(0);
    await client.disconnect();
  });

  it("refuses when a value is missing rather than expanding it away", async () => {
    // An empty substitution points at the directory above — a different resource than
    // the user asked for, and one they cannot see they asked for.
    const { client, readCalls } = connectWith({
      advertiseResources: true,
      approveCapabilities: ["tools", "resources"],
      templatePages: [{ resourceTemplates: [{ uriTemplate: "file:///project/{path}", name: "f" }] }],
    });
    await client.connect();

    await expect(client.readDeclaredResourceTemplate(
      "file:///project/{path}",
      new Map(),
    )).rejects.toThrow(/no usable uri/);
    expect(readCalls).toHaveLength(0);
    await client.disconnect();
  });

  it("refuses to fetch a template whose LITERAL scheme is refused", async () => {
    // Deliberately the easy half, and labelled as such after a review pointed out that
    // its old title ("when the EXPANSION lands on a refused scheme") was a claim this
    // fixture cannot make: `https://…/{doc}` is refused identically whether the check
    // reads the template or the expansion. The re-derivation is pinned by "refuses at
    // READ time when the flag could not have known", which uses a variable scheme.
    const { client, readCalls } = connectWith({
      advertiseResources: true,
      approveCapabilities: ["tools", "resources"],
      templatePages: [{ resourceTemplates: [{ uriTemplate: "https://example.com/{doc}", name: "web" }] }],
    });
    await client.connect();

    await expect(client.readDeclaredResourceTemplate(
      "https://example.com/{doc}",
      new Map([["doc", "r.pdf"]]),
    )).rejects.toThrow(/does not fetch/);
    expect(readCalls).toHaveLength(0);
    await client.disconnect();
  });
  it("refuses to read a URI it never listed", async () => {
    const { client, readCalls } = connectWith({
      advertiseResources: true,
      approveCapabilities: ["tools", "resources"],
      resourcePages: [{ resources: [{ uri: "file:///listed", name: "listed" }] }],
    });
    await client.connect();
    // The gate that stops `resources/read` becoming a general fetch primitive
    // against the server URI space.
    await expect(client.readDeclaredResource("file:///not-listed")).rejects.toThrow(
      /did not declare/,
    );
    expect(readCalls).toHaveLength(0);
    await client.disconnect();
  });

  it("refuses to fetch an https resource, but still lists it", async () => {
    const { client, readCalls } = connectWith({
      advertiseResources: true,
      approveCapabilities: ["tools", "resources"],
      resourcePages: [
        { resources: [{ uri: "https://example.com/doc", name: "web doc" }] },
      ],
    });
    await client.connect();
    expect(client.getState().resources?.[0]).toMatchObject({ hostFetchRefused: true });
    // Host-side fetching of a server-chosen URL is an SSRF primitive, so the read
    // is refused rather than proxied.
    await expect(client.readDeclaredResource("https://example.com/doc")).rejects.toThrow(
      /does not fetch/,
    );
    expect(readCalls).toHaveLength(0);
    await client.disconnect();
  });

  it("returns text blocks and placeholders for binary, bounded", async () => {
    const { client } = connectWith({
      advertiseResources: true,
      approveCapabilities: ["tools", "resources"],
      resourcePages: [{ resources: [{ uri: "file:///doc", name: "doc" }] }],
      readResult: {
        contents: [
          { uri: "file:///doc", mimeType: "text/plain", text: "hello" },
          { uri: "file:///doc.png", mimeType: "image/png", blob: "AAAA" },
          { uri: 42 },
        ],
      },
    });
    await client.connect();
    const read = await client.readDeclaredResource("file:///doc");
    expect(read.blocks[0]).toEqual({ uri: "file:///doc", mimeType: "text/plain", text: "hello" });
    // Never decoded into the turn, never silently dropped.
    expect(read.blocks[1]).toMatchObject({ omittedKind: "binary" });
    expect(read.blocks[2]).toMatchObject({ omittedKind: "unknown" });
    expect(read.droppedBlocks).toBe(0);
    await client.disconnect();
  });

  // Spent ACROSS blocks: a server that splits one huge document into many blocks
  // must not get a bigger budget than one that sends it whole.
  it("spends one character budget across all blocks", async () => {
    const { client } = connectWith({
      advertiseResources: true,
      approveCapabilities: ["tools", "resources"],
      resourcePages: [{ resources: [{ uri: "file:///big", name: "big" }] }],
      readResult: {
        contents: [
          { text: "a".repeat(MCP_RESOURCE_MAX_CHARS - 10) },
          { text: "b".repeat(1000) },
          { text: "c".repeat(1000) },
        ],
      },
    });
    await client.connect();
    const read = await client.readDeclaredResource("file:///big");
    const total = read.blocks.reduce((sum, block) => sum + (block.text?.length ?? 0), 0);
    expect(total).toBe(MCP_RESOURCE_MAX_CHARS);
    expect(read.blocks[2].text).toBe("");
    expect(read.truncated).toBe(true);
    await client.disconnect();
  });

  // A catalogue that outlives its connection is worse than an empty one: the model
  // keeps being offered URIs whose read can only fail, and the failure surfaces far
  // from the cause. Both teardown paths clear it.
  it("stops advertising resources once the server is gone", async () => {
    const { client } = connectWith({
      advertiseResources: true,
      approveCapabilities: ["tools", "resources"],
      resourcePages: [{ resources: [{ uri: "file:///doc", name: "doc" }] }],
    });
    await client.connect();
    expect(client.getState().resources).toHaveLength(1);
    await client.disconnect();
    expect(client.getState().resources).toBeUndefined();
  });

  // The CRASH path is the one that was actually broken: it cleared the tools and
  // left prompts and resources behind, so a dead server kept advertising both.
  it("clears the catalogue when the transport dies, not just on a clean disconnect", async () => {
    const { client } = connectWith({
      advertiseResources: true,
      approveCapabilities: ["tools", "resources"],
      resourcePages: [{ resources: [{ uri: "file:///doc", name: "doc" }] }],
    });
    await client.connect();
    expect(client.getState().resources).toHaveLength(1);
    // Same entry point the stdio transport uses when the child exits.
    (client as unknown as { handleTransportClose(reason: string): void })
      .handleTransportClose("child exited");
    expect(client.getState().status).toBe("error");
    expect(client.getState().resources).toBeUndefined();
    expect(client.getState().prompts).toBeUndefined();
    await client.disconnect();
  });

  it("bounds the page walk and the catalogue", async () => {
    const page = {
      resources: Array.from({ length: 300 }, (_, i) => ({
        uri: `file:///f${i}`,
        name: `f${i}`,
      })),
      nextCursor: "more",
    };
    const { client, listCalls } = connectWith({
      advertiseResources: true,
      approveCapabilities: ["tools", "resources"],
      resourcePages: [page, page, page],
    });
    await client.connect();
    // Stops at the per-server cap rather than following `nextCursor` forever.
    expect(client.getState().resources).toHaveLength(MCP_RESOURCE_MAX_PER_SERVER);
    expect(listCalls).toHaveLength(1);
    await client.disconnect();
  });
});
