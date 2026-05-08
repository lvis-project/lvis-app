/**
 * Wire/Disk serialization transform — Layer 1 marked tool_results 를 stub 으로 변환.
 *
 * v3 §4.2 (PR-3) 핵심 — `markStaleToolResults` 가 *memory verbatim* 보존하므로 provider 호출
 * 직전 + JSONL 영속화 직전 두 boundary 에서 *반드시* 이 helper 를 통과시켜 stub 형태로 만든다.
 *
 * 단일 source of truth — 모든 vendor adapter (Anthropic / OpenAI / Gemini / Copilot / Vertex /
 * Azure Foundry) 와 disk 영속화 사이트는 공통적으로 이 함수를 통해 직렬화 형태를 얻는다.
 */

import type { GenericMessage } from "./llm/types.js";
import { buildToolResultStub } from "./auto-compact.js";

/**
 * `meta.compactedAt` set 된 tool_result content 를 stub 텍스트로 교체한 새 array 반환.
 *
 * - 입력 array 는 mutate 안 함 — caller 의 in-memory verbatim 보존
 * - mark 안 된 메시지는 reference-equal (per-turn allocation 회피)
 * - tool_result 가 아닌 메시지는 그대로
 *
 * @param messages 입력 — markStaleToolResults 가 마킹한 verbatim history
 * @returns 직렬화용 stub-substituted array
 */
export function stubMarkedToolResults(messages: GenericMessage[]): GenericMessage[] {
  let mutated = false;
  const out = messages.map((msg) => {
    if (msg.role !== "tool_result") return msg;
    if (msg.meta?.compactedAt === undefined) return msg;
    // 이미 stub 형태로 들어온 경우 (e.g. JSONL load 후) — toolName + length-suffix 패턴이면 이중 stub 회피.
    if (msg.content.startsWith("[tool_result stripped:")) return msg;

    mutated = true;
    const origLen = msg.content.length;
    return {
      role: "tool_result",
      toolUseId: msg.toolUseId,
      toolName: msg.toolName,
      isError: msg.isError,
      content: buildToolResultStub(msg.toolName, origLen),
      meta: msg.meta,
    } as GenericMessage;
  });

  // mutate 없으면 원본 reference 반환 (allocation 회피)
  return mutated ? out : messages;
}
