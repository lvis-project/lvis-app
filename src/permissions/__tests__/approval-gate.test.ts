/**
 * ApprovalGate unit tests
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ApprovalGate } from "../approval-gate.js";
import type { ApprovalRequest, ApprovalDecision } from "../approval-gate.js";
import type { PolicyFile } from "../policy-store.js";

// ─── Mock WebContents ─────────────────────────────────

function makeMockWebContents(opts: { isDestroyed?: boolean; sendThrows?: boolean } = {}) {
  return {
    send: vi.fn(() => {
      if (opts.sendThrows) throw new Error("webContents destroyed (race)");
    }),
    isDestroyed: vi.fn(() => opts.isDestroyed ?? false),
  };
}

// requestAndWait accepts Omit<ApprovalRequest, "requireExplicit"> — no requireExplicit here
type RequestInput = Omit<ApprovalRequest, "requireExplicit">;

function makeRequest(overrides?: Partial<RequestInput>): RequestInput {
  return {
    id: "req-1",
    category: "tool",
    toolName: "memory_save",
    args: { title: "test", content: "hello" },
    reason: "상태 변경 도구 (trust: high, category: write)",
    source: "builtin",
    createdAt: Date.now(),
    ...overrides,
  };
}

function makePolicy(overrides?: Partial<PolicyFile>): PolicyFile {
  return {
    version: 1,
    requireExplicitApproval: true,
    managed: false,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────

describe("ApprovalGate", () => {
  it("requestAndWait resolves when resolve() is called", async () => {
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const req = makeRequest();

    const promise = gate.requestAndWait(req);

    // gate enriches req with requireExplicit before sending
    expect(wc.send).toHaveBeenCalledWith("lvis:approval:request", {
      ...req,
      requireExplicit: true,
    });

    const decision: ApprovalDecision = { requestId: req.id, choice: "allow-once" };
    gate.resolve(req.id, decision);

    const result = await promise;
    expect(result.choice).toBe("allow-once");
    expect(result.requestId).toBe("req-1");
  });

  it("timeout returns deny-once after timeoutMs", async () => {
    vi.useFakeTimers();
    const wc = makeMockWebContents();
    // initialPolicy is now the 2nd arg — pass undefined to use default, timeoutMs is 3rd
    const gate = new ApprovalGate(wc as never, undefined, 1000); // 1s timeout
    const req = makeRequest({ id: "req-timeout" });

    const promise = gate.requestAndWait(req);

    // 타임아웃 경과
    vi.advanceTimersByTime(1001);

    const result = await promise;
    expect(result.choice).toBe("deny-once");
    expect(result.requestId).toBe("req-timeout");

    vi.useRealTimers();
  });

  it("concurrent requests do not cross-contaminate", async () => {
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);

    const req1 = makeRequest({ id: "req-a", toolName: "tool_a" });
    const req2 = makeRequest({ id: "req-b", toolName: "tool_b" });

    const p1 = gate.requestAndWait(req1);
    const p2 = gate.requestAndWait(req2);

    // req-b를 먼저 응답
    gate.resolve("req-b", { requestId: "req-b", choice: "deny-once" });
    // req-a를 나중에 응답
    gate.resolve("req-a", { requestId: "req-a", choice: "allow-always" });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.choice).toBe("allow-always");
    expect(r2.choice).toBe("deny-once");
    expect(r1.requestId).toBe("req-a");
    expect(r2.requestId).toBe("req-b");
  });

  it("webContents.send is called with the correct channel and payload shape", async () => {
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const req = makeRequest({ id: "req-shape" });

    gate.requestAndWait(req);

    expect(wc.send).toHaveBeenCalledTimes(1);
    const [channel, payload] = wc.send.mock.calls[0] as [string, ApprovalRequest];
    expect(channel).toBe("lvis:approval:request");
    expect(payload.id).toBe("req-shape");
    expect(payload.toolName).toBe("memory_save");
    expect(payload.category).toBe("tool");
    expect(payload.source).toBe("builtin");
    // default policy: requireExplicitApproval = true
    expect(payload.requireExplicit).toBe(true);

    // cleanup
    gate.resolve(req.id, { requestId: req.id, choice: "deny-once" });
  });

  it("requireExplicit=false가 페이로드에 포함됨 (policy.requireExplicitApproval=false)", async () => {
    const wc = makeMockWebContents();
    const policy = makePolicy({ requireExplicitApproval: false });
    const gate = new ApprovalGate(wc as never, policy);
    const req = makeRequest({ id: "req-nonstrict" });

    gate.requestAndWait(req);

    const [, payload] = wc.send.mock.calls[0] as [string, ApprovalRequest];
    expect(payload.requireExplicit).toBe(false);

    // cleanup
    gate.resolve(req.id, { requestId: req.id, choice: "deny-once" });
  });

  it("setPolicy 호출 후 다음 request에 새 requireExplicit 반영", async () => {
    const wc = makeMockWebContents();
    const strictPolicy = makePolicy({ requireExplicitApproval: true });
    const gate = new ApprovalGate(wc as never, strictPolicy);

    // 첫 번째 request — strict
    const req1 = makeRequest({ id: "req-before" });
    gate.requestAndWait(req1);
    const [, payload1] = wc.send.mock.calls[0] as [string, ApprovalRequest];
    expect(payload1.requireExplicit).toBe(true);
    gate.resolve(req1.id, { requestId: req1.id, choice: "deny-once" });

    // policy 교체
    gate.setPolicy(makePolicy({ requireExplicitApproval: false }));
    expect(gate.policy.requireExplicitApproval).toBe(false);

    // 두 번째 request — lenient
    const req2 = makeRequest({ id: "req-after" });
    gate.requestAndWait(req2);
    const [, payload2] = wc.send.mock.calls[1] as [string, ApprovalRequest];
    expect(payload2.requireExplicit).toBe(false);
    gate.resolve(req2.id, { requestId: req2.id, choice: "allow-once" });
  });

  it("resolve with unknown requestId is a no-op", () => {
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    // 등록되지 않은 ID에 resolve — throw 없이 무시
    expect(() => gate.resolve("unknown-id", { requestId: "unknown-id", choice: "allow-once" })).not.toThrow();
  });

  it("pendingCount tracks pending requests correctly", async () => {
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);

    expect(gate.pendingCount).toBe(0);

    const req1 = makeRequest({ id: "cnt-1" });
    const req2 = makeRequest({ id: "cnt-2" });
    const p1 = gate.requestAndWait(req1);
    const p2 = gate.requestAndWait(req2);

    expect(gate.pendingCount).toBe(2);

    gate.resolve("cnt-1", { requestId: "cnt-1", choice: "allow-once" });
    await p1;
    expect(gate.pendingCount).toBe(1);

    gate.resolve("cnt-2", { requestId: "cnt-2", choice: "deny-once" });
    await p2;
    expect(gate.pendingCount).toBe(0);
  });

  // ── F2: webContents lifecycle guards ─────────────

  it("isDestroyed() true → deny-once immediately, no pending entry", async () => {
    const wc = makeMockWebContents({ isDestroyed: true });
    const gate = new ApprovalGate(wc as never);
    const req = makeRequest({ id: "req-destroyed" });

    const result = await gate.requestAndWait(req);

    expect(result.choice).toBe("deny-once");
    expect(result.requestId).toBe("req-destroyed");
    // send should never be called when already destroyed
    expect(wc.send).not.toHaveBeenCalled();
    expect(gate.pendingCount).toBe(0);
  });

  it("webContents.send throws → deny-once + pendingCount === 0", async () => {
    const wc = makeMockWebContents({ sendThrows: true });
    const gate = new ApprovalGate(wc as never);
    const req = makeRequest({ id: "req-send-throw" });

    const result = await gate.requestAndWait(req);

    expect(result.choice).toBe("deny-once");
    expect(result.requestId).toBe("req-send-throw");
    expect(gate.pendingCount).toBe(0);
  });

  // ── S1: Sensitive path hard-block ─────────────────

  it("sensitive path is hard-blocked even with mode=full_auto — dialog never shown", async () => {
    const wc = makeMockWebContents();
    // Even a permissive policy cannot unblock a sensitive path
    const permissive = makePolicy({ requireExplicitApproval: false });
    const gate = new ApprovalGate(wc as never, permissive);
    const req = makeRequest({
      id: "req-sensitive",
      toolName: "file_read",
      target: { filePath: "/Users/ken/.ssh/id_rsa" },
      mode: "full_auto",
      // Even if tool lies and claims read-only, sensitive block wins
      isReadOnly: true,
    });

    const result = await gate.requestAndWait(req);

    expect(result.choice).toBe("deny-once");
    expect(result.requestId).toBe("req-sensitive");
    // Dialog must NOT have been shown to the user
    expect(wc.send).not.toHaveBeenCalled();
    expect(gate.pendingCount).toBe(0);
    // The pattern that triggered the block is surfaced to the caller
    expect(result.rememberPattern).toContain("Sensitive credential path blocked");
    expect(result.rememberPattern).toContain("**/.ssh/*");
  });

  // ── S4: isReadOnly short-circuit ──────────────────

  it("isReadOnly=true + mode=default → auto-approve, dialog skipped", async () => {
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const req = makeRequest({
      id: "req-readonly",
      toolName: "knowledge_search",
      isReadOnly: true,
      mode: "default",
    });

    const result = await gate.requestAndWait(req);

    expect(result.choice).toBe("allow-once");
    expect(result.requestId).toBe("req-readonly");
    expect(result.rememberPattern).toBe("read-only auto-approve");
    // Dialog must NOT have been shown to the user
    expect(wc.send).not.toHaveBeenCalled();
    expect(gate.pendingCount).toBe(0);
  });

  it("isReadOnly=true + mode=plan → still blocked by plan mode (dialog shown)", async () => {
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const req = makeRequest({
      id: "req-readonly-plan",
      toolName: "knowledge_search",
      isReadOnly: true,
      mode: "plan",
    });

    const promise = gate.requestAndWait(req);

    // Plan mode must NOT short-circuit — dialog must be sent
    expect(wc.send).toHaveBeenCalledTimes(1);
    const [channel, payload] = wc.send.mock.calls[0] as [string, ApprovalRequest];
    expect(channel).toBe("lvis:approval:request");
    expect(payload.id).toBe("req-readonly-plan");
    expect(payload.mode).toBe("plan");
    expect(payload.isReadOnly).toBe(true);
    expect(gate.pendingCount).toBe(1);

    // Simulate user denying
    gate.resolve("req-readonly-plan", {
      requestId: "req-readonly-plan",
      choice: "deny-once",
    });
    const result = await promise;
    expect(result.choice).toBe("deny-once");
  });
});
