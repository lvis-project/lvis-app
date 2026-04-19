/**
 * Plugin Tool Adapter — bridges plugin `tools[]` declarations into the
 * canonical {@link Tool} contract used by the §6.4 ToolRegistry.
 *
 * Uses `manifest.toolSchemas[tool]` when present so the LLM sees typed
 * parameter fields; otherwise falls back to the generic `{payload: object}`
 * wrapper shape.
 */
import { createDynamicTool, type Tool } from "../tools/base.js";
import type { PluginRuntime } from "./runtime.js";
import type { PluginManifest } from "./types.js";

const GENERIC_PAYLOAD_SCHEMA = {
  type: "object",
  properties: {
    payload: {
      type: "object",
      description: "플러그인 도구에 전달할 매개변수 객체",
    },
  },
};

interface ToolSchemaEntry {
  description?: string;
  /** §6.4 Tool versioning — optional per-tool semver. Falls back to manifest.version. */
  version?: string;
  deprecatedSince?: string;
  replacedBy?: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Returns true only when the supplied schema is a well-formed object schema
 * the LLM can consume directly. Anything else (string type, missing
 * properties, non-object root) is rejected so the caller can fall back to the
 * generic {payload} shape rather than silently shipping a broken schema.
 */
function isValidTypedSchema(schema: Record<string, unknown> | undefined): boolean {
  if (!schema || typeof schema !== "object") return false;
  if (schema.type !== "object") return false;
  const props = schema.properties;
  return typeof props === "object" && props !== null;
}

function typedDescription(toolName: string): string {
  return `플러그인 도구: ${toolName}. inputSchema에 선언된 필드를 평면 객체로 전달하세요.`;
}

function untypedDescription(toolName: string): string {
  return `플러그인 도구: ${toolName}. payload에 필요한 매개변수를 JSON 객체로 전달하세요.`;
}

function buildPluginTool(
  pluginRuntime: PluginRuntime,
  toolName: string,
  pluginId: string,
  schemaEntry: ToolSchemaEntry | undefined,
  manifestVersion: string,
): Tool {
  const typed = isValidTypedSchema(schemaEntry?.inputSchema) ? schemaEntry!.inputSchema : undefined;
  const description = schemaEntry?.description ?? (typed ? typedDescription(toolName) : untypedDescription(toolName));
  return createDynamicTool({
    name: toolName,
    description,
    source: "plugin",
    pluginId,
    version: schemaEntry?.version ?? manifestVersion,
    deprecatedSince: schemaEntry?.deprecatedSince,
    replacedBy: schemaEntry?.replacedBy,
    jsonSchema: typed ?? GENERIC_PAYLOAD_SCHEMA,
    execute: async (rawInput) => {
      // Both typed and untyped paths accept a JSON-string input (some provider
      // paths deliver tool arguments pre-serialized). Parse once at the entry
      // point so the downstream flat/wrapped split sees a real object.
      let parsed: unknown = rawInput ?? {};
      if (typeof parsed === "string") {
        try { parsed = JSON.parse(parsed); } catch { /* leave as string */ }
      }
      const args = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<string, unknown>;

      let finalPayload: unknown;
      if (typed) {
        finalPayload = Object.keys(args).length > 0 ? args : undefined;
      } else {
        finalPayload = args.payload;
        if (!finalPayload && Object.keys(args).length > 0) finalPayload = args;
        if (typeof finalPayload === "string") {
          try { finalPayload = JSON.parse(finalPayload); } catch { /* leave as string */ }
        }
      }
      try {
        const result = await pluginRuntime.call(toolName, finalPayload);
        return {
          output: typeof result === "string" ? result : JSON.stringify(result, null, 2),
          isError: false,
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

export function pluginToolsForRegistration(
  pluginRuntime: PluginRuntime,
  pluginId: string,
  manifest: PluginManifest,
): Tool[] {
  const schemas = manifest.toolSchemas ?? {};
  const manifestVersion = manifest.version || "1.0.0";
  return (manifest.tools ?? []).map((tool) =>
    buildPluginTool(pluginRuntime, tool, pluginId, schemas[tool], manifestVersion),
  );
}
