import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "../../i18n/react.js";
import { flushSync } from "react-dom";
import { ChevronDown, KeyRound, Pencil, Star, GitBranch } from "lucide-react";
import { Button } from "../../components/ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/ui/tooltip.js";
import { ScrollArea } from "../../components/ui/scroll-area.js";
import { formatCostBadge } from "../../lib/cost-estimator.js";
import type { ChatEntry } from "../../lib/chat-stream-state.js";
import type { UserApprovalHitPayload } from "../../shared/permissions-events.js";
import { debugLog, isDebugStreamEnabled } from "../../lib/debug-stream.js";
import { OverlayCardRegion } from "./components/OverlayCardRegion.js";
import { AssistantCard } from "./components/AssistantCard.js";
import { UserMessageEditor } from "./components/UserMessageEditor.js";
import { ReasoningCard } from "./components/ReasoningCard.js";
import { ToolGroupCard } from "./components/ToolGroupCard.js";
import { SessionDateNavigator } from "./components/SessionDateNavigator.js";
import { CheckpointDivider } from "./components/CheckpointDivider.js";
import { SummaryToast } from "./components/SummaryToast.js";
import { ViewModeBanner, type ViewModeState } from "./components/ViewModeBanner.js";
import { SessionResumeDivider } from "./components/SessionResumeDivider.js";
import { SessionTodoPanel } from "./components/SessionTodoPanel.js";
import { MessageQueuePanel } from "./components/MessageQueuePanel.js";
import { MessageQueueStore, formatQueueInject, type MessageQueueItem } from "./state/message-queue-store.js";
import { SubAgentCard } from "./components/SubAgentCard.js";
import { TokenProgressRing } from "./components/TokenProgressRing.js";
import { BottomActionRow } from "./components/BottomActionRow.js";
import { PermissionModeBadge } from "./components/permissions/PermissionModeBadge.js";
import { DEFAULT_TOAST_TTL_MS, SHORT_TOAST_TTL_MS } from "./constants.js";
import { SkillBadge } from "./components/SkillBadge.js";
import { WorkGroup } from "./components/WorkGroup.js";
import { PermissionReviewStatusCard } from "./components/PermissionReviewStatusCard.js";
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
import { useSuggestedReplies } from "./hooks/use-suggested-replies.js";
import { computeComposerPlaceholder, hasActiveSuggestedReplies } from "./utils/composer-placeholder.js";
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
import { type AskUserQuestionRequest } from "./components/AskUserQuestionCard.js";
import type { LvisApi } from "./types.js";
import type { SubAgentSpawn } from "./components/SubAgentCard.js";
import type { SkillBadgeProps } from "./components/SkillBadge.js";
import type { SessionSummary } from "./hooks/use-sessions.js";
import type { UserKeyboardIntentSnapshot } from "../../shared/chat-origin.js";
import ReactMarkdown from "react-markdown";
import { MARKDOWN_REMARK_PLUGINS } from "./utils/markdown-plugins.js";
import { parseImportedTriggerEnvelope } from "../../shared/overlay-trigger-source.js";
import { lookupBillablePricingOptional } from "../../shared/pricing-data.js";
import type { LLMVendor } from "../../shared/llm-vendor-defaults.js";

const CHAT_BOTTOM_THRESHOLD_PX = 96;
const KOREA_DATE_KEY_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

type ImportedTriggerEntry = Extract<ChatEntry, { kind: "imported_trigger" }>;
type ToolGroupEntry = Extract<ChatEntry, { kind: "tool_group" }>;

function isTurnStartEntry(entry: ChatEntry | undefined): boolean {
  return entry?.kind === "user" || entry?.kind === "imported_trigger";
}

