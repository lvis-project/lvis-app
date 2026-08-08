import { ToolApprovalDialog } from "../components/ToolApprovalDialog.js";
import type { ApprovalDecisionExtras } from "../hooks/use-approval.js";
import type { ApprovalChoice, ApprovalRequest } from "../types.js";

export interface ApprovalDialogProps {
  queue: ApprovalRequest[];
  onDecide: (
    choice: ApprovalChoice,
    pattern?: string,
    extras?: ApprovalDecisionExtras,
  ) => void | Promise<void>;
}

/**
 * App-level wrapper around ToolApprovalDialog — pulls the head-of-queue
 * request and forwards the decide handler. Keeps App.tsx free of inline
 * queue-shift plumbing.
 */
export function ApprovalDialog({ queue, onDecide }: ApprovalDialogProps) {
  const request = queue[0] ?? null;

  // Out-of-allowed-dir is served by the docked, non-modal DockedApprovalCard
  // in the composer dock (issue #1940). Rendering a modal here too would put
  // two surfaces on one decision.
  if (request?.kind === "out-of-allowed-dir") return null;

  return (
    <ToolApprovalDialog
      open={queue.length > 0}
      request={request}
      pendingCount={queue.length}
      onDecide={(choice, pattern, extras) => {
        if (extras === undefined) {
          void onDecide(choice, pattern);
        } else {
          void onDecide(choice, pattern, extras);
        }
      }}
    />
  );
}
