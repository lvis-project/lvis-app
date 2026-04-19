import type { ReactNode } from "react";
import { PluginUiHostView } from "../../plugin-ui-host.js";
import type { getApi } from "./api-client.js";
import { ChatContextProvider, type ChatContextValue } from "./context/ChatContext.js";
import { ChatView } from "./ChatView.js";
import { MemorySearchPanel } from "./components/MemorySearchPanel.js";
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
  // plugin view
  activePluginView: PluginView | null;
}

/**
 * Renders the active main-pane content. One view per branch keeps the router
 * readable and moves the ternary tower out of App.tsx.
 */
export function MainContent(props: MainContentProps): ReactNode {
  const { activeView, api } = props;

  if (activeView === "memory") return <MemorySearchPanel api={api} />;
  if (activeView === "tasks") return <TaskView api={api} />;

  if (activeView === "starred") {
    return (
      <StarredView
        api={api}
        starred={props.starred}
        currentSessionId={props.currentSessionId}
        refreshStarred={props.refreshStarred}
        onJumpToSession={props.onJumpToSession}
        onActivateHome={props.onActivateHome}
      />
    );
  }

  if (activeView === "home") {
    return (
      <ChatContextProvider value={props.chatContextValue}>
        <ChatView
          onAsk={props.onAsk}
          onEditSave={props.onEditSave}
          onFork={props.onFork}
          onToggleStar={props.onToggleStar}
          onRetryEffort={props.onRetryEffort}
          isEntryStarred={props.isEntryStarred}
          onAbort={props.onAbort}
          onFeedback={props.onFeedback}
        />
      </ChatContextProvider>
    );
  }

  return (
    <PluginUiHostView
      view={props.activePluginView ?? null}
      callPluginMethod={(m, p) => api.callPluginMethod(m, p)}
      onAskInHomeChat={async (q) => { props.onActivateHome(); await props.onAsk(q); }}
      onAddTask={(t) => api.addTask(t)}
    />
  );
}