function textRevision(text: string | undefined): string {
  if (!text) return "0:0";
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${text.length}:${hash >>> 0}`;
}

function valueRevision(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value !== "object") return textRevision(String(value));
  if (Array.isArray(value)) {
    return textRevision(`[${value.map(valueRevision).join(",")}]`);
  }
  const objectValue = value as Record<string, unknown>;
  return textRevision(`{${Object.keys(objectValue)
    .sort()
    .map((key) => `${key}:${valueRevision(objectValue[key])}`)
    .join(",")}}`);
}

function subAgentRevision(spawn: SubAgentSpawn): string {
  return [
    spawn.spawnId,
    textRevision(spawn.title),
    spawn.status,
    spawn.toolCallCount,
    textRevision(spawn.summary),
    textRevision(spawn.errorMessage),
    spawn.turns
      .map((turn) => `${turn.turn}:${turn.toolCallCount}:${textRevision(turn.text)}`)
      .join("|"),
  ].join(":");
}

function toolGroupRevision(group: ToolGroupEntry, spawnRevisions: string[]): string {
  return [
    group.groupId,
    group.groupIds.join(","),
    group.status,
    group.tools
      .map((tool) => [
        tool.toolUseId,
        tool.name,
        tool.displayOrder,
        tool.status,
        valueRevision(tool.input),
        textRevision(tool.result),
        tool.source ?? "",
        tool.category ?? "",
        tool.pluginId ?? "",
        tool.mcpServerId ?? "",
        tool.durationMs ?? "",
        tool.startedAt ?? "",
        valueRevision(tool.uiPayload),
      ].join(":"))
      .join("|"),
    spawnRevisions.join(","),
  ].join("#");
}

function entryRenderRevision(params: {
  entry: ChatEntry;
  idx: number;
  searchHighlight: string;
  starred: boolean;
  spawnRevisions?: string[];
}): string {
  const { entry, idx, searchHighlight, starred, spawnRevisions = [] } = params;
  switch (entry.kind) {
    case "reasoning":
      return `${idx}:reasoning:${textRevision(entry.text)}:${entry.streaming ? "1" : "0"}`;
    case "assistant":
      return `${idx}:assistant:${textRevision(entry.text)}:${entry.streaming ? "1" : "0"}:${entry.phase ?? ""}:${entry.systemNotice ?? ""}:${textRevision(searchHighlight)}:${starred ? "1" : "0"}`;
    case "permission_review":
      return [
        idx,
        "permission_review",
        entry.toolUseId,
        entry.groupId,
        entry.displayOrder,
        entry.status,
        entry.verdictLevel ?? "",
        entry.toolName,
        entry.source ?? "",
        entry.toolCategory ?? "",
        textRevision(entry.reason),
        valueRevision(entry.approvalPurpose),
      ].join(":");
    case "tool_group":
      return `${idx}:tool_group:${toolGroupRevision(entry, spawnRevisions)}`;
    case "ask_user_answer":
      return `${idx}:ask_user_answer:${entry.dismissed ? "1" : "0"}:${entry.rows.map((row) => `${row.label}:${textRevision(row.value)}`).join("|")}`;
    default:
      return `${idx}:${entry.kind}`;
  }
}

function bottomFollowSignature(entries: ChatEntry[]): string {
  const last = entries.at(-1);
  if (!last) return "empty";
  switch (last.kind) {
    case "user":
    case "system":
      return `${entries.length}:${last.kind}:${last.text.length}`;
    case "reasoning":
    case "assistant":
      return `${entries.length}:${last.kind}:${last.text.length}:${last.streaming ? "streaming" : "done"}`;
    case "tool_group":
      return `${entries.length}:tool_group:${last.status}:${last.tools
        .map((tool) => `${tool.toolUseId}:${tool.status}:${tool.result?.length ?? 0}:${tool.durationMs ?? ""}`)
        .join("|")}`;
    case "turn_summary":
      return `${entries.length}:turn_summary:${last.tokensIn}:${last.tokensOut}:${last.toolCount}`;
    case "checkpoint":
      return `${entries.length}:checkpoint:${last.compactNum ?? ""}:${last.freedTokens}`;
    default:
      return `${entries.length}:${last.kind}`;
  }
}

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
  onContinueFromLastUser?: (sessionId: string) => void | Promise<void>;
  isEntryStarred: (idx: number) => string | null;
  /** B4: abort current streaming turn */
  onAbort: () => void | Promise<void>;
  /** Mid-stream "guide" utterance — non-interrupting direction adjustment. Returns IPC result so caller can preserve typed text on rejection. */
  onGuide: (text: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** Surface visible error in chat transcript when guide is rejected (queue-full / too-long / no-active-turn). */
  onGuideError: (message: string) => void;
  /** Submit thumbs up/down feedback for an assistant message. */
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
  /** Refresh plugin cards/views before opening the plugin grid. */
  onRefreshPlugins?: () => void;
  currentSessionKind?: "main" | "routine";
  currentSessionTitle?: string;
  sessions?: SessionSummary[];
  onLoadSession?: (sessionId: string) => void | boolean | Promise<void | boolean>;
  onRefreshSessions?: () => void | Promise<void>;
  /** Quick-action items for CommandPopover (빠른 실행 section) */
  commandActions: QuickAction[];
  /** Controlled open state for CommandPopover */
  commandPopoverOpen: boolean;
  onCommandPopoverOpenChange: (open: boolean) => void;
  installingPlugins?: ReadonlyMap<string, InstallPhase>;
  onOpenMarketplace: () => void;
  marketplaceUrlReady?: boolean;
  // Fork-based revert is replaced by the same-session checkpoint chain.
  // sessionId remains stable until the user explicitly branches from a checkpoint.
  /** Called when user confirms a plugin overlay item; id is the OverlayItem.id. */
  onPluginPrimaryAction?: (overlayItemId: string) => void;
  /** Called when a completed routine overlay result has been seen or dismissed. */
  onRoutineAcknowledge?: (routineId: string, firedAt: string) => void;
  /** Opens the non-interruptive deferred permission queue modal. */
  onOpenPermissionQueue?: () => void;
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
        className="ml-auto w-fit min-w-0 max-w-[75%] rounded-md border border-border/70 border-l-2 border-l-muted-foreground/60 bg-card/80 px-3 py-2 text-xs text-muted-foreground"
        data-testid="ask-user-answer-bubble"
      >
        <div className="text-[10.5px] text-muted-foreground/80">{t("chatView.askAnswerSkippedLabel")}</div>
        <div className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{t("chatView.askAnswerSkippedProceed")}</div>
      </div>
    );
  }

  return (
    <div
      className="ml-auto w-fit min-w-0 max-w-[75%] rounded-md border border-border/70 border-l-2 border-l-message-user bg-card/90 px-3 py-2 text-xs text-card-foreground shadow-sm"
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

export function ChatView({ api, onAsk, onEditSave, onFork, onToggleStar, onRetryEffort, onContinueFromLastUser, isEntryStarred, onAbort, onGuide, onGuideError, onFeedback, subAgentSpawns, loadedSkills, hasAskQuestions, askQuestions, onResolveAskQuestion, plugins, onSelectPlugin, onRefreshPlugins, currentSessionKind = "main", currentSessionTitle, sessions, onLoadSession, onRefreshSessions, commandActions, commandPopoverOpen, onCommandPopoverOpenChange, installingPlugins, onOpenMarketplace, marketplaceUrlReady, onPluginPrimaryAction, onRoutineAcknowledge, onOpenPermissionQueue }: ChatViewProps) {
  const { t } = useTranslation();
  // We still need the api for SessionTodoPanel; obtain it via singleton.
  const workflowApi = getApi();
  const debugStreamEnabled = isDebugStreamEnabled();
  const composerRef = useRef<ComposerHandle | null>(null);
  const suggestedReplies = useSuggestedReplies();
  const suggestedRepliesActive = hasActiveSuggestedReplies(suggestedReplies);
  const {
    entries, streaming, editingEntryIdx, setEditingEntryIdx, editBusy,
    question, setQuestion, chatEndRef, currentSessionId,
    hasApiKey, onOpenSettings,
    searchOpen, searchMatches, searchMatchSet, searchIdx, searchHighlight,
    contextOverflowPct, usedTokens, contextBudget, effectiveBudget,
    tpmLimit, tpmPct,
    rolePresets, activePreset, activePresetId, setActivePresetId,
    attachments, setAttachments, attachmentNCounter,
    enableThinkingChat, toggleThinking,
    costEstimate, costBadgeClass, activeVendor,
    hideToolFailures,
  } = useChatContext();

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

  // Checkpoint view-mode — null = live, non-null = viewing a past checkpoint slice.
  const [viewMode, setViewMode] = useState<ViewModeState | null>(null);
  // Brief fork-success toast (auto-dismisses after 3 s).
  const [forkToast, setForkToast] = useState<string | null>(null);
  const forkToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // User-approval memory-hit disclosure toast (#793). Subscribes to the
  // `lvis:permissions:user-approval-hit` IPC broadcast wired by PR #786 and
  // surfaces a transient banner so the user sees that a stored approval
  // cache entry auto-resolved the tool call. Auto-dismisses after 4 s.
  const [userApprovalHitToast, setUserApprovalHitToast] = useState<
    UserApprovalHitPayload | null
  >(null);
  const userApprovalHitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  // Cleanup fork toast timer on unmount to avoid setState-after-unmount.
  useEffect(() => {
    return () => {
      if (forkToastTimerRef.current) clearTimeout(forkToastTimerRef.current);
    };
  }, []);

  // Subscribe to user-approval-hit broadcasts. Returned closure both
  // unsubscribes the IPC listener and cancels any in-flight dismiss timer.
  // Cluster review S-Med-2: defense-in-depth structural validation of the
  // IPC payload — TS type guarantees only compile-time; a future bug in
  // permission-manager emitting `null` / `""` / `"critical"` would otherwise
  // propagate to `.toUpperCase()` (throws) or render unexpected text.
  useEffect(() => {
    let api;
    try {
      api = getApi();
    } catch {
      return;
    }
    const unsubscribe = api.permission.onUserApprovalHit((payload) => {
      if (
        !payload ||
        typeof payload.toolName !== "string" ||
        payload.toolName.length === 0 ||
        (payload.scope !== "session" && payload.scope !== "persistent") ||
        (payload.verdictAtApproval !== "low" &&
          payload.verdictAtApproval !== "medium" &&
          payload.verdictAtApproval !== "high")
      ) {
        console.warn(
          "[chat] dropping malformed userApprovalHit payload — see permissions-events.ts SOT",
          payload,
        );
        return;
      }
      if (userApprovalHitTimerRef.current) {
        clearTimeout(userApprovalHitTimerRef.current);
      }
      setUserApprovalHitToast(payload);
      userApprovalHitTimerRef.current = setTimeout(() => {
        setUserApprovalHitToast(null);
      }, DEFAULT_TOAST_TTL_MS);
    });
    return () => {
      unsubscribe();
      if (userApprovalHitTimerRef.current) {
        clearTimeout(userApprovalHitTimerRef.current);
      }
    };
  }, []);

  // In view-mode, show only the sliced entries up to the checkpoint.
  const visibleEntries = useMemo(
    () => viewMode ? entries.slice(0, viewMode.slicedRangeEnd) : entries,
    [entries, viewMode],
  );
  const hasActiveStreamingEntry = useMemo(
    () => visibleEntries.some((entry) => "streaming" in entry && entry.streaming === true),
    [visibleEntries],
  );

  // Calendar's in-session day jump indexer — derived from visibleEntries with
  // only user + assistant entries (the only kinds that carry createdAt).
  // Memoized so that stream-delta re-renders of ChatView don't rebuild the
  // map on every keystroke (which would re-mount the calendar tree behind the
  // closed popover at ~100Hz on long sessions).
  const navigatorCurrentSessionEntries = useMemo(
    () =>
      visibleEntries.map((entry, idx) => ({
        idx,
        createdAt:
          entry.kind === "assistant" || entry.kind === "user"
            ? entry.createdAt
            : undefined,
      })),
    [visibleEntries],
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
      vendorProvider?: LLMVendor;
      vendorModel?: string;
      usageByModel?: Extract<ChatEntry, { kind: "turn_summary" }>["usageByModel"];
    };
    const map = new Map<number, TurnSummary>();
    let curTurnStart = -1;
    for (let i = 0; i < visibleEntries.length; i++) {
      const e = visibleEntries[i];
      if (!e) continue;
      if (isTurnStartEntry(e)) curTurnStart = i;
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
          ...(e.vendorProvider !== undefined ? { vendorProvider: e.vendorProvider } : {}),
          ...(e.vendorModel !== undefined ? { vendorModel: e.vendorModel } : {}),
          ...(e.usageByModel !== undefined ? { usageByModel: e.usageByModel } : {}),
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

  const scrollViewportRef = useRef<HTMLDivElement | null>(null);
  const previousEntryCountRef = useRef(entries.length);
  const previousSessionIdRef = useRef(currentSessionId);
  const pinnedToBottomRef = useRef(true);
  const autoBottomPinFrameRef = useRef<number | null>(null);
  const scrollFollowSignature = useMemo(() => bottomFollowSignature(entries), [entries]);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);

  const isNearBottom = useCallback(() => {
    const viewport = scrollViewportRef.current;
    if (!viewport) return true;
    return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= CHAT_BOTTOM_THRESHOLD_PX;
  }, [scrollViewportRef]);

  const cancelAutoBottomPin = useCallback(() => {
    if (autoBottomPinFrameRef.current === null) return;
    window.cancelAnimationFrame(autoBottomPinFrameRef.current);
    autoBottomPinFrameRef.current = null;
  }, []);

  const pinChatToBottom = useCallback(() => {
    const viewport = scrollViewportRef.current;
    if (viewport) {
      viewport.scrollTop = viewport.scrollHeight;
    } else {
      chatEndRef.current?.scrollIntoView({ behavior: "auto" });
    }
    pinnedToBottomRef.current = true;
    setShowJumpToBottom(false);
  }, [chatEndRef, scrollViewportRef]);

  const scheduleAutoBottomPin = useCallback(() => {
    if (autoBottomPinFrameRef.current !== null) return;
    autoBottomPinFrameRef.current = window.requestAnimationFrame(() => {
      autoBottomPinFrameRef.current = null;
      pinChatToBottom();
    });
  }, [pinChatToBottom]);

  const scrollChatToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    cancelAutoBottomPin();
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
    pinnedToBottomRef.current = true;
    setShowJumpToBottom(false);
  }, [cancelAutoBottomPin, chatEndRef, scrollViewportRef]);

  useEffect(() => () => cancelAutoBottomPin(), [cancelAutoBottomPin]);

  const handleCalendarSessionSelect = useCallback(async (sessionId: string) => {
    await onLoadSession?.(sessionId);
  }, [onLoadSession]);

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

  // Checkpoint view-mode handlers.
  const handleEnterView = useCallback(async (compactNum: number) => {
    const result = await api.chatEnterCheckpointView?.(currentSessionId, compactNum);
    if (!result || "error" in result) return;
    // messageIndexAtCreation is engine history message count — it does NOT
    // map 1:1 to renderer entries (which include reasoning/tool_group/checkpoint entries).
    // We cap to entries.length so the slice is always valid, accepting that in tool-heavy
    // sessions the visible range may show slightly more entries than the exact checkpoint.
    // A precise renderer↔engine index mapping can be added later if needed.
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
    if (streaming || hasActiveStreamingEntry) {
      if (forkToastTimerRef.current) clearTimeout(forkToastTimerRef.current);
      setForkToast(t("chatView.forkBusyToast"));
      forkToastTimerRef.current = setTimeout(() => setForkToast(null), SHORT_TOAST_TTL_MS);
      return;
    }
    const result = await api.chatBranchFromCheckpoint?.(currentSessionId, compactNum);
    if (!result || "error" in result) return;
    // Exit view-mode before loading the new session so it opens in live mode.
    setViewMode(null);
    // Load the branched session
    if (!onLoadSession) return;
    const loaded = await onLoadSession(result.newSessionId);
    if (loaded === false) return;
    // Show fork-success toast (shorter than default — single-line confirmation needs less time)
    if (forkToastTimerRef.current) clearTimeout(forkToastTimerRef.current);
    setForkToast(
      result.shouldAutoContinue
        ? t("chatView.forkSuccessAutoContinue", { compactNum })
        : t("chatView.forkSuccess", { compactNum }),
    );
    forkToastTimerRef.current = setTimeout(() => setForkToast(null), SHORT_TOAST_TTL_MS); // single-line fork confirmation needs less read time
    if (result.shouldAutoContinue) {
      await onContinueFromLastUser?.(result.newSessionId);
    }
  }, [api, currentSessionId, hasActiveStreamingEntry, onContinueFromLastUser, onLoadSession, streaming]);

  useEffect(() => {
    setShowJumpToBottom(false);
  }, [currentSessionId]);

  // per-ChatView message-queue store. session 변경 시 자동 비움.
  const messageQueueStore = useMemo(() => new MessageQueueStore(), []);
  // queue-auto inject in-flight 플래그 — done event re-entrancy 방지.
  const queueAutoInflightRef = useRef(false);

  // dev/e2e runtime test hook — Playwright launches production-built renderer
  // assets, so this must use preload runtime env instead of build-time NODE_ENV.
  useEffect(() => {
    const w = window as unknown as {
      __lvis_message_queue_store__?: MessageQueueStore;
      lvis?: { env?: { isDev?: boolean; isE2E?: boolean } };
    };
    if (w.lvis?.env?.isDev === true && w.lvis?.env?.isE2E === true) {
      w.__lvis_message_queue_store__ = messageQueueStore;
    }
    return () => {
      if (w.__lvis_message_queue_store__ === messageQueueStore) {
        delete w.__lvis_message_queue_store__;
      }
    };
  }, [messageQueueStore]);
  useEffect(() => {
    messageQueueStore.clear();
  }, [currentSessionId, messageQueueStore]);

  // 자연 인입 (true mid-turn brake-point) — 엔진의 onGuide
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
  // brake-point 에서 큐 flush 시도. 실패 시 — re-add 는 무한 loop 위험
  // (no-active-turn 직후 brake 가 다시 fire → 다시 drop → 영구 stuck) 라
  // 메시지를 다시 큐에 넣지 않고 **사용자 가시 에러로 surface** 한다.
  // 단순 console.warn 은 큐가 silent 로 사라지는 회귀였음 (#849).
  const flushQueueViaGuide = useCallback(() => {
    if (messageQueueStore.size() === 0) return;
    const taken = messageQueueStore.takeAll();
    if (taken.length === 0) return;
    const formatted = formatQueueInject(taken);
    void (async () => {
      const result = await onGuide(formatted);
      if (result?.ok !== true) {
        const reason = result?.error ?? "unknown";
        const count = taken.length;
        const reasonLabel =
          reason === "queue-full" ? t("chatView.queueFlushFailReasonFull") :
          reason === "too-long" ? t("chatView.queueFlushFailReasonTooLong") :
          reason === "no-active-turn" ? t("chatView.queueFlushFailReasonNoTurn") :
          `(${reason})`;
        // Surface a user-visible error so the lost messages don't disappear
        // silently. Re-add is intentionally avoided to prevent infinite-retry
        // cascade — the user can re-type if they want to retry.
        onGuideError(t("chatView.queueFlushFailMessage", { count, reasonLabel }));
        console.warn(`[message-queue] guide flush dropped (${reason}):`, formatted.slice(0, 80));
      }
    })();
  }, [messageQueueStore, onGuide, onGuideError]);

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

  // composer Enter morph — busy = queue.add, idle = onAsk 직행.
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

  const handleMessageQueueSendNow = useCallback((item: MessageQueueItem) => {
    messageQueueStore.remove(item.id);
    const text = formatQueueInject([item]);
    void onAsk(text, { inputOrigin: "user-keyboard", token: "" }, { injectHint: "interrupt" });
  }, [messageQueueStore, onAsk]);

  const handleInsertSlashCommand = useCallback((cmd: string) => {
    setQuestion((prev) => (prev ? `${prev}${cmd} ` : `${cmd} `));
  }, [setQuestion]);

  const noopPluginPrimaryAction = useCallback(() => {}, []);

  const handleBottomSend = useCallback(() => {
    handleComposerSend({ inputOrigin: "user-keyboard", token: "" });
  }, [handleComposerSend]);

  const tokenSlot = useMemo(() => (
    <div className="flex min-w-0 items-center gap-2">
      <TokenProgressRing
        used={usedTokens}
        budget={effectiveBudget}
        contextBudget={contextBudget}
        tpmLimit={tpmLimit}
      />
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={`text-[11px] font-mono ${costBadgeClass}`} title={t("chatView.estimatedCostTitle")}>
            {formatCostBadge(costEstimate.total, costEstimate.pricingKnown)}
          </span>
        </TooltipTrigger>
        <TooltipContent className="text-xs">
          <div>{t("chatView.costInputLabel")} {costEstimate.inputTokens.toLocaleString()} tok{costEstimate.pricingKnown === false ? "" : ` · $${costEstimate.inputCost.toFixed(5)}`}</div>
          <div>{t("chatView.costOutputLabel")} {costEstimate.outputTokens.toLocaleString()} tok{costEstimate.pricingKnown === false ? "" : ` · $${costEstimate.outputCost.toFixed(5)}`}</div>
          {costEstimate.pricingKnown === false
            ? <div className="font-semibold">{t("chatView.costUnknownModel")}</div>
            : <div className="font-semibold">{t("chatView.costTotalLabel")} ${costEstimate.total.toFixed(5)}</div>}
        </TooltipContent>
      </Tooltip>
    </div>
  ), [contextBudget, costBadgeClass, costEstimate, effectiveBudget, tpmLimit, usedTokens]);

  // ESC 우선순위
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

  // ⌘K = 가이드 호출. text 비어 있으면 noop. busy 와 무관 (idle 에서도 가이드 가능).
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
            result.error === "queue-full" ? t("chatView.guideErrorQueueFull") :
            result.error === "too-long" ? t("chatView.guideErrorTooLong") :
            result.error === "no-active-turn" ? t("chatView.guideErrorNoActiveTurn") :
            t("chatView.guideErrorFailed", { error: result.error });
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
    const onScroll = () => {
      const nearBottom = isNearBottom();
      pinnedToBottomRef.current = nearBottom;
      if (!nearBottom) cancelAutoBottomPin();
      setShowJumpToBottom(!nearBottom);
    };
    onScroll();
    viewport.addEventListener("scroll", onScroll, { passive: true });
    return () => viewport.removeEventListener("scroll", onScroll);
  }, [cancelAutoBottomPin, isNearBottom, scrollViewportRef]);

  useEffect(() => {
    const previousEntryCount = previousEntryCountRef.current;
    const previousSessionId = previousSessionIdRef.current;
    previousEntryCountRef.current = entries.length;
    previousSessionIdRef.current = currentSessionId;
    // Suppress auto-scroll while in view-mode so new live entries don't
    // yank the viewport away from the frozen checkpoint slice the user is reading.
    if (viewMode) return;
    if (
      entries.length > 1 &&
      (previousEntryCount === 0 || previousSessionId !== currentSessionId)
    ) {
      scheduleAutoBottomPin();
      return;
    }
    if (pinnedToBottomRef.current || isNearBottom()) {
      scheduleAutoBottomPin();
    }
  }, [currentSessionId, entries.length, isNearBottom, scheduleAutoBottomPin, scrollFollowSignature, viewMode]);

  const activeDayKey = getKoreaDateKey(new Date());
  const handleJumpToEntry = useCallback((entryIndex: number) => {
    const el = scrollViewportRef.current?.querySelector<HTMLElement>(
      `[data-chat-entry-index="${entryIndex}"]`,
    );
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [scrollViewportRef]);


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

  const transcriptEntries = useMemo(() => {
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

  // Last turn-start index: user messages and imported overlay prompts both
  // own the assistant/tool/summary output that follows them.
  let lastTurnStartIdx = -1;
  for (let k = activeEntries.length - 1; k >= 0; k--) {
    if (isTurnStartEntry(activeEntries[k])) { lastTurnStartIdx = k; break; }
  }

  type EntryClass = "intermediate" | "live" | "final";
  const entryClassMap = new Map<number, EntryClass>();
  const finalTurnStartMap = new Map<number, number>(); // final idx → turn-start idx
  const entryTurnStartMap = new Map<number, number>(); // classified idx → turn-start idx

  let turnStart = -1;
  for (let i = 0; i < activeEntries.length; i++) {
    const e = activeEntries[i];
    if (!e) continue;
    if (isTurnStartEntry(e)) { turnStart = i; continue; }
    if (e.kind !== "assistant" && e.kind !== "reasoning" && e.kind !== "tool_group" && e.kind !== "permission_review") continue;

    let nextTurnStartIdx = activeEntries.length;
    for (let j = i + 1; j < activeEntries.length; j++) {
      if (isTurnStartEntry(activeEntries[j])) { nextTurnStartIdx = j; break; }
    }

    const subsequentTurnEntries = activeEntries.slice(i + 1, nextTurnStartIdx);
    const hasSubsequent = subsequentTurnEntries.some(
      (ne) => ne.kind === "assistant" || ne.kind === "tool_group" || ne.kind === "reasoning" || ne.kind === "permission_review",
    );
    const hasSubsequentWork = subsequentTurnEntries.some(
      (ne) => ne.kind === "tool_group" || ne.kind === "reasoning" || ne.kind === "permission_review",
    );

    const myTurnStart = turnStart >= 0 ? turnStart : 0;
    entryTurnStartMap.set(i, myTurnStart);
    const isActiveTurnEntry = myTurnStart === lastTurnStartIdx && streaming;
    const hasPriorWork = activeEntries.slice(myTurnStart + 1, i).some(
      (pe) => pe.kind === "tool_group" || pe.kind === "reasoning" || pe.kind === "permission_review",
    );

    if (e.kind === "assistant") {
      if (e.phase === "work") {
        entryClassMap.set(i, "intermediate");
      } else if (e.phase === "final" && !isActiveTurnEntry) {
        entryClassMap.set(i, "final");
        finalTurnStartMap.set(i, myTurnStart);
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
              <div className="mb-1 inline-flex items-center gap-1 rounded bg-message-user-foreground/10 px-1.5 py-0.5 text-[10px] text-message-user-foreground/70" title={t("chatView.queueInjectTitle")}>
                {t("chatView.queueInjectLabel")}
              </div>
            ) : entry.injectHint === "interrupt" ? (
              <div className="mb-1 inline-flex items-center gap-1 rounded bg-message-user-foreground/10 px-1.5 py-0.5 text-[10px] text-message-user-foreground/70" title={t("chatView.interruptTitle")}>
                {t("chatView.interruptLabel")}
              </div>
            ) : null}
            {starActive ? (
              <Star key="active" className="absolute right-2 top-2 h-3 w-3 fill-emphasis text-emphasis lvis-anim-star" />
            ) : null}
            {/* Hide mutating actions in view-mode (read-only slice). */}
            {!viewMode && (
              <div className="absolute right-2 top-2 hidden gap-1 group-hover:flex bg-message-user/95 rounded">
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

      while (i < activeEntries.length) {
        const e = activeEntries[i];
        if (!e) { i++; continue; }
        if ((entryTurnStartMap.get(i) ?? groupTurnStart) !== groupTurnStart) break;
        const cls = entryClassMap.get(i);
        if (cls === "final") break;
        if (e.kind === "reasoning") {
          if (cls === "intermediate") {
            groupRevisions.push(entryRenderRevision({ entry: e, idx: i, searchHighlight, starred: false }));
            groupEntries.push({ idx: i, node: <ReasoningCard key={i} entry={e} embedded /> });
          } else {
            break;
          }
        } else if (e.kind === "permission_review") {
          if (cls === "intermediate") {
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
                <ToolGroupCard key={e.groupId} group={e} sessionId={currentSessionId} hideFailureStatus={hideToolFailures} />
              ) : (
                <Fragment key={e.groupId}>
                  <ToolGroupCard group={e} sessionId={currentSessionId} hideFailureStatus={hideToolFailures} />
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
        rendered.push(<ToolGroupCard key={entry.groupId} group={entry} sessionId={currentSessionId} hideFailureStatus={hideToolFailures} />);
        for (const node of renderSpawnsForGroup(entry)) rendered.push(node);
      } else if (entry.kind === "assistant") {
        rendered.push(
          <div key={idx} data-chat-entry-index={idx} className={ringCls || undefined}>
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
          <div key={idx} data-chat-entry-index={idx} className={`${ringCls} min-w-0 w-full max-w-full overflow-x-hidden rounded-md`}>
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
      rendered.push(<ToolGroupCard key={entry.groupId} group={entry} sessionId={currentSessionId} hideFailureStatus={hideToolFailures} />);
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

  return (
    <div
      className="relative flex min-h-0 min-w-0 w-full flex-1 flex-col overflow-hidden"
      data-testid="chat-view-root"
    >
      {hasApiKey === false && (
        <div className="absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2">
          <Card className="w-[400px]"><CardHeader className="text-center"><KeyRound className="mx-auto mb-2 h-10 w-10 text-muted-foreground" /><CardTitle>{t("chatView.noApiKeyTitle")}</CardTitle><CardDescription>{t("chatView.noApiKeyDescription")}</CardDescription></CardHeader>
            <CardContent className="flex justify-center"><Button onClick={() => onOpenSettings()}><KeyRound className="mr-2 h-4 w-4" />{t("chatView.openSettingsButton")}</Button></CardContent>
          </Card>
        </div>
      )}
      {/* Routine fire + plugin overlay. Routine items stay isolated from chat history; plugin items insert via imported_trigger on confirm. */}
      <OverlayCardRegion
        onPluginPrimaryAction={onPluginPrimaryAction ?? noopPluginPrimaryAction}
        onRoutineAcknowledge={onRoutineAcknowledge}
      />
      <div className="relative min-h-0 min-w-0 max-w-full flex-1 overflow-hidden">
      {/* Checkpoint view-mode banner — sticky at the top of the chat scroll area */}
      <ViewModeBanner viewMode={viewMode} onExit={() => { void handleExitView(); }} />
      {/* Fork-success toast — auto-dismisses after 3 s */}
      {forkToast && (
        <div
          data-testid="fork-toast"
          className="sticky top-0 z-30 mx-3 mt-2 rounded-md border border-[hsl(var(--action-branch)/0.4)] bg-[hsl(var(--action-branch)/0.1)] px-3 py-2 text-xs text-[hsl(var(--action-branch))]"
        >
          {forkToast}
        </div>
      )}
      {/* User-approval memory-hit disclosure toast (#793) — auto-dismisses after 4 s.
          Verdict-tier tint surfaces the trust gradient (CRITICAL 4.1 disclosure):
          - low    → --success (informational, safe re-approval)
          - medium → --warning (moderate risk)
          - high   → --destructive + role="alert" (urgent — user is re-using a high-risk approval)
          Cluster review MAJOR-3 — disclosure surface must be visually distinguishable per tier.
          Uses semantic theme tokens (--success / --warning / --destructive) so bundles
          (tokyo-night / forest / etc.) supply the actual color — the toast adapts. */}
      {userApprovalHitToast && (() => {
        const verdict = userApprovalHitToast.verdictAtApproval;
        const isHigh = verdict === "high";
        const token =
          verdict === "high" ? "destructive"
          : verdict === "medium" ? "warning"
          : "success";
        const tone = `border-[hsl(var(--${token})/0.4)] bg-[hsl(var(--${token})/0.1)] text-[hsl(var(--${token}))]`;
  return (
          <div
            data-testid="user-approval-hit-toast"
            data-verdict={verdict}
            role={isHigh ? "alert" : "status"}
            aria-live={isHigh ? "assertive" : "polite"}
            className={`sticky top-0 z-30 mx-3 mt-2 rounded-md border px-3 py-2 text-xs ${tone}`}
          >
            <span className="font-medium">{t("chatView.approvalMemoryApplied")}</span>
            <span className="ml-2 text-muted-foreground">
              {userApprovalHitToast.toolName} · {userApprovalHitToast.scope === "persistent" ? t("chatView.approvalScopePersistent") : t("chatView.approvalScopeSession")} · {verdict.toUpperCase()}
            </span>
          </div>
        );
      })()}
      {currentSessionKind === "routine" && (
        <div
          data-testid="current-session-kind-banner"
          className="sticky top-0 z-20 mx-3 mt-2 rounded-md border border-action-view/30 bg-action-view/10 px-3 py-2 text-xs text-action-view"
        >
          <span className="font-medium">{t("chatView.routineSessionLabel")}</span>
          {currentSessionTitle ? <span className="ml-2 text-muted-foreground">{currentSessionTitle}</span> : null}
        </div>
      )}
      <ScrollArea type="always" className="lvis-chat-scroll h-full min-h-0 min-w-0 max-w-full" viewportRef={scrollViewportRef}><div className="min-w-0 w-full max-w-full overflow-x-hidden space-y-3 px-3 py-4">
        {/* Today's date badge stays a selector for explicit session loads only.
            currentSessionEntries enables in-session day jumping via
            SessionCalendarPopover Step 4 — pass entries with createdAt + index.
            Reasoning entries never carry createdAt (only user + assistant get
            stamped in historyToEntries / appendUserEntry / finalizeStreamingAssistant),
            so they're excluded from the mapper rather than passed with undefined. */}
        <SessionDateNavigator
          dateKey={activeDayKey}
          sessionMarkerId={currentSessionId}
          sessions={sessions}
          currentSessionId={currentSessionId}
          streaming={streaming}
          currentSessionEntries={navigatorCurrentSessionEntries}
          onJumpToEntry={handleJumpToEntry}
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
        {visibleEntries.length === 0 && hasApiKey === true && !hasAskQuestions && !suggestedRepliesActive && <div className="py-12 text-center text-sm text-muted-foreground">{t("chatView.emptyState")}</div>}
        {transcriptEntries}
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
          {t("chatView.jumpToBottom")}
        </Button>
      )}
      </div>
      {contextOverflowPct >= 0.95 && (
        <div className="flex w-full max-w-full items-center gap-2 border-t bg-destructive/10 px-3 py-1.5 text-xs text-destructive">
          <span className="font-semibold">{t("chatView.contextUsagePercent", { pct: Math.round(contextOverflowPct * 100) })}</span>
          <span>{t("chatView.contextOverflowWarning")}</span>
        </div>
      )}
      {contextOverflowPct >= 0.80 && contextOverflowPct < 0.95 && (
        <div className="flex w-full max-w-full items-center gap-2 border-t bg-warning/15 px-3 py-1.5 text-xs text-warning">
          <span className="font-semibold">{t("chatView.contextUsagePercent", { pct: Math.round(contextOverflowPct * 100) })}</span>
          <span>{t("chatView.contextNearingWarning")}</span>
        </div>
      )}
      {/*
        Issue #900 #1 — per-request TPM (Tokens Per Minute) hint. *Cumulative*
        context-budget 와 별 metric — 작은-tier 모델 (nano 등) 은 단발 input
        이 contextBudget 안이라도 분당 처리 한도 초과로 429 가능. tpmLimit 가
        등록된 모델 (현재 gpt-5.4-nano 만) + 80% 이상 사용 시 표시. 사용자
        영상의 271K nano 사고 patterns 를 사전 경고.
      */}
      {typeof tpmPct === "number" && typeof tpmLimit === "number" && tpmPct >= 0.95 && (
        <div className="flex w-full max-w-full items-center gap-2 border-t bg-destructive/10 px-3 py-1.5 text-xs text-destructive">
          <span className="font-semibold">{t("chatView.tpmUsagePercent", { pct: Math.round(tpmPct * 100), used: usedTokens.toLocaleString(), limit: tpmLimit.toLocaleString() })}</span>
          <span>{t("chatView.tpmOverflowWarning")}</span>
        </div>
      )}
      {typeof tpmPct === "number" && typeof tpmLimit === "number" && tpmPct >= 0.80 && tpmPct < 0.95 && (
        <div className="flex w-full max-w-full items-center gap-2 border-t bg-warning/15 px-3 py-1.5 text-xs text-warning">
          <span className="font-semibold">{t("chatView.tpmUsagePercent", { pct: Math.round(tpmPct * 100), used: usedTokens.toLocaleString(), limit: tpmLimit.toLocaleString() })}</span>
          <span>{t("chatView.tpmNearingWarning")}</span>
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
            onSendNow={handleMessageQueueSendNow}
          />
        </div>
        <div className="w-full max-w-full min-w-0 overflow-x-hidden pb-1 space-y-2">
          <InputActionBar
            plugins={plugins}
            onSelectPlugin={onSelectPlugin}
            onRefreshPlugins={onRefreshPlugins}
            installingPlugins={installingPlugins}
            onOpenMarketplace={onOpenMarketplace}
            marketplaceUrlReady={marketplaceUrlReady}
            onInsertSlashCommand={handleInsertSlashCommand}
            commandActions={commandActions}
            commandPopoverOpen={commandPopoverOpen}
            onCommandPopoverOpenChange={onCommandPopoverOpenChange}
            attachDisabled={
              attachments.length >= ATTACH_MAX_COUNT ||
              hasApiKey === false
            }
            attachDisabledReason={
              hasApiKey === false
                ? "no-api-key"
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
          {/* v6 layout: Composer (textarea) + BottomActionRow (TokenRing/
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
            suggestedReplies={suggestedReplies}
            disabled={
              // Context/TPM red zones stay sendable: main preflight runs
              // compact before the LLM call. Slash commands still bypass
              // API/view UI gates where they are the recovery path.
              (hasApiKey === false || viewMode !== null) &&
              !question.trimStart().startsWith("/")
            }
            onWarning={(msg) => console.warn(msg)}
            placeholder={computeComposerPlaceholder({ hasApiKey, streaming, suggestedReplies })}
          />
          <BottomActionRow
            tokenSlot={tokenSlot}
            isBusy={streaming}
            isSendDisabled={
              (hasApiKey === false || viewMode !== null) &&
              !question.trimStart().startsWith("/")
                ? true
                : question.trim().length === 0 && attachments.length === 0
            }
            onSend={handleBottomSend}
            onCancel={() => {
              // ESC handler 와 동일: 큐를 inject + abort (멈춤 X, 입력으로 inject).
              flushQueueAsUserMessage();
            }}
            />
          </div>
          {/* PermissionModeBadge + DeferredApprovalChip 모두
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
  const parts = KOREA_DATE_KEY_FORMATTER.formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}
