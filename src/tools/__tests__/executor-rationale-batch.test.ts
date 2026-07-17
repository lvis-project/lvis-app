import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { HookRunner } from "../../hooks/hook-runner.js";
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
import {
  createRationaleExecutorControlOutcome,
} from "../pipeline/rationale-pr1-contract.js";
import {
  createRationaleReviewRequiredRecord,
} from "../pipeline/rationale-ticket-lifecycle.js";
import type {
  RationaleControlCandidate,
  RationaleHostRuntime,
  RationaleRuntimeMaterialization,
} from "../pipeline/rationale-orchestrator.js";
import { ToolExecutor } from "../executor.js";
import { ToolRegistry } from "../registry.js";
import type { ToolCategory } from "../types.js";

function requestAnchor() {
  const anchor = createRequestAnchor({
    sessionId: "session-rationale",
    turnId: "turn-rationale",
    inputMessageId: "message-rationale",
    inputOrigin: "user-keyboard",
    rawIntent: "Perform the requested operation.",
  });
  if (!anchor) throw new Error("test request anchor was not created");
  return anchor;
}

function hostRuntime(anchor = requestAnchor()): {
  runtime: RationaleHostRuntime;
  materialize: ReturnType<typeof vi.fn>;
} {
  const cas = new InMemoryHostAnchorRoundCasStore();
  const materialize = vi.fn(
    (candidate: RationaleControlCandidate): RationaleRuntimeMaterialization => {
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
        ...(candidate.pluginId === undefined ? {} : { pluginId: candidate.pluginId }),
        ...(candidate.mcpServerId === undefined ? {} : { mcpServerId: candidate.mcpServerId }),
        ...(candidate.workerId === undefined ? {} : { workerId: candidate.workerId }),
        finalInput: { ...candidate.finalInput },
        ...(candidate.approvalCacheKey === undefined
          ? {}
          : { approvalCacheKey: candidate.approvalCacheKey }),
        canonicalTargets,
        requestedEffects: [candidate.category],
        affectedResources: canonicalTargets[0] === RATIONALE_UNKNOWN_SCOPE_SENTINEL
          ? [RATIONALE_UNKNOWN_SCOPE_SENTINEL]
          : ["declared-targets"],
        requiredAuthority: "mid",
        policyEpoch: "test-policy-epoch",
        registryGeneration: "test-registry-generation",
        sandboxGeneration: "test-sandbox-generation",
        sandboxExecutionPlan: structuredClone(
          candidate.sandboxExecutionPlan,
        ) as Record<string, unknown>,
      });
      const reservation = cas.tryReserve({
        anchor: candidate.requestAnchor,
        action,
        triggeringBatchDisposition: candidate.triggeringBatchDisposition,
        round: 1,
        now: candidate.now,
      });
      if (!reservation) throw new Error("test anchor round was already reserved");
      const control = createRationaleRequiredControl({
        anchor: candidate.requestAnchor,
        action,
        triggeringBatchDisposition: candidate.triggeringBatchDisposition,
        anchorRoundReservation: reservation,
        hostAnchorRoundCas: cas,
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
        ticket: createRationaleReviewRequiredRecord(control, candidate.now),
        executorControl: createRationaleExecutorControlOutcome(control, candidate.now),
      };
    },
  );
  return {
    runtime: {
      requestAnchor: anchor,
      rationaleProvenance: { startedFromUserKeyboard: true, taint: "none" },
      materializeRationaleControl: materialize,
    },
    materialize,
  };
}

function registerProbe(
  registry: ToolRegistry,
  input: {
    name: string;
    category: ToolCategory;
    execute: ReturnType<typeof vi.fn>;
    parallelSafe?: boolean;
  },
): void {
  registry.register(createDynamicTool({
    name: input.name,
    description: input.name,
    source: "builtin",
    category: input.category,
    ...(input.category === "meta" ? { decisionOverride: "ask" as const } : {}),
    ...(input.parallelSafe === undefined ? {} : { parallelSafe: input.parallelSafe }),
    isReadOnly: () => input.category === "read",
    jsonSchema: {
      type: "object",
      properties: { payload: { type: "string" } },
    },
    execute: async (rawInput) => ({
      output: await input.execute(rawInput),
      isError: false,
    }),
  }));
}

