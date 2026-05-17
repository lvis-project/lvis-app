import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { debugLog, isDebugStreamEnabled } from "../../lib/debug-stream.js";
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
import { DeferredQueueDialog } from "./dialogs/DeferredQueueDialog.js";
import { OnboardingDialog } from "./components/OnboardingDialog.js";
import { LoginModal } from "./components/LoginModal.js";
import { LLM_VENDORS } from "../../shared/llm-vendor-defaults.js";
import { buildQuickActions } from "./components/command-actions.js";
import { MainToolbar } from "./MainToolbar.js";
import { useAppUpdate } from "./hooks/use-app-update.js";
import { DevToolsPanel } from "./components/DevToolsPanel.js";
import { MainContent } from "./MainContent.js";
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
import { useAssistantContextOptions } from "./hooks/use-assistant-context-options.js";
import { useAppBootstrap } from "./hooks/use-app-bootstrap.js";
import { useChatActions } from "./hooks/use-chat-actions.js";
import { useChatContextValue } from "./hooks/use-chat-context-value.js";
import { CustomTitleBar } from "./components/CustomTitleBar.js";
import { useWorkflowTools } from "./hooks/use-workflow-tools.js";
import { useInstallingPlugins } from "./hooks/use-installing-plugins.js";
import { useMarketplaceUrl } from "./hooks/use-marketplace-url.js";
import { OverlayContextProvider } from "./context/OverlayContext.js";
import { UnifiedSearchPanel } from "./components/UnifiedSearchPanel.js";
import type { UserKeyboardIntentSnapshot } from "../../shared/chat-origin.js";

// ─── App ────────────────────────────────────────────

