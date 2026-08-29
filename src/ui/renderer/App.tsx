import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "../../i18n/react.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { TooltipProvider } from "../../components/ui/tooltip.js";
import { ThemeProvider } from "./theme/index.js";
import { OverlayContextProvider } from "./context/OverlayContext.js";
import { CustomTitleBar } from "./components/CustomTitleBar.js";
import { MainToolbar } from "./MainToolbar.js";
import { Sidebar } from "./components/Sidebar.js";
import { BootstrapStatusBanner } from "./components/BootstrapStatusBanner.js";
import { MarketplaceUpdateBanner } from "./components/MarketplaceUpdateBanner.js";
import { MarketplaceAnnouncementBanner } from "./components/MarketplaceAnnouncementBanner.js";
import { DevToolsPanel } from "./components/DevToolsPanel.js";
import { UnifiedSearchPanel } from "./components/UnifiedSearchPanel.js";
import { PluginUiHostView } from "../../plugin-ui-host.js";
import { ChatGroupSession, type ChatGroupEnvironment } from "./components/ChatGroupSession.js";
import { ChatGroupSessionRegistry, useChatGroupSession, useTileSessions, tileHoldingSession, overlayCardTile, type OverlayCardPlacement } from "./components/chat-group-session-registry.js";
import { leafIds } from "./components/chat-group-tree.js";
import type { ChatEntry } from "../../lib/chat-stream-state.js";
// The away surfaces for an MCP-app card that left its home mount — one singleton
// each (each renders nothing while no card occupies its slot).
import { McpAppPipPanel } from "./components/McpAppPipPanel.js";
import { McpAppFullscreenPanel } from "./components/McpAppFullscreenPanel.js";
import { MemorySearchPanel } from "./components/MemorySearchPanel.js";
import { RoutinePanel } from "./components/RoutinePanel.js";
import { WorkBoardPanel } from "./components/WorkBoardPanel.js";
import { StarredView } from "./components/StarredView.js";
import { SettingsInlineView } from "./SettingsInlineView.js";
import { PageShell } from "./components/PageShell.js";
import type { ConversationRowActions, ProjectRowActions } from "./components/Sidebar.js";
import { ChatGroupFrame, ChatGroupGutter, areaStyle, chatGroupApi, useChatGroups, type ChatGroupSplitAxis } from "./components/ChatGroupFrame.js";
import type { DropTarget } from "./components/chat-group-drop.js";
import { useSessionList, useTurnAttention, type SessionSummary } from "./hooks/use-sessions.js";
import type { PluginViewKey } from "../../shared/view-key.js";
import { SHELL_GUTTER } from "../../shared/shell-geometry.js";
import { DeferredQueueDialog } from "./dialogs/DeferredQueueDialog.js";
import { SpotlightTour } from "./components/SpotlightTour.js";
import { PostTourFirstTask } from "./onboarding/PostTourFirstTask.js";
import { DevConsoleToggle } from "./components/DevConsoleToggle.js";
import { ApprovalDock } from "./components/permissions/ApprovalDock.js";
import type { ApprovalRequest } from "./types.js";
import type { UserApprovalVerdict } from "../../shared/permissions-events.js";
import type { ExactDenyDraft } from "./exact-permission-decision.js";

// ─── Imports: types / constants / helpers / components / tabs ────────
import { getApi, getPluginViewLabel, toViewKey } from "./api-client.js";
import { Button } from "../../components/ui/button.js";
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
import { SIDEBAR_WIDTH_PREF, usePanelWidth } from "./hooks/use-panel-width.js";
import { useSidebarTab } from "./hooks/use-sidebar-tab.js";
import { useActiveView } from "./hooks/use-active-view.js";
import { useSettingsTab } from "./hooks/use-settings-tab.js";
import { useProjectPreferences } from "./hooks/use-project-preferences.js";
import { useRoutineOverlay } from "./hooks/use-routine-overlay.js";
import { usePluginViewRouting } from "./hooks/use-plugin-view-routing.js";
import { useOnboardingTourController } from "./hooks/use-onboarding-tour-controller.js";
import { usePluginLifecycleRefresh } from "./hooks/use-plugin-lifecycle-refresh.js";
import { useStatusBar, type NotificationToastMeta } from "./hooks/use-status-bar.js";
import { useSettings } from "./hooks/use-settings.js";
import { ApprovalSurfaceProvider, useApproval, useApprovalClaimsVersion, type ApprovalSurfaceContextValue } from "./hooks/use-approval.js";
import { usePermissionToasts } from "./hooks/use-permission-toasts.js";
import { useApprovalSentence } from "./hooks/use-approval-sentence.js";
import { useSearch } from "./hooks/use-search.js";
import { useStarred } from "./hooks/use-starred.js";
import { useMarketplaceUpdates } from "./hooks/use-marketplace-updates.js";
import { useMarketplaceAnnouncements } from "./hooks/use-marketplace-announcements.js";
import { useBootstrapStatus } from "./hooks/use-bootstrap-status.js";
import { usePluginMarketplace } from "./hooks/use-plugin-marketplace.js";
import { usePluginAuthStatuses } from "./hooks/use-plugin-auth-status.js";
import { useRolePresets } from "./hooks/use-role-presets.js";
import { useAppBootstrap } from "./hooks/use-app-bootstrap.js";
import { useWindowFileDropGuard } from "./hooks/use-window-file-drop-guard.js";
import { useMarketplaceUrl } from "./hooks/use-marketplace-url.js";
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

/**
 * Card edge -> where a content title starts.
 *
 * The main surface sits one gutter past the sidebar card and carries another of
 * its own leading padding, so every view's title — a plugin's name, the chat
 * group's conversation title — begins two gutters in. The band's path is the
 * same label one row up, and a path that stopped at the card edge read as
 * belonging to the sidebar rather than to the thing it names.
 */
const CONTENT_TITLE_INSET = SHELL_GUTTER * 2;

/**
 * What the BAND assumes `<main>` reserves on its leading edge for the collapsed
 * icon rail. The content surface's own reserve is
 * `--shell-collapsed-rail-reserve` (4rem), and the two do not agree: the app
 * ships at a 0.875 font scale (`FONT_SIZE_SCALE_DEFAULT`), so 4rem resolves to
 * 56px while this reads 64. The band's path therefore starts 8px to the right
 * of the content it names whenever the sidebar is collapsed.
 *
 * That gap predates this constant being named — it was a bare 64 against a
 * bare `pl-[4rem]`, which is why nobody had noticed the units differ. It is
 * left as-is here rather than silently "fixed", because closing it is a visual
 * change and this pass is behaviour-preserving. The band genuinely may not
 * follow the type scale (it shares the traffic lights' line, drawn in device
 * px), so the fix is to decide which number is right and make the content
 * surface px too — tracked as follow-up, not done here.
 */
