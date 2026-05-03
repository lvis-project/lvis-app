import type { ReactNode } from "react";
import { PluginUiHostView } from "../../plugin-ui-host.js";
import type { getApi } from "./api-client.js";
import { ChatContextProvider, type ChatContextValue } from "./context/ChatContext.js";
import { ChatView } from "./ChatView.js";
import { StackedChatView } from "./components/StackedChatView.js";
import { useStackedChat } from "./hooks/use-stacked-chat.js";
import type { PluginEntry } from "./components/PluginGridButton.js";
import type { AskUserQuestionRequest } from "./components/AskUserQuestionCard.js";
import type { InstallPhase } from "./hooks/use-plugin-marketplace.js";
import type { QuickAction } from "./components/CommandPopover.js";
import { MemorySearchPanel } from "./components/MemorySearchPanel.js";
import { RoutinePanel } from "./components/RoutinePanel.js";
import { StarredView } from "./components/StarredView.js";
import { TaskView } from "./components/TaskView.js";
import { RemindersList } from "./components/RemindersList.js";

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
  /**
   * §457 Phase 3: revert active session to the parent of a rotation
   * checkpoint. Surfaces the "여기로 되돌아가기" action on
   * StackedChatView's CheckpointDivider. Optional — when absent the
   * button is hidden even on rotation checkpoints.
   */
  onRevertCheckpoint?: (parentSessionId: string) => Promise<void>;
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
  // plugin view
  activePluginView: PluginView | null;
  /** Feature flag: use StackedChatView instead of ChatView. Default false. */
  useStackedChatView?: boolean;
}

function MainPaneShell({ children, padded = true }: { children: ReactNode; padded?: boolean }) {
  return (
    <div className={padded ? "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden p-4" : "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"}>
      {children}
    </div>
  );
}

/**
 * HomeChatPane — wraps ChatView or StackedChatView depending on the feature flag.
 * Owns useStackedChat hook (only instantiated when stacked view is active).
 */
function HomeChatPane(props: MainContentProps) {
  const { chatContextValue, api } = props;
  const useStacked = props.useStackedChatView ?? false;

  // useStackedChat is always called (rules of hooks). The `enabled` flag gates
  // its IPC effects so we don't pay for session-listing + per-session-history
  // calls when the legacy ChatView is rendered.
  const stackedChatHook = useStackedChat(api, props.currentSessionId, useStacked);

  if (useStacked) {
    return (
      <ChatContextProvider value={chatContextValue}>
        <StackedChatView
          api={props.api}
          historicalSessions={stackedChatHook.historicalSessions}
          currentSessionId={props.currentSessionId}
          entries={chatContextValue.entries}
          streaming={chatContextValue.streaming}
          askQuestions={props.askQuestions}
          onResolveAskQuestion={props.onResolveAskQuestion}
          onAsk={props.onAsk}
          onGuide={props.onGuide}
          onAbort={props.onAbort}
          loading={stackedChatHook.loading}
          reachedEnd={stackedChatHook.reachedEnd}
          sentinelRef={stackedChatHook.sentinelRef}
          scrollContainerRef={stackedChatHook.scrollContainerRef}
          plugins={props.plugins}
          onSelectPlugin={props.onSelectPlugin}
          commandActions={props.commandActions}
          commandPopoverOpen={props.commandPopoverOpen}
          onCommandPopoverOpenChange={props.onCommandPopoverOpenChange}
          installingPlugins={props.installingPlugins}
          onOpenMarketplace={props.onOpenMarketplace}
          marketplaceUrlReady={props.marketplaceUrlReady}
          onRetryEffort={props.onRetryEffort}
          onFork={props.onFork}
          onToggleStar={props.onToggleStar}
          isEntryStarred={props.isEntryStarred}
          onFeedback={props.onFeedback}
          {...(props.onRevertCheckpoint ? { onRevertCheckpoint: props.onRevertCheckpoint } : {})}
        />
      </ChatContextProvider>
    );
  }

  return (
    <ChatContextProvider value={chatContextValue}>
      <ChatView
        api={props.api}
        onAsk={props.onAsk}
        onGuide={props.onGuide}
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
        commandActions={props.commandActions}
        commandPopoverOpen={props.commandPopoverOpen}
        onCommandPopoverOpenChange={props.onCommandPopoverOpenChange}
        installingPlugins={props.installingPlugins}
        onOpenMarketplace={props.onOpenMarketplace}
        marketplaceUrlReady={props.marketplaceUrlReady}
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

  if (activeView === "tasks") {
    return (
      <MainPaneShell>
        <TaskView api={api} />
      </MainPaneShell>
    );
  }

  if (activeView === "reminders") {
    return (
      <MainPaneShell>
        <RemindersList api={api} />
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
