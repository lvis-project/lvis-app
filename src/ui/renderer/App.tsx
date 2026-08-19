import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "../../i18n/react.js";
import { composeOutgoing as composeOutgoingUtil, type ComposedOutgoing } from "./utils/compose.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { AppProviders } from "./AppProviders.js";
import { AppDialogs } from "./AppDialogs.js";
import { AppShell } from "./AppShell.js";
import { ApprovalDock } from "./components/permissions/ApprovalDock.js";
import type { ApprovalRequest } from "./types.js";
import type { UserApprovalVerdict } from "../../shared/permissions-events.js";
import type { ExactDenyDraft } from "./exact-permission-decision.js";

// ─── Imports: types / constants / helpers / components / tabs ────────
import { getApi, getPluginViewLabel, toViewKey } from "./api-client.js";
import type { PluginEntry } from "./components/PluginGridButton.js";
import { getPluginInstallAliases } from "./utils/plugin-install-aliases.js";
import {
  parsePluginDoctorViewKey,
  parsePluginSettingsViewKey,
  toPluginDoctorViewKey,
} from "./utils/plugin-doctor-view.js";
import { buildQuickActions } from "./components/command-actions.js";
import { useAppUpdate } from "./hooks/use-app-update.js";
import { useAppMode } from "./hooks/use-app-mode.js";
import { useSidebarWidth } from "./hooks/use-sidebar-width.js";
import { useSidebarTab } from "./hooks/use-sidebar-tab.js";
import { useActiveView } from "./hooks/use-active-view.js";
import { useSettingsTab } from "./hooks/use-settings-tab.js";
import { usePinnedProjects } from "./hooks/use-pinned-projects.js";
import { useRoutineOverlay } from "./hooks/use-routine-overlay.js";
import { useSendMessage } from "./hooks/use-send-message.js";
import { usePluginViewRouting } from "./hooks/use-plugin-view-routing.js";
import { useOnboardingTourController } from "./hooks/use-onboarding-tour-controller.js";
import { usePluginLifecycleRefresh } from "./hooks/use-plugin-lifecycle-refresh.js";
import { useChatStatusIndicators } from "./hooks/use-chat-status-indicators.js";
import { MainContent } from "./MainContent.js";
import { useStatusBar, type NotificationToastMeta } from "./hooks/use-status-bar.js";
import { useSettings } from "./hooks/use-settings.js";
import { lookupBillablePricingOptional } from "../../shared/pricing-data.js";
import { estimateOutgoingUserMessageTokens } from "../../shared/multimodal-token-estimate.js";
import { useChatState } from "./hooks/use-chat-state.js";
import { useApproval } from "./hooks/use-approval.js";
import { useApprovalSentence } from "./hooks/use-approval-sentence.js";
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
import type { McpPromptEntry } from "./components/slash-picker-data.js";
import { normalizeSettingsTab } from "../../shared/settings-tabs.js";
import { toViewLocation, viewLocationBreadcrumb, type ViewLocation } from "./utils/view-location.js";
import { useViewHistory } from "./hooks/use-view-history.js";
import { useViewHistoryShortcuts } from "./hooks/use-view-history-shortcuts.js";
import type { ProjectIdentity } from "../../shared/project-identity.js";
import {
  defaultProjectFromProjects,
  findWorkspaceProject,
  projectIdentityFromPayload,
  reconcileActiveProject,
  workspaceRootsToProjects,
} from "../../shared/project-identity.js";
import { formatIpcError } from "./format-ipc-error.js";
import type { ProjectErrorReporter } from "./hooks/use-add-project-folder.js";

// ─── App ────────────────────────────────────────────

