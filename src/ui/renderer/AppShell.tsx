import type { ReactNode } from "react";
import type { getApi } from "./api-client.js";
import { CustomTitleBar } from "./components/CustomTitleBar.js";
import { MainToolbar } from "./MainToolbar.js";
import { Sidebar } from "./components/Sidebar.js";
import { BootstrapStatusBanner } from "./components/BootstrapStatusBanner.js";
import { MarketplaceUpdateBanner } from "./components/MarketplaceUpdateBanner.js";
import { MarketplaceAnnouncementBanner } from "./components/MarketplaceAnnouncementBanner.js";
import { DevToolsPanel } from "./components/DevToolsPanel.js";
import { UnifiedSearchPanel } from "./components/UnifiedSearchPanel.js";
import type { useAppUpdate } from "./hooks/use-app-update.js";

type Api = ReturnType<typeof getApi>;
type MainToolbarProps = Parameters<typeof MainToolbar>[0];
type SidebarProps = Parameters<typeof Sidebar>[0];
type USPProps = Parameters<typeof UnifiedSearchPanel>[0];
type BootstrapBannerProps = Parameters<typeof BootstrapStatusBanner>[0];
type UpdateBannerProps = Parameters<typeof MarketplaceUpdateBanner>[0];
type AnnouncementBannerProps = Parameters<typeof MarketplaceAnnouncementBanner>[0];

/**
 * AppShell — the layout/sidebar/toolbar chrome around the routed main content.
 *
 * Behavior-preserving extraction of App.tsx's shell JSX: the full-height shell
 * column, the CustomTitleBar + MainToolbar band, the floating Sidebar, the
 * floating notification banner stack, the fallback toast, DevToolsPanel, the
 * UnifiedSearchPanel overlay, and the work-mode ActionPanel. The routed content
 * (the inner main-content ErrorBoundary + MainContent) is passed as `children`,
 * so App keeps ownership of that wiring while the chrome lives here. All
 * className strings, data-testids, and the DOM order are byte-identical to the
 * pre-extraction render tree.
 */
