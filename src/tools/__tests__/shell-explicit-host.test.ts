import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalGate, IPC_APPROVAL_REQUEST, isHostApprovalRejectedDecision, type ApprovalRequest, type ApprovalRequestInput } from "../../permissions/approval-gate.js";
import { buildHostShellExecutionPermitBinding, mintHostShellExecutionPermit } from "../../permissions/host-shell-execution-permit.js";
import { buildHostShellExecutionPlan, getHostShellExecutionPlanAuditProjection, getHostShellExecutionPlanCacheIdentity, parseHostShellExecutionInput } from "../../permissions/host-shell-execution-plan.js";
import { __resetActiveSandboxCapabilityForTest, __resetSandboxRequestedAtBootForTest, getHostShellExecutionPlan, setActiveSandboxCapability, setSandboxRequestedAtBoot } from "../../permissions/sandbox-capability.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { BashTool, BashToolInputSchema, PowerShellTool, PowerShellToolInputSchema } from "../shell-tools.js";
import { approvalFailureOutcome } from "../pipeline/approval-outcome.js";

const HOST_INPUT = { command: "printf approved > host-marker.txt", executionMode: "host" as const, justification: "Verify the explicitly requested host route", timeoutSeconds: 5 };
const temporaryDirectories: string[] = [];
function prepare() {
  const cwd = mkdtempSync(join(tmpdir(), "host-shell-approval-"));
  temporaryDirectories.push(cwd);
  setSandboxRequestedAtBoot(true);
  setActiveSandboxCapability({ kind: "asrt", confidence: "verified", platform: process.platform, reason: "fixture capability", confines: { filesystem: true, process: true, network: true } });
  const plan = getHostShellExecutionPlan("host");
  const binding = buildHostShellExecutionPermitBinding({ plan, toolName: "bash", toolUseId: "host-once", rawInput: HOST_INPUT, executionCwd: cwd, extraAllowedDirectories: [] })!;
  const webContents = { send: vi.fn(), isDestroyed: () => false };
  const gate = new ApprovalGate(webContents as never);
  const request: ApprovalRequestInput = { id: "host-once", category: "tool", toolCategory: "shell", toolName: "bash", args: HOST_INPUT, source: "builtin", createdAt: Date.now(), reason: "Explicit host execution", allowedChoices: ["allow-once", "deny-once"], forceExplicit: true, hostShellExecutionPermitBinding: binding };
  return { cwd, plan, binding, webContents, gate, request };
}
afterEach(() => {
  __resetActiveSandboxCapabilityForTest();
  __resetSandboxRequestedAtBootForTest();
  for (const dir of temporaryDirectories.splice(0)) cleanupTmpDir(dir);
});

