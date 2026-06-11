/**
 * Reverse projection: a first-party plugin's discovered MCP `Tool` (from its
 * loopback `tools/list`) → the canonical {@link Tool} the §6.4 ToolRegistry and
 * the permission pipeline consume. The symmetric inverse of
 * `plugin-server-projection.ts` (manifest → MCP tool).
 *
 * This is the "category SOT from `_meta`" half of the `plugin-loopback-server`
 * milestone (docs/architecture/mcp-alignment-design.md §5): a migrated plugin's
 * permission-relevant authority — category / pathFields / writesToOwnSandbox /
 * version / deprecation — is read back from the tool's reverse-DNS `xyz.lvis/*`
 * `_meta`, NOT from a second direct manifest read. The manifest is projected to
 * MCP exactly once (forward), and host policy still reads a single authoritative
 * `category` — now carried in `_meta` rather than the raw manifest field.
 *
 * Why this is NOT `mcp-tool-adapter.ts`: that adapter handles EXTERNAL/untrusted
 * MCP servers, which are foreign network peers → hardcoded `category:"network"`,
 * `source:"mcp"`, and the `mcp_{server}_` namespace. A first-party plugin's
 * loopback server is the SAME plugin: it keeps its natural tool name (no
 * namespace), `source:"plugin"`, its `pluginId`, and its DECLARED category. The
 * two adapters intentionally diverge because the trust models differ.
 *
 * Fail-closed: a tool whose `_meta` carries no valid `xyz.lvis/category` throws
 * here — exactly as `buildPluginTool` throws on a missing category — so an
 * authority-less plugin tool can never register with a silent default.
 */
import { createDynamicTool, type Tool } from "../tools/base.js";
import type { PluginToolCategory } from "../plugins/types.js";
import type { McpUiPayload } from "./types.js";

/** Reverse-DNS prefix for LVIS-private `_meta` keys (must mirror the forward projection). */
const LVIS_META_PREFIX = "xyz.lvis/";

const PLUGIN_TOOL_CATEGORIES: readonly PluginToolCategory[] = ["read", "write", "shell", "network"];

/**
 * The minimal shape this adapter consumes from a discovered MCP tool. Over a
 * real transport `_meta` arrives as an opaque `Record<string, unknown>`, so
 * every authority field is read defensively rather than trusting a wire type.
 */
export interface DiscoveredMcpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

/**
 * Invoke the plugin's tool over its MCP server (the loopback `tools/call`).
 * Mirrors {@link McpClient.callTool}: returns the rendered text (+ optional MCP
 * Apps UI payload) and THROWS on a tool error, which this adapter surfaces as an
 * `isError` {@link ToolResult}.
 *
 * `rawResult` is the boxed structured plugin return value carried back via
 * `_meta["xyz.lvis/rawResult"]`. It is a box (`{ value }`) rather than a bare
 * value so "present but `undefined`" (a void plugin tool) is distinguishable
 * from "absent" — preserving the legacy adapter's `metadata.rawResult` presence.
 */
export type PluginMcpInvoke = (
  name: string,
  args: Record<string, unknown>,
) => Promise<{ text: string; uiPayload?: McpUiPayload; rawResult?: { value: unknown } }>;

function readString(meta: Record<string, unknown>, key: string): string | undefined {
  const value = meta[`${LVIS_META_PREFIX}${key}`];
  return typeof value === "string" ? value : undefined;
}

function readCategory(meta: Record<string, unknown>, toolName: string): PluginToolCategory {
  const value = meta[`${LVIS_META_PREFIX}category`];
  if (typeof value === "string" && (PLUGIN_TOOL_CATEGORIES as readonly string[]).includes(value)) {
    return value as PluginToolCategory;
  }
  throw new Error(
    `Discovered plugin tool '${toolName}' has no authoritative '${LVIS_META_PREFIX}category' in _meta ` +
      `(got ${JSON.stringify(value)}); refusing to register without a category (fail-closed).`,
  );
}

function readPathFields(meta: Record<string, unknown>): string[] | undefined {
  const value = meta[`${LVIS_META_PREFIX}pathFields`];
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
    return value as string[];
  }
  return undefined;
}

function readBoolean(meta: Record<string, unknown>, key: string): boolean | undefined {
  const value = meta[`${LVIS_META_PREFIX}${key}`];
  return typeof value === "boolean" ? value : undefined;
}

/**
 * Convert one discovered first-party plugin MCP tool into a canonical
 * {@link Tool}. `pluginId` is the owning plugin (becomes `Tool.pluginId` for the
 * §6.3 permission pipeline); `invoke` performs the actual `tools/call`.
 */
export function mcpToolToPluginTool(
  pluginId: string,
  tool: DiscoveredMcpTool,
  invoke: PluginMcpInvoke,
): Tool {
  const meta = tool._meta ?? {};
  const category = readCategory(meta, tool.name);

  return createDynamicTool({
    name: tool.name,
    description: tool.description ?? tool.name,
    source: "plugin",
    category,
    pluginId,
    pathFields: readPathFields(meta),
    writesToOwnSandbox: readBoolean(meta, "writesToOwnSandbox"),
    version: readString(meta, "version"),
    deprecatedSince: readString(meta, "deprecatedSince"),
    replacedBy: readString(meta, "replacedBy"),
    jsonSchema: tool.inputSchema,
    isReadOnly: () => category === "read",
    execute: async (rawInput) => {
      let parsed: unknown = rawInput ?? {};
      if (typeof parsed === "string") {
        try {
          parsed = JSON.parse(parsed);
        } catch {
          /* leave as string; the plugin server validates */
        }
      }
      const args = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<string, unknown>;
      try {
        const { text, uiPayload, rawResult } = await invoke(tool.name, args);
        // Preserve the legacy `metadata.rawResult` / `metadata.uiPayload` channel
        // (executor.ts + boot.ts read rawResult). rawResult is present iff the
        // call succeeded, matching buildPluginTool's success-only metadata.
        const metadata: Record<string, unknown> = {};
        if (uiPayload) metadata.uiPayload = uiPayload;
        if (rawResult) metadata.rawResult = rawResult.value;
        return {
          output: text,
          isError: false,
          ...(Object.keys(metadata).length > 0 && { metadata }),
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
