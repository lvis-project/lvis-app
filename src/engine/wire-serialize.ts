




import type { GenericMessage } from "./llm/types.js";
import { buildToolResultStrippedStub, buildToolResultTruncatedStub } from "../shared/tool-result-stub.js";
import type { ToolOutputArtifactInfo } from "../shared/tool-output-artifact.js";
import type { ToolResultArtifactUnavailableInfo } from "../shared/tool-result-stub.js";

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
  info: NonNullable<GenericMessage["meta"]>["truncated"],
  content: string,
  outputArtifact?: ToolOutputArtifactInfo,
  artifactUnavailable?: ToolResultArtifactUnavailableInfo,
  outputArtifactUnavailable?: boolean,
): string {
  return buildToolResultTruncatedStub(toolUseId, toolName, info, content, { outputArtifact, artifactUnavailable, outputArtifactUnavailable });
}




export function prepareMarkedToolResultsForWire(messages: GenericMessage[]): GenericMessage[] {
  let firstEligibleIdx = -1;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "tool_result") continue;
    if (msg.meta === undefined) continue;
    firstEligibleIdx = i;
    break;
  }
  if (firstEligibleIdx === -1) return messages; // no allocation


  const out: GenericMessage[] = messages.slice(0, firstEligibleIdx);
  for (let i = firstEligibleIdx; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "tool_result" || msg.meta === undefined) {
      out.push(msg); // reference share
      continue;
    }

    const marked = msg.meta.compactedAt !== undefined || msg.meta.truncated !== undefined || (msg.meta.outputArtifact !== undefined || msg.meta.outputArtifactUnavailable === true);
    if (marked && msg.meta.serializedStub !== true) {
      // Oversized results keep their bounded preview and retrieval path even
      // after later compaction. Other stale results use the shorter stripped form.
      const compactedResultText = msg.meta.truncated !== undefined || (msg.meta.outputArtifact !== undefined || msg.meta.outputArtifactUnavailable === true)
        ? buildToolResultTruncatedStubForWire(
          msg.toolUseId, msg.toolName, msg.meta.truncated, msg.content, msg.meta.outputArtifact, msg.meta.artifactUnavailable, msg.meta.outputArtifactUnavailable,
        )
        : buildToolResultStrippedStub(msg.toolName, msg.content.length);
      out.push({
        role: "tool_result",
        toolUseId: msg.toolUseId,
        toolName: msg.toolName,
        isError: msg.isError,
        content: compactedResultText,
      } as GenericMessage);
    } else {
      // Tool-result metadata is host-only state for history, UI, recovery, and
      // compaction. Provider adapters map the request fields explicitly, so the
      // request projection must exclude metadata instead of charging or sending it.
      const { meta: _meta, ...wireMessage } = msg;
      out.push(wireMessage);
    }
  }
  return out;
}
