import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "../../i18n/react.js";
import { composeOutgoing as composeOutgoingUtil } from "./utils/compose.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { AppProviders } from "./AppProviders.js";
import { AppDialogs } from "./AppDialogs.js";
import { AppShell } from "./AppShell.js";

// ─── Imports: types / constants / helpers / components / tabs ────────
import { getApi, getPluginViewLabel, toViewKey } from "./api-client.js";
import type { PluginEntry } from "./components/PluginGridButton.js";
import { getPluginInstallAliases } from "./utils/plugin-install-aliases.js";
import { summarizePluginReadiness } from "./onboarding/first-run-readiness.js";
import { buildQuickActions } from "./components/command-actions.js";
import { useAppUpdate } from "./hooks/use-app-update.js";
import { useAppMode } from "./hooks/use-app-mode.js";
import { useRoutineOverlay } from "./hooks/use-routine-overlay.js";
import { useSendMessage } from "./hooks/use-send-message.js";
import { usePluginViewRouting } from "./hooks/use-plugin-view-routing.js";
import { useOnboardingChainController } from "./hooks/use-onboarding-chain-controller.js";
import { usePluginLifecycleRefresh } from "./hooks/use-plugin-lifecycle-refresh.js";
import { useChatStatusIndicators } from "./hooks/use-chat-status-indicators.js";
import { MainContent } from "./MainContent.js";
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
import { useMarketplaceAnnouncements } from "./hooks/use-marketplace-announcements.js";
import { useBootstrapStatus } from "./hooks/use-bootstrap-status.js";
import { usePluginMarketplace } from "./hooks/use-plugin-marketplace.js";
import { usePluginAuthStatuses } from "./hooks/use-plugin-auth-status.js";
import type { Attachment } from "./types/attachments.js";
import { useRolePresets } from "./hooks/use-role-presets.js";
import { useAppBootstrap } from "./hooks/use-app-bootstrap.js";
import { useWindowFileDropGuard } from "./hooks/use-window-file-drop-guard.js";
import { useChatActions } from "./hooks/use-chat-actions.js";
import { useChatContextValue } from "./hooks/use-chat-context-value.js";
import { useWorkflowTools } from "./hooks/use-workflow-tools.js";
import { useMarketplaceUrl } from "./hooks/use-marketplace-url.js";
import type { UserKeyboardIntentSnapshot } from "../../shared/chat-origin.js";
import { normalizeSettingsTab } from "../../shared/settings-tabs.js";
import type { ProjectIdentity } from "../../shared/project-identity.js";
import {
  defaultProjectFromProjects,
  projectIdentityFromPayload,
  projectRootEquals,
  workspaceRootsToProjects,
} from "../../shared/project-identity.js";

// ─── App ────────────────────────────────────────────

