import type { ChatEntry } from "../../../lib/chat-stream-state.js";
import type { ProcessingDisplayLevel } from "../../../shared/processing-display-level.js";
import type { EntryClass } from "./classify-turn-entries.js";

type AssistantEntry = Extract<ChatEntry, { kind: "assistant" }>;

/**
 * One visibility rule for assistant rows shared by rendering and search.
 * Classification must run against the complete timeline before this policy is
 * applied; otherwise a hidden work row can be mistaken for the final answer.
 */
export function shouldShowAssistantEntry(
  entry: AssistantEntry,
  entryClass: EntryClass | undefined,
  level: ProcessingDisplayLevel,
): boolean {
  if (level === "full" || entryClass === "final") return true;
  return entry.phase === "final"
    || entry.phase === "status"
    || entry.systemNotice !== undefined
    || entry.interrupted === true;
}
