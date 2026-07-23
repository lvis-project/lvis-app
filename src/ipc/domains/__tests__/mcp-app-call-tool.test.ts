/**
 * `lvis:mcp:call-tool` — the gated MCP-App `tools/call` IPC.
 *
 * Proves the chokepoint's own invariants (the per-backend visibility MUST is proved
 * in `mcp/__tests__/mcp-ui-tool-call.test.ts`, where it is enforced):
 *   - an unauthorized sender frame is rejected BEFORE anything else runs
 *   - the tool must be OWNED by the card's server (cross-server-call-denied), for the
 *     loopback arm AND the external arm
 *   - an allowed call reaches the backend and comes back as an outcome
 *   - a denial from the gate (or the tool) is an outcome, never a throw
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeAppIpcInvoker } from "./test-helpers.js";

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  app: { isPackaged: false, getPath: vi.fn(() => "") },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
  webContents: { fromId: vi.fn() },
}));

const CHANNEL = "lvis:mcp:call-tool";
const LOOPBACK_GENERATION = "generation-acme-1";
const invoke = makeAppIpcInvoker(handlers);

/**
 * One first-party plugin (`acme-cards`) running as a loopback MCP server, and one
 * external MCP server (`github`) whose `query` tool is registered gated + app-visible.
 */
async function setup() {
  handlers.clear();
  vi.clearAllMocks();

  const callFromApp = vi.fn(async () => "plugin-result");
  const invokePluginTool = vi.fn(async () => "external-result");
  const requestPluginOperationGrant = vi.fn(async () => ({
    operationGrantToken: "host-one-shot-token",
    grantId: "grant-1",
    expiresAt: Date.now() + 60_000,
  }));

  const deps = {
    pluginRuntime: {
      resolveToolOwner: vi.fn((method: string) =>
        method === "acme_open" || method === "acme_write" ? "acme-cards" : undefined),
      callFromApp,
      getPerfStats: vi.fn(() => ({})),
    },
    pluginLoopbackManager: {
      has: vi.fn((serverId: string) => serverId === "acme-cards"),
      assertCardGeneration: vi.fn(),
      readUiResource: vi.fn(),
    },
    mcpManager: {
      namespacedToolName: vi.fn((_serverId: string, toolName: string) =>
        toolName.startsWith("mcp_gh_") ? toolName : `mcp_gh_${toolName}`,
      ),
      readUiResource: vi.fn(),
      listServers: vi.fn(() => []),
    },
    toolRegistry: {
      size: 0,
      findByName: vi.fn((name: string) =>
        name === "mcp_gh_query"
          ? { name: "mcp_gh_query", mcpServerId: "github", appInvokable: true }
          : name === "acme_write"
            ? {
                name: "acme_write",
                pluginId: "acme-cards",
                operationPolicy: {
                  discriminant: "operation",
                  operations: {
                    update: {
                      kind: "write",
                      minimumRisk: "write",
                      appVisible: true,
                      requiresRead: {
                        tool: "acme_read",
                        operations: ["get"],
                        maxAgeMs: 60_000,
                      },
                    },
                  },
                },
              }
          : undefined,
      ),
    },
    getPluginToolInvoker: () => invokePluginTool,
    requestPluginOperationGrant,
    settingsService: { get: vi.fn(() => ({})) },
    auditLogger: { log: vi.fn() },
    pluginMarketplace: { list: vi.fn(async () => []) },
    refreshPluginNotifications: vi.fn(),
    getMainWindow: vi.fn(() => null),
    getAppWindows: vi.fn(() => []),
  };

  const { registerPluginsHandlers } = await import("../plugins.js");
  registerPluginsHandlers(deps as never);
  return { deps, callFromApp, invokePluginTool, requestPluginOperationGrant };
}

beforeEach(() => {
  handlers.clear();
});

describe("lvis:mcp:call-tool — sender gate", () => {
  it("rejects an unauthorized sender frame before touching the backend", async () => {
    const { deps, callFromApp, invokePluginTool } = await setup();
    const handler = handlers.get(CHANNEL)!;

    const result = await handler(
      { senderFrame: { url: "https://evil.example.com/x" } } as never,
      "acme-cards",
      "acme_open",
      {},
    );

    expect(result).toEqual({ ok: false, error: "unauthorized-frame" });
    expect(callFromApp).not.toHaveBeenCalled();
    expect(invokePluginTool).not.toHaveBeenCalled();
    expect(deps.auditLogger.log).toHaveBeenCalled(); // auditUnauthorized
  });

  it("rejects a plugin-ui-shell frame (mutating channel ⇒ host-renderer-only)", async () => {
    const { callFromApp } = await setup();
    const handler = handlers.get(CHANNEL)!;

    const result = await handler(
      { senderFrame: { url: "file:///app/plugin-ui-shell.html" } } as never,
      "acme-cards",
      "acme_open",
      {},
    );

    expect(result).toEqual({ ok: false, error: "unauthorized-frame" });
    expect(callFromApp).not.toHaveBeenCalled();
  });
});

