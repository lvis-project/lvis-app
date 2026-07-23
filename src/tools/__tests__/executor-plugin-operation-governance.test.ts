import { describe, expect, it, vi } from "vitest";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { runWithInvocationOrigin } from "../../plugins/runtime/origin-chain.js";
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

function setup() {
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
      modelVisible: true,
      operationGovernance: {
        discriminant: "operation",
        appAllowed: ["status"],
        operations: { status: { kind: "read", minimumRisk: "read" } },
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
      modelVisible: true,
      operationGovernance: {
        discriminant: "operation",
        appAllowed: ["save"],
        operations: {
          save: {
            kind: "write",
            minimumRisk: "network",
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
      modelVisible: true,
      operationGovernance: {
        discriminant: "operation",
        appAllowed: ["reserve"],
        operations: { reserve: { kind: "write", minimumRisk: "network" } },
      },
      jsonSchema: { type: "object" },
      execute: directWrite,
    }),
  ]);
  const permissions = new PermissionManager("/tmp/nonexistent-operation-governance.json");
  permissions.checkDetailed = () => ({ decision: "allow", reason: "test", layer: 3 });
  const approvalGate = { requestAndWait: vi.fn(async () => ({ choice: "allow-once" })) };
  const auditLogger = {
    log: vi.fn(),
    logShadow: vi.fn(),
    isPermissionAuditChainReady: vi.fn(() => false),
    isShadowChannelWritable: vi.fn(() => true),
    getPermissionShadowLogFile: vi.fn(() => "/tmp/shadow"),
  };
  return {
    executor: new ToolExecutor(
      registry,
      undefined,
      permissions,
      undefined,
      approvalGate as never,
      undefined,
      auditLogger as never,
    ),
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
    const { executor, read, write } = setup();
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

  it("keeps no-read writes on ordinary approval and ignores forged grant tokens", async () => {
    const { executor, permissions, approvalGate, directWrite } = setup();
    permissions.checkDetailed = () => ({ decision: "ask", reason: "ordinary write ask", layer: 6 });
    const [result] = await runWithInvocationOrigin("ui", undefined, () =>
      executor.executeAll(
        [{ id: "w", name: "direct_write", input: { operation: "reserve" } }],
        options("forged-token"),
      ),
    );
    expect(result.is_error).toBeFalsy();
    expect(approvalGate.requestAndWait).toHaveBeenCalledTimes(1);
    expect(directWrite).toHaveBeenCalledTimes(1);
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
});