const COLLAPSED_RAIL_LEAD_RESERVE = 64;

/** The per-turn output ceiling the cost projection assumes. */
const MAX_OUTPUT_TOKENS = 4096;

export function App() {
  const { t } = useTranslation();
  const api = useMemo(() => getApi(), []);

  // Block default file:// navigation when a file is dropped onto the window
  // (the drag-drop indexing feature was removed; this guard is all that remains).
  useWindowFileDropGuard();

  // The tiles' conversations. Each ChatGroupSession publishes its handle here
  // and the WINDOW reads whichever tile is focused — see
  // chat-group-session-registry.ts for why this is a store and not state.
  const chatGroupSessions = useMemo(() => new ChatGroupSessionRegistry(), []);

  // The window's conversation list. Separate from any tile's current session:
  // the list describes the window and is the same for all of them.
  const { sessions, refreshSessions } = useSessionList(api);

  // Top status surface: persistent operational items plus transient toasts.
  // Window-scoped — a toast about a project error or an app update is the
  // window's news, not one conversation's. Initialized early because plugin
  // auth selection can emit toasts.
  const {
    persistent: statusPersistent,
    visibleToast: statusVisibleToast,
    pendingCount: statusPendingCount,
    pushToast: statusPushToast,
    removeToast: statusRemoveToast,
    upsertPersistent: statusUpsertPersistent,
    removePersistent: statusRemovePersistent,
  } = useStatusBar({ api });

  // Issue #260 — when a notification toast is clicked, dispatch the click via
  // notifyClick IPC (which restores+focuses the window) and dismiss the toast.
  // Other toast producers leave `notification` undefined so this is a no-op.
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
    setSidePanelOpen,
  } = useAppMode(api);
  // Durable expanded-width of the primary navigation sidebar (drag-to-resize on
  // its inner edge). Persists via SystemSettings.sidebarWidth; drives both the
  // sidebar card width and the <main> left-padding reserve in the shell layout.
  const {
    width: sidebarWidth,
    setWidth: setSidebarWidth,
    commitWidth: commitSidebarWidth,
  } = usePanelWidth(api, SIDEBAR_WIDTH_PREF);
  // Sidebar Chats/Projects tab — persisted the same way as sidebarWidth.
  const { activeTab: sidebarActiveTab, setActiveTab: setSidebarActiveTab } = useSidebarTab(api);

  // The tiled chat groups — the geometry. See `useChatGroups` and
  // docs/design/tiled-chat-groups.md.
  const chatGroups = useChatGroups(appMode);

  /**
   * The conversation the WINDOW is talking about.
   *
   * Every window control that names "the conversation" — the toolbar's
   * streaming state, the sidebar's highlighted session, the search panel's
   * transcript, a prefill from the tour — means the tile the user is looking
   * at. Reading it here once is what keeps that meaning in one place.
   */
  // The tile area in pixels. The split control halves the focused tile's LONGER
  // side, and the tree only knows fractions — a fraction cannot say which side
  // of a tile is longer.
  const chatGroupCanvasRef = useRef<HTMLDivElement>(null);

  const focusedSession = useChatGroupSession(chatGroupSessions, chatGroups.focusedId);
  const tileSessions = useTileSessions(chatGroupSessions);
  const { entries, streaming, currentSessionId, currentSessionProject, fallbackToast } = focusedSession;

  // Search is window chrome (the panel is an overlay over everything), reading
  // the focused tile's transcript — the one actually on screen.
  const {
    open: searchOpen, query: searchQuery, caseSensitive: searchCase,
    matches: searchMatches, matchSet: searchMatchSet, matchIdx: searchIdx, highlight: searchHighlight,
    changeQuery: searchChangeQuery, toggleCase: searchToggleCase,
    openOverlay: searchOpenOverlay, toggleOverlay: searchToggleOverlay, closeOverlay: searchCloseOverlay,
    nextMatch: searchNext, prevMatch: searchPrev, jumpToMatch: searchJumpToMatch,
  } = useSearch(entries as unknown as ChatEntry[]);

  const handleExport = useCallback(async (format: "markdown" | "json", sessionId?: string) => {
    try { await api.chatExport(format, sessionId); }
    catch (err) { console.warn("[lvis] export failed:", (err as Error).message); }
  }, [api]);

  // Reverse of handleExport. Returns the new sessionId on success so the caller
  // can load it and refresh the sidebar, matching the export/import symmetry —
  // import always yields a brand-new session, never overwrites the current one.
  const handleImport = useCallback(async (): Promise<string | null> => {
    try {
      const result = await api.chatImport();
      return result.ok ? result.sessionId : null;
    } catch (err) {
      console.warn("[lvis] import failed:", (err as Error).message);
      return null;
    }
  }, [api]);

  // A conversation open in another tile is brought forward, not loaded a
  // second time — see `tileHoldingSession`.
  // Read through refs so the callback is stable: it sits in the environment
  // every tile receives, and a fresh identity per render would re-render every
  // tile on every stream delta.
  const chatGroupsRef = useRef(chatGroups);
  chatGroupsRef.current = chatGroups;
  const { focus: focusGroup } = chatGroups;
  const focusChatGroup = useCallback((chatGroupId: string): boolean => {
    const { tree, focusedId } = chatGroupsRef.current;
    // The host can name a tile that is already closed (its release is still
    // in flight); focusing an id the tree does not hold would put the window
    // on a tile that exists nowhere.
    if (chatGroupId === focusedId || !leafIds(tree).includes(chatGroupId)) return false;
    focusGroup(chatGroupId);
    return true;
  }, [focusGroup]);
  // Which tile shows an overlay card. Only the window can answer it: it needs
  // every tile's conversation and which one is focused.
  const overlayCardTileForWindow = useCallback(
    (originSessionId: string | undefined): OverlayCardPlacement =>
      overlayCardTile(tileSessions, chatGroups.focusedId, originSessionId),
    [tileSessions, chatGroups.focusedId],
  );

  const focusTileHolding = useCallback((sessionId: string): boolean => {
    const holder = tileHoldingSession(tileSessions, sessionId);
    return holder !== undefined && focusChatGroup(holder.chatGroupId);
  }, [tileSessions, focusChatGroup]);

  const handleLoadSessionAndRefresh = useCallback(
    async (sessionId: string) => focusTileHolding(sessionId) || focusedSession.loadSession(sessionId),
    [focusedSession, focusTileHolding],
  );

  const handleImportAndLoad = useCallback(async () => {
    const sessionId = await handleImport();
    if (!sessionId) return;
    await handleLoadSessionAndRefresh(sessionId);
  }, [handleImport, handleLoadSessionAndRefresh]);

  // Closing a tile is the one moment its conversation is let go of in main —
  // not unmount, which the chat-mode toggle also causes and must not destroy
  // anything. The tile leaves the tree at once; the release is fire-and-forget
  // because nothing in the window can address that group afterwards.
  const closeChatGroup = useCallback((chatGroupId: string) => {
    chatGroups.close(chatGroupId);
    void chatGroupApi(api, chatGroupId).chatGroupRelease().catch((err: unknown) => {
      console.warn("[lvis] chat group release failed: %s", (err as Error).message);
    });
  }, [api, chatGroups]);

  /**
   * A conversation dragged out of the sidebar and dropped on a tile.
   *
   * The middle of a tile means "show it here"; an edge means "put it beside
   * this one". The second case creates a tile that is not mounted yet, so the
   * load cannot happen in this handler — it is remembered and run the moment
   * that tile publishes its handle.
   */
  const [pendingSessionDrop, setPendingSessionDrop] =
    useState<{ chatGroupId: string; sessionId: string } | null>(null);

  const handleSessionDrop = useCallback((
    targetGroupId: string,
    sessionId: string,
    target: DropTarget,
  ) => {
    const holder = tileHoldingSession(tileSessions, sessionId);
    if (holder) {
      chatGroups.focus(holder.chatGroupId);
      return;
    }
    if (target === "center") {
      chatGroups.focus(targetGroupId);
      void chatGroupSessions.read(targetGroupId)?.loadSession(sessionId);
      return;
    }
    const created = chatGroups.dropOnEdge(targetGroupId, target);
    // null is the ceiling: four tiles already. Nothing to say — the frame
    // stops offering edges once `canSplit` is false.
    if (created) setPendingSessionDrop({ chatGroupId: created, sessionId });
  }, [chatGroups, chatGroupSessions, tileSessions]);

  useEffect(() => {
    if (!pendingSessionDrop) return;
    const { chatGroupId, sessionId } = pendingSessionDrop;
    const deliver = () => {
      const tile = chatGroupSessions.read(chatGroupId);
      if (!tile) return false;
      void tile.loadSession(sessionId);
      setPendingSessionDrop(null);
      return true;
    };
    if (deliver()) return;
    return chatGroupSessions.subscribe(chatGroupId, () => { deliver(); });
  }, [pendingSessionDrop, chatGroupSessions]);

  // Pinned-project preference — pinned projects sort to the top of the
  // sidebar's Projects tab.
  const {
    isProjectPinned,
    toggleProjectPin,
    isProjectArchived,
    toggleProjectArchived,
    projectLabel,
    setProjectLabel,
  } = useProjectPreferences(api);
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
  const approvals = useApproval();
  const { queue: approvalQueue, decide: handleApprovalDecide, claims: approvalClaims } = approvals;
  // A card is drawn by the surface that claimed its session: a tile for its
  // own conversation and its sub-agents, a side chat for its loop. What is
  // left for the window's own dock is exactly the requests no surface
  // claimed — a request that names no conversation (a host or plugin ask),
  // or a session no open surface holds (a routine's turn, a session this
  // window closed while its ask was still parked). That dock is those
  // requests' home, not a catch-all: it draws nothing a surface has claimed.
  const approvalClaimsVersion = useApprovalClaimsVersion(approvalClaims);
  const unclaimedApprovals = useMemo(
    () => approvalQueue.filter((req) =>
      req.sessionId === undefined || approvalClaims.ownerOf(req.sessionId) === null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-read claims when they change
    [approvalQueue, approvalClaims, approvalClaimsVersion],
  );
  const windowApprovalHead = unclaimedApprovals[0] ?? null;
  // Approval-memory hit + permission review suggestion. Both report on the
  // WINDOW's permission settings, not on one conversation, so they are
  // subscribed and rendered once here — per tile they would raise the same
  // toast in every open conversation at once.
  const {
    userApprovalHitToast,
    permissionReviewSuggestion,
    handleEnablePermissionReviewSuggestion,
  } = usePermissionToasts();
  const [exactDenyDraft, setExactDenyDraft] = useState<ExactDenyDraft | null>(null);
  // `/allow <sentence>` is typed into the focused tile's composer, so it
  // addresses the out-of-directory card shown in that tile; with none there,
  // the window's own card. Other approval kinds keep their own explicit
  // decision form and must never consume a proposal they cannot display.
  const approvalSentenceTarget = useMemo(() => {
    const inFocusedTile = approvalQueue.find((req) =>
      req.kind === "out-of-allowed-dir"
        && req.sessionId !== undefined
        && approvalClaims.ownerOf(req.sessionId) === chatGroups.focusedId);
    if (inFocusedTile !== undefined) return inFocusedTile;
    return unclaimedApprovals.find((req) => req.kind === "out-of-allowed-dir") ?? null;
  }, [approvalQueue, approvalClaims, chatGroups.focusedId, unclaimedApprovals]);
  const {
    proposedChoice: approvalProposedChoice,
    interceptSubmit: interceptApprovalSentence,
  } = useApprovalSentence({
    approvalRequest: approvalSentenceTarget,
    onNotice: (message: string) => focusedSession.appendSystemEntry(message),
  });
  const approvalProposal = useMemo(
    () => (approvalSentenceTarget !== null && approvalProposedChoice !== null
      ? { requestId: approvalSentenceTarget.id, choice: approvalProposedChoice }
      : null),
    [approvalSentenceTarget, approvalProposedChoice],
  );

  // Routine + plugin-overlay IPC pipeline. Owns runningRoutines, the addFireRef
  // surfaced to OverlayContextProvider (populated during that provider's render),
  // the overlay lookup map, and the routine/overlay IPC subscriptions. A card's
  // primary action reaches its tile through the registry, so the turn starts in
  // the conversation the card was shown in. See use-routine-overlay.ts.
  const {
    addFireRef,
    runningRoutines,
    handlePluginPrimaryAction,
    handleRoutineAcknowledge,
  } = useRoutineOverlay({ api, t, registry: chatGroupSessions });

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
    if (approvalQueue.some((req) => req.id === requestId)) {
      void handleApprovalDecide(requestId, "deny-once");
    }
  }, [approvalQueue, handleApprovalDecide]);

  useEffect(() => {
    if (exactDenyDraft && !approvalQueue.some((req) => req.id === exactDenyDraft.requestId)) {
      setExactDenyDraft(null);
    }
  }, [approvalQueue, exactDenyDraft]);

  const approvalSurface = useMemo<ApprovalSurfaceContextValue>(() => ({
    ...approvals,
    openPermanentDeny: handleOpenPermanentDeny,
    lockedRequestId: exactDenyDraft?.requestId ?? null,
    proposal: approvalProposal,
  }), [approvals, handleOpenPermanentDeny, exactDenyDraft, approvalProposal]);

  // Auth status for every plugin that declares `manifest.auth`


  // (PluginGridButton). Hoisting to App.tsx means a single live-poll
  // + event-bridge subscription serves both surfaces — no duplicate
  // listeners, no stale-state divergence between the two views.
  const { statuses: pluginAuthStatuses, refresh: refreshPluginAuthStatus } = usePluginAuthStatuses(api, pluginCards);

  // Role preset, cost preview, multimodal attachments
  const { rolePresets, activePreset, activePresetId, setActivePresetId } = useRolePresets(api);
  const {
    starred,
    refreshStarred,
    isEntryStarred: starredIsEntry,
    handleToggleStar: starredToggle,
    isSessionStarred,
    handleToggleSessionStar,
  } = useStarred(api);
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
      // Moving focus to the tile already showing it touches no conversation,
      // so it is not held back by the focused tile's stream.
      if (focusTileHolding(sessionId)) {
        setActiveView("home");
        return true;
      }
      if (streaming) {
        console.warn("[lvis] openRoutineSession blocked during streaming");
        return false;
      }
      try {
        setActiveView("home");
        return await focusedSession.loadSession(sessionId);
      } catch (err) {
        console.warn("[lvis] openRoutineSession failed:", (err as Error).message);
        return false;
      }
    },
    [focusedSession, focusTileHolding, setActiveView, streaming],
  );

  useEffect(() => {
    if (!searchOpen) return;
    void refreshSessions();
    void refreshStarred();
  }, [refreshSessions, refreshStarred, searchOpen]);

  // Small adapter callbacks that bridge hook outputs to ChatView / MainToolbar.
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
  // Plugin/built-in view routing + host-managed plugin auth lifecycle (the 4
  // auth-gate refs + action guard + pluginAuthErrors + the two drain effects +
  // the uninstalled-plugin fallback), extracted as ONE unit. Routing no longer
  // reads appMode: every view renders inline in every mode. See
  // use-plugin-view-routing.ts.
  const {
    handleViewSelect,
    activePluginView,
    activePluginPreparing,
    activePluginAuthError,
  } = usePluginViewRouting({
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


  // The conversation action set. Built once so the chat-group header and the
  // sidebar row's context menu cannot drift apart about what is offered.
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
  // views) in EVERY mode. `setActiveView("settings")` + the main content region renders
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
  const handleNewChat = useCallback(async (project?: { projectRoot?: string; projectName?: string }) => {
    if (streaming) { console.warn("new chat blocked during streaming"); return; }
    const nextProject = resolveKnownProject(projectIdentityFromPayload(project)) ?? activeProject ?? defaultWorkspaceProject;
    // The tile starts it: chatNew has to reach the FOCUSED tile's loop, and
    // the reset has to land on that tile's transcript.
    await focusedSession.startNewChat(nextProject
      ? { projectRoot: nextProject.projectRoot, projectName: nextProject.projectName }
      : undefined);
    if (nextProject) setActiveProject(nextProject);
    setActiveView("home");
  }, [activeProject, defaultWorkspaceProject, focusedSession, resolveKnownProject, setActiveView]);

  // ── What a conversation ROW can do to itself ───────────────────────────────
  // Assembled here because these are the only place that has both the IPC
  // bridge and the list refresh: every mutation below has to be followed by
  // `refreshSessions()` or the row keeps rendering the state it just left.
  const conversationActions = useMemo<ConversationRowActions>(() => {
    const findSession = (sessionId: string) => sessions.find((session) => session.id === sessionId);
    const applyUpdate = async (
      payload: { sessionId: string; title?: string; archived?: boolean; unread?: boolean },
    ) => {
      const result = await api.chatSessionUpdate(payload);
      if (!result?.ok) {
        console.warn("[lvis] conversation update failed:", result?.error);
        return;
      }
      await refreshSessions();
    };
    return {
      isArchived: (sessionId) => Boolean(findSession(sessionId)?.archivedAt),
      isUnread: (sessionId) => Boolean(findSession(sessionId)?.unreadSince),
      isResponding: (sessionId) =>
        tileSessions.some((tile) => tile.sessionId === sessionId && tile.streaming),
      onRename: (sessionId, title) => applyUpdate({ sessionId, title }),
      onSetArchived: (sessionId, archived) => applyUpdate({ sessionId, archived }),
      onSetUnread: (sessionId, unread) => applyUpdate({ sessionId, unread }),
      // Share hands the conversation to the OS save dialog as Markdown — the
      // one format that is readable by whoever receives it without LVIS.
      onShare: (sessionId) => handleExport("markdown", sessionId),
      onCopy: async (sessionId) => {
        const history = await api.chatSessionHistory(sessionId);
        const messages = history?.messages ?? [];
        if (messages.length === 0) return;
        const text = messages
          .map((message) => {
            const body = typeof message.content === "string"
              ? message.content
              : JSON.stringify(message.content);
            return `## ${message.role}\n\n${body}`;
          })
          .join("\n\n");
        await navigator.clipboard.writeText(text);
      },
      onImport: handleImportAndLoad,
      onDelete: async (sessionId) => {
        const result = await api.chatSessionDelete(sessionId);
        if (!result?.ok) {
          // A cancelled confirm is the user's own decision, not a failure.
          if (!("canceled" in result && result.canceled)) {
            console.warn("[lvis] conversation delete failed:", result?.error);
          }
          return;
        }
        // Deleting the LOADED conversation leaves the loop pointed at a file
        // that is gone, so start a fresh one rather than leaving it dangling.
        if (result.wasLoaded) await handleNewChat();
        await refreshSessions();
      },
    };
  }, [api, sessions, tileSessions, refreshSessions, handleExport, handleImportAndLoad, handleNewChat]);
  // A turn that ends where the user is not looking marks its row; looking
  // at a conversation reads it. The sidebar's bold rows come from here.
  useTurnAttention({
    tiles: tileSessions,
    attention: { focusedChatGroupId: chatGroups.focusedId, conversationVisible: activeView === "home" },
    isUnread: conversationActions.isUnread,
    setUnread: conversationActions.onSetUnread,
    onTurnsEnded: refreshSessions,
  });

  // The work panel is per-GROUP state now (each conversation carries its own),
  // but WIDENING THE WINDOW is a window-level effect: it has to fire when ANY
  // group wants the extra room, and stop the moment we leave the surface those
  // groups live on. So the flag useAppMode drives resizeForSidePanel with is
  // derived here rather than being a second, independently-toggled truth.
  const anyGroupPanelOpen =
    activeView === "home" && chatGroups.groups.some((group) => group.panelOpen);
  useEffect(() => {
    setSidePanelOpen(anyGroupPanelOpen);
  }, [anyGroupPanelOpen, setSidePanelOpen]);

  const projectActions = useMemo<ProjectRowActions>(() => ({
    isArchived: isProjectArchived,
    onSetArchived: toggleProjectArchived,
    label: projectLabel,
    onSetLabel: setProjectLabel,
  }), [isProjectArchived, toggleProjectArchived, projectLabel, setProjectLabel]);



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


  /**
   * Everything a tile needs that is NOT its own conversation.
   *
   * One object rather than fifty props: a tile is rendered in a loop, so
   * threading these individually would put fifty lines at every call site and
   * make adding one a change in two places.
   */
  const chatGroupEnvironment = useMemo<ChatGroupEnvironment>(() => ({
    llmVendor, llmModel, settingsLoaded,
    subscriptionRuntimeSelected, subscriptionRuntimePolicy,
    subscriptionImageAttachmentProvider, subscriptionFileAttachmentProvider,
    subscriptionUnavailableProvider, subscriptionPendingProvider,
    apiUsageProjectionAvailable,
    // Until the persisted runtime selection has loaded, API-vendor defaults are
    // not a safe authority for a setting a selected subscription runtime does
    // not expose. Keep this control fail-closed with send/attachment UX.
    chatReasoningAvailable: settingsLoaded && activeSubscriptionRuntime === null,
    effectiveLlmReady, chatReadyWithoutApiKey, checkApiKey,
    onOpenSettings, maxOutputTokens: MAX_OUTPUT_TOKENS,
    rolePresets, activePreset, activePresetId, setActivePresetId,
    enableThinkingChat, toggleThinking,
    refreshSessions, sessions, focusChatGroup,
    isSessionStarred: (sessionId: string) => Boolean(isSessionStarred(sessionId)),
    handleToggleSessionStar,
    starredIsEntry, starredToggle,
    statusBar: {
      persistent: statusPersistent,
      visibleToast: statusVisibleToast,
      pendingCount: statusPendingCount,
      onToastClick: handleStatusToastClick,
      onToastDismiss: (toast) => statusRemoveToast(toast.id),
    },
    statusPushToast, statusUpsertPersistent, statusRemovePersistent,
    search: {
      searchOpen, searchQuery, searchCase, searchMatches, searchMatchSet,
      searchIdx, searchHighlight, searchChangeQuery, searchToggleCase,
      searchNext, searchPrev, searchCloseOverlay, searchToggleOverlay,
    },
    onExport: handleExport, onImport: handleImport,
    plugins: pluginEntries,
    onSelectPlugin: handleViewSelectWithDoctor,
    appMode,
    onOpenApprovalQueue: () => setDeferredQueueOpen(true),
    commandActions, commandPopoverOpen, onCommandPopoverOpenChange: setCommandPopoverOpen,
    // The window answers where a card goes, because only it sees every tile.
    overlayCardTile: overlayCardTileForWindow,
    onPluginPrimaryAction: (id: string, chatGroupId: string) => {
      void handlePluginPrimaryAction(id, chatGroupId);
    },
    onRoutineAcknowledge: handleRoutineAcknowledge,
    approvalSentenceInterceptSubmit: interceptApprovalSentence,
    activeProject: activeProject ?? defaultWorkspaceProject,
    workspaceProjects,
    onNewChatForProject,
    onRefreshProjects: refreshWorkspaceProjects,
    onProjectError: handleProjectError,
  }), [
    llmVendor, llmModel, settingsLoaded, subscriptionRuntimeSelected, subscriptionRuntimePolicy,
    subscriptionImageAttachmentProvider, subscriptionFileAttachmentProvider,
    subscriptionUnavailableProvider, subscriptionPendingProvider,
    apiUsageProjectionAvailable, activeSubscriptionRuntime,
    effectiveLlmReady, chatReadyWithoutApiKey, checkApiKey, onOpenSettings,
    rolePresets, activePreset, activePresetId, setActivePresetId,
    enableThinkingChat, toggleThinking, refreshSessions, focusChatGroup, sessions,
    isSessionStarred, handleToggleSessionStar, starredIsEntry, starredToggle,
    statusPersistent, statusVisibleToast, statusPendingCount, handleStatusToastClick,
    statusRemoveToast, statusPushToast, statusUpsertPersistent, statusRemovePersistent,
    searchOpen, searchQuery, searchCase, searchMatches, searchMatchSet, searchIdx,
    searchHighlight, searchChangeQuery, searchToggleCase, searchNext, searchPrev,
    searchCloseOverlay, searchToggleOverlay,
    handleExport, handleImport, pluginEntries, handleViewSelectWithDoctor, appMode,
    commandActions, commandPopoverOpen, overlayCardTileForWindow,
    handlePluginPrimaryAction, handleRoutineAcknowledge,
    interceptApprovalSentence,
    activeProject, defaultWorkspaceProject, workspaceProjects,
    onNewChatForProject, refreshWorkspaceProjects, handleProjectError,
  ]);

  // ─── Render ───────────────────────────────────
  return (
    /* The composition root's provider stack, outer → inner:
       ErrorBoundary → ThemeProvider → TooltipProvider → OverlayContextProvider. */
    <ErrorBoundary fallback={t("app.appErrorFallback")}>
      <ThemeProvider api={api}>
        <TooltipProvider>
          {/* IMPORTANT (render-order coupling): OverlayContextProvider MUST stay
              INSIDE this stack. It populates `addFireRef.current` DURING ITS
              RENDER (a synchronous assignment, before any effects fire), so the
              routine/overlay IPC subscriptions that App owns can call addFire()
              from outside the React tree. Hoisting it out — or mounting it below
              its consumers — would leave that ref null when the first IPC event
              lands. See src/ui/renderer/context/OverlayContext.tsx. */}
          <ApprovalSurfaceProvider value={approvalSurface}>
          <OverlayContextProvider
            onOpenSession={handleOpenRoutineSession}
            addFireRef={addFireRef}
            runningRoutines={runningRoutines}
          >
            {/* `relative` makes THIS full-height shell column the positioning
                context for the floating-card Sidebar, so the card's `top-0` reaches
                the window top — extending UP into the traffic-light band and
                reclaiming that vertical space on the left. */}
            <div className="relative flex h-screen flex-col overflow-hidden">
              {/* Single top band — window controls + the app toolbar cluster live
                  together here. The toolbar content is passed as children so it
                  renders IN the band (no separate toolbar row below it). */}
              {/* The band's path names what is open, so it lines up with that
                  thing's own title one row below — NOT with the sidebar card's
                  edge. `CONTENT_TITLE_INSET` is the distance from the card to
                  where a title starts: the gutter between the card and the
                  content, plus the content surface's own leading padding. */}
              <CustomTitleBar
                leadClearance={(sidebarCollapsed ? COLLAPSED_RAIL_LEAD_RESERVE : sidebarWidth + SHELL_GUTTER) + CONTENT_TITLE_INSET}
              >
                <MainToolbar
                  viewNav={viewNav}
                  streaming={streaming}
                  hasApiKey={effectiveLlmReady}
                  appMode={appMode}
                  onToggleAppMode={setAppMode}
                  onOpenDevTools={() => setDevToolsOpen((v) => !v)}
                  appUpdateState={appUpdate.state}
                  appUpdateInFlight={appUpdate.inFlight}
                  onDownloadAppUpdate={appUpdate.download}
                  onInstallAppUpdate={appUpdate.install}
                  onSkipAppUpdate={appUpdate.skip}
                />
              </CustomTitleBar>
              {/* The floating-card Sidebar is anchored against the full-height shell
                  column above (NOT this content row) so its `top-0` spans up into the
                  band. The content `<main>` carries left padding equal to the card
                  width + insets so the rail never occludes the canvas. */}
              <Sidebar
                activeView={activeView}
                onSelect={handleViewSelectWithDoctor}
                pluginViews={pluginViews}
                failedPluginCards={failedPluginCards}
                inactivePluginCards={inactivePluginCards}
                pluginAuthStatuses={pluginAuthStatuses}
                sessions={sessions}
                currentSessionId={currentSessionId}
                onLoadSession={async (sessionId) => {
                  const loaded = await handleLoadSessionAndRefresh(sessionId);
                  if (loaded !== false) setActiveView("home");
                  return loaded;
                }}
                hasApiKey={effectiveLlmReady}
                subscriptionUnavailable={subscriptionUnavailableProvider !== undefined}
                subscriptionPending={subscriptionPendingProvider !== undefined}
                subscriptionRuntimePolicy={subscriptionRuntimePolicy}
                onOpenSettings={() => onOpenSettings()}
                onNewChat={onNewChat}
                onNewChatForProject={onNewChatForProject}
                onRefreshProjects={refreshWorkspaceProjects}
                onProjectError={handleProjectError}
                projects={workspaceProjects}
                streaming={streaming}
                onOpenMarketplace={onOpenMarketplace}
                marketplaceUrlReady={marketplaceUrlReady}
                collapsed={sidebarCollapsed}
                onToggleCollapse={() => setSidebarCollapsed((v) => !v)}
                width={sidebarWidth}
                onWidthChange={setSidebarWidth}
                onWidthCommit={commitSidebarWidth}
                onOpenUnifiedSearch={() => { searchOpenOverlay(); }}
                viewNav={viewNav}
                conversationActions={conversationActions}
                projectActions={projectActions}
                activeSidebarTab={sidebarActiveTab}
                onActiveSidebarTabChange={setSidebarActiveTab}
                isSessionStarred={isSessionStarred}
                onToggleSessionStar={handleToggleSessionStar}
                isProjectPinned={isProjectPinned}
                onToggleProjectPin={toggleProjectPin}
              />
              <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
                <main
                  className={`relative flex min-h-0 min-w-0 flex-1 flex-col bg-background transition-[padding] duration-200 ease-out motion-reduce:transition-none ${
                    sidebarCollapsed ? "pl-(--shell-collapsed-rail-reserve)" : ""
                  }`}
                  // Expanded: reserve the sidebar card width plus one SHELL_GUTTER
                  // of right gap so the floating rail never occludes the canvas.
                  // Collapsed uses the fixed `--shell-collapsed-rail-reserve`
                  // class above. Inline style so the durable, user-resized width
                  // (SystemSettings.sidebarWidth) drives the reserve directly —
                  // during a drag this tracks the live width for a seamless resize.
                  style={sidebarCollapsed ? undefined : { paddingLeft: `${sidebarWidth + SHELL_GUTTER}px` }}
                >
                  {/* Floating notification stack — update/announcement banners are an
                      OVERLAY, not in-flow content. They float over the canvas anchored
                      top-RIGHT so they never push the routed content or the composer
                      down. The wrapper is pointer-events-none (clicks pass through the
                      gaps); each banner card re-enables pointer-events so
                      Update/dismiss still work. The left edge is inset past the
                      sidebar — `--shell-collapsed-banner-inset` when collapsed, the
                      live `sidebarWidth + CONTENT_TITLE_INSET` inline when expanded,
                      each one gutter clear of <main>'s own leading padding — so a
                      wide banner (max-w-md) in a
                      narrow window can never slide UNDER the floating sidebar card —
                      absolute positioning resolves against main's padding box, which
                      starts at the window edge beneath the rail. Multiple DISTINCT
                      banners (bootstrap / update / announcement) stack vertically; each
                      component collapses its own N items into a single counted card, so
                      the stack height stays bounded. */}
                  <div
                    className={`pointer-events-none absolute right-2 top-2 z-50 ml-auto flex max-w-md flex-col gap-2 transition-[left] duration-200 ease-out motion-reduce:transition-none [&>*]:pointer-events-auto [&>*]:m-0 ${
                      sidebarCollapsed ? "left-(--shell-collapsed-banner-inset)" : ""
                    }`}
                    // Expanded: inset the banner stack past the resized sidebar card so a
                    // wide banner can never slide under the floating rail. Tracks
                    // sidebarWidth by the same CONTENT_TITLE_INSET a view's own title
                    // starts at, so the stack lines up with the content it floats over.
                    style={sidebarCollapsed ? undefined : { left: `${sidebarWidth + CONTENT_TITLE_INSET}px` }}
                  >
                    <BootstrapStatusBanner status={bootstrapStatus} onDismiss={dismissBootstrapStatus} onRetry={() => void retryBootstrap()} />
                    <MarketplaceUpdateBanner
                      updates={marketplaceUpdates}
                      onDismiss={dismissMarketplaceUpdates}
                      onSkip={skipMarketplaceUpdates}
                      onResolved={resolveMarketplaceUpdates}
                      onUpdate={installPlugin}
                    />
                    <MarketplaceAnnouncementBanner
                      announcements={marketplaceAnnouncements}
                      onDismiss={handleMarketplaceAnnouncementDismiss}
                    />
                    {/* Verdict-tier tint surfaces the trust gradient:
                        low → --success (informational re-approval), medium →
                        --warning, high → --destructive + role="alert" (the user
                        is re-using a high-risk approval). Semantic tokens, so a
                        theme bundle supplies the actual color. */}
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
                          className={`rounded-md border px-3 py-2 text-xs ${tone}`}
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
                        className="flex min-w-0 items-center gap-2 rounded-md border border-[hsl(var(--warning)/0.4)] bg-[hsl(var(--warning)/0.1)] px-3 py-2 text-xs text-[hsl(var(--warning))]"
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
                  </div>
                  {fallbackToast && (
                    <div className="bg-warning text-warning-foreground text-xs px-4 py-2 border-b border-warning">
                      {fallbackToast}
                    </div>
                  )}
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
                      entries={entries as ChatEntry[]}
                      conversationMatches={searchMatches}
                      currentConversationMatch={searchIdx}
                      sessions={sessions}
                      project={activeProject ?? defaultWorkspaceProject}
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
                    />
                  )}

                  {/* Routed content and route-independent foreground surfaces share a
                      content-box positioning context. Floating surfaces can anchor to
                      this canvas without ignoring <main>'s sidebar padding or taking
                      flex space away from the active route. */}
                  <div
                    className="relative isolate flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
                    data-testid="route-canvas"
                    data-approval-scope
                  >
                    {/* Inner ErrorBoundary scoped to the routed main content so a
                        single failing plugin (e.g. stale manifest schema mismatch —
                        issue #736) does NOT bring down MainToolbar / Settings page /
                        Marketplace tab. The user must remain able to update /
                        uninstall the broken plugin via Settings, otherwise they are
                        locked out and the only recovery is manually rm-ing
                        ~/.lvis/plugins/<id>/.
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
                      {/* The conversations, always mounted.
                          A tile subscribes to its group's stream when it mounts, so
                          swapping it out to render Settings would drop the frames of
                          a turn still in flight — and take the composer draft and
                          scroll position with it. `contents` keeps the wrapper out of
                          the layout entirely, so the flex chain reads exactly as it
                          does when this is the only child. */}
                      <div
                        data-testid="chat-surface"
                        data-visible={activeView === "home" ? "true" : "false"}
                        className={activeView === "home" ? "contents" : "hidden"}
                      >
                        <PageShell
                              padded={false}
                              maxWidth="none"
                              contentClassName="flex min-h-0 min-w-0 flex-1 flex-col"
                              data-testid="main-pane-shell"
                            >
                              <>
                                {/* The away surfaces for an MCP-app card that left its home
                                    mount — one singleton each (each renders nothing while no
                                    card occupies its slot). Mounted once here rather than
                                    per-transcript-card, matching the slots' own
                                    single-occupant design. */}
                                <McpAppPipPanel />
                                <McpAppFullscreenPanel />
                                {/* Tiles are positioned from the split tree's boxes rather
                                    than nested flex containers, so a tile's rectangle is
                                    one number that the layout, a drag hit-test, and a
                                    measurement in a test all read the same way. */}
                                <div className="min-h-0 min-w-0 flex-1 pb-(--chrome-gap) pl-(--chrome-gap-tight) pr-(--chrome-gap) pt-0" data-testid="chat-group-row">
                                {/* The positioning context is INSIDE the padding: an
                                    absolutely-positioned child resolves against the padding
                                    box, so anchoring the tiles to the row itself would eat
                                    the air that lines the chat group's bottom edge up with
                                    the sidebar's. */}
                                <div ref={chatGroupCanvasRef} className="relative h-full w-full" data-testid="chat-group-canvas">
                                {chatGroups.groups.map((group) => (
                                <div
                                  key={group.id}
                                  /* The half-gutter: two adjacent tiles make the 8px gap
                                     between tiles, and the row's own padding is reduced by
                                     the same 4px so the outer edges land on the sidebar
                                     card's. Both read the chrome px tokens the sidebar's
                                     insets use — the chat group's bottom line has to stay on
                                     the sidebar's at every font scale, so neither side may
                                     be rem. */
                                  className="absolute flex p-(--chrome-gap-tight)"
                                  style={areaStyle(group.box)}
                                  data-testid={`chat-group-cell:${group.id}`}
                                >
                                  {/* The tile owns its conversation: every hook inside is
                                      keyed on its group-bound api, so two tiles stream at
                                      once without either seeing the other's transcript. */}
                                  <ChatGroupSession
                                    chatGroupId={group.id}
                                    api={api}
                                    registry={chatGroupSessions}
                                    env={chatGroupEnvironment}
                                    panelOpen={group.panelOpen}
                                    focused={chatGroups.focusedId === group.id}
                                    onSidePanelOpenChange={(open) => chatGroups.setPanelOpen(group.id, open)}
                                  >
                                    {({ actions, content, currentSessionId: tileSessionId }) => (
                                      <ChatGroupFrame
                                        title={
                                          sessions.find((session: SessionSummary) => session.id === tileSessionId)?.title
                                          ?? t("mainToolbar.newChat")
                                        }
                                        focused={chatGroups.focusedId === group.id}
                                        onFocus={() => chatGroups.focus(group.id)}
                                        onSessionDrop={(sessionId, target) =>
                                          handleSessionDrop(group.id, sessionId, target)}
                                        canSplit={chatGroups.canSplit}
                                        panelOpen={group.panelOpen}
                                        onTogglePanel={() => chatGroups.setPanelOpen(group.id, !group.panelOpen)}
                                        actions={actions}
                                        {...(chatGroups.canSplit ? {
                                          onSplit: (axis: ChatGroupSplitAxis) => chatGroups.split(group.id, axis),
                                          splitFits: (axis: ChatGroupSplitAxis) => {
                                            // A canvas that has not been laid out yet measures 0×0;
                                            // that is "unmeasured", not "no room".
                                            const canvas = chatGroupCanvasRef.current;
                                            const measured = canvas && canvas.clientWidth > 0 && canvas.clientHeight > 0;
                                            return chatGroups.splitFits(group.id, axis, measured
                                              ? { width: canvas.clientWidth, height: canvas.clientHeight }
                                              : undefined);
                                          },
                                        } : {})}
                                        {...(chatGroups.closable ? { onClose: () => closeChatGroup(group.id) } : {})}
                                        {...(chatGroups.canMaximize ? {
                                          maximized: chatGroups.maximizedId === group.id,
                                          onToggleMaximize: () => chatGroups.toggleMaximize(group.id),
                                        } : {})}
                                      >
                                        {content}
                                      </ChatGroupFrame>
                                    )}
                                  </ChatGroupSession>
                                </div>
                                ))}
                                {/* The boundaries sit in the 8px the cells' half-gutters
                                    leave between tiles, so the bar's strip is exactly
                                    the gap and steals nothing from either transcript. */}
                                {chatGroups.gutters.map((gutter) => (
                                  <ChatGroupGutter
                                    key={gutter.key}
                                    gutter={gutter}
                                    canvasRef={chatGroupCanvasRef}
                                    previewResize={chatGroups.previewResize}
                                    onResize={chatGroups.resize}
                                  />
                                ))}
                                </div>
                                </div>
                              </>
                            </PageShell>
                      </div>
                      {/* Renders the active main-pane content. One branch per view
                          keeps the router readable; every branch wraps its panel in
                          the same PageShell (`main-pane-shell`). */}
                      {(() => {
                        if (activeView === "memory") {
                          return (
                            <PageShell
                              padded
                              maxWidth="6xl"
                              contentClassName="flex min-h-0 min-w-0 flex-1 flex-col"
                              data-testid="main-pane-shell"
                            >
                              <MemorySearchPanel
                                api={api}
                                project={activeProject ?? defaultWorkspaceProject}
                                onOpenSession={async (sessionId) => {
                                  const loaded = await handleLoadSessionAndRefresh(sessionId);
                                  if (loaded !== false) handleActivateHome();
                                  return loaded;
                                }}
                              />
                            </PageShell>
                          );
                        }

                        if (activeView === "insights" || activeView === "starred") {
                          return (
                            <PageShell
                              padded
                              maxWidth="6xl"
                              contentClassName="flex min-h-0 min-w-0 flex-1 flex-col"
                              data-testid="main-pane-shell"
                            >
                              <StarredView
                                api={api}
                                starred={starred}
                                sessions={sessions}
                                workspaceProjects={workspaceProjects}
                                currentSessionId={currentSessionId}
                                refreshStarred={refreshStarred}
                                onJumpToSession={handleLoadSessionAndRefresh}
                                onActivateHome={handleActivateHome}
                              />
                            </PageShell>
                          );
                        }

                        if (activeView === "routines") {
                          return (
                            <PageShell
                              padded
                              maxWidth="6xl"
                              contentClassName="flex min-h-0 min-w-0 flex-1 flex-col"
                              data-testid="main-pane-shell"
                            >
                              <RoutinePanel
                                api={api}
                                onOpenSession={(sessionId) => {
                                  void (async () => {
                                    const loaded = await handleLoadSessionAndRefresh(sessionId);
                                    if (loaded !== false) handleActivateHome();
                                  })();
                                }}
                              />
                            </PageShell>
                          );
                        }

                        if (activeView === "settings") {
                          return (
                            <PageShell
                              padded={false}
                              maxWidth="none"
                              contentClassName="flex min-h-0 min-w-0 flex-1 flex-col"
                              data-testid="main-pane-shell"
                            >
                              {/* Settings renders inline in EVERY appMode; there is no
                                  detached settings window on this path. */}
                              <SettingsInlineView
                                api={api}
                                chatGroupId={chatGroups.focusedId}
                                initialTab={settingsTab}
                                onSaved={handleInlineSettingsSaved}
                                onTabChange={setSettingsTab}
                                exactDenyDraft={exactDenyDraft ?? null}
                                onExactDenySaved={handleExactDenySaved ?? (() => undefined)}
                                onDiscardExactDeny={() => setExactDenyDraft(null)}
                              />
                            </PageShell>
                          );
                        }

                        if (activeView === "work-board") {
                          return (
                            <PageShell
                              padded
                              maxWidth="6xl"
                              contentClassName="flex min-h-0 min-w-0 flex-1 flex-col"
                              data-testid="main-pane-shell"
                            >
                              <WorkBoardPanel api={api} project={activeProject ?? defaultWorkspaceProject} />
                            </PageShell>
                          );
                        }

                        // The conversations are rendered OUTSIDE this router — see
                        // `chatSurface` above. They must stay mounted across view
                        // navigation: each tile's stream subscription starts when it
                        // mounts, so unmounting them to show Settings would drop the
                        // frames of a turn that is still running.
                        if (activeView === "home") return null;

                        // Everything above narrowed away an inline BUILT-IN key, so what is
                        // left is a plugin view — proven, not assumed. The annotation is the
                        // proof: add a built-in to `BUILTIN_VIEWS` with `inline: true` and
                        // forget a branch here, and this line stops compiling. That is what
                        // replaced the old bare fallback, which rendered ANY unrecognized
                        // string as a plugin view and so reported a misspelled destination
                        // as a missing plugin.
                        const pluginKey: PluginViewKey = activeView;
                        void pluginKey;
                        return (
                          <PluginUiHostView
                            view={activePluginView ?? null}
                            preparing={activePluginPreparing}
                            authError={activePluginAuthError ?? null}
                          />
                        );
                      })()}
                    </ErrorBoundary>
                    {/* The window's own dock: only requests no conversation
                        surface claimed (see `unclaimedApprovals`). */}
                    <ApprovalDock
                      queue={unclaimedApprovals}
                      conversationLabel={
                        windowApprovalHead?.sessionId === undefined
                          ? t("approvalAttribution.unattributed")
                          : t("approvalAttribution.headlessSession")
                      }
                      proposedChoice={
                        windowApprovalHead !== null
                          && approvalProposal?.requestId === windowApprovalHead.id
                          ? approvalProposal.choice
                          : null
                      }
                      onDecide={(choice, pattern, extras) => {
                        if (windowApprovalHead === null) return;
                        void handleApprovalDecide(windowApprovalHead.id, choice, pattern, extras);
                      }}
                      onOpenPermanentDeny={handleOpenPermanentDeny}
                      interactionLocked={
                        windowApprovalHead !== null
                          && exactDenyDraft?.requestId === windowApprovalHead.id
                      }
                    />
                  </div>
                  {/* StatusBar notifications render inside ChatView, directly above
                      the composer. The composer's own status sub-row keeps showing
                      the ring / permission / model cells. The 도구 활동 (Tool Activity)
                      panel is now constructed inside ChatView (controlled via
                      `actionPanelOpen` / `onActionPanelOpenChange`, work-mode only) so
                      its open-actions reach the workspace store, anchored to the chat
                      column so it coexists with the right-docked ChatSidePanel. */}
                </main>
              </div>
            </div>

            {/* App-level dialogs that remain available after removing setup flows. */}
            <DeferredQueueDialog open={deferredQueueOpen} onOpenChange={setDeferredQueueOpen} />
            <SpotlightTour
              api={api}
              onComplete={onTourComplete}
              onDismiss={onTourDismiss}
            />
            <PostTourFirstTask
              onPrefillComposer={focusedSession.prefillComposer}
              pluginCards={pluginCards}
              tourCompleted={tourCompleted}
            />
            <DevConsoleToggle />
          </OverlayContextProvider>
          </ApprovalSurfaceProvider>
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
