import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { debugLog } from "../../lib/debug-stream.js";
import { composeOutgoing as composeOutgoingUtil } from "./utils/compose.js";
import { vendorSupportsThinking as vendorSupportsThinkingShared } from "../../shared/vendor-capabilities.js";
import { supportsVision } from "../../engine/llm/vendor-capabilities.js";
import { TooltipProvider } from "../../components/ui/tooltip.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { ThemeProvider } from "./theme/index.js";

// ─── Phase 2 split: types / constants / helpers / components / tabs ──
import { getApi, getPluginViewLabel, toViewKey } from "./api-client.js";
import type { PluginEntry } from "./components/PluginGridButton.js";
import { ApprovalDialog } from "./dialogs/ApprovalDialog.js";
import { ApprovalQueueStatus } from "./components/ApprovalQueueStatus.js";
import { GlobalSearchDialog } from "./dialogs/GlobalSearchDialog.js";
import { buildQuickActions } from "./components/CommandPopover.js";
import { MainToolbar } from "./MainToolbar.js";
import { MainContent } from "./MainContent.js";
import { Sidebar } from "./Sidebar.js";
import { SettingsDialog } from "./SettingsDialog.js";
import { StatusBar } from "./components/StatusBar.js";
import { useStatusBar, type NotificationToastMeta } from "./hooks/use-status-bar.js";
import { useSettings } from "./hooks/use-settings.js";
import { useChatState } from "./hooks/use-chat-state.js";
import { useRoutineResult } from "./hooks/use-routine-result.js";
import { useRoutineRunning } from "./hooks/use-routine-running.js";
import { useTriggerResult } from "./hooks/use-trigger-result.js";
import { useApproval } from "./hooks/use-approval.js";
import { useSearch } from "./hooks/use-search.js";
import { useContextBudget } from "./hooks/use-context-budget.js";
import { useCostEstimate } from "./hooks/use-cost-estimate.js";
import { useStarred } from "./hooks/use-starred.js";
import { useSessions } from "./hooks/use-sessions.js";
import { useMarketplaceUpdates } from "./hooks/use-marketplace-updates.js";
import { useBootstrapStatus } from "./hooks/use-bootstrap-status.js";
import { MarketplaceUpdateBanner } from "./components/MarketplaceUpdateBanner.js";
import { BootstrapStatusBanner } from "./components/BootstrapStatusBanner.js";
import { DevConsoleToggle } from "./components/DevConsoleToggle.js";
import { DropZoneOverlay } from "./components/DropZoneOverlay.js";
import { SnapEdgeHighlight } from "./components/SnapEdgeHighlight.js";
import { usePluginMarketplace } from "./hooks/use-plugin-marketplace.js";
import { usePluginAuthStatuses } from "./hooks/use-plugin-auth-status.js";
import type { Attachment } from "./types/attachments.js";
import { useRolePresets } from "./hooks/use-role-presets.js";
import { useAppBootstrap } from "./hooks/use-app-bootstrap.js";
import { useChatActions } from "./hooks/use-chat-actions.js";
import { useChatContextValue } from "./hooks/use-chat-context-value.js";
import { CustomTitleBar } from "./components/CustomTitleBar.js";
import { useWorkflowTools } from "./hooks/use-workflow-tools.js";
import { useInstallingPlugins } from "./hooks/use-installing-plugins.js";
import { useMarketplaceUrl } from "./hooks/use-marketplace-url.js";

// RoutineCard: new routine result card
export { RoutineCard } from "./components/RoutineCard.js";

// ─── App ────────────────────────────────────────────

