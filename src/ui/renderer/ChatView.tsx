import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "../../i18n/react.js";
import { ChevronDown, KeyRound, PanelRightOpen } from "lucide-react";
import { Button } from "../../components/ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card.js";
import { isDebugStreamEnabled } from "../../lib/debug-stream.js";
import { OverlayCardRegion } from "./components/OverlayCardRegion.js";
import { ViewModeBanner, type ViewModeState } from "./components/ViewModeBanner.js";
import { SubAgentCard } from "./components/SubAgentCard.js";
import { TokenProgressRing } from "./components/TokenProgressRing.js";
import { type StatusBarProps } from "./components/StatusBar.js";
import { ChatPreviewRail } from "./components/ChatPreviewRail.js";
// TurnSummaryFooter 컴포넌트는 2026-05-07 폐기. 토큰 정보는 TurnActionBar 의
// TokenCostBadge (provider-truth, 토글 + tooltip breakdown) 가 단일 source 로
// 표시. 시간 정보는 WorkGroup 헤더의 ⏱ T 가 흡수. turn_summary entry 는
// 데이터 carrier 로 history 에 남고, lookup 으로 두 surface 에 공급.
import { getApi } from "./api-client.js";
import { useChatContext } from "./context/ChatContext.js";
import type { AppMode } from "./MainToolbar.js";
import { useInputStatusRow } from "./hooks/use-input-status-row.js";
import { type ComposerHandle } from "./components/Composer.js";
import { useSuggestedReplies } from "./hooks/use-suggested-replies.js";
import { hasActiveSuggestedReplies } from "./utils/composer-placeholder.js";
import type { PluginEntry } from "./components/PluginGridButton.js";
import type { QuickAction } from "./components/CommandPopover.js";
import { type AskUserQuestionRequest } from "./components/AskUserQuestionCard.js";
import type { LvisApi } from "./types.js";
import type { SubAgentSpawn } from "./components/SubAgentCard.js";
import type { SkillBadgeProps } from "./components/SkillBadge.js";
import type { SessionSummary } from "./hooks/use-sessions.js";
import type { UserKeyboardIntentSnapshot } from "../../shared/chat-origin.js";
import { getKoreaDateKey } from "./utils/korea-date-key.js";
import { isTurnStartEntry } from "./utils/classify-turn-entries.js";
import { collectChatPreviewModel } from "./preview/preview-targets.js";
import { useChatScroll } from "./hooks/use-chat-scroll.js";
import { usePermissionToasts } from "./hooks/use-permission-toasts.js";
import { useCheckpointView } from "./hooks/use-checkpoint-view.js";
import { useMessageQueue } from "./hooks/use-message-queue.js";
import { useAttachmentPicker } from "./hooks/use-attachment-picker.js";
import { useTranscriptEntries, type TurnSummary } from "./hooks/use-transcript-entries.js";
import { ChatTranscript } from "./components/ChatTranscript.js";
import { ChatComposerDock } from "./components/ChatComposerDock.js";

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
  /** Plugin list — surfaced inside the SlashPicker's plugin category. */
  plugins: PluginEntry[];
  /** Navigate to a plugin view */
  onSelectPlugin: (viewKey: string) => void;
  /** Workspace mode; chat mode compacts the footer model label. */
  appMode?: AppMode;
  /** Opens the deferred approval queue dialog from the footer approval count. */
  onOpenApprovalQueue?: () => void;
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
  // Fork-based revert is replaced by the same-session checkpoint chain.
  // sessionId remains stable until the user explicitly branches from a checkpoint.
  /** Called when user confirms a plugin overlay item; id is the OverlayItem.id. */
  onPluginPrimaryAction?: (overlayItemId: string) => void;
  /** Called when a completed routine overlay result has been seen or dismissed. */
  onRoutineAcknowledge?: (routineId: string, firedAt: string) => void;
  /** Toast surface rendered directly above the composer input. */
  statusBar?: StatusBarProps;
  /** Constrain transcript and composer to a centered reading column. */
  blogLayout?: boolean;
}

