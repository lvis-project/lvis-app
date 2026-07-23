import { describe, expect, it, vi } from "vitest";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { ScriptHookManager } from "../../hooks/script-hook-manager.js";
import { runWithInvocationOrigin } from "../../plugins/runtime/origin-chain.js";
import { currentEffectLedger } from "../../permissions/effect-ledger.js";
import { createDynamicTool } from "../base.js";
import { ToolExecutor } from "../executor.js";
import { ToolRegistry } from "../registry.js";

const principal = {
  ownerPluginId: "ep-api",
  ownerVersion: "2.0.0",
  generationId: "gen-2",
  appSessionId: "window-4",
  accountHash: "account-hash",
};

function setup(options: { wireHooks?: boolean } = {}) {
  const read = vi.fn(async () => ({ output: "fresh", isError: false, metadata: { rawResult: { status: "open" } } }));
  const write = vi.fn(async () => ({ output: "saved", isError: false }));
  const directWrite = vi.fn(async () => ({ output: "reserved", isError: false }));
  const registry = new ToolRegistry();
  registry.registerBatch([
    createDynamicTool({
      name: "domain_read",
      description: "read domain state",
      source: "plugin",
      category: "write",
      pluginId: principal.ownerPluginId,
      pluginGeneration: { pluginId: principal.ownerPluginId, generationId: principal.generationId },
      modelVisible: true,
      operationPolicy: {
        discriminant: "operation",
        operations: { status: { kind: "read", minimumRisk: "read", appVisible: true } },
      },
      jsonSchema: { type: "object" },
      execute: read,
    }),
    createDynamicTool({
      name: "domain_write",
      description: "write domain state",
      source: "plugin",
      category: "write",
      pluginId: principal.ownerPluginId,
      pluginGeneration: { pluginId: principal.ownerPluginId, generationId: principal.generationId },
      modelVisible: true,
      operationPolicy: {
        discriminant: "operation",
        operations: {
          save: {
            kind: "write",
            minimumRisk: "network",
            appVisible: true,
            requiresRead: { tool: "domain_read", operations: ["status"], maxAgeMs: 60_000 },
          },
        },
      },
      jsonSchema: { type: "object" },
      execute: write,
    }),
    createDynamicTool({
      name: "direct_write",
      description: "write without an artificial read counterpart",
      source: "plugin",
      category: "write",
      pluginId: principal.ownerPluginId,
      pluginGeneration: { pluginId: principal.ownerPluginId, generationId: principal.generationId },
      modelVisible: true,
      operationPolicy: {
        discriminant: "operation",
        operations: { reserve: { kind: "write", minimumRisk: "network", appVisible: true } },
      },
      jsonSchema: { type: "object" },
      execute: directWrite,
    }),
    createDynamicTool({
      name: "tainted_read",
      description: "read declaration that performs a Host-observed mutation",
      source: "plugin",
      category: "write",
      pluginId: principal.ownerPluginId,
      pluginGeneration: { pluginId: principal.ownerPluginId, generationId: principal.generationId },
      modelVisible: true,
      operationPolicy: {
        discriminant: "operation",
        operations: { status: { kind: "read", minimumRisk: "read", appVisible: true } },
      },
      jsonSchema: { type: "object" },
      execute: async () => {
        currentEffectLedger()?.record({ kind: "config.set", effect: "write", target: "test" });
        return { output: "tainted", isError: false };
      },
    }),
  ]);
  const permissions = new PermissionManager("/tmp/nonexistent-operation-governance.json");
  permissions.checkDetailed = () => ({ decision: "allow", reason: "test", layer: 3 });
  const approvalGate = { requestAndWait: vi.fn(async () => ({ choice: "allow-once" })) };
  const auditLogger = {
    log: vi.fn(),
    logShadow: vi.fn(),
    appendPermissionAuditEntry: vi.fn(async (entry: Record<string, unknown>) => ({
      ...entry,
      prevHash: "test-prev-hash",
    })),
    isPermissionAuditChainReady: vi.fn(() => false),
    isShadowChannelWritable: vi.fn(() => true),
    getPermissionShadowLogFile: vi.fn(() => "/tmp/shadow"),
  };
  const activeGeneration = {
    pluginId: principal.ownerPluginId,
    generationId: principal.generationId,
    state: {},
  };
  const generationAccess = {
    getActive: vi.fn((pluginId: string) =>
      pluginId === principal.ownerPluginId ? activeGeneration : undefined),
    isExactAdmitted: vi.fn(() => true),
    acquire: vi.fn(async () => ({ generation: activeGeneration, release: vi.fn() })),
    acquireExact: vi.fn(async (_pluginId: string, generationId: string) => {
      if (generationId !== principal.generationId) throw new Error("stale test generation");
      return { generation: activeGeneration, release: vi.fn() };
    }),
    runWithLease: vi.fn(async (_lease: unknown, operation: () => Promise<unknown>) => operation()),
  };
  let generationAccessAvailable = true;
  return {
    executor: new ToolExecutor(
      registry,
      undefined,
      permissions,
      undefined,
      approvalGate as never,
      options.wireHooks === false ? undefined : new ScriptHookManager(),
      auditLogger as never,
      undefined,
      undefined,
      undefined,
      undefined,
      () => generationAccessAvailable ? generationAccess as never : undefined,
    ),
    setGenerationAccessAvailable: (available: boolean) => { generationAccessAvailable = available; },
    permissions,
    approvalGate,
    read,
    write,
    directWrite,
    auditLogger,
  };
}

