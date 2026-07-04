import type { ReactNode } from "react";
import { PluginUiHostView } from "../../plugin-ui-host.js";
import type { getApi } from "./api-client.js";
import { ChatContextProvider, type ChatContextValue } from "./context/ChatContext.js";
import { ChatView } from "./ChatView.js";
import type { PluginEntry } from "./components/PluginGridButton.js";
import type { AskUserQuestionRequest } from "./components/AskUserQuestionCard.js";
import type { QuickAction } from "./components/CommandPopover.js";
import { MemorySearchPanel } from "./components/MemorySearchPanel.js";
import { RoutinePanel } from "./components/RoutinePanel.js";
import { WorkBoardPanel } from "./components/WorkBoardPanel.js";
import { StarredView } from "./components/StarredView.js";
import { SettingsInlineView } from "./SettingsInlineView.js";
import { PageShell } from "./components/PageShell.js";
import type { SessionSummary } from "./hooks/use-sessions.js";
import type { UserKeyboardIntentSnapshot } from "../../shared/chat-origin.js";
import type { AppMode } from "./MainToolbar.js";
import type { ProjectIdentity } from "../../shared/project-identity.js";

type Api = ReturnType<typeof getApi>;
type PluginView = Parameters<typeof PluginUiHostView>[0]["view"];
type StarredItem = Parameters<typeof StarredView>[0]["starred"][number];

export interface MainContentProps {
  activeView: string;
  api: Api;
  // inline settings (work mode) — chat mode detaches Settings to its own
  // BrowserWindow and never routes through this branch.
  settingsTab: string;
  onSettingsSaved: () => void;
  onCloseSettings: () => void;
  // starred
  starred: StarredItem[];
  currentSessionId: string;
  currentSessionKind: "main" | "routine";
  currentSessionTitle?: string;
  sessions: SessionSummary[];
  activeProject?: ProjectIdentity;
  /** Full known project list — the SAME source Sidebar's project group reads
   *  from, threaded here so the empty-state composer's project selector
   *  (ComposerProjectSelector) shares one SOT with the sidebar. */
  workspaceProjects?: ProjectIdentity[];
  /** Switch the active project / start a new chat scoped to it — the SAME
   *  handler wired to the sidebar's project rows. */
  onNewChatForProject?: (project: { projectRoot?: string; projectName?: string }) => void | Promise<void>;
  /** Re-fetch the workspace project list (e.g. after adding a project folder
   *  from the composer selector) — the same refresh the sidebar's context
   *  menu already uses. */
  onRefreshProjects?: () => void | Promise<void>;
  refreshStarred: () => void;
  // navigation
  appMode: AppMode;
  onActivateHome: () => void;
  onJumpToSession: (sessionId: string) => void | boolean | Promise<void | boolean>;
  // chat
  chatContextValue: ChatContextValue;
  onAsk: (
    q: string,
    intent?: UserKeyboardIntentSnapshot,
    opts?: { injectHint?: "queue" | "interrupt"; inputOrigin?: "queue-auto" },
  ) => Promise<void>;
  onEditSave: Parameters<typeof ChatView>[0]["onEditSave"];
  onFork: (entryIdx: number) => Promise<void>;
  onToggleStar: (entryIdx: number) => void;
  onRetryEffort: Parameters<typeof ChatView>[0]["onRetryEffort"];
  onContinueFromLastUser: NonNullable<Parameters<typeof ChatView>[0]["onContinueFromLastUser"]>;
  isEntryStarred: (entryIdx: number) => string | null;
  onAbort: () => Promise<void>;
  onGuide: Parameters<typeof ChatView>[0]["onGuide"];
  onGuideError: Parameters<typeof ChatView>[0]["onGuideError"];
  onFeedback: Parameters<typeof ChatView>[0]["onFeedback"];
  // workflow tool state (lifted from ChatView to survive navigation)
  subAgentSpawns: Parameters<typeof ChatView>[0]["subAgentSpawns"];
  loadedSkills: Parameters<typeof ChatView>[0]["loadedSkills"];
  hasAskQuestions: boolean;
  /** Pending ask_user_question requests rendered inline at the end of the chat stream. */
  askQuestions: AskUserQuestionRequest[];
  /** Removes a request once the user submits or dismisses it. */
  onResolveAskQuestion: (id: string) => void;
  // plugins — surfaced inside the SlashPicker plugin category
  plugins: PluginEntry[];
  onSelectPlugin: (viewKey: string) => void;
  onOpenApprovalQueue?: () => void;
  // command popover
  commandActions: QuickAction[];
  commandPopoverOpen: boolean;
  onCommandPopoverOpenChange: (open: boolean) => void;
  // plugin view
  activePluginView: PluginView | null;
  pluginAuthError?: string | null;
  /** Called when user confirms a plugin overlay item; id is the OverlayItem.id. */
  onPluginPrimaryAction: (overlayItemId: string) => void;
  /** Called when a completed routine overlay result has been seen or dismissed. */
  onRoutineAcknowledge?: (routineId: string, firedAt: string) => void;
  statusBar?: Parameters<typeof ChatView>[0]["statusBar"];
  actionPanelOpen?: Parameters<typeof ChatView>[0]["actionPanelOpen"];
  onActionPanelOpenChange?: Parameters<typeof ChatView>[0]["onActionPanelOpenChange"];
  sidePanelOpen?: Parameters<typeof ChatView>[0]["sidePanelOpen"];
  onSidePanelOpenChange?: Parameters<typeof ChatView>[0]["onSidePanelOpenChange"];
}

