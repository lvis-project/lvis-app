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
import type { McpToolSchema, McpUiPayload, McpUiToolVisibility } from "./types.js";

/**
 * MCP Apps spec default when a server declares no `_meta.ui.visibility`:
 * `["model","app"]` — visible to the agent AND callable by the server's own app.
 */
const SPEC_DEFAULT_VISIBILITY: readonly McpUiToolVisibility[] = ["model", "app"];

/**
 * The ONE site that materializes an external MCP tool's app-visibility (the
 * `parsePluginJson` U1 analog for foreign servers). Downstream readers — the
 * `oncalltool` external backend is the only one — read the resulting boolean and
 * never re-default.
 *
 * Applying the SPEC DEFAULT (not a stricter fail-closed `["model"]`) is
 * deliberate: a spec-conformant server that declares nothing still expects its
 * own app to reach its tools, and the actual protection for those calls is the
 * host risk/consent gate the call is routed through — not this flag. A malformed
 * declaration (not an array of the two known literals) IS treated as fail-closed:
 * an unrecognized shape must not silently widen the app surface.
 */
function isAppInvokable(schema: McpToolSchema): boolean {
  const declared = schema._meta?.ui?.visibility;
  if (declared === undefined) return SPEC_DEFAULT_VISIBILITY.includes("app");
  if (!Array.isArray(declared) || declared.some((v) => v !== "model" && v !== "app")) {
    return false;
  }
  return declared.includes("app");
}

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
    // MCP Apps `_meta.ui.visibility` ∋ "app" — the spec's gate on this server's
    // OWN app calling this tool (`oncalltool`). Materialized here, once.
    appInvokable: isAppInvokable(schema),
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
