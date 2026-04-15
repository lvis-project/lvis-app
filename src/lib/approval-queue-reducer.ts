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
  // Copilot review fix: TypeScript discriminated union 이 모든 case 를 cover
  // 하지만 runtime 에서 알 수 없는 action 타입이 들어오는 경우 (e.g. IPC
  // payload 손상, 라이브러리 업그레이드로 새 타입 추가) 를 위해 안전한 fallback.
  return state;
}
