import type { ChatEntry } from "../../../lib/chat-stream-state.js";
import type { SubAgentSpawn } from "../components/SubAgentCard.js";

type ToolGroupEntry = Extract<ChatEntry, { kind: "tool_group" }>;

/**
 * Chat-entry revision helpers — pure content fingerprints used by ChatView to
 * decide when a rendered card must re-render. Extracted from ChatView.tsx (C14)
 * so they can be unit-tested directly. Byte-identical to the originals.
 */
export function textRevision(text: string | undefined): string {
  if (!text) return "0:0";
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${text.length}:${hash >>> 0}`;
}

export function valueRevision(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value !== "object") return textRevision(String(value));
  if (Array.isArray(value)) {
    return textRevision(`[${value.map(valueRevision).join(",")}]`);
  }
  const objectValue = value as Record<string, unknown>;
  return textRevision(`{${Object.keys(objectValue)
    .sort()
    .map((key) => `${key}:${valueRevision(objectValue[key])}`)
    .join(",")}}`);
}

export function subAgentRevision(spawn: SubAgentSpawn): string {
  return [
    spawn.spawnId,
    textRevision(spawn.title),
    spawn.status,
    spawn.toolCallCount,
    textRevision(spawn.summary),
    textRevision(spawn.errorMessage),
    // Fingerprint the child transcript so a live-updating spawn re-renders when
    // its entries change (new tool row, streamed reasoning, final assistant).
    spawn.entries
      .map((entry, i) => entryRenderRevision({ entry, idx: i, searchHighlight: "", starred: false }))
      .join("|"),
  ].join(":");
}

export function toolGroupRevision(group: ToolGroupEntry, spawnRevisions: string[]): string {
  return [
    group.groupId,
    group.groupIds.join(","),
    group.status,
    group.tools
      .map((tool) => [
        tool.toolUseId,
        tool.name,
        tool.displayOrder,
        tool.status,
        valueRevision(tool.input),
        textRevision(tool.result),
        tool.source ?? "",
        tool.category ?? "",
        tool.pluginId ?? "",
        tool.mcpServerId ?? "",
        tool.durationMs ?? "",
        tool.startedAt ?? "",
        valueRevision(tool.uiPayload),
      ].join(":"))
      .join("|"),
    spawnRevisions.join(","),
  ].join("#");
}

export function entryRenderRevision(params: {
  entry: ChatEntry;
  idx: number;
  searchHighlight: string;
  starred: boolean;
  spawnRevisions?: string[];
}): string {
  const { entry, idx, searchHighlight, starred, spawnRevisions = [] } = params;
  switch (entry.kind) {
    case "reasoning":
      return `${idx}:reasoning:${textRevision(entry.text)}:${entry.streaming ? "1" : "0"}`;
    case "assistant":
      return `${idx}:assistant:${textRevision(entry.text)}:${entry.streaming ? "1" : "0"}:${entry.phase ?? ""}:${entry.systemNotice ?? ""}:${textRevision(searchHighlight)}:${starred ? "1" : "0"}`;
    case "permission_review":
      return [
        idx,
        "permission_review",
        entry.toolUseId,
        entry.groupId,
        entry.displayOrder,
        entry.status,
        entry.verdictLevel ?? "",
        entry.toolName,
        entry.source ?? "",
        entry.toolCategory ?? "",
        textRevision(entry.reason),
        valueRevision(entry.approvalPurpose),
      ].join(":");
    case "tool_group":
      return `${idx}:tool_group:${toolGroupRevision(entry, spawnRevisions)}`;
    case "ask_user_answer":
      return `${idx}:ask_user_answer:${entry.dismissed ? "1" : "0"}:${entry.rows.map((row) => `${row.label}:${textRevision(row.value)}`).join("|")}`;
    default:
      return `${idx}:${entry.kind}`;
  }
}

export function bottomFollowSignature(entries: ChatEntry[]): string {
  const last = entries.at(-1);
  if (!last) return "empty";
  switch (last.kind) {
    case "user":
    case "system":
      return `${entries.length}:${last.kind}:${last.text.length}`;
    case "reasoning":
    case "assistant":
      return `${entries.length}:${last.kind}:${last.text.length}:${last.streaming ? "streaming" : "done"}`;
    case "tool_group":
      return `${entries.length}:tool_group:${last.status}:${last.tools
        .map((tool) => `${tool.toolUseId}:${tool.status}:${tool.result?.length ?? 0}:${tool.durationMs ?? ""}`)
        .join("|")}`;
    case "turn_summary":
      return `${entries.length}:turn_summary:${last.tokensIn}:${last.tokensOut}:${last.toolCount}`;
    case "checkpoint":
      return `${entries.length}:checkpoint:${last.compactNum ?? ""}:${last.freedTokens}`;
    default:
      return `${entries.length}:${last.kind}`;
  }
}
