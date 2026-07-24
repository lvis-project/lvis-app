import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BootContext } from "../../context.js";
import { TOOL_TIMEOUT_POLICY } from "../../../shared/tool-timeout-policy.js";
import { PluginRuntimeDetachedOperationError } from "../../../plugins/runtime/detached-operation.js";

const mocks = vi.hoisted(() => ({
  dispatchAppOnlyRuntimeInvocation: vi.fn(),
  beginPluginAuthInvocation: vi.fn(),
  observePluginAuthResult: vi.fn(),
  invalidateDetachedPluginAuthInvocation: vi.fn(),
  revokePluginOperationAccount: vi.fn(),
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
  isAppOnlyRuntimeInvocation: vi.fn(() => true),
  dispatchAppOnlyRuntimeInvocation:
    mocks.dispatchAppOnlyRuntimeInvocation,
}));

vi.mock("../plugin-operation-account.js", () => ({
  resolvePluginOperationAccount: vi.fn(() => undefined),
}));

import { setupPluginToolExecutor } from "../plugin-tool-executor.js";

const pluginId = "ep-api";
const activeGenerationId = "generation-2";
const predecessorGenerationId = "generation-1";

function makeContext(): BootContext {
  const pluginRuntime = {
    beginPluginAuthInvocation: mocks.beginPluginAuthInvocation,
    observePluginAuthResult: mocks.observePluginAuthResult,
    invalidateDetachedPluginAuthInvocation:
      mocks.invalidateDetachedPluginAuthInvocation,
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
          tools: [],
        },
      })),
    },
  } as unknown as BootContext;
}

function invocationContext() {
  return {
    origin: "ui",
    ownerPluginId: pluginId,
    ownerGenerationId: activeGenerationId,
    appInvocation: { sessionId: "window-1" },
  } as const;
}

describe("setupPluginToolExecutor production auth wiring", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.observePluginAuthResult.mockReturnValue({});
    mocks.invalidateDetachedPluginAuthInvocation.mockReturnValue({});
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
      invoke("auth_status", {}, invocationContext()),
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
    mocks.invalidateDetachedPluginAuthInvocation.mockReturnValue({
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
});
