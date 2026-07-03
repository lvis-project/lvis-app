/**
 * SubAgentSpawnChip — lightweight main-chat completion notice for a sub-agent
 * spawn, attached beneath the `agent_spawn` tool row in the main transcript.
 *
 * The design (PR3) makes the `agent_spawn` tool call the SOLE inline surface:
 *   - INPUT  — the task (rendered by the normal ToolGroupCard row).
 *   - OUTPUT — this chip: a compact "완료 / 실패" notice + turn/tool counts.
 *   - DETAIL — the full child transcript (tool + reasoning + assistant timeline)
 *              lives in the sub-agent tab (SubAgentViewer), rendered through the
 *              shared TranscriptRenderer.
 *
 * The previous inline `SubAgentCard` (a second full expandable transcript wedged
 * into the main flow) is removed: it duplicated the tab's content and, being
 * stacked, reproduced the 2026-05-07 "user misses it at the top" regression. The
 * chip is a one-line notice, not a transcript.
 */
import { Bot, CheckCircle2, Loader2, XCircle } from "lucide-react";
import { useTranslation } from "../../../i18n/react.js";
import type { SubAgentSpawn } from "./SubAgentCard.js";

export function SubAgentSpawnChip({ spawn }: { spawn: SubAgentSpawn }) {
  const { t } = useTranslation();
  const isError = spawn.status === "error";
  const isRunning = spawn.status === "running";
  return (
    <div
      className={`flex w-full min-w-0 items-center gap-2 rounded-md border px-3 py-1 text-[11px] ${
        isError
          ? "border-destructive/(--opacity-medium) bg-destructive/(--opacity-faint) text-destructive"
          : "border-info/(--opacity-medium) bg-info/(--opacity-faint) text-muted-foreground"
      }`}
      data-testid="sub-agent-spawn-chip"
      data-spawn-status={spawn.status}
    >
      <Bot className="h-3 w-3 shrink-0" />
      <span className="min-w-0 truncate font-medium" title={spawn.title}>
        {spawn.title}
      </span>
      {isRunning ? (
        <Loader2 className="ml-auto h-3 w-3 shrink-0 animate-spin" aria-hidden="true" />
      ) : isError ? (
        <XCircle className="ml-auto h-3 w-3 shrink-0" aria-hidden="true" />
      ) : (
        <CheckCircle2 className="ml-auto h-3 w-3 shrink-0" aria-hidden="true" />
      )}
      <span className="shrink-0 font-medium">
        {isRunning
          ? t("subAgentCard.statusRunning")
          : isError
            ? t("subAgentCard.statusError")
            : t("subAgentCard.statusDone")}
      </span>
      {!isRunning && (
        <span className="shrink-0 opacity-70">
          {t("subAgentCard.toolCalls", { count: String(spawn.toolCallCount) })}
        </span>
      )}
      {/* Detail affordance: the full child transcript lives in the sub-agent
          tab. We label it here so the user knows where to look, matching the
          "자세히 → 탭" spec intent without prop-drilling tab-focus state through
          the whole transcript render tree. */}
      <span className="shrink-0 opacity-60" data-testid="sub-agent-chip-detail-hint">
        {t("subAgentCard.detailInTab")}
      </span>
    </div>
  );
}
