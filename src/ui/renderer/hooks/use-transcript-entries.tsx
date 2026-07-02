import { Fragment, useMemo } from "react";
import type React from "react";
import { useTranslation } from "../../../i18n/react.js";
import { Button } from "../../../components/ui/button.js";
import { GitBranch, Pencil, Star } from "lucide-react";
import type { ChatEntry } from "../../../lib/chat-stream-state.js";
import type { LLMVendor } from "../../../shared/llm-vendor-defaults.js";
import { debugLog } from "../../../lib/debug-stream.js";
import { detectFromStream } from "../../../lib/stream-markers.js";
import { lookupBillablePricingOptional } from "../../../shared/pricing-data.js";
import { highlightText } from "../utils/html-preview.js";
import { classifyTurnEntries, isTurnStartEntry } from "../utils/classify-turn-entries.js";
import { entryRenderRevision, subAgentRevision } from "../utils/chat-entry-revision.js";
import { AssistantCard } from "../components/AssistantCard.js";
import { UserMessageEditor } from "../components/UserMessageEditor.js";
import { ReasoningCard } from "../components/ReasoningCard.js";
import { ToolGroupCard } from "../components/ToolGroupCard.js";
import { CheckpointDivider } from "../components/CheckpointDivider.js";
import { SummaryToast } from "../components/SummaryToast.js";
import type { ViewModeState } from "../components/ViewModeBanner.js";
import { SessionResumeDivider } from "../components/SessionResumeDivider.js";
import { WorkGroup } from "../components/WorkGroup.js";
import { PermissionReviewStatusCard } from "../components/PermissionReviewStatusCard.js";
import { TurnActionBar } from "../components/TurnActionBar.js";
import { ImportedTriggerCard } from "../components/ImportedTriggerCard.js";
import { AskUserAnswerBubble } from "../components/AskUserAnswerBubble.js";
import type { SubAgentSpawn } from "../components/SubAgentCard.js";

/**
 * Per-turn provider-reported usage summary, keyed by turn-start entry index.
 * Built in ChatView (from `turn_summary` entries) and consumed here to feed the
 * WorkGroup step count / duration and the final TurnActionBar cost badge.
 */
export type TurnSummary = {
  turnDurationMs: number;
  toolCount: number;
  cumulativeToolMs: number;
  tokensIn: number;
  freshInputTokens: number;
  tokensOut: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  vendorProvider?: LLMVendor;
  vendorModel?: string;
  usageByModel?: Extract<ChatEntry, { kind: "turn_summary" }>["usageByModel"];
};

export interface UseTranscriptEntriesParams {
  visibleEntries: ChatEntry[];
  streaming: boolean;
  currentSessionId: string;
  viewMode: ViewModeState | null;
  editingEntryIdx: number | null;
  editBusy: boolean;
  setEditingEntryIdx: (i: number | null) => void;
  searchOpen: boolean;
  searchMatches: number[];
  searchMatchSet: Set<number>;
  searchIdx: number;
  searchHighlight: string;
  isEntryStarred: (idx: number) => string | null;
  onEditSave: (idx: number, text: string) => void | Promise<void>;
  onFork: (idx: number) => void | Promise<void>;
  onToggleStar: (idx: number) => void | Promise<void>;
  onRetryEffort: () => void | Promise<void>;
  onFeedback?: (messageIdx: number, rating: "up" | "down", reason?: string) => void | Promise<void>;
  activeVendor: LLMVendor;
  debugStreamEnabled: boolean;
  spawnsByToolUseId: Map<string, SubAgentSpawn[]>;
  renderSpawnsForGroup: (group: { tools: { toolUseId: string }[] }) => React.ReactNode[];
  turnSummaryByTurnStart: Map<number, TurnSummary>;
  handleEnterView: (compactNum: number) => Promise<void> | void;
  handleBranchFrom: (compactNum: number) => Promise<void> | void;
}

/**
 * Builds the ChatView transcript node list. Extracted verbatim from ChatView's
 * `transcriptEntries` useMemo (same three-way turn classification + WorkGroup
 * collapsing + TurnActionBar-only-when-complete behavior). All data-testids and
 * i18n keys are byte-identical; the memo dependency array is preserved exactly.
 */
