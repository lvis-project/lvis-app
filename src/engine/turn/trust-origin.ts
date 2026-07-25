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
import type { ToolTrustOrigin } from "../../tools/types.js";
import type { RationaleEligibilityProvenance } from "../../tools/pipeline/rationale-control.js";
import type { ToolResult, ToolUseBlock } from "../../tools/executor.js";

const INLINE_PASTED_TEXT_RE = /(^|\n)-{5} Pasted text #\d+ \(\d+ lines\) -{5}\n/;

const FILE_CONTENT_RESULT_TOOLS = new Set([
  "read_file",
  "grep_files",
]);

export function initialToolTrustOrigin(inputOrigin: ChatInputOrigin, turnInput: string): ToolTrustOrigin {
  if (inputOrigin === "file-content" || INLINE_PASTED_TEXT_RE.test(turnInput)) {
    return "file-content";
  }
  if (inputOrigin === "agent-message") {
    return "agent-message";
  }
  // Every STAGED origin (plugin overlay trigger, MCP App `ui/message`, MCP server
  // prompt) keeps its OWN provenance through the tool layer — none is the user's
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
