/**
 * Plugin Tool Adapter — bridges plugin `methods[]` declarations into the
 * canonical {@link Tool} contract used by the §6.4 ToolRegistry.
 */
import { createDynamicTool, type Tool } from "../tools/base.js";
import type { PluginRuntime } from "./runtime.js";
import type { PluginManifest } from "./types.js";

const GENERIC_PAYLOAD_SCHEMA = {
  type: "object",
  properties: {
    payload: {
      type: "object",
      description: "메서드에 전달할 매개변수 객체",
    },
  },
};

function buildMethodTool(pluginRuntime: PluginRuntime, methodName: string, pluginId: string): Tool {
  return createDynamicTool({
    name: methodName,
    description: `플러그인 메서드: ${methodName}. payload에 필요한 매개변수를 JSON 객체로 전달하세요.`,
    source: "plugin",
    pluginId,
    jsonSchema: GENERIC_PAYLOAD_SCHEMA,
    execute: async (rawInput) => {
      const args = (rawInput ?? {}) as Record<string, unknown>;
      let finalPayload: unknown = args.payload;
      if (!finalPayload && Object.keys(args).length > 0) finalPayload = args;
      if (typeof finalPayload === "string") {
        try { finalPayload = JSON.parse(finalPayload); } catch { /* leave as string */ }
      }
      try {
        const result = await pluginRuntime.call(methodName, finalPayload);
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
  return (manifest.methods ?? []).map((method) => buildMethodTool(pluginRuntime, method, pluginId));
}
