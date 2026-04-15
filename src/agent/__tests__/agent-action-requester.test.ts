/**
 * Tests — DefaultAgentActionRequester (§8 Agent Hub approval caller)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  DefaultAgentActionRequester,
  isAllowed,
  type AgentFileShareAction,
  type AgentTaskDelegateAction,
  type AgentExternalApiCallAction,
} from "../agent-action-requester.js";
import type { ApprovalGate, ApprovalDecision } from "../../core/approval-gate.js";

// ─── Mock ApprovalGate ───────────────────────────────

function makeMockGate(choice: ApprovalDecision["choice"] = "allow-once"): ApprovalGate {
  return {
    requestAndWait: vi.fn().mockResolvedValue({
      requestId: "mock-id",
      choice,
    }),
    resolve: vi.fn(),
    setPolicy: vi.fn(),
    disposeAll: vi.fn(),
    get pendingCount() { return 0; },
    get policy() { return { version: 1, requireExplicitApproval: true, managed: false, updatedAt: "" }; },
  } as unknown as ApprovalGate;
}

// ─── isAllowed helper ────────────────────────────────

describe("isAllowed()", () => {
  it("returns true for allow-once", () => {
    expect(isAllowed("allow-once")).toBe(true);
  });

  it("returns true for allow-always", () => {
    expect(isAllowed("allow-always")).toBe(true);
  });

  it("returns false for deny-once", () => {
    expect(isAllowed("deny-once")).toBe(false);
  });

  it("returns false for deny-always", () => {
    expect(isAllowed("deny-always")).toBe(false);
  });
});

// ─── DefaultAgentActionRequester ─────────────────────

describe("DefaultAgentActionRequester", () => {
  let gate: ApprovalGate;
  let requester: DefaultAgentActionRequester;

  beforeEach(() => {
    gate = makeMockGate("allow-once");
    requester = new DefaultAgentActionRequester(gate);
  });

  it("passes category 'agent-action' to gate for file-share", async () => {
    const action: AgentFileShareAction = {
      type: "file-share",
      filePath: "/tmp/report.pdf",
      recipient: "user@example.com",
      reason: "월간 보고서 공유",
    };

    await requester.request(action);

    expect(gate.requestAndWait).toHaveBeenCalledOnce();
    const callArg = vi.mocked(gate.requestAndWait).mock.calls[0][0];
    expect(callArg.category).toBe("agent-action");
    expect(callArg.toolName).toBe("file_share");
    expect(callArg.args).toEqual(action);
    expect(callArg.reason).toBe("월간 보고서 공유");
    expect(callArg.source).toBe("builtin");
    expect(typeof callArg.id).toBe("string");
    expect(typeof callArg.createdAt).toBe("number");
  });

  it("passes category 'agent-action' to gate for task-delegate", async () => {
    const action: AgentTaskDelegateAction = {
      type: "task-delegate",
      targetAgentId: "email-plugin",
      taskDescription: "이메일 초안 작성",
      reason: "이메일 작성 자동화",
    };

    await requester.request(action);

    const callArg = vi.mocked(gate.requestAndWait).mock.calls[0][0];
    expect(callArg.category).toBe("agent-action");
    expect(callArg.toolName).toBe("task_delegate");
  });

  it("passes category 'agent-action' to gate for external-api-call", async () => {
    const action: AgentExternalApiCallAction = {
      type: "external-api-call",
      endpoint: "https://api.example.com/v1/data",
      method: "POST",
      reason: "외부 데이터 전송",
    };

    await requester.request(action);

    const callArg = vi.mocked(gate.requestAndWait).mock.calls[0][0];
    expect(callArg.category).toBe("agent-action");
    expect(callArg.toolName).toBe("external_api_call");
  });

  it("returns deny decision when gate responds deny-once", async () => {
    gate = makeMockGate("deny-once");
    requester = new DefaultAgentActionRequester(gate);

    const action: AgentFileShareAction = {
      type: "file-share",
      filePath: "/tmp/secret.pdf",
      recipient: "unknown@example.com",
      reason: "테스트 거부",
    };

    const decision = await requester.request(action);

    expect(decision.choice).toBe("deny-once");
    expect(isAllowed(decision.choice)).toBe(false);
  });

  it("generates a unique id per request", async () => {
    const action: AgentFileShareAction = {
      type: "file-share",
      filePath: "/tmp/a.pdf",
      recipient: "a@example.com",
      reason: "첫 번째 요청",
    };

    await requester.request(action);
    await requester.request({ ...action, reason: "두 번째 요청" });

    const calls = vi.mocked(gate.requestAndWait).mock.calls;
    expect(calls[0][0].id).not.toBe(calls[1][0].id);
  });
});
