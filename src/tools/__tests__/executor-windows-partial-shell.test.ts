import { afterEach, describe, expect, it, vi } from "vitest";
import { createDynamicTool, type Tool } from "../base.js";
import { BashTool } from "../bash.js";
import { ToolExecutor, type ToolCallMeta, type ToolPermissionContext } from "../executor.js";
import { ToolRegistry } from "../registry.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import {
  ApprovalGate,
  type ApprovalRequest,
} from "../../permissions/approval-gate.js";
import {
  canonicalizeHostShellAllowedDirectories,
  consumeHostShellExecutionPermit,
  resolveHostShellWorkingDirectory,
} from "../../permissions/host-shell-execution-permit.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import {
  __resetActiveSandboxCapabilityForTest,
  __resetSandboxRequestedAtBootForTest,
  setActiveSandboxCapability,
  setSandboxRequestedAtBoot,
} from "../../permissions/sandbox-capability.js";
import { setProcessPlatform } from "../../testing/process-platform.js";
import {
  partialWindowsAsrt,
  requestedSandboxUnavailable,
} from "../../testing/host-shell-sandbox-fixtures.js";
import type { AuditEntry, AuditLogger } from "../../audit/audit-logger.js";
import type { PermissionAuditEntryInput } from "../../audit/audit-schema.js";
import { getHostShellExecutionPlanAuditProjection } from "../../permissions/host-shell-execution-plan.js";

const ORIGINAL_PLATFORM = process.platform;

function permissionContext(overrides: Partial<ToolPermissionContext> = {}): ToolPermissionContext {
  return { trustOrigin: "user-keyboard", ...overrides };
}

function shellProbe(execute: (ctx: import("../types.js").ToolExecutionContext) => void): Tool {
  const tool = new BashTool();
  vi.spyOn(tool, "execute").mockImplementation(async (_input, ctx) => {
    execute(ctx);
    return { output: "executed", isError: false };
  });
  return tool;
}

function dynamicShellProbe(execute: (ctx: import("../types.js").ToolExecutionContext) => void): Tool {
  return createDynamicTool({
    name: "bash",
    description: "test-only shell probe",
    source: "builtin",
    category: "shell",
    jsonSchema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
    execute: async (_input, ctx) => {
      execute(ctx);
      return { output: "executed", isError: false };
    },
  });
}

function fullDarwinAsrt(): void {
  setProcessPlatform("darwin");
  setSandboxRequestedAtBoot(true);
  setActiveSandboxCapability({
    kind: "asrt",
    confidence: "verified",
    platform: "darwin",
    reason: "full ASRT",
    confines: { filesystem: true, process: true, network: true },
  });
}
function explicitlySandboxOff(platform: "darwin" | "linux" | "win32"): void {
  setProcessPlatform(platform);
  __resetActiveSandboxCapabilityForTest();
  setSandboxRequestedAtBoot(false);
}
function pmReturning(result: ReturnType<PermissionManager["checkDetailed"]>): PermissionManager {
  const pm = new PermissionManager("/tmp/nonexistent-windows-partial-shell.json");
  pm.checkDetailed = () => result;
  return pm;
}

function gateResolving(
  choice: "allow-once" | "deny-once",
  auditLogger?: AuditLogger,
) {
  let gate: ApprovalGate;
  const send = vi.fn((_channel: string, request: ApprovalRequest) => {
    gate.resolve(request.id, {
      requestId: request.id,
      choice,
      nonce: request.nonce,
      hmac: request.hmac,
    });
  });
  gate = new ApprovalGate(
    { isDestroyed: vi.fn(() => false), send } as never,
    undefined,
    undefined,
    auditLogger,
  );
  return { gate, send };
}

