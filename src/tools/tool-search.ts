import { createDynamicTool, type Tool } from "./base.js";
import { TOOL_SEARCH_TOOL_NAME } from "./registry.js";
import { t } from "../i18n/index.js";

/**
 * Builtin `tool_search` meta-tool. Like `request_plugin`, the call is
 * intercepted and handled inline by ConversationLoop; the `execute` below is a
 * fail-closed fallback that surfaces a regression in the loop interception.
 */
export function createToolSearchTool(): Tool {
  return createDynamicTool({
    name: TOOL_SEARCH_TOOL_NAME,
    description: t("be_tools.toolSearchDescription"),
    source: "builtin",
    category: "read",
    isReadOnly: () => true,
    jsonSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: {
          type: "string",
          description: t("be_tools.toolSearchQueryDescription"),
        },
      },
    },
    // Handled inline by ConversationLoop. If execution reaches this fallback,
    // the loop interception regressed; fail closed so traces expose it.
    execute: async () => ({
      output: t("be_tools.toolSearchLoopError"),
      isError: true,
    }),
  });
}
