import { useMemo, useState } from "react";
import type React from "react";
import { useTranslation } from "../../../i18n/react.js";
import ReactMarkdown from "react-markdown";
import { MARKDOWN_REMARK_PLUGINS } from "../utils/markdown-plugins.js";
import { parseStagedEnvelope } from "../../../shared/staged-origins.js";
import { Button } from "../../../components/ui/button.js";
import { Bot, Brain, ChevronDown, ChevronRight, GitBranch, Loader2, Pencil, Undo2 } from "lucide-react";
import type { ChatEntry, CheckpointTrigger } from "../../../lib/chat-stream-state.js";
import type { LLMVendor } from "../../../shared/llm-vendor-defaults.js";
import { debugLog } from "../../../lib/debug-stream.js";
import { detectFromStream } from "../../../lib/stream-markers.js";
import { lookupBillablePricingOptional } from "../../../shared/pricing-data.js";
import { highlightText } from "../utils/html-preview.js";
import { trustOriginLabel } from "../utils/trust-origin-label.js";
import { classifyTurnEntries, isTurnStartEntry } from "../utils/classify-turn-entries.js";
import { formatHhMmKst } from "../utils/format-time.js";
import { entryRenderRevision } from "../utils/chat-entry-revision.js";
import { AssistantCard } from "./AssistantCard.js";
import { UserMessageEditor } from "./UserMessageEditor.js";
import { ToolGroupCard } from "./ToolGroupCard.js";
import type { ViewModeState } from "./ViewModeBanner.js";
import { WorkGroup } from "./WorkGroup.js";
import { PermissionReviewStatusCard } from "./PermissionReviewStatusCard.js";
import { TurnActionBar } from "./TurnActionBar.js";
import {
  useNativeContextMenu,
  type NativeContextMenuHandlers,
} from "../hooks/use-native-context-menu.js";

type PermissionReviewEntry = Extract<ChatEntry, { kind: "permission_review" }>;

/**
 * Per-turn provider-reported usage summary, keyed by turn-start entry index.
 * Built by the caller (from `turn_summary` entries) and consumed here to feed
 * the WorkGroup step count / duration and the final TurnActionBar cost badge.
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
  subscriptionUsage?: Extract<ChatEntry, { kind: "turn_summary" }>["subscriptionUsage"];
};

/**
 * Edit-cluster props: cohesion group co-derived from the transcript in the
 * caller. Presence enables the inline user-message editor + the "edit" hover
 * action. Omit to render the transcript read-only (side-chat / sub-agent).
 */
export interface TranscriptEditProps {
  editingEntryIdx: number | null;
  editBusy: boolean;
  setEditingEntryIdx: (i: number | null) => void;
  onEditSave: (idx: number, text: string) => void | Promise<void>;
}

/**
 * Search-cluster props: highlight + match-ring state. Omit to render without
 * search highlighting (defaults collapse to no ring, no highlight).
 */
export interface TranscriptSearchProps {
  searchOpen: boolean;
  searchMatches: number[];
  searchMatchSet: Set<number>;
  searchIdx: number;
  searchHighlight: string;
}

/**
 * Action-cluster props: mutating per-entry / per-turn actions (fork, rewind,
 * star, retry, feedback) + checkpoint navigation. Each action renders only when
 * its callback is present (side-chat omits the cluster to opt out of all
 * actions). `isEntryStarred` defaults to `() => null` so the star indicator is
 * inert when the caller does not track starred state.
 */
export interface TranscriptActionProps {
  isEntryStarred?: (idx: number) => string | null;
  onFork?: (idx: number) => void | Promise<void>;
  /**
   * Rewind to just before this user message: the conversation from it onward is
   * discarded and its text goes back into the composer, unsent. Distinct from
   * edit (which resends) and fork (which branches into a new session).
   */
  onReturnHere?: (idx: number) => void | Promise<void>;
  onToggleStar?: (idx: number) => void | Promise<void>;
  onRetryEffort?: () => void | Promise<void>;
  onFeedback?: (messageIdx: number, rating: "up" | "down", reason?: string) => void | Promise<void>;
  handleEnterView?: (compactNum: number) => Promise<void> | void;
  handleBranchFrom?: (compactNum: number) => Promise<void> | void;
}

export interface SharedTranscriptProps {
  entries: ChatEntry[];
  streaming: boolean;
  currentSessionId: string;

