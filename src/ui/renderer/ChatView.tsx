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
import { SubAgentCard } from "./components/SubAgentCard.js";
import { TokenCostBadge } from "./components/TokenCostBadge.js";
import { TokenProgressRing } from "./components/TokenProgressRing.js";
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

/**
 * ChatView — consumes cross-cutting state via `useChatContext()`. Action
 * callbacks stay as direct props so data flow for user-driven side effects
 * remains explicit at the App level.
 */
export interface ChatViewProps {
  api: LvisApi;
  onAsk: (q: string, intent?: UserKeyboardIntentSnapshot) => void | Promise<void>;
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
      // Parse envelope source tag to confirm overlay trigger provenance.
      // title + summary fields are already clean (set at insert time).
      const envelopeSource = parseImportedTriggerEnvelope(entry.prompt);
      rendered.push(
        <div
          key={`trigger:${entry.sessionId}`}
          className="mx-3 my-1 rounded border border-action-view/20 bg-action-view/5 px-3 py-2 text-xs"
        >
          <div className="flex items-center gap-1 text-action-view font-medium">
            <span>●</span>
            <span>{envelopeSource ?? entry.summary.slice(0, 60)}</span>
          </div>
          {entry.summary && (
            // markdown 으로 render — plugin prompt 의 `\n` + list (`- 항목`) +
            // **bold** 등을 살림. plain `<p>` 시 CSS `white-space: normal` 이
            // newline 을 collapse 해 모든 내용이 한 줄로 붙어 가독성 손상.
            // response 측 (아래) 과 같은 markdown 파이프라인 재사용.
            <div className="mt-1 text-muted-foreground prose prose-sm lvis-prose max-w-none">
              <ReactMarkdown remarkPlugins={MARKDOWN_REMARK_PLUGINS}>
                {entry.summary}
              </ReactMarkdown>
            </div>
          )}
          {entry.response && (
            <div className="mt-2 text-foreground/80 prose prose-sm lvis-prose max-w-none">
              <ReactMarkdown remarkPlugins={MARKDOWN_REMARK_PLUGINS}>
                {entry.response}
              </ReactMarkdown>
            </div>
          )}
          {entry.responseStreaming && !entry.response && (
            <p className="mt-1 text-muted-foreground animate-pulse">응답 중...</p>
          )}
        </div>,
      );
      i++;
      continue;
    }

    i++;
  }

  return <div className="min-w-0 w-full max-w-full space-y-3 overflow-x-hidden">{rendered}</div>;
}

export function ChatView({ api, onAsk, onEditSave, onFork, onToggleStar, onRetryEffort, isEntryStarred, onAbort, onFeedback, subAgentSpawns, loadedSkills, hasAskQuestions, askQuestions, onResolveAskQuestion, plugins, onSelectPlugin, sessions, onLoadSession, onRefreshSessions, commandActions, commandPopoverOpen, onCommandPopoverOpenChange, installingPlugins, onOpenMarketplace, marketplaceUrlReady, onPluginPrimaryAction, onRoutineAcknowledge, onOpenPermissionQueue }: ChatViewProps) {
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
                    {starActive ? (
                      <Star key="active" className="absolute right-2 top-2 h-3 w-3 fill-emphasis text-emphasis lvis-anim-star" />
                    ) : null}
                    {/* §PR-5: hide mutating actions in view-mode (read-only slice) */}
                    {!viewMode && (
                      <div className="absolute right-2 top-2 hidden gap-1 group-hover:flex bg-message-user/95 rounded">
                        <button className="rounded p-0.5 hover:bg-[hsl(var(--hover-overlay)/0.2)]" title="편집" onClick={() => setEditingEntryIdx(idx)}><Pencil className="h-3 w-3" /></button>
                        <button className="rounded p-0.5 hover:bg-[hsl(var(--hover-overlay)/0.2)]" title="분기" onClick={() => void onFork(idx)}><GitBranch className="h-3 w-3" /></button>
                        <button className="rounded p-0.5 hover:bg-[hsl(var(--hover-overlay)/0.2)]" title="즐겨찾기" onClick={() => void onToggleStar(idx)}>
                          <Star key={starActive ? "on" : "off"} className={`h-3 w-3 ${starActive ? "fill-emphasis text-emphasis lvis-anim-star" : ""}`} />
                        </button>
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
              rendered.push(<div key={idx} className="mx-auto text-center text-xs text-muted-foreground py-1 px-3 rounded-full bg-muted/50">{entry.text}</div>);
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
              // Parse envelope source tag to confirm overlay trigger provenance.
              // title + summary fields are already clean (set at insert time).
              const envelopeSource = parseImportedTriggerEnvelope(entry.prompt);
              rendered.push(
                <div
                  key={`trigger:${entry.sessionId}`}
                  className="mx-3 my-1 rounded border border-action-view/20 bg-action-view/5 px-3 py-2 text-xs"
                >
                  <div className="flex items-center gap-1 text-action-view font-medium">
                    <span>●</span>
                    <span>{envelopeSource ?? entry.summary.slice(0, 60)}</span>
                  </div>
                  {entry.summary && (
                    <p className="mt-1 text-muted-foreground">{entry.summary}</p>
                  )}
                  {entry.response && (
                    <div className="mt-2 text-foreground/80 prose prose-sm lvis-prose max-w-none">
                      <ReactMarkdown remarkPlugins={MARKDOWN_REMARK_PLUGINS}>
                        {entry.response}
                      </ReactMarkdown>
                    </div>
                  )}
                  {entry.responseStreaming && !entry.response && (
                    <p className="mt-1 text-muted-foreground animate-pulse">응답 중...</p>
                  )}
                </div>,
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
        <div className="w-full max-w-full min-w-0 px-3">
          <div className="min-w-0">
            <SessionTodoPanel api={workflowApi} sessionId={currentSessionId} />
          </div>
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
            onSend={(intent) => void onAsk(question, intent)}
            onAbort={() => void onAbort()}
            streaming={streaming}
            disabled={hasApiKey === false || contextOverflowPct >= 0.95 || viewMode !== null}
            onWarning={(msg) => console.warn(msg)}
            placeholder={
              hasApiKey === false
                ? "API 키를 먼저 설정해 주세요..."
                : streaming
                  ? "새 메시지 전송 시 현재 응답을 중단하고 새 턴을 시작합니다"
                  : "질문 입력 (Enter 전송 · Cmd/Ctrl+V 첨부) · /command 사용 가능"
            }
          />
          <div className="flex min-w-0 items-center justify-between gap-3 px-3">
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
            <div className="ml-auto flex shrink-0 items-center justify-end">
              <PermissionModeBadge
                onClick={() => onOpenSettings("permissions")}
                onQueueClick={onOpenPermissionQueue}
              />
            </div>
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
