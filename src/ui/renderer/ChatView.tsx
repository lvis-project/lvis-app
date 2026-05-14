import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { ChevronDown, KeyRound, Pencil, Star, GitBranch } from "lucide-react";
import { Button } from "../../components/ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/ui/tooltip.js";
import { ScrollArea } from "../../components/ui/scroll-area.js";
import { formatCostBadge } from "../../lib/cost-estimator.js";
import type { ChatEntry } from "../../lib/chat-stream-state.js";
import { debugLog, isDebugStreamEnabled } from "../../lib/debug-stream.js";
import { OverlayCardRegion } from "./components/OverlayCardRegion.js";
import { AssistantCard } from "./components/AssistantCard.js";
import { UserMessageEditor } from "./components/UserMessageEditor.js";
import { ReasoningCard } from "./components/ReasoningCard.js";
import { ToolGroupCard } from "./components/ToolGroupCard.js";
import { DayDivider } from "./components/DayDivider.js";
import { CheckpointDivider } from "./components/CheckpointDivider.js";
import { SummaryToast } from "./components/SummaryToast.js";
import { ViewModeBanner, type ViewModeState } from "./components/ViewModeBanner.js";
import { SessionResumeDivider } from "./components/SessionResumeDivider.js";
import { SessionTodoPanel } from "./components/SessionTodoPanel.js";
import { MessageQueuePanel } from "./components/MessageQueuePanel.js";
import { MessageQueueStore, formatQueueInject } from "./state/message-queue-store.js";
import { SubAgentCard } from "./components/SubAgentCard.js";
import { TokenCostBadge } from "./components/TokenCostBadge.js";
import { TokenProgressRing } from "./components/TokenProgressRing.js";
import { BottomActionRow } from "./components/BottomActionRow.js";
import { PermissionModeBadge } from "./components/permissions/PermissionModeBadge.js";
import { SkillBadge } from "./components/SkillBadge.js";
import { WorkGroup } from "./components/WorkGroup.js";
import { TurnActionBar } from "./components/TurnActionBar.js";
// TurnSummaryFooter 컴포넌트는 2026-05-07 폐기. 토큰 정보는 TurnActionBar 의
// TokenCostBadge (provider-truth, 토글 + tooltip breakdown) 가 단일 source 로
// 표시. 시간 정보는 WorkGroup 헤더의 ⏱ T 가 흡수. turn_summary entry 는
// 데이터 carrier 로 history 에 남고, lookup 으로 두 surface 에 공급.
import { QuestionOverlay } from "./components/QuestionOverlay.js";
import { getApi } from "./api-client.js";
import { highlightText } from "./utils/html-preview.js";
import { useChatContext, type ChatContextValue } from "./context/ChatContext.js";
import { InputActionBar } from "./components/InputActionBar.js";
import { Composer, type ComposerHandle } from "./components/Composer.js";
import { DeferredApprovalChip } from "./components/DeferredApprovalChip.js";
import {
  ATTACH_MAX_COUNT,
  DENY_EXTENSIONS,
  type Attachment,
} from "./types/attachments.js";
import { buildMarkerText } from "./utils/attachment-markers.js";
import type { PluginEntry } from "./components/PluginGridButton.js";
import type { InstallPhase } from "./hooks/use-plugin-marketplace.js";
import type { QuickAction } from "./components/CommandPopover.js";
import { AskUserQuestionCard, type AskUserQuestionRequest } from "./components/AskUserQuestionCard.js";
import type { LvisApi } from "./types.js";
import type { SubAgentSpawn } from "./components/SubAgentCard.js";
import type { SkillBadgeProps } from "./components/SkillBadge.js";
import type { SessionSummary } from "./hooks/use-sessions.js";
import type { UserKeyboardIntentSnapshot } from "../../shared/chat-origin.js";
import { useContinuousHistory, type ContinuousHistorySession } from "./hooks/use-continuous-history.js";
import ReactMarkdown from "react-markdown";
import { MARKDOWN_REMARK_PLUGINS } from "./utils/markdown-plugins.js";
import { parseImportedTriggerEnvelope } from "../../shared/overlay-trigger-source.js";

const CHAT_BOTTOM_THRESHOLD_PX = 96;

type ImportedTriggerEntry = Extract<ChatEntry, { kind: "imported_trigger" }>;

function ImportedTriggerCard({ entry }: { entry: ImportedTriggerEntry }) {
  // Parse envelope source tag to confirm overlay trigger provenance.
  // title + summary fields are already clean (set at insert time).
  const envelopeSource = parseImportedTriggerEnvelope(entry.prompt);
  return (
    <div
      className="mx-3 my-1 rounded border border-action-view/20 bg-action-view/5 px-3 py-2 text-xs"
    >
      <div className="flex items-center gap-1 text-action-view font-medium">
        <span>●</span>
        <span>{envelopeSource ?? entry.summary.slice(0, 60)}</span>
      </div>
      {entry.summary && (
        <div className="mt-1 text-muted-foreground prose prose-sm lvis-prose max-w-none">
          <ReactMarkdown remarkPlugins={MARKDOWN_REMARK_PLUGINS}>
            {entry.summary}
          </ReactMarkdown>
        </div>
      )}
    </div>
  );
}

/**
 * ChatView — consumes cross-cutting state via `useChatContext()`. Action
 * callbacks stay as direct props so data flow for user-driven side effects
 * remains explicit at the App level.
 */