  // --- all optional; absence = the feature is omitted for this source ---
  turnSummaryByTurnStart?: Map<number, TurnSummary>;
  edit?: TranscriptEditProps;
  search?: TranscriptSearchProps;
  actions?: TranscriptActionProps;

  /**
   * Checkpoint read-only slice banner state. Suppresses mutating actions on the
   * main path even when the action callbacks are present. Omit (default `null`)
   * for sources that never enter a checkpoint slice.
   */
  viewMode?: ViewModeState | null;

  /** Final TurnActionBar vendor fallback when a turn_summary has no vendor. */
  activeVendor?: LLMVendor;

  /**
   * False when the active runtime has no API-key billing contract. A validated
   * subscription telemetry segment still renders its token-only badge.
   */
  showTokenCostBadge?: boolean;

  /** When true, WorkGroup render decisions are traced via debugLog. */
  debugStreamEnabled?: boolean;

  /**
   * Read-only companion surfaces such as the sub-agent side panel need the same
   * WorkGroup / ToolGroup SOT as main chat, but with historical content visible
   * immediately after selecting a row.
   */
  workGroupsForceOpen?: boolean;
}

const NO_STAR: () => string | null = () => null;

/**
 * Shared, context-free transcript renderer. Builds the ordered node list from a
 * ChatEntry array using the three-way turn classification + WorkGroup collapsing
 * + TurnActionBar-only-when-complete behavior. Extracted verbatim from ChatView's
 * `transcriptEntries` useMemo — all data-testids and i18n keys are byte-identical
 * and the memo dependency array is preserved exactly.
 *
 * Capability differences between the three chat sources (main / side-chat /
 * sub-agent) are expressed as optional prop clusters. Individual mutating
 * actions render only when their callback is present, so a read-only source that
 * omits `actions` shows no fork / star / retry / feedback affordances.
 */
