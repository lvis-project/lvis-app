/**
 * deriveSubAgentSpawnsFromEntries — reconstruct `SubAgentSpawn[]` from a
 * LOADED session's persisted transcript.
 *
 * The live `subAgentSpawns` list (useWorkflowTools) is populated ONLY from the
 * in-flight `lvis:agent-spawn:event` stream. When a PAST session is loaded that
 * stream never replays, so the workspace SubAgentViewer + inline SubAgentCard
 * would show nothing even though the transcript still carries the original
 * `agent_spawn` tool calls (rendered as generic tool cards).
 *
 * This mirrors how `collectChatPreviewModel` derives file/preview/browser
 * targets from loaded entries: walk the `tool_group` entries, find each
 * `agent_spawn` tool call, and rebuild a `SubAgentSpawn` from what IS persisted:
 *   - title:   `input.title` (falls back to `input.agentName`)
 *   - status:  from the tool status (`done` / `error`) — an error result JSON
 *              (`{ error }`) also downgrades a nominally-`done` tool to `error`
 *   - output:  the sub-agent's final summary (`result.summary`) collapsed into a
 *              single synthetic turn + the card summary; `result.error` for the
 *              error message
 *   - spawnId: derived deterministically from the tool_use id so the derived
 *              entry is stable across re-renders and dedupes cleanly against the
 *              live spawn (which carries the same `toolUseId`)
 *   - toolUseId: the tool_use id — groups the card under its ToolGroupCard
 *
 * Persistence parity (PR3): the `agent_spawn` tool result now EMBEDS the child's
 * full `entries: ChatEntry[]` transcript (written by agent-spawn.ts, DLP-masked
 * at the SubAgentTranscriptAccumulator source). When present, the derived spawn
 * carries the real tool/reasoning/assistant timeline — visually identical to the
 * live run. When ABSENT (legacy sessions written before this PR), we fall back to
 * a single synthetic assistant entry built from `result.summary` so the card
 * still has body content. This fallback is a legitimate external-boundary
 * fallback over persisted history (CLAUDE.md No-Fallback carve-out for the
 * persistence boundary), not an internal-contract paper-over.
 */
import type { ChatEntry } from "../../../lib/chat-stream-state.js";
import type { SubAgentSpawn } from "../components/SubAgentCard.js";

/** Deterministic spawnId for a derived spawn, keyed by its tool_use id. */
export function derivedSpawnId(toolUseId: string): string {
  return `derived:${toolUseId}`;
}

interface ParsedSpawnResult {
  summary?: string;
  toolCallCount?: number;
  error?: string;
  /** Embedded child transcript (PR3+). Absent on legacy persisted results. */
  entries?: ChatEntry[];
}

function parseSpawnResult(raw: string | undefined): ParsedSpawnResult {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A non-JSON result string is still usable as the sub-agent's output.
    return { summary: raw };
  }
  if (!parsed || typeof parsed !== "object") return {};
  const obj = parsed as Record<string, unknown>;
  const result: ParsedSpawnResult = {};
  if (typeof obj.summary === "string") result.summary = obj.summary;
  if (typeof obj.toolCallCount === "number") result.toolCallCount = obj.toolCallCount;
  if (typeof obj.error === "string") result.error = obj.error;
  // The embedded transcript is trusted structurally (same-origin persisted
  // state written by agent-spawn.ts). We only guard the array shape so a
  // corrupt / truncated jsonl line degrades to the synthetic fallback instead
  // of crashing the renderer.
  if (Array.isArray(obj.entries)) result.entries = obj.entries as ChatEntry[];
  return result;
}

function deriveTitle(input: Record<string, unknown> | undefined): string {
  const title = typeof input?.title === "string" ? input.title.trim() : "";
  if (title) return title;
  const agentName = typeof input?.agentName === "string" ? input.agentName.trim() : "";
  if (agentName) return agentName;
  return "(sub-agent)";
}

export function deriveSubAgentSpawnsFromEntries(entries: ChatEntry[]): SubAgentSpawn[] {
  const spawns: SubAgentSpawn[] = [];
  for (const entry of entries) {
    if (entry.kind !== "tool_group") continue;
    for (const tool of [...entry.tools].sort((a, b) => a.displayOrder - b.displayOrder)) {
      if (tool.name !== "agent_spawn") continue;
      const parsed = parseSpawnResult(tool.result);
      // An `agent_spawn` result carrying `{ error }` means the sub-agent
      // failed even if the tool call itself completed — treat as error.
      const status: SubAgentSpawn["status"] =
        tool.status === "error" || parsed.error !== undefined
          ? "error"
          : tool.status === "running"
            ? "running"
            : "done";
      // Prefer the embedded full transcript (PR3+). Legacy results without it
      // fall back to a single synthetic assistant entry from the summary so the
      // card still renders body content on old sessions.
      const entries: ChatEntry[] =
        parsed.entries && parsed.entries.length > 0
          ? parsed.entries
          : status !== "error" && parsed.summary
            ? [{ kind: "assistant", text: parsed.summary, streaming: false }]
            : [];
      spawns.push({
        spawnId: derivedSpawnId(tool.toolUseId),
        title: deriveTitle(tool.input),
        status,
        entries,
        toolCallCount: parsed.toolCallCount ?? 0,
        ...(parsed.summary !== undefined ? { summary: parsed.summary } : {}),
        ...(parsed.error !== undefined ? { errorMessage: parsed.error } : {}),
        toolUseId: tool.toolUseId,
      });
    }
  }
  return spawns;
}

/**
 * Merge sub-agent spawns derived from a loaded session's entries with the LIVE
 * spawns from the in-flight event stream. The LIVE spawn wins whenever both
 * describe the same run — it carries richer, incrementally-streamed data
 * (per-turn snippets, live status). The derived spawn fills in history for past
 * runs the live stream never saw.
 *
 * Dedupe is by BOTH `spawnId` and `toolUseId`: a live spawn and its derived
 * counterpart have different spawnIds (live = server UUID, derived =
 * `derived:<toolUseId>`) but share the same `toolUseId`, so keying only on
 * spawnId would double-render the same run once loaded. Live entries are laid
 * down first (order preserved), then a derived entry is appended only if no
 * live entry already claims its spawnId or toolUseId.
 */
export function mergeSubAgentSpawns(
  live: SubAgentSpawn[],
  derived: SubAgentSpawn[],
): SubAgentSpawn[] {
  const seenSpawnIds = new Set<string>();
  const seenToolUseIds = new Set<string>();
  const merged: SubAgentSpawn[] = [];
  for (const spawn of live) {
    seenSpawnIds.add(spawn.spawnId);
    if (spawn.toolUseId) seenToolUseIds.add(spawn.toolUseId);
    merged.push(spawn);
  }
  for (const spawn of derived) {
    if (seenSpawnIds.has(spawn.spawnId)) continue;
    if (spawn.toolUseId && seenToolUseIds.has(spawn.toolUseId)) continue;
    merged.push(spawn);
  }
  return merged;
}
