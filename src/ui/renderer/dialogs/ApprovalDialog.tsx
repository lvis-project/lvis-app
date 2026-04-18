import { ToolApprovalDialog } from "../components/ToolApprovalDialog.js";
import type { ApprovalChoice, ApprovalRequest } from "../types.js";

export interface ApprovalDialogProps {
  queue: ApprovalRequest[];
  onDecide: (choice: ApprovalChoice, pattern?: string) => void | Promise<void>;
}

/**
 * App-level wrapper around ToolApprovalDialog — pulls the head-of-queue
 * request and forwards the decide handler. Keeps App.tsx free of inline
 * queue-shift plumbing.
 */
export function ApprovalDialog({ queue, onDecide }: ApprovalDialogProps) {
  return (
    <ToolApprovalDialog
      open={queue.length > 0}
      request={queue[0] ?? null}
      pendingCount={queue.length}
      onDecide={(choice, pattern) => void onDecide(choice, pattern)}
    />
  );
}
