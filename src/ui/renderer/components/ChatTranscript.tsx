import type React from "react";
import type { RefObject } from "react";
import { KeyRound } from "lucide-react";
import { useTranslation } from "../../../i18n/react.js";
import { Button } from "../../../components/ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../components/ui/card.js";
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
  onOpenSettings: (tab?: string) => void;
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
  onOpenSettings,
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
          ready copy so the user never sees a fake-logged-in race
          where the empty state paints before the boot probe resolves
          (#1014 tracer: Stage B). */}
      {visibleEntries.length === 0 && hasApiKey === true && !hasAskQuestions && !suggestedRepliesActive && (
        <div className="sr-only">
          {t("chatView.emptyState")}
        </div>
      )}
      {visibleEntries.length === 0 && hasApiKey === false && !hasAskQuestions && !suggestedRepliesActive && (
        <div className="flex min-h-[min(18rem,45vh)] items-center justify-center px-2">
          <Card data-testid="chat-view:no-api-key-card" className="w-full max-w-[400px]">
            <CardHeader className="p-4 pb-2 text-center">
              <KeyRound className="mx-auto mb-1 h-8 w-8 text-muted-foreground" />
              <CardTitle className="text-base">{t("chatView.noApiKeyTitle")}</CardTitle>
              <CardDescription className="text-xs">{t("chatView.noApiKeyDescription")}</CardDescription>
            </CardHeader>
            <CardContent className="flex justify-center p-4 pt-0">
              <Button size="sm" onClick={() => onOpenSettings("llm")}>
                <KeyRound className="mr-2 h-4 w-4" />
                {t("chatView.openSettingsButton")}
              </Button>
            </CardContent>
          </Card>
        </div>
      )}
      {transcriptEntries}
      <div ref={chatEndRef} />
    </div></ScrollArea>
  );
}