function options(grantToken?: string, principalOverride = principal) {
  return {
    sessionId: "s",
    permissionContext: {
      trustOrigin: "plugin-emitted" as const,
      allowedPluginIds: new Set([principalOverride.ownerPluginId]),
      pluginOperation: { ...principalOverride, grantToken },
    },
  };
}

describe("ToolExecutor plugin operation governance", () => {
  it("requires a fresh read and consumes one app-write grant exactly once", async () => {
    const { executor, read, write, auditLogger } = setup();
    const readResult = await runWithInvocationOrigin("ui", undefined, () =>
      executor.executeAll([{ id: "r", name: "domain_read", input: { operation: "status" } }], options()),
    );
    expect(readResult[0].is_error).toBeFalsy();
    expect(read).toHaveBeenCalledTimes(1);

    const grant = executor.issuePluginOperationGrant({
      toolName: "domain_write",
      input: { operation: "save", value: 1 },
      principal,
    });
    const first = await runWithInvocationOrigin("ui", undefined, () =>
      executor.executeAll([{ id: "w1", name: "domain_write", input: { operation: "save", value: 1 } }], options(grant.token)),
    );
    expect(first[0].is_error).toBeFalsy();
    expect(write).toHaveBeenCalledTimes(1);

    const replay = await runWithInvocationOrigin("ui", undefined, () =>
      executor.executeAll([{ id: "w2", name: "domain_write", input: { operation: "save", value: 1 } }], options(grant.token)),
    );
    expect(replay[0].is_error).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
    expect(auditLogger.appendPermissionAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "allow",
        pluginOperation: expect.objectContaining({ outcome: "consumed" }),
      }),
    );
    expect(auditLogger.appendPermissionAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "deny",
        pluginOperation: expect.objectContaining({ outcome: "rejected" }),
      }),
    );
  });

  it("atomically burns one read at grant issuance and requires a fresh read before the next write", async () => {
    const { executor, write } = setup();
    await runWithInvocationOrigin("ui", undefined, () =>
      executor.executeAll(
        [{ id: "r1", name: "domain_read", input: { operation: "status" } }],
        options(),
      ),
    );
    const grantArgs = {
      toolName: "domain_write",
      input: { operation: "save", value: 7 },
      principal,
    };
    const firstInspection = executor.inspectPluginOperationGrant(grantArgs);
    const secondInspection = executor.inspectPluginOperationGrant(grantArgs);
    const issue = (inspected: typeof firstInspection) =>
      executor.issueInspectedPluginOperationGrant({
        toolName: grantArgs.toolName,
        principal,
        inspected,
      });

    const issued = await Promise.allSettled([
      Promise.resolve().then(() => issue(firstInspection)),
      Promise.resolve().then(() => issue(secondInspection)),
    ]);
    const granted = issued.find(
      (result): result is PromiseFulfilledResult<ReturnType<typeof issue>> =>
        result.status === "fulfilled",
    );
    expect(granted).toBeDefined();
    expect(issued.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(issued.filter((result) => result.status === "rejected")).toHaveLength(1);

    const [firstWrite] = await runWithInvocationOrigin("ui", undefined, () =>
      executor.executeAll(
        [{ id: "w1", name: "domain_write", input: { operation: "save", value: 7 } }],
        options(granted!.value.token),
      ),
    );
    expect(firstWrite.is_error).toBeFalsy();
    expect(write).toHaveBeenCalledTimes(1);
    expect(() => executor.issuePluginOperationGrant(grantArgs))
      .toThrow(/required read is missing or stale/);

    await runWithInvocationOrigin("ui", undefined, () =>
      executor.executeAll(
        [{ id: "r2", name: "domain_read", input: { operation: "status" } }],
        options(),
      ),
    );
    const secondGrant = executor.issuePluginOperationGrant(grantArgs);
    const [secondWrite] = await runWithInvocationOrigin("ui", undefined, () =>
      executor.executeAll(
        [{ id: "w2", name: "domain_write", input: { operation: "save", value: 7 } }],
        options(secondGrant.token),
      ),
    );
    expect(secondWrite.is_error).toBeFalsy();
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("default-denies missing, unknown and app-disallowed operations before dispatch", async () => {
    const { executor, read } = setup();
    for (const input of [{}, { operation: "unknown" }]) {
      const [result] = await runWithInvocationOrigin("ui", undefined, () =>
        executor.executeAll([{ id: "x", name: "domain_read", input }], options()),
      );
      expect(result.is_error).toBe(true);
    }
    expect(read).not.toHaveBeenCalled();
  });

  it("uses a pre-issued grant instead of the ordinary ask without bypassing final consume", async () => {
    const { executor, permissions, approvalGate, write } = setup();
    await runWithInvocationOrigin("ui", undefined, () =>
      executor.executeAll([{ id: "r", name: "domain_read", input: { operation: "status" } }], options()),
    );
    const grant = executor.issuePluginOperationGrant({
      toolName: "domain_write",
      input: { operation: "save", value: 2 },
      principal,
    });
    permissions.checkDetailed = () => ({ decision: "ask", reason: "ordinary write ask", layer: 6 });
    const [result] = await runWithInvocationOrigin("ui", undefined, () =>
      executor.executeAll([{ id: "w", name: "domain_write", input: { operation: "save", value: 2 } }], options(grant.token)),
    );
    expect(result.is_error).toBeFalsy();
    expect(approvalGate.requestAndWait).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("requires and consumes a one-shot grant for writes without an artificial read", async () => {
    const { executor, permissions, approvalGate, directWrite } = setup();
    const grant = executor.issuePluginOperationGrant({
      toolName: "direct_write",
      input: { operation: "reserve", target: "room-1" },
      principal,
    });
    expect(grant.readRevision).toBeNull();

    permissions.checkDetailed = () => ({ decision: "ask", reason: "ordinary write ask", layer: 6 });
    const [forged] = await runWithInvocationOrigin("ui", undefined, () =>
      executor.executeAll(
        [{ id: "forged", name: "direct_write", input: { operation: "reserve", target: "room-1" } }],
        options("forged-token"),
      ),
    );
    expect(forged.is_error).toBe(true);
    expect(approvalGate.requestAndWait).not.toHaveBeenCalled();
    expect(directWrite).not.toHaveBeenCalled();

    const [first] = await runWithInvocationOrigin("ui", undefined, () =>
      executor.executeAll(
        [{ id: "first", name: "direct_write", input: { operation: "reserve", target: "room-1" } }],
        options(grant.token),
      ),
    );
    expect(first.is_error).toBeFalsy();
    expect(directWrite).toHaveBeenCalledTimes(1);

    const [replay] = await runWithInvocationOrigin("ui", undefined, () =>
      executor.executeAll(
        [{ id: "replay", name: "direct_write", input: { operation: "reserve", target: "room-1" } }],
        options(grant.token),
      ),
    );
    expect(replay.is_error).toBe(true);
    expect(directWrite).toHaveBeenCalledTimes(1);
  });

  it("fails closed when an app write without a read prerequisite has no grant", async () => {
    const { executor, directWrite } = setup();
    const [result] = await runWithInvocationOrigin("ui", undefined, () =>
      executor.executeAll(
        [{ id: "missing", name: "direct_write", input: { operation: "reserve" } }],
        options(),
      ),
    );
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("operation grant missing");
    expect(directWrite).not.toHaveBeenCalled();
  });

  it("does not mint a read receipt from a self-declared read that mutates", async () => {
    const { executor } = setup();
    const [result] = await runWithInvocationOrigin("ui", undefined, () =>
      executor.executeAll([{ id: "r", name: "tainted_read", input: { operation: "status" } }], options()),
    );
    expect(result.is_error).toBeFalsy();
    expect(() => executor.issuePluginOperationGrant({
      toolName: "domain_write",
      input: { operation: "save", value: 1 },
      principal,
    })).toThrow(/required read is missing or stale/);
  });

  it("binds an MCP-App grant to its Host session and burns it on a cross-session attempt", async () => {
    const { executor, write } = setup();
    await runWithInvocationOrigin("mcp-app", undefined, () =>
      executor.executeAll([{ id: "r", name: "domain_read", input: { operation: "status" } }], options()),
    );
    const grant = executor.issuePluginOperationGrant({
      toolName: "domain_write",
      input: { operation: "save", value: 3 },
      principal,
      origin: "mcp-app",
    });
    const otherSession = { ...principal, appSessionId: "window-foreign" };
    await runWithInvocationOrigin("mcp-app", undefined, () =>
      executor.executeAll(
        [{ id: "r-other", name: "domain_read", input: { operation: "status" } }],
        options(undefined, otherSession),
      ),
    );
    const [mismatch] = await runWithInvocationOrigin("mcp-app", undefined, () =>
      executor.executeAll(
        [{ id: "w1", name: "domain_write", input: { operation: "save", value: 3 } }],
        options(grant.token, otherSession),
      ),
    );
    expect(mismatch.is_error).toBe(true);

    const [burned] = await runWithInvocationOrigin("mcp-app", undefined, () =>
      executor.executeAll(
        [{ id: "w2", name: "domain_write", input: { operation: "save", value: 3 } }],
        options(grant.token),
      ),
    );
    expect(burned.is_error).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });

  it("keeps governed input, result, bearer, and account identity out of audit rows", async () => {
    const { executor, auditLogger } = setup();
    await runWithInvocationOrigin("ui", undefined, () =>
      executor.executeAll([{
        id: "r",
        name: "domain_read",
        input: { operation: "status", employeeName: "Sensitive Person" },
      }], options("bearer-must-not-log")),
    );
    const serialized = JSON.stringify(auditLogger.log.mock.calls);
    expect(serialized).toContain("status");
    expect(serialized).not.toContain("Sensitive Person");
    expect(serialized).not.toContain("bearer-must-not-log");
    expect(serialized).not.toContain(principal.accountHash);
    expect(serialized).not.toContain("fresh");
  });

  it("refuses to mint a grant when exact generation access becomes unavailable", async () => {
    const { executor, setGenerationAccessAvailable } = setup();
    await runWithInvocationOrigin("ui", undefined, () =>
      executor.executeAll([{ id: "r", name: "domain_read", input: { operation: "status" } }], options()),
    );
    setGenerationAccessAvailable(false);

    expect(() => executor.issuePluginOperationGrant({
      toolName: "domain_write",
      input: { operation: "save", value: 9 },
      principal,
    })).toThrow(/generation access is not wired/);
  });

  it("fails closed for a generation-owned tool when the script Hook manager is not wired", async () => {
    const { executor, read } = setup({ wireHooks: false });
    await expect(runWithInvocationOrigin("ui", undefined, () =>
      executor.executeAll([{ id: "r", name: "domain_read", input: { operation: "status" } }], options()),
    )).rejects.toThrow(/script Hook manager is not wired/);

    expect(read).not.toHaveBeenCalled();
  });
});
