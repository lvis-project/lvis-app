import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import {
  PermissionManager,
  type ReviewerDispatchOutcome,
} from "../../permissions/permission-manager.js";
import { DeferredQueue } from "../../permissions/reviewer/deferred-queue.js";
import {
  __resetActiveSandboxCapabilityForTest,
  __resetSandboxRequestedAtBootForTest,
  setActiveSandboxCapability,
  setSandboxRequestedAtBoot,
} from "../../permissions/sandbox-capability.js";
import { authorizationRequiredStateOf } from "../../shared/authorization-required.js";
import { createDynamicTool } from "../base.js";
import { ToolExecutor } from "../executor.js";
import { ToolRegistry } from "../registry.js";
import { BashTool } from "../shell-tools.js";
import { userPermissionContext } from "./tool-context-fixture.js";

const temporaryDirectories: string[] = [];

function tempDirectory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}

function askingPermissionManager(): PermissionManager {
  const manager = new PermissionManager(join(tempDirectory("lvis-auth-required-"), "permissions.json"));
  manager.checkDetailed = () => ({
    decision: "ask",
    reason: "fixture requires explicit approval",
    layer: 3,
    forceModal: true,
  });
  return manager;
}

afterEach(async () => {
  __resetActiveSandboxCapabilityForTest();
  __resetSandboxRequestedAtBootForTest();
  for (const path of temporaryDirectories.splice(0)) await cleanupTmpDir(path);
});

