import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { ChevronDown, KeyRound, Pencil, Star, GitBranch } from "lucide-react";
import { Button } from "../../components/ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/ui/tooltip.js";
import { ScrollArea } from "../../components/ui/scroll-area.js";
import { formatCostBadge } from "../../lib/cost-estimator.js";
import { debugLog, isDebugStreamEnabled } from "../../lib/debug-stream.js";
import { RoutineCard } from "./components/RoutineCard.js";
import { RoutineRunningIndicator } from "./components/RoutineRunningIndicator.js";
import { TriggerCard } from "./components/TriggerCard.js";
import { ImportedTriggerCard } from "./components/ImportedTriggerCard.js";
import { AssistantCard } from "./components/AssistantCard.js";
import { UserMessageEditor } from "./components/UserMessageEditor.js";
import { ReasoningCard } from "./components/ReasoningCard.js";
import { ToolGroupCard } from "./components/ToolGroupCard.js";
import { ChatSearchOverlay } from "./components/ChatSearchOverlay.js";
import { DayDivider } from "./components/DayDivider.js";
import { CheckpointDivider } from "./components/CheckpointDivider.js";
import { SummaryToast } from "./components/SummaryToast.js";
import { SessionResumeDivider } from "./components/SessionResumeDivider.js";
import { SessionTodoPanel } from "./components/SessionTodoPanel.js";
import { SubAgentCard } from "./components/SubAgentCard.js";
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
import { useChatContext } from "./context/ChatContext.js";
import { InputActionBar } from "./components/InputActionBar.js";
import { Composer, type ComposerHandle } from "./components/Composer.js";
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
import { useContinuousHistory, type ContinuousHistorySession } from "./hooks/use-continuous-history.js";

const CHAT_BOTTOM_THRESHOLD_PX = 96;

/**
 * ChatView — consumes cross-cutting state via `useChatContext()`. Action
 * callbacks stay as direct props so data flow for user-driven side effects
 * remains explicit at the App level.
 */
