/**
 * SubAgentCard — chat-side card showing a sub-agent spawn lifecycle.
 *
 * Updates from the spawn lifecycle stream (`lvis:agent-spawn:event`):
 *   start → running → turn (n) … → done | error
 *
 * Each card auto-collapses after `done`. The expandable section shows the
 * per-turn snippets and final summary so the user can audit what the
 * sub-agent did.
 */
import { useState } from "react";
import { Bot, ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { Badge } from "../../../components/ui/badge.js";

export interface SubAgentTurn {
  turn: number;
  text: string;
  toolCallCount: number;
}

export interface SubAgentSpawn {
  spawnId: string;
  title: string;
  status: "running" | "done" | "error";
  turns: SubAgentTurn[];
  summary?: string;
  toolCallCount: number;
  errorMessage?: string;
}

/**
 * L2: cap the displayed title so a long attacker-supplied value does not
 * blow up the chat layout. The full value is preserved in the card's
 * tooltip-equivalent (the summary section), so legitimate long titles are
 * still discoverable.
 */
const TITLE_DISPLAY_CAP = 80;
function clipTitle(value: string): string {
  return value.length > TITLE_DISPLAY_CAP
    ? `${value.slice(0, TITLE_DISPLAY_CAP)}…`
    : value;
}

export function SubAgentCard({ spawn }: { spawn: SubAgentSpawn }) {
  const [open, setOpen] = useState(spawn.status === "running");
  const isError = spawn.status === "error";
  const displayTitle = clipTitle(spawn.title);
  return (
    <div
      className={`w-full max-w-full min-w-0 rounded-md border text-xs ${isError ? "border-destructive/40 bg-destructive/5" : "border-blue-500/40 bg-blue-500/5"}`}
      data-testid="sub-agent-card"
    >
      <button
        className="flex w-full min-w-0 items-center gap-2 px-3 py-1.5 hover:bg-blue-500/10"
        onClick={() => setOpen((o) => !o)}
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <Bot className="h-3 w-3" />
        <span className="min-w-0 truncate font-medium" title={spawn.title}>{displayTitle}</span>
        <Badge variant="outline" className="shrink-0 px-1 py-0 text-[10px]">
          {spawn.turns.length} turn
        </Badge>
        {spawn.status === "running" ? (
          <Loader2 className="ml-auto h-3 w-3 shrink-0 animate-spin" />
        ) : (
          <Badge
            variant={isError ? "secondary" : "default"}
            className={`ml-auto shrink-0 px-1 py-0 text-[10px] ${isError ? "text-destructive" : ""}`}
          >
            {isError ? "오류" : "완료"}
          </Badge>
        )}
      </button>
      {open && (
        <div className="min-w-0 space-y-1 border-t px-3 py-1.5">
          {spawn.turns.map((t) => (
            <div key={t.turn} className="min-w-0 rounded border border-dashed/50 px-2 py-1">
              <div className="text-[10px] uppercase opacity-60">Turn {t.turn}</div>
              {t.text && (
                <div className="mt-1 whitespace-pre-wrap break-words text-[11px] opacity-80 [overflow-wrap:anywhere]">
                  {t.text}
                </div>
              )}
            </div>
          ))}
          {spawn.summary && (
            <div className="min-w-0 rounded border bg-background/40 px-2 py-1">
              <div className="text-[10px] uppercase opacity-60">요약</div>
              <div className="mt-1 whitespace-pre-wrap break-words text-[11px] [overflow-wrap:anywhere]">
                {spawn.summary}
              </div>
              <div className="mt-1 text-[10px] opacity-60">
                tool calls: {spawn.toolCallCount}
              </div>
            </div>
          )}
          {spawn.errorMessage && (
            <div className="rounded border border-destructive/40 bg-destructive/5 px-2 py-1 text-[11px] text-destructive">
              {spawn.errorMessage}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
