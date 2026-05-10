import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { debugLog } from "../../lib/debug-stream.js";
import {
  composeImportedTriggerOutgoing,
  composeOutgoing as composeOutgoingUtil,
} from "./utils/compose.js";
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
import { lookupPricingOptional } from "../../shared/pricing-data.js";
import { useChatState } from "./hooks/use-chat-state.js";
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
import { OverlayContextProvider } from "./context/OverlayContext.js";
import { RoutineSessionView } from "./components/RoutineSessionView.js";

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
    fallbackToast,
    insertImportedTriggerEntry,
  } = useChatState(api);
  const [question, setQuestion] = useState("");
  const chatEndRef = useRef<HTMLDivElement>(null);
  const turnRequestRef = useRef(0);
  // Ref so handlePluginPrimaryAction (defined before handleAsk) can call
  // handleAsk without a forward-declaration TS error. Updated each render.
  const handleAskRef = useRef<(q: string, mode?: "default" | "trigger-import") => Promise<void>>(
    async () => { /* populated below */ },
  );

  // App state
  const [hasApiKey, setHasApiKey] = useState<boolean | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState("llm");
  const [activeView, setActiveView] = useState("home");
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
  const [commandPopoverOpen, setCommandPopoverOpen] = useState(false);
  const { updates: marketplaceUpdates, dismiss: dismissMarketplaceUpdates } = useMarketplaceUpdates(api);
  const { status: bootstrapStatus, dismiss: dismissBootstrapStatus, retry: retryBootstrap } = useBootstrapStatus(api);
  const { queue: approvalQueue, decide: handleApprovalDecide } = useApproval();

  // runningRoutines tracks in-flight LLM sessions.
  const [runningRoutines, setRunningRoutines] = useState<Set<string>>(new Set());

  // addFire ref is populated by OverlayContextProvider during render
  // so the IPC subscription below can call it without prop-drilling
  const addFireRef = useRef<import("./context/OverlayContext.js").OverlayContextValue["addFire"] | null>(null);

  // C1+M4: single subscription for routine IPC events. runningStarted pushes a
  // running OverlayItem immediately (running:true); fired replaces it with the
  // completed item (running:false + summary). runningRoutines Set is kept in
  // sync for OverlayContextProvider to derive running flags on queue items.
  useEffect(() => {
    const unsubStarted = api.onRoutineRunningStarted((payload) => {
      const { routineId, firedAt, title } = payload;
      setRunningRoutines((prev) => new Set([...prev, routineId]));
      addFireRef.current?.({
        id: `${routineId}-running`,
        source: { kind: "routine", routineId, firedAt },
        title,
        summary: "",
        running: true,
      });
    });

    const unsubFinished = api.onRoutineRunningFinished((routineId) => {
      setRunningRoutines((prev) => {
        const next = new Set(prev);
        next.delete(routineId);
        return next;
      });
    });

    // Major fix: clears running:true stuck OverlayItem when LLM session fails.
    // Uses the same stale-replace path as fired so the running OverlayItem
    // transitions to a visible error summary instead of staying spinning.
    const unsubFailed = api.onRoutineFailedV2((evt) => {
      setRunningRoutines((prev) => {
        const next = new Set(prev);
        next.delete(evt.routineId);
        return next;
      });
      addFireRef.current?.({
        id: `${evt.routineId}-running`,
        source: { kind: "routine", routineId: evt.routineId, firedAt: new Date().toISOString() },
        title: `[실패] 루틴`,
        summary: `루틴 실행 실패: ${evt.error}`,
        running: false,
      });
    });

    // M1: fired payload uses explicit allowlist fields only (no ...routine spread)
    const unsubFired = api.onRoutineFiredV2((evt) => {
      addFireRef.current?.({
        id: `${evt.id}-${evt.firedAt}`,
        source: { kind: "routine", routineId: evt.id, firedAt: evt.firedAt },
        title: evt.title,
        summary: evt.summary,
        running: false,
        routineSessionPath: evt.routineSessionPath,
      });
    });

    return () => { unsubStarted(); unsubFinished(); unsubFailed(); unsubFired(); };
  }, [api]);

  // Overlay items ref tracks all items pushed via onOverlayShow so
  // handlePluginPrimaryAction can look up pendingPrompt by id without needing
  // to reach into OverlayContext (App.tsx is the parent of OverlayContextProvider).
  const overlayItemsRef = useRef<Map<string, import("./context/OverlayContext.js").OverlayItem>>(new Map());

  // Overlay IPC subscriptions: main pushes plugin OverlayItems via OVERLAY_V1.show.
  useEffect(() => {
    if (typeof api.onOverlayShow !== "function") return;
    const unsubShow = api.onOverlayShow((item) => {
      // Populate lookup ref so handlePluginPrimaryAction can find the item
      overlayItemsRef.current.set(item.id, item);
      addFireRef.current?.(item);
    });
    const unsubDismiss = typeof api.onOverlayDismiss === "function"
      ? api.onOverlayDismiss((id) => {
          overlayItemsRef.current.delete(id);
        })
      : () => {};
    return () => { unsubShow(); unsubDismiss(); };
  }, [api]);

  // Plugin overlay primary action handler (user confirm → main chat insert).
  // Called from OverlayCardRegion with the OverlayItem.id after OverlayContext.dismiss()
  // has already removed the item from the queue. overlayItemsRef still holds it.
  const handlePluginPrimaryAction = useCallback(
    async (overlayItemId: string) => {
      const item = overlayItemsRef.current.get(overlayItemId);
      if (!item) return;

      const { source, pendingPrompt, summary, title } = item;
      if (source.kind !== "plugin" || !pendingPrompt) return;

      // Clean up lookup ref
      overlayItemsRef.current.delete(overlayItemId);

      // Notify main process (audit log + plugin notification) — best-effort
      try {
        await api.notifyOverlayPrimary?.(source.pluginId, source.eventId);
      } catch {
        // audit is best-effort; do not block the chat insert
      }

      // Insert as imported_trigger entry — proactive provenance preserved,
      // NOT a plain user bubble (architecture §9 plugin provenance contract)
      insertImportedTriggerEntry({
        sessionId: source.eventId,
        pluginId: source.pluginId,
        prompt: pendingPrompt,
        summary,
        title,
      });

      // Start the main ConversationLoop turn immediately (user-in-the-loop
      // confirm → auto-process). trigger-import mode skips the user-bubble
      // append since the imported_trigger card already represents the prompt.
      void handleAskRef.current(pendingPrompt, "trigger-import");
    },
    [api, insertImportedTriggerEntry],
  );

  // Routine session modal opened from OverlayCard "결과 보기".
  const [routineSessionModal, setRoutineSessionModal] = useState<{ jsonlPath: string } | null>(null);
  const handleOpenRoutineSession = useCallback(
    async (routineId: string, firedAt: string) => {
      try {
        const sessions = await api.listRoutineSessionsV2(routineId, 20);
        // Match firedAt — find closest session file for this fire event
        const match = sessions.find((s) => s.firedAt === firedAt) ?? sessions[0];
        if (match) setRoutineSessionModal({ jsonlPath: match.jsonlPath });
      } catch (err) {
        console.warn("[lvis] openRoutineSession failed:", (err as Error).message);
      }
    },
    [api],
  );

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
      mode: "default" | "trigger-import" = "default",
    ) => {
      debugLog("handleAsk", "enter", { mode, qLen: q.length, streaming });
      const t = q.trim();
      if (!t) {
        debugLog("handleAsk", "skip:empty");
        return;
      }
      if (mode === "default" && streaming) {
        // Issue #622: interrupt the current turn and start a new one.
        // chatAbort awaits until the active stream turn settles (interrupted),
        // then returns. The in-flight turn's finally block calls
        // finishStreamingRequest; the turnRequestRef increment below makes
        // its requestId stale so the call is a safe no-op. Partial response
        // is committed to history by post-turn-hook-chain with
        // stopReason="interrupted".
        debugLog("handleAsk", "interrupt:abort-and-proceed");
        try { await api.chatAbort(); } catch { /* no-op */ }
      }
      // Renderer only performs UX-level shortcuts for typed composer input.
      // Main owns the authoritative trust-origin classification.
      if (mode === "default") {
        if (await handleCompactCommand(t)) {
          debugLog("handleAsk", "skip:compact-command-handled");
          return;
        }
        if (t === "/load" || t.startsWith("/load ")) {
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
      }
      if (!(await checkApiKey())) {
        setSettingsInitialTab("llm");
        setSettingsOpen(true);
        return;
      }
      const requestId = ++turnRequestRef.current;
      const streamingRequestId = beginStreamingRequest();
      debugLog("handleAsk", "begin", { requestId, streamingRequestId });
      setQuestion("");
      const composed = mode === "trigger-import"
        ? composeImportedTriggerOutgoing(t)
        : composeOutgoing(t);
      const outgoing = composed.text;
      let outgoingAttachments = composed.attachments;
      // Vendor vision capability gate. The composer accepts images
      // regardless of the active model so the user can switch models
      // freely; check at send time and confirm before silently dropping
      // image parts on a text-only model.
      const hasImageParts = outgoingAttachments.some((p) => p.type === "image");
      if (hasImageParts && !supportsVision(llmVendor, llmModel)) {
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
        appendUserEntry(t);
      }
      resetStreamAccumulators();
      try {
        await api.chatSend(
          outgoing,
          outgoingAttachments,
          mode === "trigger-import" ? "plugin-emitted" : "user-keyboard",
        );
        debugLog("handleAsk", "chatSend:resolved", { requestId });
        // After successful send, clear attachments — the textarea was
        // already cleared by setQuestion(""). N counter persists across
        // turns so re-attached items get fresh numbers.
        if (outgoingAttachments.length > 0 || attachments.length > 0) {
          setAttachments([]);
        }
      } catch (err) {
        debugLog("handleAsk", "chatSend:rejected", {
          requestId,
          err: (err as Error)?.message,
        });
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
  // Keep ref in sync so handlePluginPrimaryAction can call handleAsk
  // without a forward-declaration error (ref is populated before first use).
  handleAskRef.current = handleAsk;

  const { costEstimate, costBadgeClass } =
    useCostEstimate({ entries, question, llmVendor, llmModel, maxOutputTokens, composeOutgoing });
  // Strict variant — `undefined` means "model not in catalog" so the cost
  // toggle in TokenCostBadge stays disabled rather than showing $0 from
  // FALLBACK_PRICING.
  const activePricing = useMemo(
    () => lookupPricingOptional(llmVendor, llmModel),
    [llmVendor, llmModel],
  );

  const handleNewChat = useCallback(async () => {
    if (streaming) { console.warn("new chat blocked during streaming"); return; }
    await api.chatNew(); clearForNewChat(); resetForNewSession(); void refreshSessionId();
  }, [api, streaming, refreshSessionId, clearForNewChat, resetForNewSession]);

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
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [entries]);

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

  const onOpenSettings = useCallback((tab = "llm") => {
    setSettingsInitialTab(tab);
    setSettingsOpen(true);
  }, []);

  const commandActions = useMemo(
    () =>
      buildQuickActions({
        setActiveView: handleSidebarSelect,
        openSettings: onOpenSettings,
        handleNewChat,
        pluginViews,
      }),
    [pluginViews, handleNewChat, handleSidebarSelect, onOpenSettings],
  );

  const onNewChat = useCallback(() => { void handleNewChat(); }, [handleNewChat]);

  // ChatView context bundle — avoids drilling ~40 props through the tree.
  const chatContextValue = useChatContextValue({
    entries, streaming, editingEntryIdx, setEditingEntryIdx, editBusy,
    question, setQuestion, chatEndRef, currentSessionId, hasApiKey, onOpenSettings,
    searchOpen, searchQuery, searchCase, searchMatches, searchMatchSet, searchIdx, searchHighlight,
    searchChangeQuery, searchToggleCase, searchNext, searchPrev, searchCloseOverlay, searchToggleOverlay,
    contextOverflowPct, usedTokens, contextBudget,
    rolePresets, activePreset, activePresetId, setActivePresetId,
    attachments, setAttachments, attachmentNCounter,
    vendorSupportsThinking, enableThinkingChat, toggleThinking, costEstimate, costBadgeClass,
    activePricing,
    activeVendor: llmVendor,
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
    <OverlayContextProvider
      onOpenSession={handleOpenRoutineSession}
      addFireRef={addFireRef}
      runningRoutines={runningRoutines}
    >
        <div className="flex h-screen flex-col overflow-hidden">
          <CustomTitleBar />
        <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
          <Sidebar
            activeView={activeView}
            setActiveView={handleSidebarSelect}
            starredCount={starred.length}
            sessions={sessions}
            onLoadSession={handleLoadSession}
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
            onOpenSettings={() => onOpenSettings()}
            onOpenGlobalSearch={() => { refreshSessions(); setGlobalSearchOpen(true); }}
            onOpenStarredView={() => setActiveView("starred")}
          />

          <MainContent
            activeView={activeView}
            api={api}
            starred={starred}
            currentSessionId={currentSessionId}
            sessions={sessions}
            refreshStarred={refreshStarred}
            onActivateHome={() => setActiveView("home")}
            onJumpToSession={handleLoadSession}
            onRefreshSessions={refreshSessions}
            chatContextValue={chatContextValue}
            onAsk={(q) => handleAsk(q, "default")}
            onEditSave={handleEditSave}
            onFork={handleFork}
            onToggleStar={handleToggleStar}
            onRetryEffort={handleRetryEffort}
            isEntryStarred={isEntryStarred}
            onAbort={handleAbort}
            onFeedback={handleFeedback}
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
            onPluginPrimaryAction={(id) => { void handlePluginPrimaryAction(id); }}
          />
        </main>
        </div>
        <StatusBar persistent={statusPersistent} visibleToast={statusVisibleToast} pendingCount={statusPendingCount} onToastClick={handleStatusToastClick} />
      </div>

      {/* ask_user_question cards now render inline inside ChatView
          (immediately after the active turn's entries),
          so the previous App-level FloatingQuestionPanel mount is gone.
          See <AskUserQuestionCard> + ChatView ask-question slot. */}
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} api={api} onSaved={() => { void checkApiKey(); void refreshLlmSettings(); }} initialTab={settingsInitialTab} />
      <ApprovalDialog queue={approvalQueue} onDecide={handleApprovalDecide} />
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
      {/* Routine session modal opened from OverlayCard "결과 보기" */}
      {routineSessionModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
          onClick={() => setRoutineSessionModal(null)}
        >
          <div
            className="relative w-full max-w-2xl max-h-[80vh] overflow-hidden rounded-lg shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <RoutineSessionView
              jsonlPath={routineSessionModal.jsonlPath}
              api={api}
              onClose={() => setRoutineSessionModal(null)}
            />
          </div>
        </div>
      )}
    </OverlayContextProvider>
    </TooltipProvider>
    </ThemeProvider>
    </ErrorBoundary>
  );
}
