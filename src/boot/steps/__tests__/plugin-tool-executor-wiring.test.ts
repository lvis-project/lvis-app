import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BootContext } from "../../context.js";
import { TOOL_TIMEOUT_POLICY } from "../../../shared/tool-timeout-policy.js";
import { PluginRuntimeDetachedOperationError } from "../../../plugins/runtime/detached-operation.js";

const mocks = vi.hoisted(() => ({
  dispatchAppOnlyRuntimeInvocation: vi.fn(),
  isAppOnlyRuntimeInvocation: vi.fn(),
  beginPluginAuthInvocation: vi.fn(),
  observePluginAuthResult: vi.fn(),
  invalidateFailedPluginAuthInvocation: vi.fn(),
  revokePluginOperationAccount: vi.fn(),
  executeAll: vi.fn(),
  resolvePluginOperationAccount: vi.fn(),
}));

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));

vi.mock("../../conversation.js", () => ({
  createHookRunner: vi.fn(() => ({})),
}));

vi.mock("../hook-system-wiring.js", () => ({
  wireHookSystem: vi.fn(async () => ({ manager: {} })),
}));

vi.mock("../../../tools/executor.js", () => ({
  ToolExecutor: class {
    revokePluginOperationAccount = mocks.revokePluginOperationAccount;
    executeAll = mocks.executeAll;
  },
}));

vi.mock("../../plugin-surface-permissions.js", () => ({
  createPluginSurfacePermissionScope: vi.fn(() => ({
    createPermissionContext: vi.fn(
      (_context: unknown, overrides: Record<string, unknown>) => overrides,
    ),
  })),
}));

vi.mock("../../../permissions/permission-settings-store.js", () => ({
  readPermissionSettings: vi.fn(() => ({
    permissions: { additionalDirectories: [] },
  })),
}));

vi.mock("../../../ipc/domains/permissions.js", () => ({
  broadcastPermissionConfigChanged: vi.fn(),
}));

vi.mock("../../../permissions/sandbox-capability.js", () => ({
  isActiveSandboxFilesystemContainedForPluginEffects: vi.fn(() => false),
}));

vi.mock("../../plugin-tool-invocation.js", () => ({
  isAppOnlyRuntimeInvocation: mocks.isAppOnlyRuntimeInvocation,
  dispatchAppOnlyRuntimeInvocation:
    mocks.dispatchAppOnlyRuntimeInvocation,
}));

vi.mock("../plugin-operation-account.js", () => ({
  resolvePluginOperationAccount: mocks.resolvePluginOperationAccount,
}));

import { setupPluginToolExecutor } from "../plugin-tool-executor.js";

const pluginId = "ep-api";
const activeGenerationId = "generation-2";
const predecessorGenerationId = "generation-1";

function makeContext(options: {
  manifestTools?: unknown[];
  manifestAuth?: Record<string, string>;
} = {}): BootContext {
  const pluginRuntime = {
    beginPluginAuthInvocation: mocks.beginPluginAuthInvocation,
    observePluginAuthResult: mocks.observePluginAuthResult,
    invalidateFailedPluginAuthInvocation:
      mocks.invalidateFailedPluginAuthInvocation,
    setToolInvocationDelegate: vi.fn(),
  };
  return {
    toolRegistry: {},
    permissionManager: {},
    bashAstValidator: {},
    approvalGate: {},
    bootAuditLogger: {},
    settingsService: { get: vi.fn(() => ({})) },
    pluginRuntime,
    lateBinding: {
      conversationLoopRef: {},
      pluginToolInvokerRef: {},
    },
    getMainWindow: vi.fn(),
    pluginBundleLifecycle: {
      getActive: vi.fn(() => ({
        generationId: activeGenerationId,
        manifest: {
          id: pluginId,
          version: "2.0.0",
          tools: options.manifestTools ?? [],
          auth: options.manifestAuth ?? {
            statusTool: "auth_status",
            loginTool: "auth_login",
            logoutTool: "auth_logout",
          },
        },
      })),
    },
  } as unknown as BootContext;
}

