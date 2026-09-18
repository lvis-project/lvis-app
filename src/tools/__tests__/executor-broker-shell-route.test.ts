import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import {
  __resetActiveSandboxCapabilityForTest,
  __resetSandboxRequestedAtBootForTest,
  setSandboxRequestedAtBoot,
} from "../../permissions/sandbox-capability.js";
import { ToolExecutor } from "../executor.js";
import { ToolRegistry } from "../registry.js";
import { BashTool } from "../shell-tools.js";

const localSpawn = vi.hoisted(() => vi.fn(() => {
  throw new Error("local spawn forbidden in broker route test");
}));
const hostPrepare = vi.hoisted(() => vi.fn(() => {
  throw new Error("host shell preparation forbidden in broker route test");
}));
const hostPathInspection = vi.hoisted(() => vi.fn(() => {
  throw new Error("host shell path inspection forbidden in broker route test");
}));
const hostToolPathInspection = vi.hoisted(() => vi.fn(() => {
  throw new Error("tool-local host path inspection forbidden in broker route test");
}));
const hostToolCwdValidation = vi.hoisted(() => vi.fn(() => {
  throw new Error("tool-local host cwd validation forbidden in broker route test");
}));
const broker = vi.hoisted(() => ({
  active: true,
  capability: Object.freeze({
    version: "brokered-workload-capability/v1",
    workload: Object.freeze({
      id: "1".repeat(64),
      generation: "executor-broker-1",
      boundaryFingerprint: "2".repeat(64),
      imageDigest: `sha256:${"3".repeat(64)}`,
      cwd: "/app",
      home: "/home/lvis",
      platform: "linux",
    }),
    expiresAt: "2099-01-01T00:00:00.000Z",
    allowedOperations: Object.freeze(["shell.run"]),
  }),
  acquire: vi.fn(),
  execute: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: localSpawn };
});

vi.mock("../prepared-shell-invocation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../prepared-shell-invocation.js")>();
  return { ...actual, prepareShellInvocation: hostPrepare };
});

vi.mock("../pipeline/path-extraction.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../pipeline/path-extraction.js")>();
  return { ...actual, shellPathPolicyViolation: hostPathInspection };
});

vi.mock("../shell-path-policy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shell-path-policy.js")>();
  return {
    ...actual,
    findShellPathPolicyViolation: hostToolPathInspection,
    validateShellWorkingDirectory: hostToolCwdValidation,
  };
});

vi.mock("../../workload/runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../workload/runtime.js")>();
  return {
    ...actual,
    isWorkloadBrokerActive: () => broker.active,
    acquireBrokeredWorkloadCapability: broker.acquire,
    isIssuedActiveBrokeredWorkloadCapability: (value: unknown) =>
      broker.active && value === broker.capability,
    executeBrokeredWorkloadRequest: broker.execute,
  };
});

let root: string;

beforeEach(() => {
  __resetActiveSandboxCapabilityForTest();
  __resetSandboxRequestedAtBootForTest();
  setSandboxRequestedAtBoot(false);
  broker.active = true;
  broker.acquire.mockReset();
  broker.acquire.mockResolvedValue(broker.capability);
  broker.execute.mockReset();
  localSpawn.mockClear();
  hostPrepare.mockClear();
  hostPathInspection.mockClear();
  hostToolPathInspection.mockClear();
  hostToolCwdValidation.mockClear();
  root = mkdtempSync(join(tmpdir(), "lvis-executor-broker-shell-"));
});

afterEach(async () => {
  __resetActiveSandboxCapabilityForTest();
  __resetSandboxRequestedAtBootForTest();
  await cleanupTmpDir(root);
});

describe("executor broker shell route", () => {
  it("authorizes and audits the guest request without host preparation, path inspection, or spawn", async () => {
    const registry = new ToolRegistry();
    registry.register(new BashTool());
    const permissionManager = new PermissionManager(join(root, "permissions.json"));
    permissionManager.checkDetailed = () => ({ decision: "allow", reason: "test", layer: 5 });
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
      permissionManager,
      undefined,
      undefined,
      undefined,
      auditLogger as never,
    );
    broker.execute.mockResolvedValueOnce({
      output: "broker-executed",
      isError: false,
      status: "exited",
      exitCode: 0,
      signal: null,
      timedOut: false,
      cancelled: false,
      oomDelta: 0,
      ownedResourcesZero: true,
      receiptDigest: "4".repeat(64),
    });

    const [result] = await executor.executeAll(
      [{
        id: "tu-broker-guest-shell",
        name: "bash",
        input: {
          command: "printf broker-only > /logs/result",
          cwd: "/git",
          timeoutSeconds: 30,
        },
      }],
      {
        sessionId: "sess-broker-guest-shell",
        executionCwd: root,
        permissionContext: {
          trustOrigin: "llm-tool-arg",
          approvalSurface: "unavailable",
        },
      },
    );

    expect(result).toMatchObject({
      content: "broker-executed",
      executionPlan: { mode: "plain" },
    });
    expect(result?.is_error).toBeUndefined();
    expect(broker.acquire.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(broker.execute).toHaveBeenCalledWith(
      broker.capability,
      "shell.run",
      {
        command: "printf broker-only > /logs/result",
        cwd: "/git",
        timeoutMs: 30_000,
      },
      expect.objectContaining({ operation: "shell.run", toolName: "bash" }),
      expect.any(AbortSignal),
    );
    expect(hostPrepare).not.toHaveBeenCalled();
    expect(hostPathInspection).not.toHaveBeenCalled();
    expect(hostToolPathInspection).not.toHaveBeenCalled();
    expect(hostToolCwdValidation).not.toHaveBeenCalled();
    expect(localSpawn).not.toHaveBeenCalled();
    expect(appendPermissionAuditEntry).toHaveBeenCalledWith(expect.objectContaining({
      toolUseId: "tu-broker-guest-shell",
      executionRoute: expect.objectContaining({
        decision: "selected",
        route: "disposable-container",
        disposableCapability: expect.objectContaining({ kind: "workload-broker" }),
      }),
    }));
  });
});
