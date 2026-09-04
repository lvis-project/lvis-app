import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "../../i18n/react.js";
import { MAX_CHAT_GROUPS } from "../../contract/app-contract.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { TooltipProvider } from "../../components/ui/tooltip.js";
import { ThemeProvider } from "./theme/index.js";
import { OverlayContextProvider } from "./context/OverlayContext.js";
import { CustomTitleBar } from "./components/CustomTitleBar.js";
import { MainToolbar } from "./MainToolbar.js";
import { Sidebar, isDarwinPlatform } from "./components/Sidebar.js";
import { MarketplaceAnnouncementBanner } from "./components/MarketplaceAnnouncementBanner.js";
import { StatusBar } from "./components/StatusBar.js";
import { DevToolsPanel } from "./components/DevToolsPanel.js";
import { DevComponentLabels } from "./components/DevComponentLabels.js";
import { UnifiedSearchPanel } from "./components/UnifiedSearchPanel.js";
import { PluginUiHostView } from "../../plugin-ui-host.js";
import { ChatGroupSession, type ChatGroupEnvironment } from "./components/ChatGroupSession.js";
import { ChatGroupSessionRegistry, useChatGroupSession, useTileSessions, tileHoldingSession, overlayCardTile, type OverlayCardPlacement } from "./components/chat-group-session-registry.js";
import { leafIds } from "./components/pane-tree.js";
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
import { PANE_CELL_INSET, PANE_MIN_HEIGHT, PaneGutter, PANE_HOME, PaneFrame, areaStyle, chatGroupApi, useChatGroups, type PaneSplitAxis } from "./components/PaneFrame.js";
import { minimumCanvasHeight } from "./components/pane-tree.js";
import type { DropTarget } from "./components/pane-drop.js";
import { useSessionList, useTurnAttention, type SessionSummary } from "./hooks/use-sessions.js";
import { parseInlineViewKey, type InlineViewKey, type PluginViewKey } from "../../shared/view-key.js";
import { CONTENT_TITLE_INSET, SHELL_GUTTER, collapsedBandLeadClearance } from "../../shared/shell-geometry.js";
import { DeferredQueueDialog } from "./dialogs/DeferredQueueDialog.js";
import { SpotlightTour } from "./components/SpotlightTour.js";
import { DevConsoleToggle } from "./components/DevConsoleToggle.js";
import { ApprovalDock, WINDOW_DOCK_MIN_HEIGHT } from "./components/permissions/ApprovalDock.js";
import { AskUserQuestionCard } from "./components/AskUserQuestionCard.js";
import { OverlayCardRegion } from "./components/OverlayCardRegion.js";
import type { ApprovalRequest } from "./types.js";
import type { UserApprovalVerdict } from "../../shared/permissions-events.js";
import type { ExactDenyDraft } from "./exact-permission-decision.js";

// ─── Imports: types / constants / helpers / components / tabs ────────
import { getApi, getPluginViewLabel, toViewKey } from "./api-client.js";
import type { PluginEntry } from "./components/PluginGridButton.js";
import { getPluginInstallAliases } from "./utils/plugin-install-aliases.js";
import { pluginIconFor } from "./utils/plugin-icon.js";
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
import { usePermissionSignals } from "./hooks/use-permission-signals.js";
import { useApprovalSentence } from "./hooks/use-approval-sentence.js";
import { useSearch } from "./hooks/use-search.js";
import { useStarred } from "./hooks/use-starred.js";
import { useMarketplaceUpdates } from "./hooks/use-marketplace-updates.js";
import { useMarketplaceAnnouncements } from "./hooks/use-marketplace-announcements.js";
import type { MarketplaceAnnouncementActionTarget } from "../../shared/marketplace-announcements.js";
import { useBootstrapStatus } from "./hooks/use-bootstrap-status.js";
import { usePluginMarketplace } from "./hooks/use-plugin-marketplace.js";
import { usePluginAuthStatuses } from "./hooks/use-plugin-auth-status.js";
import { useRolePresets } from "./hooks/use-role-presets.js";
import { useAppBootstrap } from "./hooks/use-app-bootstrap.js";
import { useWindowFileDropGuard } from "./hooks/use-window-file-drop-guard.js";
import { normalizeSettingsTab, type SettingsPath } from "../../shared/settings-tabs.js";
import type { OnboardingProposalDisposition } from "../../main/onboarding-proposal-store.js";
import {
  BUILTIN_LABEL_KEYS,
  BUILTIN_VIEW_ICONS,
  toViewLocation,
  viewLocationBreadcrumb,
  type PaneViewKey,
  type ViewLocation,
} from "./utils/view-location.js";
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
import { TEST_IDS } from "../../shared/test-ids.js";
import { errorMessage } from "../../shared/error-message.js";

// ─── App ────────────────────────────────────────────

/** The per-turn output ceiling the cost projection assumes. */
const MAX_OUTPUT_TOKENS = 4096;

/** A canvas not laid out yet measures 0x0 — that is "unmeasured", not "no room". */
function measuredCanvasSize(canvas: HTMLElement | null) {
  return canvas && canvas.clientWidth > 0 && canvas.clientHeight > 0
    ? { width: canvas.clientWidth, height: canvas.clientHeight }
    : undefined;
}

