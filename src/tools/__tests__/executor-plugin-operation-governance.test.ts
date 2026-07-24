import { describe, expect, it, vi } from "vitest";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { PluginOperationGrantCoordinator } from "../../permissions/plugin-operation-grant.js";
import { ScriptHookManager } from "../../hooks/script-hook-manager.js";
import { runWithInvocationOrigin } from "../../plugins/runtime/origin-chain.js";
import { currentEffectLedger } from "../../permissions/effect-ledger.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
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

function setup(options: {
  wireHooks?: boolean;
  provideModelIdentity?: boolean;
  readRawResult?: unknown;
  omitReadRawResult?: boolean;
  useReadResultStatusContract?: boolean;
} = {}) {
  const configuredRawResult = Object.prototype.hasOwnProperty.call(
    options,
    "readRawResult",
  )
    ? options.readRawResult
    : {
        operation: "status",
        status: "success",
        data: { state: "open" },
        providerEvidence: {},
        warnings: [],
      };
  const read = vi.fn(async () => ({
    output: "fresh",
    isError: false,
    ...(options.omitReadRawResult
      ? {}
      : { metadata: { rawResult: configuredRawResult } }),
  }));
  const write = vi.fn(async () => ({ output: "saved", isError: false }));
  const directWrite = vi.fn(async () => ({ output: "reserved", isError: false }));
  const taintedRead = vi.fn(async () => {
    currentEffectLedger()?.record({ kind: "config.set", effect: "write", target: "test" });
    return { output: "tainted", isError: false };
  });
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
        operations: {
          status: {
            kind: "read",
            minimumRisk: "read",
            appVisible: true,
            ...(options.useReadResultStatusContract === false
              ? {}
              : { successfulResultStatuses: ["success"] }),
          },
        },
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
      execute: taintedRead,
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
  const pluginOperationGrants = new PluginOperationGrantCoordinator();
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
      pluginOperationGrants,
      () => generationAccessAvailable ? generationAccess as never : undefined,
      options.provideModelIdentity
        ? (_tool, sessionId) => ({
            ownerVersion: principal.ownerVersion,
            generationId: principal.generationId,
            appSessionId: sessionId ?? "model-session",
            accountHash: principal.accountHash,
            appGrantRequired: false,
          })
        : undefined,
    ),
    setGenerationAccessAvailable: (available: boolean) => { generationAccessAvailable = available; },
    permissions,
    approvalGate,
    read,
    write,
    directWrite,
    taintedRead,
    auditLogger,
    pluginOperationGrants,
  };
}

function options(
  grantToken?: string,
  principalOverride = principal,
  appGrantRequired = true,
) {
  return {
    sessionId: "s",
    permissionContext: {
      trustOrigin: "plugin-emitted" as const,
      allowedPluginIds: new Set([principalOverride.ownerPluginId]),
      pluginOperation: {
        ...principalOverride,
        appGrantRequired,
        grantToken,
      },
    },
  };
}