describe("lvis:mcp:call-tool — tool-owner == serverId (enforced once, here)", () => {
  it("denies a plugin card asking for a tool its plugin does not own", async () => {
    const { deps, callFromApp } = await setup();

    const result = await invoke(
      CHANNEL,
      "acme-cards",
      "other_plugin_tool",
      {},
      LOOPBACK_GENERATION,
    );

    expect(result).toEqual({
      ok: false,
      error: "cross-server-call-denied",
      message: "Tool 'other_plugin_tool' is not owned by MCP server 'acme-cards'",
    });
    expect(callFromApp).not.toHaveBeenCalled();
    expect(deps.auditLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({ input: expect.stringContaining("cross-server call denied") }),
    );
  });

  it("denies an external card asking for a HOST BUILTIN (no mcpServerId ⇒ not owned)", async () => {
    const { invokePluginTool } = await setup();

    const result = await invoke(CHANNEL, "github", "bash", { command: "rm -rf /" });

    expect(result).toMatchObject({ ok: false, error: "cross-server-call-denied" });
    expect(invokePluginTool).not.toHaveBeenCalled();
  });

  it("denies an external card asking for ANOTHER server's tool", async () => {
    const { deps, invokePluginTool } = await setup();
    deps.toolRegistry.findByName = vi.fn(() => ({
      name: "mcp_gh_query",
      mcpServerId: "gitlab", // registry says a DIFFERENT server owns it
      appInvokable: true,
    })) as never;

    const result = await invoke(CHANNEL, "github", "query", {});

    expect(result).toMatchObject({ ok: false, error: "cross-server-call-denied" });
    expect(invokePluginTool).not.toHaveBeenCalled();
  });

  it("rejects a malformed serverId / tool name without resolving a backend", async () => {
    await setup();
    await expect(invoke(CHANNEL, "", "acme_open", {})).resolves.toMatchObject({
      ok: false,
      error: "invalid-server-id",
    });
    await expect(invoke(CHANNEL, "acme-cards", "  ", {})).resolves.toMatchObject({
      ok: false,
      error: "invalid-tool-name",
    });
  });
});

describe("lvis:mcp:call-tool — allowed calls take the gated backend", () => {
  it("routes a plugin card's own tool through PluginRuntime.callFromApp — the APP path, not the panel's callFromUi", async () => {
    const { callFromApp, invokePluginTool } = await setup();

    const result = await invoke(
      CHANNEL,
      "acme-cards",
      "acme_open",
      { id: 7 },
      LOOPBACK_GENERATION,
    );

    expect(result).toEqual({ ok: true, result: "plugin-result" });
    expect(callFromApp).toHaveBeenCalledWith("acme_open", { id: 7 }, {
      appSessionId: "mcp-app:acme-cards:0:0",
      expectedGenerationId: LOOPBACK_GENERATION,
    });
    expect(invokePluginTool).not.toHaveBeenCalled();
  });

  it("routes an external card's own tool through the gated ToolExecutor delegate (origin: mcp-app)", async () => {
    const { invokePluginTool, callFromApp } = await setup();

    const result = await invoke(CHANNEL, "github", "query", { q: "x" });

    expect(result).toEqual({ ok: true, result: "external-result" });
    expect(invokePluginTool).toHaveBeenCalledWith(
      "mcp_gh_query",
      { q: "x" },
      {
        origin: "mcp-app",
        userAction: false,
        appInvocation: { surface: "mcp-app", sessionId: "mcp-app:github:0:0" },
        expectedMcpServerId: "github",
      },
    );
    expect(callFromApp).not.toHaveBeenCalled();
  });

  it("coerces non-object args to an empty input rather than forwarding junk", async () => {
    const { callFromApp } = await setup();
    await invoke(
      CHANNEL,
      "acme-cards",
      "acme_open",
      "not-an-object",
      LOOPBACK_GENERATION,
    );
    expect(callFromApp).toHaveBeenCalledWith("acme_open", {}, {
      appSessionId: "mcp-app:acme-cards:0:0",
      expectedGenerationId: LOOPBACK_GENERATION,
    });
  });

  it("keeps a governed write grant inside main and binds it to the Host-minted card session", async () => {
    const { callFromApp, requestPluginOperationGrant } = await setup();

    const result = await invoke(
      CHANNEL,
      "acme-cards",
      "acme_write",
      {
        operation: "update",
        employeeId: "E-7",
      },
      LOOPBACK_GENERATION,
    );

    expect(result).toEqual({ ok: true, result: "plugin-result" });
    expect(requestPluginOperationGrant).toHaveBeenCalledWith({
      pluginId: "acme-cards",
      toolName: "acme_write",
      input: { operation: "update", employeeId: "E-7" },
      appSessionId: "mcp-app:acme-cards:0:0",
      origin: "mcp-app",
      expectedGenerationId: LOOPBACK_GENERATION,
    });
    expect(callFromApp).toHaveBeenCalledWith(
      "acme_write",
      { operation: "update", employeeId: "E-7" },
      {
        appSessionId: "mcp-app:acme-cards:0:0",
        operationGrantToken: "host-one-shot-token",
        expectedGenerationId: LOOPBACK_GENERATION,
      },
    );
  });

  it("turns a gate DENIAL into an outcome (never a throw across the IPC)", async () => {
    const { deps, callFromApp } = await setup();
    callFromApp.mockRejectedValueOnce(new Error("Tool execution denied by user"));

    const result = await invoke(
      CHANNEL,
      "acme-cards",
      "acme_open",
      {},
      LOOPBACK_GENERATION,
    );

    expect(result).toEqual({
      ok: false,
      error: "tool-call-failed",
      message: "Tool execution denied by user",
    });
    expect(deps.auditLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({ input: expect.stringContaining("tools/call denied or failed") }),
    );
  });
});