describe("explicit host shell authorization", () => {
  it.each(["host", "default"] as const)("does not ask for %s host consent when the exact action would be masked", async (executionMode) => {
    for (const field of ["command", "justification", "cwd"] as const) {
      const { cwd, gate, request, webContents } = prepare();
      const plan = buildHostShellExecutionPlan({ platform: process.platform, executionMode, requestedSandbox: true,
        activeCapability: { kind: "none", confidence: "verified", platform: process.platform } });
      const input = { ...HOST_INPUT, executionMode,
        [field]: field === "command" ? "printf unchanged > live-abcdefgh" : field === "cwd" ? join(cwd, "live-abcdefgh") : "Use live-abcdefgh" };
      const binding = buildHostShellExecutionPermitBinding({ plan, toolName: "bash", toolUseId: request.id, rawInput: input, executionCwd: cwd, extraAllowedDirectories: [] })!;
      const decision = await gate.requestAndWait({ ...request, args: input, hostShellExecutionPermitBinding: binding });
      expect(decision.choice).toBe("deny-once");
      expect(isHostApprovalRejectedDecision(decision)).toBe(true);
      expect(webContents.send.mock.calls.some(([channel]) => channel === IPC_APPROVAL_REQUEST)).toBe(false);
      expect(gate.pendingCount).toBe(0);
      expect(mintHostShellExecutionPermit({ plan, binding, decision })).toBeUndefined();
      const outcome = approvalFailureOutcome(decision, "bash", { decision: "ask", layer: 2, reason: "host consent" });
      expect(outcome?.content).toContain("sensitive-data masking");
      expect(outcome?.content).not.toContain("live-abcdefgh");
      expect(outcome?.permission.reason).toBe("approval rejected by host");
      expect(existsSync(join(cwd, "live-abcdefgh"))).toBe(false);
    }
  });

  it.each([true, false])("requires fresh host approval when sandbox requested is %s", (requestedSandbox) => {
    const common = { platform: process.platform, requestedSandbox, activeCapability: { kind: "none" as const, confidence: "verified" as const, platform: process.platform, reason: "fixture" } };
    const explicit = buildHostShellExecutionPlan({ ...common, executionMode: "host" });
    const ordinary = buildHostShellExecutionPlan(common);
    expect(explicit).toMatchObject({ executionRequest: "host", mode: "plain", requestedSandbox, fallbackReason: "none", requiresExplicitUserApproval: true, capability: { kind: "none", confines: { filesystem: false, process: false, network: false } } });
    expect(getHostShellExecutionPlanCacheIdentity(getHostShellExecutionPlanAuditProjection(explicit))).not.toBe(getHostShellExecutionPlanCacheIdentity(getHostShellExecutionPlanAuditProjection(ordinary)));
  });

  it.each([BashToolInputSchema, PowerShellToolInputSchema])("rejects malformed host input consistently in schema and permit parsing", (schema) => {
    for (const input of [ { ...HOST_INPUT, justification: undefined }, { ...HOST_INPUT, justification: "  " }, { ...HOST_INPUT, executionMode: "unconfined" }, { ...HOST_INPUT, run_in_background: true } ]) {
      expect(schema.safeParse(input).success).toBe(false);
      expect(parseHostShellExecutionInput(input)).toBeUndefined();
    }
    expect(schema.safeParse(HOST_INPUT).success).toBe(true);
    expect(parseHostShellExecutionInput({ command: "echo default" })?.executionMode).toBe("default");
  });

  it("accepts a desktop response once and performs a native host spawn", async () => {
    const { cwd, plan, binding, gate, request, webContents } = prepare();
    const onPending = vi.fn();
    gate.observePendingApprovals({ onPending, onSettled: vi.fn() });
    const pending = gate.requestAndWait({ ...request, isReadOnly: true, executionCwd: "untrusted-display-path" });
    const displayed = webContents.send.mock.calls[0][1] as ApprovalRequest;
    expect(onPending).not.toHaveBeenCalled();
    expect(displayed.args).toEqual(HOST_INPUT);
    expect(displayed.executionCwd).toBe(cwd);
    const decision = { requestId: request.id, choice: "allow-once" as const, nonce: displayed.nonce, hmac: displayed.hmac };
    expect(gate.resolve(request.id, decision)).toBeNull();
    expect(gate.resolve(request.id, decision, "platform-bridge")).toBeNull();
    expect(gate.pendingCount).toBe(1);
    expect(gate.resolveFromDesktopRenderer(request.id, decision)?.choice).toBe("allow-once");
    const permit = mintHostShellExecutionPermit({ plan, binding, approvalDecision: await pending });
    expect(permit).toBeDefined();
    const ctx = { cwd, extraAllowedDirectories: [], metadata: { toolUseId: "host-once" }, hostShellExecutionPlan: plan, hostShellExecutionPermit: permit };
    const result = await new BashTool().execute(HOST_INPUT, ctx);
    expect(result.isError).toBe(false);
    expect(readFileSync(join(cwd, "host-marker.txt"), "utf8")).toBe("approved");
    expect(result.metadata).toMatchObject({ sandboxed: false, isolation: "none", sandboxExecutionPlan: { executionRequest: "host" } });
    expect((await new BashTool().execute(HOST_INPUT, ctx)).isError).toBe(true);
  });

  it.each(["command", "justification", "executionMode", "cwd"] as const)("rejects a changed %s after approval", async (field) => {
    const { cwd, plan, binding, gate, request, webContents } = prepare();
    const pending = gate.requestAndWait(request);
    const displayed = webContents.send.mock.calls[0][1] as ApprovalRequest;
    gate.resolveFromDesktopRenderer(request.id, { requestId: request.id, choice: "allow-once", nonce: displayed.nonce, hmac: displayed.hmac });
    const permit = mintHostShellExecutionPermit({ plan, binding, approvalDecision: await pending });
    const changed = { ...HOST_INPUT, [field]: field === "executionMode" ? "default" : field === "command" ? "printf changed" : field === "cwd" ? "." : "Changed justification" };
    const result = await new BashTool().execute(changed, { cwd, extraAllowedDirectories: [], metadata: { toolUseId: "host-once" }, hostShellExecutionPlan: plan, hostShellExecutionPermit: permit });
    expect(result.isError).toBe(true);
  });

  it("rejects headless and remote-origin requests before showing approval", async () => {
    const { request, webContents } = prepare();
    const headless = new ApprovalGate(null);
    expect((await headless.requestAndWait(request)).choice).toBe("deny-once");
    const gate = new ApprovalGate(webContents as never);
    expect((await gate.requestAndWait({ ...request, remoteControllerOrigin: "tailnet-controller" })).choice).toBe("deny-once");
    expect(webContents.send).not.toHaveBeenCalled();
  });

  it.each([BashTool, PowerShellTool])("refuses direct host execution without a permit", async (ShellTool) => {
    const { cwd, plan } = prepare();
    const result = await new ShellTool().execute({ ...HOST_INPUT, command: "echo denied" }, { cwd, extraAllowedDirectories: [], metadata: {}, hostShellExecutionPlan: plan });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("one-shot host approval permit");
  });
});