describe("ToolExecutor plugin operation governance", () => {
  it.each(["error", "degraded", "uncertain"])(
    "does not mint freshness from a declared non-success read status=%s",
    async (status) => {
      const { executor, read } = setup({
        readRawResult: {
          status,
        },
      });
      const [readResult] = await runWithInvocationOrigin("ui", undefined, () =>
        executor.executeAll(
          [{ id: "r", name: "domain_read", input: { operation: "status" } }],
          options(),
        ),
      );
      expect(readResult.is_error).toBeFalsy();
      expect(read).toHaveBeenCalledTimes(1);
      expect(() => executor.issuePluginOperationGrant({
        toolName: "domain_write",
        input: { operation: "save", value: 1 },
        principal,
      })).toThrow(/required read is missing or stale/);
    },
  );

  it.each([
    { label: "absent", options: { omitReadRawResult: true } },
    { label: "undefined", options: { readRawResult: undefined } },
    { label: "null", options: { readRawResult: null } },
    { label: "non-object", options: { readRawResult: "success" } },
    { label: "missing status", options: { readRawResult: { data: "fresh" } } },
  ])(
    "fails closed when a declared read result status is $label",
    async ({ options: setupOptions }) => {
      const { executor } = setup(setupOptions);
      const [readResult] = await runWithInvocationOrigin("ui", undefined, () =>
        executor.executeAll(
          [{ id: "r", name: "domain_read", input: { operation: "status" } }],
          options(),
        ),
      );
      expect(readResult.is_error).toBeFalsy();
      expect(() => executor.issuePluginOperationGrant({
        toolName: "domain_write",
        input: { operation: "save", value: 1 },
        principal,
      })).toThrow(/required read is missing or stale/);
    },
  );

  it("keeps invocation-success semantics when no read result status contract is declared", async () => {
    const { executor } = setup({
      omitReadRawResult: true,
      useReadResultStatusContract: false,
    });
    await runWithInvocationOrigin("ui", undefined, () =>
      executor.executeAll(
        [{ id: "r", name: "domain_read", input: { operation: "status" } }],
        options(),
      ),
    );
    expect(() => executor.issuePluginOperationGrant({
      toolName: "domain_write",
      input: { operation: "save", value: 1 },
      principal,
    })).not.toThrow();
  });

  it("invalidates an older successful read when a refresh resolves non-success", async () => {
    const { executor, read } = setup();
    await runWithInvocationOrigin("ui", undefined, () =>
      executor.executeAll(
        [{ id: "r1", name: "domain_read", input: { operation: "status" } }],
        options(),
      ),
    );
    read.mockImplementationOnce(async () => ({
      output: "refresh failed",
      isError: false,
      metadata: { rawResult: { status: "error" } },
    }));
    await runWithInvocationOrigin("ui", undefined, () =>
      executor.executeAll(
        [{ id: "r2", name: "domain_read", input: { operation: "status" } }],
        options(),
      ),
    );
    expect(() => executor.issuePluginOperationGrant({
      toolName: "domain_write",
      input: { operation: "save", value: 1 },
      principal,
    })).toThrow(/required read is missing or stale/);
  });

  it("revokes an issued grant as soon as a newer read starts, even if that read fails", async () => {
    const { executor, read, write } = setup();
    await runWithInvocationOrigin("ui", undefined, () =>
      executor.executeAll(
        [{ id: "r1", name: "domain_read", input: { operation: "status" } }],
        options(),
      ),
    );
    const oldGrant = executor.issuePluginOperationGrant({
      toolName: "domain_write",
      input: { operation: "save", value: 1 },
      principal,
    });
    let releaseRefresh!: () => void;
    let markRefreshStarted!: () => void;
    const refreshStarted = new Promise<void>((resolve) => {
      markRefreshStarted = resolve;
    });
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    read.mockImplementationOnce(async () => {
      markRefreshStarted();
      await refreshGate;
      return {
        output: "refresh failed",
        isError: false,
        metadata: { rawResult: { status: "uncertain" } },
      };
    });
    const refresh = runWithInvocationOrigin("ui", undefined, () =>
      executor.executeAll(
        [{ id: "r2", name: "domain_read", input: { operation: "status" } }],
        options(),
      ),
    );
    await refreshStarted;
    expect(() => executor.issuePluginOperationGrant({
      toolName: "domain_write",
      input: { operation: "save", value: 2 },
      principal,
    })).toThrow(/required read is missing or stale/);

    const staleWrite = runWithInvocationOrigin("ui", undefined, () =>
      executor.executeAll(
        [{ id: "w", name: "domain_write", input: { operation: "save", value: 1 } }],
        options(oldGrant.token),
      ),
    );
    releaseRefresh();
    await refresh;
    const [writeResult] = await staleWrite;
    expect(writeResult.is_error).toBe(true);
    expect(writeResult.content).toMatch(/superseded/);
    expect(write).not.toHaveBeenCalled();
  });

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

  it("holds one exclusive domain lease through write execution before admitting readback", async () => {
    const { executor, read, write } = setup();
    await runWithInvocationOrigin("ui", undefined, () =>
      executor.executeAll(
        [{ id: "r1", name: "domain_read", input: { operation: "status" } }],
        options(),
      ),
    );
    const grantArgs = {
      toolName: "domain_write",
      input: { operation: "save", value: 11 },
      principal,
    };
    const firstGrant = executor.issuePluginOperationGrant(grantArgs);
    let signalWriteStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => {
      signalWriteStarted = resolve;
    });
    let releaseWrite!: () => void;
    const writeBlocked = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    write.mockImplementationOnce(async () => {
      signalWriteStarted();
      await writeBlocked;
      return { output: "saved", isError: false };
    });

    const firstWrite = runWithInvocationOrigin("ui", undefined, () =>
      executor.executeAll(
        [{ id: "w1", name: "domain_write", input: { operation: "save", value: 11 } }],
        options(firstGrant.token),
      ),
    );
    await writeStarted;
    const readback = runWithInvocationOrigin("ui", undefined, () =>
      executor.executeAll(
        [{ id: "r2", name: "domain_read", input: { operation: "status" } }],
        options(),
      ),
    );
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(1);
    expect(() => executor.issuePluginOperationGrant(grantArgs))
      .toThrow(/required read is missing or stale/);

    releaseWrite();
    await firstWrite;
    await readback;
    expect(read).toHaveBeenCalledTimes(2);

    const secondGrant = executor.issuePluginOperationGrant(grantArgs);
    const [secondWrite] = await runWithInvocationOrigin("ui", undefined, () =>
      executor.executeAll(
        [{ id: "w2", name: "domain_write", input: { operation: "save", value: 11 } }],
        options(secondGrant.token),
      ),
    );
    expect(secondWrite.is_error).toBeFalsy();
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("invalidates a second session's pre-issued grant after the first session writes", async () => {
    const { executor, write } = setup();
    const secondSession = { ...principal, appSessionId: "window-5" };
    await runWithInvocationOrigin("ui", undefined, () =>
      executor.executeAll(
        [{ id: "r1", name: "domain_read", input: { operation: "status" } }],
        options(),
      ),
    );
    await runWithInvocationOrigin("ui", undefined, () =>
      executor.executeAll(
        [{ id: "r2", name: "domain_read", input: { operation: "status" } }],
        options(undefined, secondSession),
      ),
    );
    const grantArgs = {
      toolName: "domain_write",
      input: { operation: "save", value: 12 },
      principal,
    };
    const firstGrant = executor.issuePluginOperationGrant(grantArgs);
    const staleGrant = executor.issuePluginOperationGrant({
      ...grantArgs,
      principal: secondSession,
    });

    const [firstWrite] = await runWithInvocationOrigin("ui", undefined, () =>
      executor.executeAll(
        [{ id: "w1", name: "domain_write", input: { operation: "save", value: 12 } }],
        options(firstGrant.token),
      ),
    );
    expect(firstWrite.is_error).toBeFalsy();

    const [staleWrite] = await runWithInvocationOrigin("ui", undefined, () =>
      executor.executeAll(
        [{ id: "w2", name: "domain_write", input: { operation: "save", value: 12 } }],
        options(staleGrant.token, secondSession),
      ),
    );
    expect(staleWrite.is_error).toBe(true);
    expect(staleWrite.content).toContain("intervening write");
    expect(write).toHaveBeenCalledTimes(1);

    await runWithInvocationOrigin("ui", undefined, () =>
      executor.executeAll(
        [{ id: "r3", name: "domain_read", input: { operation: "status" } }],
        options(undefined, secondSession),
      ),
    );
    const freshGrant = executor.issuePluginOperationGrant({
      ...grantArgs,
      principal: secondSession,
    });
    const [freshWrite] = await runWithInvocationOrigin("ui", undefined, () =>
      executor.executeAll(
        [{ id: "w3", name: "domain_write", input: { operation: "save", value: 12 } }],
        options(freshGrant.token, secondSession),
      ),
    );
    expect(freshWrite.is_error).toBeFalsy();
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("enforces fresh-read and mutation epochs for non-app plugin writes", async () => {
    const { executor, write } = setup();
    const hostPrincipal = {
      ...principal,
      appSessionId: "plugin-plugin-ep-api",
    };
    await runWithInvocationOrigin("ui", undefined, () =>
      executor.executeAll(
        [{ id: "app-read", name: "domain_read", input: { operation: "status" } }],
        options(),
      ),
    );
    const staleAppGrant = executor.issuePluginOperationGrant({
      toolName: "domain_write",
      input: { operation: "save", value: 14 },
      principal,
    });

    const [missingRead] = await runWithInvocationOrigin("plugin", undefined, () =>
      executor.executeAll(
        [{ id: "plugin-write-1", name: "domain_write", input: { operation: "save", value: 14 } }],
        options(undefined, hostPrincipal, false),
      ),
    );
    expect(missingRead.is_error).toBe(true);
    expect(missingRead.content).toContain("required read");
    expect(write).not.toHaveBeenCalled();

    await runWithInvocationOrigin("plugin", undefined, () =>
      executor.executeAll(
        [{ id: "plugin-read", name: "domain_read", input: { operation: "status" } }],
        options(undefined, hostPrincipal, false),
      ),
    );
    const [pluginWrite] = await runWithInvocationOrigin("plugin", undefined, () =>
      executor.executeAll(
        [{ id: "plugin-write-2", name: "domain_write", input: { operation: "save", value: 14 } }],
        options(undefined, hostPrincipal, false),
      ),
    );
    expect(pluginWrite.is_error).toBeFalsy();
    expect(write).toHaveBeenCalledTimes(1);

    const [staleAppWrite] = await runWithInvocationOrigin("ui", undefined, () =>
      executor.executeAll(
        [{ id: "app-write", name: "domain_write", input: { operation: "save", value: 14 } }],
        options(staleAppGrant.token),
      ),
    );
    expect(staleAppWrite.is_error).toBe(true);
    expect(staleAppWrite.content).toContain("intervening write");
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("holds the exclusive domain lease until a signal-ignoring write settles", async () => {
    vi.useFakeTimers();
    try {
      const { executor, read, write, auditLogger } = setup();
      await runWithInvocationOrigin("ui", undefined, () =>
        executor.executeAll(
          [{ id: "r1", name: "domain_read", input: { operation: "status" } }],
          options(),
        ),
      );
      const grant = executor.issuePluginOperationGrant({
        toolName: "domain_write",
        input: { operation: "save", value: 13 },
        principal,
      });
      let signalWriteStarted!: () => void;
      const writeStarted = new Promise<void>((resolve) => {
        signalWriteStarted = resolve;
      });
      let releaseWrite!: () => void;
      write.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            signalWriteStarted();
            releaseWrite = () => resolve({ output: "late saved", isError: false });
          }),
      );

      const timedOutWrite = runWithInvocationOrigin("ui", undefined, () =>
        executor.executeAll(
          [{ id: "w1", name: "domain_write", input: { operation: "save", value: 13 } }],
          options(grant.token),
        ),
      );
      await writeStarted;
      await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_POLICY.globalCeilingMs + 1);
      const [timedOutResult] = await timedOutWrite;
      expect(timedOutResult.is_error).toBe(true);
      expect(timedOutResult.content).toContain("exceeded global ceiling");

      const readback = runWithInvocationOrigin("ui", undefined, () =>
        executor.executeAll(
          [{ id: "r2", name: "domain_read", input: { operation: "status" } }],
          options(),
        ),
      );
      await Promise.resolve();
      expect(read).toHaveBeenCalledTimes(1);

      releaseWrite();
      await readback;
      expect(read).toHaveBeenCalledTimes(2);
      expect(auditLogger.appendPermissionAuditEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          pluginOperation: expect.objectContaining({ outcome: "indeterminate" }),
        }),
      );
      expect(auditLogger.appendPermissionAuditEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          pluginOperation: expect.objectContaining({ outcome: "settled" }),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the domain poisoned when late-settlement audit persistence fails", async () => {
    vi.useFakeTimers();
    try {
      const { executor, read, write, auditLogger } = setup();
      await runWithInvocationOrigin("ui", undefined, () =>
        executor.executeAll(
          [{ id: "r1", name: "domain_read", input: { operation: "status" } }],
          options(),
        ),
      );
      const grant = executor.issuePluginOperationGrant({
        toolName: "domain_write",
        input: { operation: "save", value: 15 },
        principal,
      });
      const appendPermissionAuditEntry =
        auditLogger.appendPermissionAuditEntry.getMockImplementation()!;
      auditLogger.appendPermissionAuditEntry.mockImplementation(async (entry) => {
        const pluginOperation = entry.pluginOperation as
          | { outcome?: string }
          | undefined;
        if (pluginOperation?.outcome === "settled") {
          throw new Error("audit disk unavailable");
        }
        return appendPermissionAuditEntry(entry);
      });
      let signalWriteStarted!: () => void;
      const writeStarted = new Promise<void>((resolve) => {
        signalWriteStarted = resolve;
      });
      let releaseWrite!: () => void;
      write.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            signalWriteStarted();
            releaseWrite = () => resolve({ output: "late saved", isError: false });
          }),
      );

      const timedOutWrite = runWithInvocationOrigin("ui", undefined, () =>
        executor.executeAll(
          [{ id: "w1", name: "domain_write", input: { operation: "save", value: 15 } }],
          options(grant.token),
        ),
      );
      await writeStarted;
      await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_POLICY.globalCeilingMs + 1);
      await timedOutWrite;

      const readAbort = new AbortController();
      const readback = runWithInvocationOrigin("ui", undefined, () =>
        executor.executeAll(
          [{ id: "r2", name: "domain_read", input: { operation: "status" } }],
          { ...options(), abortSignal: readAbort.signal },
        ),
      );
      await Promise.resolve();
      releaseWrite();
      await Promise.resolve();
      await Promise.resolve();
      expect(read).toHaveBeenCalledTimes(1);
      readAbort.abort();
      await expect(readback).rejects.toThrow(/aborted/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the domain poisoned when the initial indeterminate audit cannot persist", async () => {
    vi.useFakeTimers();
    try {
      const { executor, read, write, auditLogger } = setup();
      await runWithInvocationOrigin("ui", undefined, () =>
        executor.executeAll(
          [{ id: "r1", name: "domain_read", input: { operation: "status" } }],
          options(),
        ),
      );
      const grant = executor.issuePluginOperationGrant({
        toolName: "domain_write",
        input: { operation: "save", value: 17 },
        principal,
      });
      const appendPermissionAuditEntry =
        auditLogger.appendPermissionAuditEntry.getMockImplementation()!;
      auditLogger.appendPermissionAuditEntry.mockImplementation(async (entry) => {
        const pluginOperation = entry.pluginOperation as
          | { outcome?: string }
          | undefined;
        if (pluginOperation?.outcome === "indeterminate") {
          throw new Error("indeterminate audit unavailable");
        }
        return appendPermissionAuditEntry(entry);
      });
      let signalWriteStarted!: () => void;
      const writeStarted = new Promise<void>((resolve) => {
        signalWriteStarted = resolve;
      });
      let releaseWrite!: () => void;
      write.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            signalWriteStarted();
            releaseWrite = () => resolve({ output: "late saved", isError: false });
          }),
      );

      const timedOutWrite = runWithInvocationOrigin("ui", undefined, () =>
        executor.executeAll(
          [{ id: "w1", name: "domain_write", input: { operation: "save", value: 17 } }],
          options(grant.token),
        ),
      );
      const timedOutExpectation =
        expect(timedOutWrite).rejects.toThrow("indeterminate audit unavailable");
      await writeStarted;
      await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_POLICY.globalCeilingMs + 1);
      await timedOutExpectation;

      const readAbort = new AbortController();
      const readback = runWithInvocationOrigin("ui", undefined, () =>
        executor.executeAll(
          [{ id: "r2", name: "domain_read", input: { operation: "status" } }],
          { ...options(), abortSignal: readAbort.signal },
        ),
      );
      await Promise.resolve();
      releaseWrite();
      await Promise.resolve();
      await Promise.resolve();
      expect(read).toHaveBeenCalledTimes(1);
      expect(auditLogger.appendPermissionAuditEntry).not.toHaveBeenCalledWith(
        expect.objectContaining({
          pluginOperation: expect.objectContaining({ outcome: "settled" }),
        }),
      );
      readAbort.abort();
      await expect(readback).rejects.toThrow(/aborted/);
    } finally {
      vi.useRealTimers();
    }
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

  it("fails closed when any governed origin lacks Host-derived domain identity", async () => {
    const { executor, read } = setup();
    const [result] = await runWithInvocationOrigin("plugin", undefined, () =>
      executor.executeAll(
        [{ id: "missing-domain", name: "domain_read", input: { operation: "status" } }],
        {
          sessionId: "s",
          permissionContext: {
            trustOrigin: "plugin-emitted",
            allowedPluginIds: new Set([principal.ownerPluginId]),
          },
        },
      ),
    );
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("host-derived operation identity is missing");
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects Host context whose grant policy does not match the effective origin", async () => {
    const { executor, read } = setup();
    const [result] = await runWithInvocationOrigin("ui", undefined, () =>
      executor.executeAll(
        [{ id: "origin-mismatch", name: "domain_read", input: { operation: "status" } }],
        options(undefined, principal, false),
      ),
    );
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("grant policy does not match");
    expect(read).not.toHaveBeenCalled();
  });

  it("uses the Host identity provider for model-origin reads and first direct writes", async () => {
    const { executor, read, write, directWrite } = setup({ provideModelIdentity: true });
    const modelOptions = {
      sessionId: "model-session",
      permissionContext: {
        trustOrigin: "llm-tool-arg" as const,
        allowedPluginIds: new Set([principal.ownerPluginId]),
      },
    };

    const [firstWrite] = await executor.executeAll(
      [{
        id: "model-direct-write",
        name: "direct_write",
        input: { operation: "reserve", target: "room-2" },
      }],
      modelOptions,
    );
    expect(firstWrite.is_error).toBeFalsy();
    expect(directWrite).toHaveBeenCalledTimes(1);

    const [readResult] = await executor.executeAll(
      [{ id: "model-read", name: "domain_read", input: { operation: "status" } }],
      modelOptions,
    );
    expect(readResult.is_error).toBeFalsy();
    expect(read).toHaveBeenCalledTimes(1);

    const [readBackedWrite] = await executor.executeAll(
      [{
        id: "model-read-backed-write",
        name: "domain_write",
        input: { operation: "save", value: 21 },
      }],
      modelOptions,
    );
    expect(readBackedWrite.is_error).toBeFalsy();
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("registers the domain before a first governed read is observed as mutating", async () => {
    const { executor, taintedRead } = setup({ provideModelIdentity: true });
    const [result] = await executor.executeAll(
      [{ id: "first-tainted", name: "tainted_read", input: { operation: "status" } }],
      {
        sessionId: "model-first-tainted",
        permissionContext: {
          trustOrigin: "llm-tool-arg",
          allowedPluginIds: new Set([principal.ownerPluginId]),
        },
      },
    );
    expect(result.is_error).toBeFalsy();
    expect(taintedRead).toHaveBeenCalledTimes(1);
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

  it("invalidates existing authority and mints no receipt from a read that mutates", async () => {
    const { executor, write } = setup();
    await runWithInvocationOrigin("ui", undefined, () =>
      executor.executeAll(
        [{ id: "clean", name: "domain_read", input: { operation: "status" } }],
        options(),
      ),
    );
    const staleGrant = executor.issuePluginOperationGrant({
      toolName: "domain_write",
      input: { operation: "save", value: 1 },
      principal,
    });
    const [result] = await runWithInvocationOrigin("ui", undefined, () =>
      executor.executeAll([{ id: "r", name: "tainted_read", input: { operation: "status" } }], options()),
    );
    expect(result.is_error).toBeFalsy();
    const [staleWrite] = await runWithInvocationOrigin("ui", undefined, () =>
      executor.executeAll(
        [{ id: "w", name: "domain_write", input: { operation: "save", value: 1 } }],
        options(staleGrant.token),
      ),
    );
    expect(staleWrite.is_error).toBe(true);
    expect(staleWrite.content).toContain("intervening write");
    expect(write).not.toHaveBeenCalled();
    expect(() => executor.issuePluginOperationGrant({
      toolName: "domain_write",
      input: { operation: "save", value: 1 },
      principal,
    })).toThrow(/required read is missing or stale/);
  });

  it("serializes and poisons a signal-ignoring read that mutates", async () => {
    vi.useFakeTimers();
    try {
      const { executor, write, taintedRead, auditLogger } = setup();
      await runWithInvocationOrigin("ui", undefined, () =>
        executor.executeAll(
          [{ id: "clean", name: "domain_read", input: { operation: "status" } }],
          options(),
        ),
      );
      const staleGrant = executor.issuePluginOperationGrant({
        toolName: "domain_write",
        input: { operation: "save", value: 16 },
        principal,
        ttlMs: 300_000,
      });
      let signalReadStarted!: () => void;
      const readStarted = new Promise<void>((resolve) => {
        signalReadStarted = resolve;
      });
      let releaseRead!: () => void;
      taintedRead.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            currentEffectLedger()?.record({
              kind: "config.set",
              effect: "write",
              target: "test",
            });
            signalReadStarted();
            releaseRead = () => resolve({ output: "late tainted", isError: false });
          }),
      );

      const timedOutRead = runWithInvocationOrigin("ui", undefined, () =>
        executor.executeAll(
          [{ id: "tainted", name: "tainted_read", input: { operation: "status" } }],
          options(),
        ),
      );
      await readStarted;
      await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_POLICY.globalCeilingMs + 1);
      const [timedOutResult] = await timedOutRead;
      expect(timedOutResult.is_error).toBe(true);

      const queuedWrite = runWithInvocationOrigin("ui", undefined, () =>
        executor.executeAll(
          [{ id: "write", name: "domain_write", input: { operation: "save", value: 16 } }],
          options(staleGrant.token),
        ),
      );
      await Promise.resolve();
      expect(write).not.toHaveBeenCalled();

      releaseRead();
      const [staleWrite] = await queuedWrite;
      expect(staleWrite.is_error).toBe(true);
      expect(staleWrite.content).toContain("intervening write");
      expect(auditLogger.appendPermissionAuditEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          pluginOperation: expect.objectContaining({ outcome: "indeterminate" }),
        }),
      );
      expect(auditLogger.appendPermissionAuditEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          pluginOperation: expect.objectContaining({ outcome: "settled" }),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
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

  it("never dispatches a revoked session's queued operation while preserving another session", async () => {
    const { executor, read, directWrite } = setup();
    const holderPrincipal = { ...principal, appSessionId: "window-holder" };
    const survivorPrincipal = { ...principal, appSessionId: "window-survivor" };
    const holderGrant = executor.issuePluginOperationGrant({
      toolName: "direct_write",
      input: { operation: "reserve", target: "held" },
      principal: holderPrincipal,
    });
    let signalHolderStarted!: () => void;
    const holderStarted = new Promise<void>((resolve) => {
      signalHolderStarted = resolve;
    });
    let releaseHolder!: () => void;
    directWrite.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          signalHolderStarted();
          releaseHolder = () => resolve({ output: "released", isError: false });
        }),
    );
    const holder = runWithInvocationOrigin("ui", undefined, () =>
      executor.executeAll(
        [{
          id: "holder",
          name: "direct_write",
          input: { operation: "reserve", target: "held" },
        }],
        options(holderGrant.token, holderPrincipal),
      ),
    );
    await holderStarted;

    const revoked = runWithInvocationOrigin("ui", undefined, () =>
      executor.executeAll(
        [{ id: "revoked", name: "domain_read", input: { operation: "status" } }],
        options(undefined, principal),
      ),
    );
    const survivor = runWithInvocationOrigin("ui", undefined, () =>
      executor.executeAll(
        [{ id: "survivor", name: "domain_read", input: { operation: "status" } }],
        options(undefined, survivorPrincipal),
      ),
    );
    await Promise.resolve();
    executor.revokePluginOperationSession(principal.appSessionId);
    await expect(revoked).rejects.toThrow("session is revoked");
    expect(read).not.toHaveBeenCalled();

    releaseHolder();
    await holder;
    const [survivorResult] = await survivor;
    expect(survivorResult.is_error).toBeFalsy();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it.each(["session", "account", "generation"] as const)(
    "revalidates %s revocation after lease admission and before handler dispatch",
    async (revocation) => {
      const { executor, directWrite, auditLogger } = setup();
      const grant = executor.issuePluginOperationGrant({
        toolName: "direct_write",
        input: { operation: "reserve", target: revocation },
        principal,
      });
      const originalAppend =
        auditLogger.appendPermissionAuditEntry.getMockImplementation()!;
      let signalAuditStarted!: () => void;
      const auditStarted = new Promise<void>((resolve) => {
        signalAuditStarted = resolve;
      });
      let releaseAudit!: () => void;
      auditLogger.appendPermissionAuditEntry.mockImplementation((entry) => {
        const pluginOperation = entry.pluginOperation as
          | { outcome?: string }
          | undefined;
        if (pluginOperation?.outcome !== "consumed") {
          return originalAppend(entry);
        }
        signalAuditStarted();
        return new Promise((resolve) => {
          releaseAudit = () => resolve({
            ...entry,
            prevHash: "test-prev-hash",
          });
        });
      });

      const pending = runWithInvocationOrigin("ui", undefined, () =>
        executor.executeAll(
          [{
            id: `admitted-${revocation}`,
            name: "direct_write",
            input: { operation: "reserve", target: revocation },
          }],
          options(grant.token),
        ),
      );
      await auditStarted;
      if (revocation === "session") {
        executor.revokePluginOperationSession(principal.appSessionId);
      } else if (revocation === "account") {
        executor.revokePluginOperationAccount(
          principal.ownerPluginId,
          principal.generationId,
          principal.accountHash,
        );
      } else {
        executor.revokePluginOperationGeneration(
          principal.ownerPluginId,
          principal.generationId,
        );
      }
      releaseAudit();

      const [result] = await pending;
      expect(result.is_error).toBe(true);
      expect(result.content).toContain(`${revocation} is revoked`);
      expect(directWrite).not.toHaveBeenCalled();
    },
  );

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
