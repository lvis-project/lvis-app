



import type { ApprovalRequest } from "../permissions/approval-gate.js";

/** Default maximum number of pending approval requests held in the queue. */
export const DEFAULT_APPROVAL_QUEUE_MAX = 50;

export type ApprovalQueueAction =
  | { type: "push"; req: ApprovalRequest; max?: number }
  | { type: "shift" }
  | { type: "clear" };

export function approvalQueueReducer(
  state: ApprovalRequest[],
  action: ApprovalQueueAction,
): ApprovalRequest[] {
  switch (action.type) {
    case "push": {
      const max = action.max ?? DEFAULT_APPROVAL_QUEUE_MAX;
      // Drop-newest when cap reached. The user is already looking at the
      // head-of-queue; dropping the tail (this new request) preserves their
      // focus and prevents DOS via queue flooding.
      if (state.length >= max) {
        return state;
      }
      return [...state, action.req];
    }
    case "shift":
      return state.slice(1);
    case "clear":
      // Administrative queue reset only. User-facing approvals are decided
      // one request at a time so unseen requests are never bulk-approved.
      return [];
  }


  return state;
}