export function App() {
  const api = useMemo(() => getApi(), []);
  // App auto-update badge state — surfaces the main-process electron-updater
  // events as a permanent badge next to the Home button. User-gated:
  // download/install only run on explicit badge click.
  const appUpdate = useAppUpdate(api);

  // Workflow tools (S1+S2) — lifted to App level so FloatingQuestionPanel
  // survives view navigation (question state persists across view changes).
  const {
    askQuestions,
    subAgentSpawns,
    loadedSkills,
    dismissAskQuestion,
    resetForNewSession,
  } = useWorkflowTools(api);

  // Chat state + stream lifecycle (useChatState is the sole owner of entries).
  const {
    entries, streaming, isCompacting, beginStreamingRequest, finishStreamingRequest, editingEntryIdx, setEditingEntryIdx, editBusy,
    entryIndexToHistoryIndex, handleEditSave, handleRetryEffort,
    resetStreamAccumulators, setErrorWithThought, handleCompactCommand,
    clearForNewChat, appendUserEntry, appendAssistantStatus, appendSystemEntry, applyInitialSession, applyLoadedSession, truncateToEntry,
    fallbackToast,
    insertImportedTriggerEntry,
  } = useChatState(api);
  const [question, setQuestion] = useState("");
  const chatEndRef = useRef<HTMLDivElement>(null);
  const turnRequestRef = useRef(0);
  // In-flight guard for kind="action" plugin-panel dispatches — keyed by
  // `${pluginId}:${tool}`. Prevents duplicate fires from rapid double-clicks
  // when no panel transition is visible to throttle the user naturally.
  const pluginActionInflightRef = useRef<Set<string>>(new Set());
  // Ref so handlePluginPrimaryAction (defined before handleAsk) can call
  // handleAsk without a forward-declaration TS error. Updated each render.
  const handleAskRef = useRef<(
    q: string,
    mode?: "default" | "trigger-import",
    userIntent?: UserKeyboardIntentSnapshot,
  ) => Promise<void>>(
    async () => { /* populated below */ },
  );

  // App state
  const [hasApiKey, setHasApiKey] = useState<boolean | null>(null);
  // #893 — onboarding + login dialog state. The onboarding effect below
  // probes `getSettings()` once on boot; if no vendor has a key *and* the
  // user has not previously dismissed onboarding, the dialog opens.
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [appLoginOpen, setAppLoginOpen] = useState(false);
  const [onboardingVendor, setOnboardingVendor] = useState<string>("claude");
  const [deferredQueueOpen, setDeferredQueueOpen] = useState(false);
  const [activeView, setActiveView] = useState("home");
  const [commandPopoverOpen, setCommandPopoverOpen] = useState(false);
  const [devToolsOpen, setDevToolsOpen] = useState(false);

  // Dev tools — Cmd/Ctrl+Shift+D toggles the floating panel.
  // Listener is only bound in dev mode (`window.__lvisDevMode === true`) so
  // packaged builds neither swallow the chord nor pay setState cost on every
  // press. Main process strips dev IPC handlers when packaged, so even if a
  // production build accidentally read true, the panel would render inert.
  useEffect(() => {
    if ((window as unknown as { __lvisDevMode?: boolean }).__lvisDevMode !== true) {
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.shiftKey && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d") {
        e.preventDefault();
        setDevToolsOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const { updates: marketplaceUpdates, dismiss: dismissMarketplaceUpdates } = useMarketplaceUpdates(api);
  const { status: bootstrapStatus, dismiss: dismissBootstrapStatus, retry: retryBootstrap } = useBootstrapStatus(api);
  const { queue: approvalQueue, decide: handleApprovalDecide } = useApproval();

  // runningRoutines tracks in-flight LLM sessions.
  const [runningRoutines, setRunningRoutines] = useState<Set<string>>(new Set());

  // addFire ref is populated by OverlayContextProvider during render
  // so the IPC subscription below can call it without prop-drilling
  const addFireRef = useRef<import("./context/OverlayContext.js").OverlayContextValue["addFire"] | null>(null);
  const pushRoutineResult = useCallback((evt: import("../../shared/routines-types.js").RoutineFiredPayload) => {
    addFireRef.current?.({
      id: `${evt.id}-${evt.firedAt}`,
      source: { kind: "routine", routineId: evt.id, firedAt: evt.firedAt },
      title: evt.title,
      summary: evt.summary,
      running: false,
      routineSessionId: evt.routineSessionId,
    });
  }, []);

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

    void (async () => {
      try {
        const pending = await api.listPendingRoutineResultsV2();
        for (const result of pending) pushRoutineResult(result);
      } catch (err) {
        console.warn("[lvis] listPendingRoutineResults failed:", (err as Error).message);
      }
    })();

    // M1: fired payload uses explicit allowlist fields only (no ...routine spread)
    const unsubFired = api.onRoutineFiredV2(pushRoutineResult);

    return () => { unsubStarted(); unsubFinished(); unsubFailed(); unsubFired(); };
  }, [api, pushRoutineResult]);

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

      // Insert as imported_trigger entry — overlay trigger provenance preserved,
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
      // append since the imported_trigger marker already represents the prompt.
      void handleAskRef.current(pendingPrompt, "trigger-import");
    },
    [api, insertImportedTriggerEntry],
  );

  const handleRoutineAcknowledge = useCallback(
    (routineId: string, firedAt: string) => {
      void api.acknowledgeRoutineResultV2(routineId, firedAt).catch((err) => {
        console.warn("[lvis] acknowledgeRoutineResult failed:", (err as Error).message);
      });
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
  const { rolePresets, activePreset, activePresetId, setActivePresetId } = useRolePresets(api);
  const { agents: agentOptions, skills: skillOptions } = useAssistantContextOptions(api);
  const [activeAgentName, setActiveAgentName] = useState("");
  const [activeSkillNames, setActiveSkillNames] = useState<string[]>([]);
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
    openOverlay: searchOpenOverlay, toggleOverlay: searchToggleOverlay, closeOverlay: searchCloseOverlay,
    nextMatch: searchNext, prevMatch: searchPrev, jumpToMatch: searchJumpToMatch,
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
    currentSessionId, currentSessionKind, currentSessionTitle, sessions, refreshSessionId, refreshSessions,
    handleLoadSession: sessionLoad, handleFork: sessionFork,
  } = useSessions(api, applyInitialSession);

  const handleOpenRoutineSession = useCallback(
    async (sessionId: string) => {
      if (streaming) {
        console.warn("[lvis] openRoutineSession blocked during streaming");
        return false;
      }
      try {
        setActiveView("home");
        return await sessionLoad(sessionId, streaming, applyLoadedSession);
      } catch (err) {
        console.warn("[lvis] openRoutineSession failed:", (err as Error).message);
        return false;
      }
    },
    [applyLoadedSession, sessionLoad, streaming],
  );

  useEffect(() => {
    if (!searchOpen) return;
    void refreshSessions();
    void refreshStarred();
  }, [refreshSessions, refreshStarred, searchOpen]);

  // Small adapter callbacks that bridge hook outputs to ChatView / MainToolbar.
  const {
    handleLoadSession, isEntryStarred, handleFork, handleToggleStar,
    handleAbort, handleGuide, handleFeedback, handleExport,
  } = useChatActions({
    api, streaming, currentSessionId, entries, entryIndexToHistoryIndex,
    applyLoadedSession, truncateToEntry, sessionLoad, sessionFork,
    starredIsEntry, starredToggle,
  });

  useEffect(() => {
    const unsubscribe = api.window?.onLoadSessionInMain?.((sessionId) => {
      setActiveView("home");
      void handleLoadSession(sessionId);
    });
    return unsubscribe;
  }, [api, handleLoadSession]);

  // LLM settings + context budget (single source of truth: src/shared/pricing-data.ts)
  const { llmVendor, llmModel, enableThinkingChat, refresh: refreshLlmSettings, toggleThinking } = useSettings(api);

  const { usedTokens, contextBudget, contextOverflowPct } =
    useContextBudget({ entries, llmVendor, llmModel, draftText: question });

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
        iconText: view.iconText,
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

  const openDetachedBuiltInView = useCallback(
    async (viewKey: "routines" | "memory" | "starred"): Promise<boolean> => {
      const openDetached = api.window?.openDetached;
      if (!openDetached) {
        setErrorWithThought("오류: 새 창을 열 수 없습니다.");
        return false;
      }
      const result = await openDetached(viewKey);
      if (!result.ok) {
        console.warn(`[window] detached built-in view ${viewKey} did not open`, result.error);
        setErrorWithThought(`오류: 새 창을 열 수 없습니다. ${result.error}`);
        return false;
      }
      return true;
    },
    [api, setErrorWithThought],
  );

  // When a plugin view declares `window.defaultMode: "detached"`, selecting
  // it opens a separate magnetic-snap BrowserWindow instead of
  // switching the main window's active view.
  //
  // If the owning plugin declares `manifest.auth` AND its current state is
  // unauthed, embedded views invoke loginTool before navigating. Detached
  // views open directly so plugin-owned login UIs can collect their own
  // credentials through the plugin surface instead of the host calling
  // loginTool with no arguments.
  const handleViewSelect = useCallback(
    (key: string) => {
      if (key.startsWith("plugin:")) {
        const view = pluginViews.find((v) => toViewKey(v) === key);
        if (!view) return;
        // kind="action" entries never open a panel/window — host directly
        // dispatches the declared tool. uiCallable allowlist is enforced
        // downstream in runtime/index.ts:callFromUi. Active view state is
        // intentionally NOT changed so the user stays on whatever they
        // were looking at (chat / settings / etc.). slot==="sidebar" 는
        // (현재 schema 키 — 사용자에게는 "플러그인 패널") 강제하지만
        // future enum 확장 시 defense-in-depth.
        if (view.extension.kind === "action" && view.extension.slot === "sidebar") {
          const actionTool = view.extension.tool;
          if (typeof actionTool !== "string" || actionTool.length === 0) {
            console.warn(
              `[plugin-action] ${view.pluginId} extension ${view.extension.id} has kind="action" but no tool field — manifest validation should have caught this`,
            );
            return;
          }
          // In-flight guard: 사용자가 동일 action 아이콘을 빠르게 N번 클릭하면
          // N번 동시 디스패치 surface 가 열림 (mutating tool 일 때 실해). per
          // (pluginId, tool) 단위로 in-flight 추적해 진행 중이면 swallow.
          const inflightKey = `${view.pluginId}:${actionTool}`;
          if (pluginActionInflightRef.current.has(inflightKey)) {
            return;
          }
          pluginActionInflightRef.current.add(inflightKey);
          void (async () => {
            try {
              await api.callPluginMethod(actionTool);
            } catch (err) {
              // Raw err.message 는 OAuth refresh-token / Bearer header fragment
              // 가 포함될 수 있어 사용자 chat 영역에 그대로 노출하지 않는다.
              // 진단용 raw 는 console.warn 으로만 보존.
              console.warn(
                `[plugin-action] ${view.pluginId} tool '${actionTool}' failed`,
                err,
              );
              setErrorWithThought("오류: 플러그인 액션을 실행할 수 없습니다.");
            } finally {
              pluginActionInflightRef.current.delete(inflightKey);
            }
          })();
          return;
        }
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

  // If the currently-open plugin view belongs to a plugin that just got
  // uninstalled, fall back to home so the renderer doesn't render a "view
  // not found" placeholder for a stale plugin id.
  useEffect(() => {
    if (!activeView.startsWith("plugin:")) return;
    if (activePluginView) return;
    setActiveView("home");
  }, [activeView, activePluginView]);
  const checkApiKey = useCallback(async () => { const h = await api.hasApiKey(); setHasApiKey(h); return h; }, [api]);

  // #893 — First-boot onboarding probe. Runs once on mount; opens the
  // onboarding dialog when (a) no vendor has a persisted API key AND (b)
  // the user has not previously dismissed onboarding. Both choices flip
  // `features.onboardingCompleted = true` so subsequent boots skip the
  // dialog even if the user closes Settings without saving a key.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const settings = await api.getSettings();
        if (cancelled) return;
        if (settings.features?.onboardingCompleted === true) return;
        const anyKey = await Promise.all(
          LLM_VENDORS.map((v) => api.hasApiKey(v).catch(() => false)),
        );
        if (cancelled) return;
        if (anyKey.some(Boolean)) return;
        setOnboardingVendor(settings.llm.provider);
        setOnboardingOpen(true);
      } catch {
        // Probe failure is non-fatal — chat still works once a key exists.
      }
    })();
    return () => { cancelled = true; };
  }, [api]);

  const markOnboardingCompleted = useCallback(async () => {
    try {
      await api.updateSettings({ features: { onboardingCompleted: true } });
    } catch {
      // Persist failure is non-fatal; the dialog still dismisses for the
      // current session even if the disk write fails.
    }
  }, [api]);
  const vendorSupportsThinking = useMemo(() => vendorSupportsThinkingShared(llmVendor, llmModel), [llmVendor, llmModel]);
  const onOpenSettings = useCallback((tab = "llm") => {
    void api.openSettingsWindow(tab);
  }, [api]);

  useEffect(() => {
    return api.onSettingsWindowSaved(() => {
      void checkApiKey();
      void refreshLlmSettings();
    });
  }, [api, checkApiKey, refreshLlmSettings]);

  const composeOutgoing = useCallback(
    (raw: string) => composeOutgoingUtil({ raw, activePreset, attachments }),
    [activePreset, attachments],
  );

  useEffect(() => {
    if (activeAgentName && !agentOptions.some((agent) => agent.name === activeAgentName)) {
      setActiveAgentName("");
    }
    if (activeSkillNames.length > 0) {
      const available = new Set(skillOptions.map((skill) => skill.name));
      setActiveSkillNames((current) => current.filter((name) => available.has(name)));
    }
  }, [activeAgentName, activeSkillNames.length, agentOptions, skillOptions]);

  const handleAsk = useCallback(
    async (
      q: string,
      mode: "default" | "trigger-import" = "default",
      userIntent?: UserKeyboardIntentSnapshot,
      opts?: { injectHint?: "queue" | "interrupt"; inputOrigin?: "queue-auto" },
    ) => {
      // Cache once per invocation — `window.lvis.env.debugStream` is fixed at
      // preload bootstrap, so reading it again per debugLog call is wasted
      // work. Guarding each call site with the cached flag also skips the
      // payload object allocation when diagnostics are off (#566 item 1).
      const debugStreamEnabled = isDebugStreamEnabled();
      if (debugStreamEnabled) debugLog("handleAsk", "enter", { mode, qLen: q.length, streaming });
      const t = q.trim();
      if (!t) {
        if (debugStreamEnabled) debugLog("handleAsk", "skip:empty");
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
        if (debugStreamEnabled) debugLog("handleAsk", "interrupt:abort-and-proceed");
        try { await api.chatAbort(); } catch { /* no-op */ }
      }
      // Renderer only performs UX-level shortcuts for typed composer input.
      // Main owns the authoritative trust-origin classification.
      // queue-auto path 는 slash command 분기 우회 — 큐에 누적된 /compact,
      // /load 가 silent execute 되는 회귀 차단 (Round 3 critic C1-NEW).
      // 큐는 단순 user message inject 로만 동작 — slash command literal 은
      // LLM 에 plain text 로 전달.
      if (mode === "default" && opts?.inputOrigin !== "queue-auto") {
        if (await handleCompactCommand(t)) {
          if (debugStreamEnabled) debugLog("handleAsk", "skip:compact-command-handled");
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
          if (debugStreamEnabled) debugLog("handleAsk", "load-session:handled", { sessionId: match.id });
          return;
        }
      }
      if (!(await checkApiKey())) {
        onOpenSettings("llm");
        return;
      }
      const requestId = ++turnRequestRef.current;
      const streamingRequestId = beginStreamingRequest();
      if (debugStreamEnabled) debugLog("handleAsk", "begin", { requestId, streamingRequestId });
      setQuestion("");
      const composed = mode === "trigger-import"
        ? composeImportedTriggerOutgoing(t)
        : composeOutgoing(t);
      const outgoing = composed.text;
      // queue-auto path 는 큐 schema (텍스트 only) 라 사용자가 별도로 추가한
      // 첨부 파일이 따라가면 mental model 위배 + silent corruption (Round 3
      // code-reviewer CRITICAL). queue-auto 시 attachments 강제 빈 배열.
      let outgoingAttachments = opts?.inputOrigin === "queue-auto" ? [] : composed.attachments;
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
      // trigger-import: skip only the user-bubble append. The imported_trigger
      // marker already represents the plugin-authored overlay prompt
      // visibly, and rendering the wrapped envelope as a user bubble
      // would misattribute authorship.
      if (mode !== "trigger-import") {
        appendUserEntry(t, opts?.injectHint);
      }
      resetStreamAccumulators();
      appendAssistantStatus("생각 중...");
      try {
        await api.chatSend(
          outgoing,
          outgoingAttachments,
          opts?.inputOrigin === "queue-auto"
            ? "queue-auto"
            : mode === "trigger-import"
              ? "plugin-emitted"
              : "user-keyboard",
          // queue-auto path 는 user gesture 없이 IPC stream context 에서
          // 발생하므로 userIntent 전달 안 함 (validator 가 userActivation
          // 검사 우회).
          opts?.inputOrigin === "queue-auto"
            ? undefined
            : mode === "default" ? userIntent : undefined,
          // chat.ts:59 가 queue-auto 도 rolePrompt 허용 — Round 3 critic
          // M-NEW-1 fix. role preset 효과가 queue-auto inject 에도 적용됨.
          mode === "default" ? composed.rolePrompt : undefined,
          mode === "default"
            ? {
                ...(activeAgentName ? { agentName: activeAgentName } : {}),
                ...(activeSkillNames.length > 0 ? { skillNames: activeSkillNames } : {}),
              }
            : undefined,
        );
        if (debugStreamEnabled) debugLog("handleAsk", "chatSend:resolved", { requestId });
        // After successful send, clear attachments — the textarea was
        // already cleared by setQuestion(""). N counter persists across
        // turns so re-attached items get fresh numbers.
        if (outgoingAttachments.length > 0 || attachments.length > 0) {
          setAttachments([]);
        }
      } catch (err) {
        if (debugStreamEnabled) {
          debugLog("handleAsk", "chatSend:rejected", {
            requestId,
            err: (err as Error)?.message,
          });
        }
        setErrorWithThought(`오류: ${(err as Error).message}`);
      } finally {
        const turnMatch = turnRequestRef.current === requestId;
        if (debugStreamEnabled) {
          debugLog("handleAsk", "finally", {
            requestId,
            currentTurnRef: turnRequestRef.current,
            turnMatch,
            willCallFinish: turnMatch,
          });
        }
        if (turnMatch) finishStreamingRequest(streamingRequestId);
      }
    },
    [
      api,
      streaming,
      checkApiKey,
      composeOutgoing,
      appendUserEntry,
      appendAssistantStatus,
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
      activeAgentName,
      activeSkillNames,
      llmVendor,
      llmModel,
      onOpenSettings,
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
    api, refreshViews, refreshCards, checkApiKey,
    setActiveView,
    toggleCommandPopover,
  });
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [entries]);

  // Refresh plugin views + marketplace catalog when a lvis:// deep-link
  // install completes in the main process, so new plugin entries appear
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
  // event. Without this subscription plugin entry state would stay stale
  // until the app reloads.
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

  useEffect(() => {
    const unsubs = [
      api.onAgentInstallResult?.(({ success }) => { if (success) void refreshMarketplace(); }),
      api.onAgentUninstallResult?.(({ success }) => { if (success) void refreshMarketplace(); }),
      api.onSkillInstallResult?.(({ success }) => { if (success) void refreshMarketplace(); }),
      api.onSkillUninstallResult?.(({ success }) => { if (success) void refreshMarketplace(); }),
    ].filter((unsubscribe): unsubscribe is () => void => typeof unsubscribe === "function");
    return () => {
      for (const unsubscribe of unsubs) unsubscribe();
    };
  }, [api, refreshMarketplace]);

  // Auto-close CommandPopover when navigating away from home — the popover
  // is only mounted on the home view so leaving it open causes stuck state.
  useEffect(() => {
    if (activeView !== "home") setCommandPopoverOpen(false);
  }, [activeView]);

  const commandActions = useMemo(
    () =>
      buildQuickActions({
        setActiveView: handleViewSelect,
        openSettings: onOpenSettings,
        handleNewChat,
        pluginViews,
      }),
    [pluginViews, handleNewChat, handleViewSelect, onOpenSettings],
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
    agentOptions, skillOptions, activeAgentName, setActiveAgentName,
    activeSkillNames, setActiveSkillNames,
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
  const { persistent: statusPersistent, visibleToast: statusVisibleToast, pendingCount: statusPendingCount, removeToast: statusRemoveToast, upsertPersistent: statusUpsertPersistent, removePersistent: statusRemovePersistent } =
    useStatusBar({ api });

  // Show a persistent StatusBar indicator while a pre-turn auto-compact runs.
  // `compact_started` sets isCompacting → this effect upserts the item.
  // `compact_notice` clears isCompacting → this effect removes the item.
  useEffect(() => {
    const COMPACT_ITEM_ID = "auto-compact-in-progress";
    if (isCompacting) {
      statusUpsertPersistent({ id: COMPACT_ITEM_ID, severity: "info", label: "컨텍스트", value: "자동 압축 중..." });
    } else {
      statusRemovePersistent(COMPACT_ITEM_ID);
    }
  }, [isCompacting, statusUpsertPersistent, statusRemovePersistent]);

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
            activeView={activeView}
            streaming={streaming}
            hasApiKey={hasApiKey}
            isCurrentSessionStarred={Boolean(currentSessionId && isSessionStarred(currentSessionId))}
            onNewChat={onNewChat}
            onToggleCurrentSessionStar={() => currentSessionId
              ? handleToggleSessionStar(currentSessionId, sessions.find((s) => s.id === currentSessionId)?.title)
              : Promise.resolve()}
            onExport={handleExport}
            onOpenHome={() => setActiveView("home")}
            onOpenRoutinesView={() => setActiveView("routines")}
            onOpenMemoryView={() => setActiveView("memory")}
            onOpenSettings={() => onOpenSettings()}
            onOpenUnifiedSearch={() => {
              searchOpenOverlay();
            }}
            onOpenStarredView={() => setActiveView("starred")}
            onOpenDetachedView={(viewKey) => {
              void openDetachedBuiltInView(viewKey);
            }}
            onOpenDevTools={() => setDevToolsOpen((v) => !v)}
            appUpdateState={appUpdate.state}
            appUpdateInFlight={appUpdate.inFlight}
            onDownloadAppUpdate={appUpdate.download}
            onInstallAppUpdate={appUpdate.install}
          />
          <DevToolsPanel
            api={api}
            open={devToolsOpen}
            onClose={() => setDevToolsOpen(false)}
          />
          {searchOpen && (
            <UnifiedSearchPanel
              api={api}
              open={searchOpen}
              query={searchQuery}
              caseSensitive={searchCase}
              entries={entries}
              conversationMatches={searchMatches}
              currentConversationMatch={searchIdx}
              sessions={sessions}
              starred={starred}
              onChangeQuery={searchChangeQuery}
              onToggleCase={searchToggleCase}
              onNextConversationMatch={searchNext}
              onPrevConversationMatch={searchPrev}
              onJumpToConversationMatch={(matchIndex) => {
                setActiveView("home");
                searchJumpToMatch(matchIndex);
              }}
              onOpen={searchOpenOverlay}
              onClose={searchCloseOverlay}
              onLoadSession={async (sessionId) => {
                const loaded = await handleLoadSession(sessionId);
                if (loaded !== false) setActiveView("home");
                return loaded;
              }}
              onOpenMemoryView={() => {
                setActiveView("memory");
                searchCloseOverlay();
              }}
              onOpenRoutinesView={() => {
                setActiveView("routines");
                searchCloseOverlay();
              }}
              currentSessionId={currentSessionId}
              streaming={streaming}
              onRefreshSessions={refreshSessions}
              onJumpToEntry={(entryIndex) => {
                // Calendar popover in the search bar jumps to entries tagged
                // with data-chat-entry-index in ChatView. Switch the view to
                // home before scrolling so the entry is mounted.
                // ChatView (and its Suspense-wrapped children) may not be in
                // the DOM at the next paint — retry a bounded number of
                // frames so the scroll lands once mount completes.
                if (!Number.isInteger(entryIndex) || entryIndex < 0) return;
                setActiveView("home");
                const selector = `[data-chat-entry-index="${entryIndex}"]`;
                const MAX_SCROLL_RETRY_FRAMES = 10; // ~160ms ceiling at 60fps
                let attempts = 0;
                const tryScroll = () => {
                  const el = document.querySelector<HTMLElement>(selector);
                  if (el) {
                    el.scrollIntoView({ behavior: "smooth", block: "start" });
                    return;
                  }
                  if (++attempts >= MAX_SCROLL_RETRY_FRAMES) return;
                  requestAnimationFrame(tryScroll);
                };
                requestAnimationFrame(tryScroll);
              }}
            />
          )}

          {/* Inner ErrorBoundary scoped to MainContent so a single failing
              plugin (e.g. stale manifest schema mismatch — issue #736) does
              NOT bring down MainToolbar / Settings dialog / Marketplace tab.
              The user must remain able to update / uninstall the broken
              plugin via Settings, otherwise they are locked out and the only
              recovery is manually rm-ing ~/.lvis/plugins/<id>/.
              onReset: refresh plugin state then re-render — for transient
              throws this avoids the deterministic reload-into-same-crash
              loop where the bad data is reloaded with the page. */}
          <ErrorBoundary
            boundaryName="main-content"
            fallback="메인 영역에 오류가 발생했습니다 — 상단 메뉴에서 설정 → 마켓플레이스로 이동하여 해당 플러그인을 업데이트하거나 제거해 주세요."
            onReset={() => {
              // Refresh plugin views/cards in case the failure was caused by
              // a transient state mismatch. activeView reset to "home" gives
              // the user a clean baseline to navigate from.
              void refreshViews();
              void refreshCards();
              setActiveView("home");
            }}
          >
          <MainContent
            activeView={activeView}
            api={api}
            starred={starred}
            currentSessionId={currentSessionId}
            currentSessionKind={currentSessionKind}
            currentSessionTitle={currentSessionTitle}
            sessions={sessions}
            refreshStarred={refreshStarred}
            onActivateHome={() => setActiveView("home")}
            onJumpToSession={handleLoadSession}
            onRefreshSessions={refreshSessions}
            chatContextValue={chatContextValue}
            onAsk={(q, intent, opts) => handleAsk(q, "default", intent, opts)}
            /* opts 의 inputOrigin / injectHint 가 그대로 handleAsk 4번째
               인자로 전달 — queue-auto inject path 활성. */
            onEditSave={handleEditSave}
            onFork={handleFork}
            onToggleStar={handleToggleStar}
            onRetryEffort={handleRetryEffort}
            isEntryStarred={isEntryStarred}
            onAbort={handleAbort}
            onGuide={handleGuide}
            onGuideError={(msg) => appendSystemEntry(`⚠️ 방향 지시 전송 실패: ${msg}`)}
            onFeedback={handleFeedback}
            subAgentSpawns={subAgentSpawns}
            loadedSkills={loadedSkills}
            hasAskQuestions={askQuestions.length > 0}
            askQuestions={askQuestions}
            onResolveAskQuestion={dismissAskQuestion}
            plugins={pluginEntries}
            onSelectPlugin={handleViewSelect}
            commandActions={commandActions}
            commandPopoverOpen={commandPopoverOpen}
            onCommandPopoverOpenChange={setCommandPopoverOpen}
            installingPlugins={installingPlugins}
            onOpenMarketplace={onOpenMarketplace}
            marketplaceUrlReady={marketplaceUrlReady}
            activePluginView={activePluginView ?? null}
            onPluginPrimaryAction={(id) => { void handlePluginPrimaryAction(id); }}
            onRoutineAcknowledge={handleRoutineAcknowledge}
            onOpenPermissionQueue={() => setDeferredQueueOpen(true)}
          />
          </ErrorBoundary>
        </main>
        </div>
        <StatusBar persistent={statusPersistent} visibleToast={statusVisibleToast} pendingCount={statusPendingCount} onToastClick={handleStatusToastClick} />
      </div>

      {/* ask_user_question cards now render inline inside ChatView
          (immediately after the active turn's entries),
          so the previous App-level FloatingQuestionPanel mount is gone.
          See <AskUserQuestionCard> + ChatView ask-question slot. */}
      <DeferredQueueDialog open={deferredQueueOpen} onOpenChange={setDeferredQueueOpen} />
      <ApprovalDialog queue={approvalQueue} onDecide={handleApprovalDecide} />
      <OnboardingDialog
        open={onboardingOpen}
        onOpenChange={(open) => {
          setOnboardingOpen(open);
          if (!open) void markOnboardingCompleted();
        }}
        onChooseApiKey={() => {
          setOnboardingOpen(false);
          void markOnboardingCompleted();
          onOpenSettings("llm");
        }}
        onChooseLogin={() => {
          setOnboardingOpen(false);
          void markOnboardingCompleted();
          setAppLoginOpen(true);
        }}
      />
      <LoginModal
        api={api}
        vendor={onboardingVendor}
        open={appLoginOpen}
        onOpenChange={setAppLoginOpen}
        onSuccess={() => {
          void checkApiKey();
        }}
      />
      {/* v6: ApprovalQueueStatus floating chip 제거. 큐 정보는 InputActionBar
          trailing 의 DeferredApprovalChip 으로 통합. Spec docs/blueprints/
          composer-redesign-message-queue.md "제거" 섹션. */}
      <DropZoneOverlay />
      <DevConsoleToggle />
      {/* Snap edge highlight — shown when a detached child window enters the snap zone */}
      <SnapEdgeHighlight />
    </OverlayContextProvider>
    </TooltipProvider>
    </ThemeProvider>
    </ErrorBoundary>
  );
}
