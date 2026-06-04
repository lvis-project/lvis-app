/**
 * Approval Queue Reducer — C4 §8 Parallel Approval Queue
 *
 * renderer.tsx ApprovalGate 구독을 single-slot → FIFO queue 로 승격.
 * 순수 함수로 분리해 jsdom 없이 unit test 가능.
 *
 * Queue depth cap (default 50) to prevent unbounded growth when a
 * misbehaving agent floods approval requests. When the cap is exceeded, the
 * NEWEST incoming push is rejected (drop-newest). Drop-newest preserves
 * ordering of in-flight requests the user is already committed to deciding,
 * and prevents an attacker from evicting a legitimate pending request by
 * flooding new ones.
 */
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
  // Copilot review fix: TypeScript discriminated union 이 모든 case 를 cover
  // 하지만 runtime 에서 알 수 없는 action 타입이 들어오는 경우 (e.g. IPC
  // payload 손상, 라이브러리 업그레이드로 새 타입 추가) 를 위해 안전한 fallback.
  return state;
}
