import { describe, expect, it, vi } from "vitest";
import type { ApprovalGate } from "../approval-gate.js";
import { buildSingleFlightAgentActionApprover } from "../agent-action-approver.js";

const REQUEST = {
  toolName: "a2a.send-message",
  args: { profile: "worker", secret: "must-not-enter-diagnostics" },
  reason: "Allow the external agent to start work?",
  trustOrigin: "local-api",
} as const;

function gate(requestAndWait: ReturnType<typeof vi.fn>): Pick<ApprovalGate, "requestAndWait"> {
  return { requestAndWait } as unknown as Pick<ApprovalGate, "requestAndWait">;
}

describe("single-flight agent-action approver", () => {
  it("returns undefined without an ApprovalGate", () => {
    expect(buildSingleFlightAgentActionApprover(undefined)).toBeUndefined();
  });

  it("builds the canonical agent-action request and treats allow-always as one-shot", async () => {
    const requestAndWait = vi.fn(async () => ({
      requestId: "approval-1",
      choice: "allow-always" as const,
      rememberPattern: "ignored",
    }));
    const approve = buildSingleFlightAgentActionApprover(gate(requestAndWait))!;

    await expect(approve(REQUEST)).resolves.toMatchObject({ decisionId: "approval-1", decidedAt: expect.any(String) });
    await expect(approve(REQUEST)).resolves.toMatchObject({ decisionId: "approval-1", decidedAt: expect.any(String) });

    expect(requestAndWait).toHaveBeenCalledTimes(2);
    expect(requestAndWait).toHaveBeenNthCalledWith(1, expect.objectContaining({
      category: "agent-action",
      kind: "agent-action",
      toolName: REQUEST.toolName,
      toolCategory: "meta",
      args: REQUEST.args,
      reason: REQUEST.reason,
      source: "builtin",
      trustOrigin: REQUEST.trustOrigin,
      id: expect.any(String),
      createdAt: expect.any(Number),
    }));
    expect(requestAndWait.mock.calls[0]![0]).not.toHaveProperty("requireExplicit");
  });

  it("denies a non-allow decision", async () => {
    const requestAndWait = vi.fn(async () => ({
      requestId: "approval-1",
      choice: "deny-once" as const,
    }));
    const approve = buildSingleFlightAgentActionApprover(gate(requestAndWait))!;

    await expect(approve(REQUEST)).resolves.toBeNull();
  });

  it("single-flights attention prompts and exposes only safe diagnostic identity", async () => {
    let release!: () => void;
    const decision = new Promise<{ requestId: string; choice: "allow-once" }>((resolve) => {
      release = () => resolve({ requestId: "approval-1", choice: "allow-once" });
    });
    const requestAndWait = vi.fn(async () => await decision);
    const onConcurrent = vi.fn(() => {
      throw new Error("diagnostic failed");
    });
    const approve = buildSingleFlightAgentActionApprover(
      gate(requestAndWait),
      { onConcurrent },
    )!;

    const first = approve(REQUEST);
    await Promise.resolve();
    await expect(approve({ ...REQUEST, args: { secret: "second-secret" } }))
      .resolves.toBeNull();

    expect(requestAndWait).toHaveBeenCalledOnce();
    expect(onConcurrent).toHaveBeenCalledWith({
      toolName: REQUEST.toolName,
      trustOrigin: REQUEST.trustOrigin,
    });
    expect(JSON.stringify(onConcurrent.mock.calls)).not.toContain("secret");

    release();
    await expect(first).resolves.toMatchObject({ decisionId: "approval-1", decidedAt: expect.any(String) });
  });

  it("fails closed on a gate error and releases the single-flight guard", async () => {
    const requestAndWait = vi.fn()
      .mockRejectedValueOnce(new Error("must-not-enter-diagnostics"))
      .mockResolvedValueOnce({ requestId: "approval-2", choice: "allow-once" as const });
    const onError = vi.fn(() => {
      throw new Error("diagnostic failed");
    });
    const approve = buildSingleFlightAgentActionApprover(
      gate(requestAndWait),
      { onError },
    )!;

    await expect(approve(REQUEST)).resolves.toBeNull();
    await expect(approve(REQUEST)).resolves.toMatchObject({ decisionId: "approval-2", decidedAt: expect.any(String) });

    expect(requestAndWait).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledWith({
      toolName: REQUEST.toolName,
      trustOrigin: REQUEST.trustOrigin,
    });
  });
});
