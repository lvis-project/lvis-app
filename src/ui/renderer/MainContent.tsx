import type { ReactNode } from "react";
import { PluginUiHostView } from "../../plugin-ui-host.js";
import type { getApi } from "./api-client.js";
import { ChatContextProvider, type ChatContextValue } from "./context/ChatContext.js";
import { ChatView } from "./ChatView.js";
import { MemorySearchPanel } from "./components/MemorySearchPanel.js";
import { RoutinePanel } from "./components/RoutinePanel.js";
import { StarredView } from "./components/StarredView.js";
import { TaskView } from "./components/TaskView.js";

type Api = ReturnType<typeof getApi>;
type PluginView = Parameters<typeof PluginUiHostView>[0]["view"];
type StarredItem = Parameters<typeof StarredView>[0]["starred"][number];

export interface MainContentProps {
  activeView: string;
  api: Api;
  // starred
  starred: StarredItem[];
  currentSessionId: string;
  refreshStarred: () => void;
  // navigation
  onActivateHome: () => void;
  onJumpToSession: (sessionId: string) => void;
  onStartRoutineSession: (routineId: string) => Promise<void>;
  // chat
  chatContextValue: ChatContextValue;
  onAsk: (q: string) => Promise<void>;
  onGuide: (q: string) => Promise<void>;
  onEditSave: Parameters<typeof ChatView>[0]["onEditSave"];
  onFork: (entryIdx: number) => Promise<void>;
  onToggleStar: (entryIdx: number) => void;
  onRetryEffort: Parameters<typeof ChatView>[0]["onRetryEffort"];
  isEntryStarred: (entryIdx: number) => string | null;
  onAbort: () => Promise<void>;
  onFeedback: Parameters<typeof ChatView>[0]["onFeedback"];
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

  if (activeView === "tasks") {
    return (
      <MainPaneShell>
        <TaskView api={api} />
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

  if (activeView === "routines") {
    return (
      <MainPaneShell>
        <RoutinePanel
          api={api}
          onActivateHome={props.onActivateHome}
          onJumpToSession={props.onJumpToSession}
          onStartRoutineSession={props.onStartRoutineSession}
        />
      </MainPaneShell>
    );
  }

  if (activeView === "home") {
    return (
      <MainPaneShell padded={false}>
        <ChatContextProvider value={props.chatContextValue}>
          <ChatView
            onAsk={props.onAsk}
            onGuide={props.onGuide}
            onEditSave={props.onEditSave}
            onFork={props.onFork}
            onToggleStar={props.onToggleStar}
            onRetryEffort={props.onRetryEffort}
            isEntryStarred={props.isEntryStarred}
            onAbort={props.onAbort}
            onFeedback={props.onFeedback}
          />
        </ChatContextProvider>
      </MainPaneShell>
    );
  }

  return (
    <MainPaneShell>
      <PluginUiHostView view={props.activePluginView ?? null} />
    </MainPaneShell>
  );
}