export function App() {
  const { t } = useTranslation();
  const api = useMemo(() => getApi(), []);

  // Block default file:// navigation when a file is dropped onto the window
  // (the drag-drop indexing feature was removed; this guard is all that remains).
  useWindowFileDropGuard();

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
    clearForNewChat, appendUserEntry, appendSystemEntry, applyInitialSession, applyLoadedSession, truncateToEntry,
    fallbackToast,
    insertImportedTriggerEntry,
  } = useChatState(api);
  // Top chat-area status surface: persistent operational items plus transient
  // toasts. Initialized early because plugin auth selection can emit toasts.
  const {
    persistent: statusPersistent,
    visibleToast: statusVisibleToast,
    pendingCount: statusPendingCount,
    pushToast: statusPushToast,
    removeToast: statusRemoveToast,
    upsertPersistent: statusUpsertPersistent,
    removePersistent: statusRemovePersistent,
  } = useStatusBar({ api });

  // App auto-update badge — surfaces main-process electron-updater events as a
  // permanent badge next to the Home button. User-gated: download/install only
  // run on explicit badge click. Declared after useStatusBar so the unsigned-
  // build manual-install fallback can raise a toast: an unsigned macOS build
  // can't self-install (Squirrel.Mac needs a Developer ID), so the main process
  // opens the release page and signals "manual-install-required" here instead
  // of leaving the badge a dead button.
  const appUpdate = useAppUpdate(api, () => {
    // Unsigned macOS build can't self-install (Squirrel.Mac needs a Developer
    // ID); the main process opened the LVIS homepage, which hosts the manual
    // update guide. Tell the user to finish up, quit, then update per the guide.
    statusPushToast({
      severity: "warning",
      message: t("app.manualInstallRequiredToast"),
      ttlMs: 20000,
    });
  });

  const [question, setQuestion] = useState("");
  const chatEndRef = useRef<HTMLDivElement>(null);
  // Forward-ref cycle bridge — App OWNS this ref and passes it to both hooks:
  // use-send-message WRITES it (handleAskRef.current = handleAsk each render) and
  // use-routine-overlay's handlePluginPrimaryAction READS it to start a
  // trigger-import turn. Keeping the ref in App (rather than inline-breaking the
  // cycle) is what lets the two hooks reference each other safely.
  const handleAskRef = useRef<(
    q: string,
    mode?: "default" | "trigger-import",
    userIntent?: UserKeyboardIntentSnapshot,
  ) => Promise<void>>(
    async () => { /* populated below */ },
  );

  // App state
  // Z onboarding chain controller — owns hasApiKey, the chain reducer, the
  // demo-reactivation flag, the boot-probe generation, and the four onboarding
  // effects (boot probe / completion+tour broadcast / logout+reactivate /
  // ⌘?-shortcut). Surfaces effectiveHasApiKey (the chain-masked key state) and
  // checkApiKey. See use-onboarding-chain-controller.ts.
  const {
    chainStage,
    dispatchChain,
    selectedScenarioId,
    memorySeedNickname,
    memorySeedIntroduction,
    tourCompleted,
    checkApiKey,
    effectiveHasApiKey,
    reactivationOpen,
    setReactivationOpen,
  } = useOnboardingChainController(api);
  const [deferredQueueOpen, setDeferredQueueOpen] = useState(false);
  const [activeView, setActiveView] = useState("home");
  // Inline-settings (work mode): which tab SettingsContent opens on, and the
  // view to return to via the back-to-home affordance. In chat mode Settings
  // detaches to its own BrowserWindow instead (see onOpenSettings), so these
  // only drive the work-mode activeView==="settings" inline render.
  const [settingsTab, setSettingsTab] = useState("general");
  const settingsReturnViewRef = useRef("home");
  // Workspace mode (Chat / Work) + coupled shell layout state. appMode is the
  // SOLE authority for inline-vs-detached; the hook owns the seed-before-paint
  // state, the no-op-guarded persistence, and the three appMode-transition
  // effects (rail-width coupling, resizeForMode, closeAllDetached). See
  // use-app-mode.ts.
  const {
    appMode, setAppMode,
    sidebarCollapsed, setSidebarCollapsed,
    actionPanelOpen, setActionPanelOpen,
    sidePanelOpen, setSidePanelOpen,
  } = useAppMode(api);
  const [commandPopoverOpen, setCommandPopoverOpen] = useState(false);
  const [devToolsOpen, setDevToolsOpen] = useState(false);
  const [workspaceProjects, setWorkspaceProjects] = useState<ProjectIdentity[]>([]);
  const [activeProject, setActiveProject] = useState<ProjectIdentity | undefined>(undefined);

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
  const {
    updates: marketplaceUpdates,
    dismiss: dismissMarketplaceUpdates,
    skip: skipMarketplaceUpdates,
  } = useMarketplaceUpdates(api);
  const { announcements: marketplaceAnnouncements, dismiss: dismissMarketplaceAnnouncement } = useMarketplaceAnnouncements(api);
  const { status: bootstrapStatus, dismiss: dismissBootstrapStatus, retry: retryBootstrap } = useBootstrapStatus(api);
  const { queue: approvalQueue, decide: handleApprovalDecide } = useApproval();

  // Routine + plugin-overlay IPC pipeline. Owns runningRoutines, the addFireRef
  // surfaced to OverlayContextProvider (populated during that provider's render),
  // the overlay lookup map, and the routine/overlay IPC subscriptions. The
  // forward-ref cycle is preserved: handlePluginPrimaryAction reads handleAskRef
  // (App-owned, written by use-send-message). See use-routine-overlay.ts.
  const {
    addFireRef,
    runningRoutines,
    handlePluginPrimaryAction,
    handleRoutineAcknowledge,
  } = useRoutineOverlay({ api, t, insertImportedTriggerEntry, handleAskRef });

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
  const { statuses: pluginAuthStatuses, refresh: refreshPluginAuthStatus } = usePluginAuthStatuses(api, pluginCards);

  // Role preset, cost preview, multimodal attachments
  const { rolePresets, activePreset, activePresetId, setActivePresetId } = useRolePresets(api);
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
    currentSessionProject,
    handleLoadSession: sessionLoad, handleFork: sessionFork,
  } = useSessions(api, applyInitialSession);
  const attachmentSessionScopeRef = useRef<{ initialized: boolean; sessionId?: string }>({
    initialized: false,
    sessionId: undefined,
  });

  useEffect(() => {
    const scope = attachmentSessionScopeRef.current;
    if (!scope.initialized) {
      scope.initialized = true;
      scope.sessionId = currentSessionId;
      return;
    }
    if (scope.sessionId === currentSessionId) return;
    scope.sessionId = currentSessionId;
    setAttachments([]);
  }, [currentSessionId]);

  useEffect(() => {
    let cancelled = false;
    void window.lvis?.workspace?.listRoots?.().then((result) => {
      if (cancelled || !result?.ok) return;
      const roots = Array.isArray(result.roots) ? result.roots : [];
      const projects = workspaceRootsToProjects(result.defaultRoot, roots, t("sidebar.currentProject"));
      setWorkspaceProjects(projects);
      setActiveProject((current) => current ?? defaultProjectFromProjects(projects));
    }).catch(() => {
      // The backend still defaults chat creation to the anchored workspace root.
    });
    return () => {
      cancelled = true;
    };
  }, [t]);

  const resolveKnownProject = useCallback((project: ProjectIdentity | undefined): ProjectIdentity | undefined => {
    if (!project) return undefined;
    return workspaceProjects.find((candidate) => projectRootEquals(candidate.projectRoot, project.projectRoot)) ?? project;
  }, [workspaceProjects]);

  useEffect(() => {
    const sessionProject = projectIdentityFromPayload(currentSessionProject);
    if (sessionProject) setActiveProject(resolveKnownProject(sessionProject));
  }, [currentSessionProject, resolveKnownProject]);

  const defaultWorkspaceProject = useMemo(
    () => defaultProjectFromProjects(workspaceProjects),
    [workspaceProjects],
  );

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

  // Plugin/built-in view routing + host-managed plugin auth lifecycle (the 4
  // auth-gate refs + action guard + pluginAuthErrors + the two drain effects +
  // the uninstalled-plugin fallback), extracted as ONE unit. appMode is the sole
  // authority for inline-vs-detached; the hook only reads it. See
  // use-plugin-view-routing.ts.
  const { handleViewSelect, activePluginView, activePluginAuthError } = usePluginViewRouting({
    api, t, appMode, activeView, setActiveView,
    pluginViews, pluginCards, pluginAuthStatuses, refreshPluginAuthStatus,
    setErrorWithThought, statusPushToast,
  });

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

  const firstRunPluginSummary = useMemo(
    () => summarizePluginReadiness(pluginCards),
    [pluginCards],
  );

  // Marketplace URL — sourced from settings (marketplace.cloudBaseUrl).
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

  useEffect(() => {
    if (typeof api.onNotificationClicked !== "function") return undefined;
    return api.onNotificationClicked((payload) => {
      const contextRef = payload.contextRef;
      if (contextRef?.sessionId) {
        setActiveView("home");
        void handleLoadSessionAndRefresh(contextRef.sessionId);
        return;
      }
      if (payload.kind === "approval" || contextRef?.approvalId) {
        setActiveView("home");
        if (approvalQueue.length === 0) setDeferredQueueOpen(true);
        return;
      }
      if (payload.kind === "routine" || contextRef?.routineId) {
        handleViewSelect("routines");
        return;
      }
      if (payload.kind === "ask-user" || contextRef?.questionId) {
        setActiveView("home");
        return;
      }
      setActiveView("home");
    });
  }, [api, approvalQueue.length, handleLoadSessionAndRefresh, handleViewSelect]);

  // Inline settings exists only in work mode. Switching to chat mode while it
  // is open returns to home so chat mode's detached-Settings contract holds (a
  // subsequent sidebar Settings click then opens the detached BrowserWindow).
  useEffect(() => {
    if (appMode === "chat" && activeView === "settings") {
      setActiveView(settingsReturnViewRef.current === "settings" ? "home" : settingsReturnViewRef.current);
    }
  }, [appMode, activeView]);

  // appMode is the SOLE authority for inline-vs-detached, mirroring the other
  // views (업무보드/루틴/메모리/별표 + plugin views). In work mode Settings
  // joins that inline pattern: setActiveView("settings") + MainContent renders
  // SettingsContent inline. In chat mode Settings keeps the existing detached
  // BrowserWindow path untouched. Re-selecting Settings while already on the
  // inline view is a no-op (only the tab is refreshed) so the view never
  // re-mounts and loses its place.
  const onOpenSettings = useCallback((tab = "llm") => {
    if (appMode === "chat") {
      void api.openSettingsWindow(tab);
      return;
    }
    setSettingsTab(normalizeSettingsTab(tab));
    setActiveView((current) => {
      // Only capture the return view on the first entry into settings; a
      // re-click while already inline must not overwrite it with "settings".
      if (current !== "settings") settingsReturnViewRef.current = current;
      return "settings";
    });
  }, [api, appMode]);

  const handleCloseInlineSettings = useCallback(() => {
    const target = settingsReturnViewRef.current;
    setActiveView(target === "settings" ? "home" : target);
  }, []);

  // Side panel (ChatSidePanel) is a home-view affordance: navigating away from
  // home closes it so it never lingers behind another view. Toggling from a
  // non-home view first returns to home, then opens the panel.
  useEffect(() => {
    if (activeView !== "home") {
      setSidePanelOpen(false);
    }
  }, [activeView, setSidePanelOpen]);
  const handleToggleSidePanel = useCallback(() => {
    if (activeView !== "home") {
      setActiveView("home");
      setSidePanelOpen(true);
      return;
    }
    setSidePanelOpen((open) => !open);
  }, [activeView, setSidePanelOpen]);

  // Inline settings save → refresh the same live state the detached window's
  // onSettingsWindowSaved listener refreshes (api key + LLM settings), without
  // an IPC round-trip since the content renders in-process.
  const handleInlineSettingsSaved = useCallback(() => {
    void checkApiKey();
    void refreshLlmSettings();
  }, [checkApiKey, refreshLlmSettings]);

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

  // Composer send pipeline. Owns handleAsk (+ its turnRequestRef guard) and
  // writes handleAskRef.current each render so the forward-ref cycle with
  // use-routine-overlay's handlePluginPrimaryAction stays live. See
  // use-send-message.ts.
  const { handleAsk } = useSendMessage({
    api, t, streaming, checkApiKey, composeOutgoing,
    appendUserEntry, resetStreamAccumulators, beginStreamingRequest, finishStreamingRequest,
    setErrorWithThought, handleCompactCommand, sessionLoad, applyLoadedSession,
    refreshSessionId, refreshSessions, attachments, setAttachments,
    llmVendor, llmModel, onOpenSettings, setQuestion, handleAskRef,
  });

  const { costEstimate, costBadgeClass } =
    useCostEstimate({ entries, question, llmVendor, llmModel, maxOutputTokens, composeOutgoing });
  // Strict variant — `undefined` means "model not in catalog" so the cost
  // toggle in TokenCostBadge stays disabled rather than showing $0 from
  // FALLBACK_PRICING.
  const activePricing = useMemo(
    () => lookupBillablePricingOptional(llmVendor, llmModel),
    [llmVendor, llmModel],
  );

  const handleNewChat = useCallback(async (project?: { projectRoot?: string; projectName?: string }) => {
    if (streaming) { console.warn("new chat blocked during streaming"); return; }
    const nextProject = resolveKnownProject(projectIdentityFromPayload(project)) ?? activeProject ?? defaultWorkspaceProject;
    await api.chatNew(nextProject
      ? { projectRoot: nextProject.projectRoot, projectName: nextProject.projectName }
      : undefined);
    if (nextProject) setActiveProject(nextProject);
    clearForNewChat();
    resetForNewSession();
    setActiveView("home");
    await refreshSessionId();
    await refreshSessions();
  }, [activeProject, api, clearForNewChat, defaultWorkspaceProject, refreshSessionId, refreshSessions, resetForNewSession, resolveKnownProject, streaming]);

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
    api, refreshViews, refreshCards: async () => { await refreshCards(); }, checkApiKey,
    setActiveView,
    toggleCommandPopover,
  });
  // Plugin/agent/skill lifecycle → catalog refresh. Owns the in-flight install
  // tracker + every IPC subscription that keeps plugin views/cards/marketplace
  // fresh (install/uninstall/runtime/progress broadcasts, the preparing-plugin
  // poll, agent/skill install results). See use-plugin-lifecycle-refresh.ts.
  usePluginLifecycleRefresh({ api, pluginCards, refreshViews, refreshCards, refreshMarketplace });

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
  const onNewChatForProject = useCallback((project: { projectRoot?: string; projectName?: string }) => {
    void handleNewChat(project);
  }, [handleNewChat]);
  const handleMarketplaceAnnouncementDismiss = useCallback(
    (id: number) => {
      dismissMarketplaceAnnouncement(id).catch((err) => {
        console.error(
          "[marketplace-announcement] dismiss persistence failed",
          err,
        );
      });
    },
    [dismissMarketplaceAnnouncement],
  );

  // ChatView context bundle — avoids drilling ~40 props through the tree.
  // `effectiveHasApiKey` (the chain-masked key state) is surfaced by
  // useOnboardingChainController; see that hook for the masking rationale (#1014).
  const chatContextValue = useChatContextValue({
    entries, streaming, editingEntryIdx, setEditingEntryIdx, editBusy,
    question, setQuestion, chatEndRef, currentSessionId, hasApiKey: effectiveHasApiKey, onOpenSettings,
    searchOpen, searchQuery, searchCase, searchMatches, searchMatchSet, searchIdx, searchHighlight,
    searchChangeQuery, searchToggleCase, searchNext, searchPrev, searchCloseOverlay, searchToggleOverlay,
    contextOverflowPct, usedTokens, contextBudget, effectiveBudget,
    tpmLimit, tpmPct, isTpmOverflow,
    rolePresets, activePreset, activePresetId, setActivePresetId,
    attachments, setAttachments, attachmentNCounter,
    enableThinkingChat, toggleThinking, costEstimate, costBadgeClass,
    activePricing,
    activeVendor: llmVendor,
  });

  // Issue #260 — when a notification toast is clicked, dispatch the click via
  // notifyClick IPC (which restores+focuses the window) and dismiss the
  // toast. Other toast producers leave `notification` undefined so this
  // handler is a no-op for them.
  // Persistent StatusBar indicators for pre-turn auto-compact + exhausted
  // force-recover budget, keyed off useChatState flags. See
  // use-chat-status-indicators.ts.
  useChatStatusIndicators({
    t, isCompacting, compactTriggerSource, isRecoveryExhausted,
    statusUpsertPersistent, statusRemovePersistent,
  });

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
    <AppProviders
      api={api}
      onOpenSession={handleOpenRoutineSession}
      addFireRef={addFireRef}
      runningRoutines={runningRoutines}
    >
      <AppShell
        api={api}
        appMode={appMode}
        sidebarCollapsed={sidebarCollapsed}
        onToggleSidebarCollapse={() => setSidebarCollapsed((v) => !v)}
        activeView={activeView}
        streaming={streaming}
        hasApiKey={effectiveHasApiKey}
        onToggleAppMode={setAppMode}
        onOpenDevTools={() => setDevToolsOpen((v) => !v)}
        appUpdate={appUpdate}
        onSelectView={handleViewSelect}
        pluginViews={pluginViews}
        pluginAuthStatuses={pluginAuthStatuses}
        onOpenSettings={onOpenSettings}
        onNewChat={onNewChat}
        onNewChatForProject={onNewChatForProject}
        workspaceProjects={workspaceProjects}
        activeProject={activeProject ?? defaultWorkspaceProject}
        onOpenMarketplace={onOpenMarketplace}
        marketplaceUrlReady={marketplaceUrlReady}
        onOpenUnifiedSearch={() => { searchOpenOverlay(); }}
        currentSessionId={currentSessionId}
        isCurrentSessionStarred={Boolean(currentSessionId && isSessionStarred(currentSessionId))}
        onToggleCurrentSessionStar={() => currentSessionId
          ? handleToggleSessionStar(currentSessionId, sessions.find((s) => s.id === currentSessionId)?.title)
          : Promise.resolve()}
        onExport={handleExport}
        bootstrapStatus={bootstrapStatus}
        onDismissBootstrapStatus={dismissBootstrapStatus}
        onRetryBootstrap={() => void retryBootstrap()}
        marketplaceUpdates={marketplaceUpdates}
        onDismissMarketplaceUpdates={dismissMarketplaceUpdates}
        onSkipMarketplaceUpdates={skipMarketplaceUpdates}
        onUpdatePlugin={installPlugin}
        marketplaceAnnouncements={marketplaceAnnouncements}
        onDismissMarketplaceAnnouncement={handleMarketplaceAnnouncementDismiss}
        fallbackToast={fallbackToast}
        devToolsOpen={devToolsOpen}
        onCloseDevTools={() => setDevToolsOpen(false)}
        searchOpen={searchOpen}
        searchQuery={searchQuery}
        searchCase={searchCase}
        entries={entries}
        searchMatches={searchMatches}
        searchIdx={searchIdx}
        sessions={sessions}
        starred={starred}
        onSearchChangeQuery={searchChangeQuery}
        onSearchToggleCase={searchToggleCase}
        onSearchNext={searchNext}
        onSearchPrev={searchPrev}
        onSearchJumpToMatch={searchJumpToMatch}
        onSearchOpen={searchOpenOverlay}
        onSearchClose={searchCloseOverlay}
        onSearchLoadSession={handleLoadSessionAndRefresh}
        setActiveView={setActiveView}
        sidePanelOpen={sidePanelOpen}
        onToggleSidePanel={handleToggleSidePanel}
      >
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
            fallback={t("app.mainContentErrorFallback")}
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
            appMode={appMode}
            settingsTab={settingsTab}
            onSettingsSaved={handleInlineSettingsSaved}
            onCloseSettings={handleCloseInlineSettings}
            starred={starred}
            currentSessionId={currentSessionId}
            currentSessionKind={currentSessionKind}
            currentSessionTitle={currentSessionTitle}
            sessions={sessions}
            activeProject={activeProject ?? defaultWorkspaceProject}
            refreshStarred={refreshStarred}
            onActivateHome={() => setActiveView("home")}
            onJumpToSession={handleLoadSessionAndRefresh}
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
            onGuideError={(msg) => appendSystemEntry(t("app.guideErrorMessage", { msg }))}
            onFeedback={handleFeedback}
            subAgentSpawns={subAgentSpawns}
            loadedSkills={loadedSkills}
            hasAskQuestions={askQuestions.length > 0}
            askQuestions={askQuestions}
            onResolveAskQuestion={dismissAskQuestion}
            plugins={pluginEntries}
            onSelectPlugin={handleViewSelect}
            onOpenApprovalQueue={() => setDeferredQueueOpen(true)}
            commandActions={commandActions}
            commandPopoverOpen={commandPopoverOpen}
            onCommandPopoverOpenChange={setCommandPopoverOpen}
            activePluginView={activePluginView ?? null}
            pluginAuthError={activePluginAuthError}
            onPluginPrimaryAction={(id) => { void handlePluginPrimaryAction(id); }}
            onRoutineAcknowledge={handleRoutineAcknowledge}
            statusBar={{
              persistent: statusPersistent,
              visibleToast: statusVisibleToast,
              pendingCount: statusPendingCount,
              onToastClick: handleStatusToastClick,
              onToastDismiss: (toast) => statusRemoveToast(toast.id),
            }}
            actionPanelOpen={actionPanelOpen}
            onActionPanelOpenChange={setActionPanelOpen}
            sidePanelOpen={sidePanelOpen}
            onSidePanelOpenChange={setSidePanelOpen}
          />
          </ErrorBoundary>
      </AppShell>

      <AppDialogs
        api={api}
        deferredQueueOpen={deferredQueueOpen}
        onDeferredQueueOpenChange={setDeferredQueueOpen}
        approvalQueue={approvalQueue}
        onApprovalDecide={handleApprovalDecide}
        chainStage={chainStage}
        dispatchChain={dispatchChain}
        selectedScenarioId={selectedScenarioId}
        memorySeedNickname={memorySeedNickname}
        memorySeedIntroduction={memorySeedIntroduction}
        tourCompleted={tourCompleted}
        checkApiKey={checkApiKey}
        reactivationOpen={reactivationOpen}
        onReactivationOpenChange={setReactivationOpen}
        firstRunPluginSummary={firstRunPluginSummary}
        marketplaceUrlReady={marketplaceUrlReady}
        bootstrapStatus={bootstrapStatus}
        onRetryBootstrap={retryBootstrap}
        installedPluginIds={pluginCards.map((c) => c.id)}
        onComposerSeedText={setQuestion}
      />
    </AppProviders>
  );
}
