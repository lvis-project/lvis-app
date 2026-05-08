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
  // Copy-on-write — eligible 메시지가 하나도 없으면 새 array 생성하지 않고 입력 그대로 반환.
  // 사전 scan: marked (compactedAt set) + 아직 stub 아님 (serializedStub !== true) 인 첫 인덱스 탐색.
  // NOTE: string-prefix 체크는 도구 출력이 우연히 그 prefix 로 시작하는 false-positive 위험 →
  //       meta.serializedStub flag 기반으로 전환 (Copilot round 2 지적, PR-3 round 3 fix).
  let firstEligibleIdx = -1;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "tool_result") continue;
    if (msg.meta?.compactedAt === undefined) continue;
    if (msg.meta.serializedStub === true) continue; // 이미 stub (meta flag)
    firstEligibleIdx = i;
    break;
  }
  if (firstEligibleIdx === -1) return messages; // no allocation

  // 첫 eligible 부터만 새 array 분기 — 앞 부분은 reference 그대로 share.
  const out: GenericMessage[] = messages.slice(0, firstEligibleIdx);
  for (let i = firstEligibleIdx; i < messages.length; i++) {
    const msg = messages[i];
    if (
      msg.role === "tool_result" &&
      msg.meta?.compactedAt !== undefined &&
      msg.meta.serializedStub !== true
    ) {
      const origLen = msg.content.length;
      out.push({
        role: "tool_result",
        toolUseId: msg.toolUseId,
        toolName: msg.toolName,
        isError: msg.isError,
        content: buildToolResultStub(msg.toolName, origLen),
        meta: { ...msg.meta, serializedStub: true },
      } as GenericMessage);
    } else {
      out.push(msg); // reference share
    }
  }
  return out;
}