export interface ChatViewProps {
  api: LvisApi;
  onAsk: (q: string) => void | Promise<void>;
  onGuide: (q: string) => void | Promise<void>;
  onEditSave: (idx: number, text: string) => void | Promise<void>;
  onFork: (idx: number) => void | Promise<void>;
  onToggleStar: (idx: number) => void | Promise<void>;
  onRetryEffort: () => void | Promise<void>;
  isEntryStarred: (idx: number) => string | null;
  /** B4: abort current streaming turn */
  onAbort: () => void | Promise<void>;
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
  /**
   * §457 Phase 3: revert active session to the parent of a rotation
   * checkpoint. When provided, a "여기로 되돌아가기" link is rendered next
   * to checkpoint fallback entries that carry a `revertSessionId`. When
   * omitted, the link is hidden even on rotation checkpoints.
   */
  onRevertCheckpoint?: (revertSessionId: string) => void | Promise<void>;
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

function HistoricalEntriesList({ entries }: { entries: ContinuousHistorySession["entries"] }) {
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
      return <ToolGroupCard key={entry.groupId || idx} group={entry} embedded={embedded} />;
    }
    if (entry.kind === "ask_user_answer") {
      return <AskUserAnswerBubble key={entry.sourceToolUseId || idx} entry={entry} />;
    }
    if (entry.kind === "turn_summary") {
      // Historical: turn_summary 는 데이터 carrier 로만 — standalone 표시 X.
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
      if (workItems.length > 0) {
        // historical 의 turnStart 추적 — 이전 user entry idx 가 있으면 그것이
        // 이 segment 의 turnStart. turn_summary 는 segment 외부 (다음 user
        // 직전) 에 있으므로 entries 전체에서 찾되 segment 가 끝나기 전이어야.
        let histTurnStart = -1;
        for (let k = segmentStart; k >= 0; k--) {
          if (entries[k]?.kind === "user") { histTurnStart = k; break; }
        }
        let histDurationMs: number | undefined;
        if (histTurnStart >= 0) {
          for (let k = segmentStart; k < entries.length; k++) {
            const ne = entries[k];
            if (!ne) continue;
            if (ne.kind === "user" && k !== histTurnStart) break;
            if (ne.kind === "turn_summary") {
              histDurationMs = ne.turnDurationMs;
              break;
            }
          }
        }
        rendered.push(
          <WorkGroup
            key={`hist-wg-${segmentStart}`}
            stepCount={workItems.length}
            streaming={false}
            {...(histDurationMs !== undefined && histDurationMs > 0 ? { turnDurationMs: histDurationMs } : {})}
          >
            {workItems.map((item) => renderEntry(item.entry, item.idx, true))}
          </WorkGroup>,
        );
      }
      if (finalAssistantOffset >= 0) {
        const finalItem = segment[finalAssistantOffset];
        if (finalItem) rendered.push(renderEntry(finalItem.entry, finalItem.idx));
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

    if (entry.kind === "turn_summary") {
      // Historical: turn_summary 는 데이터 carrier 로만 — standalone 표시 X.
      // (See note in renderEntry above.)
      i++;
      continue;
    }

    if (entry.kind === "checkpoint") {
      rendered.push(
        <Fragment key={i}>
          <CheckpointDivider tier={entry.tier} messageCount={entry.removedMessages} />
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
          source={entry.source}
          prompt={entry.prompt}
          summary={entry.summary}
          toolCallCount={entry.toolCallCount}
          importedAt={entry.importedAt}
          response={entry.response}
          responseStreaming={false}
        />,
      );
      i++;
      continue;
    }

    i++;
  }

  return <div className="min-w-0 w-full max-w-full space-y-3 overflow-x-hidden">{rendered}</div>;
}

export function ChatView({ api, onAsk, onGuide, onEditSave, onFork, onToggleStar, onRetryEffort, isEntryStarred, onAbort, onFeedback, subAgentSpawns, loadedSkills, hasAskQuestions, askQuestions, onResolveAskQuestion, plugins, onSelectPlugin, sessions, onLoadSession, onRefreshSessions, commandActions, commandPopoverOpen, onCommandPopoverOpenChange, installingPlugins, onOpenMarketplace, marketplaceUrlReady, onRevertCheckpoint }: ChatViewProps) {
  // We still need the api for SessionTodoPanel; obtain it via singleton.
  const workflowApi = getApi();
  const debugStreamEnabled = isDebugStreamEnabled();
  const composerRef = useRef<ComposerHandle | null>(null);
  const {
    entries, streaming, editingEntryIdx, setEditingEntryIdx, editBusy,
    question, setQuestion, chatEndRef, currentSessionId,
    hasApiKey, onOpenSettings,
    routineResult, routineQueueIndex, routineQueueTotal,
    onDismissRoutineResult, onSnoozeRoutineResult,
    onPrevRoutineResult, onNextRoutineResult, runningRoutines,
    triggerResult, onDismissTrigger, onAcceptTrigger,
    searchOpen, searchQuery, searchCase, searchMatches, searchMatchSet, searchIdx, searchHighlight,
    searchChangeQuery, searchToggleCase, searchNext, searchPrev, searchCloseOverlay, searchToggleOverlay,
    contextOverflowPct, usedTokens, contextBudget,
    rolePresets, activePreset, activePresetId, setActivePresetId,
    attachments, setAttachments, attachmentNCounter,
    vendorSupportsThinking, enableThinkingChat, toggleThinking,
    costEstimate, costBadgeClass,
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

  // turn_summary entry 의 turnStart 별 lookup. 각 turn 의 final assistant
  // 와 WorkGroup 이 같은 turn 의 token / duration 정보를 inline 으로 가져와
  // 표시한다. turn_summary entry 자체는 standalone 렌더링 되지 않는다.
  const turnSummaryByTurnStart = useMemo(() => {
    type TurnSummary = {
      turnDurationMs: number;
      toolCount: number;
      cumulativeToolMs: number;
      tokensIn: number;
      tokensOut: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    };
    const map = new Map<number, TurnSummary>();
    let curTurnStart = -1;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (!e) continue;
      if (e.kind === "user") curTurnStart = i;
      else if (e.kind === "turn_summary" && curTurnStart >= 0) {
        map.set(curTurnStart, {
          turnDurationMs: e.turnDurationMs,
          toolCount: e.toolCount,
          cumulativeToolMs: e.cumulativeToolMs,
          tokensIn: e.tokensIn,
          tokensOut: e.tokensOut,
          ...(e.cacheReadTokens !== undefined ? { cacheReadTokens: e.cacheReadTokens } : {}),
          ...(e.cacheWriteTokens !== undefined ? { cacheWriteTokens: e.cacheWriteTokens } : {}),
        });
      }
    }
    return map;
  }, [entries]);

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
    initialBottomScrollPendingRef.current = true;
    sawHistoryLoadingRef.current = false;
    setShowJumpToBottom(false);
  }, [currentSessionId]);

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
    if (isNearBottom()) {
      requestAnimationFrame(() => scrollChatToBottom("smooth"));
    }
  }, [entries.length, isNearBottom, scrollChatToBottom]);

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
      {/* ChatSearchOverlay moved INSIDE ScrollArea below so its sticky top-0
          attaches to the chat scroll viewport instead of floating above it. */}
      {hasApiKey === false && (
        <div className="absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2">
          <Card className="w-[400px]"><CardHeader className="text-center"><KeyRound className="mx-auto mb-2 h-10 w-10 text-muted-foreground" /><CardTitle>API 키 설정 필요</CardTitle><CardDescription>채팅을 시작하려면 Claude API 키를 설정해 주세요.</CardDescription></CardHeader>
            <CardContent className="flex justify-center"><Button onClick={onOpenSettings}><KeyRound className="mr-2 h-4 w-4" />설정 열기</Button></CardContent>
          </Card>
        </div>
      )}
      {/* 루틴 floating overlay — 단일 슬롯에 진행 중 / 결과 중 하나만 표시.
          진행 중이면 RoutineRunningIndicator, 아니면 직전 결과 RoutineCard.
          긴 브리핑은 카드 내부에서 스크롤 (max-h-[60vh] + overflow-y-auto).
          FloatingQuestionPanel은 App 레벨에서 렌더링 — 뷰 전환 시에도 유지. */}
      {/* Suppress the floating routine overlay while an ask card is pending —
          a question demanding the user's response shouldn't compete with a
          running-routine indicator for attention. The overlay reappears
          automatically once the user resolves or dismisses the question. */}
      {(runningRoutines.size > 0 || routineResult) && !hasAskQuestions && (
        <div className="pointer-events-none absolute left-0 right-0 top-2 z-20 flex justify-center px-4">
          <div className="pointer-events-auto flex w-full max-w-2xl max-h-[60vh] flex-col overflow-hidden">
            {runningRoutines.size > 0 ? (
              <RoutineRunningIndicator runningRoutines={runningRoutines} />
            ) : routineResult ? (
              <RoutineCard
                key={`${routineResult.routineId}::${routineResult.generatedAt}`}
                result={routineResult}
                onDismiss={onDismissRoutineResult}
                onSnooze={onSnoozeRoutineResult}
                index={routineQueueIndex}
                total={routineQueueTotal}
                onPrev={onPrevRoutineResult}
                onNext={onNextRoutineResult}
              />
            ) : null}
          </div>
        </div>
      )}
      {/* Proactive trigger overlays — visibility-driven slot routing (P2):
            user-visible → centered modal-like card (below routine area)
            summary-only → top-right compact toast that auto-dismisses
            silent       → never reaches here (filtered in useTriggerResult)
          The trigger session is held in an isolated ConversationLoop so chat
          history below remains clean unless the user clicks "지금 답하기". */}
      {triggerResult && triggerResult.visibility === "user-visible" && (
        <div className="pointer-events-none absolute left-0 right-0 top-[calc(0.5rem+62vh)] z-20 flex justify-center px-4">
          <div className="pointer-events-auto flex w-full max-w-2xl max-h-[40vh] flex-col overflow-hidden">
            <TriggerCard
              key={triggerResult.sessionId}
              result={triggerResult}
              onDismiss={onDismissTrigger}
              onAccept={onAcceptTrigger}
            />
          </div>
        </div>
      )}
      {triggerResult && triggerResult.visibility === "summary-only" && (
        // z-30 keeps the toast above the routine area (z-20) on narrow
        // windows where the centered routine card and right-edge toast
        // overlap horizontally.
        <div className="pointer-events-none absolute right-4 top-2 z-30 flex justify-end">
          <div className="pointer-events-auto w-[380px] max-w-[calc(100vw-2rem)]">
            <TriggerCard
              key={triggerResult.sessionId}
              result={triggerResult}
              onDismiss={onDismissTrigger}
              onAccept={onAcceptTrigger}
            />
          </div>
        </div>
      )}
      <div className="relative min-h-0 min-w-0 max-w-full flex-1 overflow-hidden">
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
                <HistoricalEntriesList entries={session.entries} />
              </Fragment>
            ))}
          </Fragment>
        ))}
        <ChatSearchOverlay
          open={searchOpen}
          query={searchQuery}
          caseSensitive={searchCase}
          matchCount={searchMatches.length}
          currentIdx={searchIdx}
          onChangeQuery={searchChangeQuery}
          onToggleCase={searchToggleCase}
          onNext={searchNext}
          onPrev={searchPrev}
          onClose={searchCloseOverlay}
        />
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
        {entries.length === 0 && !hasHistoricalContent && hasApiKey !== false && !hasAskQuestions && <div className="py-12 text-center text-sm text-muted-foreground">LVIS 에이전트가 준비되었습니다. 질문을 입력하거나 /command를 사용하세요.</div>}
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

          // Last user-message index: determines which WorkGroup belongs to the active turn.
          let lastUserIdx = -1;
          for (let k = entries.length - 1; k >= 0; k--) {
            if (entries[k]?.kind === "user") { lastUserIdx = k; break; }
          }

          type EntryClass = "intermediate" | "live" | "final";
          const entryClassMap = new Map<number, EntryClass>();
          const finalTurnStartMap = new Map<number, number>(); // final idx → turn-start idx
          const entryTurnStartMap = new Map<number, number>(); // classified idx → turn-start idx

          let turnStart = -1;
          for (let i = 0; i < entries.length; i++) {
            const e = entries[i];
            if (!e) continue;
            if (e.kind === "user") { turnStart = i; continue; }
            if (e.kind !== "assistant" && e.kind !== "reasoning" && e.kind !== "tool_group") continue;

            let nextUserIdx = entries.length;
            for (let j = i + 1; j < entries.length; j++) {
              if (entries[j]?.kind === "user") { nextUserIdx = j; break; }
            }

            const subsequentTurnEntries = entries.slice(i + 1, nextUserIdx);
            const hasSubsequent = subsequentTurnEntries.some(
              (ne) => ne.kind === "assistant" || ne.kind === "tool_group" || ne.kind === "reasoning",
            );
            const hasSubsequentWork = subsequentTurnEntries.some(
              (ne) => ne.kind === "tool_group" || ne.kind === "reasoning",
            );

            const myTurnStart = turnStart >= 0 ? turnStart : 0;
            entryTurnStartMap.set(i, myTurnStart);
            const isActiveTurnEntry = myTurnStart === lastUserIdx && streaming;
            const hasPriorWork = entries.slice(myTurnStart + 1, i).some(
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
          while (i < entries.length) {
            const entry = entries[i];
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
              // turns, and mid-stream onGuide() messages where the previous
              // assistant entry is still streaming and has no action bar
              // yet. `!mt-4` uses Tailwind's important prefix to outweigh
              // the parent's `space-y-3` specificity (the descendant
              // selector `> :not([hidden]) ~ :not([hidden])` otherwise
              // wins).
              const prevEntry = i > 0 ? entries[i - 1] : undefined;
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
                  <div key={idx} className={`group relative ml-auto w-fit min-w-0 max-w-[75%] overflow-hidden rounded-md bg-message-user px-3.5 py-2 text-sm text-message-user-foreground ${userGapCls} ${ringCls}`}>
                    {/* "나" label removed — sender is implicit. Star + hover
                        actions float top-right via absolute positioning so
                        the bubble has no header chrome. */}
                    {starActive ? (
                      <Star className="absolute right-2 top-2 h-3 w-3 fill-yellow-400 text-yellow-400" />
                    ) : null}
                    <div className="absolute right-2 top-2 hidden gap-1 group-hover:flex bg-message-user/95 rounded">
                      <button className="rounded p-0.5 hover:bg-black/20" title="편집" onClick={() => setEditingEntryIdx(idx)}><Pencil className="h-3 w-3" /></button>
                      <button className="rounded p-0.5 hover:bg-black/20" title="분기" onClick={() => void onFork(idx)}><GitBranch className="h-3 w-3" /></button>
                      <button className="rounded p-0.5 hover:bg-black/20" title="즐겨찾기" onClick={() => void onToggleStar(idx)}>
                        <Star className={`h-3 w-3 ${starActive ? "fill-yellow-400 text-yellow-400" : ""}`} />
                      </button>
                    </div>
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
              rendered.push(<div key={idx} className="mx-auto text-center text-xs text-muted-foreground py-1 px-3 rounded-full bg-muted/50">{entry.text}</div>);
              i++;
              continue;
            }

            // turn_summary entry — 데이터 carrier 로 history 에 남기되 standalone
            // 렌더링 안 함. 같은 turn 의 final AssistantCard / WorkGroup 이
            // turnSummaryByTurnStart 에서 lookup 해 inline 으로 표시한다.
            if (entry.kind === "turn_summary") {
              i++;
              continue;
            }

            // §457 PR-A: structured rotation markers — tier-aware visuals
            // restored from the deleted StackedChatView (issue #547 visual
            // absorption). CheckpointDivider applies the tier color/icon;
            // SummaryToast surfaces the rolling summary text when present.
            if (entry.kind === "checkpoint") {
              const revertId = entry.revertSessionId;
              rendered.push(
                <CheckpointDivider
                  key={`cp-${idx}`}
                  tier={entry.tier}
                  messageCount={entry.removedMessages}
                  {...(onRevertCheckpoint && revertId
                    ? { onRevert: () => onRevertCheckpoint(revertId) }
                    : {})}
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
                  source={entry.source}
                  prompt={entry.prompt}
                  summary={entry.summary}
                  toolCallCount={entry.toolCallCount}
                  importedAt={entry.importedAt}
                  response={entry.response}
                  responseStreaming={entry.responseStreaming}
                />
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

              while (i < entries.length) {
                const e = entries[i];
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
                        <ToolGroupCard key={e.groupId} group={e} embedded />
                      ) : (
                        <Fragment key={e.groupId}>
                          <ToolGroupCard group={e} embedded />
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
                    if (entries[k]?.kind === "user") { aaTurnStart = k; break; }
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
                rendered.push(
                  <WorkGroup
                    key={`wg-${groupStart}`}
                    stepCount={groupEntries.length}
                    streaming={groupIsActiveTurn}
                    {...(turnSummaryByTurnStart.get(groupTurnStart)?.turnDurationMs
                      ? { turnDurationMs: turnSummaryByTurnStart.get(groupTurnStart)!.turnDurationMs }
                      : {})}
                  >
                    {groupEntries.map((ge) => ge.node)}
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
                rendered.push(<ToolGroupCard key={entry.groupId} group={entry} />);
                for (const node of renderSpawnsForGroup(entry)) rendered.push(node);
              } else if (entry.kind === "assistant") {
                rendered.push(
                  <div key={idx} className={ringCls || undefined}>
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
              // chars/4 turnTokens 계산 폐기 (2026-05-07): provider 보고 값
              // (turn_summary entry 의 tokensIn/Out + cacheRead/Write) 을
              // TurnActionBar 의 TokenCostBadge 에 전달. 한국어 2-3× under-
              // estimate + 시스템 prompt / 도구 schema 누락 문제 해소.
              const turnSummaryProp = summary
                ? {
                    tokensIn: summary.tokensIn,
                    tokensOut: summary.tokensOut,
                    ...(summary.cacheReadTokens !== undefined ? { cacheReadTokens: summary.cacheReadTokens } : {}),
                    ...(summary.cacheWriteTokens !== undefined ? { cacheWriteTokens: summary.cacheWriteTokens } : {}),
                  }
                : undefined;

              rendered.push(
                  <div key={idx} className={`${ringCls} min-w-0 w-full max-w-full overflow-x-hidden rounded-md`}>
                  <AssistantCard
                    entry={entry}
                    highlightQuery={searchHighlight}
                    isStarred={!!isEntryStarred(idx)}
                    isFinal={true}
                  />
                  <TurnActionBar
                    {...(turnSummaryProp ? { turnSummary: turnSummaryProp } : {})}
                    isStarred={!!isEntryStarred(idx)}
                    actions={{
                      onRetry: () => void onRetryEffort(),
                      onFork: () => void onFork(idx),
                      onToggleStar: () => void onToggleStar(idx),
                    }}
                    onFeedback={onFeedback ? (rating, reason) => void onFeedback(idx, rating, reason) : undefined}
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
              rendered.push(<ToolGroupCard key={entry.groupId} group={entry} />);
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
        <div className="flex w-full max-w-full items-center gap-2 border-t bg-amber-500/10 px-3 py-1.5 text-xs text-amber-600 dark:text-amber-400">
          <span className="font-semibold">컨텍스트 {Math.round(contextOverflowPct * 100)}% 사용</span>
          <span>— 곧 자동 압축됩니다.</span>
        </div>
      )}
      {/* Assistant todo panel — anchored above the input cluster, below the
          chat scroll area. Stays visible regardless of where the user has
          scrolled the chat. The panel collapses by default once it has
          content; in the collapsed state the active item title streams next
          to the count so the user always sees what step is running. */}
      <div className="relative z-30 w-full max-w-full min-w-0 overflow-visible bg-background">
        <div className="w-full max-w-full min-w-0 px-3">
          <SessionTodoPanel api={workflowApi} sessionId={currentSessionId} />
        </div>
        <div className="w-full max-w-full min-w-0 overflow-x-hidden pb-1 space-y-2">
          <InputActionBar
            usedTokens={usedTokens}
            contextBudget={contextBudget}
            plugins={plugins}
            onSelectPlugin={onSelectPlugin}
            installingPlugins={installingPlugins}
            onOpenMarketplace={onOpenMarketplace}
            marketplaceUrlReady={marketplaceUrlReady}
            onInsertSlashCommand={(cmd) => setQuestion(question ? question + cmd + " " : cmd + " ")}
            onToggleChatSearch={searchToggleOverlay}
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
          />
          <Composer
            ref={composerRef}
            text={question}
            onTextChange={setQuestion}
            attachments={attachments}
            onAttachmentsChange={setAttachments}
            allocateN={() => ++attachmentNCounter.current}
            saveClipboardImage={(b64) => window.lvis.attach.saveClipboardImage(b64)}
            openExternal={(p) => window.lvis.attach.openExternal(p)}
            onSend={() => void (streaming ? onGuide(question) : onAsk(question))}
            onAbort={() => void onAbort()}
            streaming={streaming}
            disabled={hasApiKey === false || contextOverflowPct >= 0.95}
            onWarning={(msg) => console.warn(msg)}
            placeholder={
              hasApiKey === false
                ? "API 키를 먼저 설정해 주세요..."
                : streaming
                  ? "응답 방향 지시 입력 (Enter 힌트 전송 / Shift+Enter 줄바꿈)"
                  : "질문 입력 (Enter 전송 · Cmd/Ctrl+V 첨부) · /command 사용 가능"
            }
          />
          <div className="px-3">
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
