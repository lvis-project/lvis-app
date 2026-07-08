import type React from "react";
import type { RefObject } from "react";
import { useTranslation } from "../../../i18n/react.js";
import { ScrollArea } from "../../../components/ui/scroll-area.js";
import { SkillBadge, type SkillBadgeProps } from "./SkillBadge.js";
import type { ChatEntry } from "../../../lib/chat-stream-state.js";

export interface ChatTranscriptProps {
  scrollViewportRef: RefObject<HTMLDivElement | null>;
  readingColumnClass: string;
  loadedSkills: SkillBadgeProps[];
  visibleEntries: ChatEntry[];
  hasApiKey: boolean | null;
  hasAskQuestions: boolean;
  suggestedRepliesActive: boolean;
  transcriptEntries: React.ReactNode;
  chatEndRef: RefObject<HTMLDivElement | null>;
}

/**
 * Presentational chat transcript scroll region: skill badges, empty state, the
 * rendered transcript entries, and the bottom anchor.
 * Scroll behavior lives in `useChatScroll` — this component only receives the
 * viewport ref + already-rendered nodes.
 */
export function ChatTranscript({
  scrollViewportRef,
  readingColumnClass,
  loadedSkills,
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
      {/* Workflow tools (S1+S2): skill badges + ask-user inline.
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
      {/* No-key state is NOT surfaced here any more. A card in this column
          claimed `min-h-[min(12rem,36vh)]`, which forced ChatView to shrink the
          centered composer's lift to make room — the composer never sat
          optically centered on an empty conversation. The affordance now lives
          in the composer's reserved top strip as `ComposerApiKeyChip`, an
          absolutely-positioned chip + overlay popover that adds zero layout
          height and keeps both of the card's destinations (settings / marketplace). */}
      {transcriptEntries}
      <div ref={chatEndRef} />
    </div></ScrollArea>
  );
}
