import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { AuditLogger } from "../../audit/audit-logger.js";
import { HookRunner } from "../../hooks/hook-runner.js";
import type { ScriptHookManager } from "../../hooks/script-hook-manager.js";
import type { ApprovalGate } from "../../permissions/approval-gate.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { DeferredQueue } from "../../permissions/reviewer/deferred-queue.js";
import { VerdictCache } from "../../permissions/reviewer/verdict-cache.js";
import { createDynamicTool } from "../base.js";
import {
  RATIONALE_UNKNOWN_SCOPE_SENTINEL,
  InMemoryHostAnchorRoundCasStore,
  createActionIdentity,
  createRationaleRequiredControl,
  createRequestAnchor,
} from "../pipeline/rationale-control.js";
import { createRationaleExecutorControlOutcome } from "../pipeline/rationale-pr1-contract.js";
import { createSealedRationaleResumeRequest } from "../pipeline/rationale-resume-contract.js";
import type {
  RationaleResumeHostRuntime,
  RationaleResumeIdentityProbe,
} from "../pipeline/rationale-resume-runner.js";
import {
  InMemoryHostInvocationStartCasStore,
  type HostInvocationStartCas,
  type InvocationAuditRecord,
} from "../pipeline/rationale-ticket-lifecycle.js";
import {
  InProcessRationaleTicketStore,
  createRationaleTicketCasExpectation,
} from "../pipeline/rationale-ticket-store.js";
import type {
  RationaleControlCandidate,
  RationaleHostRuntime,
  RationaleRuntimeMaterialization,
} from "../pipeline/rationale-orchestrator.js";
import {
  RATIONALE_TERMINAL_AUDIT_UNKNOWN_RESULT,
  ToolExecutor,
  type RationaleResumeExecuteOptions,
} from "../executor.js";
import { ToolRegistry } from "../registry.js";

const permissionContext = {
  trustOrigin: "llm-tool-arg" as const,
  userIntent: "Perform the requested operation.",
};

function requestAnchor() {
  const anchor = createRequestAnchor({
    sessionId: "session-rationale-resume",
    turnId: "turn-rationale-resume",
    inputMessageId: "message-rationale-resume",
    inputOrigin: "user-keyboard",
    rawIntent: "Perform the requested write operation.",
  });
  if (!anchor) throw new Error("test request anchor was not created");
  return anchor;
}

function hostRuntime(): RationaleHostRuntime {
  const anchor = requestAnchor();
  const anchorCas = new InMemoryHostAnchorRoundCasStore();
  return {
    requestAnchor: anchor,
    rationaleProvenance: { startedFromUserKeyboard: true, taint: "none" },
    materializeRationaleControl: (
      candidate: RationaleControlCandidate,
    ): RationaleRuntimeMaterialization => {
      const canonicalTargets = candidate.canonicalTargets.length > 0
        ? [...candidate.canonicalTargets]
        : [RATIONALE_UNKNOWN_SCOPE_SENTINEL];
      const action = createActionIdentity({
        anchorId: candidate.requestAnchor.anchorId,
        invocationTrustOrigin: candidate.invocationTrustOrigin,
        rationaleProvenance: candidate.rationaleProvenance,
        toolName: candidate.toolName,
        toolVersion: candidate.toolVersion,
        source: candidate.source,
        category: candidate.category,
        finalInput: { ...candidate.finalInput },
        ...(candidate.approvalCacheKey === undefined
          ? {}
          : { approvalCacheKey: candidate.approvalCacheKey }),
        canonicalTargets,
        requestedEffects: [candidate.category],
        affectedResources: [canonicalTargets[0]],
        requiredAuthority: "mid",
        policyEpoch: "resume-policy-v1",
        registryGeneration: "resume-registry-v1",
        sandboxGeneration: "resume-sandbox-v1",
        sandboxExecutionPlan: structuredClone(
          candidate.sandboxExecutionPlan,
        ) as Record<string, unknown>,
      });
      const reservation = anchorCas.tryReserve({
        anchor: candidate.requestAnchor,
        action,
        triggeringBatchDisposition: candidate.triggeringBatchDisposition,
        round: 1,
        now: candidate.now,
      });
      if (!reservation) throw new Error("anchor round reservation failed");
      const control = createRationaleRequiredControl({
        anchor: candidate.requestAnchor,
        action,
        triggeringBatchDisposition: candidate.triggeringBatchDisposition,
        anchorRoundReservation: reservation,
        hostAnchorRoundCas: anchorCas,
        sealedAction: {
          toolUseId: candidate.toolUseId,
          toolName: candidate.toolName,
          originalInput: { ...candidate.originalInput },
          finalInput: { ...candidate.finalInput },
        },
        eligibilityContext: candidate.eligibilityContext,
        permission: candidate.permission,
        now: candidate.now,
      });
      return {
        action,
        control,
        ticket: {
          contractVersion: control.contractVersion,
          ticketId: control.ticketId,
          actionDigest: control.action.actionDigest,
          state: "review_required",
          rationaleStatus: "not-requested",
          generationOutcome: null,
          reevaluationOutcome: null,
          terminalReason: null,
        },
        executorControl: createRationaleExecutorControlOutcome(control, candidate.now),
      };
    },
  };
}