export function AppShell({
  api,
  children,
  // layout
  appMode,
  sidebarCollapsed,
  onToggleSidebarCollapse,
  sidebarWidth,
  onSidebarWidthChange,
  onSidebarWidthCommit,
  // toolbar
  activeView,
  streaming,
  hasApiKey,
  onToggleAppMode,
  onOpenDevTools,
  appUpdate,
  // sidebar
  onSelectView,
  pluginViews,
  pluginAuthStatuses,
  onOpenSettings,
  onNewChat,
  onNewChatForProject,
  onRefreshProjects,
  workspaceProjects,
  activeProject,
  onOpenMarketplace,
  marketplaceUrlReady,
  onOpenUnifiedSearch,
  currentSessionId,
  isCurrentSessionStarred,
  onToggleCurrentSessionStar,
  activeSidebarTab,
  onActiveSidebarTabChange,
  isSessionStarred,
  onToggleSessionStar,
  isProjectPinned,
  onToggleProjectPin,
  onExport,
  // banners
  bootstrapStatus,
  onDismissBootstrapStatus,
  onRetryBootstrap,
  marketplaceUpdates,
  onDismissMarketplaceUpdates,
  onSkipMarketplaceUpdates,
  onResolveMarketplaceUpdates,
  onUpdatePlugin,
  marketplaceAnnouncements,
  onDismissMarketplaceAnnouncement,
  // fallback toast
  fallbackToast,
  // dev tools
  devToolsOpen,
  onCloseDevTools,
  // unified search
  searchOpen,
  searchQuery,
  searchCase,
  entries,
  searchMatches,
  searchIdx,
  sessions,
  starred,
  onSearchChangeQuery,
  onSearchToggleCase,
  onSearchNext,
  onSearchPrev,
  onSearchJumpToMatch,
  onSearchOpen,
  onSearchClose,
  onSearchLoadSession,
  setActiveView,
  // side panel toggle (title bar → ChatSidePanel)
  sidePanelOpen,
  onToggleSidePanel,
}: {
  api: Api;
  children: ReactNode;
  appMode: MainToolbarProps["appMode"];
  sidebarCollapsed: boolean;
  onToggleSidebarCollapse: () => void;
  /** Persisted expanded sidebar width (px). Drives the card width + main padding. */
  sidebarWidth: number;
  /** Per-move drag update (state only). */
  onSidebarWidthChange: (px: number) => void;
  /** Drag-end / keyboard commit (persist). Also backs the resize bar's
   *  double-click reset (Sidebar commits SIDEBAR_DEFAULT_WIDTH through this). */
  onSidebarWidthCommit: (px: number) => void;
  activeView: string;
  streaming: boolean;
  hasApiKey: MainToolbarProps["hasApiKey"];
  onToggleAppMode: MainToolbarProps["onToggleAppMode"];
  onOpenDevTools: () => void;
  appUpdate: ReturnType<typeof useAppUpdate>;
  onSelectView: SidebarProps["onSelect"];
  pluginViews: SidebarProps["pluginViews"];
  pluginAuthStatuses: SidebarProps["pluginAuthStatuses"];
  onOpenSettings: (tab?: string) => void;
  onNewChat: () => void;
  onNewChatForProject: SidebarProps["onNewChatForProject"];
  onRefreshProjects: SidebarProps["onRefreshProjects"];
  workspaceProjects?: SidebarProps["projects"];
  activeProject?: USPProps["project"];
  onOpenMarketplace: () => void;
  marketplaceUrlReady: boolean;
  onOpenUnifiedSearch: () => void;
  currentSessionId: string;
  isCurrentSessionStarred: boolean;
  onToggleCurrentSessionStar: () => void | Promise<void>;
  activeSidebarTab?: SidebarProps["activeSidebarTab"];
  onActiveSidebarTabChange?: SidebarProps["onActiveSidebarTabChange"];
  isSessionStarred?: SidebarProps["isSessionStarred"];
  onToggleSessionStar?: SidebarProps["onToggleSessionStar"];
  isProjectPinned?: SidebarProps["isProjectPinned"];
  onToggleProjectPin?: SidebarProps["onToggleProjectPin"];
  onExport: SidebarProps["onExport"];
  bootstrapStatus: BootstrapBannerProps["status"];
  onDismissBootstrapStatus: BootstrapBannerProps["onDismiss"];
  onRetryBootstrap: () => void;
  marketplaceUpdates: UpdateBannerProps["updates"];
  onDismissMarketplaceUpdates: UpdateBannerProps["onDismiss"];
  onSkipMarketplaceUpdates: UpdateBannerProps["onSkip"];
  onResolveMarketplaceUpdates: NonNullable<UpdateBannerProps["onResolved"]>;
  onUpdatePlugin: UpdateBannerProps["onUpdate"];
  marketplaceAnnouncements: AnnouncementBannerProps["announcements"];
  onDismissMarketplaceAnnouncement: AnnouncementBannerProps["onDismiss"];
  fallbackToast: ReactNode;
  devToolsOpen: boolean;
  onCloseDevTools: () => void;
  searchOpen: boolean;
  searchQuery: USPProps["query"];
  searchCase: USPProps["caseSensitive"];
  entries: USPProps["entries"];
  searchMatches: USPProps["conversationMatches"];
  searchIdx: USPProps["currentConversationMatch"];
  sessions: USPProps["sessions"];
  starred: USPProps["starred"];
  onSearchChangeQuery: USPProps["onChangeQuery"];
  onSearchToggleCase: USPProps["onToggleCase"];
  onSearchNext: USPProps["onNextConversationMatch"];
  onSearchPrev: USPProps["onPrevConversationMatch"];
  onSearchJumpToMatch: (matchIndex: number) => void;
  onSearchOpen: USPProps["onOpen"];
  onSearchClose: USPProps["onClose"];
  onSearchLoadSession: (sessionId: string) => Promise<boolean | void>;
  setActiveView: (view: string) => void;
  sidePanelOpen: MainToolbarProps["sidePanelOpen"];
  onToggleSidePanel: MainToolbarProps["onToggleSidePanel"];
}) {
  return (
    /* `relative` makes THIS full-height shell column the positioning
       context for the floating-card Sidebar, so the card's `top-0` reaches
       the window top — extending UP into the traffic-light band and
       reclaiming that vertical space on the left. */
    <div className="relative flex h-screen flex-col overflow-hidden">
      {/* Single top band — window controls + the app toolbar cluster live
          together here. The toolbar content is passed as children so it
          renders IN the band (no separate toolbar row below it). */}
      <CustomTitleBar>
        <MainToolbar
          activeView={activeView}
          streaming={streaming}
          hasApiKey={hasApiKey}
          appMode={appMode}
          onToggleAppMode={onToggleAppMode}
          sidePanelOpen={sidePanelOpen}
          onToggleSidePanel={onToggleSidePanel}
          onOpenDevTools={onOpenDevTools}
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
        onSelect={onSelectView}
        pluginViews={pluginViews}
        pluginAuthStatuses={pluginAuthStatuses}
        sessions={sessions}
        currentSessionId={currentSessionId}
        onLoadSession={async (sessionId) => {
          const loaded = await onSearchLoadSession(sessionId);
          if (loaded !== false) setActiveView("home");
          return loaded;
        }}
        hasApiKey={hasApiKey}
        onOpenSettings={() => onOpenSettings()}
        onNewChat={onNewChat}
        onNewChatForProject={onNewChatForProject}
        onRefreshProjects={onRefreshProjects}
        projects={workspaceProjects}
        streaming={streaming}
        onOpenMarketplace={onOpenMarketplace}
        marketplaceUrlReady={marketplaceUrlReady}
        collapsed={sidebarCollapsed}
        onToggleCollapse={onToggleSidebarCollapse}
        width={sidebarWidth}
        onWidthChange={onSidebarWidthChange}
        onWidthCommit={onSidebarWidthCommit}
        onOpenUnifiedSearch={onOpenUnifiedSearch}
        isCurrentSessionStarred={isCurrentSessionStarred}
        onToggleCurrentSessionStar={onToggleCurrentSessionStar}
        activeSidebarTab={activeSidebarTab}
        onActiveSidebarTabChange={onActiveSidebarTabChange}
        isSessionStarred={isSessionStarred}
        onToggleSessionStar={onToggleSessionStar}
        isProjectPinned={isProjectPinned}
        onToggleProjectPin={onToggleProjectPin}
        onExport={onExport}
      />
      <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <main
          className={`relative flex min-h-0 min-w-0 flex-1 flex-col bg-background transition-[padding] duration-200 ease-out motion-reduce:transition-none ${
            sidebarCollapsed ? "pl-[4rem]" : ""
          }`}
          // Expanded: reserve the sidebar card width + the ~8px right gap so the
          // floating rail never occludes the canvas. Collapsed uses the fixed
          // pl-[4rem] class above. Inline style so the durable, user-resized
          // width (SystemSettings.sidebarWidth) drives the reserve directly —
          // during a drag this tracks the live width for a seamless resize.
          style={sidebarCollapsed ? undefined : { paddingLeft: `${sidebarWidth + 8}px` }}
        >
          {/* Floating notification stack — update/announcement banners are an
              OVERLAY, not in-flow content. They float over the canvas anchored
              top-RIGHT so they never push MainContent or the composer down. The
              wrapper is pointer-events-none (clicks pass through the gaps); each
              banner card re-enables pointer-events so Update/dismiss still work.
              The left edge is inset by the sidebar width (`left-[4.5rem]` /
              `left-[15rem]`, tracking <main>'s collapsed/expanded padding) so a
              wide banner (max-w-md) in a narrow window can never slide UNDER the
              floating sidebar card — absolute positioning resolves against
              main's padding box, which starts at the window edge beneath the
              rail. Multiple DISTINCT banners (bootstrap / update / announcement)
              stack vertically; each component collapses its own N items into a
              single counted card, so the stack height stays bounded. */}
          <div
            className={`pointer-events-none absolute right-2 top-2 z-50 ml-auto flex max-w-md flex-col gap-2 transition-[left] duration-200 ease-out motion-reduce:transition-none [&>*]:pointer-events-auto [&>*]:m-0 ${
              sidebarCollapsed ? "left-[4.5rem]" : ""
            }`}
            // Expanded: inset the banner stack past the resized sidebar card so a
            // wide banner can never slide under the floating rail. Tracks
            // sidebarWidth (+~16px gap) to stay just right of the card edge.
            style={sidebarCollapsed ? undefined : { left: `${sidebarWidth + 16}px` }}
          >
            <BootstrapStatusBanner status={bootstrapStatus} onDismiss={onDismissBootstrapStatus} onRetry={onRetryBootstrap} />
            <MarketplaceUpdateBanner
              updates={marketplaceUpdates}
              onDismiss={onDismissMarketplaceUpdates}
              onSkip={onSkipMarketplaceUpdates}
              onResolved={onResolveMarketplaceUpdates}
              onUpdate={onUpdatePlugin}
            />
            <MarketplaceAnnouncementBanner
              announcements={marketplaceAnnouncements}
              onDismiss={onDismissMarketplaceAnnouncement}
            />
          </div>
          {fallbackToast && (
            <div className="bg-warning text-warning-foreground text-xs px-4 py-2 border-b border-warning">
              {fallbackToast}
            </div>
          )}
          <DevToolsPanel
            api={api}
            open={devToolsOpen}
            onClose={onCloseDevTools}
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
              project={activeProject}
              starred={starred}
              onChangeQuery={onSearchChangeQuery}
              onToggleCase={onSearchToggleCase}
              onNextConversationMatch={onSearchNext}
              onPrevConversationMatch={onSearchPrev}
              onJumpToConversationMatch={(matchIndex) => {
                setActiveView("home");
                onSearchJumpToMatch(matchIndex);
              }}
              onOpen={onSearchOpen}
              onClose={onSearchClose}
              onLoadSession={async (sessionId) => {
                const loaded = await onSearchLoadSession(sessionId);
                if (loaded !== false) setActiveView("home");
                return loaded;
              }}
              onOpenMemoryView={() => {
                setActiveView("memory");
                onSearchClose();
              }}
              onOpenRoutinesView={() => {
                setActiveView("routines");
                onSearchClose();
              }}
            />
          )}

          {children}
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
  );
}
