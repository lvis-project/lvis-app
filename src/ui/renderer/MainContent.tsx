import type { ReactNode } from "react";
import { PluginUiHostView } from "../../plugin-ui-host.js";
import type { getApi } from "./api-client.js";
import { ChatContextProvider, type ChatContextValue } from "./context/ChatContext.js";
import { ChatView } from "./ChatView.js";
import type { PluginEntry } from "./components/PluginGridButton.js";
import type { AskUserQuestionRequest } from "./components/AskUserQuestionCard.js";
import type { InstallPhase } from "./hooks/use-plugin-marketplace.js";
import type { QuickAction } from "./components/CommandPopover.js";
import { MemorySearchPanel } from "./components/MemorySearchPanel.js";
import { RoutinePanel } from "./components/RoutinePanel.js";
import { StarredView } from "./components/StarredView.js";
import type { SessionSummary } from "./hooks/use-sessions.js";

type Api = ReturnType<typeof getApi>;
type PluginView = Parameters<typeof PluginUiHostView>[0]["view"];
type StarredItem = Parameters<typeof StarredView>[0]["starred"][number];

export interface MainContentProps {
  activeView: string;
  api: Api;
  // starred
  starred: StarredItem[];
  currentSessionId: string;
  sessions: SessionSummary[];
  refreshStarred: () => void;
  // navigation
  onActivateHome: () => void;
  onJumpToSession: (sessionId: string) => void;
  onRefreshSessions: () => void | Promise<void>;
  // chat
  chatContextValue: ChatContextValue;
  onAsk: (q: string) => Promise<void>;
  onEditSave: Parameters<typeof ChatView>[0]["onEditSave"];
  onFork: (entryIdx: number) => Promise<void>;
  onToggleStar: (entryIdx: number) => void;
  onRetryEffort: Parameters<typeof ChatView>[0]["onRetryEffort"];
  isEntryStarred: (entryIdx: number) => string | null;
  onAbort: () => Promise<void>;
  onFeedback: Parameters<typeof ChatView>[0]["onFeedback"];
  // workflow tool state (lifted from ChatView to survive navigation)
  subAgentSpawns: Parameters<typeof ChatView>[0]["subAgentSpawns"];
  loadedSkills: Parameters<typeof ChatView>[0]["loadedSkills"];
  hasAskQuestions: boolean;
  /** Pending ask_user_question requests rendered inline at the end of the chat stream. */
  askQuestions: AskUserQuestionRequest[];
  /** Removes a request once the user submits or dismisses it. */
  onResolveAskQuestion: (id: string) => void;
  // plugin grid for InputActionBar
  plugins: PluginEntry[];
  onSelectPlugin: (viewKey: string) => void;
  // command popover
  commandActions: QuickAction[];
  commandPopoverOpen: boolean;
  onCommandPopoverOpenChange: (open: boolean) => void;
  installingPlugins?: ReadonlyMap<string, InstallPhase>;
  onOpenMarketplace: () => void;
  marketplaceUrlReady?: boolean;
  /** Q10 — set of routineIds currently executing */
  runningRoutines?: Set<string>;
  // plugin view
  activePluginView: PluginView | null;
}

function MainPaneShell({ children, padded = true }: { children: ReactNode; padded?: boolean }) {
  return (
    <div className={padded ? "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden p-4" : "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"}>
      {children}
    </div>
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
        isEntryStarred={props.isEntryStarred}
        onAbort={props.onAbort}
        onFeedback={props.onFeedback}
        subAgentSpawns={props.subAgentSpawns}
        loadedSkills={props.loadedSkills}
        hasAskQuestions={props.hasAskQuestions}
        askQuestions={props.askQuestions}
        onResolveAskQuestion={props.onResolveAskQuestion}
        plugins={props.plugins}
        onSelectPlugin={props.onSelectPlugin}
        sessions={props.sessions}
        onLoadSession={props.onJumpToSession}
        onRefreshSessions={props.onRefreshSessions}
        commandActions={props.commandActions}
        commandPopoverOpen={props.commandPopoverOpen}
        onCommandPopoverOpenChange={props.onCommandPopoverOpenChange}
        installingPlugins={props.installingPlugins}
        onOpenMarketplace={props.onOpenMarketplace}
        marketplaceUrlReady={props.marketplaceUrlReady}
        runningRoutines={props.runningRoutines}
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
      <MainPaneShell>
        <MemorySearchPanel api={api} />
      </MainPaneShell>
    );
  }

  if (activeView === "starred") {
    return (
      <MainPaneShell>
        <StarredView
          api={api}
          starred={props.starred}
          currentSessionId={props.currentSessionId}
          refreshStarred={props.refreshStarred}
          onJumpToSession={props.onJumpToSession}
          onActivateHome={props.onActivateHome}
        />
      </MainPaneShell>
    );
  }

  if (activeView === "reminders" || activeView === "routines") {
    return (
      <MainPaneShell>
        <RoutinePanel api={api} />
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
    <MainPaneShell>
      <PluginUiHostView view={props.activePluginView ?? null} />
    </MainPaneShell>
  );
}