export function ChatView({ api, onAsk, onEditSave, onFork, onToggleStar, onRetryEffort, onContinueFromLastUser, isEntryStarred, onAbort, onGuide, onGuideError, onFeedback, subAgentSpawns, loadedSkills, hasAskQuestions, askQuestions, onResolveAskQuestion, plugins, onSelectPlugin, appMode = "work", onOpenApprovalQueue, currentSessionKind = "main", currentSessionTitle, sessions, onLoadSession, onRefreshSessions, commandActions, commandPopoverOpen, onCommandPopoverOpenChange, onPluginPrimaryAction, onRoutineAcknowledge, statusBar, blogLayout = false }: ChatViewProps) {
  const { t } = useTranslation();
  // We still need the api for SessionTodoPanel; obtain it via singleton.
  const workflowApi = getApi();
  const debugStreamEnabled = isDebugStreamEnabled();
  const composerRef = useRef<ComposerHandle | null>(null);
  const suggestedReplies = useSuggestedReplies();
  const suggestedRepliesActive = hasActiveSuggestedReplies(suggestedReplies);
  const readingColumnClass = blogLayout
    ? "mx-auto w-full max-w-[58rem] px-6 lg:px-8"
    : "w-full max-w-full px-4";
  const dockColumnClass = blogLayout
    ? "mx-auto w-full max-w-[58rem] min-w-0"
    : "w-full max-w-full min-w-0";
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

  // Checkpoint view-mode — null = live, non-null = viewing a past checkpoint
  // slice. Owned at the composition root because it is read by useChatScroll
  // (auto-scroll suppression) + transcript slicing, and written by
  // useCheckpointView (setViewMode).
  const [viewMode, setViewMode] = useState<ViewModeState | null>(null);

  // User-approval memory-hit (#793) + permission review suggestion disclosure
  // toasts — IPC subscriptions + auto-dismiss timers + enable action.
  const {
    userApprovalHitToast,
    permissionReviewSuggestion,
    handleEnablePermissionReviewSuggestion,
  } = usePermissionToasts();

  // In view-mode, show only the sliced entries up to the checkpoint.
  const visibleEntries = useMemo(
    () => viewMode ? entries.slice(0, viewMode.slicedRangeEnd) : entries,
    [entries, viewMode],
  );
  const previewModel = useMemo(
    () => collectChatPreviewModel({ entries: visibleEntries, attachments }),
    [attachments, visibleEntries],
  );
  const hasPreviewArtifacts = previewModel.targets.length > 0 || previewModel.files.length > 0;
  const previewTargetIdKey = useMemo(
    () => previewModel.targets.map((target) => target.id).join("\u0001"),
    [previewModel.targets],
  );
  const [previewRailOpen, setPreviewRailOpen] = useState(false);
  const [selectedPreviewId, setSelectedPreviewId] = useState<string | null>(null);
  const previewRailVisible = previewRailOpen && hasPreviewArtifacts;

  useEffect(() => {
    setSelectedPreviewId(null);
  }, [currentSessionId]);

  useEffect(() => {
    if (!hasPreviewArtifacts) {
      setPreviewRailOpen(false);
      setSelectedPreviewId(null);
    }
  }, [hasPreviewArtifacts]);

  useEffect(() => {
    if (previewModel.targets.length === 0) {
      setSelectedPreviewId(null);
      return;
    }
    if (selectedPreviewId && previewModel.targets.some((target) => target.id === selectedPreviewId)) return;
    setSelectedPreviewId(previewModel.targets[0]?.id ?? null);
  }, [previewModel.targets, previewTargetIdKey, selectedPreviewId]);

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

  const { scrollViewportRef, showJumpToBottom, scrollChatToBottom, handleJumpToEntry } = useChatScroll({
    entries,
    currentSessionId,
    chatEndRef,
    viewMode,
    searchOpen,
    searchMatches,
    searchIdx,
  });

  const handleCalendarSessionSelect = useCallback(async (sessionId: string) => {
    await onLoadSession?.(sessionId);
  }, [onLoadSession]);

  // Checkpoint view-mode handlers + fork-success toast (depends on the scroll
  // hook's scrollChatToBottom).
  const { forkToast, handleEnterView, handleExitView, handleBranchFrom } = useCheckpointView({
    api,
    currentSessionId,
    entries,
    streaming,
    hasActiveStreamingEntry,
    onLoadSession,
    onContinueFromLastUser,
    setViewMode,
    scrollChatToBottom,
  });

  // Mid-turn message queue — per-view store + dev/e2e window hook + stream
  // brake-point drains + composer/streaming keyboard flows (Enter morph, ESC
  // inject-or-abort, ⌘⏎ immediate inject, ⌘K guide).
  const {
    messageQueueStore,
    handleComposerSend,
    handleMessageQueueSendNow,
    flushQueueAsUserMessage,
  } = useMessageQueue({
    api,
    currentSessionId,
    question,
    attachments,
    streaming,
    setQuestion,
    setAttachments,
    onAsk,
    onGuide,
    onGuideError,
    onAbort,
  });

  const handleInsertSlashCommand = useCallback((cmd: string) => {
    setQuestion((prev) => (prev ? `${prev}${cmd} ` : `${cmd} `));
  }, [setQuestion]);

  const noopPluginPrimaryAction = useCallback(() => {}, []);

  const handleBottomSend = useCallback(() => {
    handleComposerSend({ inputOrigin: "user-keyboard", token: "" });
  }, [handleComposerSend]);

  // Attach picker — native file dialog + atomic flushSync commit + 5-cap.
  const { handleAttach } = useAttachmentPicker({
    attachmentNCounter,
    setAttachments,
    setQuestion,
    composerRef,
  });

  // Token progress ring — square, hover=percent, click=detail. The former
  // sibling cost badge is gone: the cost/amount now lives INSIDE the ring's
  // click-detail popover (a single flat surface), so the action row carries
  // only the ring itself.
  const ringSlot = useMemo(() => (
    <TokenProgressRing
      used={usedTokens}
      budget={effectiveBudget}
      contextBudget={contextBudget}
      tpmLimit={tpmLimit}
      costEstimate={costEstimate}
      costClass={costBadgeClass}
    />
  ), [contextBudget, costBadgeClass, costEstimate, effectiveBudget, tpmLimit, usedTokens]);

  // Status sub-row (in the unified InputActionBar) — model / permission /
  // active state. Resolved from the same IPC the former window-StatusBar
  // producers used; the window StatusBar is notifications-only now.
  const inputStatusRow = useInputStatusRow(api);
  // The token-context percent is no longer surfaced as a separate text cell in
  // the status sub-row — the TokenProgressRing (which now lives at the end of
  // that row) renders the % / cost detail on hover/click.
  const onOpenModelSettings = useCallback(() => onOpenSettings("llm"), [onOpenSettings]);
  const onOpenInputPermissions = useCallback(() => onOpenSettings("permissions"), [onOpenSettings]);

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

  const transcriptEntries = useTranscriptEntries({
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
  });

  return (
    <div
      className={`relative flex min-h-0 min-w-0 w-full flex-1 flex-col overflow-hidden ${
        previewRailVisible ? "lg:pr-96" : ""
      }`}
      data-testid="chat-view-root"
    >
      {hasApiKey === false && (
        <div className="absolute inset-x-4 top-1/2 z-10 flex -translate-y-1/2 justify-center">
          <Card className="w-full max-w-[400px]"><CardHeader className="text-center"><KeyRound className="mx-auto mb-2 h-10 w-10 text-muted-foreground" /><CardTitle>{t("chatView.noApiKeyTitle")}</CardTitle><CardDescription>{t("chatView.noApiKeyDescription")}</CardDescription></CardHeader>
            <CardContent className="flex justify-center"><Button onClick={() => onOpenSettings()}><KeyRound className="mr-2 h-4 w-4" />{t("chatView.openSettingsButton")}</Button></CardContent>
          </Card>
        </div>
      )}
      {/* Routine fire + plugin overlay. Routine items stay isolated from chat history; plugin items insert via imported_trigger on confirm. */}
      <OverlayCardRegion
        onPluginPrimaryAction={onPluginPrimaryAction ?? noopPluginPrimaryAction}
        onRoutineAcknowledge={onRoutineAcknowledge}
      />
      {previewRailVisible && (
        <button
          type="button"
          className="absolute inset-0 z-30 bg-background/(--opacity-strong) backdrop-blur-[1px] lg:hidden"
          aria-label={t("chatPreviewRail.close")}
          onClick={() => {
            setPreviewRailOpen(false);
          }}
        />
      )}
      <div className="relative min-h-0 min-w-0 max-w-full flex-1 overflow-hidden">
      <div className="grid h-full min-h-0 min-w-0 grid-cols-1">
      <div className="relative min-h-0 min-w-0 overflow-hidden">
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
      {permissionReviewSuggestion && (
        <div
          data-testid="permission-review-suggestion-toast"
          role="status"
          aria-live="polite"
          className="sticky top-0 z-30 mx-3 mt-2 flex min-w-0 items-center gap-2 rounded-md border border-[hsl(var(--warning)/0.4)] bg-[hsl(var(--warning)/0.1)] px-3 py-2 text-xs text-[hsl(var(--warning))]"
        >
          <div className="min-w-0 flex-1">
            <span className="font-medium">{t("chatView.permissionReviewSuggestionTitle")}</span>
            <span className="ml-2 text-muted-foreground">
              {permissionReviewSuggestion.reason === "allow-always"
                ? t("chatView.permissionReviewSuggestionAllowAlways")
                : t("chatView.permissionReviewSuggestionRepeat", {
                    count: permissionReviewSuggestion.allowCount,
                    minutes: Math.max(1, Math.round(permissionReviewSuggestion.windowMs / 60000)),
                  })}
            </span>
            {permissionReviewSuggestion.error && (
              <span className="ml-2 text-[hsl(var(--destructive))]">
                {permissionReviewSuggestion.error}
              </span>
            )}
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 shrink-0 px-2 text-xs"
            disabled={permissionReviewSuggestion.busy === true}
            onClick={() => void handleEnablePermissionReviewSuggestion()}
          >
            {permissionReviewSuggestion.busy === true
              ? t("chatView.permissionReviewSuggestionBusy")
              : t("chatView.permissionReviewSuggestionAction")}
          </Button>
        </div>
      )}
      {currentSessionKind === "routine" && (
        <div
          data-testid="current-session-kind-banner"
          className="sticky top-0 z-20 mx-3 mt-2 rounded-md border border-action-view/(--opacity-muted) bg-action-view/(--opacity-subtle) px-3 py-2 text-xs text-action-view"
        >
          <span className="font-medium">{t("chatView.routineSessionLabel")}</span>
          {currentSessionTitle ? <span className="ml-2 text-muted-foreground">{currentSessionTitle}</span> : null}
        </div>
      )}
      {hasPreviewArtifacts && !previewRailOpen && (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="lvis-surface-raised absolute right-5 top-4 z-30 h-8 rounded-full bg-card/(--opacity-solid) px-3 text-xs backdrop-blur"
          title={t("chatPreviewRail.open")}
          aria-label={t("chatPreviewRail.open")}
          onClick={() => {
            setPreviewRailOpen(true);
          }}
          data-testid="chat-preview-open"
        >
          <PanelRightOpen className="mr-1 h-3.5 w-3.5" />
          {t("chatPreviewRail.openShort", { count: previewModel.targets.length })}
        </Button>
      )}
      <ChatTranscript
        scrollViewportRef={scrollViewportRef}
        readingColumnClass={readingColumnClass}
        activeDayKey={activeDayKey}
        currentSessionId={currentSessionId}
        sessions={sessions}
        streaming={streaming}
        navigatorCurrentSessionEntries={navigatorCurrentSessionEntries}
        onJumpToEntry={handleJumpToEntry}
        onLoadSession={handleCalendarSessionSelect}
        onRefreshSessions={onRefreshSessions}
        loadedSkills={loadedSkills}
        orphanSpawns={orphanSpawns}
        visibleEntries={visibleEntries}
        hasApiKey={hasApiKey}
        hasAskQuestions={hasAskQuestions}
        suggestedRepliesActive={suggestedRepliesActive}
        transcriptEntries={transcriptEntries}
        chatEndRef={chatEndRef}
      />
      {showJumpToBottom && (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="lvis-surface-raised absolute bottom-4 right-5 z-20 h-8 rounded-full bg-card/(--opacity-solid) px-3 text-xs backdrop-blur"
          onClick={() => scrollChatToBottom("smooth")}
          data-testid="jump-to-bottom"
        >
          <ChevronDown className="mr-1 h-3.5 w-3.5" />
          {t("chatView.jumpToBottom")}
        </Button>
      )}
      </div>
      </div>
      </div>
      {contextOverflowPct >= 0.95 && (
        <div className="flex w-full max-w-full items-center gap-2 border-t bg-destructive/(--opacity-subtle) px-3 py-1.5 text-xs text-destructive">
          <span className="font-semibold">{t("chatView.contextUsagePercent", { pct: Math.round(contextOverflowPct * 100) })}</span>
          <span>{t("chatView.contextOverflowWarning")}</span>
        </div>
      )}
      {contextOverflowPct >= 0.80 && contextOverflowPct < 0.95 && (
        <div className="flex w-full max-w-full items-center gap-2 border-t bg-warning/(--opacity-soft) px-3 py-1.5 text-xs text-warning">
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
        <div className="flex w-full max-w-full items-center gap-2 border-t bg-destructive/(--opacity-subtle) px-3 py-1.5 text-xs text-destructive">
          <span className="font-semibold">{t("chatView.tpmUsagePercent", { pct: Math.round(tpmPct * 100), used: usedTokens.toLocaleString(), limit: tpmLimit.toLocaleString() })}</span>
          <span>{t("chatView.tpmOverflowWarning")}</span>
        </div>
      )}
      {typeof tpmPct === "number" && typeof tpmLimit === "number" && tpmPct >= 0.80 && tpmPct < 0.95 && (
        <div className="flex w-full max-w-full items-center gap-2 border-t bg-warning/(--opacity-soft) px-3 py-1.5 text-xs text-warning">
          <span className="font-semibold">{t("chatView.tpmUsagePercent", { pct: Math.round(tpmPct * 100), used: usedTokens.toLocaleString(), limit: tpmLimit.toLocaleString() })}</span>
          <span>{t("chatView.tpmNearingWarning")}</span>
        </div>
      )}
      {/* Assistant todo panel — anchored above the input cluster, below the
          chat scroll area. Stays visible regardless of where the user has
          scrolled the chat. The panel collapses by default once it has
          content; in the collapsed state the active item title streams next
          to the count so the user always sees what step is running. */}
      {/* Composer dock — seamless. No opaque background (the outer fill behind
          the composer box was clipping the floating sidebar's drop shadow) and
          no top border seam: the dock now blends into the bg-background content
          surface, so there is no hard line / pink bar between the messages and
          the composer. The composer box (border + bg-input-bar) still reads as a
          distinct surface on its own. */}
      <ChatComposerDock
        dockColumnClass={dockColumnClass}
        workflowApi={workflowApi}
        api={api}
        currentSessionId={currentSessionId}
        messageQueueStore={messageQueueStore}
        onMessageQueueSendNow={handleMessageQueueSendNow}
        question={question}
        statusBar={statusBar}
        composerRef={composerRef}
        setQuestion={setQuestion}
        attachments={attachments}
        setAttachments={setAttachments}
        attachmentNCounter={attachmentNCounter}
        onComposerSend={handleComposerSend}
        suggestedReplies={suggestedReplies}
        commandActions={commandActions}
        plugins={plugins}
        onSelectPlugin={onSelectPlugin}
        hasApiKey={hasApiKey}
        viewMode={viewMode}
        streaming={streaming}
        onInsertSlashCommand={handleInsertSlashCommand}
        commandPopoverOpen={commandPopoverOpen}
        onCommandPopoverOpenChange={onCommandPopoverOpenChange}
        ringSlot={ringSlot}
        onAttach={handleAttach}
        rolePresets={rolePresets}
        activePreset={activePreset}
        activePresetId={activePresetId}
        onSelectPreset={setActivePresetId}
        onBottomSend={handleBottomSend}
        onCancel={flushQueueAsUserMessage}
        enableThinkingChat={enableThinkingChat}
        onToggleThinking={toggleThinking}
        inputStatusRow={inputStatusRow}
        appMode={appMode}
        onOpenModelSettings={onOpenModelSettings}
        onOpenPermissions={onOpenInputPermissions}
        onOpenApprovalQueue={onOpenApprovalQueue}
        askQuestions={askQuestions}
        onResolveAskQuestion={onResolveAskQuestion}
      />
      {previewRailVisible ? (
        <ChatPreviewRail
          api={api}
          sessionId={currentSessionId}
          targets={previewModel.targets}
          files={previewModel.files}
          selectedId={selectedPreviewId}
          onSelect={setSelectedPreviewId}
          onClose={() => {
            setPreviewRailOpen(false);
          }}
          className="absolute inset-y-0 right-0 z-50 flex w-[min(24rem,calc(100%-1rem))] shadow-2xl lg:w-96 lg:shadow-none"
        />
      ) : null}
    </div>
  );
}
