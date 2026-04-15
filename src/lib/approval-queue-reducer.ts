/**
 * Approval Queue Reducer — C4 §8 Parallel Approval Queue
 *
 * renderer.tsx ApprovalGate 구독을 single-slot → FIFO queue 로 승격.
 * 순수 함수로 분리해 jsdom 없이 unit test 가능.
 */
import type { ApprovalRequest } from "../core/approval-gate.js";

export type ApprovalQueueAction =
  | { type: "push"; req: ApprovalRequest }
  | { type: "shift" };

export function approvalQueueReducer(
  state: ApprovalRequest[],
  action: ApprovalQueueAction,
): ApprovalRequest[] {
  switch (action.type) {
    case "push":
      return [...state, action.req];
    case "shift":
      return state.slice(1);
  }
}