function reviewerManager(directory: string): PermissionManager {
  const manager = new PermissionManager(join(directory, "permissions.json"));
  manager.setMode("auto");
  manager.setInteractiveAutoApprove("low");
  manager.setReviewer({
    classifier: {
      classify: vi.fn(() => ({
        level: "medium" as const,
        reason: "requires rationale",
      })),
    },
    cache: new VerdictCache(join(directory, "reviewer-cache.jsonl")),
    deferredQueue: new DeferredQueue(join(directory, "deferred-queue.jsonl")),
  });
  return manager;
}

function createScriptHooks(order: string[]): ScriptHookManager {
  const allow = () => ({
    decision: "allow" as const,
    reason: "test allow",
    results: [],
  });
  return {
    runPermissionRequest: vi.fn(async () => {
      order.push("permission-hook");
      return allow();
    }),
    runPreToolUse: vi.fn(async () => {
      order.push("script-pre");
      return allow();
    }),
    runPostToolUse: vi.fn(async () => {
      order.push("script-post");
      return allow();
    }),
    runLifecycleEvent: vi.fn(async () => allow()),
  } as unknown as ScriptHookManager;
}

function createAuditLogger(order: string[], directory: string): AuditLogger {
  return {
    isPermissionAuditChainReady: () => true,
    isShadowChannelWritable: () => true,
    getPermissionShadowLogFile: () => join(directory, "shadow.jsonl"),
    assertPermissionAuditWritable: () => {
      order.push("audit-writable");
    },
    appendPermissionAuditEntry: vi.fn(async (entry) => {
      order.push(
        entry.decision === "ask"
          ? "permission-ask-audit"
          : "final-permission-audit",
      );
      return entry;
    }),
    log: vi.fn(() => {
      order.push("final-audit");
    }),
    logShadow: vi.fn(),
  } as unknown as AuditLogger;
}

