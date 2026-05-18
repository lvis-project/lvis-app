/**
 * Wire/Disk serialization transform — marked tool_results 를 stub 으로 변환.
 *
 * `markStaleToolResults` 가 *memory verbatim* 보존하므로 provider 호출
 * 직전 + JSONL 영속화 직전 두 boundary 에서 *반드시* 이 helper 를 통과시켜 stub 형태로 만든다.
 *
 * 단일 source of truth — 모든 vendor adapter (Anthropic / OpenAI / Gemini / Copilot / Vertex /
 * Azure Foundry) 와 disk 영속화 사이트는 공통적으로 이 함수를 통해 직렬화 형태를 얻는다.
 */

import type { GenericMessage } from "./llm/types.js";
import { buildToolResultStub } from "./auto-compact.js";

/**
 * Stub form for tool_result messages marked by Issue #902's generic size
 * cap (`meta.truncated` set by `ConversationHistory.append`/`.restore`).
 *
 * The marker is verbose on purpose: the model has to know *why* this
 * result was capped (size limit, not failure), *how much* was lost
 * (lines + tokens + bytes), and *what to do next* (retry with paging /
 * filtering) to make a sensible follow-up call. The verbose form costs
 * a handful of tokens but saves the model from blindly retrying the
 * same oversized call.
 */
function buildToolResultTruncatedStub(
  toolName: string | undefined,
  info: NonNullable<NonNullable<GenericMessage["meta"]>["truncated"]>,
): string {
  return (
    `[tool_result truncated by host (Issue #902):` +
    ` tool=${toolName ?? "?"},` +
    ` originalLines=${info.originalLines},` +
    ` originalTokens=${info.originalTokens},` +
    ` originalBytes=${info.originalBytes}.` +
    ` The full response exceeded the per-result size cap` +
    ` and was dropped from history to protect TPM / context window.` +
    ` Retry with pagination / narrower filter to see the contents.]`
  );
}

/**
 * `meta.compactedAt` 또는 `meta.truncated` set 된 tool_result content 를
 * stub 텍스트로 교체한 새 array 반환.
 *
 * 두 마커의 의미:
 *   - `compactedAt` — LLM auto-compact 이 turn 을 요약 → 원본 raw content
 *     는 더 이상 의미 없으므로 짧은 stub 으로 swap (token 회수)
 *   - `truncated`   — 호스트가 size cap 으로 잘림 (Issue #902). in-memory
 *     content 는 이미 head + marker 형태인데, wire/disk 직렬화 시에는
 *     marker 만 남기는 더 짧은 stub 로 swap (disk 부담 감소 + 다음 load
 *     시 jsonl 의 원본 verbatim 보호용 raw 는 *executor 가 보존*)
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
  // 사전 scan: marked (compactedAt or truncated set) + 아직 stub 아님 (serializedStub !== true) 인 첫 인덱스 탐색.
  // NOTE: string-prefix 체크는 도구 출력이 우연히 그 prefix 로 시작하는 false-positive 위험 →
  //       meta.serializedStub flag 기반으로 전환.
  let firstEligibleIdx = -1;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "tool_result") continue;
    if (msg.meta?.compactedAt === undefined && msg.meta?.truncated === undefined) continue;
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
      (msg.meta?.compactedAt !== undefined || msg.meta?.truncated !== undefined) &&
      msg.meta.serializedStub !== true
    ) {
      // compactedAt takes precedence — once the LLM has summarized the
      // turn the original is fully redundant, so the shorter generic
      // stub is right even if the result was *also* size-capped.
      const stubContent =
        msg.meta.compactedAt !== undefined
          ? buildToolResultStub(msg.toolName, msg.meta.truncated?.originalBytes ?? msg.content.length)
          : buildToolResultTruncatedStub(msg.toolName, msg.meta.truncated!);
      out.push({
        role: "tool_result",
        toolUseId: msg.toolUseId,
        toolName: msg.toolName,
        isError: msg.isError,
        content: stubContent,
        meta: { ...msg.meta, serializedStub: true },
      } as GenericMessage);
    } else {
      out.push(msg); // reference share
    }
  }
  return out;
}
