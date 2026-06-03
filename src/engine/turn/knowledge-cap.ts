/**
 * §11 depth cap — knowledge 도구 turn당 최대 호출 횟수 제한.
 *
 * LLM agentic 토큰 폭발 방지. 관련 KNOWLEDGE_TOOL_NAMES 에 속한 tool_use 들은
 * turn 범위의 카운터를 넘어서면 실행 대신 error tool_result 로 치환된다.
 */
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
  /** depth cap 미만이라 실제 실행해도 되는 tool_use. */
  allowed: ToolUseBlock[];
  /** depth cap 초과로 차단된 항목들의 합성 tool_result. */
  blocked: Array<{ tool_use_id: string; content: string; is_error: boolean }>;
  /** 갱신된 knowledge 호출 카운터 (다음 round 로 넘겨받는다). */
  nextCount: number;
}

/**
 * knowledge 도구 호출 수를 depth cap 기준으로 분리한다.
 * 순수 함수 — 입력 카운터는 불변이며 새 카운터를 반환값에 담아 준다.
 */
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