function MainPaneShell({
  children,
  padded = true,
  backToHome = false,
  onBack,
}: {
  children: ReactNode;
  padded?: boolean;
  backToHome?: boolean;
  onBack?: () => void;
}) {
  return (
    <PageShell
      padded={padded}
      maxWidth={padded ? "6xl" : "none"}
      onBack={backToHome ? onBack : undefined}
      backTestId="main-content-back"
      contentClassName="flex min-h-0 min-w-0 flex-1 flex-col"
      data-testid="main-pane-shell"
    >
      {children}
    </PageShell>
  );
}

/**
 * HomeChatPane — renders ChatView as the single chat renderer (issue #547).
 */
function HomeChatPane(props: MainContentProps) {
  return (
    <ChatContextProvider value={props.chatContextValue}>
      <ChatView
        api={props.api}
        onAsk={props.onAsk}
        onEditSave={props.onEditSave}
        onFork={props.onFork}
        onToggleStar={props.onToggleStar}
        onRetryEffort={props.onRetryEffort}
        onContinueFromLastUser={props.onContinueFromLastUser}
        isEntryStarred={props.isEntryStarred}
        onAbort={props.onAbort}
        onGuide={props.onGuide}
        onGuideError={props.onGuideError}
        onFeedback={props.onFeedback}
        subAgentSpawns={props.subAgentSpawns}
        loadedSkills={props.loadedSkills}
        hasAskQuestions={props.hasAskQuestions}
        askQuestions={props.askQuestions}
        onResolveAskQuestion={props.onResolveAskQuestion}
        plugins={props.plugins}
        onSelectPlugin={props.onSelectPlugin}
        appMode={props.appMode}
        onOpenApprovalQueue={props.onOpenApprovalQueue}
        currentSessionKind={props.currentSessionKind}
        currentSessionTitle={props.currentSessionTitle}
        onLoadSession={props.onJumpToSession}
        commandActions={props.commandActions}
        commandPopoverOpen={props.commandPopoverOpen}
        onCommandPopoverOpenChange={props.onCommandPopoverOpenChange}
        onPluginPrimaryAction={props.onPluginPrimaryAction}
        onRoutineAcknowledge={props.onRoutineAcknowledge}
        statusBar={props.statusBar}
        actionPanelOpen={props.actionPanelOpen}
        onActionPanelOpenChange={props.onActionPanelOpenChange}
        sidePanelOpen={props.sidePanelOpen}
        onSidePanelOpenChange={props.onSidePanelOpenChange}
        blogLayout={props.appMode === "work"}
        activeProject={props.activeProject}
        workspaceProjects={props.workspaceProjects}
        onNewChatForProject={props.onNewChatForProject}
        onRefreshProjects={props.onRefreshProjects}
      />
    </ChatContextProvider>
  );
}

/**
 * Renders the active main-pane content. One view per branch keeps the router
 * readable and moves the ternary tower out of App.tsx.
 */
export function MainContent(props: MainContentProps): ReactNode {
  const { activeView, api } = props;

  if (activeView === "memory") {
    return (
      <MainPaneShell backToHome onBack={props.onActivateHome}>
        <MemorySearchPanel
          api={api}
          project={props.activeProject}
          onOpenSession={async (sessionId) => {
            const loaded = await props.onJumpToSession(sessionId);
            if (loaded !== false) props.onActivateHome();
            return loaded;
          }}
        />
      </MainPaneShell>
    );
  }

  if (activeView === "insights" || activeView === "starred") {
    return (
      <MainPaneShell backToHome onBack={props.onActivateHome}>
        <StarredView
          api={api}
          starred={props.starred}
          sessions={props.sessions}
          currentSessionId={props.currentSessionId}
          refreshStarred={props.refreshStarred}
          onJumpToSession={props.onJumpToSession}
          onActivateHome={props.onActivateHome}
        />
      </MainPaneShell>
    );
  }

  if (activeView === "routines") {
    return (
      <MainPaneShell backToHome onBack={props.onActivateHome}>
        <RoutinePanel
          api={api}
          onOpenSession={(sessionId) => {
            void (async () => {
              const loaded = await props.onJumpToSession(sessionId);
              if (loaded !== false) props.onActivateHome();
            })();
          }}
        />
      </MainPaneShell>
    );
  }

  if (activeView === "settings") {
    return (
      <MainPaneShell padded={false}>
        <SettingsInlineView
          api={api}
          initialTab={props.settingsTab}
          onSaved={props.onSettingsSaved}
          onBack={props.onCloseSettings}
        />
      </MainPaneShell>
    );
  }

  if (activeView === "work-board") {
    return (
      <MainPaneShell backToHome onBack={props.onActivateHome}>
        <WorkBoardPanel api={api} project={props.activeProject} />
      </MainPaneShell>
    );
  }

  if (activeView === "home") {
    return (
      <MainPaneShell padded={false}>
        <HomeChatPane {...props} />
      </MainPaneShell>
    );
  }

  return (
    <PluginUiHostView
      view={props.activePluginView ?? null}
      authError={props.pluginAuthError ?? null}
      onBack={props.onActivateHome}
    />
  );
}
