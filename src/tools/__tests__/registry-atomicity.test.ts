import { describe, expect, it } from "vitest";
import { createDynamicTool, type Tool } from "../base.js";
import { ToolRegistry } from "../registry.js";

function tool(name: string, serverId: string): Tool {
  return createDynamicTool({
    name,
    description: `${name} from ${serverId}`,
    source: "mcp",
    category: "network",
    mcpServerId: serverId,
    jsonSchema: { type: "object", properties: {} },
    execute: async () => ({ output: serverId, isError: false }),
  });
}

describe("ToolRegistry MCP generation replacement", () => {
  it("keeps the predecessor live until one exact synchronous publish", () => {
    const registry = new ToolRegistry();
    const predecessor = tool("mcp_ep_read", "server-g1");
    const unrelated = tool("mcp_other_read", "other-server");
    registry.registerBatch([predecessor, unrelated]);

    const candidate = tool("mcp_ep_read", "server-g2");
    const prepared = registry.reserveMcpReplacement(["server-g1"], [candidate]);
    expect(registry.findByName("mcp_ep_read")?.mcpServerId).toBe("server-g1");
    expect(() => registry.register(tool("mcp_ep_read", "racer"))).toThrow(/reserved/);

    prepared.publish();
    expect(registry.findByName("mcp_ep_read")?.mcpServerId).toBe("server-g2");
    expect(registry.findByName("mcp_other_read")?.mcpServerId).toBe("other-server");
    registry.unregisterByMcp("server-g1");
    expect(registry.findByName("mcp_ep_read")?.mcpServerId).toBe("server-g2");
  });

  it("leaves the live registry unchanged when candidate validation fails", () => {
    const registry = new ToolRegistry();
    registry.register(tool("mcp_ep_read", "server-g1"));
    registry.register(createDynamicTool({
      name: "collision",
      description: "builtin",
      source: "builtin",
      category: "read",
      jsonSchema: { type: "object", properties: {} },
      execute: async () => ({ output: "ok", isError: false }),
    }));

    expect(() => registry.reserveMcpReplacement(
      ["server-g1"],
      [tool("collision", "server-g2")],
    )).toThrow(/collision/);
    expect(registry.findByName("mcp_ep_read")?.mcpServerId).toBe("server-g1");
    expect(registry.findByName("collision")?.source).toBe("builtin");
  });
});
