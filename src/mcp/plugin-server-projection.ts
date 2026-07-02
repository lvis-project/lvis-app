/**
 * Pure projection: an LVIS {@link PluginManifest} / `toolSchemas` → the MCP
 * `2026-07-28` RC server shapes a plugin-as-MCP-server exposes
 * (`server/discover`'s `DiscoverResult` and `tools/list`'s `Tool[]`).
 *
 * Design: docs/architecture/mcp-alignment-design.md §3.2 (manifest → discover)
 * and §3.3 (toolSchemas → Tool), against the verified §8 wire shapes.
 *
 * This module is intentionally PURE (no I/O, no host deps) — it is the spec'd
 * transformation that the `plugin-loopback-server` milestone wires into a real
 * per-plugin MCP server. Keeping it pure makes the contract independently
 * testable before any runtime wiring.
 *
 * Key invariants:
 *  - **Category is the authoritative policy SOT**, carried under reverse-DNS
 *    `_meta["xyz.lvis/category"]`. MCP `ToolAnnotations` are ALSO projected, but
 *    they are interop hints only — host policy reads `_meta`, never the
 *    (untrusted) annotations (design §3.3, §8 "annotations untrusted").
 *  - `_meta` keys use the `xyz.lvis/` prefix; per §8 any prefix whose second
 *    label is `mcp`/`modelcontextprotocol` is RESERVED for MCP, so LVIS keys
 *    MUST NOT use those.
 *  - `inputSchema` dialect moves draft-07 → JSON Schema 2020-12 (a relabel —
 *    LVIS plugin tool schemas use a 2020-12 subset, no `$ref` network deref).
 *  - `manifest.capabilities[]` (the advisory kebab-case dependency tags) are
 *    LVIS-internal and are NOT projected into MCP `ServerCapabilities`.
 */
import type { PluginManifest, PluginToolCategory } from "../plugins/types.js";

/** The RC protocol revision LVIS plugin-servers speak. */
const MCP_PROTOCOL_VERSION = "2026-07-28";

/** Reverse-DNS prefix for LVIS-private `_meta` keys (second label ≠ mcp). */
const LVIS_META_PREFIX = "xyz.lvis/";

/** JSON Schema 2020-12 dialect URI (the RC default for tool inputSchema). */
const JSON_SCHEMA_2020_12 = "https://json-schema.org/draft/2020-12/schema";

/**
 * Write-equivalent baseline used when a `toolSchemas` entry omits `category`
 * (host-classifies-risk, project_permission_review_redesign). The declared
 * category is optional and advisory; when absent the host projects the safe,
 * write-equivalent default rather than rejecting the manifest. Never read.
 */
const DEFAULT_STRICT_CATEGORY: PluginToolCategory = "write";

/** MCP `ToolAnnotations` (hints only — NOT authoritative). */
export interface McpToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

/** An MCP `Tool` projected from one LVIS `toolSchemas` entry. */
export interface McpToolProjection {
  name: string;
  description: string;
  inputSchema: {
    $schema: string;
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  annotations: McpToolAnnotations;
  _meta: Record<string, unknown>;
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

type ToolSchemaEntry = NonNullable<PluginManifest["toolSchemas"]>[string];

/**
 * Project the LVIS permission `category` to MCP `ToolAnnotations` hints. The
 * mapping is deliberately conservative (writes/shell are destructive; only
 * `read` is read-only/idempotent; `network` opens the world). These are
 * interop hints; the authoritative category lives in `_meta` (§3.3).
 */
export function annotationsForCategory(category: PluginToolCategory): McpToolAnnotations {
  return {
    readOnlyHint: category === "read",
    destructiveHint: category === "write" || category === "shell",
    idempotentHint: category === "read",
    openWorldHint: category === "network",
  };
}

/**
 * Project one `toolSchemas[name]` entry to an MCP `Tool`. `manifestVersion` is
 * the per-tool version fallback (a tool without its own `version` inherits the
 * manifest version — §6.4).
 */
export function toolSchemaToMcpTool(
  name: string,
  entry: ToolSchemaEntry,
  manifestVersion: string,
): McpToolProjection {
  const inputSchema = { ...entry.inputSchema, $schema: JSON_SCHEMA_2020_12 };

  // `category` is now optional (host-classifies-risk). When the plugin omits
  // it, project the write-equivalent default-strict baseline so the manifest
  // still loads and the reverse adapter reads a valid category. The host never
  // trusts this value as the authority — it derives the effective category per
  // invocation — but it remains the declared value for shadow reconciliation.
  const declaredCategory: PluginToolCategory = entry.category ?? DEFAULT_STRICT_CATEGORY;

  const meta: Record<string, unknown> = {
    [`${LVIS_META_PREFIX}category`]: declaredCategory,
    [`${LVIS_META_PREFIX}version`]: entry.version ?? manifestVersion,
  };
  if (entry.pathFields !== undefined) meta[`${LVIS_META_PREFIX}pathFields`] = entry.pathFields;
  if (entry.workerId !== undefined) meta[`${LVIS_META_PREFIX}workerId`] = entry.workerId;
  if (entry.writesToOwnSandbox !== undefined) meta[`${LVIS_META_PREFIX}writesToOwnSandbox`] = entry.writesToOwnSandbox;
  if (entry.deprecatedSince !== undefined) meta[`${LVIS_META_PREFIX}deprecatedSince`] = entry.deprecatedSince;
  if (entry.replacedBy !== undefined) meta[`${LVIS_META_PREFIX}replacedBy`] = entry.replacedBy;

  return {
    name,
    description: entry.description,
    inputSchema,
    annotations: annotationsForCategory(declaredCategory),
    _meta: meta,
  };
}

/**
 * Project the manifest's declared tools to MCP `Tool[]`. A `tools[]` entry with
 * no matching `toolSchemas` entry is skipped (UI-only runtime methods live in
 * `uiActions`, not `toolSchemas`, and are not model-callable MCP tools).
 */
export function manifestToolsToMcpTools(manifest: PluginManifest): McpToolProjection[] {
  const schemas = manifest.toolSchemas ?? {};
  const out: McpToolProjection[] = [];
  for (const name of manifest.tools ?? []) {
    const entry = schemas[name];
    if (entry === undefined) continue;
    out.push(toolSchemaToMcpTool(name, entry, manifest.version));
  }
  return out;
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
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
    },
    capabilities,
    instructions: manifest.description,
  };
}
