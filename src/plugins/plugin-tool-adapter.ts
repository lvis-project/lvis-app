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
  inputSchema: Record<string, unknown>;
}

function buildPluginTool(
  pluginRuntime: PluginRuntime,
  toolName: string,
  pluginId: string,
  schemaEntry: ToolSchemaEntry | undefined,
): Tool {
  const typed = schemaEntry?.inputSchema;
  return createDynamicTool({
    name: toolName,
    description: schemaEntry?.description ?? `플러그인 도구: ${toolName}. payload에 필요한 매개변수를 JSON 객체로 전달하세요.`,
    source: "plugin",
    pluginId,
    jsonSchema: typed ?? GENERIC_PAYLOAD_SCHEMA,
    execute: async (rawInput) => {
      const args = (rawInput ?? {}) as Record<string, unknown>;
      // With a typed inputSchema the LLM passes arguments as a flat object —
      // forward it unwrapped. Without one, unwrap the {payload} envelope.
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
  return (manifest.tools ?? []).map((tool) =>
    buildPluginTool(pluginRuntime, tool, pluginId, schemas[tool]),
  );
}