export function App() {
  const { t } = useTranslation();
  const api = useMemo(() => getApi(), []);

  // Block default file:// navigation when a file is dropped onto the window
  // (the drag-drop indexing feature was removed; this guard is all that remains).
  useWindowFileDropGuard();

  // Workflow tools (S1+S2) — lifted to App level so the question request queue
  // survives view navigation (question state persists across view changes).
  const {
    askQuestions,
    subAgentSpawns,
    loadedSkills,
    dismissAskQuestion,
    resetForNewSession,
    restoreSubAgentSpawns,
  } = useWorkflowTools(api);

  // Chat state + stream lifecycle (useChatState is the sole owner of entries).
  const {
    entries, streaming, isCompacting, compactTriggerSource, isRecoveryExhausted, beginStreamingRequest, finishStreamingRequest, markLastAssistantInterrupted, editingEntryIdx, setEditingEntryIdx, editBusy,
    entryIndexToHistoryIndex, handleEditSave, handleRetryEffort, handleContinueFromLastUser,
    resetStreamAccumulators, setErrorWithThought, handleCompactCommand,
    clearForNewChat, appendUserEntry, dropUserEntry, appendSystemEntry, applyInitialSession, applyLoadedSession, truncateToEntry,
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

  // Composer attachment warnings share the existing App-owned StatusBar queue.
  // No second toast store or renderer-global channel is introduced for this flow.
  const handleAttachmentWarning = useCallback((message: string) => {
    statusPushToast({ severity: "warning", message, ttlMs: 8000 });
  }, [statusPushToast]);

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
    mode?: "default" | "trigger-import" | "app-message" | "mcp-prompt",
    userIntent?: UserKeyboardIntentSnapshot,
  ) => Promise<void>>(
    async () => { /* populated below */ },
  );

  // App state
  const {
    tourCompleted,
    onTourComplete,
    onTourDismiss,
    checkApiKey,
    effectiveHasApiKey,
  } = useOnboardingTourController(api);
  const [deferredQueueOpen, setDeferredQueueOpen] = useState(false);
  // Inline settings: which tab the panel is on — seeded on open and updated by
  // the panel's own read-back as the user moves — and the view to
  // return to via the back affordance. Settings is an inline view in EVERY
  // appMode — there is no detached settings window on this path (see
  // onOpenSettings below), so these drive it in both modes.
  // Persisted alongside the view (#1995), so a restart resumes the exact page
  // inside Settings rather than the tab it was last opened on.
  const { settingsTab, setSettingsTab, restoresApplied: settingsTabRestoresApplied } =
    useSettingsTab(api);
  // Workspace mode (Chat / Work) + coupled shell layout state. The hook owns the
  // seed-before-paint state, the no-op-guarded persistence, and the
  // appMode-transition effects (rail-width coupling, resizeForMode). See
  // use-app-mode.ts.
  const {
    appMode, setAppMode,
    sidebarCollapsed, setSidebarCollapsed,
    actionPanelOpen, setActionPanelOpen,
    sidePanelOpen, setSidePanelOpen,
  } = useAppMode(api);
  // Durable expanded-width of the primary navigation sidebar (drag-to-resize on
  // its inner edge). Persists via SystemSettings.sidebarWidth; drives both the
  // sidebar card width and the <main> left-padding reserve in AppShell.
  const { sidebarWidth, setSidebarWidth, commitSidebarWidth } = useSidebarWidth(api);
  // Sidebar Chats/Projects tab — persisted the same way as sidebarWidth.
  const { activeTab: sidebarActiveTab, setActiveTab: setSidebarActiveTab } = useSidebarTab(api);
  // Pinned-project preference — pinned projects sort to the top of the
  // sidebar's Projects tab.
  const { isProjectPinned, toggleProjectPin } = usePinnedProjects(api);
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
    resolveUpdated: resolveMarketplaceUpdates,
  } = useMarketplaceUpdates(api);
  const { announcements: marketplaceAnnouncements, dismiss: dismissMarketplaceAnnouncement } = useMarketplaceAnnouncements(api);
  const { status: bootstrapStatus, dismiss: dismissBootstrapStatus, retry: retryBootstrap } = useBootstrapStatus(api);
  const { queue: approvalQueue, decide: handleApprovalDecide } = useApproval();
  const [exactDenyDraft, setExactDenyDraft] = useState<ExactDenyDraft | null>(null);
  const {
    proposedChoice: approvalProposedChoice,
    interceptSubmit: interceptApprovalSentence,
  } = useApprovalSentence({
    // `/allow <sentence>` proposes a filesystem scope and is meaningful only
    // for the out-of-directory card. Other approval kinds keep their own
    // explicit decision form and must never consume a proposal they cannot
    // display.
    approvalRequest:
      approvalQueue[0]?.kind === "out-of-allowed-dir" ? approvalQueue[0] : null,
    onNotice: appendSystemEntry,
  });

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

  // Where the main window is. `InlineViewKey` (not `string`) so a destination
  // that has no inline form — or a typo — cannot be assigned here at all.
  // Persisted and restored on next launch. Declared AFTER the plugin views it
  // needs: a restored `plugin:` key is only entered once this list confirms the
  // view still exists, so uninstalling a plugin cannot leave the app opening on
  // a view that is gone.
  const loadedPluginViewKeys = useMemo(
    () => pluginViews.map((view) => toViewKey(view)),
    [pluginViews],
  );
  const { activeView, setActiveView, restoresApplied: activeViewRestoresApplied } =
    useActiveView(api, loadedPluginViewKeys);
  // The location has two halves and each restores itself, so the history needs
  // one signal covering both. Each count only ever rises, so their sum rises
  // exactly when either half is restored — which is all the history reads.
  const restoresApplied = activeViewRestoresApplied + settingsTabRestoresApplied;
  // Where the window IS, as one value — the pair the top-bar path renders and
  // the unit visit history records. Settings is one view key but several
  // places, so the tab belongs in the location or the path would say
  // "Settings" while the user is on Permissions.
  const location = useMemo(
    () => toViewLocation(activeView, settingsTab),
    [activeView, settingsTab],
  );
  // Applying a history entry sets BOTH halves, so replaying a settings entry
  // lands on the page it was recorded on rather than the tab last opened.
  const navigateToLocation = useCallback((to: ViewLocation) => {
    if (to.view === "settings") setSettingsTab(to.settingsTab ?? "llm");
    setActiveView(to.view);
  }, [setSettingsTab, setActiveView]);
  const viewHistory = useViewHistory(location, navigateToLocation, restoresApplied);
  useViewHistoryShortcuts(viewHistory);

  const handleOpenPermanentDeny = useCallback((
    request: ApprovalRequest,
    verdictAtApproval: UserApprovalVerdict,
  ) => {
    setExactDenyDraft({
      requestId: request.id,
      toolName: request.toolName,
      args: request.args,
      source: request.source ?? "builtin",
      trustOrigin: request.trustOrigin,
      approvalCacheKey: request.approvalCacheKey,
      verdictAtApproval,
    });
    navigateToLocation({ view: "settings", settingsTab: "permissions" });
  }, [navigateToLocation]);

  const handleExactDenySaved = useCallback((requestId: string) => {
    setExactDenyDraft((current) => current?.requestId === requestId ? null : current);
    if (approvalQueue[0]?.id === requestId) {
      void handleApprovalDecide("deny-once");
    }
  }, [approvalQueue, handleApprovalDecide]);

  useEffect(() => {
    if (exactDenyDraft && approvalQueue[0]?.id !== exactDenyDraft.requestId) {
      setExactDenyDraft(null);
    }
  }, [approvalQueue, exactDenyDraft]);

  // Auth status for every plugin that declares `manifest.auth`


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
  } = useSessions(api, applyInitialSession, resetForNewSession, restoreSubAgentSpawns);
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

  const handleProjectError = useCallback<ProjectErrorReporter>((operation, error, message) => {
    statusPushToast({
      severity: "error",
      message: formatIpcError(error, message, {
        // Only reached for a code the shared IPC table does not know — every
        // code these operations actually return is mapped. The add label is
        // the file-browser one because the menu entry carries a trailing
        // ellipsis that reads badly in `<context>: <message>`.
        fallbackContext: operation === "add"
          ? t("chatPreviewRail.addProjectRoot")
          : operation === "remove"
            ? t("sidebar.projectMenuRemove")
            : t("sidebar.projectsLabel"),
      }),
      ttlMs: 10_000,
    });
  }, [statusPushToast, t]);

  // The project list refreshes on mount and after every add and remove, so a
  // standing fault would re-toast on each pass. Only a change of condition is
  // news; a repair clears the memory so the next one is reported again.
  const reportedListFault = useRef<string | null>(null);
  const reportProjectListFault = useCallback((code: string) => {
    if (reportedListFault.current === code) return;
    reportedListFault.current = code;
    handleProjectError("list", code);
  }, [handleProjectError]);

  const refreshWorkspaceProjects = useCallback(async () => {
    try {
      const result = await window.lvis?.workspace?.listRoots?.();
      if (!result?.ok) {
        // An empty project list and a project list main could not read look
        // identical on screen, so the second one is only ever a condition the
        // user is told about — never a silently shorter sidebar.
        if (result?.error) reportProjectListFault(result.error);
        return;
      }
      if (result.settingsFault) reportProjectListFault(result.settingsFault);
      else reportedListFault.current = null;
      const roots = Array.isArray(result.roots) ? result.roots : [];
      // fallbackName is only a safety net for a root with no resolvable
      // basename — the default project is excluded from every display
      // surface (composer selector, sidebar grouping, Insights), so its
      // exact string value is never shown.
      const projects = workspaceRootsToProjects(result.defaultRoot, roots, t("sidebar.projectsLabel"));
      setWorkspaceProjects(projects);
      setActiveProject((current) => reconcileActiveProject(current, projects));
    } catch {
      // The backend still defaults chat creation to the anchored workspace root.
    }
  }, [reportProjectListFault, t]);

  useEffect(() => {
    void refreshWorkspaceProjects();
  }, [refreshWorkspaceProjects]);

  /**
   * Resolve an EXPLICITLY requested project against the known list.
   *
   * A request that is not in the list is passed through unchanged rather than
   * replaced by the default. `workspaceProjects` is a render-time snapshot, so
   * the folder the user just added is reliably absent from it — the selector's
   * refresh has not re-rendered this callback yet — and substituting the
   * default there silently discarded the very choice the user made. The
   * authority for "may this root be used" is main's
   * `resolveAuthorizedWorkspaceProject`, which answers `project-not-allowed`;
   * a renderer-side guess cannot add safety, only wrong answers.
   */
  const resolveKnownProject = useCallback((project: ProjectIdentity | undefined): ProjectIdentity | undefined => {
    if (!project) return undefined;
    return findWorkspaceProject(workspaceProjects, project) ?? project;
  }, [workspaceProjects]);

  useEffect(() => {
    const sessionProject = projectIdentityFromPayload(currentSessionProject);
    setActiveProject(reconcileActiveProject(sessionProject, workspaceProjects));
  }, [currentSessionProject, workspaceProjects]);

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
    handleAbort, handleGuide, handleFeedback, handleExport, handleImport,
  } = useChatActions({
    api, streaming, currentSessionId, entries, entryIndexToHistoryIndex,
    markLastAssistantInterrupted,
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

  // #1500 (E3) — import always creates a brand-new session; on success,
  // load it into the current view and refresh the sidebar (export/import
  // symmetry: neither mutates the session currently open).
  const handleImportAndLoad = useCallback(async () => {
    const sessionId = await handleImport();
    if (sessionId) {
      await handleLoadSessionAndRefresh(sessionId);
    }
  }, [handleImport, handleLoadSessionAndRefresh]);

  // LLM settings + context budget (single source of truth: src/shared/pricing-data.ts)
  const {
    llmVendor,
    llmModel,
    enableThinkingChat,
    llmReadyWithoutApiKey,
    subscriptionRuntimePolicy,
    refresh: refreshLlmSettings,
    settingsLoaded,
    toggleThinking,
  } = useSettings(api);
  const {
    activeSubscriptionRuntime,
    subscriptionSelected: subscriptionRuntimeSelected,
    chatReady: subscriptionChatReady,
  } = subscriptionRuntimePolicy;
  const chatReadyWithoutApiKey = subscriptionRuntimeSelected
    ? subscriptionChatReady === true
    : llmReadyWithoutApiKey;
  // Until the authoritative runtime snapshot lands, the initial API-vendor
  // defaults are not a safe source for billing or context UI. Hide those
  // projections just as send and attachment ingress already fail closed.
  const apiUsageProjectionAvailable = settingsLoaded && !subscriptionRuntimeSelected;
  const effectiveLlmReady = useMemo(
    () => {
      // A selected subscription runtime is the sole authority for readiness.
      // Never revive a failed/pending subscription selection with a stale API key.
      // A pending readiness probe is deliberately non-sendable: it has not yet
      // established an authenticated chat session.
      if (subscriptionRuntimeSelected) return subscriptionChatReady === true;
      return effectiveHasApiKey === null
        ? (chatReadyWithoutApiKey ? true : null)
        : effectiveHasApiKey || chatReadyWithoutApiKey;
    },
    [effectiveHasApiKey, chatReadyWithoutApiKey, subscriptionChatReady, subscriptionRuntimeSelected],
  );
  const subscriptionUnavailableProvider = subscriptionRuntimePolicy.unavailableProvider;
  const subscriptionPendingProvider = subscriptionRuntimePolicy.pendingProvider;
  const subscriptionImageAttachmentProvider = subscriptionRuntimePolicy.imageAttachmentProvider;
  const subscriptionFileAttachmentProvider = subscriptionRuntimePolicy.fileAttachmentProvider;
  const composeOutgoing = useCallback(
    (raw: string) => composeOutgoingUtil({ raw, activePreset, attachments }),
    [activePreset, attachments],
  );
  // This is the same trimmed draft the send path composes. Both pre-send
  // surfaces consume it, so pasted text, file paths, resource text parts, and
  // images cannot drift from the actual user payload.
  const composedDraft = useMemo<ComposedOutgoing>(() => {
    const trimmedQuestion = question.trim();
    return trimmedQuestion.length > 0
      ? composeOutgoing(trimmedQuestion)
      : { text: "", attachments: [] };
  }, [question, composeOutgoing]);
  const draftTokenEstimate = useMemo(
    () => estimateOutgoingUserMessageTokens(composedDraft.text, composedDraft.attachments),
    [composedDraft],
  );

  const { usedTokens, contextBudget, effectiveBudget, contextOverflowPct, tpmLimit, tpmPct, isTpmOverflow } =
    useContextBudget({
      entries,
      llmVendor: subscriptionRuntimeSelected ? undefined : llmVendor,
      llmModel: subscriptionRuntimeSelected ? undefined : llmModel,
      draftTokenEstimate,
      enabled: apiUsageProjectionAvailable,
    });
  // Plugin/built-in view routing + host-managed plugin auth lifecycle (the 4
  // auth-gate refs + action guard + pluginAuthErrors + the two drain effects +
  // the uninstalled-plugin fallback), extracted as ONE unit. Routing no longer
  // reads appMode: every view renders inline in every mode. See
  // use-plugin-view-routing.ts.
  const { handleViewSelect, activePluginView, activePluginAuthError } = usePluginViewRouting({
    api, t, activeView, setActiveView,
    pluginViews, pluginCards, pluginAuthStatuses, refreshPluginAuthStatus,
    statusPushToast,
  });

  // Path + history controls handed to the top bar. Labels resolve through the
  // plugin's declared title so a plugin crumb names the panel the way its own
  // sidebar entry does.
  const viewNav = useMemo(() => {
    const deps = {
      t,
      pluginViewLabel: (viewKey: string) => {
        const view = pluginViews.find((candidate) => toViewKey(candidate) === viewKey);
        return view ? getPluginViewLabel(view) : undefined;
      },
    };
    // Name the destination on the buttons. In chat mode the path itself does
    // not render, so without this the only navigation left says nothing about
    // where it goes. The deepest crumb is the destination's own name.
    const destinationLabel = (target: ViewLocation | null) =>
      target ? viewLocationBreadcrumb(target, deps).at(-1)?.label : undefined;
    return {
      segments: viewLocationBreadcrumb(location, deps),
      canGoBack: viewHistory.canGoBack,
      canGoForward: viewHistory.canGoForward,
      backLabel: destinationLabel(viewHistory.backTo),
      forwardLabel: destinationLabel(viewHistory.forwardTo),
      onBack: viewHistory.goBack,
      onForward: viewHistory.goForward,
      onSelectSegment: navigateToLocation,
    };
  }, [location, t, pluginViews, viewHistory, navigateToLocation]);

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
    const viewPluginIds = new Set(
      viewEntries
        .map((entry) => entry.pluginId)
        .filter((pluginId): pluginId is string => typeof pluginId === "string" && pluginId.length > 0),
    );
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
    const failedCardEntries = pluginCards.flatMap((card): PluginEntry[] => {
      if (card.loadStatus !== "failed" || viewPluginIds.has(card.id)) return [];
      return [{
        viewKey: toPluginDoctorViewKey(card.id),
        pluginId: card.id,
        installAliases: getPluginInstallAliases(card.id, card.installAliases),
        loadStatus: card.loadStatus,
        label: card.name,
        icon: card.icon,
        iconText: card.iconText,
        unauthed: false,
        doctorRequired: true,
      }];
    });
    return [...viewEntries, ...preparingCardEntries, ...failedCardEntries];
  }, [pluginViews, pluginAuthStatuses, pluginCards]);

  const failedPluginCards = useMemo(() => {
    const pluginIdsWithViews = new Set(pluginViews.map((view) => view.pluginId));
    return pluginCards.filter((card) =>
      card.loadStatus === "failed" && !pluginIdsWithViews.has(card.id)
    );
  }, [pluginCards, pluginViews]);

  // A plugin the user switched off keeps its card (`loadStatus: "disabled"`)
  // but has no live view, so the sidebar used to render nothing for it — the
  // same "installed everywhere except in the app" dead end a dropped plugin
  // produces. Scoped to manifests that declare a sidebar extension: those are
  // the plugins whose absence from THIS list is what a user notices, and the
  // row stands in the slot the plugin will occupy once re-enabled.
  const inactivePluginCards = useMemo(() => {
    const pluginIdsWithViews = new Set(pluginViews.map((view) => view.pluginId));
    return pluginCards.filter((card) =>
      card.loadStatus === "disabled"
      && !pluginIdsWithViews.has(card.id)
      && (card.uiExtensions?.length ?? 0) > 0
    );
  }, [pluginCards, pluginViews]);

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

  // Settings is ALWAYS an inline view now — there is no detached Settings
  // window in either mode (overhaul). So the old "chat mode force-closes inline
  // settings" guard is gone: the settings view is valid in every appMode, and a
  // mode switch must not eject the user from it.

  // Settings joins the inline view pattern (업무보드/루틴/메모리/별표 + plugin
  // views) in EVERY mode. `setActiveView("settings")` + MainContent renders
  // SettingsContent inline; there is no BrowserWindow path. Re-selecting
  // Settings while already inline only refreshes the tab, so the view never
  // re-mounts and loses its place.
  const onOpenSettings = useCallback((tab = "llm") => {
    setSettingsTab(normalizeSettingsTab(tab));
    setActiveView("settings");
  }, []);

  const handleViewSelectWithDoctor = useCallback((key: string) => {
    // An inactive plugin's row is a shortcut to the toggle that turned it off,
    // not an incident: it opens Plugin Settings with no warning toast.
    if (parsePluginSettingsViewKey(key)) {
      onOpenSettings("plugin-config");
      return;
    }
    const doctorPluginId = parsePluginDoctorViewKey(key);
    if (doctorPluginId) {
      const card = pluginCards.find((candidate) => candidate.id === doctorPluginId);
      statusPushToast({
        severity: "warning",
        message: t("app.pluginDoctorRequiredToast", { label: card?.name ?? doctorPluginId }),
        ttlMs: 10000,
      });
      onOpenSettings("plugin-config");
      return;
    }
    handleViewSelect(key);
  }, [handleViewSelect, onOpenSettings, pluginCards, statusPushToast, t]);

  // Loading a conversation from Memory, Insights, or Routines is content
  // navigation, not a history replay. The top toolbar exclusively owns visit
  // history; result activation always reveals the loaded chat.
  const handleActivateHome = useCallback(() => {
    setActiveView("home");
  }, [setActiveView]);

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

  // Settings renders in-process, so a successful save refreshes the live API
  // key and model state directly without a cross-window notification hop.
  const handleInlineSettingsSaved = useCallback(() => {
    void checkApiKey();
    void refreshLlmSettings();
  }, [checkApiKey, refreshLlmSettings]);

  // Composer send pipeline. Owns handleAsk (+ its turnRequestRef guard) and
  // writes handleAskRef.current each render so the forward-ref cycle with
  // use-routine-overlay's handlePluginPrimaryAction stays live. See
  // use-send-message.ts.
  const { handleAsk } = useSendMessage({
    api, t, streaming, checkApiKey, composeOutgoing,
    appendUserEntry, dropUserEntry, resetStreamAccumulators, beginStreamingRequest, finishStreamingRequest,
    markLastAssistantInterrupted,
    setErrorWithThought, handleCompactCommand, sessionLoad, applyLoadedSession,
    refreshSessionId, refreshSessions, attachments, setAttachments,
    llmVendor, llmModel, llmReadyWithoutApiKey: chatReadyWithoutApiKey,
    settingsReady: settingsLoaded,
    subscriptionRuntimePolicy,
    onOpenSettings, setQuestion, handleAskRef,
  });

  // Run a server-declared MCP prompt. The host fetches it and returns the text
  // ALREADY wrapped in its provenance envelope; we send that verbatim under the
  // staged `mcp-prompt` mode. It deliberately does NOT go through the composer
  // draft: a draft the user then submits would enter as `user-keyboard`, which
  // would launder server-authored text into a fully trusted turn.
  // Arguments are collected by HOST chrome (McpPromptArgsDialog) — the renderer
  // has no `window.prompt`, and a composer draft would re-enter as
  // `user-keyboard`. An argument-less prompt skips the form entirely.
  const [mcpPromptAwaitingArgs, setMcpPromptAwaitingArgs] = useState<McpPromptEntry | null>(null);

  const runMcpPrompt = useCallback(
    async (prompt: McpPromptEntry, args: Record<string, string>) => {
      // The prompt NAME is server-authored, so it is bounded before it goes near
      // host chrome (React escapes it; this is about layout, and about the toast
      // staying readable).
      const label = prompt.name.slice(0, 64);
      const fail = (error?: string) => {
        // The handler distinguishes rate-limited from empty-prompt from
        // prompt-failed. Collapsing them into one string is what makes "it just
        // doesn't work" undiagnosable — `formatIpcError` already owns the wording
        // for each code, and falls back to the generic line for an unknown one.
        statusPushToast({
          severity: "error",
          message: formatIpcError(error, undefined, {
            fallbackContext: t("app.mcpPromptFailed", { name: label }),
          }),
          ttlMs: 10000,
        });
      };
      // One catch for the whole path: an IPC rejection, a missing bridge, or a
      // send-gate refusal all surface as a toast rather than an unhandled
      // rejection the user never sees.
      try {
        const outcome = await window.lvis?.mcp?.getPrompt?.(prompt.serverId, prompt.name, args);
        if (!outcome || outcome.ok !== true) {
          fail(outcome?.ok === false ? outcome.error : undefined);
          return;
        }
        // The host clipped what the server returned. Saying so is the difference
        // between a prompt that looks complete and one the user knows is partial.
        if (outcome.truncated || (outcome.omittedBlocks ?? 0) > 0) {
          statusPushToast({
            severity: "warning",
            message: t("app.mcpPromptClipped", { name: label }),
            ttlMs: 8000,
          });
        }
        await handleAskRef.current?.(outcome.envelope, "mcp-prompt");
      } catch {
        fail();
      }
    },
    [handleAskRef, statusPushToast, t],
  );

  const handleRunMcpPrompt = useCallback((prompt: McpPromptEntry) => {
    if (prompt.arguments.length > 0) {
      setMcpPromptAwaitingArgs(prompt);
      return;
    }
    void runMcpPrompt(prompt, {});
  }, [runMcpPrompt]);

  const handleMcpPromptArgsSubmit = useCallback(
    (prompt: McpPromptEntry, args: Record<string, string>) => {
      setMcpPromptAwaitingArgs(null);
      void runMcpPrompt(prompt, args);
    },
    [runMcpPrompt],
  );

  const { costEstimate, costBadgeClass } =
    useCostEstimate({
      entries,
      draft: composedDraft,
      llmVendor: subscriptionRuntimeSelected ? undefined : llmVendor,
      llmModel: subscriptionRuntimeSelected ? undefined : llmModel,
      maxOutputTokens,
      enabled: apiUsageProjectionAvailable,
    });
  // Strict variant — `undefined` means "model not in catalog" so the cost
  // toggle in TokenCostBadge stays disabled rather than showing $0 from
  // FALLBACK_PRICING.
  const activePricing = useMemo(
    () => apiUsageProjectionAvailable ? lookupBillablePricingOptional(llmVendor, llmModel) : undefined,
    [apiUsageProjectionAvailable, llmVendor, llmModel],
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
    setActiveView, onOpenSettings,
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
  // `effectiveLlmReady` combines the provider-key probe with explicit
  // keyless-compatible provider readiness and a subscription runtime that has
  // explicitly verified chat support.
  const chatContextValue = useChatContextValue({
    entries, streaming, editingEntryIdx, setEditingEntryIdx, editBusy,
    question, setQuestion, chatEndRef, currentSessionId, hasApiKey: effectiveLlmReady, settingsLoaded, onOpenSettings,
    searchOpen, searchQuery, searchCase, searchMatches, searchMatchSet, searchIdx, searchHighlight,
    searchChangeQuery, searchToggleCase, searchNext, searchPrev, searchCloseOverlay, searchToggleOverlay,
    contextOverflowPct, usedTokens, contextBudget, effectiveBudget,
    tpmLimit, tpmPct, isTpmOverflow,
    usageAvailable: apiUsageProjectionAvailable,
    rolePresets, activePreset, activePresetId, setActivePresetId,
    subscriptionRuntimePolicy,
    subscriptionImageAttachmentProvider,
    subscriptionFileAttachmentProvider,
    subscriptionUnavailableProvider,
    subscriptionPendingProvider,
    attachments, setAttachments, attachmentNCounter,
    // Until the persisted runtime selection has loaded, API-vendor defaults are
    // not a safe authority for a setting that a selected subscription runtime
    // does not expose. Keep this control fail-closed with send/attachment UX.
    enableThinkingChat, reasoningAvailable: settingsLoaded && activeSubscriptionRuntime === null,
    toggleThinking, costEstimate, costBadgeClass,
    activePricing,
    activeVendor: apiUsageProjectionAvailable ? llmVendor : undefined,
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
        viewNav={viewNav}
        appMode={appMode}
        sidebarCollapsed={sidebarCollapsed}
        onToggleSidebarCollapse={() => setSidebarCollapsed((v) => !v)}
        sidebarWidth={sidebarWidth}
        onSidebarWidthChange={setSidebarWidth}
        onSidebarWidthCommit={commitSidebarWidth}
        activeView={activeView}
        streaming={streaming}
        hasApiKey={effectiveLlmReady}
        subscriptionUnavailable={subscriptionUnavailableProvider !== undefined}
        subscriptionPending={subscriptionPendingProvider !== undefined}
        subscriptionRuntimePolicy={subscriptionRuntimePolicy}
        onToggleAppMode={setAppMode}
        onOpenDevTools={() => setDevToolsOpen((v) => !v)}
        appUpdate={appUpdate}
        onSelectView={handleViewSelectWithDoctor}
        pluginViews={pluginViews}
        failedPluginCards={failedPluginCards}
        inactivePluginCards={inactivePluginCards}
        pluginAuthStatuses={pluginAuthStatuses}
        onOpenSettings={onOpenSettings}
        onNewChat={onNewChat}
        onNewChatForProject={onNewChatForProject}
        onRefreshProjects={refreshWorkspaceProjects}
        onProjectError={handleProjectError}
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
        activeSidebarTab={sidebarActiveTab}
        onActiveSidebarTabChange={setSidebarActiveTab}
        isSessionStarred={isSessionStarred}
        onToggleSessionStar={handleToggleSessionStar}
        isProjectPinned={isProjectPinned}
        onToggleProjectPin={toggleProjectPin}
        onExport={handleExport}
        onImport={handleImportAndLoad}
        bootstrapStatus={bootstrapStatus}
        onDismissBootstrapStatus={dismissBootstrapStatus}
        onRetryBootstrap={() => void retryBootstrap()}
        marketplaceUpdates={marketplaceUpdates}
        onDismissMarketplaceUpdates={dismissMarketplaceUpdates}
        onSkipMarketplaceUpdates={skipMarketplaceUpdates}
        onResolveMarketplaceUpdates={resolveMarketplaceUpdates}
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
              NOT bring down MainToolbar / Settings page / Marketplace tab.
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
            onSettingsTabChange={setSettingsTab}
            onSettingsSaved={handleInlineSettingsSaved}
            exactDenyDraft={exactDenyDraft}
            onExactDenySaved={handleExactDenySaved}
            onDiscardExactDeny={() => setExactDenyDraft(null)}
            starred={starred}
            currentSessionId={currentSessionId}
            currentSessionKind={currentSessionKind}
            currentSessionTitle={currentSessionTitle}
            sessions={sessions}
            activeProject={activeProject ?? defaultWorkspaceProject}
            workspaceProjects={workspaceProjects}
            onNewChatForProject={onNewChatForProject}
            onRefreshProjects={refreshWorkspaceProjects}
            onProjectError={handleProjectError}
            onRunMcpPrompt={handleRunMcpPrompt}
            refreshStarred={refreshStarred}
            onActivateHome={handleActivateHome}
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
            approvalSentenceInterceptSubmit={interceptApprovalSentence}
            onResolveAskQuestion={dismissAskQuestion}
            plugins={pluginEntries}
            onSelectPlugin={handleViewSelectWithDoctor}
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
            onAttachmentWarning={handleAttachmentWarning}
            onActionPanelOpenChange={setActionPanelOpen}
            sidePanelOpen={sidePanelOpen}
            onSidePanelOpenChange={setSidePanelOpen}
          />
          </ErrorBoundary>
          <ApprovalDock
            queue={approvalQueue}
            proposedChoice={approvalProposedChoice}
            onDecide={handleApprovalDecide}
            onOpenPermanentDeny={handleOpenPermanentDeny}
            interactionLocked={exactDenyDraft !== null}
          />
      </AppShell>

      <AppDialogs
        api={api}
        deferredQueueOpen={deferredQueueOpen}
        onDeferredQueueOpenChange={setDeferredQueueOpen}
        tourCompleted={tourCompleted}
        onTourComplete={onTourComplete}
        onTourDismiss={onTourDismiss}
        pluginCards={pluginCards}
        onComposerSeedText={setQuestion}
        mcpPromptAwaitingArgs={mcpPromptAwaitingArgs}
        onMcpPromptArgsCancel={() => setMcpPromptAwaitingArgs(null)}
        onMcpPromptArgsSubmit={handleMcpPromptArgsSubmit}
      />
    </AppProviders>
  );
}
