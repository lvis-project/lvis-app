/**
 * Tests — approvalQueueReducer (C4 Approval Queue Logic)
 */
import { describe, it, expect } from "vitest";
import { approvalQueueReducer } from "../approval-queue-reducer.js";
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
