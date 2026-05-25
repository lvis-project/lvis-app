import { TOOL_SEARCH_TOOL_NAME } from "../tools/registry.js";

export const OPENAI_RESPONSES_TOOL_SEARCH_ALIAS = "lvis_tool_search";

export const PROVIDER_TOOL_SEARCH_TEXT_ALIASES = [
  OPENAI_RESPONSES_TOOL_SEARCH_ALIAS,
  "lvis\\_tool_search",
  "lvis_tool\\_search",
  "lvis\\_tool\\_search",
] as const;

export function normalizeProviderToolAliasName(toolName: string): string {
  return toolName === OPENAI_RESPONSES_TOOL_SEARCH_ALIAS
    ? TOOL_SEARCH_TOOL_NAME
    : toolName;
}

export function normalizeProviderToolAliasText(text: string): string {
  let restored = text;
  for (const alias of PROVIDER_TOOL_SEARCH_TEXT_ALIASES) {
    restored = restored.replace(
      new RegExp(
        `(^|[^A-Za-z0-9_])${escapeRegExp(alias)}(?=$|[^A-Za-z0-9_])`,
        "gi",
      ),
      `$1${TOOL_SEARCH_TOOL_NAME}`,
    );
  }
  return restored;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
