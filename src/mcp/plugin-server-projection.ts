/**
 * Pure projection: an LVIS normalized {@link PluginManifest} `Tool[]` → the
 * MCP `2026-07-28` RC server shapes a plugin-as-MCP-server exposes
 * (`server/discover`'s `DiscoverResult` and `tools/list`'s `Tool[]`).
 *
 * #885 v6 — the manifest tool object IS the wire shape (manifest == wire, Q5),
 * so the forward projection is near-identity. Its only jobs are:
 *  - filter to MODEL-visible tools — app-only (the auth trio, UI-only methods)
 *    must NEVER enter the LLM ToolRegistry via the loopback (the #1554
 *    registry-exclusion invariant); "was in tools[]" ⇔ `model ∈ visibility`.
 *  - emit `_meta.ui.visibility` EXPLICITLY (SoT §2.2 "the wire projection always
 *    emits visibility explicitly").
 *  - construct `_meta` from a WHITELIST so no stray/removed proprietary key
 *    (category / version / writesToOwnSandbox / workerId / deprecation) can ride
 *    the wire — they simply have nowhere to come from.
 *
 * This module is intentionally PURE (no I/O, no host deps). The host still
 * DERIVES its own interop annotations elsewhere and never reads inbound
 * (untrusted) `annotations` — plugin-authored annotations are exactly the
 * self-claims Q4 removed (MCP "annotations untrusted", design §2.2).
 *
 * Key invariants:
 *  - `_meta` keys use the `lvisai/` prefix; per §8 any prefix whose second
 *    label is `mcp`/`modelcontextprotocol` is RESERVED for MCP.
 *  - `inputSchema` dialect moves to JSON Schema 2020-12 (a relabel — LVIS plugin
 *    tool schemas use a 2020-12 subset, no `$ref` network deref).
 *  - `manifest.capabilities[]` (advisory kebab-case dependency tags) are
 *    LVIS-internal and are NOT projected into MCP `ServerCapabilities`.
 */
import type { PluginManifest, Tool as McpTool } from "../plugins/types.js";
import { toolVisibility, isModelVisible } from "../plugins/runtime/tool-visibility.js";
import { observeLegacyMetaKey } from "./legacy-meta-telemetry.js";

/** The RC protocol revision LVIS plugin-servers speak. */
const MCP_PROTOCOL_VERSION = "2026-07-28";

/** JSON Schema 2020-12 dialect URI (the RC default for tool inputSchema). */
const JSON_SCHEMA_2020_12 = "https://json-schema.org/draft/2020-12/schema";

/**
 * An MCP `Tool` projected from one normalized `Tool`. #885 v6 — `annotations` is
 * DROPPED (the host never projects plugin-authored ones) and `_meta` is narrowed
 * to exactly the standard visibility block + the single kept LVIS-proprietary key
 * (`lvisai/pathFields`).
 */
export interface McpToolProjection {
  name: string;
  title?: string;
  description: string;
  inputSchema: {
    $schema: string;
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  outputSchema?: McpTool["outputSchema"];
  icons?: McpTool["icons"];
  _meta: {
    ui: { visibility: Array<"model" | "app"> };
    "lvisai/pathFields"?: string[];
  };
}

/** A `server/discover` `DiscoverResult` projected from a plugin manifest. */
export interface McpDiscoverProjection {
  resultType: "complete";
  supportedVersions: string[];
  serverInfo: { name: string; version: string; description: string };
  capabilities: {
    tools?: { listChanged: boolean };
    extensions?: Record<string, unknown>;
  };
  instructions: string;
}

/**
 * Project ONE normalized `Tool` to the MCP wire shape. The tool object IS already
 * the wire shape (manifest == wire, Q5), so this is near-identity: it makes
 * `_meta.ui.visibility` explicit and builds `_meta` from a whitelist so no
 * stray/removed proprietary key can ride the wire. `outputSchema` (standard MCP)
 * is passed through verbatim when present.
 */
function toWireTool(tool: McpTool, pluginId: string): McpToolProjection {
  const meta: McpToolProjection["_meta"] = { ui: { visibility: toolVisibility(tool) } };
  // Read the authored manifest key, preferring the new `lvisai/pathFields`;
  // transitional: fall back to the legacy `xyz.lvis/pathFields` until published
  // plugin manifests are migrated (then remove the fallback). The WIRE always
  // emits ONLY the new key below. This site reads the ON-DISK manifest, so a legacy
  // hit here is the signal that this installed plugin has not yet rolled forward —
  // the observable removal gate for the schema's legacy property.
  const pathFields = tool._meta?.["lvisai/pathFields"];
  const legacyPathFields = tool._meta?.["xyz.lvis/pathFields"];
  if (pathFields !== undefined) {
    meta["lvisai/pathFields"] = pathFields;
  } else if (legacyPathFields !== undefined) {
    observeLegacyMetaKey(pluginId, "pathFields");
    meta["lvisai/pathFields"] = legacyPathFields;
  }
  return {
    name: tool.name,
    ...(tool.title !== undefined ? { title: tool.title } : {}),
    description: tool.description ?? tool.name,
    inputSchema: { ...tool.inputSchema, $schema: JSON_SCHEMA_2020_12 },
    ...(tool.outputSchema !== undefined ? { outputSchema: tool.outputSchema } : {}),
    ...(tool.icons !== undefined ? { icons: tool.icons } : {}),
    _meta: meta,
  };
}

/**
 * Project the manifest's declared tools to MCP `Tool[]`. #885 v6 — filter to
 * MODEL-visible tools: app-only (auth trio, UI-only methods) must NOT enter the
 * LLM ToolRegistry via the loopback (the #1554 registry-exclusion invariant).
 * Every `Tool` has a mandatory `inputSchema`, so this reproduces the old
 * {name ∈ tools[] ∧ has schema} output set exactly — registry contents identical.
 */
export function manifestToolsToMcpTools(manifest: PluginManifest): McpToolProjection[] {
  return (manifest.tools ?? []).filter(isModelVisible).map((t) => toWireTool(t, manifest.id));
}

/**
 * Project a plugin manifest to a `server/discover` `DiscoverResult`. Capability
 * flags are derived from what the plugin actually contributes (tools present →
 * `tools.listChanged`; UI extension → the MCP Apps extension). `manifest.capabilities[]`
 * is NOT projected — it is LVIS-internal dependency metadata, not MCP
 * `ServerCapabilities` (§3.2).
 */
export function manifestToDiscoverResult(manifest: PluginManifest): McpDiscoverProjection {
  const capabilities: McpDiscoverProjection["capabilities"] = {};
  if ((manifest.tools?.length ?? 0) > 0) {
    capabilities.tools = { listChanged: true };
  }
  const extensions: Record<string, unknown> = {};
  if ((manifest.ui?.length ?? 0) > 0) {
    extensions["io.modelcontextprotocol/ui"] = { mimeTypes: ["text/html;profile=mcp-app"] };
  }
  if (Object.keys(extensions).length > 0) {
    capabilities.extensions = extensions;
  }
  return {
    resultType: "complete",
    supportedVersions: [MCP_PROTOCOL_VERSION],
    serverInfo: {
      name: manifest.name ?? manifest.id,
      version: manifest.version,
      description: manifest.description,
    },
    capabilities,
    instructions: manifest.description,
  };
}
