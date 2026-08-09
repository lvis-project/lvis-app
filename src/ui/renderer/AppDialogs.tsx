import type { getApi } from "./api-client.js";
import { DeferredQueueDialog } from "./dialogs/DeferredQueueDialog.js";
import { McpPromptArgsDialog } from "./dialogs/McpPromptArgsDialog.js";
import { SpotlightTour } from "./components/SpotlightTour.js";
import { PostTourFirstTask } from "./onboarding/PostTourFirstTask.js";
import { DevConsoleToggle } from "./components/DevConsoleToggle.js";

type Api = ReturnType<typeof getApi>;

/** App-level dialogs that remain available after removing setup flows. */
export function AppDialogs({
  api,
  deferredQueueOpen,
  onDeferredQueueOpenChange,
  tourCompleted,
  onTourComplete,
  onTourDismiss,
  pluginCards,
  onComposerSeedText,
  mcpPromptAwaitingArgs,
  onMcpPromptArgsCancel,
  onMcpPromptArgsSubmit,
}: {
  api: Api;
  deferredQueueOpen: boolean;
  onDeferredQueueOpenChange: (open: boolean) => void;
  tourCompleted: boolean;
  onTourComplete: () => void;
  onTourDismiss: () => void;
  pluginCards: Parameters<typeof PostTourFirstTask>[0]["pluginCards"];
  onComposerSeedText: (text: string) => void;
  /** The server-declared MCP prompt whose arguments the user is filling in. */
  mcpPromptAwaitingArgs: Parameters<typeof McpPromptArgsDialog>[0]["prompt"];
  onMcpPromptArgsCancel: Parameters<typeof McpPromptArgsDialog>[0]["onCancel"];
  onMcpPromptArgsSubmit: Parameters<typeof McpPromptArgsDialog>[0]["onSubmit"];
}) {
  return (
    <>
      <DeferredQueueDialog open={deferredQueueOpen} onOpenChange={onDeferredQueueOpenChange} />
      <McpPromptArgsDialog
        onCancel={onMcpPromptArgsCancel}
        onSubmit={onMcpPromptArgsSubmit}
        prompt={mcpPromptAwaitingArgs}
      />
      <SpotlightTour
        api={api}
        onComplete={onTourComplete}
        onDismiss={onTourDismiss}
      />
      <PostTourFirstTask
        onPrefillComposer={onComposerSeedText}
        pluginCards={pluginCards}
        tourCompleted={tourCompleted}
      />
      <DevConsoleToggle />
    </>
  );
}