function tracedStartCas(
  order: string[],
  backing: InMemoryHostInvocationStartCasStore,
): HostInvocationStartCas {
  return {
    commitStart: async (input) => {
      order.push("start-cas");
      order.push("start-consume");
      return backing.commitStart(input);
    },
    commitTerminal: async (input) => {
      order.push("terminal-cas");
      return backing.commitTerminal(input);
    },
  };
}

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "lvis-rationale-resume-"));
  const order: string[] = [];
  const invocationAudits: InvocationAuditRecord[] = [];
  const registry = new ToolRegistry();
  const execute = vi.fn(async () => {
    order.push("tool-execute");
    return "resume-ok";
  });
  registry.register(createDynamicTool({
    name: "sealed_write",
    description: "sealed write",
    source: "builtin",
    category: "write",
    isReadOnly: () => false,
    jsonSchema: {
      type: "object",
      properties: { payload: { type: "string" } },
    },
    execute: async () => ({
      output: await execute(),
      isError: false,
    }),
  }));

  const hooks = new HookRunner();
  hooks.registerPostHook("trace-post", () => {
    order.push("config-post");
  });
  const manager = reviewerManager(directory);
  const approvalGate = {
    requestAndWait: vi.fn(async () => {
      throw new Error("ordinary approval modal must not run for sealed resume");
    }),
  } as unknown as ApprovalGate;
  const scriptHooks = createScriptHooks(order);
  const executor = new ToolExecutor(
    registry,
    hooks,
    manager,
    undefined,
    approvalGate,
    scriptHooks,
    createAuditLogger(order, directory),
  );

  const initial = await executor.executeConversationBatch(
    [{
      id: "sealed-use",
      name: "sealed_write",
      input: { payload: "sealed" },
    }],
    {
      executionCwd: process.cwd(),
      sessionId: "session-rationale-resume",
      permissionContext,
      rationaleRuntime: hostRuntime(),
    },
  );
  if (initial.outcome !== "rationale-required") {
    throw new Error("expected initial rationale control");
  }
  const control = initial.control.control;
  const ticketStore = new InProcessRationaleTicketStore({ onAudit: () => {} });
  let snapshot = ticketStore.create({
    sessionId: "session-rationale-resume",
    control,
  });
  if (!snapshot) throw new Error("ticket create failed");
  snapshot = ticketStore.requestRationale(
    createRationaleTicketCasExpectation(snapshot),
  );
  if (!snapshot) throw new Error("request-rationale failed");
  snapshot = ticketStore.markRationaleFailed(
    createRationaleTicketCasExpectation(snapshot),
    {
      generationOutcome: "generation-error",
      reevaluationOutcome: null,
    },
  );
  if (!snapshot) throw new Error("rationale-failed transition failed");
  snapshot = ticketStore.promptUser(
    createRationaleTicketCasExpectation(snapshot),
  );
  if (!snapshot) throw new Error("prompt-user transition failed");
  const receipt = ticketStore.consumeAllowOnce(
    createRationaleTicketCasExpectation(snapshot),
  );
  if (!receipt) throw new Error("allow-once receipt failed");

  const request = createSealedRationaleResumeRequest({
    control,
    response: null,
    rationaleStatus: "failed",
    reevaluation: null,
    ticket: receipt.ticket,
    currentActionIdentity: control.action,
    currentEligibilityContext: control.eligibilityContext,
    hostConsumedAllowOnceReceipt: receipt,
  });
  const identity = vi.fn((probe: RationaleResumeIdentityProbe) => {
    order.push("current-identity");
    expect(probe.finalInput).toEqual(control.sealedAction.finalInput);
    return control.action;
  });
  const loadReceipt = vi.fn(() => {
    order.push("receipt-load");
    return receipt;
  });
  const authenticateReceipt = vi.fn((candidate, now: number) => {
    order.push("receipt-auth");
    return ticketStore.isAuthenticConsumedAllowOnceReceipt(candidate, now);
  });
  const startStore = new InMemoryHostInvocationStartCasStore();
  const resumeRuntime: RationaleResumeHostRuntime = {
    resolveCurrentActionIdentity: identity,
    loadHostConsumedAllowOnceReceipt: loadReceipt,
    isAuthenticConsumedAllowOnceReceipt: authenticateReceipt,
    hostInvocationStartCas: tracedStartCas(order, startStore),
    onInvocationAudit: (record) => {
      invocationAudits.push(record);
      order.push(
        record.state === "authorized"
          ? "authorized-audit"
          : record.state === "started"
            ? "started-audit"
            : "terminal-audit",
      );
    },
  };
  const options: RationaleResumeExecuteOptions = {
    executionCwd: process.cwd(),
    sessionId: "session-rationale-resume",
    permissionContext,
    rationaleResumeRuntime: resumeRuntime,
    callbacks: {
      onToolStart: () => {
        order.push("tool-start");
      },
      onToolEnd: () => {
        order.push("tool-end");
      },
    },
  };

  return {
    directory,
    order,
    executor,
    execute,
    hooks,
    manager,
    approvalGate,
    scriptHooks,
    request,
    options,
    resumeRuntime,
    identity,
    loadReceipt,
    control,
    invocationAudits,
  };
}

