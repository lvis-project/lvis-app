/**
 * Wire serialization transform — marked tool_results 를 stub 으로 변환.
 *
 * `markStaleToolResults` 가 *memory verbatim* 보존하므로 provider 호출
 * 직전 boundary 에서 *반드시* 이 helper 를 통과시켜 stub 형태로 만든다.
 * JSONL 영속화는 `MemoryManager.saveSession` 이 같은 stub builder 를 사용하되,
 * oversized raw content 는 file-backed artifact 로 따로 보존한다.
 *
 * 단일 source of truth — 모든 vendor adapter (Anthropic / OpenAI / Gemini / Copilot / Vertex /
 * Azure Foundry) 는 공통적으로 이 함수를 통해 wire 직렬화 형태를 얻는다.
 */

import type { GenericMessage } from "./llm/types.js";
import { buildToolResultStub } from "./auto-compact.js";
import { buildToolResultTruncatedStub } from "../shared/tool-result-stub.js";

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
 *
 * `originalLines === -1` / `originalTokens === -1` are sentinels meaning
 * "exact scan skipped because the payload exceeded HARD_BYTES_CEILING"
 * — surfaced as "(scan skipped — over hard ceiling)" so the model knows
 * the count is unknown rather than literally negative.
 *
 * `toolName` is sanitized with the same `^[A-Za-z0-9_-]+$` charset that
 * `registerPluginTools` enforces at registration time. Defense-in-depth:
 * if future validation weakens, the stub cannot become an injection
 * vector via a hostile tool name.
 */
function buildToolResultTruncatedStubForWire(
  toolUseId: string,
  toolName: string | undefined,
  info: NonNullable<NonNullable<GenericMessage["meta"]>["truncated"]>,
): string {
  return buildToolResultTruncatedStub(toolUseId, toolName, info);
}

/**
 * `meta.compactedAt` 또는 `meta.truncated` set 된 tool_result content 를
 * provider용 stub 텍스트로 교체한 새 array 반환.
 *
 * 두 마커의 의미:
 *   - `compactedAt` — LLM auto-compact 이 turn 을 요약 → 원본 raw content
 *     는 더 이상 의미 없으므로 짧은 stub 으로 swap (token 회수)
 *   - `truncated`   — 호스트가 size cap 으로 잘림 (Issue #902). in-memory
 *     content 는 **raw verbatim 그대로 보존** (UI / inspection 정합) —
 *     이 함수가 wire/disk 직렬화 시점에서만 짧은 stub 로 swap. 따라서
 *     in-memory snapshot 을 보는 UI 는 원본을 볼 수 있고, LLM 으로
 *     보낼 때는 stub 으로 통일. JSONL 저장도 같은 marker 를 쓰지만
 *     `MemoryManager.saveSession` 에서 file-backed artifact 를 함께 쓴다.
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
      //
      // origLen passed to `buildToolResultStub`:
      //   - When the message was *also* truncated, prefer the recorded
      //     `truncated.originalBytes` so the stub reflects the *raw*
      //     payload size (UI / debug tooltips show "100K original" even
      //     after compactedAt swap). `msg.content.length` would only
      //     equal the in-memory raw length pre-stub — once another
      //     serialization cycle has run, that length is the stub's, not
      //     the raw's. The `serializedStub` guard above ensures we never
      //     reach this branch a second time for the same message, but
      //     pulling from `truncated.originalBytes` is the more honest
      //     value contractually.
      //   - When only `compactedAt` is set (no truncated meta), the
      //     pre-PR behaviour is preserved: use the in-memory length.
      const stubContent =
        msg.meta.compactedAt !== undefined
          ? buildToolResultStub(msg.toolName, msg.meta.truncated?.originalBytes ?? msg.content.length)
          : buildToolResultTruncatedStubForWire(msg.toolUseId, msg.toolName, msg.meta.truncated!);
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
