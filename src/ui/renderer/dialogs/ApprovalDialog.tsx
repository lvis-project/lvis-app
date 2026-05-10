import { OutOfAllowedDirCard } from "../components/permissions/OutOfAllowedDirCard.js";
import { ToolApprovalDialog } from "../components/ToolApprovalDialog.js";
import type { ApprovalChoice, ApprovalRequest } from "../types.js";

export interface ApprovalDialogProps {
  queue: ApprovalRequest[];
  onDecide: (choice: ApprovalChoice, pattern?: string) => void | Promise<void>;
  /**
   * Bulk approve/deny every pending request at once. When the LLM emits
   * multiple tool calls in one round, the dialog surfaces "모두 허용" /
   * "모두 거부" buttons that route here.
   */
  onDecideAll?: (choice: "allow-once" | "deny-once") => void | Promise<void>;
}

/**
 * App-level wrapper around ToolApprovalDialog — pulls the head-of-queue
 * request and forwards the decide handler. Keeps App.tsx free of inline
 * queue-shift plumbing.
 */
export function ApprovalDialog({ queue, onDecide, onDecideAll }: ApprovalDialogProps) {
  const request = queue[0] ?? null;

  if (request?.kind === "out-of-allowed-dir") {
    return (
      <OutOfAllowedDirCard
        open={queue.length > 0}
        request={request}
        onDecide={(choice, pattern) => void onDecide(choice, pattern)}
      />
    );
  }

  return (
    <ToolApprovalDialog
      open={queue.length > 0}
      request={request}
      pendingCount={queue.length}
      onDecide={(choice, pattern) => void onDecide(choice, pattern)}
      onDecideAll={onDecideAll ? (choice) => void onDecideAll(choice) : undefined}
    />
  );
}
