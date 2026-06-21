/**
 * MCP Tool Adapter — bridges Model Context Protocol tool discovery
 * (`tools/list` response shape) into the canonical {@link Tool}
 * contract used by the §6.4 ToolRegistry.
 *
 * Every MCP server's discovered tools flow through this single named
 * adapter so the conversion contract stays in one auditable place
 * instead of being inlined at every call site.
 *
 * Host-classifies-risk (project_permission_review_redesign): the hardcoded
 * `category:"network"` below is HOST-OWNED, not self-declared. An EXTERNAL MCP
 * server is a foreign, lowest-trust network peer (`trustFromSource("mcp")` →
 * `"low"`), and the host treats every tool it exposes as a network-reaching
 * operation regardless of any annotation the server sends — MCP annotations
 * are untrusted hints ("a server can lie"). This is therefore retained as a
 * host-derived default-strict classification, distinct from the
 * `plugin-tool-from-mcp.ts` path (first-party loopback servers).
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
    // Host-derived default-strict for foreign MCP peers — see file header.
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