function invocationContext(
  authToolKind: "status" | "login" | "logout" = "login",
) {
  return {
    origin: "ui",
    ownerPluginId: pluginId,
    ownerGenerationId: activeGenerationId,
    authToolKind,
    appInvocation: { sessionId: "window-1" },
  } as const;
}

describe("setupPluginToolExecutor production auth wiring", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.isAppOnlyRuntimeInvocation.mockReturnValue(true);
    mocks.observePluginAuthResult.mockReturnValue({});
    mocks.invalidateFailedPluginAuthInvocation.mockReturnValue({});
    mocks.resolvePluginOperationAccount.mockReturnValue(undefined);
    mocks.executeAll.mockResolvedValue([{
      tool_use_id: "result",
      content: "ok",
      rawResult: { authenticated: true },
      durationMs: 1,
    }]);
    mocks.dispatchAppOnlyRuntimeInvocation.mockResolvedValue({
      authenticated: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("subtracts account-transition admission time from the app-only handler ceiling", async () => {
    const ctx = makeContext();
    mocks.beginPluginAuthInvocation.mockReturnValue({
      epoch: 1,
      accountTransitionScopeHash: "stable-account-scope",
    });
    await setupPluginToolExecutor(ctx);

    const held = await ctx.pluginOperationGrants!.acquireAccountTransitionLease({
      ownerPluginId: pluginId,
      generationId: predecessorGenerationId,
      appSessionId: "predecessor-window",
      accountScopeHash: "stable-account-scope",
    });
    const invoke = ctx.lateBinding.pluginToolInvokerRef.fn!;
    const resultPromise = invoke(
      "auth_login",
      {},
      invocationContext(),
    );

    await vi.advanceTimersByTimeAsync(
      TOOL_TIMEOUT_POLICY.globalCeilingMs - 50,
    );
    held.release();
    await expect(resultPromise).resolves.toEqual({ authenticated: true });

    const handlerCeiling = mocks.dispatchAppOnlyRuntimeInvocation.mock
      .calls[0]?.[4] as number | undefined;
    expect(handlerCeiling).toBeTypeOf("number");
    expect(handlerCeiling).toBeGreaterThan(0);
    expect(handlerCeiling).toBeLessThanOrEqual(50);
  });

  it("routes predecessor-generation revocation from auth start", async () => {
    const ctx = makeContext();
    mocks.beginPluginAuthInvocation.mockReturnValue({
      epoch: 2,
      invalidatedAccountHash: "predecessor-begin-principal",
      invalidatedAccountGenerationId: predecessorGenerationId,
    });
    await setupPluginToolExecutor(ctx);

    const invoke = ctx.lateBinding.pluginToolInvokerRef.fn!;
    await expect(
      invoke("auth_login", {}, invocationContext()),
    ).resolves.toEqual({ authenticated: true });

    expect(mocks.revokePluginOperationAccount).toHaveBeenCalledTimes(1);
    expect(mocks.revokePluginOperationAccount).toHaveBeenCalledWith(
      pluginId,
      predecessorGenerationId,
      "predecessor-begin-principal",
    );
  });

  it("fails closed when auth invalidation lacks generation provenance", async () => {
    const ctx = makeContext();
    mocks.beginPluginAuthInvocation.mockReturnValue({
      epoch: 2,
      invalidatedAccountHash: "malformed-principal",
    });
    await setupPluginToolExecutor(ctx);

    const invoke = ctx.lateBinding.pluginToolInvokerRef.fn!;
    await expect(
      invoke("auth_login", {}, invocationContext()),
    ).rejects.toThrow("plugin auth invalidation is missing generation provenance");
    expect(mocks.revokePluginOperationAccount).not.toHaveBeenCalled();
  });

  it("routes predecessor-generation revocation from auth result observation", async () => {
    const ctx = makeContext();
    mocks.beginPluginAuthInvocation.mockReturnValue({ epoch: 3 });
    mocks.observePluginAuthResult.mockReturnValue({
      invalidatedAccountHash: "predecessor-result-principal",
      invalidatedAccountGenerationId: predecessorGenerationId,
    });
    await setupPluginToolExecutor(ctx);

    const invoke = ctx.lateBinding.pluginToolInvokerRef.fn!;
    await expect(
      invoke("auth_status", {}, invocationContext("status")),
    ).resolves.toEqual({ authenticated: true });

    expect(mocks.revokePluginOperationAccount).toHaveBeenCalledTimes(1);
    expect(mocks.revokePluginOperationAccount).toHaveBeenCalledWith(
      pluginId,
      predecessorGenerationId,
      "predecessor-result-principal",
    );
  });

  it("routes predecessor-generation revocation when an auth handler detaches", async () => {
    const ctx = makeContext();
    mocks.beginPluginAuthInvocation.mockReturnValue({ epoch: 4 });
    mocks.dispatchAppOnlyRuntimeInvocation.mockRejectedValue(
      new PluginRuntimeDetachedOperationError(
        new Error("auth handler ceiling"),
        Promise.resolve(),
      ),
    );
    mocks.invalidateFailedPluginAuthInvocation.mockReturnValue({
      invalidatedAccountHash: "predecessor-detached-principal",
      invalidatedAccountGenerationId: predecessorGenerationId,
    });
    await setupPluginToolExecutor(ctx);

    const invoke = ctx.lateBinding.pluginToolInvokerRef.fn!;
    await expect(
      invoke("auth_login", {}, invocationContext()),
    ).rejects.toThrow("auth handler ceiling");

    expect(mocks.revokePluginOperationAccount).toHaveBeenCalledTimes(1);
    expect(mocks.revokePluginOperationAccount).toHaveBeenCalledWith(
      pluginId,
      predecessorGenerationId,
      "predecessor-detached-principal",
    );
  });

  it("fails closed before dispatch when pinned auth provenance cannot claim the active generation", async () => {
    const ctx = makeContext();
    mocks.beginPluginAuthInvocation.mockReturnValue(undefined);
    await setupPluginToolExecutor(ctx);

    const invoke = ctx.lateBinding.pluginToolInvokerRef.fn!;
    await expect(
      invoke("auth_login", {}, invocationContext()),
    ).rejects.toThrow("plugin auth generation changed before transition admission");
    expect(mocks.dispatchAppOnlyRuntimeInvocation).not.toHaveBeenCalled();
  });

  it("rejects a manifest auth Tool without host-pinned trusted-panel provenance", async () => {
    const ctx = makeContext({
      manifestTools: [{
        name: "auth_login",
        _meta: { "lvisai/operationPolicy": { discriminant: "operation" } },
      }],
    });
    await setupPluginToolExecutor(ctx);

    const invoke = ctx.lateBinding.pluginToolInvokerRef.fn!;
    await expect(
      invoke("auth_login", {}, {
        origin: "ui",
        ownerPluginId: pluginId,
        ownerGenerationId: activeGenerationId,
        appInvocation: { sessionId: "window-1" },
      }),
    ).rejects.toThrow("manifest auth Tool requires host-pinned trusted-panel provenance");
    expect(mocks.beginPluginAuthInvocation).not.toHaveBeenCalled();
    expect(mocks.executeAll).not.toHaveBeenCalled();
    expect(mocks.dispatchAppOnlyRuntimeInvocation).not.toHaveBeenCalled();
  });

  it("rejects host-pinned auth provenance when it does not match the manifest role", async () => {
    const ctx = makeContext();
    await setupPluginToolExecutor(ctx);

    const invoke = ctx.lateBinding.pluginToolInvokerRef.fn!;
    await expect(
      invoke("auth_login", {}, invocationContext("status")),
    ).rejects.toThrow("host-pinned plugin auth provenance does not match the active manifest");
    expect(mocks.beginPluginAuthInvocation).not.toHaveBeenCalled();
    expect(mocks.executeAll).not.toHaveBeenCalled();
    expect(mocks.dispatchAppOnlyRuntimeInvocation).not.toHaveBeenCalled();
  });

  it("routes an operation-governed auth Tool through the executor without taking an outer transition lease", async () => {
    const ctx = makeContext({
      manifestTools: [{
        name: "auth_login",
        _meta: { "lvisai/operationPolicy": { discriminant: "operation" } },
      }],
    });
    mocks.beginPluginAuthInvocation.mockReturnValue({
      epoch: 5,
      accountTransitionScopeHash: "stable-account-scope",
      operationAccount: {
        accountScopeHash: "stable-account-scope",
        accountHash: "host-only-transition-principal",
      },
    });
    mocks.isAppOnlyRuntimeInvocation.mockReturnValue(false);
    await setupPluginToolExecutor(ctx);

    const transitionLease = vi.spyOn(
      ctx.pluginOperationGrants!,
      "acquireAccountTransitionLease",
    );
    mocks.executeAll.mockImplementation(async (_tools: unknown, options: {
      pluginAuthLifecycle?: {
        binding: Record<string, unknown>;
        completeSuccess(result: unknown): void;
      };
    }) => {
      expect(options.pluginAuthLifecycle?.binding).toMatchObject({
        pluginId,
        generationId: activeGenerationId,
        toolName: "auth_login",
        appSessionId: "window-1",
        accountScopeHash: "stable-account-scope",
      });
      options.pluginAuthLifecycle?.completeSuccess({ authenticated: true });
      return [{
        tool_use_id: "result",
        content: "ok",
        rawResult: { authenticated: true },
        durationMs: 1,
      }];
    });

    const invoke = ctx.lateBinding.pluginToolInvokerRef.fn!;
    await expect(
      invoke("auth_login", {}, invocationContext()),
    ).resolves.toEqual({ authenticated: true });
    expect(transitionLease).not.toHaveBeenCalled();
    expect(mocks.dispatchAppOnlyRuntimeInvocation).not.toHaveBeenCalled();
    // The lifecycle observes inside the executor boundary. A second boot-level
    // observation would be after lease release and reintroduce the race.
    expect(mocks.observePluginAuthResult).toHaveBeenCalledTimes(1);
  });

  it("revokes an unsuccessful status refresh before releasing its transition lease", async () => {
    const ctx = makeContext();
    mocks.beginPluginAuthInvocation.mockReturnValue({
      epoch: 6,
      accountTransitionScopeHash: "stable-account-scope",
    });
    mocks.dispatchAppOnlyRuntimeInvocation.mockRejectedValue(
      new Error("status refresh failed"),
    );
    mocks.invalidateFailedPluginAuthInvocation.mockReturnValue({
      invalidatedAccountHash: "stale-status-principal",
      invalidatedAccountGenerationId: predecessorGenerationId,
    });
    await setupPluginToolExecutor(ctx);

    const invoke = ctx.lateBinding.pluginToolInvokerRef.fn!;
    await expect(
      invoke("auth_status", {}, invocationContext("status")),
    ).rejects.toThrow("status refresh failed");

    expect(mocks.invalidateFailedPluginAuthInvocation).toHaveBeenCalledWith(
      pluginId,
      activeGenerationId,
      6,
    );
    expect(mocks.revokePluginOperationAccount).toHaveBeenCalledWith(
      pluginId,
      predecessorGenerationId,
      "stale-status-principal",
    );
  });

  it("passes a final session authorization assertion into app-only auth dispatch", async () => {
    const ctx = makeContext();
    mocks.beginPluginAuthInvocation.mockReturnValue({
      epoch: 7,
      accountTransitionScopeHash: "stable-account-scope",
    });
    mocks.dispatchAppOnlyRuntimeInvocation.mockImplementation(
      async (...args: unknown[]) => {
        ctx.pluginOperationGrants!.revokeSession("window-1");
        const beforeHandler = args[5];
        if (typeof beforeHandler !== "function") {
          throw new Error("missing auth transition assertion");
        }
        beforeHandler();
      },
    );
    await setupPluginToolExecutor(ctx);

    const invoke = ctx.lateBinding.pluginToolInvokerRef.fn!;
    await expect(
      invoke("auth_login", {}, invocationContext()),
    ).rejects.toThrow("plugin operation session is revoked");
  });
});
