import { createDynamicTool, type Tool } from "./base.js";
import { t } from "../i18n/index.js";

/**
 * Builtin `request_plugin` meta-tool. The call is intercepted and handled
 * inline by ConversationLoop; the `execute` below is only a fail-closed
 * fallback — if it ever runs, the loop interception regressed, so it returns
 * an error to make the regression visible in traces.
 */
export function createRequestPluginTool(): Tool {
  return createDynamicTool({
    name: "request_plugin",
    description: t("be_tools.requestPluginDescription"),
    source: "builtin",
    category: "read",
    isReadOnly: () => true,
    jsonSchema: {
      type: "object",
      required: ["pluginId"],
      properties: {
        pluginId: {
          type: "string",
          description: t("be_tools.requestPluginIdDescription"),
        },
      },
    },
    // Handled inline by ConversationLoop. If execution reaches this fallback,
    // the loop interception regressed; fail closed so traces expose it.
    execute: async () => ({
      output: t("be_tools.requestPluginLoopError"),
      isError: true,
    }),
  });
}
