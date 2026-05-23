import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
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

// ─── Imports: types / constants / helpers / components / tabs ────────
import { getApi, getPluginViewLabel, toViewKey } from "./api-client.js";
import type { PluginEntry } from "./components/PluginGridButton.js";
import { getPluginInstallAliases } from "./utils/plugin-install-aliases.js";
import { ApprovalDialog } from "./dialogs/ApprovalDialog.js";
import { DeferredQueueDialog } from "./dialogs/DeferredQueueDialog.js";
import { MemorySeedDialog } from "./dialogs/MemorySeedDialog.js";
import { SpotlightTour } from "./components/SpotlightTour.js";
import { PostTourFirstTask } from "./onboarding/PostTourFirstTask.js";
import { ScenarioShowcase } from "./onboarding/ScenarioShowcase.js";
import { PersonalizedWelcome } from "./onboarding/PersonalizedWelcome.js";
import { PluginShowcase } from "./onboarding/PluginShowcase.js";
import {
  initialOnboardingChainState,
  onboardingChainReducer,
  type OnboardingChainStage,
} from "./onboarding/onboarding-chain.js";
import { shouldOpenDemoReactivationOnBoot } from "./onboarding/demo-reactivation-gate.js";
import { LoginModal } from "./components/LoginModal.js";
import { LLM_VENDORS } from "../../shared/llm-vendor-defaults.js";
import { buildQuickActions } from "./components/command-actions.js";
import { MainToolbar } from "./MainToolbar.js";
import { useAppUpdate } from "./hooks/use-app-update.js";
import { useDemoAutoplay } from "./hooks/use-demo-autoplay.js";
import { DemoAutoplayView } from "./components/DemoAutoplayView.js";
import { DevToolsPanel } from "./components/DevToolsPanel.js";
import { MainContent } from "./MainContent.js";
import { StatusBar } from "./components/StatusBar.js";
import { useStatusBar, type NotificationToastMeta } from "./hooks/use-status-bar.js";
import { useSettings } from "./hooks/use-settings.js";
import { lookupBillablePricingOptional } from "../../shared/pricing-data.js";
import { estimateMultimodalTokenOverhead } from "../../shared/multimodal-token-estimate.js";
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
    entries, streaming, isCompacting, compactTriggerSource, isRecoveryExhausted, beginStreamingRequest, finishStreamingRequest, editingEntryIdx, setEditingEntryIdx, editBusy,
    entryIndexToHistoryIndex, handleEditSave, handleRetryEffort, handleContinueFromLastUser,
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
  // Z onboarding chain (2026-05-19) — replaces the previous pair of
  // `onboardingOpen` + `appLoginOpen` flags with an explicit reducer
  // that drives every stage of the first-boot funnel:
  //   idle → showcase → login → welcome → memory → tour → plugins → done
  // The reducer keeps the JSX render branches small (each dialog
  // mounts only when its stage matches) and prevents the race where
  // multiple Radix Dialogs were mounted at once (#982/#990/#997).
  //
  // Initial state is `idle`. The boot probe (below) classifies the
  // boot exactly once and dispatches either `probe-start` → showcase
  // (fresh install, no key, onboarding incomplete) or `probe-skip` →
  // done (returning user). Starting at `idle` instead of `showcase`
  // eliminates the closet-flash race where a true fresh-state boot
  // briefly shows the intro Dialog and then collapses (#1014).
  const [chainState, dispatchChain] = useReducer(
    onboardingChainReducer,
    initialOnboardingChainState,
  );
  const chainStage: OnboardingChainStage = chainState.stage;
  /**
   * ScenarioShowcase carry — which card the user clicked in the first
   * step. Threaded into MemorySeed recommendations and PluginShowcase
   * ordering so the chain is personalised by the user's first choice.
   * `null` means the user reached the chain via skip / returning-user
   * paths and downstream stages should use their default ordering.
   */
  const selectedScenarioId: string | null = chainState.selectedScenarioId;
  // 2026-05-20: PersonalizedWelcome reads its display name + intro
  // straight from the chain's memorySeed context, which `memory-finish`
  // populates from the MemorySeed wizard inputs. No separate state.
  const memorySeedNickname = chainState.memorySeed.nickname;
  const memorySeedIntroduction = chainState.memorySeed.introduction;
  const [deferredQueueOpen, setDeferredQueueOpen] = useState(false);
  // 2026-05-20 — Settings → "데모 자격증명 재입력" 클릭 시 main window 가
  // LoginModal 을 forceActivation=true 로 mount 하도록 하는 flag.
  // `lvis:auth:reactivate-demo` broadcast 가 도착하면 true 로 flip 되고,
  // LoginModal 이 close 되면 false 로 reset.
  const [reactivationOpen, setReactivationOpen] = useState(false);
  // Z chain — `tourCompleted` is derived from the chain reducer. The
  // PostTourFirstTask still receives a boolean prop so its existing
  // contract is unchanged; downstream consumers see `true` only after
  // the SpotlightTour reaches its last step (mapped to chain stage
  // "plugins" or beyond).
  const tourCompleted =
    chainStage === "plugins" || chainStage === "done";
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

  // Role preset, cost preview, multimodal attachments
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
        const loaded = await sessionLoad(sessionId, streaming, applyLoadedSession);
        if (loaded !== false) await refreshSessions();
        return loaded;
      } catch (err) {
        console.warn("[lvis] openRoutineSession failed:", (err as Error).message);
        return false;
      }
    },
    [applyLoadedSession, refreshSessions, sessionLoad, streaming],
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

  const handleLoadSessionAndRefresh = useCallback(async (sessionId: string) => {
    const loaded = await handleLoadSession(sessionId);
    if (loaded !== false) {
      await refreshSessions();
    }
    return loaded;
  }, [handleLoadSession, refreshSessions]);

  useEffect(() => {
    const unsubscribe = api.window?.onLoadSessionInMain?.((sessionId) => {
      setActiveView("home");
      return handleLoadSessionAndRefresh(sessionId);
    });
    return unsubscribe;
  }, [api, handleLoadSessionAndRefresh]);

  // LLM settings + context budget (single source of truth: src/shared/pricing-data.ts)
  const { llmVendor, llmModel, enableThinkingChat, refresh: refreshLlmSettings, toggleThinking } = useSettings(api);
  const draftAttachmentTokens = useMemo(
    () => estimateMultimodalTokenOverhead(attachments
      .filter((attachment) => attachment.kind === "image")
      .map((attachment) => ({
        type: "image",
        mimeType: attachment.mimeType,
        width: attachment.width,
        height: attachment.height,
        bytes: attachment.bytes,
      }))),
    [attachments],
  );

  const { usedTokens, contextBudget, effectiveBudget, contextOverflowPct, tpmLimit, tpmPct, isTpmOverflow } =
    useContextBudget({ entries, llmVendor, llmModel, draftText: question, draftExtraTokens: draftAttachmentTokens });

  const activePluginView = useMemo(() => pluginViews.find((i) => toViewKey(i) === activeView), [pluginViews, activeView]);

  // Build flat PluginEntry list for InputActionBar plugin grid.
  // `unauthed` is set when the owning plugin declares `manifest.auth` AND its
  // current statusTool result is `kind: "unauthed"`. The grid renders a
  // small 🔒 indicator on those entries so users see the missing-auth state
  // without first opening Settings.
  const pluginEntries = useMemo<PluginEntry[]>(() => {
    const viewEntries: PluginEntry[] = pluginViews.map((view): PluginEntry => {
      const card = pluginCards.find((candidate) => candidate.id === view.pluginId);
      return {
        viewKey: toViewKey(view),
        pluginId: view.pluginId,
        installAliases: getPluginInstallAliases(view.pluginId, card?.installAliases),
        loadStatus: card?.loadStatus,
        preparationStatus: card?.preparationStatus,
        label: getPluginViewLabel(view),
        icon: view.icon,
        iconText: view.iconText,
        unauthed: pluginAuthStatuses.get(view.pluginId)?.kind === "unauthed",
      };
    });
    const viewKeys = new Set(viewEntries.map((entry) => entry.viewKey));
    const preparingCardEntries = pluginCards.flatMap((card) => {
      if (card.loadStatus !== "preparing") return [];
      return (card.uiExtensions ?? [])
        .map((extension): PluginEntry | null => {
          const viewKey = `plugin:${card.id}:${extension.id}`;
          if (viewKeys.has(viewKey)) return null;
          return {
            viewKey,
            pluginId: card.id,
            installAliases: getPluginInstallAliases(card.id, card.installAliases),
            loadStatus: card.loadStatus,
            preparationStatus: card.preparationStatus,
            label: extension.displayName?.trim() || extension.title || card.name,
            icon: card.icon,
            iconText: card.iconText,
            unauthed: false,
          };
        })
        .filter((entry): entry is PluginEntry => entry !== null);
    });
    return [...viewEntries, ...preparingCardEntries];
  }, [pluginViews, pluginAuthStatuses, pluginCards]);

  // Track in-flight plugin installs for the grid overlay spinner.
  const installingPlugins = useInstallingPlugins(api);

  const hasPreparingPlugin = useMemo(() => {
    if (pluginCards.some((card) => card.loadStatus === "preparing")) return true;
    return Array.from(installingPlugins.values()).some((phase) => phase === "preparing");
  }, [installingPlugins, pluginCards]);

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

  const refreshPluginSurfaces = useCallback(() => {
    void refreshCards();
    void refreshViews();
  }, [refreshCards, refreshViews]);

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

  // Z onboarding chain — first-boot probe.
  //
  // Runs once on mount: when the user already has a vendor key or the
  // onboardingCompleted flag is set, the chain stays at `idle` and
  // resolves directly to `done`. Otherwise the reducer advances to
  // `showcase` which mounts the ScenarioShowcase intro screen. All
  // subsequent transitions are driven by user actions on the in-chain
  // dialogs (NOT by additional IPC probes), so the funnel is fully
  // deterministic and easy to reason about.
  // `bootProbeGen` is the explicit re-run gate. Initial mount fires the
  // probe once at gen=0; the logout broadcast bumps the generation so the
  // same effect re-evaluates `onboardingCompleted` / vendor keys on top of
  // the freshly-cleared state. Without this the original `firstBootProbedRef`
  // boolean gate (now removed) prevented logout from re-entering the
  // ScenarioShowcase.
  const [bootProbeGen, setBootProbeGen] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // Populate `hasApiKey` state up-front so the downstream
        // `effectiveHasApiKey` mask can resolve to a concrete boolean
        // the moment the chain advances to `done`. Without this the
        // boot probe only dispatched chain events; `hasApiKey` stayed
        // `null` until the user opened+saved Settings, producing the
        // "로그인된 척" race (#1014 tracer Stage B).
        void checkApiKey();
        const settings = await api.getSettings();
        if (cancelled) return;
        const demoStatus = await api.demo.status().catch(() => null);
        if (cancelled) return;
        if (shouldOpenDemoReactivationOnBoot(settings, demoStatus)) {
          dispatchChain({ type: "probe-skip" });
          setReactivationOpen(true);
          return;
        }
        if (settings.features?.onboardingCompleted === true) {
          dispatchChain({ type: "probe-skip" });
          return;
        }
        const anyKey = await Promise.all(
          LLM_VENDORS.map((v) => api.hasApiKey(v).catch(() => false)),
        );
        if (cancelled) return;
        if (anyKey.some(Boolean)) {
          // Existing-install flow — skip the whole Z chain so returning
          // users are never prompted to re-seed identity.
          dispatchChain({ type: "probe-skip" });
          return;
        }
        dispatchChain({ type: "probe-start" });
      } catch {
        // Probe failure is non-fatal — chat still works once a key exists.
        dispatchChain({ type: "probe-skip" });
      }
    })();
    return () => { cancelled = true; };
  }, [api, checkApiKey, bootProbeGen]);

  const markOnboardingCompleted = useCallback(async () => {
    try {
      await api.updateSettings({ features: { onboardingCompleted: true } });
    } catch {
      // Persist failure is non-fatal; the dialog still dismisses for the
      // current session even if the disk write fails.
    }
  }, [api]);

  // Z onboarding chain — persist completion + auto-trigger SpotlightTour.
  // Side-effects driven by the reducer state:
  //   - tour stage:    fan the host's tour broadcast so SpotlightTour
  //                    mounts the first-boot scenario without depending
  //                    on MemorySeedDialog firing the trigger itself.
  //   - done stage:    flip `features.onboardingCompleted=true` once so
  //                    the next boot skips the entire chain (idempotent
  //                    via the markOnboardingCompleted helper above).
  //
  // Both side-effects are guarded by a per-run ref so React 18 StrictMode's
  // double-invoked dev-mode effects (mount → cleanup → mount) cannot
  // broadcast `tour.start` twice — without the guard the second mount
  // re-fires the IPC, which re-enters the SpotlightTour subscriber and
  // visibly resets the scenario to step 0 ("스팟하이라이트 시퀀스가 2번 노출"
  // — user report 2026-05-19). The ref also protects against incidental
  // re-renders that change `api` / `markOnboardingCompleted` while
  // `chainStage === "tour"` stays pinned.
  const chainCompletionPersistedRef = useRef(false);
  const chainTourBroadcastRef = useRef(false);
  useEffect(() => {
    if (chainStage === "tour") {
      if (chainTourBroadcastRef.current) return;
      chainTourBroadcastRef.current = true;
      try {
        void api.tour.start("first-boot-essentials");
      } catch {
        // tour.start failure is non-fatal — user can still reach the
        // PluginShowcase via the SpotlightTour onComplete callback path
        // by pressing 다음 from within the tour.
      }
      return;
    }
    if (chainStage === "done" && !chainCompletionPersistedRef.current) {
      chainCompletionPersistedRef.current = true;
      void markOnboardingCompleted();
    }
  }, [api, chainStage, markOnboardingCompleted]);

  // Live Auto-play (proposal: docs/architecture/proposals/live-autoplay.md).
  // Activates for returning users (onboardingCompleted=true) only when the
  // host reports captured demo activation through `lvis:demo:status`.
  // `features.demoAutoplayEnabled=false` is the explicit opt-out. On a fresh
  // install the demo is gated behind onboarding so the ScenarioShowcase chain
  // is always shown first — see `shouldActivateDemoAutoplay`
  // (engine/demo-autoplay/types.ts §7) for the truth table.
  const demoAutoplay = useDemoAutoplay(api);
  // When the demo is active we collapse the rest of the Z chain because the
  // demo is a returning-user re-engage surface. `onFinished` only disables
  // future autoplay; onboardingCompleted is set solely by explicit chain
  // completion. Exceptions:
  //   - `idle` / `done`: no chain to collapse.
  //   - `showcase`: the user has started seeing the ScenarioShowcase
  //     intro. Demo MUST NOT yank it out from under them — if both
  //     somehow fired together (e.g. flag flipped mid-boot), we keep the
  //     showcase visible and let the demo abort path retire itself when
  //     the user dismisses or completes showcase.
  useEffect(() => {
    if (
      demoAutoplay.turn &&
      chainStage !== "done" &&
      chainStage !== "idle" &&
      chainStage !== "showcase"
    ) {
      dispatchChain({ type: "force-finish" });
    }
  }, [demoAutoplay.turn, chainStage]);
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

  // 2026-05-20 — Settings 의 로그아웃 / 데모 자격증명 재입력 broadcast 수신.
  //
  // 로그아웃 cue:
  //   1. chain reducer 에 `logout-reset` dispatch → 모든 stage 가 `idle` 로 collapse
  //   2. boot-probe ref 를 리셋해 onboardingCompleted=false 가 다시 평가됨
  //   3. side-effect ref (`chainTourBroadcastRef`, `chainCompletionPersistedRef`)
  //      도 reset 해서 재진입 chain 의 tour broadcast / completion persist 가
  //      한 번씩 다시 동작 가능하게 됨
  //   4. `hasApiKey` 를 다시 평가
  //
  // 재입력 cue:
  //   LoginModal 을 `forceActivation=true` 로 mount.
  useEffect(() => {
    // 일부 test fixture 가 `api.auth` 의 broadcast 메서드를 mock 하지 않으므로
    // optional chaining 으로 graceful degradation. production preload 는 항상
    // 두 메서드를 정의하고, undefined 일 때는 listener 만 비활성 (전체 effect 가
    // throw 하지 않는다).
    const unsubLogout = api.auth?.onLogoutReset?.(() => {
      dispatchChain({ type: "logout-reset" });
      chainTourBroadcastRef.current = false;
      chainCompletionPersistedRef.current = false;
      // Bump the boot-probe generation so the existing probe effect re-runs
      // against the now-cleared settings (`onboardingCompleted=false`) and
      // wipes-clear vendor keys. Without this the chain would stay at `idle`
      // forever because `dispatchChain({logout-reset})` collapses to idle
      // but no follow-up `probe-start` ever fires.
      setBootProbeGen((g) => g + 1);
      void checkApiKey();
    });
    const unsubReactivate = api.auth?.onReactivateDemo?.(() => {
      setReactivationOpen(true);
    });
    return () => {
      unsubLogout?.();
      unsubReactivate?.();
    };
  }, [api, checkApiKey]);

  // Tutorial-C SpotlightTour trigger (PR #983 follow-up). ⌘+Shift+/ ("⌘?")
  // is the canonical "help" shortcut on macOS; on Windows/Linux Ctrl+Shift+/
  // serves the same role. The handler fires `api.tour.start` which fans the
  // `lvis:tour:start` IPC broadcast out to every open window — including
  // detached panes — so the SpotlightTour component (always mounted in
  // App.tsx) flips on. Guarded against open dialogs so the shortcut never
  // races a modal interaction.
  //
  // F4 — demo↔tour mutex: when the Live Auto-play demo is mid-turn the
  // shortcut is a no-op. The Spotlight engine would otherwise paint a
  // backdrop on top of the demo overlay, breaking the scripted flow.
  // We capture the demo turn in a ref so the handler stays stable, and
  // mirror the flag onto `document.body[data-demo-active]` so the
  // SpotlightTour component (which listens to IPC `tour:start` broadcasts
  // independent of this shortcut) can also self-guard.
  const demoActiveRef = useRef<boolean>(false);
  useEffect(() => {
    demoActiveRef.current = demoAutoplay.turn !== null;
    if (typeof document !== "undefined") {
      if (demoActiveRef.current) {
        document.body.setAttribute("data-demo-active", "true");
      } else {
        document.body.removeAttribute("data-demo-active");
      }
    }
  }, [demoAutoplay.turn]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "?" && e.key !== "/") return;
      if (!(e.metaKey || e.ctrlKey)) return;
      if (!e.shiftKey) return;
      if (e.isComposing) return;
      if (
        document.querySelector(
          '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]',
        )
      ) {
        return;
      }
      // F4 — demo↔tour mutex: while the demo is running, swallow the
      // help-shortcut so the Spotlight tour can't fire on top of the
      // scripted overlay.
      if (demoActiveRef.current) {
        e.preventDefault();
        return;
      }
      e.preventDefault();
      void api.tour.start("first-boot-essentials");
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [api]);

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
          setQuestion("");
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
    () => lookupBillablePricingOptional(llmVendor, llmModel),
    [llmVendor, llmModel],
  );

  const handleNewChat = useCallback(async () => {
    if (streaming) { console.warn("new chat blocked during streaming"); return; }
    await api.chatNew();
    clearForNewChat();
    resetForNewSession();
    setActiveView("home");
    await refreshSessionId();
    await refreshSessions();
  }, [api, streaming, refreshSessionId, refreshSessions, clearForNewChat, resetForNewSession]);

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

  useEffect(() => {
    if (typeof api.onPluginInstallProgress !== "function") return;
    const unsubscribe = api.onPluginInstallProgress((payload) => {
      if (payload.phase !== "preparing") return;
      void refreshCards();
      void refreshViews();
    });
    return unsubscribe;
  }, [api, refreshViews, refreshCards]);

  useEffect(() => {
    if (!hasPreparingPlugin) return;
    const refresh = () => {
      void refreshCards();
      void refreshViews();
    };
    refresh();
    const interval = window.setInterval(refresh, 750);
    return () => window.clearInterval(interval);
  }, [hasPreparingPlugin, refreshViews, refreshCards]);

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
  //
  // Mask `hasApiKey === false` while the onboarding chain is still in
  // progress so the "Claude API 키 설정 필요" empty state never paints
  // underneath the Z chain dialogs. The chain itself is the canonical
  // first-boot CTA; surfacing a competing empty state below it leaks
  // through the Radix Dialog backdrop and confuses the user (the bug
  // this fix resolves). Returning users with `chainStage === "done"`
  // (probe-skip or chain completion) still see the empty state when
  // they remove their key from Settings, so the safety-net behaviour
  // for that path is preserved.
  // Tracer Stage B race fix (#1014): only surface the boolean when BOTH
  // (a) the Z chain has finished AND (b) the boot probe has resolved
  // `hasApiKey` to a concrete boolean. Any other state — chain still
  // running, or probe still pending — returns `null` so downstream
  // empty-state branches stay in their loading shape. This prevents the
  // "로그인된 척" race where chain advanced to `done` but `hasApiKey`
  // hadn't been populated yet, letting `hasApiKey !== false` falsely
  // paint the ready-state empty prompt.
  const effectiveHasApiKey: boolean | null =
    chainStage === "done" && hasApiKey !== null ? hasApiKey : null;
  const chatContextValue = useChatContextValue({
    entries, streaming, editingEntryIdx, setEditingEntryIdx, editBusy,
    question, setQuestion, chatEndRef, currentSessionId, hasApiKey: effectiveHasApiKey, onOpenSettings,
    searchOpen, searchQuery, searchCase, searchMatches, searchMatchSet, searchIdx, searchHighlight,
    searchChangeQuery, searchToggleCase, searchNext, searchPrev, searchCloseOverlay, searchToggleOverlay,
    contextOverflowPct, usedTokens, contextBudget, effectiveBudget,
    tpmLimit, tpmPct, isTpmOverflow,
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
  // Issue #916: force-recover (autoCompact OFF-override) shows a distinct label.
  useEffect(() => {
    const COMPACT_ITEM_ID = "auto-compact-in-progress";
    if (isCompacting) {
      const isForceRecover = compactTriggerSource === "force-recover";
      statusUpsertPersistent({
        id: COMPACT_ITEM_ID,
        severity: isForceRecover ? "warning" : "info",
        label: "컨텍스트",
        value: isForceRecover
          ? "자동 압축을 끄셨지만, context 한도 복구를 위해 1회 압축했습니다"
          : "자동 압축 중...",
      });
    } else {
      statusRemovePersistent(COMPACT_ITEM_ID);
    }
  }, [isCompacting, compactTriggerSource, statusUpsertPersistent, statusRemovePersistent]);

  // Issue #917: show a persistent warning banner when force-recover budget is exhausted.
  // Cleared when the user starts a new chat (clearForNewChat resets isRecoveryExhausted).
  useEffect(() => {
    const EXHAUSTED_ITEM_ID = "recovery-exhausted";
    if (isRecoveryExhausted) {
      statusUpsertPersistent({
        id: EXHAUSTED_ITEM_ID,
        severity: "error",
        label: "압축 실패",
        value: "압축으로 복구 불가 — 모델 변경 또는 새 대화를 시작하세요",
      });
    } else {
      statusRemovePersistent(EXHAUSTED_ITEM_ID);
    }
  }, [isRecoveryExhausted, statusUpsertPersistent, statusRemovePersistent]);

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
            hasApiKey={effectiveHasApiKey}
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
                const loaded = await handleLoadSessionAndRefresh(sessionId);
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
            onJumpToSession={handleLoadSessionAndRefresh}
            onRefreshSessions={refreshSessions}
            chatContextValue={chatContextValue}
            onAsk={(q, intent, opts) => handleAsk(q, "default", intent, opts)}
            /* opts 의 inputOrigin / injectHint 가 그대로 handleAsk 4번째
               인자로 전달 — queue-auto inject path 활성. */
            onEditSave={handleEditSave}
            onFork={handleFork}
            onToggleStar={handleToggleStar}
            onRetryEffort={handleRetryEffort}
            onContinueFromLastUser={handleContinueFromLastUser}
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
            onRefreshPlugins={refreshPluginSurfaces}
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
      {demoAutoplay.turn && (
        <div
          data-testid="demo-autoplay-overlay"
          className="fixed inset-0 z-[10000] flex items-stretch justify-center bg-background/95 backdrop-blur-sm"
          role="dialog"
          aria-label="LVIS Live Auto-play demo"
        >
          <div className="m-4 flex w-full max-w-[460px] flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
            <DemoAutoplayView
              turn={demoAutoplay.turn}
              onFinished={demoAutoplay.onFinished}
              onAuditEvent={demoAutoplay.emitAuditEvent}
            />
          </div>
        </div>
      )}
      <DeferredQueueDialog open={deferredQueueOpen} onOpenChange={setDeferredQueueOpen} />
      <ApprovalDialog queue={approvalQueue} onDecide={handleApprovalDecide} />
      {/* Z onboarding chain — staged sequence of dialogs.
          The chain reducer guarantees only one of these dialogs is
          ever mounted at a time, so the historical multi-Dialog
          race (#982/#990/#997) cannot recur. */}
      <ScenarioShowcase
        open={chainStage === "showcase"}
        onStart={(scenarioId) =>
          dispatchChain({ type: "showcase-start", scenarioId })
        }
      />
      <LoginModal
        api={api}
        open={chainStage === "login"}
        onOpenChange={(next) => {
          if (chainStage !== "login") return;
          if (!next) {
            // Radix closed the dialog — treat any close that didn't
            // already advance the chain as a user-initiated skip.
            dispatchChain({ type: "login-skip" });
          }
        }}
        onSuccess={() => {
          void checkApiKey();
          dispatchChain({ type: "login-success" });
        }}
      />
      {/* 2026-05-20 — Settings 의 "데모 자격증명 재입력" entry. onboarding
          chain 과는 독립된 modal — 사용자가 이미 onboarding 을 끝낸
          returning user 의 *자발적 재입력 path*. LoginModal 의 forceActivation
          prop 으로 chip 1/2/3 surface 를 우회하고 곧장 activation 입력
          page 를 mount 한다. */}
      <LoginModal
        api={api}
        open={reactivationOpen}
        forceActivation
        onOpenChange={(next) => {
          if (!next) setReactivationOpen(false);
        }}
        onSuccess={() => {
          void checkApiKey();
          setReactivationOpen(false);
        }}
      />
      {/* Tutorial-B (O-X2) — Memory Seed Onboarding Wizard. 2026-05-20:
          MemorySeed now mounts BEFORE the welcome card so the typed
          호칭/자기소개 can personalize the welcome greeting that follows.
          The chain reducer drives `open` from stage "memory" only;
          `onDismissed` advances the chain to "personalized_welcome".

          The wrapper below intentionally swallows MemorySeed's own
          `startTour()` IPC so the chain-effect on stage="tour" remains
          the single canonical broadcaster (preserves the #1029 fix). */}
      <MemorySeedDialog
        open={chainStage === "memory"}
        selectedScenarioId={selectedScenarioId}
        onOpenChange={(next) => {
          if (chainStage !== "memory") return;
          if (!next) {
            // Radix-side close. The MemorySeed's own onDismissed
            // already fires for Submit / Skip; this branch covers the
            // Esc / outside-click paths.
            dispatchChain({ type: "memory-finish" });
          }
        }}
        api={{
          ...api,
          tour: {
            ...api.tour,
            // Swallow the MemorySeed's internal tour.start fire — the
            // Z chain effect on stage="tour" already broadcasts the
            // canonical scenario. Double-broadcast would reset the
            // SpotlightTour to step 0 visibly.
            start: async () => ({ ok: true as const, scenarioId: "first-boot-essentials" }),
          },
        } as typeof api}
        onDismissed={() => {
          // Read the typed 호칭/자기소개 from the DOM at the dismissal
          // frame and feed them into the chain reducer so the
          // PersonalizedWelcome card can address the user by name.
          // The MemorySeed wizard's own write to MEMORY.md is unaffected
          // (it runs inside the wizard before this callback fires).
          let nickname = "";
          let introduction = "";
          if (typeof document !== "undefined") {
            const nameEl = document.querySelector<HTMLInputElement>(
              '[data-testid="memory-seed-dialog:name"]',
            );
            const introEl = document.querySelector<HTMLTextAreaElement>(
              '[data-testid="memory-seed-dialog:intro"]',
            );
            nickname = nameEl?.value?.trim() ?? "";
            introduction = introEl?.value?.trim() ?? "";
          }
          dispatchChain({
            type: "memory-finish",
            nickname,
            introduction,
          });
        }}
      />
      {/* PersonalizedWelcome (2026-05-20) — replaces WelcomeQuestion.
          Mounted after MemorySeed so the card greets the user by the
          호칭 they just typed and references their 자기소개. Forced
          choice — there is no skip; pressing "예, 시작할게요 →" is
          the only path forward. The card also pings the LLM provider
          on mount and surfaces vendor/model/latency inline as a
          connection-confirmation cue. */}
      <PersonalizedWelcome
        open={chainStage === "personalized_welcome"}
        nickname={memorySeedNickname}
        introduction={memorySeedIntroduction}
        api={{ pingAiProvider: api.pingAiProvider }}
        onContinue={() =>
          dispatchChain({ type: "personalized-welcome-accept" })
        }
      />
      {/* Tutorial-C — SpotlightTour mounts always; it stays invisible until
          a `lvis:tour:start` broadcast flips it on. Production trigger:
          ⌘+Shift+/ (macOS "⌘?" help shortcut) / Ctrl+Shift+/ — see the
          useEffect above. State lives in `~/.lvis/onboarding/`. The
          `onComplete` callback fires only when the user reaches the
          final tour step (not on early-dismissal); the Z chain
          dispatches `tour-finish` so PluginShowcase mounts next. */}
      <SpotlightTour
        api={api}
        onComplete={() => {
          if (chainStage === "tour") dispatchChain({ type: "tour-finish" });
        }}
        onDismiss={() => {
          if (chainStage === "tour") dispatchChain({ type: "tour-skip" });
        }}
      />
      {/* Z onboarding chain — PluginShowcase. Mounted only at stage
          "plugins"; carries the host's installed pluginCards so each
          card reflects what the user actually has. Closing the
          showcase finishes the chain (state → done) and the
          markOnboardingCompleted side-effect persists the flag. */}
      <PluginShowcase
        open={chainStage === "plugins"}
        installedPluginIds={pluginCards.map((c) => c.id)}
        api={api}
        onClose={() => dispatchChain({ type: "plugins-close" })}
        prioritizedScenarioId={selectedScenarioId}
      />
      {/* Tutorial-X5 — Post-tour first-task proposal. Mounts always,
          stays invisible until the user finishes a tour AND at least one
          installed plugin has a registered proposal in first-task-proposals.
          The composerSeedText callback writes directly to the chat
          composer state setter so the user is one click away from a real
          plugin invocation — no hidden IPC. */}
      <PostTourFirstTask
        api={{
          composerSeedText: (text: string) => {
            setQuestion(text);
          },
        }}
        installedPluginIds={pluginCards.map((c) => c.id)}
        tourCompleted={tourCompleted}
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
