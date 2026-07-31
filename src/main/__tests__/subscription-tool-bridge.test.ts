import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SubscriptionToolBridge,
  type SubscriptionHostToolCall,
} from "../subscription-tool-bridge.js";

const bridges: SubscriptionToolBridge[] = [];

function createBridge(): SubscriptionToolBridge {
  const bridge = new SubscriptionToolBridge([{
    name: "plugin.tool search",
    description: "Search the active project.\nUse precise terms when possible.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  }]);
  bridges.push(bridge);
  return bridge;
}

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.stop()));
});

describe("SubscriptionToolBridge remote tool aliases", () => {
  it("uses Node mode for the default Electron-hosted ACP MCP child while preserving explicit command and args", async () => {
    const defaultBridge = createBridge();
    const defaultConfig = await defaultBridge.startMcpServer();

    expect(defaultConfig.command).toBe(process.execPath);
    expect(defaultConfig.args).toHaveLength(1);
    expect(defaultConfig.args[0]).toMatch(/subscription-tool-mcp-server\.js$/u);
    expect(defaultConfig.env.ELECTRON_RUN_AS_NODE).toBe("1");

    const customBridge = createBridge();
    const customConfig = await customBridge.startMcpServer({
      command: "C:\\test\\custom-mcp.exe",
      args: ["--stdio", "--test"],
    });

    expect(customConfig.command).toBe("C:\\test\\custom-mcp.exe");
    expect(customConfig.args).toEqual(["--stdio", "--test"]);
    expect(customConfig.env.ELECTRON_RUN_AS_NODE).toBe("1");
  });

  it("coalesces concurrent MCP starts into one listener", async () => {
    const bridge = createBridge();
    const internals = bridge as unknown as {
      listenMcpServer(server: Server): Promise<void>;
    };
    const originalListen = internals.listenMcpServer.bind(bridge);
    let signalListenStarted: () => void = () => {};
    const listenStarted = new Promise<void>((resolve) => {
      signalListenStarted = resolve;
    });
    let releaseListen: () => void = () => {};
    const listenReleased = new Promise<void>((resolve) => {
      releaseListen = resolve;
    });
    let createdServer: Server | undefined;
    const listenSpy = vi.spyOn(internals, "listenMcpServer").mockImplementation(async (server) => {
      createdServer = server;
      signalListenStarted();
      await listenReleased;
      await originalListen(server);
    });
    try {
      const first = bridge.startMcpServer();
      await listenStarted;
      const second = bridge.startMcpServer({
        command: "C:\\ignored\\second.exe",
        args: ["--second"],
      });
      expect(listenSpy).toHaveBeenCalledOnce();
      releaseListen();

      const [firstConfig, secondConfig] = await Promise.all([first, second]);
      expect(secondConfig).toBe(firstConfig);
      expect(secondConfig.command).toBe(process.execPath);
      expect(createdServer?.listening).toBe(true);
    } finally {
      releaseListen();
      listenSpy.mockRestore();
    }
  });

  it("settles stop when close wins after listen starts but before its ready callback", async () => {
    const bridge = createBridge();
    const internals = bridge as unknown as {
      mcpStartingServer: Server | null;
    };
    // startMcpServer has synchronously called Server.listen by the time it
    // returns, but Node has not yet run its listen callback in this stack.
    const startResult = bridge.startMcpServer().then(
      () => undefined,
      (error: unknown) => error,
    );
    const startingServer = internals.mcpStartingServer;
    expect(startingServer).not.toBeNull();

    await bridge.stop();

    await expect(startResult).resolves.toMatchObject({ message: "subscription-host-tool-unavailable" });
    expect(startingServer?.listening).toBe(false);
    await expect(bridge.startMcpServer()).rejects.toThrow("subscription-host-tool-unavailable");
  });

  it("exposes a Codex/ACP-safe alias while dispatching the original LVIS name", async () => {
    const bridge = createBridge();
    const [remoteTool] = bridge.tools;
    if (!remoteTool) throw new Error("missing bridged tool");

    expect(remoteTool.name).not.toBe("plugin.tool search");
    expect(remoteTool.name).toMatch(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/u);
    expect(remoteTool.description).toBe(
      "Search the active project.\nUse precise terms when possible.",
    );

    const handler = vi.fn(async (call: SubscriptionHostToolCall) => {
      expect(call.id).toMatch(/^subscription_[A-Za-z0-9-]+$/u);
      expect(call.name).toBe("plugin.tool search");
      expect(call.input).toEqual({ query: "schema alias" });
      return "LVIS accepted the governed tool request.";
    });
    bridge.setHandler(handler);

    await expect(bridge.invoke(remoteTool.name, { query: "schema alias" })).resolves.toBe(
      "LVIS accepted the governed tool request.",
    );
    expect(handler).toHaveBeenCalledOnce();
  });

  it.each(["_workspace_search", "9workspace_search"])(
    "aliases a non-MCP-safe leading character in %s and dispatches the original LVIS name",
    async (originalName) => {
      const bridge = new SubscriptionToolBridge([{
        name: originalName,
        description: "Search the active workspace.",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      }]);
      bridges.push(bridge);
      const [remoteTool] = bridge.tools;
      if (!remoteTool) throw new Error("missing bridged tool");

      expect(remoteTool.name).toMatch(/^lvis_[a-f0-9]{48}$/u);
      expect(remoteTool.name).not.toBe(originalName);

      const handler = vi.fn(async (call: SubscriptionHostToolCall) => {
        expect(call.name).toBe(originalName);
        expect(call.input).toEqual({ query: "alias round trip" });
        return "LVIS accepted the governed tool request.";
      });
      bridge.setHandler(handler);

      await expect(bridge.invoke(remoteTool.name, { query: "alias round trip" })).resolves.toBe(
        "LVIS accepted the governed tool request.",
      );
      expect(handler).toHaveBeenCalledOnce();
    },
  );

  it("rejects original, unsafe, and unknown aliases without invoking the LVIS handler", async () => {
    const bridge = createBridge();
    const handler = vi.fn(async () => "must not execute");
    bridge.setHandler(handler);

    await expect(bridge.invoke("plugin.tool search", { query: "original name is private" })).rejects.toThrow(
      "subscription-host-tool-invalid",
    );
    await expect(bridge.invoke("unsafe.alias", { query: "dot is not a remote alias" })).rejects.toThrow(
      "subscription-host-tool-invalid",
    );
    await expect(bridge.invoke("lvis_unknown_alias", { query: "unknown safe alias" })).rejects.toThrow(
      "subscription-host-tool-invalid",
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects descriptions beyond the shared Codex and ACP limit before opening a runtime", () => {
    expect(() => new SubscriptionToolBridge([{
      name: "describe_project",
      description: "x".repeat(1_025),
      inputSchema: {
        type: "object",
        properties: {},
      },
    }])).toThrow("subscription-host-tool-schema-invalid");
  });

  it("rejects a schema larger than the MCP shim limit before opening a runtime", () => {
    expect(() => new SubscriptionToolBridge([{
      name: "oversized_schema",
      description: "Reject oversized schema before ACP receives it.",
      inputSchema: {
        type: "object",
        properties: {
          payload: {
            type: "string",
            description: "x".repeat(64 * 1024),
          },
        },
      },
    }])).toThrow("subscription-host-tool-schema-invalid");
  });

  it("rejects arguments larger than the MCP shim limit before invoking LVIS", async () => {
    const bridge = new SubscriptionToolBridge([{
      name: "write_large_payload",
      description: "Write a governed payload.",
      inputSchema: {
        type: "object",
        properties: {
          first: { type: "string" },
          second: { type: "string" },
        },
      },
    }]);
    bridges.push(bridge);
    const [remoteTool] = bridge.tools;
    if (!remoteTool) throw new Error("missing bridged tool");
    const handler = vi.fn(async () => "must not execute");
    bridge.setHandler(handler);

    await expect(bridge.invoke(remoteTool.name, {
      first: "x".repeat(64 * 1024),
      second: "y".repeat(64 * 1024),
    })).rejects.toThrow("subscription-host-tool-invalid");
    expect(handler).not.toHaveBeenCalled();
  });
});