describe("ToolExecutor sealed rationale resume", () => {
  it("uses the existing security suffix without a second modal", async () => {
    const f = await fixture();
    try {
      const result = await f.executor.executeSealedRationaleResume(
        f.request,
        f.options,
      );

      expect(result).toMatchObject({
        tool_use_id: "sealed-use",
        content: "resume-ok",
      });
      expect(result.is_error).toBeUndefined();
      expect(f.execute).toHaveBeenCalledOnce();
      expect(f.approvalGate.requestAndWait).not.toHaveBeenCalled();
      expect(f.order).toEqual([
        "current-identity",
        "permission-hook",
        "permission-ask-audit",
        "receipt-load",
        "receipt-auth",
        "script-pre",
        "audit-writable",
        "start-cas",
        "start-consume",
        "authorized-audit",
        "started-audit",
        "tool-start",
        "tool-execute",
        "config-post",
        "script-post",
        "final-audit",
        "final-permission-audit",
        "terminal-cas",
        "terminal-audit",
        "tool-end",
      ]);
    } finally {
      rmSync(f.directory, { recursive: true, force: true });
    }
  });

  it("blocks a HookRunner mutation before identity, receipt, modal, or execute", async () => {
    const f = await fixture();
    try {
      f.hooks.registerPreHook("mutate-after-seal", () => ({
        action: "modify",
        updatedInput: { payload: "changed" },
      }));
      const result = await f.executor.executeSealedRationaleResume(
        f.request,
        f.options,
      );

      expect(result.is_error).toBe(true);
      expect(result.content).toContain("sealed original/final input changed");
      expect(f.identity).not.toHaveBeenCalled();
      expect(f.loadReceipt).not.toHaveBeenCalled();
      expect(f.approvalGate.requestAndWait).not.toHaveBeenCalled();
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.order).not.toContain("tool-start");
    } finally {
      rmSync(f.directory, { recursive: true, force: true });
    }
  });

  it("blocks current policy and sandbox identity drift before receipt or execute", async () => {
    const policy = await fixture();
    try {
      policy.manager.setMode("allow");
      const policyResult = await policy.executor.executeSealedRationaleResume(
        policy.request,
        policy.options,
      );
      expect(policyResult.is_error).toBe(true);
      expect(policyResult.content).toContain("same eligible ask");
      expect(policy.loadReceipt).not.toHaveBeenCalled();
      expect(policy.execute).not.toHaveBeenCalled();
    } finally {
      rmSync(policy.directory, { recursive: true, force: true });
    }

    const sandbox = await fixture();
    try {
      const staleRuntime: RationaleResumeHostRuntime = {
        ...sandbox.resumeRuntime,
        resolveCurrentActionIdentity: (probe) => createActionIdentity({
          anchorId: sandbox.control.anchor.anchorId,
          invocationTrustOrigin: probe.invocationTrustOrigin,
          rationaleProvenance: sandbox.control.action.rationaleProvenance,
          toolName: probe.toolName,
          toolVersion: probe.toolVersion,
          source: probe.source,
          category: probe.category,
          finalInput: { ...probe.finalInput },
          ...(probe.approvalCacheKey === undefined
            ? {}
            : { approvalCacheKey: probe.approvalCacheKey }),
          canonicalTargets: sandbox.control.action.canonicalTargets,
          requestedEffects: sandbox.control.action.requestedEffects,
          affectedResources: sandbox.control.action.affectedResources,
          requiredAuthority: sandbox.control.action.requiredAuthority,
          policyEpoch: sandbox.control.action.policyEpoch,
          registryGeneration: sandbox.control.action.registryGeneration,
          sandboxGeneration: "resume-sandbox-v2",
          sandboxExecutionPlan: structuredClone(
            probe.sandboxExecutionPlan,
          ) as Record<string, unknown>,
        }),
      };
      const result = await sandbox.executor.executeSealedRationaleResume(
        sandbox.request,
        {
          ...sandbox.options,
          rationaleResumeRuntime: staleRuntime,
        },
      );
      expect(result.is_error).toBe(true);
      expect(result.content).toContain("sandbox binding changed");
      expect(sandbox.loadReceipt).not.toHaveBeenCalled();
      expect(sandbox.execute).not.toHaveBeenCalled();
    } finally {
      rmSync(sandbox.directory, { recursive: true, force: true });
    }
  });

  it("enforces start at-most-once on replay and never falls back to the modal", async () => {
    const f = await fixture();
    try {
      const first = await f.executor.executeSealedRationaleResume(
        f.request,
        f.options,
      );
      const second = await f.executor.executeSealedRationaleResume(
        f.request,
        f.options,
      );

      expect(first.is_error).toBeUndefined();
      expect(second.is_error).toBe(true);
      expect(second.content).toContain("already started");
      expect(f.execute).toHaveBeenCalledOnce();
      expect(f.order.filter((entry) => entry === "tool-start")).toHaveLength(1);
      expect(f.invocationAudits.map((record) => record.state)).toEqual([
        "authorized",
        "started",
        "completed",
      ]);
      expect(f.approvalGate.requestAndWait).not.toHaveBeenCalled();
    } finally {
      rmSync(f.directory, { recursive: true, force: true });
    }
  });

  it("does not persist an authorized audit for a pre-start script denial", async () => {
    const f = await fixture();
    try {
      vi.mocked(f.scriptHooks.runPreToolUse).mockImplementationOnce(async () => {
        f.order.push("script-pre");
        return { decision: "deny", reason: "blocked before start", results: [] };
      });
      const result = await f.executor.executeSealedRationaleResume(
        f.request,
        f.options,
      );

      expect(result.is_error).toBe(true);
      expect(result.content).toContain("script PreToolUse hook denied");
      expect(f.invocationAudits).toEqual([]);
      expect(f.order).not.toContain("authorized-audit");
      expect(f.order).not.toContain("start-cas");
      expect(f.execute).not.toHaveBeenCalled();
    } finally {
      rmSync(f.directory, { recursive: true, force: true });
    }
  });

  it("terminalizes a started invocation when the tool fails", async () => {
    const f = await fixture();
    try {
      f.execute.mockRejectedValueOnce(new Error("sealed tool failure"));
      const result = await f.executor.executeSealedRationaleResume(
        f.request,
        f.options,
      );

      expect(result.is_error).toBe(true);
      expect(f.invocationAudits.map((record) => record.state)).toEqual([
        "authorized",
        "started",
        "failed",
      ]);
    } finally {
      rmSync(f.directory, { recursive: true, force: true });
    }
  });

  it("terminalizes fail-closed when an exception escapes after start", async () => {
    const f = await fixture();
    try {
      await expect(f.executor.executeSealedRationaleResume(
        f.request,
        {
          ...f.options,
          callbacks: {
            ...f.options.callbacks,
            onToolStart: () => {
              f.order.push("tool-start");
              throw new Error("post-start callback failure");
            },
          },
        },
      )).rejects.toThrow("post-start callback failure");

      expect(f.execute).not.toHaveBeenCalled();
      expect(f.invocationAudits.map((record) => record.state)).toEqual([
        "authorized",
        "started",
        "failed",
      ]);
    } finally {
      rmSync(f.directory, { recursive: true, force: true });
    }
  });

  it("rejects a request that does not forbid direct tool execution", async () => {
    const f = await fixture();
    try {
      const tampered = structuredClone(f.request) as unknown as Record<string, unknown>;
      tampered.directToolExecute = "allowed";
      const result = await f.executor.executeSealedRationaleResume(
        tampered as unknown as typeof f.request,
        f.options,
      );

      expect(result.is_error).toBe(true);
      expect(result.content).toContain("invalid or expired sealed resume request");
      expect(f.identity).not.toHaveBeenCalled();
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.invocationAudits).toEqual([]);
    } finally {
      rmSync(f.directory, { recursive: true, force: true });
    }
  });
  it("fails closed before start when the invocation audit sink is missing", async () => {
    const f = await fixture();
    try {
      const { onInvocationAudit: _missing, ...withoutAudit } = f.resumeRuntime;
      const result = await f.executor.executeSealedRationaleResume(
        f.request,
        {
          ...f.options,
          rationaleResumeRuntime:
            withoutAudit as unknown as RationaleResumeHostRuntime,
        },
      );

      expect(result.is_error).toBe(true);
      expect(result.content).toContain("invocation audit sink is unavailable");
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.invocationAudits).toEqual([]);
    } finally {
      rmSync(f.directory, { recursive: true, force: true });
    }
  });

  it("fails closed when trusted resume callbacks are not wired", async () => {
    const f = await fixture();
    try {
      const result = await f.executor.executeSealedRationaleResume(
        f.request,
        {
          ...f.options,
          rationaleResumeRuntime: undefined,
        },
      );
      expect(result.is_error).toBe(true);
      expect(result.content).toContain("ActionIdentity resolver is unavailable");
      expect(f.execute).not.toHaveBeenCalled();
    } finally {
      rmSync(f.directory, { recursive: true, force: true });
    }
  });

  it.each(["return-false", "throw"] as const)(
    "returns only the safe unknown result when terminal commit %s after tool success",
    async (terminalFailure) => {
      const f = await fixture();
      try {
        const startCas = f.resumeRuntime.hostInvocationStartCas;
        if (!startCas) throw new Error("test start CAS was not wired");
        const commitTerminal = vi.fn(async () => {
          if (terminalFailure === "throw") {
            throw new Error("terminal audit projection failed");
          }
          return false;
        });
        const onToolEnd = vi.fn();

        const result = await f.executor.executeSealedRationaleResume(
          f.request,
          {
            ...f.options,
            rationaleResumeRuntime: {
              ...f.resumeRuntime,
              hostInvocationStartCas: {
                commitStart: (input) => startCas.commitStart(input),
                commitTerminal,
              },
            },
            callbacks: {
              ...f.options.callbacks,
              onToolEnd,
            },
          },
        );

        expect(result).toEqual(expect.objectContaining({
          tool_use_id: "sealed-use",
          content: RATIONALE_TERMINAL_AUDIT_UNKNOWN_RESULT,
          is_error: true,
        }));
        expect(result).not.toHaveProperty("rawResult");
        expect(result).not.toHaveProperty("uiPayload");
        expect(result.content).not.toContain("resume-ok");
        expect(f.execute).toHaveBeenCalledOnce();
        expect(commitTerminal).toHaveBeenCalledOnce();
        expect(onToolEnd).toHaveBeenCalledOnce();
        expect(onToolEnd.mock.calls[0]?.[1]).toBe(
          RATIONALE_TERMINAL_AUDIT_UNKNOWN_RESULT,
        );
        expect(f.invocationAudits.map((record) => record.state)).toEqual([
          "authorized",
          "started",
        ]);
      } finally {
        rmSync(f.directory, { recursive: true, force: true });
      }
    },
  );

  it("masks a tool failure when its terminal audit cannot be committed", async () => {
    const f = await fixture();
    try {
      const startCas = f.resumeRuntime.hostInvocationStartCas;
      if (!startCas) throw new Error("test start CAS was not wired");
      const commitTerminal = vi.fn(async () => false);
      const onToolEnd = vi.fn();
      f.execute.mockRejectedValueOnce(new Error("sealed tool failure secret"));

      const result = await f.executor.executeSealedRationaleResume(
        f.request,
        {
          ...f.options,
          rationaleResumeRuntime: {
            ...f.resumeRuntime,
            hostInvocationStartCas: {
              commitStart: (input) => startCas.commitStart(input),
              commitTerminal,
            },
          },
          callbacks: {
            ...f.options.callbacks,
            onToolEnd,
          },
        },
      );

      expect(result).toEqual(expect.objectContaining({
        tool_use_id: "sealed-use",
        content: RATIONALE_TERMINAL_AUDIT_UNKNOWN_RESULT,
        is_error: true,
      }));
      expect(result.content).not.toContain("sealed tool failure secret");
      expect(f.execute).toHaveBeenCalledOnce();
      expect(commitTerminal).toHaveBeenCalledOnce();
      expect(onToolEnd).toHaveBeenCalledOnce();
      expect(onToolEnd.mock.calls[0]?.[1]).toBe(
        RATIONALE_TERMINAL_AUDIT_UNKNOWN_RESULT,
      );
      expect(f.invocationAudits.map((record) => record.state)).toEqual([
        "authorized",
        "started",
      ]);
    } finally {
      rmSync(f.directory, { recursive: true, force: true });
    }
  });

  it("attempts terminal commit only once when a post-start callback also fails", async () => {
    const f = await fixture();
    try {
      const startCas = f.resumeRuntime.hostInvocationStartCas;
      if (!startCas) throw new Error("test start CAS was not wired");
      const commitTerminal = vi.fn(async () => false);

      await expect(f.executor.executeSealedRationaleResume(
        f.request,
        {
          ...f.options,
          rationaleResumeRuntime: {
            ...f.resumeRuntime,
            hostInvocationStartCas: {
              commitStart: (input) => startCas.commitStart(input),
              commitTerminal,
            },
          },
          callbacks: {
            ...f.options.callbacks,
            onToolStart: () => {
              throw new Error("post-start callback failure");
            },
          },
        },
      )).rejects.toThrow("post-start callback failure");

      expect(f.execute).not.toHaveBeenCalled();
      expect(commitTerminal).toHaveBeenCalledOnce();
      expect(f.order).not.toContain("tool-end");
      expect(f.invocationAudits.map((record) => record.state)).toEqual([
        "authorized",
        "started",
      ]);
    } finally {
      rmSync(f.directory, { recursive: true, force: true });
    }
  });

  it("commits the terminal audit before publishing the external tool callback", async () => {
    const f = await fixture();
    try {
      const startCas = f.resumeRuntime.hostInvocationStartCas;
      if (!startCas) throw new Error("test start CAS was not wired");
      let terminalCommitted = false;
      const commitTerminal = vi.fn(async (input) => {
        terminalCommitted = await startCas.commitTerminal(input);
        return terminalCommitted;
      });
      const onToolEnd = vi.fn(() => {
        expect(terminalCommitted).toBe(true);
      });

      const result = await f.executor.executeSealedRationaleResume(
        f.request,
        {
          ...f.options,
          rationaleResumeRuntime: {
            ...f.resumeRuntime,
            hostInvocationStartCas: {
              commitStart: (input) => startCas.commitStart(input),
              commitTerminal,
            },
          },
          callbacks: {
            ...f.options.callbacks,
            onToolEnd,
          },
        },
      );

      expect(result.content).toBe("resume-ok");
      expect(result.is_error).toBeUndefined();
      expect(commitTerminal).toHaveBeenCalledOnce();
      expect(onToolEnd).toHaveBeenCalledOnce();
      expect(onToolEnd.mock.calls[0]?.[1]).toBe("resume-ok");
    } finally {
      rmSync(f.directory, { recursive: true, force: true });
    }
  });
});