import { describe, expect, it, vi } from "vitest";
import {
  ApprovalGate,
  type ApprovalDecision,
  type ApprovalRequest,
} from "../approval-gate.js";
import { buildHostShellExecutionPlan } from "../host-shell-execution-plan.js";
import {
  consumeHostShellExecutionPermit,
  mintHostShellExecutionPermit,
  type HostShellExecutionPermitBinding,
} from "../host-shell-execution-permit.js";

function windowsPlan() {
  return buildHostShellExecutionPlan({
    platform: "win32",
    requestedSandbox: true,
    activeCapability: {
      kind: "asrt",
      confidence: "verified",
      platform: "win32",
      reason: "srt-win partial",
      confines: { filesystem: true, process: false, network: true },
    },
  });
}

function makeBinding(
  plan = windowsPlan(),
  overrides: Partial<HostShellExecutionPermitBinding> = {},
): HostShellExecutionPermitBinding {
  const binding: HostShellExecutionPermitBinding = {
    plan,
    planIdentity: plan.identity,
    toolName: "bash",
    toolUseId: "tool-1",
    command: "echo one-shot",
    requestedCwd: "subdir",
    executionCwd: "C:/repo",
    resolvedCwd: "C:/repo/subdir",
    timeoutSeconds: 30,
    allowedDirectories: Object.freeze(["c:/repo/extra"]),
    ...overrides,
  };
  return Object.freeze(binding);
}

let approvalSequence = 0;

async function issueHostApprovedDecision(
  binding: HostShellExecutionPermitBinding,
): Promise<ApprovalDecision> {
  const wc = { isDestroyed: vi.fn(() => false), send: vi.fn() };
  const gate = new ApprovalGate(wc as never);
  const id = `partial-shell-permit-${++approvalSequence}`;
  const pending = gate.requestAndWait({
    id,
    category: "tool",
    toolName: binding.toolName,
    toolCategory: "shell",
    args: {
      command: binding.command,
      cwd: binding.requestedCwd,
      timeoutSeconds: binding.timeoutSeconds,
    },
    reason: "Windows partial shell needs an explicit one-shot approval",
    source: "builtin",
    createdAt: Date.now(),
    allowedChoices: ["allow-once", "deny-once"],
    forceExplicit: true,
    hostShellExecutionPermitBinding: binding,
  });
  const request = wc.send.mock.calls[0]?.[1] as ApprovalRequest | undefined;
  if (!request?.nonce || !request.hmac) {
    throw new Error("ApprovalGate did not publish an HMAC-sealed request");
  }
  gate.resolve(id, {
    requestId: id,
    choice: "allow-once",
    nonce: request.nonce,
    hmac: request.hmac,
  });
  return pending;
}

function permitInput(
  binding: HostShellExecutionPermitBinding,
  permit: ReturnType<typeof mintHostShellExecutionPermit>,
) {
  return {
    permit,
    plan: binding.plan,
    toolName: binding.toolName,
    toolUseId: binding.toolUseId,
    command: binding.command,
    requestedCwd: binding.requestedCwd,
    executionCwd: binding.executionCwd,
    resolvedCwd: binding.resolvedCwd,
    timeoutSeconds: binding.timeoutSeconds,
    allowedDirectories: binding.allowedDirectories,
  };
}

describe("Windows partial-shell execution permit", () => {
  it("accepts exactly its Gate-approved bound action once", async () => {
    const binding = makeBinding();
    const decision = await issueHostApprovedDecision(binding);
    const permit = mintHostShellExecutionPermit({
      plan: binding.plan,
      approvalDecision: decision,
      binding,
    });

    expect(permit).toBeDefined();
    expect(consumeHostShellExecutionPermit(permitInput(binding, permit))).toBe(true);
    expect(consumeHostShellExecutionPermit(permitInput(binding, permit))).toBe(false);
  });

  it("fails closed and burns a permit when timeout or action changes", async () => {
    const binding = makeBinding();
    const decision = await issueHostApprovedDecision(binding);
    const permit = mintHostShellExecutionPermit({
      plan: binding.plan,
      approvalDecision: decision,
      binding,
    });

    expect(
      consumeHostShellExecutionPermit({
        ...permitInput(binding, permit),
        timeoutSeconds: binding.timeoutSeconds + 1,
      }),
    ).toBe(false);
    expect(consumeHostShellExecutionPermit(permitInput(binding, permit))).toBe(false);
  });

  it("rejects structural decisions and burns receipt mismatches/replays", async () => {
    const binding = makeBinding();
    const forged = { requestId: "forged", choice: "allow-once" } as ApprovalDecision;
    expect(
      mintHostShellExecutionPermit({
        plan: binding.plan,
        approvalDecision: forged,
        binding,
      }),
    ).toBeUndefined();

    const commandDecision = await issueHostApprovedDecision(binding);
    const substitutedCommand = Object.freeze({ ...binding, command: "echo substituted" });
    expect(
      mintHostShellExecutionPermit({
        plan: binding.plan,
        approvalDecision: commandDecision,
        binding: substitutedCommand,
      }),
    ).toBeUndefined();
    expect(
      mintHostShellExecutionPermit({
        plan: binding.plan,
        approvalDecision: commandDecision,
        binding,
      }),
    ).toBeUndefined();

    const planDecision = await issueHostApprovedDecision(binding);
    expect(
      mintHostShellExecutionPermit({
        plan: windowsPlan(),
        approvalDecision: planDecision,
        binding,
      }),
    ).toBeUndefined();
    expect(
      mintHostShellExecutionPermit({
        plan: binding.plan,
        approvalDecision: planDecision,
        binding,
      }),
    ).toBeUndefined();
  });
});
