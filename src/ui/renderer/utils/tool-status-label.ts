import type { ToolEntryItem } from "../../../lib/chat-stream-state.js";

const TOOL_STATUS_LABEL_KEYS = {
  running: "toolActivity.status.running",
  done: "toolActivity.status.done",
  error: "toolActivity.status.error",
  cancelled: "toolGroupCard.cancelled",
} as const;

export function toolStatusLabelKey(status: ToolEntryItem["status"] | undefined) {
  return status === undefined ? undefined : TOOL_STATUS_LABEL_KEYS[status];
}

/** A requested file operation is not an accomplished change before success. */
export function incompleteToolStatusLabelKey(status: ToolEntryItem["status"] | undefined) {
  return status === "done" ? undefined : toolStatusLabelKey(status);
}
