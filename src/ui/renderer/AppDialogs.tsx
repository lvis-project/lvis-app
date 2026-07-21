import type { getApi } from "./api-client.js";
import { ApprovalDialog } from "./dialogs/ApprovalDialog.js";
import { DeferredQueueDialog } from "./dialogs/DeferredQueueDialog.js";
import { SpotlightTour } from "./components/SpotlightTour.js";
import { PostTourFirstTask } from "./onboarding/PostTourFirstTask.js";
import { DevConsoleToggle } from "./components/DevConsoleToggle.js";
import { SnapEdgeHighlight } from "./components/SnapEdgeHighlight.js";

type Api = ReturnType<typeof getApi>;

/** App-level dialogs that remain available after removing setup flows. */
export function AppDialogs({
  api,
  deferredQueueOpen,
  onDeferredQueueOpenChange,
  approvalQueue,
  onApprovalDecide,
  tourCompleted,
  onTourComplete,
  onTourDismiss,
  installedPluginIds,
  onComposerSeedText,
}: {
  api: Api;
  deferredQueueOpen: boolean;
  onDeferredQueueOpenChange: (open: boolean) => void;
  approvalQueue: Parameters<typeof ApprovalDialog>[0]["queue"];
  onApprovalDecide: Parameters<typeof ApprovalDialog>[0]["onDecide"];
  tourCompleted: boolean;
  onTourComplete: () => void;
  onTourDismiss: () => void;
  installedPluginIds: string[];
  onComposerSeedText: (text: string) => void;
}) {
  return (
    <>
      <DeferredQueueDialog open={deferredQueueOpen} onOpenChange={onDeferredQueueOpenChange} />
      <ApprovalDialog queue={approvalQueue} onDecide={onApprovalDecide} />
      <SpotlightTour
        api={api}
        onComplete={onTourComplete}
        onDismiss={onTourDismiss}
      />
      <PostTourFirstTask
        api={{ composerSeedText: onComposerSeedText }}
        installedPluginIds={installedPluginIds}
        tourCompleted={tourCompleted}
      />
      <DevConsoleToggle />
      <SnapEdgeHighlight />
    </>
  );
}
