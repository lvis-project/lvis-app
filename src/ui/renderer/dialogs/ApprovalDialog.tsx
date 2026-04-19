import { ToolApprovalDialog } from "../components/ToolApprovalDialog.js";
import type { ApprovalChoice, ApprovalRequest } from "../types.js";

export interface ApprovalDialogProps {
  queue: ApprovalRequest[];
  onDecide: (choice: ApprovalChoice, pattern?: string) => void | Promise<void>;
  /**
   * D4 §4.5.3 — bulk approve/deny every pending request at once.
   * When the LLM emits multiple tool_calls in one round (parallel execution),
   * the dialog surfaces "모두 허용" / "모두 거부" buttons that route here.
   */
  onDecideAll?: (choice: "allow-once" | "deny-once") => void | Promise<void>;
}

/**
 * App-level wrapper around ToolApprovalDialog — pulls the head-of-queue
 * request and forwards the decide handler. Keeps App.tsx free of inline
 * queue-shift plumbing.
 */
export function ApprovalDialog({ queue, onDecide, onDecideAll }: ApprovalDialogProps) {
  return (
    <ToolApprovalDialog
      open={queue.length > 0}
      request={queue[0] ?? null}
      pendingCount={queue.length}
      onDecide={(choice, pattern) => void onDecide(choice, pattern)}
      onDecideAll={onDecideAll ? (choice) => void onDecideAll(choice) : undefined}
    />
  );
}
