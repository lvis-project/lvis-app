/**
 * Tool trust-origin helpers.
 *
 * Pure functions that derive the {@link ToolTrustOrigin} for a turn and its
 * subsequent rounds, plus the permission user-intent summary. Extracted from
 * `conversation-loop.ts` — no `this` dependency.
 */
import type { ChatInputOrigin } from "../../shared/chat-origin.js";
import { isUserKeyboardOrigin } from "../../shared/chat-origin.js";
import { stagedOriginForInput } from "../../shared/staged-origins.js";
import { MCP_RESOURCE_FENCE_OPEN } from "../../shared/mcp-resource-bounds.js";
import type { ToolTrustOrigin } from "../../tools/types.js";
import type { RationaleEligibilityProvenance } from "../../tools/pipeline/rationale-control.js";
import type { ToolResult, ToolUseBlock } from "../../tools/executor.js";

/**
 * Untrusted material the host itself folded into the TURN TEXT, which therefore has to
 * be recognized from the text rather than from the content parts.
 *
 * Both entries exist for the same reason: a payload that arrived as an attachment can
 * end up inside the message body, and the taint has to survive that move. A paste is
 * inlined by the composer at send time; a resource fence is folded by
 * `continueFromLastUserTurn`, which joins every text part into the prompt body when a
 * turn is replayed by Retry or continue-last-user.
 *
 * Deriving taint from the MATERIAL rather than from the packaging is the same lesson the
 * per-turn resource bound learned: a check that reads the shape a caller happened to
 * choose answers a different question on the next caller. Missing it here is not a
 * cosmetic slip — `llm-tool-arg` is the UNTAINTED bucket, so a replayed resource turn
 * would tell the Layer-5 reviewer that server-authored text was ordinary
 * model-generated input, write that verdict into the untainted cache partition, and
 * label the approval dock's trust badge with it.
 */
const INLINE_PASTED_TEXT_RE = /(^|\n)-{5} Pasted text #\d+ \(\d+ lines\) -{5}\n/;

const FILE_CONTENT_RESULT_TOOLS = new Set([
  "read_file",
  "grep_files",
]);

export function initialToolTrustOrigin(inputOrigin: ChatInputOrigin, turnInput: string): ToolTrustOrigin {
  if (
    inputOrigin === "file-content"
    || INLINE_PASTED_TEXT_RE.test(turnInput)
    || turnInput.includes(MCP_RESOURCE_FENCE_OPEN)
  ) {
    return "file-content";
  }
  if (inputOrigin === "agent-message") {
    return "agent-message";
  }
  // Every STAGED origin (plugin overlay trigger, MCP App `ui/message`, MCP server
  // prompt) keeps its OWN provenance through the tool layer — none is the user's
  if (inputOrigin === "surface-user" || inputOrigin === "tailnet-surface" || inputOrigin === "platform-bridge") {
    return inputOrigin;
  }
  // keyboard. Resolved from the registry rather than an if/else chain: the chain's
  // default was `llm-tool-arg`, the UNTAINTED bucket, so a newly registered origin
  // that nobody remembered to branch on would have been laundered into "ordinary
  // model-generated tool arg" with no taint at all.
  if (stagedOriginForInput(inputOrigin)) {
    return inputOrigin as ToolTrustOrigin;
  }
  return "llm-tool-arg";
}

/** Project the monotonic trust-origin SOT into rationale provenance. */
export function rationaleProvenanceFor(
  startedFromUserKeyboard: boolean,
  current: ToolTrustOrigin,
): RationaleEligibilityProvenance {
  const taint = current === "llm-tool-arg" || current === "user-keyboard"
    ? "none"
    : current;
  return { startedFromUserKeyboard, taint };
}

export function summarizePermissionUserIntent(
  inputOrigin: ChatInputOrigin,
  turnInput: string,
): string | undefined {
  if (!isUserKeyboardOrigin(inputOrigin) && inputOrigin !== "queue-auto") {
    return undefined;
  }
  const cleaned = turnInput
    .replace(/<[^>]*>/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || cleaned.startsWith("/")) return undefined;
  return cleaned.length > 500 ? `${cleaned.slice(0, 499)}…` : cleaned;
}

export function nextToolTrustOrigin(
  current: ToolTrustOrigin,
  toolUses: readonly ToolUseBlock[],
  toolResults: readonly ToolResult[],
): ToolTrustOrigin {
  if (current === "file-content" || current === "agent-message") return current;
  const successful = new Set(
    toolResults
      .filter((result) => !result.is_error)
      .map((result) => result.tool_use_id),
  );
  return toolUses.some((toolUse) => successful.has(toolUse.id) && FILE_CONTENT_RESULT_TOOLS.has(toolUse.name))
    ? "file-content"
    : current;
}
