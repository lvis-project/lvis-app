/**
 * MCP Tool Adapter — bridges Model Context Protocol tool discovery
 * (`tools/list` response shape) into the canonical {@link Tool}
 * contract used by the §6.4 ToolRegistry.
 *
 * Mirrors the OpenHarness `McpToolAdapter` pattern (MIT,
 * https://github.com/HKUDS/OpenHarness/blob/main/src/openharness/tools/__init__.py)
 * — every MCP server's discovered tools flow through this single
 * named adapter so the conversion contract stays in one auditable
 * place instead of being inlined at every call site.
 */
import { createDynamicTool, type Tool } from "../tools/base.js";
import type { McpToolSchema, McpUiPayload } from "./types.js";

/**
 * Convert one MCP-discovered tool schema into a {@link Tool} ready
 * for {@link ToolRegistry.register}.
 *
 * @param serverId         The MCP server identifier (becomes
 *                         `Tool.mcpServerId` for §6.4 trust governance
 *                         and §10.1 kill-switch unregistration).
 * @param namespacedName   Final registry name after governance
 *                         namespacing (e.g. `mcp_hr_query`).
 * @param schema           The raw tool schema from `tools/list`.
 * @param callTool         Callback that invokes `tools/call` with
 *                         the original (un-namespaced) tool name.
 *                         Returns the rendered text response and an optional
 *                         {@link McpUiPayload} when the server declares a UI
 *                         extension via `_meta.ui` (MCP Apps spec §3.2).
 */
export function mcpToolToTool(
  serverId: string,
  namespacedName: string,
  schema: McpToolSchema,
  callTool: (name: string, args: Record<string, unknown>) => Promise<{ text: string; uiPayload?: McpUiPayload }>,
): Tool {
  return createDynamicTool({
    name: namespacedName,
    description: schema.description,
    source: "mcp",
    category: "network",
    mcpServerId: serverId,
    jsonSchema: {
      type: "object",
      properties: schema.inputSchema.properties,
      required: schema.inputSchema.required,
    },
    execute: async (rawInput) => {
      const args = (rawInput ?? {}) as Record<string, unknown>;
      try {
        const { text, uiPayload } = await callTool(schema.name, args);
        return {
          output: text,
          isError: false,
          ...(uiPayload && { metadata: { uiPayload } }),
        };
      } catch (err) {
        return {
          output: err instanceof Error ? err.message : String(err),
          isError: true,
        };
      }
    },
  });
}