function recordingAuditLogger(): {
  auditLogger: AuditLogger;
  telemetryEntries: AuditEntry[];
  permissionEntries: PermissionAuditEntryInput[];
} {
  const telemetryEntries: AuditEntry[] = [];
  const permissionEntries: PermissionAuditEntryInput[] = [];
  const auditLogger = {
    log: vi.fn((entry: AuditEntry) => telemetryEntries.push(entry)),
    logShadow: vi.fn(),
    isPermissionAuditChainReady: vi.fn(() => true),
    assertPermissionAuditWritable: vi.fn(),
    appendPermissionAuditEntry: vi.fn(async (entry: PermissionAuditEntryInput) => {
      permissionEntries.push(entry);
      return { ...entry, prevHash: "test-chain" };
    }),
    isShadowChannelWritable: vi.fn(() => true),
    getPermissionShadowLogFile: vi.fn(() => "test-shadow.jsonl"),
  } as unknown as AuditLogger;
  return { auditLogger, telemetryEntries, permissionEntries };
}

describe("ToolExecutor — Windows partial shell Plan B", () => {
  afterEach(() => {
    __resetActiveSandboxCapabilityForTest();
    __resetSandboxRequestedAtBootForTest();
    setProcessPlatform(ORIGINAL_PLATFORM);
  });

  it("threads one sealed full-ASRT plan through the interactive reviewer and cache key", async () => {
    fullDarwinAsrt();
    let executedPlan: import("../../permissions/host-shell-execution-plan.js").HostShellExecutionPlan | undefined;
    let reviewerInput: import("../../permissions/permission-manager.js").ReviewerDispatchInput | undefined;
    const registry = new ToolRegistry();
    registry.register(shellProbe((ctx) => { executedPlan = ctx.hostShellExecutionPlan; }));

    const pm = pmReturning({
      decision: "ask",
      reason: "interactive reviewer required",
      layer: 6,
      reviewer: { route: "foreground-auto" },
    });
    pm.setReviewer({ classifier: {} as never, cache: {} as never, deferredQueue: {} as never });
    pm.dispatchReviewer = vi.fn(async (_toolName, input) => {
      reviewerInput = input;
      return {
        verdict: { level: "low" as const, reason: "full ASRT reviewed" },
        cacheReason: "miss-not-found" as const,
        outcome: "fresh" as const,
      };
    }) as never;

    const result = await new ToolExecutor(registry, undefined, pm).executeAll(
      [{ id: "full-asrt-review", name: "bash", input: { command: "echo reviewed" } }],
      { sessionId: "full-asrt", permissionContext: permissionContext() },
    );

    expect(pm.dispatchReviewer).toHaveBeenCalledTimes(1);
    expect(result[0]?.is_error).toBeUndefined();
    expect(executedPlan).toMatchObject({
      platform: "darwin",
      requestedSandbox: true,
      mode: "asrt",
      fallbackReason: "none",
      capability: { kind: "asrt", confines: { filesystem: true, process: true, network: true } },
    });
    expect(reviewerInput?.hostShellExecutionPlan).toBe(executedPlan);
    expect(reviewerInput?.approvalCacheKey).toContain(
      "host-shell-execution-plan-cache/v2:",
    );
  });
  it("bypasses foreground reviewer and durable memory with a one-shot explicit modal", async () => {
    partialWindowsAsrt();
    const execute = vi.fn();
    const registry = new ToolRegistry();
    registry.register(shellProbe(execute));

    const pm = pmReturning({
      decision: "ask",
      reason: "reviewer would normally handle this",
      layer: 6,
      reviewer: { route: "foreground-auto" },
    });
    const classify = vi.fn(() => ({ level: "high" as const, reason: "must not run" }));
    pm.setReviewer({
      classifier: { classify },
      cache: {} as never,
      deferredQueue: {} as never,
    });
    const requestAndWait = vi.fn(async (request: { id: string }) => ({
      requestId: request.id,
      choice: "deny-once" as const,
    }));
    const executor = new ToolExecutor(
      registry,
      undefined,
      pm,
      undefined,
      { requestAndWait } as never,
    );

    const result = await executor.executeAll(
      [{ id: "partial-shell-deny", name: "bash", input: { command: "echo no-run" } }],
      { sessionId: "partial-shell", permissionContext: permissionContext() },
    );

    expect(classify).not.toHaveBeenCalled();
    expect(requestAndWait).toHaveBeenCalledTimes(1);
    const request = requestAndWait.mock.calls[0]?.[0] as {
      allowedChoices?: string[];
      forceExplicit?: boolean;
      sandboxCapability?: { kind: string; confines?: Record<string, boolean> };
      executionPlan?: {
        mode: string;
        fallbackReason: string;
        requiresExplicitUserApproval: boolean;
        capability: { kind: string; confines?: Record<string, boolean> };
      };
    };
    expect(request.allowedChoices).toEqual(["allow-once", "deny-once"]);
    expect(request.forceExplicit).toBe(true);
    expect(request.sandboxCapability).toBeUndefined();
    expect(request.executionPlan).toMatchObject({
      mode: "plain",
      fallbackReason: "windows-partial-shell-acl-unsafe",
      requiresExplicitUserApproval: true,
      capability: {
        kind: "none",
        confines: { filesystem: false, process: false, network: false },
      },
    });
    expect(JSON.stringify(request.executionPlan)).not.toContain("echo no-run");
    expect(JSON.stringify(request.executionPlan)).not.toContain(
      "Windows ASRT partial shell confinement is unavailable",
    );
    expect(execute).not.toHaveBeenCalled();
    expect(result[0]?.is_error).toBe(true);
  });

  it("passes the same sealed none-plan to an allow-once shell invocation", async () => {
    partialWindowsAsrt();
    const audit = recordingAuditLogger();
    let observedPlan: import("../../permissions/host-shell-execution-plan.js").HostShellExecutionPlan | undefined;
    let observedPermit: unknown;
    let permitConsumed = false;
    const registry = new ToolRegistry();
    registry.register(shellProbe((ctx) => {
      observedPlan = ctx.hostShellExecutionPlan;
      observedPermit = ctx.hostShellExecutionPermit;
      if (observedPlan === undefined) return;
      permitConsumed = consumeHostShellExecutionPermit({
        permit: ctx.hostShellExecutionPermit,
        plan: observedPlan,
        toolName: "bash",
        toolUseId:
          typeof ctx.metadata.toolUseId === "string"
            ? ctx.metadata.toolUseId
            : undefined,
        command: "echo one-shot",
        requestedCwd: undefined,
        executionCwd: ctx.cwd,
        resolvedCwd: resolveHostShellWorkingDirectory(ctx.cwd, undefined),
        timeoutSeconds: TOOL_TIMEOUT_POLICY.shellDefaultMs / 1000,
        allowedDirectories: canonicalizeHostShellAllowedDirectories(
          ctx.extraAllowedDirectories,
        ),
      });
    }));

    const { gate, send } = gateResolving("allow-once", audit.auditLogger);
    const executor = new ToolExecutor(
      registry,
      undefined,
      pmReturning({ decision: "allow", reason: "allow mode", layer: 6 }),
      undefined,
      gate,
      undefined,
      audit.auditLogger,
    );

    const endMetas: ToolCallMeta[] = [];
    const result = await executor.executeAll(
      [{ id: "partial-shell-allow", name: "bash", input: { command: "echo one-shot" } }],
      {
        sessionId: "partial-shell",
        permissionContext: permissionContext(),
        callbacks: {
          onToolEnd: (_name, _content, _isError, meta) => endMetas.push(meta),
        },
      },
    );
    expect(permitConsumed).toBe(true);

    expect(send).toHaveBeenCalledTimes(1);
    const rendererApproval = send.mock.calls[0]?.[1] as ApprovalRequest;
    // Canonical host shells expose only the sealed, allowlist projection. The
    // raw capability carries a free-form host reason and must never cross IPC.
    expect(rendererApproval.sandboxCapability).toBeUndefined();
    expect(rendererApproval.executionPlan).toMatchObject({
      mode: "plain",
      fallbackReason: "windows-partial-shell-acl-unsafe",
      requiresExplicitUserApproval: true,
      capability: {
        kind: "none",
        confines: { filesystem: false, process: false, network: false },
      },
    });
    expect(JSON.stringify(rendererApproval.executionPlan)).not.toContain("echo one-shot");
    expect(JSON.stringify(rendererApproval.executionPlan)).not.toContain(
      "Windows ASRT partial shell confinement is unavailable",
    );
    expect(observedPermit).toBeDefined();
    expect(observedPlan).toMatchObject({
      mode: "plain",
      fallbackReason: "windows-partial-shell-acl-unsafe",
      requiresExplicitUserApproval: true,
      capability: {
        kind: "none",
        confines: { filesystem: false, process: false, network: false },
      },
    });
    expect(result[0]?.is_error).toBeUndefined();

    expect(observedPlan).toBeDefined();
    const auditPlan = getHostShellExecutionPlanAuditProjection(observedPlan!);
    expect(result[0]?.executionPlan).toBe(auditPlan);
    expect(endMetas).toHaveLength(1);
    expect(endMetas[0]?.executionPlan).toBe(auditPlan);
    const resultPlanJson = JSON.stringify(result[0]?.executionPlan);
    expect(resultPlanJson).not.toContain("echo one-shot");
    expect(resultPlanJson).not.toContain("Windows ASRT partial shell confinement is unavailable");
    expect(resultPlanJson).not.toContain("hostShellExecutionPermit");
    const ask = audit.permissionEntries.find((entry) => entry.decision === "ask");
    const terminal = audit.permissionEntries.find((entry) => entry.decision === "allow");
    const telemetry = audit.telemetryEntries.find(
      (entry) => entry.type === "tool_call" && entry.toolCalls?.[0]?.name === "bash",
    )?.toolCalls?.[0];
    for (const surface of [ask, terminal, telemetry]) {
      expect(surface).toBeDefined();
      expect(surface?.toolUseId).toBe("partial-shell-allow");
      expect(surface?.executionPlan).toBe(auditPlan);
    }
    const approvalAuditText = audit.telemetryEntries
      .filter((entry) => entry.type === "approval")
      .map((entry) => entry.input ?? entry.output ?? "")
      .join("\n");
    expect(approvalAuditText).toContain(`executionPlan.identity=${auditPlan.identity}`);
    expect(approvalAuditText).not.toContain("echo one-shot");
    expect(approvalAuditText).not.toContain("requestedCwd");
    expect(JSON.stringify(auditPlan)).not.toContain("reason");
  });


  it("preserves the Plan-B projection across ask, deny terminal audit, and telemetry", async () => {
    partialWindowsAsrt();
    const executed = vi.fn();
    const registry = new ToolRegistry();
    registry.register(shellProbe(executed));
    const audit = recordingAuditLogger();
    const { gate } = gateResolving("deny-once", audit.auditLogger);

    const executor = new ToolExecutor(
      registry,
      undefined,
      pmReturning({ decision: "allow", reason: "allow mode", layer: 6 }),
      undefined,
      gate,
      undefined,
      audit.auditLogger,
    );

    const endMetas: ToolCallMeta[] = [];
    const result = await executor.executeAll(
      [{ id: "partial-shell-audit-deny", name: "bash", input: { command: "echo denied" } }],
      {
        sessionId: "partial-shell",
        permissionContext: permissionContext(),
        callbacks: {
          onToolEnd: (_name, _content, _isError, meta) => endMetas.push(meta),
        },
      },
    );

    expect(executed).not.toHaveBeenCalled();
    expect(result[0]?.is_error).toBe(true);
    const ask = audit.permissionEntries.find((entry) => entry.decision === "ask");
    const terminal = audit.permissionEntries.find((entry) => entry.decision === "deny");
    const telemetry = audit.telemetryEntries.find(
      (entry) => entry.type === "tool_call" && entry.toolCalls?.[0]?.name === "bash",
    )?.toolCalls?.[0];
    expect(ask?.executionPlan).toBeDefined();
    const expectedPlan = ask!.executionPlan;
    expect(result[0]?.executionPlan).toBe(expectedPlan);
    expect(endMetas).toHaveLength(1);
    expect(endMetas[0]?.executionPlan).toBe(expectedPlan);
    const deniedResultPlanJson = JSON.stringify(result[0]?.executionPlan);
    expect(deniedResultPlanJson).not.toContain("echo denied");
    expect(deniedResultPlanJson).not.toContain("Windows ASRT partial shell confinement is unavailable");
    expect(deniedResultPlanJson).not.toContain("hostShellExecutionPermit");
    for (const surface of [ask, terminal, telemetry]) {
      expect(surface).toBeDefined();
      expect(surface?.toolUseId).toBe("partial-shell-audit-deny");
      expect(surface?.executionPlan).toBe(expectedPlan);
    }
    const approvalAuditText = audit.telemetryEntries
      .filter((entry) => entry.type === "approval")
      .map((entry) => entry.input ?? entry.output ?? "")
      .join("\n");
    expect(approvalAuditText).toContain(`executionPlan.identity=${expectedPlan.identity}`);
    expect(approvalAuditText).not.toContain("echo denied");
  });
  it("keeps the safe projection on a permitless requested-sandbox error", async () => {
    partialWindowsAsrt();
    const execute = vi.fn();
    const registry = new ToolRegistry();
    registry.register(shellProbe(execute));
    let request: ApprovalRequest | undefined;
    // This imitates an untrusted/stale gate response: it says allow-once but
    // carries no host-issued receipt bound to the private action description.
    const requestAndWait = vi.fn(async (pending: ApprovalRequest) => {
      request = pending;
      return { requestId: pending.id, choice: "allow-once" as const };
    });
    const endMetas: ToolCallMeta[] = [];
    const result = await new ToolExecutor(
      registry,
      undefined,
      pmReturning({ decision: "allow", reason: "allow mode", layer: 6 }),
      undefined,
      { requestAndWait } as never,
    ).executeAll(
      [{ id: "partial-shell-permitless", name: "bash", input: { command: "echo receiptless" } }],
      {
        sessionId: "partial-shell",
        permissionContext: permissionContext(),
        callbacks: {
          onToolEnd: (_name, _content, _isError, meta) => endMetas.push(meta),
        },
      },
    );

    expect(execute).not.toHaveBeenCalled();
    expect(requestAndWait).toHaveBeenCalledTimes(1);
    expect(request?.executionPlan).toBeDefined();
    expect(result[0]?.is_error).toBe(true);
    expect(result[0]?.content).toContain("no host-verified allow-once receipt");
    expect(result[0]?.executionPlan).toBe(request!.executionPlan);
    expect(endMetas).toHaveLength(1);
    expect(endMetas[0]?.executionPlan).toBe(request!.executionPlan);
    const permitlessResultPlanJson = JSON.stringify(result[0]?.executionPlan);
    expect(permitlessResultPlanJson).not.toContain("Windows ASRT partial shell confinement is unavailable");
    expect(permitlessResultPlanJson).not.toContain("hostShellExecutionPermit");
    expect(permitlessResultPlanJson).not.toContain('"reason"');
  });

  it("fails closed when neither PermissionManager nor ApprovalGate is present", async () => {
    partialWindowsAsrt();
    const execute = vi.fn();
    const registry = new ToolRegistry();
    registry.register(shellProbe(execute));
    const executor = new ToolExecutor(registry, undefined, undefined, undefined, undefined);

    const result = await executor.executeAll(
      [{ id: "partial-shell-no-gates", name: "bash", input: { command: "echo blocked" } }],
      { sessionId: "partial-shell", permissionContext: permissionContext() },
    );

    expect(execute).not.toHaveBeenCalled();
    expect(result[0]?.is_error).toBe(true);
  });

  it("does not attach a Plan-B capability to a dynamic bash lookalike", async () => {
    partialWindowsAsrt();
    let observedContext: import("../types.js").ToolExecutionContext | undefined;
    const registry = new ToolRegistry();
    registry.register(dynamicShellProbe((ctx) => { observedContext = ctx; }));
    const executor = new ToolExecutor(
      registry,
      undefined,
      pmReturning({ decision: "allow", reason: "ordinary dynamic tool", layer: 6 }),
    );

    const result = await executor.executeAll(
      [{ id: "dynamic-bash-lookalike", name: "bash", input: { command: "echo ordinary" } }],
      { sessionId: "partial-shell", permissionContext: permissionContext() },
    );

    expect(observedContext?.hostShellExecutionPlan).toBeUndefined();
    expect(observedContext?.hostShellExecutionPermit).toBeUndefined();
    expect(result[0]?.is_error).toBeUndefined();
  });

  it("fails closed before strict headless reviewer dispatch", async () => {
    partialWindowsAsrt();
    const execute = vi.fn();
    const registry = new ToolRegistry();
    registry.register(shellProbe(execute));
    const pm = new PermissionManager("/tmp/nonexistent-windows-partial-headless.json");
    pm.setMode("strict");
    const requestAndWait = vi.fn();
    const executor = new ToolExecutor(
      registry,
      undefined,
      pm,
      undefined,
      { requestAndWait } as never,
    );

    const result = await executor.executeAll(
      [{ id: "partial-shell-headless", name: "bash", input: { command: "echo headless" } }],
      {
        sessionId: "partial-shell",
        permissionContext: permissionContext({ headless: true }),
      },
    );

    expect(requestAndWait).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(result[0]?.is_error).toBe(true);
  });
  it.each(["darwin", "linux", "win32"] as const)(
    "forces an exact one-shot modal and bypasses reviewer/memory for requested-unavailable %s shells",
    async (platform) => {
      requestedSandboxUnavailable(platform);
      const execute = vi.fn();
      const registry = new ToolRegistry();
      registry.register(shellProbe(execute));
      const pm = pmReturning({
        decision: "ask",
        reason: "reviewer would normally handle this",
        layer: 6,
        reviewer: { route: "foreground-auto" },
      });
      pm.dispatchReviewer = vi.fn() as never;
      const requestAndWait = vi.fn(async (request: { id: string }) => ({
        requestId: request.id,
        choice: "deny-once" as const,
      }));
      const executor = new ToolExecutor(
        registry,
        undefined,
        pm,
        undefined,
        { requestAndWait } as never,
      );
      const privateExecutor = executor as unknown as {
        tryUserApprovalMemorySkip: (...args: unknown[]) => unknown;
      };
      const memorySkip = vi.spyOn(privateExecutor, "tryUserApprovalMemorySkip");

      const result = await executor.executeAll(
        [{ id: `requested-unavailable-${platform}`, name: "bash", input: { command: "echo no-run" } }],
        { sessionId: `requested-unavailable-${platform}`, permissionContext: permissionContext() },
      );

      expect(pm.dispatchReviewer).not.toHaveBeenCalled();
      expect(memorySkip).not.toHaveBeenCalled();
      expect(requestAndWait).toHaveBeenCalledTimes(1);
      const request = requestAndWait.mock.calls[0]?.[0] as {
        allowedChoices?: string[];
        forceExplicit?: boolean;
        hostShellExecutionPermitBinding?: unknown;
        executionPlan?: {
          platform: string;
          requestedSandbox: boolean;
          mode: string;
          fallbackReason: string;
          requiresExplicitUserApproval: boolean;
          capability: { kind: string; confines?: Record<string, boolean> };
        };
      };
      expect(request.allowedChoices).toEqual(["allow-once", "deny-once"]);
      expect(request.forceExplicit).toBe(true);
      expect(request.hostShellExecutionPermitBinding).toBeDefined();
      expect(request.executionPlan).toMatchObject({
        platform,
        requestedSandbox: true,
        mode: "plain",
        fallbackReason: "requested-sandbox-unavailable",
        requiresExplicitUserApproval: true,
        capability: {
          kind: "none",
          confines: { filesystem: false, process: false, network: false },
        },
      });
      expect(execute).not.toHaveBeenCalled();
      expect(result[0]?.is_error).toBe(true);
    },
  );

  it.each(["darwin", "linux", "win32"] as const)(
    "mints and consumes a generic one-shot permit for requested-unavailable %s shells",
    async (platform) => {
      requestedSandboxUnavailable(platform);
      let observedPlan: import("../../permissions/host-shell-execution-plan.js").HostShellExecutionPlan | undefined;
      let permitConsumed = false;
      const registry = new ToolRegistry();
      registry.register(shellProbe((ctx) => {
        observedPlan = ctx.hostShellExecutionPlan;
        if (observedPlan === undefined) return;
        permitConsumed = consumeHostShellExecutionPermit({
          permit: ctx.hostShellExecutionPermit,
          plan: observedPlan,
          toolName: "bash",
          toolUseId:
            typeof ctx.metadata.toolUseId === "string"
              ? ctx.metadata.toolUseId
              : undefined,
          command: "echo one-shot",
          requestedCwd: undefined,
          executionCwd: ctx.cwd,
          resolvedCwd: resolveHostShellWorkingDirectory(ctx.cwd, undefined),
          timeoutSeconds: TOOL_TIMEOUT_POLICY.shellDefaultMs / 1000,
          allowedDirectories: canonicalizeHostShellAllowedDirectories(
            ctx.extraAllowedDirectories,
          ),
        });
      }));
      const { gate, send } = gateResolving("allow-once");
      const result = await new ToolExecutor(
        registry,
        undefined,
        pmReturning({ decision: "allow", reason: "allow mode", layer: 6 }),
        undefined,
        gate,
      ).executeAll(
        [{ id: `requested-unavailable-allow-${platform}`, name: "bash", input: { command: "echo one-shot" } }],
        { sessionId: `requested-unavailable-allow-${platform}`, permissionContext: permissionContext() },
      );

      expect(send).toHaveBeenCalledTimes(1);
      const rendererApproval = send.mock.calls[0]?.[1] as ApprovalRequest;
      expect(rendererApproval.requireExplicit).toBe(true);
      expect(permitConsumed).toBe(true);
      expect(observedPlan).toMatchObject({
        platform,
        requestedSandbox: true,
        mode: "plain",
        fallbackReason: "requested-sandbox-unavailable",
        requiresExplicitUserApproval: true,
      });
      expect(result[0]?.is_error).toBeUndefined();
    },
  );

  it.each(["darwin", "linux", "win32"] as const)(
    "keeps explicitly sandbox-off %s shells on the normal approval route",
    async (platform) => {
      explicitlySandboxOff(platform);
      let observedPlan: import("../../permissions/host-shell-execution-plan.js").HostShellExecutionPlan | undefined;
      const execute = vi.fn((ctx: import("../types.js").ToolExecutionContext) => {
        observedPlan = ctx.hostShellExecutionPlan;
      });
      const registry = new ToolRegistry();
      registry.register(shellProbe(execute));
      const requestAndWait = vi.fn();
      const result = await new ToolExecutor(
        registry,
        undefined,
        pmReturning({ decision: "allow", reason: "ordinary explicit-off path", layer: 6 }),
        undefined,
        { requestAndWait } as never,
      ).executeAll(
        [{ id: `explicit-off-${platform}`, name: "bash", input: { command: "echo normal" } }],
        { sessionId: `explicit-off-${platform}`, permissionContext: permissionContext() },
      );

      expect(requestAndWait).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalledTimes(1);
      expect(observedPlan).toMatchObject({
        platform,
        requestedSandbox: false,
        mode: "plain",
        fallbackReason: "none",
        requiresExplicitUserApproval: false,
      });
      expect(result[0]?.is_error).toBeUndefined();
    },
  );
});