export function useTranscriptEntries({
  visibleEntries,
  streaming,
  currentSessionId,
  viewMode,
  editingEntryIdx,
  editBusy,
  setEditingEntryIdx,
  searchOpen,
  searchMatches,
  searchMatchSet,
  searchIdx,
  searchHighlight,
  isEntryStarred,
  onEditSave,
  onFork,
  onToggleStar,
  onRetryEffort,
  onFeedback,
  activeVendor,
  debugStreamEnabled,
  spawnsByToolUseId,
  renderSpawnsForGroup,
  turnSummaryByTurnStart,
  handleEnterView,
  handleBranchFrom,
}: UseTranscriptEntriesParams): React.ReactNode[] {
  const { t } = useTranslation();
  return useMemo(() => {
  // Three-way entry classification eliminates retroactive-reclassification flicker.
  //
  // "intermediate" — non-final work inside a user turn. This includes
  //                  reasoning, tools, and mid-turn assistant text.
  //                  Once the final assistant answer lands, all prior
  //                  work collapses into one WorkGroup.
  // "live"         — standalone non-final edge entry.
  // "final"        — last assistant entry outside the active streaming turn
  //                  → shown with TurnActionBar (turn truly complete)
  //
  // TurnActionBar therefore appears ONLY when the whole turn is done, never during it.

  // Use visibleEntries (sliced in view-mode, full list otherwise).
  const activeEntries = visibleEntries;

  const { lastTurnStartIdx, entryClassMap, finalTurnStartMap, entryTurnStartMap } =
    classifyTurnEntries(activeEntries, streaming);

  const rendered: React.ReactNode[] = [];
  let i = 0;
  while (i < activeEntries.length) {
    const entry = activeEntries[i];
    if (!entry) { i++; continue; }
    // Capture idx by value — closures in this loop must not close over mutable `i`
    const idx = i;

    const ringClassFor = (entryIdx: number) => {
      const isMatch = searchMatchSet.has(entryIdx);
      const isCurrentMatch = searchOpen && searchMatches[searchIdx] === entryIdx;
      return isCurrentMatch ? "ring-2 ring-primary" : isMatch ? "ring-1 ring-primary/(--opacity-medium)" : "";
    };
    const ringCls = ringClassFor(idx);

    if (entry.kind === "user") {
      // Add extra breathing room only after a *completed* assistant
      // turn (whose action bar sits at the bottom of the card).
      // Skip the gap for day/session markers, session-opening user
      // turns, and mid-stream guidance messages where the previous
      // assistant entry is still streaming and has no action bar
      // yet. `!mt-4` uses Tailwind's important prefix to outweigh
      // the parent's `space-y-3` specificity (the descendant
      // selector `> :not([hidden]) ~ :not([hidden])` otherwise
      // wins).
      const prevEntry = i > 0 ? activeEntries[i - 1] : undefined;
      const prevAssistantComplete =
        prevEntry?.kind === "assistant" && prevEntry.streaming !== true;
      const userGapCls = prevAssistantComplete ? "!mt-4" : "";
      if (editingEntryIdx === i) {
        rendered.push(
          <div key={idx} className={userGapCls}>
            <UserMessageEditor
              initialText={entry.text}
              busy={editBusy}
              onCancel={() => setEditingEntryIdx(null)}
              onSave={(next) => void onEditSave(idx, next)}
            />
          </div>
        );
      } else {
        const starId = isEntryStarred(idx);
        const starActive = !!starId;
        rendered.push(
          <div key={idx} data-chat-entry-index={idx} className={`group relative ml-auto w-fit min-w-0 max-w-[75%] overflow-hidden rounded-lg bg-message-user px-3.5 py-2.5 text-sm text-message-user-foreground shadow-sm ${userGapCls} ${ringCls}`}>
            {/* "나" label removed — sender is implicit. Star + hover
                actions float top-right via absolute positioning so
                the bubble has no header chrome. */}
            {entry.injectHint === "queue" ? (
              <div className="mb-1 inline-flex items-center gap-1 rounded bg-message-user-foreground/(--opacity-subtle) px-1.5 py-0.5 text-[10px] text-message-user-foreground/(--opacity-stronger)" title={t("chatView.queueInjectTitle")}>
                {t("chatView.queueInjectLabel")}
              </div>
            ) : entry.injectHint === "interrupt" ? (
              <div className="mb-1 inline-flex items-center gap-1 rounded bg-message-user-foreground/(--opacity-subtle) px-1.5 py-0.5 text-[10px] text-message-user-foreground/(--opacity-stronger)" title={t("chatView.interruptTitle")}>
                {t("chatView.interruptLabel")}
              </div>
            ) : null}
            {starActive ? (
              <Star key="active" className="absolute right-2 top-2 h-3 w-3 fill-emphasis text-emphasis lvis-anim-star" />
            ) : null}
            {/* Hide mutating actions in view-mode (read-only slice). */}
            {!viewMode && (
              <div className="absolute right-2 top-2 hidden gap-1 group-hover:flex bg-message-user/(--opacity-solid) rounded">
                <Button type="button" variant="ghost" size="icon-xs" title={t("chatView.editButtonTitle")} onClick={() => setEditingEntryIdx(idx)}>
                  <Pencil className="h-3 w-3" />
                </Button>
                <Button type="button" variant="ghost" size="icon-xs" title={t("chatView.forkButtonTitle")} onClick={() => void onFork(idx)}>
                  <GitBranch className="h-3 w-3" />
                </Button>
                <Button type="button" variant="ghost" size="icon-xs" title={t("chatView.starButtonTitle")} onClick={() => void onToggleStar(idx)}>
                  <Star key={starActive ? "on" : "off"} className={`h-3 w-3 ${starActive ? "fill-emphasis text-emphasis lvis-anim-star" : ""}`} />
                </Button>
              </div>
            )}
            <div className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{searchHighlight ? highlightText(entry.text, searchHighlight) : entry.text}</div>
          </div>
        );
      }
      const hasCurrentTurnOutput = activeEntries
        .slice(idx + 1)
        .some(
          (nextEntry) =>
            nextEntry.kind === "assistant" ||
            nextEntry.kind === "reasoning" ||
            nextEntry.kind === "tool_group" ||
            nextEntry.kind === "permission_review",
        );
      if (streaming && idx === lastTurnStartIdx && !hasCurrentTurnOutput) {
        rendered.push(
          <WorkGroup
            key={`wg-${currentSessionId}:${idx}:active-start`}
            stepCount={0}
            streaming
            revision={`${currentSessionId}:${idx}:active-start`}
          >
            {null}
          </WorkGroup>,
        );
      }
      i++;
      continue;
    }

    if (entry.kind === "ask_user_answer") {
      rendered.push(<AskUserAnswerBubble key={idx} entry={entry} />);
      i++;
      continue;
    }

    if (entry.kind === "system") {
      rendered.push(
        <div
          key={idx}
          data-testid="system-entry"
          className="mx-auto text-center text-xs text-muted-foreground py-1 px-3 rounded-full bg-muted/(--opacity-medium) border border-border/(--opacity-medium)"
        >
          {entry.text}
        </div>,
      );
      i++;
      continue;
    }

    // turn_summary entry — 데이터 carrier 로 history 에 남기되 standalone
    // 렌더링 안 함. 같은 turn 의 final AssistantCard / WorkGroup 이
    // turnSummaryByTurnStart 에서 lookup 해 inline 으로 표시한다.
    if (entry.kind === "turn_summary" || entry.kind === "context_usage") {
      i++;
      continue;
    }

    // Structured compact checkpoint marker — auto-compact 및 manual compact 모두 CheckpointDivider 로 렌더.
    // CheckpointDivider 의 trigger prop 이 auto/manual variant 를 구분.
    // sessionId 불변이라 revert 액션 없음.
    // SummaryToast 가 rendered preamble (12-section structured summary) 노출.
    if (entry.kind === "checkpoint") {
      rendered.push(
        <CheckpointDivider
          key={`cp-${idx}`}
          trigger={entry.trigger}
          messageCount={entry.removedMessages}
          compactNum={entry.compactNum}
          compactStatus={entry.compactStatus}
          truncatedDir={entry.truncatedDir}
          onEnterView={handleEnterView}
          onBranchFrom={handleBranchFrom}
        />,
      );
      if (entry.summary) {
        rendered.push(
          <SummaryToast key={`cp-${idx}-summary`} summary={entry.summary} />,
        );
      }
      i++;
      continue;
    }

    if (entry.kind === "session_resume") {
      rendered.push(
        <SessionResumeDivider
          key={`sr-${idx}`}
          preambleChars={entry.preambleChars}
        />,
      );
      i++;
      continue;
    }

    if (entry.kind === "imported_trigger") {
      rendered.push(
        <ImportedTriggerCard
          key={`trigger:${entry.sessionId}`}
          entry={entry}
        />,
      );
      i++;
      continue;
    }

    // ── Intermediate: collect contiguous turn work into one WorkGroup ──
    if (entryClassMap.get(i) === "intermediate") {
      const groupStart = i;
      const groupTurnStart = entryTurnStartMap.get(i) ?? 0;
      // Spinner is shown only while this WorkGroup belongs to the currently active turn
      const groupIsActiveTurn = groupTurnStart === lastTurnStartIdx && streaming;
      if (debugStreamEnabled && groupIsActiveTurn) {
        debugLog("ChatView", "WorkGroup:render-decision", {
          groupStart,
          groupTurnStart,
          lastTurnStartIdx,
          globalStreaming: streaming,
          groupIsActiveTurn,
        });
      }
      const groupEntries: { idx: number; node: React.ReactNode }[] = [];
      const groupRevisions: string[] = [];
      let groupHasPermissionReview = false;

      while (i < activeEntries.length) {
        const e = activeEntries[i];
        if (!e) { i++; continue; }
        if ((entryTurnStartMap.get(i) ?? groupTurnStart) !== groupTurnStart) break;
        const cls = entryClassMap.get(i);
        if (cls === "final") break;
        if (e.kind === "reasoning") {
          if (cls === "intermediate") {
            groupRevisions.push(entryRenderRevision({ entry: e, idx: i, searchHighlight, starred: false }));
            groupEntries.push({ idx: i, node: <ReasoningCard key={i} entry={e} /> });
          } else {
            break;
          }
        } else if (e.kind === "permission_review") {
          if (cls === "intermediate") {
            if (e.status === "reviewing" || e.status === "auto_approved") {
              groupHasPermissionReview = true;
            }
            groupRevisions.push(entryRenderRevision({ entry: e, idx: i, searchHighlight, starred: false }));
            groupEntries.push({
              idx: i,
              node: <PermissionReviewStatusCard key={`permission-review-${e.toolUseId}`} entry={e} />,
            });
          } else {
            break;
          }
        } else if (e.kind === "tool_group") {
          if (cls === "intermediate") {
            const spawnRevisions = e.tools.flatMap((tool) =>
              (spawnsByToolUseId.get(tool.toolUseId) ?? []).map(subAgentRevision),
            );
            const spawnNodes = renderSpawnsForGroup(e);
            groupRevisions.push(entryRenderRevision({ entry: e, idx: i, searchHighlight, starred: false, spawnRevisions }));
            groupEntries.push({
              idx: i,
              node: spawnNodes.length === 0 ? (
                <ToolGroupCard key={e.groupId} group={e} sessionId={currentSessionId} />
              ) : (
                <Fragment key={e.groupId}>
                  <ToolGroupCard group={e} sessionId={currentSessionId} />
                  {spawnNodes}
                </Fragment>
              ),
            });
          } else {
            break;
          }
        } else if (e.kind === "assistant") {
          if (cls === "intermediate") {
            const starred = !!isEntryStarred(i);
            groupRevisions.push(entryRenderRevision({ entry: e, idx: i, searchHighlight, starred }));
            groupEntries.push({
              idx: i,
              node: (
                <AssistantCard
                  key={i}
                  entry={e}
                  isStarred={starred}
                  isFinal={false}
                />
              ),
            });
          } else {
            break;
          }
        } else if (e.kind === "ask_user_answer") {
          // ask_user_question 의 사용자 응답 카드도 같은 turn 의
          // WorkGroup 안에 inline 으로 흡수. 이전: 이 branch 가 없어
          // default break 로 떨어지면서 WorkGroup 가 분리 → 사용자가
          // "작업 3단계 + 작업 9단계" 로 보이던 UX 분리 (2026-05-07).
          // entryTurnStartMap 에는 ask_user_answer 가 없어 line 901
          // 의 fallback 으로 같은 turn 처리되었으나, 여기서 명시 push
          // 가 없으면 default `break` 로 떨어짐. 안전을 위해 walkback
          // 으로 turnStart 일치 검증.
          let aaTurnStart = -1;
          for (let k = i; k >= 0; k--) {
            if (isTurnStartEntry(activeEntries[k])) { aaTurnStart = k; break; }
          }
          if (aaTurnStart === groupTurnStart) {
            groupRevisions.push(entryRenderRevision({ entry: e, idx: i, searchHighlight, starred: false }));
            groupEntries.push({
              idx: i,
              node: <AskUserAnswerBubble key={`ask-${i}`} entry={e} />,
            });
          } else {
            break;
          }
        } else {
          break;
        }
        i++;
      }

      if (groupEntries.length > 0) {
        // Prefer the turn_summary's authoritative `toolCount` over
        // groupEntries.length — the latter includes reasoning /
        // assistant bubbles / ask_user_answer / inline sub-agent
        // cards and would diverge from the actual tool-call count.
        const groupSummary = turnSummaryByTurnStart.get(groupTurnStart);
        rendered.push(
          <WorkGroup
            key={`wg-${currentSessionId}:${groupStart}`}
            stepCount={groupSummary?.toolCount ?? groupEntries.length}
            streaming={groupIsActiveTurn}
            turnDurationMs={groupSummary?.turnDurationMs}
            revision={[currentSessionId, ...groupRevisions].join("||")}
            forceOpen={groupHasPermissionReview}
          >
            {groupEntries.map((ge) => (
              <div key={ge.idx} data-chat-entry-index={ge.idx}>
                {ge.node}
              </div>
            ))}
          </WorkGroup>
        );
      }
      continue;
    }

    // ── Live: last entry in turn while streaming — no TurnActionBar ──
    if (entryClassMap.get(i) === "live") {
      if (entry.kind === "reasoning") {
        rendered.push(<ReasoningCard key={idx} entry={entry} />);
      } else if (entry.kind === "permission_review") {
        rendered.push(<PermissionReviewStatusCard key={`permission-review-${entry.toolUseId}`} entry={entry} />);
      } else if (entry.kind === "tool_group") {
        rendered.push(<ToolGroupCard key={entry.groupId} group={entry} sessionId={currentSessionId} />);
        for (const node of renderSpawnsForGroup(entry)) rendered.push(node);
      } else if (entry.kind === "assistant") {
        rendered.push(
          <div key={idx} data-chat-entry-index={idx} className={`min-w-0 w-full max-w-full overflow-x-hidden rounded-lg${ringCls ? ` ${ringCls}` : ""}`}>
            <AssistantCard
              entry={entry}
              isStarred={!!isEntryStarred(idx)}
              isFinal={true}
            />
          </div>
        );
      }
      i++;
      continue;
    }

    // ── Final: turn complete, last assistant — show TurnActionBar ──
    if (entryClassMap.get(i) === "final" && entry.kind === "assistant") {
      const turnStartIdx = finalTurnStartMap.get(i) ?? 0;
      const summary = turnSummaryByTurnStart.get(turnStartIdx);
      const summaryVendor = summary?.vendorProvider;
      const summaryPricing = summary?.vendorProvider && summary.vendorModel
        ? lookupBillablePricingOptional(summary.vendorProvider, summary.vendorModel)
        : undefined;
      rendered.push(
          <div key={idx} data-chat-entry-index={idx} className={`${ringCls} min-w-0 w-full max-w-full overflow-x-hidden rounded-lg`}>
          <AssistantCard
            entry={entry}
            isStarred={!!isEntryStarred(idx)}
            isFinal={true}
          />
          {/* Suppress mutating TurnActionBar actions in view-mode. */}
          <TurnActionBar
            timestamp={entry.kind === "assistant" ? entry.createdAt : undefined}
            turnSummary={summary}
            pricing={summaryPricing}
            vendor={summaryVendor ?? activeVendor}
            isStarred={!!isEntryStarred(idx)}
            copyText={detectFromStream(entry.text || "").cleanedText || undefined}
            actions={viewMode ? {} : {
              onRetry: () => void onRetryEffort(),
              onFork: () => void onFork(idx),
              onToggleStar: () => void onToggleStar(idx),
            }}
            onFeedback={!viewMode && onFeedback ? (rating, reason) => void onFeedback(idx, rating, reason) : undefined}
          />
        </div>
      );
      i++;
      continue;
    }

    // ── Fallback: unclassified edge-case entries ──
    if (entry.kind === "reasoning") {
      rendered.push(<ReasoningCard key={idx} entry={entry} />);
    } else if (entry.kind === "permission_review") {
      rendered.push(<PermissionReviewStatusCard key={`permission-review-${entry.toolUseId}`} entry={entry} />);
    } else if (entry.kind === "tool_group") {
      rendered.push(<ToolGroupCard key={entry.groupId} group={entry} sessionId={currentSessionId} />);
      for (const node of renderSpawnsForGroup(entry)) rendered.push(node);
    }
    i++;
  }
  return rendered;
  }, [
    activeVendor,
    currentSessionId,
    debugStreamEnabled,
    editBusy,
    editingEntryIdx,
    handleBranchFrom,
    handleEnterView,
    isEntryStarred,
    onEditSave,
    onFeedback,
    onFork,
    onRetryEffort,
    onToggleStar,
    renderSpawnsForGroup,
    spawnsByToolUseId,
    searchHighlight,
    searchIdx,
    searchMatchSet,
    searchMatches,
    searchOpen,
    setEditingEntryIdx,
    streaming,
    turnSummaryByTurnStart,
    viewMode,
    visibleEntries,
  ]);
}
