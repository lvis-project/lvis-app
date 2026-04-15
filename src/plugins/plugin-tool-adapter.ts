/**
 * Plugin Tool Adapter — bridges the LVIS plugin runtime's manifest
 * method registry (`pluginRuntime.listMethods()`) into the canonical
 * {@link Tool} contract used by the §6.4 ToolRegistry.
 *
 * Equivalent in role to {@link ../mcp/mcp-tool-adapter.js mcpToolToTool}
 * but for in-process plugin manifests instead of MCP servers. Keeping
 * the conversion in one named module (rather than inlining
 * {@link createDynamicTool} at every plugin registration call site)
 * matches the OpenHarness `McpToolAdapter` pattern and gives the
 * plugin→Tool bridge a single auditable home.
 */
import { createDynamicTool, type Tool } from "../tools/base.js";
import type { PluginRuntime } from "./runtime.js";

/**
 * Convert one plugin manifest method into a {@link Tool} ready for
 * {@link ToolRegistry.register}.
 *
 * Plugin methods use dot notation in the manifest (e.g.
 * `meeting.start`) but vendor LLM APIs require underscore-only
 * names (`^[a-zA-Z0-9_-]+$`), so we replace `.` with `_` here.
 *
 * The exposed tool takes a single `payload` argument because plugin
 * methods accept an arbitrary object — the LLM either nests its
 * arguments under `payload` or passes a flat object that we treat
 * as the payload.
 */
export function pluginMethodToTool(
  pluginRuntime: PluginRuntime,
  methodName: string,
): Tool {
  const toolName = methodName.replace(/\./g, "_");
  return createDynamicTool({
    name: toolName,
    description: `플러그인 메서드: ${methodName}. payload에 필요한 매개변수를 JSON 객체로 전달하세요.`,
    source: "plugin",
    jsonSchema: {
      type: "object",
      properties: {
        payload: {
          type: "object",
          description: "메서드에 전달할 매개변수 객체",
        },
      },
    },
    execute: async (rawInput) => {
      const args = (rawInput ?? {}) as Record<string, unknown>;
      let finalPayload: unknown = args.payload;
      if (!finalPayload && Object.keys(args).length > 0) finalPayload = args;
      if (typeof finalPayload === "string") {
        try {
          finalPayload = JSON.parse(finalPayload);
        } catch {
          /* leave as string */
        }
      }
      try {
        const result = await pluginRuntime.call(methodName, finalPayload);
        const output =
          typeof result === "string"
            ? result
            : JSON.stringify(result, null, 2);
        return { output, isError: false };
      } catch (err) {
        return {
          output: err instanceof Error ? err.message : String(err),
          isError: true,
        };
      }
    },
  });
}