describe("ToolExecutor authorization-required control", () => {
  it("terminates an ordinary ask when the host has no approval surface", async () => {
    const execute = vi.fn(async () => ({ output: "executed", isError: false }));
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "write_probe",
      description: "Write probe",
      source: "builtin",
      category: "write",
      jsonSchema: { type: "object", properties: {} },
      execute,
    }));
    const requestAndWait = vi.fn();
    const executor = new ToolExecutor(
      registry,
      undefined,
      askingPermissionManager(),
      undefined,
      { requestAndWait } as never,
    );

    const [result] = await executor.executeAll(
      [{ id: "ordinary-ask", name: "write_probe", input: {} }],
      {
        sessionId: "authorization-required",
        permissionContext: userPermissionContext({ approvalSurface: "unavailable" }),
      },
    );

    expect(execute).not.toHaveBeenCalled();
    expect(requestAndWait).not.toHaveBeenCalled();
    expect(result.is_error).toBe(true);
    expect(authorizationRequiredStateOf(result.authorizationRequired)).toEqual({
      kind: "tool",
      toolName: "write_probe",
      source: "builtin",
      category: "write",
      reason: "approval-surface-unavailable",
    });
  });

  it("preserves the desktop approval flow when an interactive surface exists", async () => {
    const execute = vi.fn(async () => ({ output: "executed", isError: false }));
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "interactive_write_probe",
      description: "Interactive write probe",
      source: "builtin",
      category: "write",
      jsonSchema: { type: "object", properties: {} },
      execute,
    }));
    const requestAndWait = vi.fn(async (request: { id: string }) => ({
      requestId: request.id,
      choice: "allow-once" as const,
    }));
    const executor = new ToolExecutor(
      registry,
      undefined,
      askingPermissionManager(),
      undefined,
      { requestAndWait } as never,
    );

    const [result] = await executor.executeAll(
      [{ id: "desktop-ask", name: "interactive_write_probe", input: {} }],
      {
        sessionId: "interactive-approval",
        permissionContext: userPermissionContext({ approvalSurface: "interactive" }),
      },
    );

    expect(requestAndWait).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
    expect(result.content).toBe("executed");
    expect(result.authorizationRequired).toBeUndefined();
  });

  it("does not block an invocation the existing policy already allows", async () => {
    const execute = vi.fn(async () => ({ output: "read completed", isError: false }));
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "read_probe",
      description: "Read probe",
      source: "builtin",
      category: "read",
      jsonSchema: { type: "object", properties: {} },
      isReadOnly: () => true,
      execute,
    }));
    const requestAndWait = vi.fn();
    const executor = new ToolExecutor(
      registry,
      undefined,
      new PermissionManager(join(tempDirectory("lvis-auth-read-"), "permissions.json")),
      undefined,
      { requestAndWait } as never,
    );

    const [result] = await executor.executeAll(
      [{ id: "allowed-read", name: "read_probe", input: {} }],
      {
        sessionId: "allowed-without-surface",
        permissionContext: userPermissionContext({ approvalSurface: "unavailable" }),
      },
    );

    expect(execute).toHaveBeenCalledOnce();
    expect(requestAndWait).not.toHaveBeenCalled();
    expect(result.content).toBe("read completed");
    expect(result.authorizationRequired).toBeUndefined();
  });

  it("still executes an invocation the reviewer automatically allows", async () => {
    const execute = vi.fn(async () => ({ output: "reviewed write", isError: false }));
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "reviewed_write_probe",
      description: "Reviewed write probe",
      source: "builtin",
      category: "write",
      jsonSchema: { type: "object", properties: {} },
      execute,
    }));
    const permissionManager = new PermissionManager(
      join(tempDirectory("lvis-auth-reviewed-"), "permissions.json"),
    );
    permissionManager.setInteractiveAutoApprove("low");
    permissionManager.checkDetailed = () => ({
      decision: "ask",
      reason: "review before execution",
      layer: 5,
      reviewer: {
        route: "foreground-auto",
        verdict: { level: "low", reason: "fixture says low risk" },
      },
    });
    permissionManager.dispatchReviewer = vi.fn(async () => ({
      verdict: { level: "low" as const, reason: "fixture says low risk" },
      outcome: "fresh" as const,
    })) as never;
    const requestAndWait = vi.fn();
    const executor = new ToolExecutor(
      registry,
      undefined,
      permissionManager,
      undefined,
      { requestAndWait } as never,
    );

    const [result] = await executor.executeAll(
      [{ id: "reviewed-allow", name: "reviewed_write_probe", input: {} }],
      {
        sessionId: "reviewed-without-surface",
        permissionContext: userPermissionContext({ approvalSurface: "unavailable" }),
      },
    );

    expect(permissionManager.dispatchReviewer).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
    expect(requestAndWait).not.toHaveBeenCalled();
    expect(result.content).toBe("reviewed write");
    expect(result.authorizationRequired).toBeUndefined();
  });

  it("keeps a completed routine reviewer verdict on the existing deferred denial lane", async () => {
    const execute = vi.fn(async () => ({ output: "executed", isError: false }));
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "reviewed_high_probe",
      description: "High-risk reviewed probe",
      source: "builtin",
      category: "write",
      jsonSchema: { type: "object", properties: {} },
      execute,
    }));
    const permissionDirectory = tempDirectory("lvis-auth-high-review-");
    const permissionManager = new PermissionManager(
      join(permissionDirectory, "permissions.json"),
    );
    permissionManager.setReviewer({
      classifier: {} as never,
      cache: {} as never,
      deferredQueue: new DeferredQueue(join(permissionDirectory, "deferred.jsonl")),
    });
    permissionManager.checkDetailed = () => ({
      decision: "ask",
      reason: "headless review required",
      layer: 5,
      reviewer: {
        route: "headless",
        verdict: { level: "high", reason: "fixture says high risk" },
      },
    });
    permissionManager.dispatchReviewer = vi.fn(async () => ({
      verdict: { level: "high" as const, reason: "fixture says high risk" },
      outcome: "fresh" as const,
    })) as never;
    const executor = new ToolExecutor(registry, undefined, permissionManager);

    const [result] = await executor.executeAll(
      [{ id: "reviewed-high", name: "reviewed_high_probe", input: {} }],
      {
        sessionId: "reviewed-high-without-surface",
        permissionContext: userPermissionContext({
          headless: true,
          approvalSurface: "unavailable",
        }),
      },
    );

    expect(execute).not.toHaveBeenCalled();
    expect(result.is_error).toBe(true);
    expect(result.authorizationRequired).toBeUndefined();
    expect(result.content).not.toContain("Authorization required");
    expect(permissionManager.dispatchReviewer).toHaveBeenCalledOnce();
  });

  it("returns authorization-required for a completed foreground verdict on a windowless host", async () => {
    const execute = vi.fn(async () => ({ output: "executed", isError: false }));
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "foreground_high_probe",
      description: "Foreground high-risk probe",
      source: "builtin",
      category: "write",
      jsonSchema: { type: "object", properties: {} },
      execute,
    }));
    const permissionManager = new PermissionManager(
      join(tempDirectory("lvis-auth-foreground-high-"), "permissions.json"),
    );
    permissionManager.setInteractiveAutoApprove("low");
    permissionManager.checkDetailed = () => ({
      decision: "ask",
      reason: "foreground review required",
      layer: 5,
      reviewer: {
        route: "foreground-auto",
        verdict: { level: "high", reason: "fixture says high risk" },
      },
    });
    permissionManager.dispatchReviewer = vi.fn(async () => ({
      verdict: { level: "high" as const, reason: "fixture says high risk" },
      outcome: "fresh" as const,
    })) as never;
    const executor = new ToolExecutor(registry, undefined, permissionManager);

    const [result] = await executor.executeAll(
      [{ id: "foreground-high", name: "foreground_high_probe", input: {} }],
      {
        sessionId: "foreground-high-without-surface",
        permissionContext: userPermissionContext({ approvalSurface: "unavailable" }),
      },
    );

    expect(execute).not.toHaveBeenCalled();
    expect(authorizationRequiredStateOf(result.authorizationRequired)).toMatchObject({
      kind: "tool",
      toolName: "foreground_high_probe",
      reason: "approval-surface-unavailable",
    });
  });

  it.each([
    "unavailable",
    "error",
    "timeout",
    "malformed",
    "sandbox-state-changed",
  ] satisfies ReviewerDispatchOutcome[])(
    "keeps foreground reviewer %s as an ordinary failure on a windowless host",
    async (outcome) => {
      const execute = vi.fn(async () => ({ output: "executed", isError: false }));
      const registry = new ToolRegistry();
      registry.register(createDynamicTool({
        name: "foreground_reviewer_failure_probe",
        description: "Foreground reviewer failure probe",
        source: "builtin",
        category: "write",
        jsonSchema: { type: "object", properties: {} },
        execute,
      }));
      const permissionManager = new PermissionManager(
        join(tempDirectory(`lvis-auth-foreground-${outcome}-`), "permissions.json"),
      );
      permissionManager.setInteractiveAutoApprove("low");
      permissionManager.checkDetailed = () => ({
        decision: "ask",
        reason: "foreground review required",
        layer: 5,
        reviewer: {
          route: "foreground-auto",
          verdict: { level: "high", reason: "review required" },
        },
      });
      permissionManager.dispatchReviewer = vi.fn(async () => ({
        verdict: { level: "high" as const, reason: `fallback after ${outcome}` },
        outcome,
      })) as never;
      const executor = new ToolExecutor(registry, undefined, permissionManager);
      const permissionReviewEvents: Array<{ status: string; reason?: string }> = [];

      const [result] = await executor.executeAll(
        [{ id: `foreground-${outcome}`, name: "foreground_reviewer_failure_probe", input: {} }],
        {
          sessionId: `foreground-${outcome}-without-surface`,
          permissionContext: userPermissionContext({ approvalSurface: "unavailable" }),
          callbacks: {
            onPermissionReview: (event) => permissionReviewEvents.push(event),
          },
        },
      );

      expect(execute).not.toHaveBeenCalled();
      expect(result.is_error).toBe(true);
      expect(result.authorizationRequired).toBeUndefined();
      expect(result.content).toContain(`foreground reviewer ${outcome}`);
      expect(result.content).not.toContain("Authorization required");
      expect(permissionReviewEvents.map((event) => event.status)).toEqual([
        "reviewing",
        "failed",
      ]);
      expect(permissionReviewEvents.at(-1)?.reason).toContain(
        `foreground reviewer ${outcome}`,
      );
    },
  );

  it.each(["no-reviewer", "timeout"] as const)(
    "keeps a headless reviewer %s as an ordinary policy failure",
    async (failure) => {
      const execute = vi.fn(async () => ({ output: "executed", isError: false }));
      const registry = new ToolRegistry();
      registry.register(createDynamicTool({
        name: "reviewer_failure_probe",
        description: "Reviewer failure probe",
        source: "builtin",
        category: "write",
        jsonSchema: { type: "object", properties: {} },
        execute,
      }));
      const permissionDirectory = tempDirectory(`lvis-auth-${failure}-`);
      const permissionManager = new PermissionManager(
        join(permissionDirectory, "permissions.json"),
      );
      if (failure === "timeout") {
        permissionManager.setReviewer({
          classifier: {} as never,
          cache: {} as never,
          deferredQueue: new DeferredQueue(join(permissionDirectory, "deferred.jsonl")),
        });
        permissionManager.dispatchReviewer = vi.fn(async () => ({
          verdict: { level: "high" as const, reason: "fallback after timeout" },
          outcome: "timeout" as const,
        })) as never;
      }
      permissionManager.checkDetailed = () => ({
        decision: "ask",
        reason: "headless review required",
        layer: 5,
        reviewer: {
          route: "headless",
          verdict: { level: "high", reason: "review required" },
        },
      });
      const executor = new ToolExecutor(registry, undefined, permissionManager);

      const [result] = await executor.executeAll(
        [{ id: `reviewer-${failure}`, name: "reviewer_failure_probe", input: {} }],
        {
          sessionId: `reviewer-${failure}-without-surface`,
          permissionContext: userPermissionContext({
            headless: true,
            approvalSurface: "unavailable",
          }),
        },
      );

      expect(execute).not.toHaveBeenCalled();
      expect(result.is_error).toBe(true);
      expect(result.authorizationRequired).toBeUndefined();
      expect(result.content).not.toContain("Authorization required");
      expect(result.content).toContain("reviewer_failure_probe");
      if (failure === "timeout") {
        expect(result.content).toContain("fallback after timeout");
      }
    },
  );

  it("keeps an ordinary routine ask on the existing headless denial lane", async () => {
    const execute = vi.fn(async () => ({ output: "executed", isError: false }));
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "routine_write_probe",
      description: "Routine write probe",
      source: "builtin",
      category: "write",
      jsonSchema: { type: "object", properties: {} },
      execute,
    }));
    const requestAndWait = vi.fn();
    const executor = new ToolExecutor(
      registry,
      undefined,
      askingPermissionManager(),
      undefined,
      { requestAndWait } as never,
    );

    const [result] = await executor.executeAll(
      [{ id: "routine-ask", name: "routine_write_probe", input: {} }],
      {
        sessionId: "routine-authorization-required",
        permissionContext: userPermissionContext({
          headless: true,
          approvalSurface: "unavailable",
        }),
      },
    );

    expect(execute).not.toHaveBeenCalled();
    expect(requestAndWait).not.toHaveBeenCalled();
    expect(result.is_error).toBe(true);
    expect(result.authorizationRequired).toBeUndefined();
    expect(result.content).not.toContain("Authorization required");
  });

  it("returns a directory authorization control instead of calling a hidden gate", async () => {
    const execute = vi.fn(async () => ({ output: "executed", isError: false }));
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "out_of_scope_write",
      description: "Write outside the workspace",
      source: "builtin",
      category: "write",
      pathFields: ["path"],
      jsonSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      execute,
    }));
    const requestAndWait = vi.fn();
    const permissionDirectory = tempDirectory("lvis-auth-dir-");
    const deferredQueue = new DeferredQueue(join(permissionDirectory, "deferred.jsonl"));
    const permissionManager = new PermissionManager(
      join(permissionDirectory, "permissions.json"),
    );
    permissionManager.setReviewer({
      classifier: {} as never,
      cache: {} as never,
      deferredQueue,
    });
    const executor = new ToolExecutor(
      registry,
      undefined,
      permissionManager,
      undefined,
      { requestAndWait } as never,
    );
    const outside = join(tempDirectory("lvis-auth-outside-"), "secret-command.txt");

    const [result] = await executor.executeAll(
      [{ id: "directory-ask", name: "out_of_scope_write", input: { path: outside } }],
      {
        sessionId: "directory-authorization",
        permissionContext: userPermissionContext({ approvalSurface: "unavailable" }),
      },
    );

    expect(execute).not.toHaveBeenCalled();
    expect(requestAndWait).not.toHaveBeenCalled();
    expect(result.content).not.toContain(outside);
    const terminalState = authorizationRequiredStateOf(result.authorizationRequired);
    expect(terminalState).toMatchObject({
      kind: "directory",
      toolName: "out_of_scope_write",
      reason: "directory-authorization-required",
    });
    const pending = deferredQueue.listPending();
    expect(pending).toHaveLength(1);
    expect(terminalState?.deferredRequestId).toBe(pending[0]?.id);
    expect(pending[0]?.grant).toMatchObject({ kind: "directory" });
    expect(JSON.stringify(terminalState)).not.toContain(outside);
  });

  it("keeps a routine out-of-directory request in the existing deferred denial flow", async () => {
    const execute = vi.fn(async () => ({ output: "executed", isError: false }));
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "routine_out_of_scope_write",
      description: "Routine write outside the workspace",
      source: "builtin",
      category: "write",
      pathFields: ["path"],
      jsonSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      execute,
    }));
    const requestAndWait = vi.fn();
    const permissionDirectory = tempDirectory("lvis-routine-auth-dir-");
    const deferredQueue = new DeferredQueue(join(permissionDirectory, "deferred.jsonl"));
    const permissionManager = new PermissionManager(
      join(permissionDirectory, "permissions.json"),
    );
    permissionManager.setReviewer({
      classifier: {} as never,
      cache: {} as never,
      deferredQueue,
    });
    const executor = new ToolExecutor(
      registry,
      undefined,
      permissionManager,
      undefined,
      { requestAndWait } as never,
    );
    const outside = join(tempDirectory("lvis-routine-auth-outside-"), "output.txt");

    const [result] = await executor.executeAll(
      [{ id: "routine-directory-ask", name: "routine_out_of_scope_write", input: { path: outside } }],
      {
        sessionId: "routine-directory-authorization",
        permissionContext: userPermissionContext({
          headless: true,
          approvalSurface: "unavailable",
        }),
      },
    );

    expect(execute).not.toHaveBeenCalled();
    expect(requestAndWait).not.toHaveBeenCalled();
    expect(result.is_error).toBe(true);
    expect(result.authorizationRequired).toBeUndefined();
    expect(result.content).not.toContain("Authorization required");
    expect(result.content).toContain("deferredId=");
    expect(deferredQueue.listPending()).toHaveLength(1);
  });

  it("returns host authorization for a requested-sandbox plain fallback", async () => {
    setSandboxRequestedAtBoot(true);
    setActiveSandboxCapability({
      kind: "none",
      confidence: "verified",
      platform: process.platform,
      reason: "fixture sandbox unavailable",
    });
    const registry = new ToolRegistry();
    const bash = new BashTool();
    const execute = vi.spyOn(bash, "execute");
    registry.register(bash);
    const requestAndWait = vi.fn();
    const executor = new ToolExecutor(
      registry,
      undefined,
      askingPermissionManager(),
      undefined,
      { requestAndWait } as never,
    );

    const [result] = await executor.executeAll(
      [{
        id: "sandbox-fallback",
        name: "bash",
        input: { command: "printf secret-command", timeoutSeconds: 1 },
      }],
      {
        sessionId: "sandbox-fallback-authorization",
        permissionContext: userPermissionContext({ approvalSurface: "unavailable" }),
      },
    );

    expect(execute).not.toHaveBeenCalled();
    expect(requestAndWait).not.toHaveBeenCalled();
    expect(result.content).not.toContain("secret-command");
    expect(authorizationRequiredStateOf(result.authorizationRequired)).toMatchObject({
      kind: "host-execution",
      toolName: "bash",
      reason: "host-execution-authorization-required",
      executionPlan: {
        fallbackReason: "requested-sandbox-unavailable",
        requiresExplicitUserApproval: true,
      },
    });
  });

  it("keeps a routine requested-sandbox fallback on the existing headless denial lane", async () => {
    setSandboxRequestedAtBoot(true);
    setActiveSandboxCapability({
      kind: "none",
      confidence: "verified",
      platform: process.platform,
      reason: "fixture sandbox unavailable",
    });
    const registry = new ToolRegistry();
    const bash = new BashTool();
    const execute = vi.spyOn(bash, "execute");
    registry.register(bash);
    const requestAndWait = vi.fn();
    const executor = new ToolExecutor(
      registry,
      undefined,
      askingPermissionManager(),
      undefined,
      { requestAndWait } as never,
    );

    const [result] = await executor.executeAll(
      [{
        id: "routine-sandbox-fallback",
        name: "bash",
        input: { command: "printf routine-command", timeoutSeconds: 1 },
      }],
      {
        sessionId: "routine-sandbox-fallback",
        permissionContext: userPermissionContext({
          headless: true,
          approvalSurface: "unavailable",
        }),
      },
    );

    expect(execute).not.toHaveBeenCalled();
    expect(requestAndWait).not.toHaveBeenCalled();
    expect(result.is_error).toBe(true);
    expect(result.authorizationRequired).toBeUndefined();
    expect(result.content).not.toContain("Authorization required");
  });

  it("rejects a structural control lookalike that was not issued by the host", () => {
    const forged = {
      type: "authorization_required",
      state: {
        kind: "tool",
        toolName: "plugin_tool",
        source: "plugin",
        category: "write",
        reason: "approval-surface-unavailable",
      },
    };

    expect(authorizationRequiredStateOf(forged)).toBeUndefined();
  });
});