export function App() {
  const { locale, t } = useTranslation();
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
  // In chat mode the expanded sidebar FLOATS over the single conversation tile
  // instead of pushing it: the band and <main> keep their collapsed geometry
  // and the card overlays the surface. Work mode keeps the pushed layout —
  // its tiles have room to give. Derived from appMode alone, so a mode flip
  // while the card is open re-lays the shell with no second state to drift.
  const sidebarOverlay = appMode === "chat" && !sidebarCollapsed;
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
  const { entries, streaming, currentSessionId, currentSessionProject } = focusedSession;

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
    catch (err) { console.warn("[lvis] export failed:", errorMessage(err)); }
  }, [api]);

  // Reverse of handleExport. Returns the new sessionId on success so the caller
  // can load it and refresh the sidebar, matching the export/import symmetry —
  // import always yields a brand-new session, never overwrites the current one.
  const handleImport = useCallback(async (): Promise<string | null> => {
    try {
      const result = await api.chatImport();
      return result.ok ? result.sessionId : null;
    } catch (err) {
      console.warn("[lvis] import failed:", errorMessage(err));
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
  // What the window's own band may take, in the layout's own terms: the room
  // left once the shortest tile still clears the floor a split or a gutter drag
  // would hold it to. A card that arrives must not be able to squeeze the grid
  // past what the user's own gestures can. `SHELL_GUTTER` is the tile row's
  // bottom air, which is canvas height the tiles never see.
  //
  // One budget for everything the band holds — the dock and the window's own
  // overlay cards stack inside it and share it.
  //
  // Expressed as a percentage of `<main>`, the flex parent the band and the
  // route canvas share, so it tracks the window without measuring it.
  const windowBandMaxHeight = useMemo(() => {
    const reserved = minimumCanvasHeight(
      chatGroups.groups.map((group) => group.box),
      PANE_MIN_HEIGHT + PANE_CELL_INSET,
    ) + SHELL_GUTTER;
    return `max(${WINDOW_DOCK_MIN_HEIGHT}px, calc(100% - ${reserved}px))`;
  }, [chatGroups.groups]);

  // Which surface shows an overlay card. Only the window can answer it: it
  // needs every tile's conversation to say whether any of them owns the card.
  const overlayCardTileForWindow = useCallback(
    (card: { originSessionId?: string; adoptedChatGroupId?: string }): OverlayCardPlacement =>
      overlayCardTile(tileSessions, card),
    [tileSessions],
  );

  // Letting a conversation go in main. Fire-and-forget because nothing in the
  // window can address that group once it has left the tree.
  const releaseChatGroupLoop = useCallback((chatGroupId: string) => {
    void chatGroupApi(api, chatGroupId).chatGroupRelease().catch((err: unknown) => {
      console.warn("[lvis] chat group release failed: %s", errorMessage(err));
    });
  }, [api]);

  // Closing a tile is one of the two moments its conversation is let go of in
  // main — not unmount, which the chat-mode toggle also causes and must not
  // destroy anything. (The other is `adopt` releasing an idle group to make
  // room.) The tile leaves the tree at once.
  const closeChatGroup = useCallback((chatGroupId: string) => {
    chatGroups.close(chatGroupId);
    releaseChatGroupLoop(chatGroupId);
  }, [chatGroups, releaseChatGroupLoop]);

  const [pendingSessionDrop, setPendingSessionDrop] =
    useState<{ chatGroupId: string; sessionId: string } | null>(null);

  const focusTileHolding = useCallback((sessionId: string): boolean => {
    const holder = tileHoldingSession(tileSessions, sessionId);
    if (holder === undefined) return false;
    // A tile already holding it means the conversation is REACHED, which is a
    // different question from whether focus moved — `focusChatGroup` answers
    // the latter and says false when the tile is already focused. Reading that
    // as "not reached" is what sent a click on the focused tile's own session
    // down to a load the main process then refused, leaving a user sitting on
    // a plugin panel with no way back to the conversation.
    focusChatGroup(holder.chatGroupId);
    return true;
  }, [tileSessions, focusChatGroup]);

  /**
   * Put a conversation in front of the user, in `targetGroupId` if that group
   * can take it.
   *
   * Three answers, in order: a tile already holding it is focused; an idle
   * target loads it; and a target that is mid-turn does not have its
   * conversation taken out from under it — the incoming one is given a group of
   * its own beside it instead. Swapping the session on a running loop is what
   * main refuses, and rightly: `saveSession` rewrites the session file from the
   * loop's in-memory history, so a swap mid-turn writes one conversation's
   * messages into the other's file.
   *
   * In chat mode the adopted group is the only one DRAWN, so the canvas does
   * not split. The displaced tile stays mounted and its turn runs on.
   */
  const reachSession = useCallback(async (
    sessionId: string,
    targetGroupId: string,
  ): Promise<boolean> => {
    if (focusTileHolding(sessionId)) return true;
    const target = tileSessions.find((tile) => tile.chatGroupId === targetGroupId);
    const tile = chatGroupSessions.read(targetGroupId);
    if (target !== undefined && !target.streaming && tile) return tile.loadSession(sessionId);
    const adopted = chatGroupsRef.current.adopt(targetGroupId, (chatGroupId) => {
      const each = tileSessions.find((candidate) => candidate.chatGroupId === chatGroupId);
      // A group with no tile is a group whose state nothing can see. That is
      // not the same as an idle one, and releasing it would abort whatever it
      // is doing — so an unanswerable question is answered "busy".
      if (each === undefined) return false;
      return !each.streaming;
    }, measuredCanvasSize(chatGroupCanvasRef.current));
    if (!adopted) {
      statusPushToast({
        severity: "warning",
        message: t("app.conversationCeilingReached", { count: MAX_CHAT_GROUPS }),
        ttlMs: 8_000,
      });
      return false;
    }
    // The tree already dropped it; main still has to let the loop go.
    if (adopted.released !== null) {
      releaseChatGroupLoop(adopted.released);
      // Say so. Making room costs the user a tile they did not ask to lose, and
      // the click that caused it looked like plain navigation. The conversation
      // itself is on disk; the composer draft and the scroll position were not.
      statusPushToast({
        severity: "info",
        message: t("app.conversationSetAside"),
        ttlMs: 8_000,
      });
    }
    // The adopted group is not mounted yet, so the load rides the same delivery
    // the edge-drop uses — it runs when that tile publishes its handle.
    setPendingSessionDrop({ chatGroupId: adopted.chatGroupId, sessionId });
    return true;
  }, [
    chatGroupSessions, focusTileHolding, releaseChatGroupLoop,
    statusPushToast, t, tileSessions,
  ]);

  /** The same ladder for a request from outside the canvas: the focused tile is the target. */
  const handleLoadSessionAndRefresh = useCallback(
    (sessionId: string) => reachSession(sessionId, chatGroupsRef.current.focusedId),
    [reachSession],
  );

  const handleImportAndLoad = useCallback(async () => {
    const sessionId = await handleImport();
    if (!sessionId) return;
    await handleLoadSessionAndRefresh(sessionId);
  }, [handleImport, handleLoadSessionAndRefresh]);


  /**
   * A conversation dragged out of the sidebar and dropped on a tile.
   *
   * The middle of a tile means "show it here"; an edge means "put it beside
   * this one". The second case creates a tile that is not mounted yet, so the
   * load cannot happen in this handler — it is remembered and run the moment
   * that tile publishes its handle.
   */
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
      // "Show it here" is the same request the sidebar makes, aimed at the tile
      // the user pointed at. Dropping straight to `loadSession` would earn a
      // silent refusal when that tile is mid-turn — the dead end a click no
      // longer has.
      void reachSession(sessionId, targetGroupId);
      return;
    }
    const created = chatGroups.dropOnEdge(targetGroupId, target);
    // null is the ceiling: four tiles already. Nothing to say — the frame
    // stops offering edges once `canSplit` is false.
    if (created) setPendingSessionDrop({ chatGroupId: created, sessionId });
  }, [chatGroups, reachSession, tileSessions]);

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
  const [slashPickerOpen, setSlashPickerOpen] = useState(false);
  const [devToolsOpen, setDevToolsOpen] = useState(false);
  const [devLabelsOn, setDevLabelsOn] = useState(false);
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
  // A question a hidden tile is holding. Unlike an approval, a question was
  // delivered to ONE tile and lives only there, so when that tile stops being
  // drawn there is no second copy anywhere — the gate would sit out its
  // deadline with nothing on screen. The tile keeps owning it (answering still
  // goes back through its own queue); the window only lends it a surface.
  const strandedQuestion = useMemo(() => {
    for (const tile of tileSessions) {
      if (!tile.hidden) continue;
      const head = tile.askQuestions[0];
      if (head !== undefined) return { chatGroupId: tile.chatGroupId, request: head };
    }
    return null;
  }, [tileSessions]);
  // Approval-memory hit + reviewer suggestion. Both report on the WINDOW's
  // permission settings, not on one conversation, so they are subscribed once
  // here — per tile they would raise the same disclosure in every open
  // conversation at once. The hit is a toast rendered below; the suggestion
  // goes into the approval surface value, so whichever card is up draws it.
  const { userApprovalHitToast, reviewerSuggestion } = usePermissionSignals();
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
  // Set for the duration of ONE new-pane gesture — see `openViewInNewPane`.
  const newPaneTargetRef = useRef<string | null>(null);
  // The location lives in the focused pane's content, so navigating is putting
  // a view IN that pane. `useActiveView` still owns the restore and the
  // persistence; what it no longer owns is the value. With one focused pane
  // `contentById[focusedId].view` and the old window-wide `activeView` are the
  // same string, which is why the router below is untouched.
  const activeViewPane = useMemo(() => ({
    view: chatGroups.contentById[chatGroups.focusedId]?.view ?? "home",
    navigate: (next: InlineViewKey) => chatGroups.setPaneContent(
      // A navigation the new-pane gesture asked for goes into the pane that
      // gesture just made, which `focusedId` cannot yet name: the pane is
      // created and filled inside one event, and React has not re-rendered in
      // between. The claim lives for exactly that event (see
      // `openViewInNewPane`), so nothing later can be captured by it — and it
      // has to be honoured, or the two moves would land as two locations and
      // the visit history would record a stop at a pane's blank conversation.
      newPaneTargetRef.current ?? chatGroups.focusedId,
      { view: next },
    ),
  }), [chatGroups.contentById, chatGroups.focusedId, chatGroups.setPaneContent]);
  const { activeView, setActiveView, restoresApplied: activeViewRestoresApplied } =
    useActiveView(api, loadedPluginViewKeys, activeViewPane);
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
  // The section a deep link named, held only until the panel has landed on it.
  // Kept OUT of `ViewLocation` deliberately: a location is a place the user can
  // return to, and this is an event — recording it would replay the scroll and
  // the arrival ring every time history walked back onto the settings entry.
  const [settingsSectionTarget, setSettingsSectionTarget] = useState<string | null>(null);
  const clearSettingsSectionTarget = useCallback(() => setSettingsSectionTarget(null), []);
  // Composed after `navigateToLocation` because an accepted onboarding proposal
  // may name a settings destination, and the move is this window's to make.
  const navigateToSettingsPath = useCallback(
    (path: SettingsPath) => {
      navigateToLocation({ view: "settings", settingsTab: path.tab });
      setSettingsSectionTarget(path.section ?? null);
    },
    [navigateToLocation],
  );
  const {
    addFireRef,
    runningRoutines,
    handlePluginPrimaryAction,
    handleRoutineAcknowledge,
    handleProposalAnswer,
  } = useRoutineOverlay({
    api, t, locale, registry: chatGroupSessions, focusedChatGroupId: chatGroups.focusedId,
    onNavigateToSettings: navigateToSettingsPath,
  });

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
    reviewerSuggestion,
  }), [approvals, handleOpenPermanentDeny, exactDenyDraft, approvalProposal, reviewerSuggestion]);

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
      // One rule for reaching a conversation, wherever the request comes from:
      // a routine card opening its session is the sidebar's ladder with the
      // view switch on the end. The switch only happens if the conversation was
      // actually reached — a card naming a session that cannot be opened must
      // not drag the user out of the routines view to look at an unrelated one.
      try {
        const loaded = await handleLoadSessionAndRefresh(sessionId);
        if (loaded !== false) setActiveView("home");
        return loaded;
      } catch (err) {
        console.warn("[lvis] openRoutineSession failed:", errorMessage(err));
        return false;
      }
    },
    [handleLoadSessionAndRefresh, setActiveView],
  );

  useEffect(() => {
    if (!searchOpen) return;
    void refreshSessions();
    void refreshStarred();
  }, [refreshSessions, refreshStarred, searchOpen]);

  // A work-board run is a row in the conversation list, so the list has to
  // move when a run starts (the row appears) and when it ends (its time and
  // order change) — the same way a chat turn ending refreshes it.
  useEffect(() => {
    const unsubscribeStarted = api.onWorkBoardRunStarted(() => void refreshSessions());
    const unsubscribeFinished = api.onWorkBoardRunFinished(() => void refreshSessions());
    const unsubscribeFailed = api.onWorkBoardRunFailed(() => void refreshSessions());
    return () => {
      unsubscribeStarted();
      unsubscribeFinished();
      unsubscribeFailed();
    };
  }, [api, refreshSessions]);

  // A fired routine is a row too. Its conversation runs on the routine engine's
  // own loop, so no tile ever reports a turn ending for it and nothing else
  // would tell the list it exists.
  useEffect(() => {
    if (typeof api.onRoutineFired !== "function") return undefined;
    return api.onRoutineFired(() => void refreshSessions());
  }, [api, refreshSessions]);


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
  // Whether any chat model is configured — a selected subscription runtime, or
  // an API vendor that names a model. Unknown until the settings snapshot
  // lands, so the sidebar does not alert on the pre-load defaults.
  const chatModelConfigured = settingsLoaded
    ? subscriptionRuntimeSelected || llmModel.length > 0
    : null;
  const subscriptionImageAttachmentProvider = subscriptionRuntimePolicy.imageAttachmentProvider;
  const subscriptionFileAttachmentProvider = subscriptionRuntimePolicy.fileAttachmentProvider;
  // Plugin/built-in view routing + host-managed plugin auth lifecycle (the 4
  // auth-gate refs + action guard + pluginAuthErrors + the two drain effects +
  // the uninstalled-plugin fallback), extracted as ONE unit. Routing no longer
  // reads appMode: every view renders inline in every mode. See
  // use-plugin-view-routing.ts.
  const {
    handleViewSelect,
    pluginPaneFor,
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
      // A session on the workspace default is a plain chat (the sidebar's own
      // rule for its Chats tab); only a named project names the root crumb.
      sessionProject: activeProject && !activeProject.isDefault ? activeProject : undefined,
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
  }, [location, t, pluginViews, viewHistory, navigateToLocation, activeProject]);


  // The conversation action set. Built once so the pane header and the
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

  // The item a sidebar row asked the board to open, held until the board has
  // opened it. An event, not a location, for the same reason as the settings
  // section target above.
  const [workBoardFocusItemId, setWorkBoardFocusItemId] = useState<number | null>(null);
  const openWorkBoardItem = useCallback((itemId: number) => {
    handleViewSelectWithDoctor("work-board");
    setWorkBoardFocusItemId(itemId);
  }, [handleViewSelectWithDoctor]);

  /**
   * The side chat a sidebar row asked for, addressed to the tile that must show
   * it. Held as an event rather than a location for the same reason as the
   * board item above: the tile consumes it once and the request is spent.
   *
   * `nonce` is what makes asking for the SAME side chat twice two requests. The
   * ids alone would compare equal and the second click would do nothing.
   */
  const [sideChatOpenRequest, setSideChatOpenRequest] = useState<
    { chatGroupId: string; sessionId: string; nonce: number } | null
  >(null);
  const sideChatRequestNonce = useRef(0);
  const openSideChat = useCallback(async (sideChatSessionId: string, originSessionId?: string) => {
    // The conversation first: a side chat is shown beside the conversation it
    // belongs to, and the panel that draws it is that conversation's own. A
    // parent that cannot be reached is not a reason to refuse the side chat —
    // it opens beside whatever the focused tile is already holding.
    if (originSessionId !== undefined) {
      try {
        const loaded = await handleLoadSessionAndRefresh(originSessionId);
        if (loaded !== false) setActiveView("home");
      } catch (err) {
        console.warn("[lvis] openSideChat parent load failed:", errorMessage(err));
      }
    } else {
      setActiveView("home");
    }
    setSideChatOpenRequest({
      chatGroupId: chatGroupsRef.current.focusedId,
      sessionId: sideChatSessionId,
      nonce: ++sideChatRequestNonce.current,
    });
  }, [handleLoadSessionAndRefresh, setActiveView]);

  /**
   * Open a sidebar row's view in a NEW pane, beside the focused one.
   *
   * The pane and the view land in ONE commit: the claim above points the
   * navigation at the pane this call just made, so the window's location goes
   * straight from where it was to the view. Opening the pane and then
   * navigating as two commits would put the new pane's blank conversation
   * between them, and the visit history — which records the location it
   * observes — would keep that as a step the user never took.
   *
   * The selection itself is the ordinary one, so the plugin auth gate, the
   * Doctor interception and the no-duplicates rule are all still in front of
   * the destination. Nothing about where a view may go is decided twice here.
   *
   * Three outcomes, all of them stated:
   *   • already open in another pane → no new pane, and the ordinary selection
   *     focuses the pane that has it (`paneShowing` is that rule's one home);
   *   • no room on the canvas → a message, and nothing opens;
   *   • otherwise → a pane, focused, holding the view.
   */
  const openViewInNewPane = useCallback((key: string) => {
    // The same runtime boundary the focused-pane path has: a string that is not
    // a place the window can BE must not cost a pane. The rows whose key is a
    // shortcut rather than a location do not offer this gesture at all.
    const parsed = parseInlineViewKey(key);
    if (!parsed) {
      console.warn(`[nav] ignoring unknown view key '${key}'`);
      return;
    }
    if (chatGroups.paneShowing({ view: parsed.key }) === undefined) {
      const opened = chatGroups.openPane(
        chatGroups.focusedId,
        measuredCanvasSize(chatGroupCanvasRef.current),
      );
      if (opened === null) {
        statusPushToast({ severity: "warning", message: t("app.newPaneNoRoom"), ttlMs: 6000 });
        return;
      }
      newPaneTargetRef.current = opened;
    }
    try {
      handleViewSelectWithDoctor(key);
    } finally {
      // The claim is one event long. A plugin whose sign-in defers the open
      // lands later, by which time focus IS the new pane and the ordinary
      // path names it — so a claim that outlived this call could only ever
      // capture a navigation the gesture did not ask for.
      newPaneTargetRef.current = null;
    }
  }, [chatGroups, handleViewSelectWithDoctor, statusPushToast, t]);

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
    attention: {
      focusedChatGroupId: chatGroups.focusedId,
      // The focused PANE's own content, the same fact its `hidden` prop reads.
      conversationVisible:
        (chatGroups.contentById[chatGroups.focusedId]?.view ?? "home") === "home",
    },
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
  const toggleSlashPicker = useCallback(() => {
    if (activeView !== "home") {
      setActiveView("home");
      setSlashPickerOpen(true);
    } else {
      setSlashPickerOpen((prev) => !prev);
    }
  }, [activeView]);

  useAppBootstrap({
    api, refreshViews, refreshCards: async () => { await refreshCards(); }, checkApiKey,
    setActiveView, onOpenSettings,
    toggleSlashPicker,
  });
  // Plugin/agent/skill lifecycle → catalog refresh. Owns the in-flight install
  // tracker + every IPC subscription that keeps plugin views/cards/marketplace
  // fresh (install/uninstall/runtime/progress broadcasts, the preparing-plugin
  // poll, agent/skill install results). See use-plugin-lifecycle-refresh.ts.
  usePluginLifecycleRefresh({ api, pluginCards, refreshViews, refreshCards, refreshMarketplace });

  // Clear the SlashPicker's raise flag when navigating away from home. The
  // picker is only mounted on the home view, so a flag left set survives the
  // unmount and pops a menu the moment the user comes back.
  useEffect(() => {
    if (activeView !== "home") setSlashPickerOpen(false);
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
   * Follow an announcement's button.
   *
   * Navigation only, and deliberately exhaustive over the two target kinds:
   * an in-app place goes through the same `navigateToLocation` the breadcrumb
   * and the history use, and a web page goes through `openExternalUrl`, the
   * renderer's one external-navigation sink. Nothing here writes settings —
   * an announcement is content fetched from the marketplace, so a branch that
   * did would be a path from a marketplace post into this machine's
   * configuration. The user turns a feature on at the destination.
   */
  const handleMarketplaceAnnouncementAction = useCallback(
    (target: MarketplaceAnnouncementActionTarget) => {
      if (target.kind === "settings") {
        navigateToSettingsPath({ tab: target.settingsTab, section: target.settingsSection });
        return;
      }
      void api.openExternalUrl(target.url);
    },
    [navigateToSettingsPath, api],
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
    sideChatOpenRequest,
    isSessionStarred: (sessionId: string) => Boolean(isSessionStarred(sessionId)),
    handleToggleSessionStar,
    starredIsEntry, starredToggle,
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
    commandActions, slashPickerOpen, onSlashPickerOpenChange: setSlashPickerOpen,
    // The window answers where a card goes, because only it sees every tile.
    overlayCardTile: overlayCardTileForWindow,
    onPluginPrimaryAction: (id: string, chatGroupId: string) => {
      void handlePluginPrimaryAction(id, chatGroupId);
    },
    onRoutineAcknowledge: handleRoutineAcknowledge,
    onProposalAnswer: (
      id: string,
      disposition: OnboardingProposalDisposition,
      chatGroupId: string,
    ) => {
      void handleProposalAnswer(id, disposition, chatGroupId);
    },
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
    sideChatOpenRequest,
    isSessionStarred, handleToggleSessionStar, starredIsEntry, starredToggle,
    searchOpen, searchQuery, searchCase, searchMatches, searchMatchSet, searchIdx,
    searchHighlight, searchChangeQuery, searchToggleCase, searchNext, searchPrev,
    searchCloseOverlay, searchToggleOverlay,
    handleExport, handleImport, pluginEntries, handleViewSelectWithDoctor, appMode,
    commandActions, slashPickerOpen, overlayCardTileForWindow,
    handlePluginPrimaryAction, handleRoutineAcknowledge, handleProposalAnswer,
    interceptApprovalSentence,
    activeProject, defaultWorkspaceProject, workspaceProjects,
    onNewChatForProject, refreshWorkspaceProjects, handleProjectError,
  ]);

  // ─── Render ───────────────────────────────────
  /**
   * What ONE pane draws while it is not showing its conversation.
   *
   * The view is the pane's own — `contentById[paneId]` — not the window's, so
   * two panes can hold two different views at once and each closes back to its
   * own conversation. `null` means this pane is on home and the conversation
   * behind it is what shows.
   *
   * One branch per view keeps the router readable; a built-in view — Settings
   * included — and a plugin surface all go into the same frame a conversation
   * gets.
   */
  const renderPaneRoute = (view: InlineViewKey, paneId: string): ReactNode => {
    // Closing a routed pane does not close the pane: it puts THIS one back on
    // home, so the conversation the view was covering comes back (design §3).
    // Loading a conversation from Memory, Insights or Routines ends the same
    // way — content navigation, not a history replay, so the top toolbar keeps
    // exclusive ownership of visit history and the result reveals its chat.
    const closePane = () => chatGroups.setPaneContent(paneId, PANE_HOME);
    /*
     * What that close control is CALLED here, and the only place it is worked
     * out. "Close pane" is what the control does on a conversation pane, and it
     * would be a lie on this path: the pane stays, holding its conversation
     * again. So the label names the view being dismissed, taken from the title
     * the frame is already given rather than worked out a second time.
     */
    const routedCloseLabel = (title: string) => t("pane.closeView", { view: title });
    const pluginPane = pluginPaneFor(view);
    /*
     * What every pane is as a TILE, whatever it is showing.
     *
     * The same bindings the conversation frame gets, from the same source: a
     * pane holding the work board is focusable, splittable and maximizable
     * exactly as the conversation it replaced was, or the canvas would quietly
     * lose those controls the moment a view opened in a tile. `onClose` is the
     * one that differs — it hands the pane back to its conversation rather
     * than removing the pane — so it stays with each branch.
     */
    const asTile = {
      focused: chatGroups.focusedId === paneId,
      onFocus: () => chatGroups.focus(paneId),
      ...(chatGroups.canSplit ? {
        canSplit: true,
        onSplit: (axis: PaneSplitAxis) => chatGroups.split(paneId, axis),
        splitFits: (axis: PaneSplitAxis) => chatGroups.splitFits(
          paneId, axis, measuredCanvasSize(chatGroupCanvasRef.current),
        ),
      } : {}),
      ...(chatGroups.canMaximize ? {
        maximized: chatGroups.maximizedId === paneId,
        onToggleMaximize: () => chatGroups.toggleMaximize(paneId),
      } : {}),
    };
    /*
     * The routed body, inside the pane's own cell.
     *
     * The cell already carries the tile inset and the box the
     * split tree gave it, so the shell adds no margin of its
     * own — a routed pane's outline lands exactly where the
     * conversation it replaced drew one.
     *
     * `data-view` says which view this shell is holding.
     * `main-pane-shell` alone cannot: a second pane's shell is
     * one too, and both are in the DOM at the same time.
     */
    const paneShell = (view: InlineViewKey, frame: ReactNode) => (
      <div
        className="flex min-h-0 min-w-0 flex-1 flex-col"
        data-testid="main-pane-shell"
        data-view={view}
      >
        {frame}
      </div>
    );

    /*
     * A built-in view, drawn as a pane.
     *
     * The frame carries what used to be a heading INSIDE the
     * view: its name, its glyph, and — through
     * `usePaneActions` — the global controls that sat beside
     * that heading. Closing it does not close the pane: it
     * puts the pane back on `home`, so the conversation the
     * view was covering comes back (design §3).
     *
     * `bodyInset` is where the view's page margin lives, and
     * it lives in exactly one place per view: `page` for a
     * view whose body is one column of content, `none` for a
     * view that lays out its own regions to the hairline —
     * Settings, whose nav column's full-height divider has to
     * reach the frame's edge to read as two regions of one
     * pane rather than a card floating inside it.
     */
    const viewPane = (
      view: PaneViewKey,
      body: ReactNode,
      bodyInset: "none" | "page" = "page",
    ) => {
      const PaneIcon = BUILTIN_VIEW_ICONS[view];
      const title = t(BUILTIN_LABEL_KEYS[view]);
      return paneShell(view, (
        <PaneFrame
          title={title}
          icon={<PaneIcon className="h-4 w-4" />}
          bodyInset={bodyInset}
          onClose={closePane}
          closeLabel={routedCloseLabel(title)}
          {...asTile}
        >
          {body}
        </PaneFrame>
      ));
    };

    if (view === "memory") {
      return viewPane("memory", (
        <MemorySearchPanel
          api={api}
          project={activeProject ?? defaultWorkspaceProject}
          onOpenSession={async (sessionId) => {
            const loaded = await handleLoadSessionAndRefresh(sessionId);
            if (loaded !== false) closePane();
            return loaded;
          }}
        />
      ));
    }

    if (view === "insights" || view === "starred") {
      return viewPane(view, (
        <StarredView
          api={api}
          starred={starred}
          sessions={sessions}
          workspaceProjects={workspaceProjects}
          currentSessionId={currentSessionId}
          refreshStarred={refreshStarred}
          onJumpToSession={handleLoadSessionAndRefresh}
          onActivateHome={closePane}
        />
      ));
    }

    if (view === "routines") {
      return viewPane("routines", (
        <RoutinePanel
          api={api}
          onOpenSession={(sessionId) => {
            void (async () => {
              const loaded = await handleLoadSessionAndRefresh(sessionId);
              if (loaded !== false) closePane();
            })();
          }}
        />
      ));
    }

    if (view === "settings") {
      // Settings renders inline in EVERY appMode; there is no
      // detached settings window on this path. It lays out its
      // own two regions, so the frame insets it by nothing.
      return viewPane("settings", (
        <SettingsInlineView
          api={api}
          /* The away-authority binding names a CONVERSATION, and
             the focused pane is the one showing Settings — so it
             is the conversation pane focus came from, not the
             focused pane itself, that this means. */
          chatGroupId={paneId}
          initialTab={settingsTab}
          sectionTarget={settingsSectionTarget}
          onSectionApplied={clearSettingsSectionTarget}
          onSaved={handleInlineSettingsSaved}
          onTabChange={setSettingsTab}
          exactDenyDraft={exactDenyDraft ?? null}
          onExactDenySaved={handleExactDenySaved ?? (() => undefined)}
          onDiscardExactDeny={() => setExactDenyDraft(null)}
        />
      ), "none");
    }

    if (view === "work-board") {
      return viewPane("work-board", (
        <WorkBoardPanel
          api={api}
          project={activeProject ?? defaultWorkspaceProject}
          focusItemId={workBoardFocusItemId}
          onFocusConsumed={() => setWorkBoardFocusItemId(null)}
        />
      ));
    }

    // The conversations are rendered OUTSIDE this router — see
    // `chatSurface` above. They must stay mounted across view
    // navigation: each tile's stream subscription starts when it
    // mounts, so unmounting them to show Settings would drop the
    // frames of a turn that is still running.
    if (view === "home") return null;

    // Everything above narrowed away an inline BUILT-IN key, so what is
    // left is a plugin view — proven, not assumed. The annotation is the
    // proof: add a built-in to `BUILTIN_VIEWS` with `inline: true` and
    // forget a branch here, and this line stops compiling. That is what
    // replaced the old bare fallback, which rendered ANY unrecognized
    // string as a plugin view and so reported a misspelled destination
    // as a missing plugin.
    const pluginKey: PluginViewKey = view;
    void pluginKey;
    /*
     * The plugin surface is a pane BODY, framed exactly like
     * a built-in view: the header carries the extension's
     * label and the glyph its sidebar row draws — both from
     * the manifest, so the host holds no plugin-specific code
     * (architecture.md §9) — and the extension's description,
     * which used to be a second line of page chrome, is the
     * title's tooltip.
     *
     * It is UNMOUNTED whenever it is not what the pane holds,
     * not kept behind `display:none`. The conversation is the
     * one surface that must survive being covered — its
     * stream subscription, its composer draft and its scroll
     * position all live in it — and a guest kept alive
     * off-screen is a whole renderer process holding a
     * partition open for a view nobody is looking at. The
     * price is that coming back reloads the guest.
     */
    const PluginPaneIcon = pluginIconFor({
      icon: pluginPane.view?.icon,
      iconText: pluginPane.view?.iconText,
    });
    const pluginTitle = pluginPane.view
      ? getPluginViewLabel(pluginPane.view)
      : t("be_pluginUiHost.pluginUiTitle");
    return paneShell(view, (
      <PaneFrame
        title={pluginTitle}
        description={pluginPane.view?.extension.description
          ?? t("be_pluginUiHost.pluginUiLoadingDesc")}
        icon={(
          <Suspense fallback={<span className="h-4 w-4" />}>
            <PluginPaneIcon className="h-4 w-4" />
          </Suspense>
        )}
        onClose={closePane}
        closeLabel={routedCloseLabel(pluginTitle)}
        {...asTile}
      >
        <PluginUiHostView
          view={pluginPane.view ?? null}
          preparing={pluginPane.preparing}
          authError={pluginPane.authError ?? null}
        />
      </PaneFrame>
    ));
  };

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
                  content, plus the content surface's own leading padding.
                  Collapsed, the card retracts but its cluster strip stays bare
                  on this band, so the path clears THAT strip instead.
                  Overlaying (chat mode, expanded), the band is not pushed
                  either: it keeps the collapsed lead and the card floats
                  over the path the way it floats over the tile. */}
              <CustomTitleBar
                leadClearance={sidebarCollapsed || sidebarOverlay ? collapsedBandLeadClearance(isDarwinPlatform()) : sidebarWidth + SHELL_GUTTER + CONTENT_TITLE_INSET}
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
                  pluginUpdates={{
                    updates: marketplaceUpdates,
                    onDismiss: dismissMarketplaceUpdates,
                    onSkip: skipMarketplaceUpdates,
                    onResolved: resolveMarketplaceUpdates,
                    onUpdate: installPlugin,
                  }}
                  bootstrapStatus={{
                    status: bootstrapStatus,
                    onDismiss: dismissBootstrapStatus,
                    onRetry: () => void retryBootstrap(),
                  }}
                />
              </CustomTitleBar>
              {/* The floating-card Sidebar is anchored against the full-height shell
                  column above (NOT this content row) so its `top-0` spans up into the
                  band. The content `<main>` carries left padding equal to the card
                  width + insets so the rail never occludes the canvas. */}
              <Sidebar
                activeView={activeView}
                onSelect={handleViewSelectWithDoctor}
                /* Chat mode draws one pane and nothing of the others, so there
                   is no second pane to open into and the gesture is not
                   offered — the same rule that takes the split control out of
                   a pane header there. */
                onSelectInNewPane={appMode === "chat" ? undefined : openViewInNewPane}
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
                onOpenWorkBoardItem={openWorkBoardItem}
                onOpenSideChat={(sideChatSessionId, originSessionId) =>
                  void openSideChat(sideChatSessionId, originSessionId)}
                hasApiKey={effectiveLlmReady}
                subscriptionUnavailable={subscriptionUnavailableProvider !== undefined}
                subscriptionPending={subscriptionPendingProvider !== undefined}
                subscriptionRuntimePolicy={subscriptionRuntimePolicy}
                modelConfigured={chatModelConfigured}
                onOpenSettings={() => onOpenSettings()}
                onNewChat={onNewChat}
                onNewChatForProject={onNewChatForProject}
                onRefreshProjects={refreshWorkspaceProjects}
                onProjectError={handleProjectError}
                projects={workspaceProjects}
                streaming={streaming}
                collapsed={sidebarCollapsed}
                overlay={sidebarOverlay}
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
                  data-sidebar-overlay={sidebarOverlay ? "true" : undefined}
                  className={`relative flex min-h-0 min-w-0 flex-1 flex-col bg-background transition-[padding] duration-200 ease-out motion-reduce:transition-none ${
                    sidebarCollapsed || sidebarOverlay ? "pl-(--shell-collapsed-rail-reserve)" : ""
                  }`}
                  // Expanded: reserve the sidebar card width plus one SHELL_GUTTER
                  // of right gap so the floating rail never occludes the canvas.
                  // Collapsed uses the fixed `--shell-collapsed-rail-reserve`
                  // class above. Inline style so the durable, user-resized width
                  // (SystemSettings.sidebarWidth) drives the reserve directly —
                  // during a drag this tracks the live width for a seamless resize.
                  // Overlaying (chat mode, expanded) keeps the collapsed reserve:
                  // the card covers the tile rather than pushing it, so the
                  // surface neither changes width nor reflows.
                  style={sidebarCollapsed || sidebarOverlay ? undefined : { paddingLeft: `${sidebarWidth + SHELL_GUTTER}px` }}
                >
                  {/* The window's notice strip — the announcement banner, the
                      permission-memory toast and the window status toasts
                      (host notifications, installs, the app update). Each is
                      about the WINDOW, so it is subscribed once and drawn once,
                      here, IN FLOW: a flex sibling above the route canvas that
                      takes its height from the canvas. It used to float over
                      the canvas's top-right corner — the corner every pane
                      keeps for its own floating lane — so a tall stack covered
                      the rightmost tile's cards, and a tile's own dock drew the
                      window toasts once per tile. Nothing here is positioned,
                      so nothing here needs a sidebar inset: <main>'s leading
                      padding keeps in-flow content clear of the rail, and an
                      overlaying sidebar card covers this strip exactly as it
                      covers the tile below it. `empty:hidden` gives the strip
                      no height while every child renders null. Plugin updates
                      and managed-plugin bootstrap are toolbar pills, beside the
                      app-update pill (see MainToolbar). */}
                  <div
                    className="flex shrink-0 flex-col gap-2 px-(--chrome-gap) pt-2 empty:hidden [&>*]:m-0"
                    data-testid="window-notice-strip"
                  >
                    <MarketplaceAnnouncementBanner
                      announcements={marketplaceAnnouncements}
                      onDismiss={handleMarketplaceAnnouncementDismiss}
                      onAction={handleMarketplaceAnnouncementAction}
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
                    <StatusBar
                      persistent={statusPersistent}
                      visibleToast={statusVisibleToast}
                      pendingCount={statusPendingCount}
                      onToastClick={handleStatusToastClick}
                      onToastDismiss={(toast) => statusRemoveToast(toast.id)}
                    />
                  </div>
                  <DevToolsPanel
                    api={api}
                    open={devToolsOpen}
                    onClose={() => setDevToolsOpen(false)}
                    labelsOn={devLabelsOn}
                    onToggleLabels={() => setDevLabelsOn((v) => !v)}
                  />
                  {devLabelsOn && <DevComponentLabels />}
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
                    data-testid={TEST_IDS.routeCanvas}
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
                      {/* The panes. Every one of them, whatever it is showing:
                          a routed view is drawn INSIDE the pane that holds it,
                          so it takes that pane's box on the canvas and leaves
                          its neighbours alone.

                          The conversations under them stay mounted. A tile
                          subscribes to its group's stream when it mounts, so
                          swapping it out to render Settings would drop the
                          frames of a turn still in flight — and take the
                          composer draft and scroll position with it.

                          `data-visible` answers "is a conversation on screen":
                          with one pane it is the old `activeView === "home"`,
                          and with several it is true while any of them still
                          draws its conversation. Nothing in the window reads
                          it — the approval band decides from the tiles' claims
                          — it is the observable the route tests assert against
                          when they check that a gate still reaches the user
                          after the route has left the chat surface. `contents`
                          keeps the wrapper out of the layout entirely, so the
                          flex chain reads exactly as it does when this is the
                          only child. */}
                      <div
                        data-testid="chat-surface"
                        data-visible={chatGroups.groups.some((group) => !group.hidden
                          && (chatGroups.contentById[group.id]?.view ?? "home") === "home") ? "true" : "false"}
                        className="contents"
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
                                <div className="min-h-0 min-w-0 flex-1 pb-(--chrome-gap) pl-(--chrome-gap-tight) pr-(--chrome-gap) pt-0" data-testid="pane-row">
                                {/* The positioning context is INSIDE the padding: an
                                    absolutely-positioned child resolves against the padding
                                    box, so anchoring the tiles to the row itself would eat
                                    the air that lines the chat group's bottom edge up with
                                    the sidebar's. */}
                                <div ref={chatGroupCanvasRef} className="relative h-full w-full" data-testid="pane-canvas">
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
                                  /* Hidden, not unmounted: this tile's conversation
                                     may be mid-turn, and the turn's stream
                                     subscription, its streaming flag and its stop
                                     control all live inside the tile. */
                                  style={{ ...areaStyle(group.box), ...(group.hidden ? { display: "none" } : {}) }}
                                  data-testid={`pane-cell:${group.id}`}
                                  data-hidden={group.hidden ? "true" : undefined}
                                >
                                  {/* What this pane is showing. A routed view replaces
                                      the conversation IN THE CELL, so it inherits the
                                      tile's box, its inset and its place in the split
                                      tree — and the panes beside it keep drawing
                                      whatever they hold. */}
                                  {renderPaneRoute(
                                    (chatGroups.contentById[group.id]?.view ?? "home") as InlineViewKey,
                                    group.id,
                                  )}
                                  {/* The tile owns its conversation: every hook inside is
                                      keyed on its group-bound api, so two tiles stream at
                                      once without either seeing the other's transcript.

                                      Hidden rather than unmounted while a view covers it —
                                      the turn it may be streaming, its composer draft and
                                      its scroll position all live in here. `contents` while
                                      it draws, so the wrapper adds no box of its own. */}
                                  <div className={(chatGroups.contentById[group.id]?.view ?? "home") === "home"
                                    ? "contents"
                                    : "hidden"}>
                                  <ChatGroupSession
                                    chatGroupId={group.id}
                                    api={api}
                                    registry={chatGroupSessions}
                                    env={chatGroupEnvironment}
                                    panelOpen={group.panelOpen}
                                    focused={chatGroups.focusedId === group.id}
                                    // "Hidden" means this tile is not drawn on screen NOW, whatever
                                    // the reason. The tree answers one reason (another pane has the
                                    // box); the route answers the other (this pane is showing
                                    // Settings or a plugin view, so its conversation is behind
                                    // display:none). A tile that only knew the tree kept its
                                    // approval claim and drew its question cards into a surface
                                    // nobody could see, and the window-level bands — built for
                                    // exactly this — drew nothing. `conversationVisible` below
                                    // reads the same fact, and so does the wrapper above.
                                    //
                                    // The route is asked of THIS pane's own content, not of
                                    // the window: a pane showing Settings hides its
                                    // conversation, and a pane still on home does not,
                                    // whatever its neighbours are showing.
                                    hidden={group.hidden
                                      || (chatGroups.contentById[group.id]?.view ?? "home") !== "home"}
                                    onSidePanelOpenChange={(open) => chatGroups.setPanelOpen(group.id, open)}
                                  >
                                    {({ actions, trailing, content, currentSessionId: tileSessionId }) => (
                                      <PaneFrame
                                        title={
                                          sessions.find((session: SessionSummary) => session.id === tileSessionId)?.title
                                          ?? t("mainToolbar.newChat")
                                        }
                                        focused={chatGroups.focusedId === group.id}
                                        onFocus={() => chatGroups.focus(group.id)}
                                        onSessionDrop={(sessionId, target) =>
                                          handleSessionDrop(group.id, sessionId, target)}
                                        canSplit={chatGroups.canSplit}
                                        /* A conversation lays out its own transcript and composer to
                                           the hairline, and its work panel lands in the frame's aside
                                           slot — the two things this pane's content brings. */
                                        asideSlot
                                        bodyInset="none"
                                        trailing={trailing}
                                        actions={actions}
                                        {...(chatGroups.canSplit ? {
                                          onSplit: (axis: PaneSplitAxis) => chatGroups.split(group.id, axis),
                                          splitFits: (axis: PaneSplitAxis) => chatGroups.splitFits(
                                            group.id, axis, measuredCanvasSize(chatGroupCanvasRef.current),
                                          ),
                                        } : {})}
                                        {...(chatGroups.closable ? { onClose: () => closeChatGroup(group.id) } : {})}
                                        {...(chatGroups.canMaximize ? {
                                          maximized: chatGroups.maximizedId === group.id,
                                          onToggleMaximize: () => chatGroups.toggleMaximize(group.id),
                                        } : {})}
                                      >
                                        {content}
                                      </PaneFrame>
                                    )}
                                  </ChatGroupSession>
                                  </div>
                                </div>
                                ))}
                                {/* The boundaries sit in the 8px the cells' half-gutters
                                    leave between tiles, so the bar's strip is exactly
                                    the gap and steals nothing from either transcript. */}
                                {chatGroups.gutters.map((gutter) => (
                                  <PaneGutter
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
                    </ErrorBoundary>
                  </div>
                  {/* The window's own band: everything the window itself has to
                      show, stacked in one strip beside the tiles rather than
                      floating over them.

                      Two occupants. The dock draws only the approval requests
                      no conversation surface claimed (see `unclaimedApprovals`).
                      The overlay region draws only what no tile can draw: a
                      card whose origin conversation has left the screen, and
                      one pinned to a tile that has since closed. A card with no
                      origin belongs to the tile it arrived over — see
                      `overlayCardTile` — so it is drawn there, not here.

                      It is a BAND, not a float: a flex sibling BELOW the route
                      canvas, so the space it takes is space the tile grid does
                      not get, and nothing here can win a hit-test over a tile.
                      An absolutely positioned surface over the canvas left
                      `inert` and the caret alone and still took the click at a
                      tile composer's centre — keyboard-reachable, not
                      mouse-clickable. `empty:hidden` gives the band back when
                      both occupants draw nothing.

                      Its cap is what the tile grid can spare, not a share of
                      the viewport: the shortest tile still has to clear the
                      floor the split and resize rules already hold it to, or
                      every transcript on screen collapses to nothing. Below
                      `WINDOW_DOCK_MIN_HEIGHT` the band stops giving and its
                      occupants scroll inside it instead — `overflow-y-auto`,
                      because two occupants asking for more than the budget
                      would otherwise paint outside the band and back over the
                      tiles, which is the whole thing the band exists to stop. */}
                  <div
                    className="flex shrink-0 flex-col gap-2 overflow-y-auto overscroll-contain px-3 pb-3 empty:hidden"
                    style={{ maxHeight: windowBandMaxHeight }}
                    data-approval-scope
                    data-testid={TEST_IDS.windowApprovalScope}
                  >
                    <OverlayCardRegion
                      chatGroupId={null}
                      actionChatGroupId={chatGroups.focusedId}
                      overlayCardTile={overlayCardTileForWindow}
                      onPluginPrimaryAction={(id, chatGroupId) => {
                        void handlePluginPrimaryAction(id, chatGroupId);
                      }}
                      onRoutineAcknowledge={handleRoutineAcknowledge}
                      onProposalAnswer={(id, disposition, chatGroupId) => {
                        void handleProposalAnswer(id, disposition, chatGroupId);
                      }}
                    />
                    {strandedQuestion !== null && (
                      <div data-testid={TEST_IDS.questionOverlay}>
                        <AskUserQuestionCard
                          key={strandedQuestion.request.id}
                          api={api}
                          request={strandedQuestion.request}
                          onResolved={(id) => {
                            chatGroupSessions.read(strandedQuestion.chatGroupId)
                              ?.resolveAskQuestion(id);
                          }}
                        />
                      </div>
                    )}
                    <ApprovalDock
                      placement="window-chrome"
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
                      reviewerSuggestion={reviewerSuggestion}
                    />
                  </div>
                  {/* StatusBar notifications render inside ChatView, directly above
                      the composer. The composer's own status sub-row keeps showing
                      the ring / permission / model cells. The conversation's tool
                      activity is derived inside ChatView and shown by the right-docked
                      ChatSidePanel, so its open-actions reach the workspace store. */}
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
            <DevConsoleToggle />
          </OverlayContextProvider>
          </ApprovalSurfaceProvider>
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