export interface ChatViewProps {
  api: LvisApi;
  onAsk: (
    q: string,
    intent?: UserKeyboardIntentSnapshot,
    opts?: { injectHint?: "queue" | "interrupt"; inputOrigin?: "queue-auto" },
  ) => void | Promise<void>;
  onEditSave: (idx: number, text: string) => void | Promise<void>;
  onFork: (idx: number) => void | Promise<void>;
  onToggleStar: (idx: number) => void | Promise<void>;
  onRetryEffort: () => void | Promise<void>;
  isEntryStarred: (idx: number) => string | null;
  /** B4: abort current streaming turn */
  onAbort: () => void | Promise<void>;
  /** Mid-stream "guide" utterance — non-interrupting direction adjustment. Returns IPC result so caller can preserve typed text on rejection. */
  onGuide: (text: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** Surface visible error in chat transcript when guide is rejected (queue-full / too-long / no-active-turn). */
  onGuideError: (message: string) => void;
  /** D6: submit thumbs up/down feedback for an assistant message */
  onFeedback?: (messageIdx: number, rating: "up" | "down", reason?: string) => void | Promise<void>;
  /** Workflow tool state — lifted to App level so panel survives view navigation */
  subAgentSpawns: SubAgentSpawn[];
  loadedSkills: SkillBadgeProps[];
  /** True when there are pending ask_user_question requests — used to suppress routine overlay */
  hasAskQuestions: boolean;
  /** Pending ask_user_question requests, rendered inline at the end of the entries stream. */
  askQuestions: AskUserQuestionRequest[];
  /** Called when a card submits or is dismissed; removes it from `askQuestions`. */
  onResolveAskQuestion: (id: string) => void;
  /** Plugin list for InputActionBar plugin grid */
  plugins: PluginEntry[];
  /** Navigate to a plugin view */
  onSelectPlugin: (viewKey: string) => void;
  sessions?: SessionSummary[];
  onLoadSession?: (sessionId: string) => void | Promise<void>;
  onRefreshSessions?: () => void | Promise<void>;
  /** Quick-action items for CommandPopover (빠른 실행 section) */
  commandActions: QuickAction[];
  /** Controlled open state for CommandPopover */
  commandPopoverOpen: boolean;
  onCommandPopoverOpenChange: (open: boolean) => void;
  installingPlugins?: ReadonlyMap<string, InstallPhase>;
  onOpenMarketplace: () => void;
  marketplaceUrlReady?: boolean;
  /** Set of routineIds currently executing (LLM session in-flight). */
  runningRoutines?: Set<string>;
  // PR-2-F-2 정정: fork-based revert (revertSessionId/onRevertCheckpoint) 폐지 — Layer 3
  // same-session checkpoint chain (Copilot 패턴) 으로 대체. sessionId 불변이므로 별도 revert action
  // 불필요 — 사용자가 임의 시점으로 돌아가려면 후속 PR 의 view-mode 지원 필요.
  /** Called when user confirms a plugin overlay item; id is the OverlayItem.id. */
  onPluginPrimaryAction?: (overlayItemId: string) => void;
  /** Called when a completed routine overlay result has been seen or dismissed. */
  onRoutineAcknowledge?: (routineId: string, firedAt: string) => void;
  /** Opens the non-interruptive deferred permission queue modal. */
  onOpenPermissionQueue?: () => void;
}

function HistoricalSessionMarker({ title, sessionId }: { title: string; sessionId: string }) {
  return (
    <div
      className="mx-auto max-w-full truncate text-center text-[11px] text-muted-foreground/50 py-0.5 px-3"
      data-testid="session-marker"
      data-session-marker-id={sessionId}
    >
      - {title || sessionId.slice(0, 8)} -
    </div>
  );
}

function sessionMarkerSelector(sessionId: string): string {
  const escaped = typeof CSS !== "undefined" && typeof CSS.escape === "function"
    ? CSS.escape(sessionId)
    : sessionId.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `[data-session-marker-id="${escaped}"]`;
}

function AskUserAnswerBubble({
  entry,
}: {
  entry: Extract<ContinuousHistorySession["entries"][number], { kind: "ask_user_answer" }>;
}) {
  if (entry.dismissed) {
    return (
      <div
        className="ml-auto w-fit min-w-0 max-w-[75%] rounded-md border border-border/70 border-l-2 border-l-muted-foreground/60 bg-card/80 px-3 py-2 text-xs text-muted-foreground"
        data-testid="ask-user-answer-bubble"
      >
        <div className="text-[10.5px] text-muted-foreground/80">↳ 질문 건너뜀</div>
        <div className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">기본값으로 진행</div>
      </div>
    );
  }

  return (
    <div
      className="ml-auto w-fit min-w-0 max-w-[75%] rounded-md border border-border/70 border-l-2 border-l-message-user bg-card/90 px-3 py-2 text-xs text-card-foreground shadow-sm"
      data-testid="ask-user-answer-bubble"
    >
      <div className="mb-1 text-[10.5px] text-muted-foreground">
        ↳ 내 답변{entry.rows.length > 1 ? ` (${entry.rows.length}개)` : ""}
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

function HistoricalEntriesList({
  entries,
  activePricing,
  activeVendor,
  onEnterView,
  onBranchFrom,
}: {
  entries: ContinuousHistorySession["entries"];
  activePricing: ChatContextValue["activePricing"];
  activeVendor: ChatContextValue["activeVendor"];
  onEnterView?: (compactNum: number) => void;
  onBranchFrom?: (compactNum: number) => void;
}) {
  const renderEntry = (entry: ContinuousHistorySession["entries"][number], idx: number, embedded = false) => {
    if (entry.kind === "assistant") {
      return (
        <AssistantCard
          key={idx}
          entry={{ ...entry, streaming: false }}
          highlightQuery=""
          isStarred={false}
          isFinal={true}
          embedded={embedded}
        />
      );
    }
    if (entry.kind === "reasoning") {
      return <ReasoningCard key={idx} entry={{ ...entry, streaming: false }} embedded={embedded} />;
    }
    if (entry.kind === "tool_group") {
      // Historical sessions are loaded from disk stubs — no verbatim available (sessionId omitted)
      return <ToolGroupCard key={entry.groupId || idx} group={entry} embedded={embedded} />;
    }
    if (entry.kind === "ask_user_answer") {
      return <AskUserAnswerBubble key={entry.sourceToolUseId || idx} entry={entry} />;
    }
    if (entry.kind === "turn_summary" || entry.kind === "context_usage") {
      // Historical: usage carriers are data only — standalone 표시 X.
      // duration 정보는 WorkGroup 헤더가 표시. token 정보는 historical 의
      // final assistant 위치엔 ActionBar 가 없어 이번 phase 에서 미노출;
      // 필요 시 후속에서 historical-footer 컴포넌트 추가 가능.
      return null;
    }
    return null;
  };

  const rendered: React.ReactNode[] = [];
  let i = 0;
  while (i < entries.length) {
    const entry = entries[i];
    if (!entry) {
      i++;
      continue;
    }

    if (entry.kind === "assistant" || entry.kind === "reasoning" || entry.kind === "tool_group") {
      const segmentStart = i;
      const segment: Array<{ entry: typeof entry; idx: number }> = [];
      while (i < entries.length) {
        const next = entries[i];
        if (!next || (next.kind !== "assistant" && next.kind !== "reasoning" && next.kind !== "tool_group")) break;
        segment.push({ entry: next as typeof entry, idx: i });
        i++;
      }
      const lastSegmentEntry = segment[segment.length - 1]?.entry;
      const finalAssistantOffset = lastSegmentEntry?.kind === "assistant"
        ? segment.length - 1
        : -1;
      const workItems = finalAssistantOffset >= 0
        ? segment.slice(0, finalAssistantOffset)
        : segment;
      // Historical segment 의 turnStart + 같은 turn 의 turn_summary entry
      // 한 번에 lookup. turn_summary 는 segment 외부 (다음 user 직전) 에 있어
      // entries 전체에서 찾되 다음 user 만나기 전까지만.
      let histTurnStart = -1;
      for (let k = segmentStart; k >= 0; k--) {
        if (entries[k]?.kind === "user") { histTurnStart = k; break; }
      }
      let histTurnSummary: Extract<ChatEntry, { kind: "turn_summary" }> | undefined;
      if (histTurnStart >= 0) {
        for (let k = segmentStart; k < entries.length; k++) {
          const ne = entries[k];
          if (!ne) continue;
          if (ne.kind === "user" && k !== histTurnStart) break;
          if (ne.kind === "turn_summary") {
            histTurnSummary = ne;
            break;
          }
        }
      }

      if (workItems.length > 0) {
        rendered.push(
          <WorkGroup
            key={`hist-wg-${segmentStart}`}
            stepCount={workItems.length}
            streaming={false}
            turnDurationMs={histTurnSummary?.turnDurationMs}
          >
            {workItems.map((item) => renderEntry(item.entry, item.idx, true))}
          </WorkGroup>,
        );
      }
      if (finalAssistantOffset >= 0) {
        const finalItem = segment[finalAssistantOffset];
        if (finalItem) rendered.push(renderEntry(finalItem.entry, finalItem.idx));
        // Historical 의 final assistant 다음에 token 정보 inline 표시.
        // Live 와 달리 ActionBar 가 없어 별도 footer slot — TokenCostBadge 만.
        if (histTurnSummary) {
          rendered.push(
            <div key={`hist-tcb-${segmentStart}`} className="px-3 mt-0.5">
              <TokenCostBadge
                tokensIn={histTurnSummary.tokensIn}
                freshInputTokens={histTurnSummary.freshInputTokens}
                tokensOut={histTurnSummary.tokensOut}
                cacheReadTokens={histTurnSummary.cacheReadTokens}
                cacheWriteTokens={histTurnSummary.cacheWriteTokens}
                vendor={activeVendor}
                pricing={activePricing}
              />
            </div>,
          );
        }
      }
      continue;
    }

    if (entry.kind === "user") {
      rendered.push(
        <div
          key={i}
          data-testid="historical-user-message"
          className="ml-auto w-fit min-w-0 max-w-[75%] overflow-hidden rounded-md bg-message-user px-3.5 py-2 text-sm text-message-user-foreground"
        >
          <div className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{entry.text}</div>
        </div>,
      );
      i++;
      continue;
    }

    if (entry.kind === "ask_user_answer") {
      rendered.push(<AskUserAnswerBubble key={i} entry={entry} />);
      i++;
      continue;
    }

    if (entry.kind === "system") {
      rendered.push(<div key={i} className="mx-auto text-center text-xs text-muted-foreground py-1 px-3 rounded-full bg-muted/50">{entry.text}</div>);
      i++;
      continue;
    }

    if (entry.kind === "turn_summary" || entry.kind === "context_usage") {
      // Historical: usage carriers are data only — standalone 표시 X.
      // (See note in renderEntry above.)
      i++;
      continue;
    }

    if (entry.kind === "checkpoint") {
      rendered.push(
        <Fragment key={i}>
          <CheckpointDivider
            tier={entry.tier}
            messageCount={entry.removedMessages}
            compactNum={entry.compactNum}
            compactStatus={entry.compactStatus}
            truncatedDir={entry.truncatedDir}
            onEnterView={onEnterView}
            onBranchFrom={onBranchFrom}
          />
          {entry.summary ? <SummaryToast summary={entry.summary} /> : null}
        </Fragment>,
      );
      i++;
      continue;
    }

    if (entry.kind === "session_resume") {
      rendered.push(<SessionResumeDivider key={i} preambleChars={entry.preambleChars} />);
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

    i++;
  }

  return <div className="min-w-0 w-full max-w-full space-y-3 overflow-x-hidden">{rendered}</div>;
}

export function ChatView({ api, onAsk, onEditSave, onFork, onToggleStar, onRetryEffort, isEntryStarred, onAbort, onGuide, onGuideError, onFeedback, subAgentSpawns, loadedSkills, hasAskQuestions, askQuestions, onResolveAskQuestion, plugins, onSelectPlugin, sessions, onLoadSession, onRefreshSessions, commandActions, commandPopoverOpen, onCommandPopoverOpenChange, installingPlugins, onOpenMarketplace, marketplaceUrlReady, onPluginPrimaryAction, onRoutineAcknowledge, onOpenPermissionQueue }: ChatViewProps) {
  // We still need the api for SessionTodoPanel; obtain it via singleton.
  const workflowApi = getApi();
  const debugStreamEnabled = isDebugStreamEnabled();
  const composerRef = useRef<ComposerHandle | null>(null);
  const {
    entries, streaming, editingEntryIdx, setEditingEntryIdx, editBusy,
    question, setQuestion, chatEndRef, currentSessionId,
    hasApiKey, onOpenSettings,
    searchOpen, searchMatches, searchMatchSet, searchIdx, searchHighlight,
    contextOverflowPct, usedTokens, contextBudget,
    rolePresets, activePreset, activePresetId, setActivePresetId,
    attachments, setAttachments, attachmentNCounter,
    vendorSupportsThinking, enableThinkingChat, toggleThinking,
    costEstimate, costBadgeClass, activePricing, activeVendor,
  } = useChatContext();

  const currentSessionAnchor = useMemo(() => {
    const current = sessions?.find((session) => session.id === currentSessionId);
    return current ? { id: currentSessionId, modifiedAt: current.modifiedAt } : undefined;
  }, [currentSessionId, sessions]);

  // Sub-agent spawns by their originating tool_use id. Used so SubAgentCard
  // renders inline next to the ToolGroupCard whose `agent_spawn` call started
  // it, rather than stacking all spawns at the top of the chat (where users
  // miss them entirely — see 2026-05-07 incident).
  const spawnsByToolUseId = useMemo(() => {
    const map = new Map<string, SubAgentSpawn[]>();
    for (const spawn of subAgentSpawns) {
      if (!spawn.toolUseId) continue;
      const list = map.get(spawn.toolUseId);
      if (list) list.push(spawn);
      else map.set(spawn.toolUseId, [spawn]);
    }
    return map;
  }, [subAgentSpawns]);

  const orphanSpawns = useMemo(
    () => subAgentSpawns.filter((s) => !s.toolUseId),
    [subAgentSpawns],
  );

  // §PR-5: Layer 3 View-Mode — null = live, non-null = viewing a past checkpoint slice
  const [viewMode, setViewMode] = useState<ViewModeState | null>(null);
  // §PR-5: brief fork-success toast (auto-dismisses after 3 s)
  const [forkToast, setForkToast] = useState<string | null>(null);
  const forkToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // §PR-5: cleanup fork toast timer on unmount to avoid setState-after-unmount
  useEffect(() => {
    return () => {
      if (forkToastTimerRef.current) clearTimeout(forkToastTimerRef.current);
    };
  }, []);

  // §PR-5: in view-mode, show only the sliced entries up to the checkpoint.
  const visibleEntries = useMemo(
    () => viewMode ? entries.slice(0, viewMode.slicedRangeEnd) : entries,
    [entries, viewMode],
  );

  // turn_summary entry 의 turnStart 별 lookup. 각 turn 의 final assistant
  // 와 WorkGroup 이 같은 turn 의 token / duration 정보를 inline 으로 가져와
  // 표시한다. turn_summary entry 자체는 standalone 렌더링 되지 않는다.
  const turnSummaryByTurnStart = useMemo(() => {
    type TurnSummary = {
      turnDurationMs: number;
      toolCount: number;
      cumulativeToolMs: number;
      tokensIn: number;
      freshInputTokens: number;
      tokensOut: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    };
    const map = new Map<number, TurnSummary>();
    let curTurnStart = -1;
    for (let i = 0; i < visibleEntries.length; i++) {
      const e = visibleEntries[i];
      if (!e) continue;
      if (e.kind === "user") curTurnStart = i;
      else if (e.kind === "turn_summary" && curTurnStart >= 0) {
        map.set(curTurnStart, {
          turnDurationMs: e.turnDurationMs,
          toolCount: e.toolCount,
          cumulativeToolMs: e.cumulativeToolMs,
          tokensIn: e.tokensIn,
          freshInputTokens: e.freshInputTokens,
          tokensOut: e.tokensOut,
          ...(e.cacheReadTokens !== undefined ? { cacheReadTokens: e.cacheReadTokens } : {}),
          ...(e.cacheWriteTokens !== undefined ? { cacheWriteTokens: e.cacheWriteTokens } : {}),
        });
      }
    }
    return map;
  }, [visibleEntries]);

  const renderSpawnsForGroup = useCallback(
    (group: { tools: { toolUseId: string }[] }) => {
      const seen = new Set<string>();
      const nodes: React.ReactNode[] = [];
      for (const tool of group.tools) {
        const list = spawnsByToolUseId.get(tool.toolUseId);
        if (!list) continue;
        for (const spawn of list) {
          if (seen.has(spawn.spawnId)) continue;
          seen.add(spawn.spawnId);
          nodes.push(<SubAgentCard key={spawn.spawnId} spawn={spawn} />);
        }
      }
      return nodes;
    },
    [spawnsByToolUseId],
  );

  const {
    historicalSessions,
    loading: loadingHistory,
    reachedEnd: reachedHistoryEnd,
    sentinelRef,
    scrollViewportRef,
  } = useContinuousHistory(api, currentSessionId, hasApiKey !== false, currentSessionAnchor);

  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const initialBottomScrollPendingRef = useRef(true);
  const sawHistoryLoadingRef = useRef(false);

  const isNearBottom = useCallback(() => {
    const viewport = scrollViewportRef.current;
    if (!viewport) return true;
    return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= CHAT_BOTTOM_THRESHOLD_PX;
  }, [scrollViewportRef]);

  const scrollChatToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const viewport = scrollViewportRef.current;
    if (viewport) {
      if (typeof viewport.scrollTo === "function") {
        viewport.scrollTo({ top: viewport.scrollHeight, behavior });
      } else {
        viewport.scrollTop = viewport.scrollHeight;
      }
    } else {
      chatEndRef.current?.scrollIntoView({ behavior });
    }
    setShowJumpToBottom(false);
  }, [chatEndRef, scrollViewportRef]);

  const scrollToSessionMarker = useCallback((sessionId: string): boolean => {
    const viewport = scrollViewportRef.current;
    if (!viewport) return false;
    const target = viewport.querySelector<HTMLElement>(sessionMarkerSelector(sessionId));
    if (!target) return false;
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    setShowJumpToBottom(!isNearBottom());
    return true;
  }, [isNearBottom, scrollViewportRef]);

  const handleCalendarSessionSelect = useCallback(async (sessionId: string) => {
    if (scrollToSessionMarker(sessionId)) return;
    await onLoadSession?.(sessionId);
  }, [onLoadSession, scrollToSessionMarker]);

  useEffect(() => {
    if (!searchOpen || searchMatches.length === 0) return;
    const entryIndex = searchMatches[searchIdx];
    if (entryIndex === undefined) return;
    const viewport = scrollViewportRef.current;
    if (!viewport) return;
    const frame = window.requestAnimationFrame(() => {
      const target = viewport.querySelector<HTMLElement>(`[data-chat-entry-index="${entryIndex}"]`);
      target?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [searchIdx, searchMatches, searchOpen, scrollViewportRef]);

  // §PR-5: View-Mode handlers
  const handleEnterView = useCallback(async (compactNum: number) => {
    const result = await api.chatEnterCheckpointView?.(currentSessionId, compactNum);
    if (!result || "error" in result) return;
    // §PR-5 note: messageIndexAtCreation is engine history message count — it does NOT
    // map 1:1 to renderer entries (which include reasoning/tool_group/checkpoint entries).
    // We cap to entries.length so the slice is always valid, accepting that in tool-heavy
    // sessions the visible range may show slightly more entries than the exact checkpoint.
    // A precise renderer↔engine index mapping is deferred to a future PR.
    const slicedRangeEnd = Math.min(result.messageIndexAtCreation, entries.length);
    setViewMode({ compactNum, slicedRangeEnd });
    scrollChatToBottom("auto");
  }, [api, currentSessionId, entries.length, scrollChatToBottom]);

  const handleExitView = useCallback(async () => {
    await api.chatExitCheckpointView?.();
    setViewMode(null);
    scrollChatToBottom("auto");
  }, [api, scrollChatToBottom]);

  const handleBranchFrom = useCallback(async (compactNum: number) => {
    const result = await api.chatBranchFromCheckpoint?.(currentSessionId, compactNum);
    if (!result || "error" in result) return;
    // §PR-5: exit view-mode before loading the new session so it opens in live mode
    setViewMode(null);
    // Load the branched session
    await onLoadSession?.(result.newSessionId);
    // Show 3-second fork-success toast
    if (forkToastTimerRef.current) clearTimeout(forkToastTimerRef.current);
    setForkToast(`checkpoint #${compactNum} 에서 새 분기를 시작했습니다`);
    forkToastTimerRef.current = setTimeout(() => setForkToast(null), 3000);
  }, [api, currentSessionId, onLoadSession]);

  useEffect(() => {
    initialBottomScrollPendingRef.current = true;
    sawHistoryLoadingRef.current = false;
    setShowJumpToBottom(false);
  }, [currentSessionId]);

  // Stage 3: per-ChatView message-queue store. session 변경 시 자동 비움.
  const messageQueueStore = useMemo(() => new MessageQueueStore(), []);
  // queue-auto inject in-flight 플래그 — done event re-entrancy 방지.
  const queueAutoInflightRef = useRef(false);

  // dev-mode test hook — Playwright e2e 가 store 직접 manipulation 으로
  // 큐 시나리오 검증 가능. production 빌드에선 노출 X.
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") {
      (window as unknown as { __lvis_message_queue_store__?: MessageQueueStore }).__lvis_message_queue_store__ = messageQueueStore;
    }
  }, [messageQueueStore]);
  useEffect(() => {
    messageQueueStore.clear();
  }, [currentSessionId, messageQueueStore]);

  // Stage 5c: 자연 인입 (true mid-turn brake-point) — 엔진의 onGuide
  // (round-boundary inject) 메커니즘 위임. tool_end event 발생 시 큐 dump:
  // 엔진이 다음 assistant round 시작 직전에 user message 로 합류시킴.
  // 이전 implementation (streaming false 전이 시 onAsk = abort+restart) 의
  // 한계 — 매 turn 종료까지 기다림 — 해소. spec §"메세지 큐 시맨틱" 의
  // brake-point 정의 ("tool result 도착 직후 = 다음 assistant 호출 직전")
  // 와 동일.
  //
  // streaming false 전이는 fallback (tool-less turn — LLM 이 도구 안 쓰고
  // 직접 텍스트만 응답한 경우) 으로 유지. tool_end 가 없으니 turn 끝에
  // onGuide 호출.
  //
  // onGuide 가 fail (queue-full / too-long / no-active-turn) 하면 큐에
  // 다시 추가 — 다음 brake-point 에 retry. 중복 inject 방지.
  const flushQueueViaGuide = useCallback(() => {
    if (messageQueueStore.size() === 0) return;
    const taken = messageQueueStore.takeAll();
    if (taken.length === 0) return;
    const formatted = formatQueueInject(taken);
    void (async () => {
      const result = await onGuide(formatted);
      if (result?.ok !== true) {
        // no-active-turn = turn 이 cancel/완료된 후 → re-add 하면 무한 loop.
        // queue-full / too-long = 일시적이지만 사용자 cancel 동시 시 무한 retry
        // 위험. 현재는 모든 실패를 best-effort drop 으로 처리 (사용자 알림 X).
        // future: too-long 만 batch split + queue-full 만 backoff retry.
        const reason = result?.error ?? "unknown";
        console.warn(`[message-queue] guide flush dropped (${reason}):`, formatted.slice(0, 80));
      }
    })();
  }, [messageQueueStore, onGuide]);

  useEffect(() => {
    const unsub = api.onChatStream((ev) => {
      if (ev.type === "tool_end") {
        // mid-turn brake-point — 엔진 round boundary 에 합류 (onGuide).
        flushQueueViaGuide();
        return;
      }
      if (ev.type === "done") {
        // turn 종료 시 큐 잔존 항목 → 새 user message 로 자동 inject.
        // inputOrigin "queue-auto" 사용 — chat.ts validator 가 userActivation
        // 검사 우회 (IPC stream context = user gesture 밖).
        // re-entrancy guard (critic Round 2 M4): inflight inject 중 재 done
        // event 무시 — rapid done sequence 시 cascade race 방지.
        if (queueAutoInflightRef.current) return;
        if (messageQueueStore.size() === 0) return;
        const taken = messageQueueStore.takeAll();
        if (taken.length === 0) return;
        queueAutoInflightRef.current = true;
        const formatted = formatQueueInject(taken);
        void (async () => {
          try {
            await onAsk(formatted, undefined, { injectHint: "queue", inputOrigin: "queue-auto" });
          } finally {
            queueAutoInflightRef.current = false;
          }
        })();
      }
    });
    return unsub;
  }, [api, flushQueueViaGuide, messageQueueStore, onAsk]);

  // streaming false 전이 fallback 폐기 (2026-05-15 사용자 피드백):
  // AskUserQuestion 카드 깜박임 등으로 streaming 이 일시 false → true 로
  // 되돌아갈 때 의도치 않게 큐가 자동 인입되어 사라지는 문제. 자동 인입은
  // tool_end (진정한 brake-point) 에서만. turn 종료 시 큐 잔존 = OK,
  // 사용자가 ESC 또는 esc 취소 로 명시적 inject 트리거.

  // ESC / esc 취소 시 호출 — 큐를 새 user message 로 inject + handleAsk 가
  // 자체 abort 처리 (Issue #622). 큐 비어 있으면 단순 abort 만.
  const flushQueueAsUserMessage = useCallback(() => {
    if (messageQueueStore.size() === 0) {
      void onAbort();
      return;
    }
    const taken = messageQueueStore.takeAll();
    const formatted = formatQueueInject(taken);
    // ESC / esc 취소 = 사용자 명시 인터럽트 → "⚡ 중단후 새메세지" hint.
    void onAsk(formatted, { inputOrigin: "user-keyboard", token: "" }, { injectHint: "interrupt" });
  }, [messageQueueStore, onAbort, onAsk]);

  // Stage 5: composer Enter morph — busy = queue.add, idle = onAsk 직행.
  // ⌘⏎ = 즉시 주입 (LLM abort + 큐 selected + 현재 입력).
  const handleComposerSend = useCallback(
    (intent: UserKeyboardIntentSnapshot) => {
      const text = question;
      if (text.trim().length === 0 && attachments.length === 0) return;
      if (streaming) {
        // Busy: 큐에 추가. cap 초과 throw catch 해서 textarea 보존.
        if (text.trim().length > 0) {
          try {
            messageQueueStore.add(text);
          } catch (err) {
            console.warn("[message-queue] add rejected:", (err as Error).message);
            return;
          }
        }
        // 첨부도 같이 비움 — busy 분기에서 첨부 잔존하면 다음 idle 입력 시
        // 의도치 않게 따라감 (mental model 위배). 큐 schema 가 첨부 비포함이라
        // busy 시 첨부는 명시적으로 사용자가 재선택하는 것이 명확.
        setQuestion("");
        if (attachments.length > 0) setAttachments([]);
      } else {
        // Idle: 직행 전송
        void onAsk(text, intent);
      }
    },
    [
      question, attachments.length, streaming, messageQueueStore, onAsk,
      setQuestion, setAttachments,
    ],
  );

  const handleImmediateInject = useCallback(() => {
    const text = question.trim();
    const taken = messageQueueStore.takeSelected();
    const parts: string[] = [];
    if (taken.length > 0) parts.push(formatQueueInject(taken));
    if (text.length > 0) parts.push(text);
    if (parts.length === 0) return;
    const combined = parts.join("\n");
    setQuestion("");
    // ⌘⏎ = 사용자 명시 인터럽트 → "⚡ 중단후 새메세지" hint.
    // handleAsk 가 streaming 시 자체 abort 처리.
    void onAsk(combined, { inputOrigin: "user-keyboard", token: "" }, { injectHint: "interrupt" });
  }, [question, messageQueueStore, onAsk, setQuestion]);

  // Stage 5: ESC 우선순위
  //   1. 모달 (Radix Dialog [data-state="open"]) → 모달이 가로챔 (defensive)
  //   2. 큐 선택 항목 있음 → 선택 해제만 (LLM 안 건드림)
  //   3. composer textarea 안에서 ESC → LLM 취소
  useEffect(() => {
    if (!streaming) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (
        document.querySelector(
          '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]',
        )
      ) {
        return;
      }
      if (messageQueueStore.hasSelected()) {
        e.preventDefault();
        messageQueueStore.clearSelection();
        return;
      }
      const target = e.target as HTMLElement | null;
      const inComposer =
        target?.getAttribute?.("data-testid") === "composer-textarea";
      if (!inComposer) return;
      e.preventDefault();
      // 사용자 의도 (2026-05-15): ESC = LLM abort + 큐를 새 user message 로
      // inject. 멈춤만 하는 게 아니고 큐 항목이 입력으로 보내짐. 빈 큐면
      // 단순 abort. handleAsk 가 자체 abort 처리.
      flushQueueAsUserMessage();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [streaming, messageQueueStore, onAbort]);

  // ⌘⏎ — composer textarea 에서 즉시 주입. busy 시 = 인터럽트 (LLM abort + 새
  // turn). idle 시도 동작 (큐가 있으면 큐+입력 inject, 없으면 입력만 send).
  // 사용자 mental model: "⌘⏎ = 지금 즉시 보내" — busy/idle 무관 일관 동작.
  // 가드 (streaming) 제거 — 사용자 보고 2026-05-15 (idle ⌘⏎ 가 무동작이던 회귀).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Enter") return;
      if (!(e.metaKey || e.ctrlKey)) return;
      // 한국어 IME composing 가드 제거 — composing 시 첫 ⌘⏎ 가 IME commit 으로
      // 소비되고 두 번째 ⌘⏎ 가 동작하는 회귀 (사용자 보고 2026-05-15).
      // 미확정 음절 손실은 마이너 — 사용자 의도 (인터럽트) 가 명확.
      if (
        document.querySelector(
          '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]',
        )
      ) {
        return;
      }
      const target = e.target as HTMLElement | null;
      const isComposerTextarea =
        target?.getAttribute?.("data-testid") === "composer-textarea";
      if (!isComposerTextarea) return;
      e.preventDefault();
      handleImmediateInject();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleImmediateInject]);

  // Stage 5 follow-up: ⌘K = 가이드 호출. BottomActionRow 의 ghost 버튼과 동일
  // onGuide 위임. text 비어 있으면 noop. busy 와 무관 (idle 에서도 가이드 가능).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "k" && e.key !== "K") return;
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.isComposing) return;
      if (
        document.querySelector(
          '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]',
        )
      ) {
        return;
      }
      const text = question.trim();
      if (text.length === 0) return;
      e.preventDefault();
      void (async () => {
        const result = await onGuide(text);
        if (result?.ok === true) {
          setQuestion("");
        } else if (result?.ok === false) {
          const message =
            result.error === "queue-full" ? "방향 지시가 너무 많아 대기열이 가득 찼습니다." :
            result.error === "too-long" ? "방향 지시 한 건이 너무 깁니다 (최대 8000자)." :
            result.error === "no-active-turn" ? "진행 중인 응답이 없어 방향 지시를 보낼 수 없습니다." :
            `방향 지시 전송 실패: ${result.error}`;
          onGuideError(message);
        }
      })();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [question, onGuide, onGuideError, setQuestion]);

  useEffect(() => {
    const viewport = scrollViewportRef.current;
    if (!viewport) return;
    const onScroll = () => setShowJumpToBottom(!isNearBottom());
    onScroll();
    viewport.addEventListener("scroll", onScroll, { passive: true });
    return () => viewport.removeEventListener("scroll", onScroll);
  }, [isNearBottom, scrollViewportRef]);

  useEffect(() => {
    if (loadingHistory) {
      sawHistoryLoadingRef.current = true;
      return;
    }
    if (!initialBottomScrollPendingRef.current) return;
    if (!sawHistoryLoadingRef.current) return;
    initialBottomScrollPendingRef.current = false;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => scrollChatToBottom("auto"));
    });
  }, [loadingHistory, scrollChatToBottom]);

  useEffect(() => {
    // §PR-5: suppress auto-scroll while in view-mode so new live entries don't
    // yank the viewport away from the frozen checkpoint slice the user is reading.
    if (viewMode) return;
    if (isNearBottom()) {
      requestAnimationFrame(() => scrollChatToBottom("smooth"));
    }
  }, [entries.length, isNearBottom, scrollChatToBottom, viewMode]);

  const historicalByDay = useMemo(() => {
    const map = new Map<string, ContinuousHistorySession[]>();
    for (const session of historicalSessions) {
      if (session.id === currentSessionId) continue;
      const existing = map.get(session.dayKey);
      if (existing) {
        existing.push(session);
      } else {
        map.set(session.dayKey, [session]);
      }
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [currentSessionId, historicalSessions]);

  const hasHistoricalContent = historicalSessions.length > 0;
  const activeDayKey = getKoreaDateKey(new Date());


  // No auto-scroll needed for floating panel — it is positioned outside
  // the scroll viewport so it is always visible regardless of scroll position.

  // B4: Ctrl/Cmd+C while streaming and no text selected → abort
  useEffect(() => {
    if (!streaming) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "c") {
        const sel = window.getSelection();
        if (sel && sel.toString().length > 0) return; // let copy work normally
        // B4 fix: do not intercept Ctrl+C when focus is inside an editable element —
        // native copy must work in <input>, <textarea>, and contenteditable.
        const target = e.target as HTMLElement;
        const isEditable =
          target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable;
        if (isEditable) return;
        e.preventDefault();
        void onAbort();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [streaming, onAbort]);

  return (
    <div className="relative flex min-h-0 min-w-0 w-full flex-1 flex-col overflow-hidden">
      {hasApiKey === false && (
        <div className="absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2">
          <Card className="w-[400px]"><CardHeader className="text-center"><KeyRound className="mx-auto mb-2 h-10 w-10 text-muted-foreground" /><CardTitle>API 키 설정 필요</CardTitle><CardDescription>채팅을 시작하려면 Claude API 키를 설정해 주세요.</CardDescription></CardHeader>
            <CardContent className="flex justify-center"><Button onClick={() => onOpenSettings()}><KeyRound className="mr-2 h-4 w-4" />설정 열기</Button></CardContent>
          </Card>
        </div>
      )}
      {/* Routine fire + plugin overlay. Routine items stay isolated from chat history; plugin items insert via imported_trigger on confirm. */}
      <OverlayCardRegion
        onPluginPrimaryAction={onPluginPrimaryAction ?? (() => {})}
        onRoutineAcknowledge={onRoutineAcknowledge}
      />
      <div className="relative min-h-0 min-w-0 max-w-full flex-1 overflow-hidden">
      {/* §PR-5: View-Mode banner — sticky at the top of the chat scroll area */}
      <ViewModeBanner viewMode={viewMode} onExit={() => { void handleExitView(); }} />
      {/* §PR-5: Fork-success toast — auto-dismisses after 3 s */}
      {forkToast && (
        <div
          data-testid="fork-toast"
          className="sticky top-0 z-30 mx-3 mt-2 rounded-md border border-[hsl(var(--action-branch)/0.4)] bg-[hsl(var(--action-branch)/0.1)] px-3 py-2 text-xs text-[hsl(var(--action-branch))]"
        >
          {forkToast}
        </div>
      )}
      <ScrollArea className="lvis-chat-scroll h-full min-h-0 min-w-0 max-w-full" viewportRef={scrollViewportRef}><div className="min-w-0 w-full max-w-full overflow-x-hidden space-y-3 px-3 py-4">
        <div ref={sentinelRef} data-testid="chat-history-sentinel" className="h-px" />
        {loadingHistory && (
          <div
            data-testid="chat-history-loading"
            className="py-2 text-center text-[11px] text-muted-foreground border-b border-dashed border-border/40"
          >
            이전 대화 기록 불러오는 중...
          </div>
        )}
        {reachedHistoryEnd && hasHistoricalContent && (
          <div className="py-2 text-center text-[10px] text-muted-foreground/50">
            - 대화 시작 -
          </div>
        )}
        {historicalByDay.map(([dayKey, daySessions]) => (
          <Fragment key={dayKey}>
            <DayDivider
              dateKey={dayKey}
              sessions={sessions}
              currentSessionId={currentSessionId}
              streaming={streaming}
              onLoadSession={handleCalendarSessionSelect}
              onRefreshSessions={onRefreshSessions}
            />
            {daySessions.map((session) => (
              <Fragment key={session.id}>
                <HistoricalSessionMarker title={session.title} sessionId={session.id} />
                {/* §PR-5: historical sessions use currentSessionId in IPC — hide view/branch actions
                    to prevent session-mismatch. Actions are only valid on the live current session. */}
                <HistoricalEntriesList entries={session.entries} activePricing={activePricing} activeVendor={activeVendor} />
              </Fragment>
            ))}
          </Fragment>
        ))}
        {/* Today's date badge — always shown above the active conversation.
            Even when historical sessions already rendered today's date, the
            active turn boundary must remain the same calendar-enabled divider
            instead of degrading to a plain "현재 대화" separator. */}
        <DayDivider
          dateKey={activeDayKey}
          sessionMarkerId={currentSessionId}
          sessions={sessions}
          currentSessionId={currentSessionId}
          streaming={streaming}
          onLoadSession={handleCalendarSessionSelect}
          onRefreshSessions={onRefreshSessions}
        />
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
            (legacy events or pre-association race conditions). Spawns with
            a toolUseId render inline next to their ToolGroupCard below. */}
        {orphanSpawns.map((spawn) => (
          <SubAgentCard key={spawn.spawnId} spawn={spawn} />
        ))}
        {visibleEntries.length === 0 && !hasHistoricalContent && hasApiKey !== false && !hasAskQuestions && <div className="py-12 text-center text-sm text-muted-foreground">LVIS 에이전트가 준비되었습니다. 질문을 입력하거나 /command를 사용하세요.</div>}
        {(() => {
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

          // §PR-5: use visibleEntries (sliced in view-mode, full list otherwise)
          const activeEntries = visibleEntries;

          // Last user-message index: determines which WorkGroup belongs to the active turn.
          let lastUserIdx = -1;
          for (let k = activeEntries.length - 1; k >= 0; k--) {
            if (activeEntries[k]?.kind === "user") { lastUserIdx = k; break; }
          }

          type EntryClass = "intermediate" | "live" | "final";
          const entryClassMap = new Map<number, EntryClass>();
          const finalTurnStartMap = new Map<number, number>(); // final idx → turn-start idx
          const entryTurnStartMap = new Map<number, number>(); // classified idx → turn-start idx

          let turnStart = -1;
          for (let i = 0; i < activeEntries.length; i++) {
            const e = activeEntries[i];
            if (!e) continue;
            if (e.kind === "user") { turnStart = i; continue; }
            if (e.kind !== "assistant" && e.kind !== "reasoning" && e.kind !== "tool_group") continue;

            let nextUserIdx = activeEntries.length;
            for (let j = i + 1; j < activeEntries.length; j++) {
              if (activeEntries[j]?.kind === "user") { nextUserIdx = j; break; }
            }

            const subsequentTurnEntries = activeEntries.slice(i + 1, nextUserIdx);
            const hasSubsequent = subsequentTurnEntries.some(
              (ne) => ne.kind === "assistant" || ne.kind === "tool_group" || ne.kind === "reasoning",
            );
            const hasSubsequentWork = subsequentTurnEntries.some(
              (ne) => ne.kind === "tool_group" || ne.kind === "reasoning",
            );

            const myTurnStart = turnStart >= 0 ? turnStart : 0;
            entryTurnStartMap.set(i, myTurnStart);
            const isActiveTurnEntry = myTurnStart === lastUserIdx && streaming;
            const hasPriorWork = activeEntries.slice(myTurnStart + 1, i).some(
              (pe) => pe.kind === "tool_group" || pe.kind === "reasoning",
            );

            if (e.kind === "assistant") {
              if (e.phase === "work") {
                entryClassMap.set(i, "intermediate");
              } else if (!hasSubsequent && !isActiveTurnEntry) {
                entryClassMap.set(i, "final");
                finalTurnStartMap.set(i, myTurnStart);
              } else if (isActiveTurnEntry || hasSubsequentWork || hasPriorWork) {
                entryClassMap.set(i, "intermediate");
              } else {
                entryClassMap.set(i, "live");
              }
            } else if (hasSubsequent || isActiveTurnEntry) {
              entryClassMap.set(i, "intermediate");
            } else {
              entryClassMap.set(i, "live");
            }
          }

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
              return isCurrentMatch ? "ring-2 ring-primary" : isMatch ? "ring-1 ring-primary/40" : "";
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
                  <div key={idx} data-chat-entry-index={idx} className={`group relative ml-auto w-fit min-w-0 max-w-[75%] overflow-hidden rounded-md bg-message-user px-3.5 py-2 text-sm text-message-user-foreground ${userGapCls} ${ringCls}`}>
                    {/* "나" label removed — sender is implicit. Star + hover
                        actions float top-right via absolute positioning so
                        the bubble has no header chrome. */}
                    {entry.injectHint === "queue" ? (
                      <div className="mb-1 inline-flex items-center gap-1 rounded bg-message-user-foreground/10 px-1.5 py-0.5 text-[10px] text-message-user-foreground/70" title="메시지 큐에서 자동 인입">
                        ↪ 큐에서
                      </div>
                    ) : entry.injectHint === "interrupt" ? (
                      <div className="mb-1 inline-flex items-center gap-1 rounded bg-message-user-foreground/10 px-1.5 py-0.5 text-[10px] text-message-user-foreground/70" title="현재 LLM 응답 중단 후 즉시 새 메시지로 주입">
                        ⚡ 중단후 새메세지
                      </div>
                    ) : null}
                    {starActive ? (
                      <Star key="active" className="absolute right-2 top-2 h-3 w-3 fill-emphasis text-emphasis lvis-anim-star" />
                    ) : null}
                    {/* §PR-5: hide mutating actions in view-mode (read-only slice) */}
                    {!viewMode && (
                      <div className="absolute right-2 top-2 hidden gap-1 group-hover:flex bg-message-user/95 rounded">
                        <Button type="button" variant="ghost" size="icon-xs" title="편집" onClick={() => setEditingEntryIdx(idx)}>
                          <Pencil className="h-3 w-3" />
                        </Button>
                        <Button type="button" variant="ghost" size="icon-xs" title="분기" onClick={() => void onFork(idx)}>
                          <GitBranch className="h-3 w-3" />
                        </Button>
                        <Button type="button" variant="ghost" size="icon-xs" title="즐겨찾기" onClick={() => void onToggleStar(idx)}>
                          <Star key={starActive ? "on" : "off"} className={`h-3 w-3 ${starActive ? "fill-emphasis text-emphasis lvis-anim-star" : ""}`} />
                        </Button>
                      </div>
                    )}
                    <div className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{searchHighlight ? highlightText(entry.text, searchHighlight) : entry.text}</div>
                  </div>
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
                  className="mx-auto text-center text-xs text-muted-foreground py-1 px-3 rounded-full bg-muted/50"
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
            // CheckpointDivider 의 tier prop 이 auto/manual variant 를 구분.
            // PR-2-F-2 이후 sessionId 불변이라 revert 액션 없음 (Copilot 패턴).
            // SummaryToast 가 rendered preamble (12-section structured summary) 노출.
            if (entry.kind === "checkpoint") {
              rendered.push(
                <CheckpointDivider
                  key={`cp-${idx}`}
                  tier={entry.tier}
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
              const groupIsActiveTurn = groupTurnStart === lastUserIdx && streaming;
              if (debugStreamEnabled) {
                debugLog("ChatView", "WorkGroup:render-decision", {
                  groupStart,
                  groupTurnStart,
                  lastUserIdx,
                  globalStreaming: streaming,
                  groupIsActiveTurn,
                });
              }
              const groupEntries: { idx: number; node: React.ReactNode }[] = [];

              while (i < activeEntries.length) {
                const e = activeEntries[i];
                if (!e) { i++; continue; }
                if ((entryTurnStartMap.get(i) ?? groupTurnStart) !== groupTurnStart) break;
                const cls = entryClassMap.get(i);
                if (cls === "final") break;
                if (e.kind === "reasoning") {
                  if (cls === "intermediate") {
                    groupEntries.push({ idx: i, node: <ReasoningCard key={i} entry={e} embedded /> });
                  } else {
                    break;
                  }
                } else if (e.kind === "tool_group") {
                  if (cls === "intermediate") {
                    const spawnNodes = renderSpawnsForGroup(e);
                    groupEntries.push({
                      idx: i,
                      node: spawnNodes.length === 0 ? (
                        <ToolGroupCard key={e.groupId} group={e} embedded sessionId={currentSessionId} />
                      ) : (
                        <Fragment key={e.groupId}>
                          <ToolGroupCard group={e} embedded sessionId={currentSessionId} />
                          {spawnNodes}
                        </Fragment>
                      ),
                    });
                  } else {
                    break;
                  }
                } else if (e.kind === "assistant") {
                  if (cls === "intermediate") {
                    groupEntries.push({
                      idx: i,
                      node: (
                        <AssistantCard
                          key={i}
                          entry={e}
                          highlightQuery={searchHighlight}
                          isStarred={!!isEntryStarred(i)}
                          isFinal={false}
                          embedded
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
                    if (activeEntries[k]?.kind === "user") { aaTurnStart = k; break; }
                  }
                  if (aaTurnStart === groupTurnStart) {
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
                    key={`wg-${groupStart}`}
                    stepCount={groupSummary?.toolCount ?? groupEntries.length}
                    streaming={groupIsActiveTurn}
                    turnDurationMs={groupSummary?.turnDurationMs}
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
              } else if (entry.kind === "tool_group") {
                rendered.push(<ToolGroupCard key={entry.groupId} group={entry} sessionId={currentSessionId} />);
                for (const node of renderSpawnsForGroup(entry)) rendered.push(node);
              } else if (entry.kind === "assistant") {
                rendered.push(
                  <div key={idx} data-chat-entry-index={idx} className={ringCls || undefined}>
                    <AssistantCard
                      entry={entry}
                      highlightQuery={searchHighlight}
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
              rendered.push(
                  <div key={idx} data-chat-entry-index={idx} className={`${ringCls} min-w-0 w-full max-w-full overflow-x-hidden rounded-md`}>
                  <AssistantCard
                    entry={entry}
                    highlightQuery={searchHighlight}
                    isStarred={!!isEntryStarred(idx)}
                    isFinal={true}
                  />
                  {/* §PR-5: suppress mutating TurnActionBar actions in view-mode */}
                  <TurnActionBar
                    turnSummary={summary}
                    pricing={activePricing}
                    vendor={activeVendor}
                    isStarred={!!isEntryStarred(idx)}
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
            } else if (entry.kind === "tool_group") {
              rendered.push(<ToolGroupCard key={entry.groupId} group={entry} sessionId={currentSessionId} />);
              for (const node of renderSpawnsForGroup(entry)) rendered.push(node);
            }
            i++;
          }
          return rendered;
        })()}
        <div ref={chatEndRef} />
      </div></ScrollArea>
      {showJumpToBottom && (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="absolute bottom-4 right-5 z-20 h-8 rounded-full border bg-background/90 px-3 text-xs shadow-md backdrop-blur"
          onClick={() => scrollChatToBottom("smooth")}
          data-testid="jump-to-bottom"
        >
          <ChevronDown className="mr-1 h-3.5 w-3.5" />
          맨밑으로
        </Button>
      )}
      </div>
      {contextOverflowPct >= 0.95 && (
        <div className="flex w-full max-w-full items-center gap-2 border-t bg-destructive/10 px-3 py-1.5 text-xs text-destructive">
          <span className="font-semibold">컨텍스트 {Math.round(contextOverflowPct * 100)}% 사용</span>
          <span>— 자동 압축이 필요합니다. 전송이 일시 차단됩니다.</span>
        </div>
      )}
      {contextOverflowPct >= 0.80 && contextOverflowPct < 0.95 && (
        <div className="flex w-full max-w-full items-center gap-2 border-t bg-warning/15 px-3 py-1.5 text-xs text-warning">
          <span className="font-semibold">컨텍스트 {Math.round(contextOverflowPct * 100)}% 사용</span>
          <span>— 곧 자동 압축됩니다.</span>
        </div>
      )}
      {/* Assistant todo panel — anchored above the input cluster, below the
          chat scroll area. Stays visible regardless of where the user has
          scrolled the chat. The panel collapses by default once it has
          content; in the collapsed state the active item title streams next
          to the count so the user always sees what step is running. */}
      <div className="relative z-30 w-full max-w-full min-w-0 overflow-visible border-t border-border/70 bg-card/95">
        <div className="w-full max-w-full min-w-0" data-testid="session-todo-dock">
          <SessionTodoPanel api={workflowApi} sessionId={currentSessionId} />
          <MessageQueuePanel
            store={messageQueueStore}
            onSendNow={(item) => {
              // 행별 [↑ 즉시] — 그 1 항목만 즉시 주입 = 사용자 명시 인터럽트.
              // "⚡ 중단후 새메세지" hint. handleAsk 자체 abort.
              messageQueueStore.remove(item.id);
              const text = formatQueueInject([item]);
              void onAsk(text, { inputOrigin: "user-keyboard", token: "" }, { injectHint: "interrupt" });
            }}
          />
        </div>
        <div className="w-full max-w-full min-w-0 overflow-x-hidden pb-1 space-y-2">
          <InputActionBar
            plugins={plugins}
            onSelectPlugin={onSelectPlugin}
            installingPlugins={installingPlugins}
            onOpenMarketplace={onOpenMarketplace}
            marketplaceUrlReady={marketplaceUrlReady}
            onInsertSlashCommand={(cmd) => setQuestion(question ? question + cmd + " " : cmd + " ")}
            commandActions={commandActions}
            commandPopoverOpen={commandPopoverOpen}
            onCommandPopoverOpenChange={onCommandPopoverOpenChange}
            attachDisabled={
              attachments.length >= ATTACH_MAX_COUNT ||
              hasApiKey === false ||
              contextOverflowPct >= 0.95
            }
            attachDisabledReason={
              hasApiKey === false
                ? "no-api-key"
                : contextOverflowPct >= 0.95
                  ? "context-overflow"
                  : "limit"
            }
            onAttach={async () => {
            const result = await window.lvis.attach.openFile();
            if (result.canceled) return;
            if (result.rejected.length > 0) {
              console.warn("attachment rejected (deny-list):", result.rejected, "deny:", DENY_EXTENSIONS);
            }
            // Build all candidate attachments first. The 5-cap is enforced
            // at *commit* time inside the setAttachments updater, so a
            // concurrent clipboard paste during the readImage await cannot
            // push us past the limit (the updater receives the latest
            // committed state, not the closure-captured one).
            const candidates: Attachment[] = [];
            for (const f of result.files) {
              const n = ++attachmentNCounter.current;
              if (f.isImage) {
                const img = await window.lvis.attach.readImage(f.path);
                if (
                  !img.ok ||
                  !img.dataUrl ||
                  !img.mimeType ||
                  img.width === undefined ||
                  img.height === undefined ||
                  img.bytes === undefined
                ) {
                  console.warn("readImage failed", f.path, img.error);
                  continue;
                }
                candidates.push({
                  id: `img-${Date.now()}-${n}`,
                  n,
                  kind: "image",
                  path: f.path,
                  mimeType: img.mimeType,
                  width: img.width,
                  height: img.height,
                  bytes: img.bytes,
                  dataUrl: img.dataUrl,
                });
              } else {
                candidates.push({
                  id: `file-${Date.now()}-${n}`,
                  n,
                  kind: "file",
                  path: f.path,
                  name: f.name,
                  ext: f.ext,
                  bytes: f.bytes,
                });
              }
            }
            if (candidates.length === 0) {
              composerRef.current?.focus();
              return;
            }
            // Atomic commit: setAttachments AND text-insert MUST land in
            // the same render commit, otherwise Composer's marker-sync
            // useEffect runs between the two and clears `attachments`
            // (because text still has no marker → liveAttachments=[] →
            // mismatch → destructive cleanup). Putting both inside one
            // flushSync batches them so the next render sees attachments
            // and marker text consistent.
            let acceptedMarkers = "";
            flushSync(() => {
              setAttachments((prev) => {
                const remaining = Math.max(0, ATTACH_MAX_COUNT - prev.length);
                const accepted = candidates.slice(0, remaining);
                if (accepted.length < candidates.length) {
                  console.warn(
                    `${candidates.length - accepted.length} attachment(s) dropped — ${ATTACH_MAX_COUNT}-cap reached during async open/read`,
                  );
                }
                acceptedMarkers = accepted.map((a) => `${buildMarkerText(a)} `).join("");
                return [...prev, ...accepted];
              });
              // Insert at caret in the SAME flushSync — batched with
              // setAttachments into one render so the destructive sync
              // useEffect never sees a mismatch.
              if (acceptedMarkers) {
                if (composerRef.current) {
                  composerRef.current.insertAtCursor(acceptedMarkers);
                } else {
                  setQuestion((prev) => prev + acceptedMarkers);
                }
              }
            });
            // Return focus to the composer textarea so the user can keep
            // typing or use Cmd/Ctrl+A immediately after the file dialog
            // closes — without this, focus stays on the action bar button
            // and the next keystroke goes nowhere visible.
            composerRef.current?.focus();
            }}
            rolePresets={rolePresets}
            activePreset={activePreset}
            activePresetId={activePresetId}
            onSelectPreset={setActivePresetId}
            vendorSupportsThinking={vendorSupportsThinking}
            enableThinkingChat={enableThinkingChat}
            onToggleThinking={toggleThinking}
            permissionSlot={
              <PermissionModeBadge
                onClick={() => onOpenSettings("permissions")}
                onQueueClick={onOpenPermissionQueue}
              />
            }
            approvalSlot={<DeferredApprovalChip draftText={question} />}
          />
          {/* v6 layout: Composer (textarea) + BottomActionRow (TokenRing/가이드/
              단축키/취소/Send) 가 하나의 흰색 컨테이너 안. 사용자 인지 = "타이핑
              영역 + 즉시 액션" 한 묶음. shadow-md + rounded-xl 로 경계 강조. */}
          <div className="mx-3 rounded-xl bg-input-bar shadow-md overflow-hidden">
          <Composer
            ref={composerRef}
            text={question}
            onTextChange={setQuestion}
            attachments={attachments}
            onAttachmentsChange={setAttachments}
            allocateN={() => ++attachmentNCounter.current}
            saveClipboardImage={(b64) => window.lvis.attach.saveClipboardImage(b64)}
            openExternal={(p) => window.lvis.attach.openExternal(p)}
            onSend={handleComposerSend}
            disabled={
              // Slash commands (e.g. /compact) bypass the context-overflow gate
              // so the user can escape a fully-blocked input even while the
              // "자동 압축이 필요합니다" banner is showing.
              (hasApiKey === false || contextOverflowPct >= 0.95 || viewMode !== null) &&
              !question.trimStart().startsWith("/")
            }
            onWarning={(msg) => console.warn(msg)}
            placeholder={
              hasApiKey === false
                ? "API 키를 먼저 설정해 주세요..."
                : streaming
                  ? "메시지 큐에 추가됩니다 (즉시 인터럽트는 ⌘⏎)"
                  : "질문 입력 (Enter 전송 · Cmd/Ctrl+V 첨부) · /command 사용 가능"
            }
          />
          <BottomActionRow
            tokenSlot={
              <div className="flex min-w-0 items-center gap-2">
                <TokenProgressRing used={usedTokens} budget={contextBudget} />
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className={`text-[11px] font-mono ${costBadgeClass}`} title="예상 비용">
                      {formatCostBadge(costEstimate.total)}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent className="text-xs">
                    <div>입력: {costEstimate.inputTokens.toLocaleString()} tok · ${costEstimate.inputCost.toFixed(5)}</div>
                    <div>출력(추정): {costEstimate.outputTokens.toLocaleString()} tok · ${costEstimate.outputCost.toFixed(5)}</div>
                    <div className="font-semibold">합계: ${costEstimate.total.toFixed(5)}</div>
                  </TooltipContent>
                </Tooltip>
              </div>
            }
            isBusy={streaming}
            isSendDisabled={
              (hasApiKey === false || contextOverflowPct >= 0.95 || viewMode !== null) &&
              !question.trimStart().startsWith("/")
                ? true
                : question.trim().length === 0 && attachments.length === 0
            }
            onSend={() => handleComposerSend({ inputOrigin: "user-keyboard", token: "" })}
            onCancel={() => {
              // ESC handler 와 동일: 큐를 inject + abort (멈춤 X, 입력으로 inject).
              flushQueueAsUserMessage();
            }}
            onGuide={() => {
              // Stage 4: 가이드 버튼 = ChatView 의 onGuide 호출 위임. Stage 5 에서
              // ⌘K 단축키 + open guide modal 추가 예정. 현재는 streaming 중
              // 방향지시 와 동일 동작 (text 비어있어도 시도).
              const text = question;
              void (async () => {
                const result = await onGuide(text);
                if (result?.ok === true) {
                  setQuestion("");
                } else if (result?.ok === false) {
                  const message =
                    result.error === "queue-full" ? "방향 지시가 너무 많아 대기열이 가득 찼습니다." :
                    result.error === "too-long" ? "방향 지시 한 건이 너무 깁니다 (최대 8000자)." :
                    result.error === "no-active-turn" ? "진행 중인 응답이 없어 방향 지시를 보낼 수 없습니다." :
                    `방향 지시 전송 실패: ${result.error}`;
                  onGuideError(message);
                }
              })();
            }}
            guideDisabled={!streaming || question.trim().length === 0}
          />
          </div>
          {/* v6 Stage 4b: PermissionModeBadge + DeferredApprovalChip 모두
              InputActionBar trailing 으로 이전 완료. 본 자리 비움. */}
        </div>
        <QuestionOverlay
          api={api}
          requests={askQuestions}
          onResolved={onResolveAskQuestion}
        />
      </div>
    </div>
  );
}

function getKoreaDateKey(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}
