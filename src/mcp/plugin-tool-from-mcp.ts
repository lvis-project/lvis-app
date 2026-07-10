/**
 * Reverse projection: a first-party plugin's discovered MCP `Tool` (from its
 * loopback `tools/list`) → the canonical {@link Tool} the §6.4 ToolRegistry and
 * the permission pipeline consume. The symmetric inverse of
 * `plugin-server-projection.ts` (manifest → MCP tool).
 *
 * Half of the `plugin-loopback-server` milestone (docs/architecture/mcp-alignment-design.md §5):
 * a migrated plugin's `pathFields` is read back from the tool's reverse-DNS
 * `_meta["xyz.lvis/pathFields"]`, NOT from a second direct manifest read; the
 * manifest is projected to MCP exactly once (forward).
 *
 * #885 v6: `category` is REMOVED from the contract (Q3) — the wire carries none,
 * so this reverse projection registers the write-equivalent default-strict
 * baseline and the effective category is derived host-side per invocation.
 * `writesToOwnSandbox` is no longer promoted (the reviewer auto-LOW keys on the
 * host-computed sandbox-containment). The per-tool `version`/`deprecatedSince`/
 * `replacedBy` fields left the Tool contract entirely (Phase-R deletions), so the
 * wire carries none and this reverse projection reads none.
 *
 * Trust boundary: `_meta["xyz.lvis/workerId"]` is intentionally NOT promoted to
 * `Tool.workerId` here. Loopback `tools/call` executes through
 * pluginRuntime.call(), not through a host-routed ASRT worker. Treating a
 * manifest-declared worker id as execution proof would let a plugin
 * self-attest ASRT confinement and relax reviewer risk for an unconfined call.
 *
 * Why this is NOT `mcp-tool-adapter.ts`: that adapter handles EXTERNAL/untrusted
 * MCP servers, which are foreign network peers → hardcoded `category:"network"`,
 * `source:"mcp"`, and the `mcp_{server}_` namespace. A first-party plugin's
 * loopback server is the SAME plugin: it keeps its natural tool name (no
 * namespace), `source:"plugin"`, its `pluginId`, and its DECLARED category. The
 * two adapters intentionally diverge because the trust models differ.
 *
 * DEFAULT-STRICT (host-classifies-risk, project_permission_review_redesign):
 * a tool whose `_meta` carries no valid `xyz.lvis/category` no longer throws.
 * A plugin grading its own danger is not a control (MCP spec: a server can
 * lie), so a missing/invalid declaration is treated as `"write"` — the safe,
 * write-equivalent baseline that asks foreground / routes to the reviewer
 * headless. The authoritative effective category is derived host-side per
 * invocation (`inspectHostRisk`); the declared value recorded here (or the
 * strict default when absent) feeds shadow-mode reconciliation only.
 */
import { createDynamicTool, type Tool } from "../tools/base.js";
import type { PluginToolCategory } from "../plugins/types.js";
import { createLogger } from "../lib/logger.js";
import type { McpUiPayload } from "./types.js";

const log = createLogger("plugin-tool-from-mcp");

/** Reverse-DNS prefix for LVIS-private `_meta` keys (must mirror the forward projection). */
const LVIS_META_PREFIX = "xyz.lvis/";

const PLUGIN_TOOL_CATEGORIES: readonly PluginToolCategory[] = ["read", "write", "shell", "network"];

/**
 * Write-equivalent baseline applied when a discovered plugin tool declares no
 * authoritative category. The deliberate safe default, NOT a bug-papering
 * fallback: the host never auto-classifies an undeclared tool down to read.
 */
const DEFAULT_STRICT_CATEGORY: PluginToolCategory = "write";

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

function readCategory(meta: Record<string, unknown>, toolName: string): PluginToolCategory {
  const value = meta[`${LVIS_META_PREFIX}category`];
  if (typeof value === "string" && (PLUGIN_TOOL_CATEGORIES as readonly string[]).includes(value)) {
    return value as PluginToolCategory;
  }
  // #885 v6 — `category` is structurally REMOVED from the contract (Q3), so an
  // ABSENT category is the expected steady state (every tool, every load) — warn
  // there would spam ~60+ lines per boot forever. Warn ONLY on a PRESENT-but-
  // malformed declaration (a real error); stay silent on the v6-expected absent
  // case. Either way the write-equivalent default-strict baseline applies; the
  // host derives the effective category per invocation (`inspectHostRisk`).
  if (value !== undefined) {
    log.warn(
      {
        event: "plugin-tool-invalid-category",
        toolName,
        declared: value,
        declaredType: typeof value,
        appliedDefault: DEFAULT_STRICT_CATEGORY,
      },
      "discovered plugin tool declares a malformed category — applying default-strict baseline",
    );
  }
  return DEFAULT_STRICT_CATEGORY;
}

function readPathFields(meta: Record<string, unknown>): string[] | undefined {
  const value = meta[`${LVIS_META_PREFIX}pathFields`];
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
    return value as string[];
  }
  return undefined;
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
    // #885 v6 — the wire carries no `writesToOwnSandbox`/`version`/`deprecatedSince`/
    // `replacedBy` (all Phase-R deletions from the Tool contract). The reviewer
    // auto-LOW keys on host-computed sandbox-containment, never a manifest value,
    // and `createDynamicTool` applies the default "1.0.0" tool version.
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