export function TranscriptRenderer({
  entries,
  streaming,
  currentSessionId,
  turnSummaryByTurnStart,
  edit,
  search,
  actions,
  viewMode = null,
  activeVendor,
  showTokenCostBadge = true,
  debugStreamEnabled = false,
  workGroupsForceOpen = false,
}: SharedTranscriptProps): React.ReactElement {
  const { t } = useTranslation();
  const openNativeContextMenu = useNativeContextMenu();

  // Cluster fields with explicit inert defaults. These defaults ARE the
  // no-regression contract: forgetting one produces wrong runtime output
  // (footers / actions silently vanish) with no type error.
  const summaryByTurnStart = turnSummaryByTurnStart;
  const editingEntryIdx = edit?.editingEntryIdx ?? null;
  const editBusy = edit?.editBusy ?? false;
  const setEditingEntryIdx = edit?.setEditingEntryIdx;
  const onEditSave = edit?.onEditSave;

  const searchOpen = search?.searchOpen ?? false;
  const searchMatches = search?.searchMatches;
  const searchMatchSet = search?.searchMatchSet;
  const searchIdx = search?.searchIdx ?? 0;
  const searchHighlight = search?.searchHighlight ?? "";

  const isEntryStarred = actions?.isEntryStarred ?? NO_STAR;
  const onFork = actions?.onFork;
  const onReturnHere = actions?.onReturnHere;
  const onToggleStar = actions?.onToggleStar;
  const onRetryEffort = actions?.onRetryEffort;
  const onFeedback = actions?.onFeedback;
  const handleEnterView = actions?.handleEnterView;
  const handleBranchFrom = actions?.handleBranchFrom;

  const rendered = useMemo(() => {
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

  // Use entries (sliced in view-mode, full list otherwise for the main source).
  const activeEntries = entries;

  // A permission review belongs to one tool call, so it renders ON that tool's
  // row (ToolGroupCard) whenever the row exists — main chat and the sub-agent
  // panel both come through here, so both surfaces show the same thing. A
  // standalone card is left only for verdicts with no row: a review still in
  // flight before tool_start, a pending approval, or a tool that never ran.
  const permissionReviewsByToolUseId = new Map<string, PermissionReviewEntry>();
  const toolUseIdsWithRow = new Set<string>();
  for (const candidate of activeEntries) {
    if (candidate.kind === "permission_review") {
      permissionReviewsByToolUseId.set(candidate.toolUseId, candidate);
    } else if (candidate.kind === "tool_group") {
      for (const tool of candidate.tools) toolUseIdsWithRow.add(tool.toolUseId);
    }
  }
  const rendersOnToolRow = (candidate: PermissionReviewEntry): boolean =>
    toolUseIdsWithRow.has(candidate.toolUseId);

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
      const isMatch = searchMatchSet?.has(entryIdx) ?? false;
      const isCurrentMatch = searchOpen && searchMatches?.[searchIdx] === entryIdx;
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
      // A sub-agent report enters the parent transcript as a user-role message
      // because that is how the model receives it — but it is not the user's
      // text and must not read as such. It gets its own left-aligned box with
      // the reporting child named, and none of the edit/fork/pin affordances
      // that only make sense on something the user wrote.
      if (entry.injectHint === "sub-agent") {
        rendered.push(
          <div
            key={idx}
            data-chat-entry-index={idx}
            data-testid="subagent-report-entry"
            className={`mr-auto w-fit min-w-0 max-w-[85%] ${userGapCls}`}
          >
            <div
              data-testid="subagent-report-bubble"
              className={`min-w-0 overflow-hidden rounded-lg border border-primary/(--opacity-medium) bg-muted/(--opacity-subtle) px-3.5 py-2.5 text-body-sm text-foreground shadow-sm ${ringCls}`}
            >
              <div
                data-testid="subagent-report-label"
                className="mb-1 inline-flex items-center gap-1 rounded bg-muted/(--opacity-medium) px-1.5 py-0.5 text-micro text-muted-foreground"
                title={t("chatView.subAgentReportTitle")}
              >
                <Bot className="h-3 w-3 text-primary" />
                {entry.subAgentTitle
                  ? t("chatView.subAgentReportLabelNamed", { title: entry.subAgentTitle })
                  : t("chatView.subAgentReportLabel")}
              </div>
              <div className="cursor-text select-text whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                {searchHighlight ? highlightText(entry.text, searchHighlight) : entry.text}
              </div>
            </div>
          </div>,
        );
      } else if (editingEntryIdx === i && setEditingEntryIdx && onEditSave) {
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
        // Hover actions render only when their callbacks are present. Main
        // passes them (identical to pre-extraction); read-only sources omit
        // the edit/action clusters, so no dangling handlers are wired.
        const showHoverActions =
          !viewMode && (!!setEditingEntryIdx || !!onFork || !!onReturnHere);
        // The send time is persisted on the message, so it is shown as recorded
        // or not at all — a card with no recorded time must not invent one.
        const sentAtLabel = formatHhMmKst(entry.createdAt);
        rendered.push(
          <div
            key={idx}
            data-chat-entry-index={idx}
            className={`group relative ml-auto w-fit min-w-0 max-w-[75%] ${userGapCls}`}
            onContextMenu={(event) =>
              openNativeContextMenu(event, "message", {
                "message.copy": () => void navigator.clipboard?.writeText(entry.text),
                ...(!viewMode && setEditingEntryIdx
                  ? { "message.edit": () => setEditingEntryIdx(idx) }
                  : {}),
                ...(!viewMode && onFork
                  ? { "message.fork": () => void onFork(idx) }
                  : {}),
                ...(!viewMode && onReturnHere && !streaming
                  ? { "message.returnHere": () => void onReturnHere(idx) }
                  : {}),
              } as NativeContextMenuHandlers)
            }
          >
            <div
              data-testid="user-message-bubble"
              className={`min-w-0 overflow-hidden rounded-lg border border-message-user-border bg-message-user px-3.5 py-2.5 text-body-sm text-message-user-foreground shadow-sm ${ringCls}`}
            >
              {/* Sender is implicit. Metadata stays above the selectable body. */}
              {entry.origin ? (
                <div
                  data-testid="user-message-origin-badge"
                  className="mb-1 inline-flex items-center gap-1 rounded bg-message-user-muted/(--opacity-subtle) px-1.5 py-0.5 text-micro text-message-user-muted"
                  title={trustOriginLabel(entry.origin)}
                >
                  {trustOriginLabel(entry.origin)}
                </div>
              ) : null}
              {entry.injectHint === "queue" ? (
                <div className="mb-1 inline-flex items-center gap-1 rounded bg-message-user-muted/(--opacity-subtle) px-1.5 py-0.5 text-micro text-message-user-muted" title={t("chatView.queueInjectTitle")}>
                  {t("chatView.queueInjectLabel")}
                </div>
              ) : entry.injectHint === "interrupt" ? (
                <div className="mb-1 inline-flex items-center gap-1 rounded bg-message-user-muted/(--opacity-subtle) px-1.5 py-0.5 text-micro text-message-user-muted" title={t("chatView.interruptTitle")}>
                  {t("chatView.interruptLabel")}
                </div>
              ) : null}
              <div className="cursor-text select-text whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{searchHighlight ? highlightText(entry.text, searchHighlight) : entry.text}</div>
            </div>
            {/* Keep a fixed footer slot outside the bubble. The send time holds
                the row open, so revealing the controls changes only opacity and
                transform, never message or transcript height. */}
            {(showHoverActions || sentAtLabel) && (
              <div className="mt-1 flex h-7 items-center justify-end gap-1">
                {sentAtLabel ? (
                  <span data-testid="user-message-time" className="shrink-0 px-1 text-xs text-muted-foreground">
                    {sentAtLabel}
                  </span>
                ) : null}
                {showHoverActions ? (
                  <div
                    data-testid="user-message-actions"
                    className="flex translate-y-1 gap-1 opacity-0 pointer-events-none transition-[opacity,transform] duration-[var(--motion-fast)] ease-[var(--motion-ease-out)] group-hover:translate-y-0 group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:translate-y-0 group-focus-within:opacity-100 group-focus-within:pointer-events-auto motion-reduce:transition-none motion-reduce:transform-none"
                  >
                    {setEditingEntryIdx ? (
                      <Button type="button" variant="ghost" size="icon-xs" className="text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-ring" title={t("chatView.editButtonTitle")} onClick={() => setEditingEntryIdx(idx)}>
                        <Pencil className="h-3 w-3" />
                      </Button>
                    ) : null}
                    {onFork ? (
                      <Button type="button" variant="ghost" size="icon-xs" className="text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-ring" title={t("chatView.forkButtonTitle")} onClick={() => void onFork(idx)}>
                        <GitBranch className="h-3 w-3" />
                      </Button>
                    ) : null}
                    {/* Rewinding drops the turns after this message, so it is
                        offered only when no turn is producing more of them. */}
                    {onReturnHere ? (
                      <Button type="button" variant="ghost" size="icon-xs" disabled={streaming} className="text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-ring" title={t("chatView.returnHereButtonTitle")} onClick={() => void onReturnHere(idx)}>
                        <Undo2 className="h-3 w-3" />
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            )}
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
    // onEnterView / onBranchFrom 은 checkpoint navigation 을 노출하는 소스에서만
    // 전달된다 — 부재 시 divider 는 렌더하되 진입/분기 액션은 no-op.
    if (entry.kind === "checkpoint") {
      rendered.push(
        <CheckpointDivider
          key={`cp-${idx}`}
          trigger={entry.trigger}
          messageCount={entry.removedMessages}
          compactNum={entry.compactNum}
          compactStatus={entry.compactStatus}
          truncatedDir={entry.truncatedDir}
          {...(handleEnterView ? { onEnterView: handleEnterView } : {})}
          {...(handleBranchFrom ? { onBranchFrom: handleBranchFrom } : {})}
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
            // The parent-answered outcomes open the work group for the same
            // reason the automatic ones do, and with more force: no dock ever
            // showed these calls, so a collapsed group would be the user's only
            // view of a decision made without them.
            if (
              e.status === "reviewing" ||
              e.status === "auto_approved" ||
              e.status === "parent_approved" ||
              e.status === "parent_denied"
            ) {
              groupHasPermissionReview = true;
            }
            groupRevisions.push(entryRenderRevision({ entry: e, idx: i, searchHighlight, starred: false }));
            if (!rendersOnToolRow(e)) {
              groupEntries.push({
                idx: i,
                node: <PermissionReviewStatusCard key={`permission-review-${e.toolUseId}`} entry={e} />,
              });
            }
          } else {
            break;
          }
        } else if (e.kind === "tool_group") {
          if (cls === "intermediate") {
            groupRevisions.push(entryRenderRevision({ entry: e, idx: i, searchHighlight, starred: false }));
            groupEntries.push({
              idx: i,
              node: (
                <ToolGroupCard
                  key={e.groupId}
                  group={e}
                  sessionId={currentSessionId}
                  permissionReviews={permissionReviewsByToolUseId}
                />
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
        // assistant bubbles / ask_user_answer and would diverge from the actual
        // tool-call count.
        const groupSummary = summaryByTurnStart?.get(groupTurnStart);
        rendered.push(
          <WorkGroup
            key={`wg-${currentSessionId}:${groupStart}`}
            stepCount={groupSummary?.toolCount ?? groupEntries.length}
            streaming={groupIsActiveTurn}
            turnDurationMs={groupSummary?.turnDurationMs}
            revision={[currentSessionId, ...groupRevisions].join("||")}
            forceOpen={workGroupsForceOpen || groupHasPermissionReview}
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
        if (!rendersOnToolRow(entry)) {
          rendered.push(<PermissionReviewStatusCard key={`permission-review-${entry.toolUseId}`} entry={entry} />);
        }
      } else if (entry.kind === "tool_group") {
        rendered.push(
          <ToolGroupCard
            key={entry.groupId}
            group={entry}
            sessionId={currentSessionId}
            permissionReviews={permissionReviewsByToolUseId}
          />,
        );
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
      const summary = summaryByTurnStart?.get(turnStartIdx);
      const summaryVendor = summary?.vendorProvider;
      const hasSubscriptionUsage = (summary?.subscriptionUsage?.length ?? 0) > 0;
      const summaryPricing = !hasSubscriptionUsage && summary?.vendorProvider && summary.vendorModel
        ? lookupBillablePricingOptional(summary.vendorProvider, summary.vendorModel)
        : undefined;
      // Mutating actions are gated on BOTH (a) not being in a read-only
      // view-mode slice AND (b) the callback being present. Main passes all
      // callbacks + a nullable viewMode → identical to pre-extraction;
      // read-only sources omit the callbacks → no actions rendered.
      const barActions =
        !viewMode && (onRetryEffort || onFork || onToggleStar)
          ? {
              ...(onRetryEffort ? { onRetry: () => void onRetryEffort() } : {}),
              ...(onFork ? { onFork: () => void onFork(idx) } : {}),
              ...(onToggleStar ? { onToggleStar: () => void onToggleStar(idx) } : {}),
            }
          : {};
      rendered.push(
          <div key={idx} data-chat-entry-index={idx} className={`${ringCls} min-w-0 w-full max-w-full overflow-x-hidden rounded-lg`}>
          <AssistantCard
            entry={entry}
            isStarred={!!isEntryStarred(idx)}
            isFinal={true}
          />
          {/* Suppress mutating TurnActionBar actions in view-mode / when the
              source omits the action callbacks. */}
          <TurnActionBar
            timestamp={entry.kind === "assistant" ? entry.createdAt : undefined}
            turnSummary={showTokenCostBadge || hasSubscriptionUsage ? summary : undefined}
            pricing={summaryPricing}
            vendor={hasSubscriptionUsage ? undefined : summaryVendor ?? activeVendor}
            isStarred={!!isEntryStarred(idx)}
            copyText={detectFromStream(entry.text || "").cleanedText || undefined}
            actions={barActions}
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
      if (!rendersOnToolRow(entry)) {
        rendered.push(<PermissionReviewStatusCard key={`permission-review-${entry.toolUseId}`} entry={entry} />);
      }
    } else if (entry.kind === "tool_group") {
      rendered.push(
        <ToolGroupCard
          key={entry.groupId}
          group={entry}
          sessionId={currentSessionId}
          permissionReviews={permissionReviewsByToolUseId}
        />,
      );
    }
    i++;
  }
  return rendered;
  // Dependency array preserves the original per-field memoization granularity
  // (flat primitives, NOT the cluster objects) so main-path perf is unchanged:
  // the memo recomputes only when an actually-consumed value changes, exactly as
  // the pre-extraction useMemo did. `t` is intentionally omitted — it is a
  // stable, provider-free translator and was not a dependency in the original.
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
    onReturnHere,
    onToggleStar,
    openNativeContextMenu,
    searchHighlight,
    searchIdx,
    searchMatchSet,
    searchMatches,
    searchOpen,
    setEditingEntryIdx,
    showTokenCostBadge,
    streaming,
    summaryByTurnStart,
    viewMode,
    workGroupsForceOpen,
    entries,
  ]);

  return <>{rendered}</>;
}


// ─── Transcript leaf fragments ────────────────────────────────────────────
// Small render-only pieces of the transcript. They live here rather than in
// their own modules because TranscriptRenderer is their only consumer.

function SessionResumeDivider({ preambleChars }: { preambleChars: number }) {
  const { t } = useTranslation();
  return (
    <div
      data-testid="session-resume-divider"
      className="flex items-center gap-2 py-2 my-2"
    >
      <span className="h-px flex-1 bg-success/(--opacity-muted)" />
      <span className="text-[10px] text-success/(--opacity-emphatic) font-medium">
        {t("sessionResumeDivider.resumeLabel", { preambleChars })}
      </span>
      <span className="h-px flex-1 bg-success/(--opacity-muted)" />
    </div>
  );
}

export function SummaryToast({ summary }: { summary: string }) {
  const { t } = useTranslation();
  return (
    <details
      data-testid="summary-toast"
      className="group w-full min-w-0 max-w-full border-l-2 border-action-compact/(--opacity-medium) bg-action-compact/(--opacity-faint) px-4 py-2.5 mb-3 rounded-r"
    >
      <summary className="cursor-pointer list-none text-[10px] uppercase tracking-wider text-action-compact/(--opacity-intense) font-medium marker:hidden">
        <span className="mr-1 inline-block transition-transform group-open:rotate-90">▸</span>
        {t("summaryToast.previousSummary")}
      </summary>
      <div
        className="prose prose-sm lvis-prose mt-2 max-w-none break-words text-sm text-muted-foreground [overflow-wrap:anywhere]"
        data-testid="summary-toast-body"
      >
        <ReactMarkdown remarkPlugins={MARKDOWN_REMARK_PLUGINS}>
          {summary}
        </ReactMarkdown>
      </div>
    </details>
  );
}

type ImportedTriggerEntry = Extract<ChatEntry, { kind: "imported_trigger" }>;

function ImportedTriggerCard({ entry }: { entry: ImportedTriggerEntry }) {
  // Parse the envelope source tag to confirm STAGED provenance — `overlay:…` for a
  // plugin trigger, `app:…` for an MCP App's `ui/message`, `mcp-prompt:…` for a
  // server-declared prompt. Resolved through the staged-origin table, so a newly
  // registered origin is labeled here without touching this card. Read from the
  // envelope in the prompt itself, so what the user sees is what the engine
  // classified. title + summary fields are already clean (set at insert time).
  const envelopeSource = parseStagedEnvelope(entry.prompt)?.source;
  return (
    <div
      className="mx-3 my-1 rounded border border-action-view/(--opacity-light) bg-action-view/(--opacity-faint) px-3 py-2 text-xs"
    >
      <div className="flex min-w-0 items-center gap-1 text-action-view font-medium">
        <span className="shrink-0">●</span>
        <span className="min-w-0 break-words [overflow-wrap:anywhere]">{envelopeSource ?? entry.summary.slice(0, 60)}</span>
      </div>
      {entry.summary && (
        <div className="mt-1 text-muted-foreground prose prose-sm lvis-prose max-w-none break-words [overflow-wrap:anywhere]">
          <ReactMarkdown remarkPlugins={MARKDOWN_REMARK_PLUGINS}>
            {entry.summary}
          </ReactMarkdown>
        </div>
      )}
    </div>
  );
}

function AskUserAnswerBubble({
  entry,
}: {
  entry: Extract<ChatEntry, { kind: "ask_user_answer" }>;
}) {
  const { t } = useTranslation();
  if (entry.dismissed) {
    return (
      <div
        className="ml-auto w-fit min-w-0 max-w-[75%] rounded-lg border border-border/(--opacity-strong) border-l-2 border-l-muted-foreground/(--opacity-strong) bg-card/(--opacity-intense) px-3 py-2 text-xs text-muted-foreground shadow-sm"
        data-testid="ask-user-answer-bubble"
      >
        <div className="text-[10.5px] text-muted-foreground/(--opacity-intense)">{t("chatView.askAnswerSkippedLabel")}</div>
        <div className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{t("chatView.askAnswerSkippedProceed")}</div>
      </div>
    );
  }

  return (
    <div
      className="ml-auto w-fit min-w-0 max-w-[75%] rounded-lg border border-border/(--opacity-strong) border-l-2 border-l-message-user bg-card/(--opacity-near) px-3 py-2.5 text-xs text-card-foreground shadow-sm"
      data-testid="ask-user-answer-bubble"
    >
      <div className="mb-1 text-[10.5px] text-muted-foreground">
        {entry.rows.length > 1 ? t("chatView.askAnswerMyAnswerMultiple", { count: entry.rows.length }) : t("chatView.askAnswerMyAnswerSingle")}
      </div>
      <div className="space-y-0.5">
        {entry.rows.map((row, idx) => (
          <div key={`${idx}:${row.label}`} className="flex min-w-0 items-baseline gap-2">
            <span className="w-[4.5rem] shrink-0 truncate text-[10.5px] text-muted-foreground">{row.label}</span>
            <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-[12px] [overflow-wrap:anywhere]">{row.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Thinking card. Always starts COLLAPSED — including while the model is still
 * streaming reasoning. The folded state shows just the header (a spinner +
 * "thinking…" title while streaming, a brain + "thought" title once done); the
 * reasoning body is revealed ONLY when the user clicks the header. This keeps
 * live reasoning from auto-expanding and cluttering the conversation; the user
 * opts in to read it. (Previously it auto-expanded during streaming and
 * auto-collapsed on completion.)
 */
export function ReasoningCard({
  entry,
}: {
  entry: Extract<ChatEntry, { kind: "reasoning" }>;
}) {
  const { t } = useTranslation();
  const streaming = entry.streaming === true;
  // Always collapsed by default — even while streaming. Expands only on click.
  const [open, setOpen] = useState(false);

  const title = streaming ? t("reasoningCard.thinkingTitle") : t("reasoningCard.thoughtCompleteTitle");
  const hasBody = entry.text.trim().length > 0;
  const bodyVisible = open && hasBody;

  return (
    <div className="min-w-0 w-full max-w-full rounded-md text-sm text-muted-foreground lvis-anim-message-in">
      <button
        type="button"
        className="flex w-full min-w-0 items-center gap-2 px-3 py-1.5 text-[11px] text-muted-foreground hover:bg-muted/(--opacity-muted)"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={bodyVisible}
      >
        {streaming
          ? <Loader2 className="h-3 w-3 flex-shrink-0 animate-spin" />
          : <Brain className="h-3 w-3 flex-shrink-0" />}
        <span className="min-w-0 font-medium">{title}</span>
        {/* Chevron always shown (even while streaming) so the folded block reads
            as expandable. */}
        <span className="shrink-0">
          {bodyVisible
            ? <ChevronDown className="h-3 w-3 flex-shrink-0" />
            : <ChevronRight className="h-3 w-3 flex-shrink-0" />}
        </span>
      </button>
      {bodyVisible && (
        <div className="ml-3 min-w-0 whitespace-pre-wrap break-words border-l-2 border-muted py-1 pl-3 text-[11px] italic leading-5 text-muted-foreground/(--opacity-intense) [overflow-wrap:anywhere] lvis-anim-fade-in">
          {entry.text}
        </div>
      )}
    </div>
  );
}

type CompactStatus =
  | "summarized"
  | "content_truncated"
  | "noop"
  | "reduced_insufficient_forced";

interface Variant {
  label: string;
  icon: string;
  lineCls: string;
  textCls: string;
}

const STATUS_VARIANTS: Record<CompactStatus, Variant> = {
  summarized: {
    label: "checkpointDivider.statusSummarized",
    icon: "📦",
    lineCls: "bg-action-compact/(--opacity-muted)",
    textCls: "text-action-compact/(--opacity-intense)",
  },
  content_truncated: {
    label: "checkpointDivider.statusContentTruncated",
    icon: "✂️",
    lineCls: "bg-warning/(--opacity-medium)",
    textCls: "text-warning/(--opacity-near)",
  },
  noop: {
    label: "checkpointDivider.statusNoop",
    icon: "✓",
    lineCls: "bg-muted-foreground/25",
    textCls: "text-muted-foreground/(--opacity-stronger)",
  },
  reduced_insufficient_forced: {
    label: "checkpointDivider.statusReducedInsufficient",
    icon: "⚠️",
    lineCls: "bg-destructive/(--opacity-medium)",
    textCls: "text-destructive/(--opacity-near)",
  },
};

const TRIGGER_VARIANTS: Record<CheckpointTrigger | "default", Variant> = {
  "auto-compact": {
    label: "checkpointDivider.triggerAutoCompact",
    icon: "📌",
    lineCls: "bg-action-compact/(--opacity-muted)",
    textCls: "text-action-compact/(--opacity-intense)",
  },
  "manual": {
    label: "checkpointDivider.triggerManual",
    icon: "✋",
    lineCls: "bg-muted-foreground/35",
    textCls: "text-muted-foreground/(--opacity-intense)",
  },
  default: {
    label: "checkpointDivider.triggerAutoCompact",
    icon: "📌",
    lineCls: "bg-action-compact/(--opacity-muted)",
    textCls: "text-action-compact/(--opacity-intense)",
  },
};

export function CheckpointDivider({
  trigger,
  messageCount,
  compactNum,
  compactStatus,
  truncatedDir,
  onEnterView,
  onBranchFrom,
}: {
  trigger?: CheckpointTrigger;
  messageCount: number;
  /** Compact sequence number — enables view/branch action buttons. */
  compactNum?: number;

  compactStatus?: CompactStatus;

  truncatedDir?: string;
  /** Enter view-mode for this checkpoint. */
  onEnterView?: (compactNum: number) => void | Promise<void>;
  /** Fork a new session from this checkpoint. */
  onBranchFrom?: (compactNum: number) => void | Promise<void>;
}) {
  const { t } = useTranslation();

  const variant: Variant = compactStatus !== undefined
    ? STATUS_VARIANTS[compactStatus]
    : TRIGGER_VARIANTS[trigger ?? "default"];


  const hasBoundary = compactStatus === undefined
    || compactStatus === "summarized"
    || compactStatus === "reduced_insufficient_forced";
  const hasActions =
    hasBoundary && compactNum !== undefined && (onEnterView !== undefined || onBranchFrom !== undefined);
  return (
    <div
      data-testid="checkpoint-divider"
      data-trigger={trigger ?? "default"}
      data-compact-status={compactStatus ?? "summarized"}
      data-compact-num={compactNum}
      className="my-2 flex flex-col gap-1.5 py-2"
    >
      <div className="flex items-center gap-2">
        <span className={`h-px flex-1 ${variant.lineCls}`} />
        <span className={`text-[10px] ${variant.textCls} font-medium`}>
          {"───"} {variant.icon} {t("checkpointDivider.checkpoint")}{compactNum !== undefined ? ` #${compactNum}` : ""} · {t(variant.label)} ({t("checkpointDivider.messageCount", { count: messageCount })}) {"───"}
        </span>
        <span className={`h-px flex-1 ${variant.lineCls}`} />
      </div>
      {truncatedDir !== undefined && (
        <div className="px-4 text-center text-[9.5px] text-muted-foreground/(--opacity-stronger)">
          {t("checkpointDivider.originalPreserved", { dir: truncatedDir })}
        </div>
      )}
      {hasActions && (
        <div
          data-testid="checkpoint-actions"
          className="flex items-center justify-center gap-2 px-4"
        >
          {onEnterView !== undefined && compactNum !== undefined && (
            <button
              type="button"
              data-testid="ck-btn-view"
              onClick={() => { void onEnterView(compactNum); }}
              className="rounded-md border border-[hsl(var(--action-view)/0.35)] bg-[hsl(var(--action-view)/0.08)] px-3 py-1 text-[10.5px] font-medium text-[hsl(var(--action-view))] transition-colors hover:bg-[hsl(var(--action-view)/0.18)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--action-view)/0.4)]"
              aria-label={t("checkpointDivider.viewAriaLabel", { num: compactNum })}
            >
              📖 {t("checkpointDivider.viewButton")}
            </button>
          )}
          {onBranchFrom !== undefined && compactNum !== undefined && (
            <button
              type="button"
              data-testid="ck-btn-fork"
              onClick={() => { void onBranchFrom(compactNum); }}
              className="rounded-md border border-[hsl(var(--action-branch)/0.35)] bg-[hsl(var(--action-branch)/0.08)] px-3 py-1 text-[10.5px] font-medium text-[hsl(var(--action-branch))] transition-colors hover:bg-[hsl(var(--action-branch)/0.18)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--action-branch)/0.4)]"
              aria-label={t("checkpointDivider.branchAriaLabel", { num: compactNum })}
            >
              ↩ {t("checkpointDivider.branchButton")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
