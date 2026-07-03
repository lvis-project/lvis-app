/**
 * SubAgentCard — chat-side card showing a sub-agent spawn lifecycle.
 *
 * Updates from the spawn lifecycle stream (`lvis:agent-spawn:event`):
 *   start → running → (tool/reasoning/assistant activity) … → done | error
 *
 * The sub-agent runs its own {@link ConversationLoop} whose per-round activity
 * (tool calls, reasoning, assistant text, permission reviews) is forwarded as
 * `ChatEntry[]` and rendered through the SHARED {@link TranscriptRenderer} — the
 * SAME renderer the main chat uses. This is the "루프 동일" unification: the
 * sub-agent transcript is visually identical to a main-chat transcript, only
 * read-only (no edit / fork / star / feedback actions).
 *
 * Each card auto-collapses after `done`. The header shows the title + status
 * badge; the expandable body is the full transcript.
 */
import { useState } from "react";
import { Bot, ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { Badge } from "../../../components/ui/badge.js";
import { useTranslation } from "../../../i18n/react.js";
import type { ChatEntry } from "../../../lib/chat-stream-state.js";
import { TranscriptRenderer } from "./TranscriptRenderer.js";

export interface SubAgentSpawn {
  spawnId: string;
  title: string;
  status: "running" | "done" | "error";
  /**
   * Full sub-agent transcript as `ChatEntry[]` — the same model the main chat
   * renders. Populated live from forwarded child-loop activity, and rebuilt
   * from the persisted `agent_spawn` tool result on session reload (symmetric
   * live-vs-load rendering). Empty until the first child round produces output.
   */
  entries: ChatEntry[];
  summary?: string;
  toolCallCount: number;
  errorMessage?: string;
  /**
   * The originating `agent_spawn` tool_use id. Set on `start` event and
   * preserved across activity/done/error updates. Used by ChatView to attach
   * the spawn to the ToolGroupCard that contains the matching tool entry (the
   * completion chip lives on that tool row; the full transcript lives in the
   * sub-agent tab).
   */
  toolUseId?: string;
  /**
   * The addressable sub-agent session id — the JOIN KEY that unifies a spawn
   * and its resume(s) into one transcript in the sub-agent viewer. A resume is
   * a distinct spawn (own `spawnId`/`toolUseId`) but shares this value with the
   * original, so `groupSubAgentSessions` concatenates their segments. Absent on
   * legacy sessions / clean-complete originals → the spawn stays a solo group.
   */
  childSessionId?: string;
}

/**
 * L2: cap the displayed title so a long attacker-supplied value does not
 * blow up the chat layout. The full value is preserved in the card's
 * tooltip (title attribute), so legitimate long titles are still discoverable.
 */
const TITLE_DISPLAY_CAP = 80;
function clipTitle(value: string): string {
  return value.length > TITLE_DISPLAY_CAP
    ? `${value.slice(0, TITLE_DISPLAY_CAP)}…`
    : value;
}

export function SubAgentCard({ spawn }: { spawn: SubAgentSpawn }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(spawn.status === "running");
  const isError = spawn.status === "error";
  const displayTitle = clipTitle(spawn.title);
  return (
    <div
      className={`w-full max-w-full min-w-0 rounded-md border text-xs ${isError ? "border-destructive/(--opacity-medium) bg-destructive/(--opacity-faint)" : "border-info/(--opacity-medium) bg-info/(--opacity-faint)"}`}
      data-testid="sub-agent-card"
    >
      <button
        className="flex w-full min-w-0 items-center gap-2 px-3 py-1.5 hover:bg-info/(--opacity-subtle)"
        onClick={() => setOpen((o) => !o)}
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <Bot className="h-3 w-3" />
        <span className="min-w-0 truncate font-medium" title={spawn.title}>{displayTitle}</span>
        <Badge variant="outline" className="shrink-0 px-1 py-0 text-[10px]">
          {t("subAgentCard.toolCalls", { count: String(spawn.toolCallCount) })}
        </Badge>
        {spawn.status === "running" ? (
          <Loader2 className="ml-auto h-3 w-3 shrink-0 animate-spin" />
        ) : (
          <Badge
            variant={isError ? "secondary" : "default"}
            className={`ml-auto shrink-0 px-1 py-0 text-[10px] ${isError ? "text-destructive" : ""}`}
          >
            {isError ? t("subAgentCard.statusError") : t("subAgentCard.statusDone")}
          </Badge>
        )}
      </button>
      {open && (
        <div className="min-w-0 space-y-1 border-t px-3 py-2" data-testid="sub-agent-card-transcript">
          {spawn.entries.length > 0 ? (
            <TranscriptRenderer
              entries={spawn.entries}
              streaming={spawn.status === "running"}
              currentSessionId={spawn.spawnId}
            />
          ) : (
            <div className="py-1 text-[11px] opacity-60">
              {spawn.status === "running"
                ? t("subAgentCard.statusRunning")
                : t("subAgentCard.summaryLabel")}
            </div>
          )}
          {spawn.errorMessage && (
            <div className="rounded border border-destructive/(--opacity-medium) bg-destructive/(--opacity-faint) px-2 py-1 text-[11px] text-destructive">
              {spawn.errorMessage}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
