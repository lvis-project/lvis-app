import { describe, expect, it, vi } from "vitest";
import { registerBuiltinTools } from "../../boot/tools.js";
import { ToolRegistry } from "../../tools/registry.js";
import { rebuildToolSchemas } from "../../engine/turn/tool-scope.js";
import { unusedNetworkFetch } from "../../__tests__/support/network-fetch-stubs.js";
import { SubscriptionToolBridge } from "../subscription-tool-bridge.js";
import { readSubscriptionToolMcpServerConfig, SubscriptionToolBridgeClient } from "../subscription-tool-mcp-server.js";

describe("subscription builtin tool descriptions", () => {
  it("preserves registered workflow tool schemas through the real bridge and tool listing", async () => {
    const registry = new ToolRegistry();
    const settings = {
      get: () => ({ provider: "duckduckgo" }),
      getSecret: () => null,
    } as unknown as Parameters<typeof registerBuiltinTools>[1];
    registerBuiltinTools(registry, settings, {
      networkFetch: unusedNetworkFetch,
      singleHopNetworkFetch: unusedNetworkFetch,
      getAskUserQuestionGate: () => undefined,
      getSubAgentRunner: () => undefined,
      emitAgentSpawn: vi.fn(),
    });
    const schemas = rebuildToolSchemas(registry, {
      activePluginIds: new Set(), activeToolNames: new Set(), forcedToolNames: new Set(),
      includeBuiltins: true, includeMcp: false, includeEgress: true, deferral: true,
    });
    expect(schemas.map(tool => tool.name)).toEqual(expect.arrayContaining([
      "render_html", "ask_user_question", "agent_spawn",
    ]));
    const bridge = new SubscriptionToolBridge(schemas);
    try {
      expect(bridge.tools).toEqual(schemas);
      const config = await bridge.startMcpServer();
      const client = new SubscriptionToolBridgeClient(readSubscriptionToolMcpServerConfig(config.env));
      expect(await client.listTools()).toEqual(schemas);
    } finally {
      await bridge.stop();
    }
  });
});
