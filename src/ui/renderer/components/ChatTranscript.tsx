import type React from "react";
import type { RefObject } from "react";
import { useTranslation } from "../../../i18n/react.js";
import { ScrollArea } from "../../../components/ui/scroll-area.js";
import { SkillBadge, type SkillBadgeProps } from "./SkillBadge.js";
import { SubAgentCard, type SubAgentSpawn } from "./SubAgentCard.js";
import type { ChatEntry } from "../../../lib/chat-stream-state.js";

export interface ChatTranscriptProps {
  scrollViewportRef: RefObject<HTMLDivElement | null>;
  readingColumnClass: string;
  loadedSkills: SkillBadgeProps[];
  orphanSpawns: SubAgentSpawn[];
  visibleEntries: ChatEntry[];
  hasApiKey: boolean | null;
  hasAskQuestions: boolean;
  suggestedRepliesActive: boolean;
  transcriptEntries: React.ReactNode;
  chatEndRef: RefObject<HTMLDivElement | null>;
}

/**
 * Presentational chat transcript scroll region: skill badges, orphan sub-agent
 * cards, empty state, the rendered transcript entries, and the bottom anchor.
 * Scroll behavior lives in `useChatScroll` — this component only receives the
 * viewport ref + already-rendered nodes.
 */
export function ChatTranscript({
  scrollViewportRef,
  readingColumnClass,
  loadedSkills,
  orphanSpawns,
  visibleEntries,
  hasApiKey,
  hasAskQuestions,
  suggestedRepliesActive,
  transcriptEntries,
  chatEndRef,
}: ChatTranscriptProps) {
  const { t } = useTranslation();
  return (
    <ScrollArea type="always" className="lvis-chat-scroll h-full min-h-0 min-w-0 max-w-full" viewportRef={scrollViewportRef}><div className={`min-w-0 overflow-x-hidden space-y-4 py-5 ${readingColumnClass}`}>
      {/* Workflow tools (S1+S2): skill badges + sub-agents + ask-user inline.
          SessionTodoPanel is intentionally NOT here — it sits above the input
          cluster (see below the ScrollArea) so it stays visible regardless of
          chat scroll position. */}
      {loadedSkills.length > 0 && (
        <div className="flex w-full max-w-full flex-wrap gap-2" data-testid="skill-badges-row">
          {loadedSkills.map((s, i) => (
            <SkillBadge key={`${s.name}:${i}`} {...s} />
          ))}
        </div>
      )}
      {/* Orphan-only fallback: spawns without a toolUseId association
          (older events or pre-association race conditions). Spawns with
          a toolUseId render inline next to their ToolGroupCard below. */}
      {orphanSpawns.map((spawn) => (
        <SubAgentCard key={spawn.spawnId} spawn={spawn} />
      ))}
      {/* Ready-state empty-prompt: only when we know `hasApiKey === true`.
          `null` (still loading) and `false` (no key) both suppress the
          "준비되었습니다" copy so the user never sees a "로그인된 척" race
          where the empty state paints before the boot probe resolves
          (#1014 tracer: Stage B). */}
      {visibleEntries.length === 0 && hasApiKey === true && !hasAskQuestions && !suggestedRepliesActive && (
        <div className="sr-only">
          {t("chatView.emptyState")}
        </div>
      )}
      {transcriptEntries}
      <div ref={chatEndRef} />
    </div></ScrollArea>
  );
}
