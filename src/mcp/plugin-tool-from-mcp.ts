/**
 * Reverse projection: a first-party plugin's discovered MCP `Tool` (from its
 * loopback `tools/list`) → the canonical {@link Tool} the §6.4 ToolRegistry and
 * the permission pipeline consume. The symmetric inverse of
 * `plugin-server-projection.ts` (manifest → MCP tool).
 *
 * Half of the `plugin-loopback-server` milestone (docs/architecture/mcp-alignment-design.md §5):
 * a migrated plugin's `pathFields` is read back from the tool's vendor-prefixed
 * `_meta["lvisai/pathFields"]`, NOT from a second direct manifest read; the
 * manifest is projected to MCP exactly once (forward).
 *
 * #885: per-tool `category` is REMOVED from the contract (Q3). The in-process
 * loopback forward projection emits none; an out-of-process plugin may still put
 * `_meta["lvisai/category"]` on the wire, but the host does NOT trust it — this
 * reverse projection ignores any wire category and registers the write-equivalent
 * default-strict baseline, with the effective category derived host-side per
 * invocation.
 * `writesToOwnSandbox` is no longer promoted (the reviewer auto-LOW keys on the
 * host-computed sandbox-containment). The per-tool `version`/`deprecatedSince`/
 * `replacedBy` fields left the Tool contract entirely (Phase-R deletions), so the
 * wire carries none and this reverse projection reads none.
 *
 * `_meta.ui.visibility` (STANDARD, not a vendor key) IS read back: it is the one
 * declaration the host honours off this wire, and it decides only MODEL EXPOSURE
 * (`Tool.modelVisible`), never whether the tool is registered. Every discovered tool
 * — app-only ones included — becomes a registry `Tool`, because that is the only way
 * a call to it can run under the host gate.
 *
 * Trust boundary: `_meta["lvisai/workerId"]` is intentionally NOT promoted to
 * `Tool.workerId` here. Loopback `tools/call` executes through
 * pluginRuntime.call(), not through a host-routed ASRT worker. Treating a
 * manifest-declared worker id as execution proof would let a plugin
 * self-attest ASRT confinement and relax reviewer risk for an unconfined call.
 *
 * Why this is NOT `mcp-tool-adapter.ts`: that adapter handles EXTERNAL/untrusted
 * MCP servers, which are foreign network peers → hardcoded `category:"network"`,
 * `source:"mcp"`, and the `mcp_{server}_` namespace. A first-party plugin's
 * loopback server is the SAME plugin: it keeps its natural tool name (no
 * namespace), `source:"plugin"`, and its `pluginId`. Neither adapter trusts a
 * plugin's self-declared category — this one applies the default-strict `"write"`
 * baseline; they otherwise diverge because the trust models differ.
 *
 * DEFAULT-STRICT (host-classifies-risk, project_permission_review_redesign):
 * #885 — the host does NOT trust a plugin's self-declared per-tool category.
 * The in-process loopback forward projection stopped emitting
 * `_meta["lvisai/category"]`, and an out-of-process plugin that still puts one
 * on the wire is ignored too, so this reverse projection unconditionally
 * registers the write-equivalent default-strict baseline. A plugin grading its
 * own danger is not a control (MCP spec: a server can lie); the effective
 * category is derived host-side per invocation (`inspectHostRisk`), never from a
 * plugin self-declaration.
 */
import { createDynamicTool, type Tool } from "../tools/base.js";
import {
  FAIL_CLOSED_SURFACE,
  parseToolSurfaces,
  type ToolSurface,
} from "../plugins/runtime/tool-visibility.js";
import { createLogger } from "../lib/logger.js";
import type { McpUiPayload } from "./types.js";

const log = createLogger("plugin-tool-from-mcp");

/** Vendor prefix for LVIS-private `_meta` keys (must mirror the forward projection). */
const LVIS_META_PREFIX = "lvisai/";

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
 * `_meta["lvisai/rawResult"]`. It is a box (`{ value }`) rather than a bare
 * value so "present but `undefined`" (a void plugin tool) is distinguishable
 * from "absent" — preserving the legacy adapter's `metadata.rawResult` presence.
 */