export function App() {
  const api = useMemo(() => getApi(), []);

  // Workflow tools (S1+S2) — lifted to App level so FloatingQuestionPanel
  // survives sidebar navigation (question state persists across view changes).
  const {
    askQuestions,
    subAgentSpawns,
    loadedSkills,
    dismissAskQuestion,
    resetForNewSession,
  } = useWorkflowTools(api);

  // Chat state + stream lifecycle (useChatState is the sole owner of entries).
  const {
    entries, streaming, beginStreamingRequest, finishStreamingRequest, editingEntryIdx, setEditingEntryIdx, editBusy,
    entryIndexToHistoryIndex, handleEditSave, handleRetryEffort,
    resetStreamAccumulators, setErrorWithThought, handleCompactCommand,
    clearForNewChat, appendUserEntry, applyInitialSession, applyLoadedSession, truncateToEntry,
    addImportedTriggerEntry, closeOpenImportedTrigger,
    fallbackToast,
  } = useChatState(api);
  const [question, setQuestion] = useState("");
  const chatEndRef = useRef<HTMLDivElement>(null);
  const turnRequestRef = useRef(0);

  // App state
  const [hasApiKey, setHasApiKey] = useState<boolean | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [activeView, setActiveView] = useState("home");
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
  const [commandPopoverOpen, setCommandPopoverOpen] = useState(false);
  const {
    routineResult,
    routineQueueIndex,
    routineQueueTotal,
    dismiss: dismissRoutineResult,
    snooze: snoozeRoutineResult,
    goPrev: prevRoutineResult,
    goNext: nextRoutineResult,
  } = useRoutineResult(api);
  const { runningRoutines } = useRoutineRunning(api);
  const { triggerResult, dismiss: dismissTrigger, importIntoChat: importTriggerIntoChat } = useTriggerResult(api);
  const { updates: marketplaceUpdates, dismiss: dismissMarketplaceUpdates } = useMarketplaceUpdates(api);
  const { status: bootstrapStatus, dismiss: dismissBootstrapStatus, retry: retryBootstrap } = useBootstrapStatus(api);
  const { queue: approvalQueue, decide: handleApprovalDecide, decideAll: handleApprovalDecideAll } = useApproval();

  // Marketplace + plugin UI extensions
  const {
    pluginViews,
    pluginCards,
    installPlugin,
    refreshViews, refreshMarketplace, refreshCards,
  } = usePluginMarketplace(api);

  // Auth status for every plugin that declares `manifest.auth`
  // (architecture.md §9.4a). Drives the 미인증 badge in both Settings →
  // 플러그인 설정 (PluginConfigTab) and the chat-input plugin grid
  // (PluginGridButton). Hoisting to App.tsx means a single live-poll
  // + event-bridge subscription serves both surfaces — no duplicate
  // listeners, no stale-state divergence between the two views.
  const { statuses: pluginAuthStatuses } = usePluginAuthStatuses(api, pluginCards);

  // Sprint B — role preset, cost preview, multimodal attachments
  const { rolePresets, activePreset, activePresetId, setActivePresetId } = useRolePresets();
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  // Strictly increasing N — never reassigned even after attachment removal so
  // textarea markers ([Image #N]) keep referring to the same payload.
  const attachmentNCounter = useRef(0);
  const [maxOutputTokens] = useState<number>(4096);

  // Search / starred / sessions
  const {
    open: searchOpen, query: searchQuery, caseSensitive: searchCase,
    matches: searchMatches, matchSet: searchMatchSet, matchIdx: searchIdx, highlight: searchHighlight,
    changeQuery: searchChangeQuery, toggleCase: searchToggleCase,
    toggleOverlay: searchToggleOverlay, closeOverlay: searchCloseOverlay,
    nextMatch: searchNext, prevMatch: searchPrev,
  } = useSearch(entries);
  const {
    starred,
    refreshStarred,
    isEntryStarred: starredIsEntry,
    handleToggleStar: starredToggle,
    isSessionStarred,
    handleToggleSessionStar,
  } = useStarred(api);
  const {
    currentSessionId, sessions, refreshSessionId, refreshSessions,
    handleLoadSession: sessionLoad, handleFork: sessionFork,
  } = useSessions(api, applyInitialSession);

  // Small adapter callbacks that bridge hook outputs to ChatView / MainToolbar.
  const {
    handleLoadSession, isEntryStarred, handleFork, handleToggleStar,
    handleAbort, handleFeedback, handleExport,
  } = useChatActions({
    api, streaming, currentSessionId, entries, entryIndexToHistoryIndex,
    applyLoadedSession, truncateToEntry, sessionLoad, sessionFork,
    starredIsEntry, starredToggle,
  });

  // LLM settings + context budget (single source of truth: src/shared/pricing-data.ts)
  const { llmVendor, llmModel, enableThinkingChat, refresh: refreshLlmSettings, toggleThinking } = useSettings(api);

  const { usedTokens, contextBudget, contextOverflowPct } =
    useContextBudget({ entries, llmVendor, llmModel });

  const activePluginView = useMemo(() => pluginViews.find((i) => toViewKey(i) === activeView), [pluginViews, activeView]);

  // Build flat PluginEntry list for InputActionBar plugin grid.
  // `unauthed` is set when the owning plugin declares `manifest.auth` AND its
  // current statusTool result is `kind: "unauthed"`. The grid renders a
  // small 🔒 indicator on those entries so users see the missing-auth state
  // without first opening Settings.
  const pluginEntries = useMemo<PluginEntry[]>(
    () =>
      pluginViews.map((view) => ({
        viewKey: toViewKey(view),
        pluginId: view.pluginId,
        label: getPluginViewLabel(view),
        icon: view.icon,
        unauthed: pluginAuthStatuses.get(view.pluginId)?.kind === "unauthed",
      })),
    [pluginViews, pluginAuthStatuses],
  );

  // Track in-flight plugin installs for the grid overlay spinner.
  const installingPlugins = useInstallingPlugins(api);

  // Marketplace URL — sourced from settings (marketplace.realCloudBaseUrl).
  const { marketplaceUrl, loaded: marketplaceUrlLoaded } = useMarketplaceUrl(api);
  // Ready only when settings have been fetched AND the URL is non-empty.
  const marketplaceUrlReady = marketplaceUrlLoaded && marketplaceUrl.length > 0;

  // Open marketplace in the system browser.
  // Guard against an empty URL during the initial settings load — calling
  // shell.openExternal("") produces undefined behaviour on some platforms.
  const onOpenMarketplace = useCallback(() => {
    if (!marketplaceUrlReady) return;
    void api.openExternalUrl(marketplaceUrl);
  }, [api, marketplaceUrl, marketplaceUrlReady]);

  const openDetachedPluginView = useCallback(
    async (viewKey: string): Promise<boolean> => {
      const openDetached = api.window?.openDetached;
      if (!openDetached) {
        setErrorWithThought("오류: 플러그인 창을 열 수 없습니다.");
        return false;
      }
      const result = await openDetached(viewKey);
      if (!result.ok) {
        console.warn(`[plugin-ui] detached plugin view ${viewKey} did not open`, result.error);
        setErrorWithThought(`오류: 플러그인 창을 열 수 없습니다. ${result.error}`);
        return false;
      }
      return true;
    },
    [api, setErrorWithThought],
  );

  // When a plugin view declares `window.defaultMode: "detached"`, a sidebar
  // click opens it in a separate magnetic-snap BrowserWindow instead of
  // switching the main window's active view.
  //
  // If the owning plugin declares `manifest.auth` AND its current state is
  // unauthed, embedded views invoke loginTool before navigating. Detached
  // views open directly so plugin-owned login UIs can collect their own
  // credentials through the plugin surface instead of the host calling
  // loginTool with no arguments.
  const handleSidebarSelect = useCallback(
    (key: string) => {
      if (key.startsWith("plugin:")) {
        const view = pluginViews.find((v) => toViewKey(v) === key);
        if (!view) return;
        const isDetachedView = view.extension.window?.defaultMode === "detached";
        if (isDetachedView) {
          void openDetachedPluginView(key);
          return;
        }

        const status = pluginAuthStatuses.get(view.pluginId);
        const card = pluginCards.find((c) => c.id === view.pluginId);
        const loginTool = card?.auth?.loginTool;
        // Race guard: status arrives via one IPC, pluginCards via another.
        // If status says "unauthed" but the cards haven't populated yet
        // (`card` undefined → `loginTool` undefined), navigating now would
        // strand the user on the broken-unauthed view — exactly what the
        // PR aimed to prevent. Abort silently; the user can click again
        // once the cards arrive (badge keeps prompting them).
        if (status?.kind === "unauthed" && !loginTool) {
          console.warn(
            `[plugin-auth] ${view.pluginId} unauthed but pluginCards not yet loaded — aborting click`,
          );
          return;
        }
        if (status?.kind === "unauthed" && loginTool) {
          void (async () => {
            try {
              await api.callPluginMethod(loginTool);
            } catch (err) {
              // User cancelled / IPC rejected — leave them on the current
              // view, do NOT navigate to the still-unauthed plugin view.
              // Cancellation is a normal user choice, not an error: log
              // at warn so renderer DevTools doesn't paint it red.
              console.warn(
                `[plugin-auth] ${view.pluginId} loginTool ${loginTool} did not complete (cancelled or IPC rejected)`,
                err,
              );
              return;
            }
            // Login resolved — navigate to the view the user originally
            // wanted. The `<pluginId>.auth.changed` event will flip the
            // badge separately via the live-poll path.
            setActiveView(key);
          })();
          return;
        }
      }
      setActiveView(key);
    },
    [api, pluginViews, pluginAuthStatuses, pluginCards, openDetachedPluginView],
  );

  // If the currently-open sidebar view belongs to a plugin that just got
  // uninstalled, fall back to home so the renderer doesn't render a "view
  // not found" placeholder for a stale plugin id.
  useEffect(() => {
    if (!activeView.startsWith("plugin:")) return;
    if (activePluginView) return;
    setActiveView("home");
  }, [activeView, activePluginView]);
  const checkApiKey = useCallback(async () => { const h = await api.hasApiKey(); setHasApiKey(h); return h; }, [api]);
  const vendorSupportsThinking = useMemo(() => vendorSupportsThinkingShared(llmVendor, llmModel), [llmVendor, llmModel]);
  const composeOutgoing = useCallback(
    (raw: string) => composeOutgoingUtil({ raw, activePreset, attachments }),
    [activePreset, attachments],
  );

  const handleAsk = useCallback(
    async (
      q: string,
      mode: "default" | "guidance" | "trigger-import" = "default",
    ) => {
      debugLog("handleAsk", "enter", { mode, qLen: q.length, streaming });
      const t = q.trim();
      if (!t) {
        debugLog("handleAsk", "skip:empty");
        return;
      }
      if (mode === "default" && streaming) {
        debugLog("handleAsk", "skip:already-streaming");
        return;
      }
      if (mode === "default" && await handleCompactCommand(t)) {
        debugLog("handleAsk", "skip:compact-command-handled");
        return;
      }
      if (mode === "default" && (t === "/load" || t.startsWith("/load "))) {
        const requested = t.slice("/load".length).trim();
        if (requested.length === 0) {
          setErrorWithThought("사용법: /load <세션ID>");
          return;
        }
        const listed = await api.chatSessions();
        const match = listed.sessions.find((session) => session.id.startsWith(requested));
        if (!match) {
          setErrorWithThought(`세션을 찾을 수 없습니다: ${requested}`);
          return;
        }
        await sessionLoad(match.id, false, applyLoadedSession);
        await refreshSessionId();
        await refreshSessions();
        debugLog("handleAsk", "load-session:handled", { sessionId: match.id });
        return;
      }
      if (!(await checkApiKey())) { setSettingsOpen(true); return; }
      const requestId = ++turnRequestRef.current;
      const streamingRequestId = beginStreamingRequest();
      debugLog("handleAsk", "begin", { requestId, streamingRequestId });
      setQuestion("");
      // trigger-import: send the wrapped prompt verbatim. composeOutgoing
      // would prefix it with role-preset / language-lock framing that
      // doesn't apply to brain-authored prompts. The brain envelope and
      // the system prompt's `<proactive-origin-guidance>` already steer
      // the LLM correctly.
      const composed =
        mode === "trigger-import"
          ? { text: t, attachments: [] }
          : composeOutgoing(t);
      const outgoing = composed.text;
      let outgoingAttachments = composed.attachments;
      // Vendor vision capability gate. The composer accepts images
      // regardless of the active model so the user can switch models
      // freely; check at send time and confirm before silently dropping
      // image parts on a text-only model.
      const hasImageParts = outgoingAttachments.some((p) => p.type === "image");
      if (mode !== "trigger-import" && hasImageParts && !supportsVision(llmVendor, llmModel)) {
        const proceed = window.confirm(
          `현재 모델(${llmModel})은 이미지를 지원하지 않습니다.\n` +
            "이미지는 전달되지 않고 파일 경로 / 텍스트만 전송됩니다.\n\n" +
            "그래도 전송하시겠습니까? 취소하면 모델을 바꾼 뒤 다시 시도할 수 있습니다.",
        );
        if (!proceed) {
          // Restore the original (untrimmed) draft text so the user can
          // switch models and resend without retyping. We use `q` rather
          // than `t = q.trim()` to preserve any intentional leading /
          // trailing whitespace or newlines the user typed. setQuestion("")
          // was called above before we knew about this guard branch.
          setQuestion(q);
          if (turnRequestRef.current === requestId) finishStreamingRequest(streamingRequestId);
          return;
        }
        outgoingAttachments = outgoingAttachments.filter((p) => p.type !== "image");
      }
      // trigger-import: skip the user-bubble append. The
      // ImportedTriggerCard already represents the brain's question
      // visibly, and rendering the wrapped envelope as a user bubble
      // would misattribute authorship.
      if (mode !== "trigger-import") {
        appendUserEntry(mode === "guidance" ? `↳ ${t}` : t);
      }
      resetStreamAccumulators();
      try {
        if (mode === "guidance") {
          await api.chatGuide(outgoing);
          debugLog("handleAsk", "chatGuide:resolved", { requestId });
        } else {
          await api.chatSend(outgoing, outgoingAttachments);
          debugLog("handleAsk", "chatSend:resolved", { requestId });
          // After successful send, clear attachments — the textarea was
          // already cleared by setQuestion(""). N counter persists across
          // turns so re-attached items get fresh numbers.
          if (outgoingAttachments.length > 0 || attachments.length > 0) {
            setAttachments([]);
          }
        }
      } catch (err) {
        debugLog("handleAsk", "chatSend:rejected", {
          requestId,
          err: (err as Error)?.message,
        });
        // chatSend rejection (network fail, abort, etc.) on a
        // trigger-import turn never lands a `done` event, so the
        // open imported_trigger card's streaming spinner would hang
        // forever. Close the card before surfacing the error.
        if (mode === "trigger-import") closeOpenImportedTrigger();
        setErrorWithThought(`오류: ${(err as Error).message}`);
      } finally {
        const turnMatch = turnRequestRef.current === requestId;
        debugLog("handleAsk", "finally", {
          requestId,
          currentTurnRef: turnRequestRef.current,
          turnMatch,
          willCallFinish: turnMatch,
        });
        if (turnMatch) finishStreamingRequest(streamingRequestId);
      }
    },
    [
      api,
      streaming,
      checkApiKey,
      composeOutgoing,
      appendUserEntry,
      resetStreamAccumulators,
      beginStreamingRequest,
      finishStreamingRequest,
      setErrorWithThought,
      handleCompactCommand,
      sessionLoad,
      applyLoadedSession,
      refreshSessionId,
      refreshSessions,
      closeOpenImportedTrigger,
      // attachments is read directly at the post-send cleanup branch
      // (line ~260) and is also a transitive dep via composeOutgoing,
      // but listing it explicitly avoids stale-closure surprises if
      // composeOutgoing's deps drift. llmVendor/llmModel are read by
      // the supportsVision gate.
      attachments,
      llmVendor,
      llmModel,
    ],
  );

  // Brain trigger accept → chat takes over. Server emits
  // `lvis:trigger:imported` with both metadata for the visible card
  // and the pre-wrapped prompt that should fire as the next chat
  // turn.
  //
  // `flushSync` around the entry insert is load-bearing: handleAsk
  // immediately fires `api.chatSend(wrappedPrompt)`, which round-
  // trips to main and starts emitting `text_delta` events. The
  // renderer's text_delta handler routes the delta INTO the
  // imported_trigger card iff `responseStreaming === true` is
  // already in `entries`. Without flushSync, React batching can
  // delay the entry insert past the first delta arrival → the
  // delta falls through to `upsertStreamingAssistant` and renders
  // as a sibling assistant bubble below the card (the duplicate-
  // response bug R1-1).
  useEffect(() => {
    const unsub = api.onTriggerImported((payload) => {
      flushSync(() => {
        addImportedTriggerEntry(payload);
      });
      void handleAsk(payload.wrappedPrompt, "trigger-import");
    });
    return () => { unsub(); };
  }, [api, addImportedTriggerEntry, handleAsk]);

  const { costEstimate, costBadgeClass } =
    useCostEstimate({ entries, question, llmVendor, llmModel, maxOutputTokens, composeOutgoing });

  const handleNewChat = useCallback(async () => {
    if (streaming) { console.warn("new chat blocked during streaming"); return; }
    await api.chatNew(); clearForNewChat(); resetForNewSession(); void refreshSessionId();
  }, [api, streaming, refreshSessionId, clearForNewChat, resetForNewSession]);

  const handleStartRoutineSession = useCallback(async (routineId: string) => {
    const result = await api.startRoutineSession(routineId);
    if (!result.ok || !result.sessionId) return;
    await sessionLoad(result.sessionId, streaming, applyLoadedSession);
    setActiveView("home");
    await refreshSessionId();
    await refreshSessions();
  }, [api, sessionLoad, streaming, applyLoadedSession, refreshSessionId, refreshSessions]);

  // ─── Effects ──────────────────────────────────
  const toggleCommandPopover = useCallback(() => {
    if (activeView !== "home") {
      setActiveView("home");
      setCommandPopoverOpen(true);
    } else {
      setCommandPopoverOpen((prev) => !prev);
    }
  }, [activeView]);

  useAppBootstrap({
    api, refreshMarketplace, refreshViews, refreshCards, checkApiKey,
    setActiveView,
    toggleCommandPopover,
  });
  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [entries]);

  // Refresh plugin views + marketplace catalog when a lvis:// deep-link
  // install completes in the main process, so new sidebar tabs appear
  // (and uninstalled ones disappear) without requiring an app restart.
  useEffect(() => {
    if (typeof api.onPluginInstallResult !== "function") return;
    const unsubscribe = api.onPluginInstallResult(({ success }) => {
      if (!success) return;
      void refreshViews();
      void refreshMarketplace();
      void refreshCards();
    });
    return unsubscribe;
  }, [api, refreshViews, refreshMarketplace, refreshCards]);

  // Same lifecycle for uninstall — PluginConfigTab and any other surface
  // drive uninstall through the IPC handler which now broadcasts a result
  // event. Without this subscription the sidebar would keep the removed
  // plugin's tab until the app reloads.
  useEffect(() => {
    if (typeof api.onPluginUninstallResult !== "function") return;
    const unsubscribe = api.onPluginUninstallResult(({ success }) => {
      if (!success) return;
      void refreshViews();
      void refreshMarketplace();
      void refreshCards();
    });
    return unsubscribe;
  }, [api, refreshViews, refreshMarketplace, refreshCards]);

  // Auto-close CommandPopover when navigating away from home — the popover
  // is only mounted on the home view so leaving it open causes stuck state.
  useEffect(() => {
    if (activeView !== "home") setCommandPopoverOpen(false);
  }, [activeView]);

  const commandActions = useMemo(
    () =>
      buildQuickActions({
        setActiveView: handleSidebarSelect,
        setSettingsOpen,
        handleNewChat,
        pluginViews,
      }),
    [pluginViews, handleNewChat, handleSidebarSelect],
  );

  const onOpenSettings = useCallback(() => setSettingsOpen(true), []);
  const onNewChat = useCallback(() => { void handleNewChat(); }, [handleNewChat]);

  // ChatView context bundle — avoids drilling ~40 props through the tree.
  const chatContextValue = useChatContextValue({
    entries, streaming, editingEntryIdx, setEditingEntryIdx, editBusy,
    question, setQuestion, chatEndRef, currentSessionId, hasApiKey, onOpenSettings,
    routineResult, routineQueueIndex, routineQueueTotal,
    onDismissRoutineResult: dismissRoutineResult, onSnoozeRoutineResult: snoozeRoutineResult,
    onPrevRoutineResult: prevRoutineResult, onNextRoutineResult: nextRoutineResult,
    runningRoutines,
    triggerResult, onDismissTrigger: dismissTrigger, onAcceptTrigger: importTriggerIntoChat,
    searchOpen, searchQuery, searchCase, searchMatches, searchMatchSet, searchIdx, searchHighlight,
    searchChangeQuery, searchToggleCase, searchNext, searchPrev, searchCloseOverlay, searchToggleOverlay,
    contextOverflowPct, usedTokens, contextBudget,
    rolePresets, activePreset, activePresetId, setActivePresetId,
    attachments, setAttachments, attachmentNCounter,
    vendorSupportsThinking, enableThinkingChat, toggleThinking, costEstimate, costBadgeClass,
  });

  // Bottom status bar (#231) — bottom slot for persistent items + transient
  // toasts. The hook subscribes to existing install-progress / install-result
  // / uninstall-result events and reads the routine schedule from settings,
  // so wiring it here is enough to surface lifecycle feedback.
  // Issue #260 — when a notification toast is clicked, dispatch the click via
  // notifyClick IPC (which restores+focuses the window) and dismiss the
  // toast. Other toast producers leave `notification` undefined so this
  // handler is a no-op for them.
  const { persistent: statusPersistent, visibleToast: statusVisibleToast, pendingCount: statusPendingCount, removeToast: statusRemoveToast } =
    useStatusBar({ api });
  const handleStatusToastClick = useCallback(
    (toast: { id: string; notification?: NotificationToastMeta }) => {
      if (!toast.notification) return;
      try {
        void api.notifyClick?.({
          kind: toast.notification.kind,
          contextRef: toast.notification.contextRef,
        });
      } catch {
        // notifyClick is best-effort UX; failure must not crash the bar.
      }
      statusRemoveToast(toast.id);
    },
    [api, statusRemoveToast],
  );

  // ─── Render ───────────────────────────────────
  return (
    <ErrorBoundary fallback="앱 오류가 발생했습니다">
    <ThemeProvider api={api}>
    <TooltipProvider>
        <div className="flex h-screen flex-col overflow-hidden">
          <CustomTitleBar />
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <Sidebar
            activeView={activeView}
            setActiveView={handleSidebarSelect}
            starredCount={starred.length}
          />

        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          <BootstrapStatusBanner status={bootstrapStatus} onDismiss={dismissBootstrapStatus} onRetry={() => void retryBootstrap()} />
          <MarketplaceUpdateBanner
            updates={marketplaceUpdates}
            onDismiss={dismissMarketplaceUpdates}
            onUpdate={installPlugin}
          />
          {fallbackToast && (
            <div className="bg-warning text-warning-foreground text-xs px-4 py-2 border-b border-warning">
              {fallbackToast}
            </div>
          )}
          <MainToolbar
            streaming={streaming}
            hasApiKey={hasApiKey}
            sessions={sessions}
            currentSessionId={currentSessionId}
            isCurrentSessionStarred={Boolean(currentSessionId && isSessionStarred(currentSessionId))}
            onNewChat={onNewChat}
            onRefreshSessions={refreshSessions}
            onRefreshStarred={refreshStarred}
            onLoadSession={handleLoadSession}
            onToggleCurrentSessionStar={() => currentSessionId
              ? handleToggleSessionStar(currentSessionId, sessions.find((s) => s.id === currentSessionId)?.title)
              : Promise.resolve()}
            onToggleSessionStar={handleToggleSessionStar}
            isSessionStarred={(sessionId) => Boolean(isSessionStarred(sessionId))}
            onExport={handleExport}
            onOpenSettings={() => setSettingsOpen(true)}
            onOpenGlobalSearch={() => { refreshSessions(); setGlobalSearchOpen(true); }}
            onOpenStarredView={() => setActiveView("starred")}
          />

          <MainContent
            activeView={activeView}
            api={api}
            starred={starred}
            currentSessionId={currentSessionId}
            refreshStarred={refreshStarred}
            onActivateHome={() => setActiveView("home")}
            onJumpToSession={handleLoadSession}
            onStartRoutineSession={handleStartRoutineSession}
            chatContextValue={chatContextValue}
            onAsk={(q) => handleAsk(q, "default")}
            onGuide={(q) => handleAsk(q, "guidance")}
            onEditSave={handleEditSave}
            onFork={handleFork}
            onToggleStar={handleToggleStar}
            onRetryEffort={handleRetryEffort}
            isEntryStarred={isEntryStarred}
            onAbort={handleAbort}
            onFeedback={handleFeedback}
            onRevertCheckpoint={handleLoadSession}
            subAgentSpawns={subAgentSpawns}
            loadedSkills={loadedSkills}
            hasAskQuestions={askQuestions.length > 0}
            askQuestions={askQuestions}
            onResolveAskQuestion={dismissAskQuestion}
            plugins={pluginEntries}
            onSelectPlugin={handleSidebarSelect}
            commandActions={commandActions}
            commandPopoverOpen={commandPopoverOpen}
            onCommandPopoverOpenChange={setCommandPopoverOpen}
            installingPlugins={installingPlugins}
            onOpenMarketplace={onOpenMarketplace}
            marketplaceUrlReady={marketplaceUrlReady}
            activePluginView={activePluginView ?? null}
          />
        </main>
        </div>
        <StatusBar persistent={statusPersistent} visibleToast={statusVisibleToast} pendingCount={statusPendingCount} onToastClick={handleStatusToastClick} />
      </div>

      {/* ask_user_question cards now render inline inside ChatView
          (immediately after the active turn's entries),
          so the previous App-level FloatingQuestionPanel mount is gone.
          See <AskUserQuestionCard> + ChatView ask-question slot. */}
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} api={api} onSaved={() => { void checkApiKey(); void refreshLlmSettings(); }} />
      <ApprovalDialog queue={approvalQueue} onDecide={handleApprovalDecide} onDecideAll={handleApprovalDecideAll} />
      <ApprovalQueueStatus queue={approvalQueue} />
      {/* Conditional mount: avoids useMemorySearch IPC calls while dialog is closed.
          Re-mounts on every open → catalog reloaded each time. If that proves slow,
          introduce a persistent cache hook in a separate PR. */}
      {globalSearchOpen && (
        <GlobalSearchDialog
          open={globalSearchOpen}
          onOpenChange={setGlobalSearchOpen}
          api={api}
          sessions={sessions}
          starred={starred}
          onLoadSession={handleLoadSession}
          onOpenMemoryView={() => setActiveView("memory")}
        />
      )}
      <DropZoneOverlay />
      <DevConsoleToggle />
      {/* Snap edge highlight — shown when a detached child window enters the snap zone */}
      <SnapEdgeHighlight />
    </TooltipProvider>
    </ThemeProvider>
    </ErrorBoundary>
  );
}
