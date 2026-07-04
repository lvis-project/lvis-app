




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




export function stubMarkedToolResults(messages: GenericMessage[]): GenericMessage[] {


  let firstEligibleIdx = -1;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "tool_result") continue;
    if (msg.meta?.compactedAt === undefined && msg.meta?.truncated === undefined) continue;
    if (msg.meta.serializedStub === true) continue;
    firstEligibleIdx = i;
    break;
  }
  if (firstEligibleIdx === -1) return messages; // no allocation


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
