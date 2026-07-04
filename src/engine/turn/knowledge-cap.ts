



import type { ToolUseBlock } from "../../tools/executor.js";
import { t } from "../../i18n/index.js";

export const KNOWLEDGE_DEPTH_CAP = 3;
export const KNOWLEDGE_TOOL_NAMES = new Set<string>([
  "knowledge_search",
  "document_list",
  "document_structure",
  "document_page_content",
]);

export interface KnowledgeCapResult {

  allowed: ToolUseBlock[];

  blocked: Array<{ tool_use_id: string; content: string; is_error: boolean }>;

  nextCount: number;
}




export function applyKnowledgeDepthCap(
  toolUses: ToolUseBlock[],
  currentCount: number,
  cap: number = KNOWLEDGE_DEPTH_CAP,
): KnowledgeCapResult {
  const allowed: ToolUseBlock[] = [];
  const blocked: KnowledgeCapResult["blocked"] = [];
  let count = currentCount;
  for (const tu of toolUses) {
    if (KNOWLEDGE_TOOL_NAMES.has(tu.name)) {
      if (count >= cap) {
        blocked.push({
          tool_use_id: tu.id,
          content: t("be_knowledgeCap.depthCapBlocked", { name: tu.name, cap: String(cap) }),
          is_error: true,
        });
        continue;
      }
      count += 1;
    }
    allowed.push(tu);
  }
  return { allowed, blocked, nextCount: count };
}
