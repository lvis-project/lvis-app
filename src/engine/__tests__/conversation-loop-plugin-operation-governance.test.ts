import { describe, expect, it, vi } from "vitest";
import { ScriptHookManager } from "../../hooks/script-hook-manager.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import {
  PluginOperationGrantCoordinator,
  pluginOperationExecutionDomain,
} from "../../permissions/plugin-operation-grant.js";
import { createDynamicTool } from "../../tools/base.js";
import { ToolExecutor } from "../../tools/executor.js";
import { ToolRegistry } from "../../tools/registry.js";
import { ConversationLoop } from "../conversation-loop.js";
import { makeConversationLoopDeps } from "./conversation-loop-test-helpers.js";

describe("ConversationLoop plugin operation governance", () => {
  it("wires Host model identity and shared authority into its canonical executor", async () => {
    const pluginId = "governed-plugin";
    const generationId = "generation-1";
    const execute = vi.fn(async () => ({
      output: "fresh",
      isError: false,
    }));
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "governed_read",
      description: "read governed state",
      source: "plugin",
      category: "write",
      pluginId,
      pluginGeneration: { pluginId, generationId },
      operationPolicy: {
        discriminant: "operation",
        operations: {
          status: {
            kind: "read",
            minimumRisk: "read",
          },
        },
      },
      jsonSchema: { type: "object" },
      execute,
    }));
    const permissionManager =
      new PermissionManager("/tmp/nonexistent-conversation-operation-governance.json");
    permissionManager.checkDetailed = () => ({
      decision: "allow",
      reason: "test",
      layer: 3,
    });
    const activeGeneration = { pluginId, generationId, state: {} };
    const generationAccess = {
      getActive: vi.fn(() => activeGeneration),
      isExactAdmitted: vi.fn(() => true),
      acquire: vi.fn(async () => ({
        generation: activeGeneration,
        release: vi.fn(),
      })),
      acquireExact: vi.fn(async () => ({
        generation: activeGeneration,
        release: vi.fn(),
      })),
      runWithLease: vi.fn(async (
        _lease: unknown,
        operation: () => Promise<unknown>,
      ) => operation()),
    };
    const grants = new PluginOperationGrantCoordinator();
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
    const loop = new ConversationLoop(makeConversationLoopDeps({
      toolRegistry: registry,
      permissionManager,
      scriptHookManager: new ScriptHookManager(),
      auditLogger: auditLogger as never,
      pluginRuntime: {
        listPluginIds: () => [pluginId],
        getGenerationAccess: () => generationAccess as never,
      },
      pluginOperationGrants: grants,
      pluginOperationIdentityProvider: (_tool, sessionId) => ({
        ownerVersion: "1.0.0",
        generationId,
        appSessionId: sessionId ?? "model-session",
        accountScopeHash: "account-scope-hash",
        accountHash: "account-hash",
        appGrantRequired: false,
      }),
    }));
    const executor = (
      loop as unknown as { toolExecutor: ToolExecutor }
    ).toolExecutor;

    const [result] = await executor.executeAll(
      [{
        id: "model-governed-read",
        name: "governed_read",
        input: { operation: "status" },
      }],
      {
        sessionId: "model-session",
        permissionContext: {
          trustOrigin: "llm-tool-arg",
          allowedPluginIds: new Set([pluginId]),
        },
      },
    );

    expect(result.is_error).toBeFalsy();
    expect(execute).toHaveBeenCalledTimes(1);
    const operationPrincipal = {
      ownerPluginId: pluginId,
      ownerVersion: "1.0.0",
      generationId,
      appSessionId: "model-session",
      accountScopeHash: "account-scope-hash",
      accountHash: "account-hash",
    };
    const domain = pluginOperationExecutionDomain(
      operationPrincipal,
      "governed_read",
      "status",
      registry.listAll(),
    );
    expect(grants.latestRequiredRead(
      operationPrincipal,
      "governed_read",
      ["status"],
      60_000,
      domain,
    )).toMatch(/^[0-9a-f-]{36}$/);
  });
});