export type PluginMcpInvoke = (
  name: string,
  args: Record<string, unknown>,
) => Promise<{ text: string; uiPayload?: McpUiPayload; rawResult?: { value: unknown } }>;

function readPathFields(meta: Record<string, unknown>): string[] | undefined {
  // Read the SOLE LVIS-proprietary wire key, `lvisai/pathFields`. The legacy
  // reverse-DNS `xyz.lvis/pathFields` dual-read was removed: a first-party
  // plugin's loopback forward projection only ever emits the new key, and an
  // installed manifest carrying the legacy key is rejected fail-closed by the
  // manifest schema before it can reach the wire (never accepted-but-ungated).
  const value = meta[`${LVIS_META_PREFIX}pathFields`];
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
    return value as string[];
  }
  return undefined;
}

/**
 * Read the STANDARD `_meta.ui.visibility` back off the wire — the same declaration
 * the forward projection emitted explicitly, parsed by the ONE shared reader
 * (`plugins/runtime/tool-visibility.ts`) so this arm cannot drift from the manifest
 * consumers or from the external-server arm.
 *
 * ABSENT/MALFORMED ⇒ {@link FAIL_CLOSED_SURFACE} (`["model"]`, minimal governed
 * surface) + a loud warn. Unlike a foreign server — where "declared nothing" is
 * spec-conformant and takes the SEP-1865 default — a first-party plugin's tool
 * reaches this reverse projection through `parsePluginJson` (which materializes the
 * default) and `manifestToolsToMcpTools` (which always emits it), so an absent
 * declaration here is a broken producer, not a spec default. Resolving it to
 * model-only keeps the tool governed and denies the app surface rather than
 * silently widening it.
 */
function readToolSurfaces(toolName: string, meta: Record<string, unknown>): readonly ToolSurface[] {
  const ui = meta.ui;
  const raw =
    typeof ui === "object" && ui !== null && !Array.isArray(ui)
      ? (ui as Record<string, unknown>).visibility
      : undefined;
  const parsed = parseToolSurfaces(raw);
  if (parsed) return parsed;
  log.warn(
    `plugin tool '${toolName}' arrived over the loopback with no valid _meta.ui.visibility — ` +
      "projection-contract violation; applying fail-closed minimal surface [model]",
  );
  return FAIL_CLOSED_SURFACE;
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
  // #885 — the host does NOT trust a plugin's self-declared per-tool category.
  // Loopback plugins emit none; an out-of-process plugin may still put
  // `_meta["lvisai/category"]` on the wire, but it is ignored either way and
  // every plugin tool registers at the write-equivalent default-strict baseline.
  // The real per-invocation classifier is host-side `inspectHostRisk`.
  const category = "write";

  return createDynamicTool({
    name: tool.name,
    description: tool.description ?? tool.name,
    source: "plugin",
    category,
    pluginId,
    pathFields: readPathFields(meta),
    // MCP Apps `_meta.ui.visibility` ∌ "model" ⇒ app-only: the tool IS registered
    // (that is what puts its card's call under risk → reviewer/approval → audit) but
    // is subtracted from the model's tool list at the ONE model-exposure boundary,
    // `ToolRegistry.getModelVisibleTools`. `appInvokable` is deliberately NOT set on
    // this arm: the plugin loopback enforces the app-visibility MUST inside
    // `PluginRuntime.callFromApp` (`assertUiActionInvokable`, reading its own
    // manifest), which stays the single enforcement site for first-party plugins.
    modelVisible: readToolSurfaces(tool.name, meta).includes("model"),
    // #885 v6 — the wire carries no `writesToOwnSandbox`/`version`/`deprecatedSince`/
    // `replacedBy` (all Phase-R deletions from the Tool contract). The reviewer
    // auto-LOW keys on host-computed sandbox-containment, never a manifest value,
    // and `createDynamicTool` applies the default "1.0.0" tool version.
    jsonSchema: tool.inputSchema,
    isReadOnly: () => false, // unconditional write baseline — never read-only
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
