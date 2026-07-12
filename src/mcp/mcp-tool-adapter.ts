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
 *
 * EVERY discovered tool is registered, including an app-only one — that is what
 * puts its card's `tools/call` under `inspectHostRisk` → reviewer/approval → audit.
 * Registration is NOT model exposure: `modelVisible` (below) is what subtracts an
 * app-only tool from the list the LLM is shown, and it is enforced in ONE place
 * (`ToolRegistry.getModelVisibleTools`), identically for this arm and the plugin
 * loopback arm.
 */
import { createDynamicTool, type Tool } from "../tools/base.js";
import {
  FAIL_CLOSED_SURFACE,
  parseToolSurfaces,
  type ToolSurface,
} from "../plugins/runtime/tool-visibility.js";
import type { McpToolSchema, McpUiPayload } from "./types.js";

/**
 * MCP Apps spec default when a server declares no `_meta.ui.visibility`:
 * `["model","app"]` — visible to the agent AND callable by the server's own app.
 */
const SPEC_DEFAULT_VISIBILITY: readonly ToolSurface[] = ["model", "app"];

/**
 * The ONE site that materializes an external MCP tool's SURFACE (the
 * `parsePluginJson` U1 analog for foreign servers). Both derived bits —
 * `Tool.appInvokable` and `Tool.modelVisible` — come from this one read, and no
 * downstream reader re-defaults.
 *
 * Applying the SPEC DEFAULT for an ABSENT declaration (not a stricter fail-closed
 * `["model"]`) is deliberate: a spec-conformant server that declares nothing still
 * expects its own app to reach its tools, and the actual protection for those calls
 * is the host risk/consent gate the call is routed through — not this flag. A
 * MALFORMED declaration falls back to the shared {@link FAIL_CLOSED_SURFACE}
 * (`["model"]`, the same minimal governed surface the plugin arm applies): an
 * unrecognized shape must not silently widen the app surface, and the tool stays
 * LLM-reachable through the governed executor.
 */
function toolSurfaces(schema: McpToolSchema): readonly ToolSurface[] {
  const declared = schema._meta?.ui?.visibility;
  if (declared === undefined) return SPEC_DEFAULT_VISIBILITY;
  return parseToolSurfaces(declared) ?? FAIL_CLOSED_SURFACE;
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
  const surfaces = toolSurfaces(schema);
  return createDynamicTool({
    name: namespacedName,
    description: schema.description,
    source: "mcp",
    // Host-derived default-strict for foreign MCP peers — see file header.
    category: "network",
    mcpServerId: serverId,
    // MCP Apps `_meta.ui.visibility` ∋ "app" — the spec's gate on this server's
    // OWN app calling this tool (`oncalltool`). Materialized here, once.
    appInvokable: surfaces.includes("app"),
    // …and ∋ "model" — the spec's OTHER half. The tool is registered either way
    // (an app-only tool must run under the same host gate as any other, which
    // requires a registry `Tool`); this bit is what keeps an app-only tool out of
    // the list handed to the LLM. Registered ≠ exposed.
    modelVisible: surfaces.includes("model"),
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
