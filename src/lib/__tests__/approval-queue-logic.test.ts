/**
 * Tests — approvalQueueReducer (C4 Approval Queue Logic)
 */
import { describe, it, expect } from "vitest";
import {
  approvalQueueReducer,
  isApprovalQueueFull,
  DEFAULT_APPROVAL_QUEUE_MAX,
} from "../approval-queue-reducer.js";
import type { ApprovalRequest } from "../../permissions/approval-gate.js";

function makeReq(id: string): ApprovalRequest {
  return {
    id,
    category: "tool",
    toolName: `tool_${id}`,
    args: {},
    reason: `test ${id}`,
    source: "builtin",
    createdAt: Date.now(),
    requireExplicit: false,
  };
}

describe("approvalQueueReducer", () => {
  it("push 2개 후 shift → 첫 번째 사라지고 두 번째가 top", () => {
    const r1 = makeReq("r1");
    const r2 = makeReq("r2");
    let state = approvalQueueReducer([], { type: "push", req: r1 });
    state = approvalQueueReducer(state, { type: "push", req: r2 });
    state = approvalQueueReducer(state, { type: "shift" });
    expect(state).toHaveLength(1);
    expect(state[0].id).toBe("r2");
  });

  it("concurrent 3 push 시 FIFO 순서 보존", () => {
    const reqs = ["a", "b", "c"].map(makeReq);
    let state: ApprovalRequest[] = [];
    for (const req of reqs) {
      state = approvalQueueReducer(state, { type: "push", req });
    }
    expect(state.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("빈 queue 에서 shift → empty 유지", () => {
    const state = approvalQueueReducer([], { type: "shift" });
    expect(state).toHaveLength(0);
  });

  it("동일 requestId push 는 duplicate 허용 (dedup 은 pending Map 역할)", () => {
    const req = makeReq("dup");
    let state = approvalQueueReducer([], { type: "push", req });
    state = approvalQueueReducer(state, { type: "push", req });
    expect(state).toHaveLength(2);
    expect(state[0].id).toBe("dup");
    expect(state[1].id).toBe("dup");
  });

  it("D3: push rejected when queue is at default cap (drop-newest)", () => {
    let state: ApprovalRequest[] = [];
    for (let i = 0; i < DEFAULT_APPROVAL_QUEUE_MAX; i++) {
      state = approvalQueueReducer(state, {
        type: "push",
        req: makeReq(`r${i}`),
      });
    }
    expect(state).toHaveLength(DEFAULT_APPROVAL_QUEUE_MAX);
    const overflow = makeReq("overflow");
    const next = approvalQueueReducer(state, { type: "push", req: overflow });
    expect(next).toHaveLength(DEFAULT_APPROVAL_QUEUE_MAX);
    expect(next.find((r) => r.id === "overflow")).toBeUndefined();
    expect(next).toBe(state);
  });

  it("D3: custom max caps queue and preserves FIFO order of accepted items", () => {
    let state: ApprovalRequest[] = [];
    for (const id of ["a", "b", "c", "d"]) {
      state = approvalQueueReducer(state, {
        type: "push",
        req: makeReq(id),
        max: 3,
      });
    }
    expect(state.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("D3: after shift below cap, push is accepted again", () => {
    let state: ApprovalRequest[] = [];
    for (const id of ["a", "b", "c"]) {
      state = approvalQueueReducer(state, {
        type: "push",
        req: makeReq(id),
        max: 3,
      });
    }
    state = approvalQueueReducer(state, {
      type: "push",
      req: makeReq("d"),
      max: 3,
    });
    expect(state.map((r) => r.id)).toEqual(["a", "b", "c"]);
    state = approvalQueueReducer(state, { type: "shift" });
    state = approvalQueueReducer(state, {
      type: "push",
      req: makeReq("e"),
      max: 3,
    });
    expect(state.map((r) => r.id)).toEqual(["b", "c", "e"]);
  });

  it("D3: isApprovalQueueFull reflects cap state", () => {
    const full = Array.from({ length: 3 }, (_, i) => makeReq(`r${i}`));
    expect(isApprovalQueueFull(full, 3)).toBe(true);
    expect(isApprovalQueueFull(full.slice(0, 2), 3)).toBe(false);
    expect(isApprovalQueueFull([], 3)).toBe(false);
  });

  it("shift 반복 → 순서대로 소진", () => {
    const reqs = ["x", "y", "z"].map(makeReq);
    let state: ApprovalRequest[] = [];
    for (const req of reqs) state = approvalQueueReducer(state, { type: "push", req });

    state = approvalQueueReducer(state, { type: "shift" });
    expect(state[0].id).toBe("y");
    state = approvalQueueReducer(state, { type: "shift" });
    expect(state[0].id).toBe("z");
    state = approvalQueueReducer(state, { type: "shift" });
    expect(state).toHaveLength(0);
  });
});
