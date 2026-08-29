



import type { ApprovalRequest } from "../permissions/approval-gate.js";

/** Default maximum number of pending approval requests held in the queue. */
export const DEFAULT_APPROVAL_QUEUE_MAX = 50;

export type ApprovalQueueAction =
  | { type: "push"; req: ApprovalRequest; max?: number }
  | { type: "shift" }
  /**
   * Remove requests the host has already settled without the renderer's
   * answer (timed out, or cancelled with the turn they belonged to). Their
   * cards answer nothing any more; kept, the dock would show a prompt whose
   * buttons reach nothing.
   */
  | { type: "drop"; ids: readonly string[] }
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
    case "drop": {
      const dropped = new Set(action.ids);
      const next = state.filter((req) => !dropped.has(req.id));
      return next.length === state.length ? state : next;
    }
    case "clear":
      // Administrative queue reset only. User-facing approvals are decided
      // one request at a time so unseen requests are never bulk-approved.
      return [];
  }


  return state;
}