function reviewerPermissionManager(directory: string, classify = vi.fn(() => ({
  level: "medium" as const,
  reason: "requires rationale",
}))): PermissionManager {
  const manager = new PermissionManager(join(directory, "permissions.json"));
  manager.setMode("auto");
  manager.setInteractiveAutoApprove("low");
  manager.setReviewer({
    classifier: { classify },
    cache: new VerdictCache(join(directory, "reviewer-cache.jsonl")),
    deferredQueue: new DeferredQueue(join(directory, "deferred-queue.jsonl")),
  });
  return manager;
}

const permissionContext = {
  trustOrigin: "llm-tool-arg" as const,
  userIntent: "Perform the requested operation.",
};

describe("ToolExecutor rationale conversation batches", () => {
  it("keeps the existing completed-result path when no anchored runtime is present", async () => {
    const registry = new ToolRegistry();
    const first = vi.fn(async () => "first");
    const second = vi.fn(async () => "second");
    registerProbe(registry, {
      name: "parallel_read_first",
      category: "read",
      execute: first,
      parallelSafe: true,
    });
    registerProbe(registry, {
      name: "parallel_read_second",
      category: "read",
      execute: second,
      parallelSafe: true,
    });
    const executor = new ToolExecutor(registry);

    const outcome = await executor.executeConversationBatch(
      [
        { id: "read-first", name: "parallel_read_first", input: { payload: "a" } },
        { id: "read-second", name: "parallel_read_second", input: { payload: "b" } },
      ],
      {
        executionCwd: process.cwd(),
        permissionContext,
      },
    );

    expect(outcome.outcome).toBe("completed");
    if (outcome.outcome !== "completed") throw new Error("unexpected rationale control");
    expect(outcome.results.map((result) => result.tool_use_id)).toEqual([
      "read-first",
      "read-second",
    ]);
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  });

  it("returns a separate control, preserves the completed prefix, and cancels later siblings", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lvis-rationale-executor-batch-"));
    try {
      const registry = new ToolRegistry();
      const before = vi.fn(async () => "before");
      const trigger = vi.fn(async () => "must-not-run");
      const after = vi.fn(async () => "must-not-run");
      registerProbe(registry, { name: "prefix_read", category: "read", execute: before });
      registerProbe(registry, { name: "arbitrary_write", category: "write", execute: trigger });
      registerProbe(registry, { name: "suffix_read", category: "read", execute: after });
      const hooks = new HookRunner();
      hooks.registerPreHook("rewrite-trigger", (context) =>
        context.toolName === "arbitrary_write"
          ? { action: "modify", updatedInput: { payload: "post-hook-raw" } }
          : { action: "allow" },
      );
      const manager = reviewerPermissionManager(directory);
      const executor = new ToolExecutor(registry, hooks, manager);
      const { runtime, materialize } = hostRuntime();
      const onToolStart = vi.fn();
      const onToolEnd = vi.fn();

      const outcome = await executor.executeConversationBatch(
        [
          { id: "prefix", name: "prefix_read", input: { payload: "before" } },
          { id: "trigger", name: "arbitrary_write", input: { payload: "provider" } },
          { id: "suffix", name: "suffix_read", input: { payload: "after" } },
        ],
        {
          executionCwd: process.cwd(),
          sessionId: "session-rationale",
          permissionContext,
          rationaleRuntime: runtime,
          callbacks: { onToolStart, onToolEnd },
        },
      );

      expect(outcome.outcome).toBe("rationale-required");
      if (outcome.outcome !== "rationale-required") {
        throw new Error("expected rationale control");
      }
      expect(outcome.completedResults.map((result) => result.tool_use_id)).toEqual(["prefix"]);
      expect(outcome.control.ordinaryToolResult).toBeNull();
      expect(outcome.control.executionAuthorized).toBe(false);
      expect(outcome.control.control.sealedAction.finalInput).toEqual({
        payload: "post-hook-raw",
      });
      expect(outcome.control.triggeringBatchDisposition).toMatchObject({
        originalToolUseIds: ["prefix", "trigger", "suffix"],
        triggeringToolUseId: "trigger",
        completedToolUseIds: ["prefix"],
        cancelledUnexecutedToolUseIds: ["suffix"],
      });
      expect(before).toHaveBeenCalledOnce();
      expect(trigger).not.toHaveBeenCalled();
      expect(after).not.toHaveBeenCalled();
      expect(onToolStart.mock.calls.map(([name]) => name)).toEqual(["prefix_read"]);
      expect(onToolEnd.mock.calls.map(([name]) => name)).toEqual(["prefix_read"]);
      expect(materialize).toHaveBeenCalledOnce();
      const candidate = materialize.mock.calls[0]?.[0] as RationaleControlCandidate;
      expect(candidate.finalInput).toEqual({ payload: "post-hook-raw" });
      expect(candidate.permission).toMatchObject({
        decision: "ask",
        layer: 5,
        reviewer: { route: "foreground-auto", outcome: "fresh" },
      });
      expect(candidate.allowedDirectories.length).toBeGreaterThan(0);
      expect(candidate.sandboxExecutionPlan).toMatchObject({
        version: "rationale-sandbox-execution-plan/v1",
        executionCwd: process.cwd(),
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("intercepts both fresh and cached final reviewer asks", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lvis-rationale-executor-cache-"));
    try {
      const registry = new ToolRegistry();
      const execute = vi.fn(async () => "must-not-run");
      registerProbe(registry, { name: "cache_write", category: "write", execute });
      const classify = vi.fn(() => ({
        level: "medium" as const,
        reason: "requires rationale",
      }));
      const executor = new ToolExecutor(
        registry,
        undefined,
        reviewerPermissionManager(directory, classify),
      );
      const firstRuntime = hostRuntime();
      const first = await executor.executeConversationBatch(
        [{ id: "fresh-trigger", name: "cache_write", input: { payload: "same" } }],
        {
          executionCwd: process.cwd(),
          sessionId: "session-rationale",
          permissionContext,
          rationaleRuntime: firstRuntime.runtime,
        },
      );
      const secondRuntime = hostRuntime();
      const second = await executor.executeConversationBatch(
        [{ id: "cache-trigger", name: "cache_write", input: { payload: "same" } }],
        {
          executionCwd: process.cwd(),
          sessionId: "session-rationale",
          permissionContext,
          rationaleRuntime: secondRuntime.runtime,
        },
      );

      expect(first.outcome).toBe("rationale-required");
      expect(second.outcome).toBe("rationale-required");
      if (first.outcome !== "rationale-required" || second.outcome !== "rationale-required") {
        throw new Error("expected rationale controls");
      }
      expect(first.control.control.reviewerOutcome).toBe("fresh");
      expect(second.control.control.reviewerOutcome).toBe("cache");
      expect(classify).toHaveBeenCalledOnce();
      expect(execute).not.toHaveBeenCalled();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ["write", "write_control"],
    ["shell", "shell_control"],
    ["network", "network_control"],
    ["meta", "agent_spawn"],
    ["meta", "agent_interrupt"],
    ["meta", "unrelated_meta_control"],
  ] as const)(
    "uses the same rationale branch for %s tool %s",
    async (category, name) => {
      const directory = mkdtempSync(join(tmpdir(), "lvis-rationale-executor-category-"));
      try {
        const registry = new ToolRegistry();
        const execute = vi.fn(async () => "must-not-run");
        registerProbe(registry, { name, category, execute });
        const executor = new ToolExecutor(
          registry,
          undefined,
          reviewerPermissionManager(directory),
        );
        const { runtime } = hostRuntime();
        const onToolStart = vi.fn();
        const onToolEnd = vi.fn();

        const outcome = await executor.executeConversationBatch(
          [{
            id: "category-trigger",
            name,
            input: category === "shell" ? { command: "echo safe" } : { payload: "value" },
          }],
          {
            executionCwd: process.cwd(),
            sessionId: "session-rationale",
            permissionContext,
            rationaleRuntime: runtime,
            callbacks: { onToolStart, onToolEnd },
          },
        );

        expect(outcome.outcome).toBe("rationale-required");
        if (outcome.outcome !== "rationale-required") {
          throw new Error("expected rationale control");
        }
        expect(outcome.control.control.action).toMatchObject({
          toolName: name,
          category,
          requiredAuthority: "mid",
        });
        expect(execute).not.toHaveBeenCalled();
        expect(onToolStart).not.toHaveBeenCalled();
        expect(onToolEnd).not.toHaveBeenCalled();
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
