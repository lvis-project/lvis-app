import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import {
  __resetActiveSandboxCapabilityForTest,
  __resetSandboxRequestedAtBootForTest,
  setSandboxRequestedAtBoot,
} from "../../permissions/sandbox-capability.js";
import { ToolExecutor } from "../executor.js";
import type { ToolCallMeta } from "../executor-contract.js";
import { ToolRegistry } from "../registry.js";
import { BashTool } from "../shell-tools.js";
import { BashAstValidator } from "../../main/bash-ast-validator.js";
import type { OperatorContainerCapability } from "../../permissions/operator-container-attestation.js";

const operatorHarness = vi.hoisted(() => ({
  current: null as object | null,
  issued: new WeakSet<object>(),
  leases: new WeakMap<object, object>(),
  consumedLeases: new WeakSet<object>(),
  consumeCount: 0,
  acquireCount: 0,
  failAfter: Number.POSITIVE_INFINITY,
}));

vi.mock("../../permissions/operator-container-attestation.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../permissions/operator-container-attestation.js")
  >();
  return {
    ...actual,
    acquirePublishedOperatorContainerCapabilityForGrant: async () => {
      operatorHarness.acquireCount += 1;
      if (operatorHarness.acquireCount > operatorHarness.failAfter) {
        throw new Error("operator-container-attestation:capability-process-changed");
      }
      if (operatorHarness.current === null) return null;
      const capability = operatorHarness.current;
      const revalidationLease = Object.freeze({
        version: "operator-container-revalidation-lease/v1",
        capabilityId: (capability as OperatorContainerCapability).id,
        capabilityGeneration: (capability as OperatorContainerCapability).generation,
      });
      operatorHarness.leases.set(revalidationLease, capability);
      return Object.freeze({ capability, revalidationLease });
    },
    isIssuedOperatorContainerCapability: (value: unknown) =>
      typeof value === "object" && value !== null && operatorHarness.issued.has(value),
    isCurrentPublishedOperatorContainerCapability: (value: unknown) =>
      value === operatorHarness.current &&
      typeof value === "object" && value !== null && operatorHarness.issued.has(value),
    consumeOperatorContainerRevalidationLease: (capability: object, lease: object) => {
      if (capability !== operatorHarness.current ||
          operatorHarness.leases.get(lease) !== capability ||
          operatorHarness.consumedLeases.has(lease)) return false;
      operatorHarness.consumedLeases.add(lease);
      operatorHarness.consumeCount += 1;
      return true;
    },
  };
});

function activateDisposableCapability(): OperatorContainerCapability {
  const capability = Object.freeze({
    version: "operator-container-capability/v1" as const,
    id: "a".repeat(64),
    generation: "operator-generation-1",
    expiresAt: 1,
    fingerprints: Object.freeze({
      attestation: "b".repeat(64),
      process: "c".repeat(64),
      key: "d".repeat(64),
    }),
  });
  operatorHarness.current = capability;
  operatorHarness.issued.add(capability);
  operatorHarness.acquireCount = 0;
  operatorHarness.consumeCount = 0;
  operatorHarness.failAfter = Number.POSITIVE_INFINITY;
  return capability;
}

afterEach(() => {
  operatorHarness.current = null;
  operatorHarness.acquireCount = 0;
  operatorHarness.consumeCount = 0;
  operatorHarness.failAfter = Number.POSITIVE_INFINITY;
  __resetActiveSandboxCapabilityForTest();
  __resetSandboxRequestedAtBootForTest();
});

function makeExecutor(
  dir: string,
  bashAstValidator?: BashAstValidator,
  scriptHookManager?: object,
): { executor: ToolExecutor; appendPermissionAuditEntry: ReturnType<typeof vi.fn> } {
  const registry = new ToolRegistry();
  registry.register(new BashTool());
  const permissions = new PermissionManager(join(dir, "permissions.json"));
  permissions.checkDetailed = () => ({ decision: "allow", reason: "test", layer: 5 });
  const appendPermissionAuditEntry = vi.fn();
  const auditLogger = {
    log: vi.fn(),
    isPermissionAuditChainReady: () => true,
    assertPermissionAuditWritable: vi.fn(),
    appendPermissionAuditEntry,
  };
  return {
    executor: new ToolExecutor(
      registry,
      undefined,
      permissions,
      bashAstValidator,
      undefined,
      scriptHookManager as never,
      auditLogger as never,
    ),
    appendPermissionAuditEntry,
  };
}

describe("execution route shadow metadata", () => {
  it("keeps the existing dynamic-path denial while refusing automatic host selection", async () => {
    __resetActiveSandboxCapabilityForTest();
    setSandboxRequestedAtBoot(false);
    const dir = mkdtempSync(join(tmpdir(), "lvis-execution-route-shadow-"));
    try {
      const registry = new ToolRegistry();
      registry.register(new BashTool());
      const permissions = new PermissionManager(join(dir, "permissions.json"));
      permissions.checkDetailed = () => ({ decision: "allow", reason: "test", layer: 5 });
      const appendPermissionAuditEntry = vi.fn();
      const auditLogger = {
        log: vi.fn(),
        isPermissionAuditChainReady: () => true,
        assertPermissionAuditWritable: vi.fn(),
        appendPermissionAuditEntry,
      };
      const executor = new ToolExecutor(
        registry,
        undefined,
        permissions,
        undefined,
        undefined,
        undefined,
        auditLogger as never,
      );
      const onToolEnd = vi.fn<(
        name: string,
        result: string,
        isError: boolean,
        meta: ToolCallMeta,
      ) => void>();

      const [result] = await executor.executeAll(
        [{ id: "tu-route-shadow", name: "bash", input: {
          command: "cat $UNRESOLVED_FILE",
          // Both are valid under the existing shell contract. The shadow
          // layer must use resolved cwd and preserve the seconds value rather
          // than introducing a narrower millisecond safe-integer check.
          cwd: "",
          timeoutSeconds: Number.MAX_SAFE_INTEGER,
        } }],
        {
          sessionId: "sess-route-shadow",
          permissionContext: { trustOrigin: "llm-tool-arg" },
          callbacks: { onToolEnd },
        },
      );

      expect(result).toMatchObject({
        is_error: true,
        executionPlan: { mode: "plain" },
      });
      expect(result.content).toContain("shell-path-policy/dynamic-path");
      expect(onToolEnd).toHaveBeenCalledOnce();
      expect(appendPermissionAuditEntry).toHaveBeenCalledWith(expect.objectContaining({
        toolUseId: "tu-route-shadow",
        executionRoute: expect.objectContaining({
          decision: "analysis-required",
          route: null,
          fallback: "analysis-uncertain",
          cwd: process.cwd(),
          runtimeLimits: {
            timeoutSeconds: Number.MAX_SAFE_INTEGER,
            background: false,
          },
          unresolvedRequirements: [{
            classification: "analysis-uncertain",
            source: "shell-path-policy",
            kind: "dynamic-path",
          }],
        }),
      }));
    } finally {
      await cleanupTmpDir(dir);
    }
  });

  it("executes recursive work in the verified disposable guest and records the consumed route", async () => {
    __resetActiveSandboxCapabilityForTest();
    setSandboxRequestedAtBoot(false);
    activateDisposableCapability();
    const dir = mkdtempSync(join(tmpdir(), "lvis-execution-route-disposable-"));
    try {
      const { executor, appendPermissionAuditEntry } = makeExecutor(dir);
      const [result] = await executor.executeAll(
        [{
          id: "tu-route-disposable",
          name: "bash",
          input: {
            command: "mkdir source && printf ok > source/input && cp -r source copied",
            timeoutSeconds: 30,
          },
        }],
        {
          sessionId: "sess-route-disposable",
          executionCwd: dir,
          permissionContext: {
            trustOrigin: "llm-tool-arg",
            approvalSurface: "unavailable",
          },
        },
      );

      expect(result?.is_error).toBeUndefined();
      expect(result?.content).not.toContain("recursive-traversal");
      expect(operatorHarness.acquireCount).toBeGreaterThanOrEqual(2);
      expect(operatorHarness.consumeCount).toBe(1);
      expect(appendPermissionAuditEntry).toHaveBeenCalledWith(expect.objectContaining({
        executionRoute: expect.objectContaining({
          decision: "selected",
          route: "disposable-container",
          unresolvedRequirements: [{
            classification: "analysis-uncertain",
            source: "shell-path-policy",
            kind: "recursive-traversal",
          }],
        }),
      }));
    } finally {
      await cleanupTmpDir(dir);
    }
  });

  it("executes an unresolved path only after the disposable route consumes live authority", async () => {
    __resetActiveSandboxCapabilityForTest();
    setSandboxRequestedAtBoot(false);
    activateDisposableCapability();
    const dir = mkdtempSync(join(tmpdir(), "lvis-execution-route-dynamic-"));
    try {
      const { executor, appendPermissionAuditEntry } = makeExecutor(dir);
      const [result] = await executor.executeAll(
        [{
          id: "tu-route-dynamic",
          name: "bash",
          input: { command: "test ! -e \"$(printf missing-file)\"", timeoutSeconds: 30 },
        }],
        {
          sessionId: "sess-route-dynamic",
          executionCwd: dir,
          permissionContext: { trustOrigin: "llm-tool-arg" },
        },
      );

      expect(result?.is_error).toBeUndefined();
      expect(appendPermissionAuditEntry).toHaveBeenCalledWith(expect.objectContaining({
        executionRoute: expect.objectContaining({
          route: "disposable-container",
          unresolvedRequirements: [expect.objectContaining({ kind: "dynamic-path" })],
        }),
      }));
    } finally {
      await cleanupTmpDir(dir);
    }
  });

  it("uses guest confinement instead of requesting an unavailable host directory grant", async () => {
    __resetActiveSandboxCapabilityForTest();
    setSandboxRequestedAtBoot(false);
    activateDisposableCapability();
    const workspace = mkdtempSync(join(tmpdir(), "lvis-execution-route-workspace-"));
    const outside = mkdtempSync(join(tmpdir(), "lvis-execution-route-outside-"));
    const marker = join(outside, "written-in-guest");
    try {
      const { executor, appendPermissionAuditEntry } = makeExecutor(workspace);
      const [result] = await executor.executeAll(
        [{
          id: "tu-route-boundary",
          name: "bash",
          input: { command: `printf boundary-ok > ${JSON.stringify(marker)}` },
        }],
        {
          sessionId: "sess-route-boundary",
          executionCwd: workspace,
          permissionContext: {
            trustOrigin: "llm-tool-arg",
            approvalSurface: "unavailable",
          },
        },
      );

      expect(result?.is_error).toBeUndefined();
      expect(existsSync(marker)).toBe(true);
      expect(appendPermissionAuditEntry).toHaveBeenCalledWith(expect.objectContaining({
        executionRoute: expect.objectContaining({
          decision: "selected",
          route: "disposable-container",
        }),
      }));
    } finally {
      await cleanupTmpDir(workspace);
      await cleanupTmpDir(outside);
    }
  });

  it("keeps an explicit-host request inside the disposable guest without requiring a desktop", async () => {
    __resetActiveSandboxCapabilityForTest();
    setSandboxRequestedAtBoot(false);
    activateDisposableCapability();
    const dir = mkdtempSync(join(tmpdir(), "lvis-execution-route-explicit-"));
    try {
      const { executor } = makeExecutor(dir);
      const [result] = await executor.executeAll(
        [{
          id: "tu-route-explicit",
          name: "bash",
          input: {
            command: "printf explicit-ok",
            executionMode: "host",
            justification: "exercise the strongest reachable execution substrate",
          },
        }],
        {
          sessionId: "sess-route-explicit",
          executionCwd: dir,
          permissionContext: { trustOrigin: "llm-tool-arg", headless: true },
        },
      );

      expect(result).toMatchObject({ content: "explicit-ok" });
      expect(result?.is_error).toBeUndefined();
    } finally {
      await cleanupTmpDir(dir);
    }
  });

  it("fails closed when the disposable process changes before final route issuance", async () => {
    __resetActiveSandboxCapabilityForTest();
    setSandboxRequestedAtBoot(false);
    activateDisposableCapability();
    operatorHarness.failAfter = 1;
    const dir = mkdtempSync(join(tmpdir(), "lvis-execution-route-changed-"));
    const marker = join(dir, "must-not-exist");
    try {
      const { executor } = makeExecutor(dir);
      const [result] = await executor.executeAll(
        [{
          id: "tu-route-changed",
          name: "bash",
          input: { command: `printf no > ${JSON.stringify(marker)}` },
        }],
        {
          sessionId: "sess-route-changed",
          executionCwd: dir,
          permissionContext: { trustOrigin: "llm-tool-arg" },
        },
      );

      expect(result).toMatchObject({ is_error: true });
      expect(result?.content).toContain("capability-process-changed");
      expect(existsSync(marker)).toBe(false);
    } finally {
      await cleanupTmpDir(dir);
    }
  });

  it("revalidates after a delayed PreToolUse hook and blocks a changed process before spawn", async () => {
    __resetActiveSandboxCapabilityForTest();
    setSandboxRequestedAtBoot(false);
    activateDisposableCapability();
    const dir = mkdtempSync(join(tmpdir(), "lvis-execution-route-post-hook-change-"));
    const marker = join(dir, "copied", "input");
    const scriptHookManager = {
      runPreToolUse: vi.fn(async () => {
        await Promise.resolve();
        operatorHarness.failAfter = operatorHarness.acquireCount;
        return { decision: "allow" as const, reason: "test hook completed", results: [] };
      }),
      runPostToolUse: vi.fn(async () => ({
        decision: "allow" as const,
        reason: "noop",
        results: [],
      })),
      runPermissionRequest: vi.fn(async () => ({
        decision: "allow" as const,
        reason: "noop",
        results: [],
      })),
    };
    try {
      const { executor } = makeExecutor(dir, undefined, scriptHookManager);
      const [result] = await executor.executeAll(
        [{
          id: "tu-route-post-hook-change",
          name: "bash",
          input: {
            command: "mkdir source && printf no > source/input && cp -r source copied",
          },
        }],
        {
          sessionId: "sess-route-post-hook-change",
          executionCwd: dir,
          permissionContext: { trustOrigin: "llm-tool-arg" },
        },
      );

      expect(scriptHookManager.runPreToolUse).toHaveBeenCalledOnce();
      expect(result).toMatchObject({ is_error: true });
      expect(result?.content).toContain("capability-process-changed");
      expect(operatorHarness.consumeCount).toBe(0);
      expect(existsSync(marker)).toBe(false);
    } finally {
      await cleanupTmpDir(dir);
    }
  });

  it("retains structural syntax rejection inside a disposable guest", async () => {
    __resetActiveSandboxCapabilityForTest();
    setSandboxRequestedAtBoot(false);
    activateDisposableCapability();
    const dir = mkdtempSync(join(tmpdir(), "lvis-execution-route-structural-"));
    try {
      const { executor } = makeExecutor(dir, new BashAstValidator({ mode: "deny" }));
      const [result] = await executor.executeAll(
        [{
          id: "tu-route-structural",
          name: "bash",
          input: { command: "printf ok | $UNRESOLVED_PROGRAM" },
        }],
        {
          sessionId: "sess-route-structural",
          executionCwd: dir,
          permissionContext: { trustOrigin: "llm-tool-arg" },
        },
      );

      expect(result).toMatchObject({ is_error: true });
      expect(result?.content).toContain("bash-ast/");
    } finally {
      await cleanupTmpDir(dir);
    }
  });

  it.each([
    ["LVIS secret directory", "cat ~/.lvis/secrets/provider.key"],
    ["legacy secret file", "cat ./lvis-secrets.json"],
  ])("keeps %s behind the sensitive-path hard block in a disposable guest", async (_label, command) => {
    __resetActiveSandboxCapabilityForTest();
    setSandboxRequestedAtBoot(false);
    activateDisposableCapability();
    const dir = mkdtempSync(join(tmpdir(), "lvis-execution-route-sensitive-"));
    try {
      const { executor } = makeExecutor(dir);
      const [result] = await executor.executeAll(
        [{ id: "tu-route-sensitive", name: "bash", input: { command } }],
        {
          sessionId: "sess-route-sensitive",
          executionCwd: dir,
          permissionContext: { trustOrigin: "llm-tool-arg", approvalSurface: "unavailable" },
        },
      );

      expect(result).toMatchObject({ is_error: true });
      expect(result?.content).toContain("shell-path-policy/sensitive-path");
    } finally {
      await cleanupTmpDir(dir);
    }
  });

  it("does not reach a control-plane-like path when the process is not a qualified v1 guest", async () => {
    __resetActiveSandboxCapabilityForTest();
    setSandboxRequestedAtBoot(false);
    const marker = "/logs/lvis-control-route-test";
    expect(existsSync(marker)).toBe(false);
    const dir = mkdtempSync(join(tmpdir(), "lvis-execution-route-unqualified-"));
    try {
      const { executor } = makeExecutor(dir);
      const [result] = await executor.executeAll(
        [{ id: "tu-route-unqualified", name: "bash", input: {
          command: `printf blocked > ${marker}`,
        } }],
        {
          sessionId: "sess-route-unqualified",
          executionCwd: dir,
          permissionContext: { trustOrigin: "llm-tool-arg", approvalSurface: "unavailable" },
        },
      );

      expect(result).toMatchObject({ is_error: true });
      expect(existsSync(marker)).toBe(false);
    } finally {
      await cleanupTmpDir(dir);
    }
  });
});
