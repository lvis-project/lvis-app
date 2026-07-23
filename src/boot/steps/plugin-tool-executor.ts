/**
 * Boot step — plugin tool execution surface (permission policy P4 Layer 6 +
 * §8, extracted from boot.ts C18).
 *
 * Builds the in-process HookRunner, the script-hook system, the plugin-surface
 * ToolExecutor (with the sandbox-filesystem-contained relaxation coupling), the
 * plugin-surface permission scope, and the `invokePluginTool` delegate that
 * routes every plugin tool call — from the model ("plugin"), the plugin's own
 * trusted panel ("ui"), or an MCP App card ("mcp-app") — through the executor.
 * The ONE exception is the app-only-visibility runtime dispatch, which skips
 * straight to the runtime and is reachable from the trusted panel ORIGIN ALONE.
 * Installs the delegate on the late-binding ref + the plugin runtime.
 */
import { randomUUID } from "node:crypto";
import { BrowserWindow as BrowserWindowValue } from "electron";
import { createHookRunner } from "../conversation.js";
import { wireHookSystem } from "./hook-system-wiring.js";
import { ToolExecutor } from "../../tools/executor.js";
import { createPluginSurfacePermissionScope } from "../plugin-surface-permissions.js";
import { readPermissionSettings } from "../../permissions/permission-settings-store.js";
import { broadcastPermissionConfigChanged as broadcastPermissionConfigChangedFromIpc } from "../../ipc/domains/permissions.js";
// Confines-aware reader for the foreground plugin read-relaxation coupling. It
// reads the published active-sandbox capability snapshot plus the exact
// host-owned plugin worker registry (no asrt-sandbox.js import) and reports
// whether this tool's off-hostApi filesystem residuals are actually contained.
import { isActiveSandboxFilesystemContainedForPluginEffects } from "../../permissions/sandbox-capability.js";
import type { PluginToolInvocationContext } from "../../plugins/runtime.js";
import {
  currentInvocationOrigin,
  runWithInvocationOrigin,
} from "../../plugins/runtime/origin-chain.js";
import {
  dispatchAppOnlyRuntimeInvocation,
  isAppOnlyRuntimeInvocation,
} from "../plugin-tool-invocation.js";
import type { BootContext } from "../context.js";
import { resolvePluginOperationAccountHash } from "./plugin-operation-account.js";

function toPluginToolInput(payload: unknown): Record<string, unknown> {
  if (payload === undefined || payload === null) return {};
  if (typeof payload === "object" && !Array.isArray(payload)) {
    return payload as Record<string, unknown>;
  }
  return { payload };
}

function pluginInvocationSessionId(context: PluginToolInvocationContext): string {
  const subject = context.callerPluginId ?? context.ownerPluginId ?? "host";
  return `plugin-${context.origin}-${subject}`;
}

export async function setupPluginToolExecutor(ctx: BootContext): Promise<void> {
  const { toolRegistry, permissionManager, bashAstValidator, approvalGate, bootAuditLogger, settingsService, pluginRuntime, lateBinding, getMainWindow } = ctx;

  // In-process HookRunner kept for internal/test hook registration only.
  // Production external hooks flow through ScriptHookManager below so strict
  // quarantine + explicit user trust registration is the single path.
  const hookRunner = createHookRunner();

  // Permission policy P4 — Layer 6 script-hook system (individual `pre-*.sh` /
  // `post-*.sh` / `perm-*.sh` files under `~/.config/lvis/hooks/`).
  // Production boot has no renderer approval prompt: untrusted or changed hook
  // files are strict-denied and moved to `.disabled/`.
  const hookSystem = await wireHookSystem({ auditLogger: bootAuditLogger });
  const scriptHookManager = hookSystem.manager;

  // This executor is created before ConversationLoop and workspace IPC. Resolve
  // the lifecycle through the existing late-binding ref at approval time; an
  // unexpectedly early plugin invocation sees undefined and fails closed.
  const pluginSurfaceExecutor = new ToolExecutor(
    toolRegistry,
    hookRunner,
    permissionManager,
    bashAstValidator,
    approvalGate,
    scriptHookManager,
    bootAuditLogger,
    () => settingsService.get("features")?.hostClassifiesRisk ?? false,
    // Couple the foreground plugin read-relaxation to the concrete tool's
    // worker-backed filesystem containment. The relaxation relies on the
    // effect-boundary, which only contains the off-hostApi `node:fs` WRITE
    // residual when this exact plugin worker is ASRT-wrapped; ordinary plugin
    // tools, degraded hosts, and sandbox-off hosts return false so the pre-exec
    // ask stands (see ToolExecutor.sandboxFsContainedProvider).
    isActiveSandboxFilesystemContainedForPluginEffects,
    () => lateBinding.conversationLoopRef.fn?.deps.workspaceRootLifecycle,
    undefined,
    () => ctx.pluginBundleLifecycle,
  );
  const pluginSurfacePermissionScope = createPluginSurfacePermissionScope({
    readPersistedDirectories: () => readPermissionSettings().permissions.additionalDirectories,
    onSessionDirectoryAdded: () => {
      broadcastPermissionConfigChangedFromIpc({ getMainWindow, getAppWindows: () => BrowserWindowValue.getAllWindows() } as Parameters<typeof broadcastPermissionConfigChangedFromIpc>[0]);
    },
  });
  const observePluginAuthResult = (
    pluginId: string,
    generationId: string,
    toolName: string,
    result: unknown,
    invocationEpoch: number | undefined,
  ): void => {
    const observed = pluginRuntime.observePluginAuthResult(
      pluginId,
      generationId,
      toolName,
      result,
      invocationEpoch,
    );
    if (observed.invalidatedAccountHash) {
      pluginSurfaceExecutor.revokePluginOperationAccount(
        pluginId,
        generationId,
        observed.invalidatedAccountHash,
      );
    }
  };
  const invokePluginTool = async (
    toolName: string,
    payload: unknown,
    context: PluginToolInvocationContext,
  ): Promise<unknown> => {
    // Issue #664 P2 — origin-chain propagation. Enter an AsyncLocalStorage
    // frame so nested ctx.callTool(...) invocations from a wrapper handler
    // inherit the outermost origin. `parentOrigin` is the explicit handoff
    // (e.g. tests / future bridges that want to pin the chain start); the
    // ambient chain (set by an outer invokePluginTool) takes precedence over a
    // bare "plugin" current so a UI→wrapper→inner chain stays UI all the way
    // down. `runWithInvocationOrigin` owns that precedence (least-trusted wins:
    // mcp-app > ui > plugin), so an MCP-App-rooted chain likewise stays
    // "mcp-app" at every depth and can never be laundered into "ui".
    return runWithInvocationOrigin(context.origin, context.parentOrigin, async () => {
      const effectiveOrigin = currentInvocationOrigin() ?? context.origin;
      const ownerPluginId = context.ownerPluginId;
      const ownerGenerationId = context.ownerGenerationId;
      // Claim auth publication order before either dispatch path awaits plugin
      // code. A later status/login/logout invocation supersedes this
      // completion even when the older handler resolves last.
      const authInvocation = ownerPluginId && ownerGenerationId
        ? pluginRuntime.beginPluginAuthInvocation(
            ownerPluginId,
            ownerGenerationId,
            toolName,
          )
        : undefined;
      if (
        ownerPluginId &&
        ownerGenerationId &&
        authInvocation?.invalidatedAccountHash
      ) {
        pluginSurfaceExecutor.revokePluginOperationAccount(
          ownerPluginId,
          ownerGenerationId,
          authInvocation.invalidatedAccountHash,
        );
      }
      const authInvocationEpoch = authInvocation?.epoch;
      if (isAppOnlyRuntimeInvocation(pluginRuntime, toolName, context, effectiveOrigin)) {
        // App-only dispatch path — TRUSTED PANEL ONLY (`effectiveOrigin === "ui"`;
        // an "mcp-app" chain never satisfies the predicate). Routes to the runtime
        // handler directly, skipping the ToolExecutor and its Step-6 ceiling. The
        // governed `runWithCeiling` cap is NOT re-added here: it is enforced
        // STRUCTURALLY inside `PluginRuntime.callDeclaredAppOnlyTool` (the sole
        // entry point of the bypass), so a hung app-only handler cannot block
        // the renderer caller even if this dispatch is ever reverted to a
        // direct `pluginRuntime.callDeclaredAppOnlyTool(...)` call. The
        // user-activation gate + the #1556 nested-origin error live in
        // `dispatchAppOnlyRuntimeInvocation`.
        const result = await dispatchAppOnlyRuntimeInvocation(
          pluginRuntime,
          toolName,
          toPluginToolInput(payload),
          context,
        );
        if (context.ownerPluginId && context.ownerGenerationId) {
          observePluginAuthResult(
            context.ownerPluginId,
            context.ownerGenerationId,
            toolName,
            result,
            authInvocationEpoch,
          );
        }
        return result;
      }

      const appInvocation = context.appInvocation;
      const activeGeneration = ownerPluginId
        ? ctx.pluginBundleLifecycle?.getActive(ownerPluginId)
        : undefined;
      const invocationGeneration = ownerPluginId && context.ownerGenerationId &&
        activeGeneration?.generationId === context.ownerGenerationId
        ? activeGeneration
        : undefined;
      const manifest = invocationGeneration?.manifest;
      const accountHash = ownerPluginId && context.ownerGenerationId
        ? resolvePluginOperationAccountHash(
            pluginRuntime,
            manifest,
            ownerPluginId,
            context.ownerGenerationId,
          )
        : undefined;
      const pluginOperation = appInvocation && ownerPluginId && manifest && invocationGeneration && accountHash
        ? {
            ownerVersion: manifest.version,
            generationId: invocationGeneration.generationId,
            appSessionId: appInvocation.sessionId,
            accountHash,
            ...(appInvocation.operationGrantToken
              ? { grantToken: appInvocation.operationGrantToken }
              : {}),
          }
        : undefined;

      const [result] = await pluginSurfaceExecutor.executeAll(
        [{
          id: randomUUID(),
          name: toolName,
          input: toPluginToolInput(payload),
        }],
        {
          sessionId: pluginInvocationSessionId(context),
          permissionContext: pluginSurfacePermissionScope.createPermissionContext(context, {
            // headless follows the *effective* chain origin (#664 P2):
            // a UI-rooted chain keeps `headless: false` even after one or
            // more `ctx.callTool` hops, so the user's outer approval is
            // honoured and the reviewer lane is not re-engaged. An MCP-App
            // chain is foreground too — the user is looking at the card and CAN
            // be asked — so only a plugin/LLM-emitted chain is headless. (This
            // is exactly the lane an app call had when it dispatched as "ui";
            // splitting the origin changed WHO may reach the ungoverned bypass,
            // not whether a card's governed call can prompt the user.)
            headless: effectiveOrigin === "plugin",
            trustOrigin: "plugin-emitted",
            // The user-gesture credit is the trusted PANEL's alone: an "mcp-app"
            // chain never carries `userAction` (callFromApp does not accept one),
            // and the explicit origin check keeps that true even if it ever did.
            pluginPanelUserAction: effectiveOrigin === "ui" && context.userAction === true,
            ...(pluginOperation ? { pluginOperation } : {}),
            ...(context.expectedMcpServerId
              ? { expectedMcpServerId: context.expectedMcpServerId }
              : {}),
          }),
        },
      );
      if (!result) {
        throw new Error(`Plugin tool '${toolName}' produced no executor result`);
      }
      if (result.is_error) {
        throw new Error(result.content);
      }
      if (Object.prototype.hasOwnProperty.call(result, "rawResult")) {
        if (ownerPluginId && context.ownerGenerationId) {
          observePluginAuthResult(
            ownerPluginId,
            context.ownerGenerationId,
            toolName,
            result.rawResult,
            authInvocationEpoch,
          );
        }
        return result.rawResult;
      }
      if (ownerPluginId && context.ownerGenerationId) {
        observePluginAuthResult(
          ownerPluginId,
          context.ownerGenerationId,
          toolName,
          result.content,
          authInvocationEpoch,
        );
      }
      return result.content;
    });
  };
  lateBinding.pluginToolInvokerRef.fn = invokePluginTool;
  pluginRuntime.setToolInvocationDelegate(invokePluginTool);

  ctx.requestPluginOperationGrant = async ({
    pluginId,
    toolName,
    input,
    appSessionId,
    origin = "ui",
    expectedGenerationId,
  }) => {
    const lifecycle = ctx.pluginBundleLifecycle;
    if (!lifecycle) {
      throw new Error("[plugin-operation-policy] active plugin generation is missing");
    }
    const generationLease = expectedGenerationId
      ? await lifecycle.acquireExact(pluginId, expectedGenerationId)
      : await lifecycle.acquire(pluginId);
    try {
      return await lifecycle.runWithLease(generationLease, async () => {
        const activeGeneration = generationLease.generation;
        const manifest = activeGeneration.state.runtime.manifest;
        const accountHash = resolvePluginOperationAccountHash(
          pluginRuntime,
          manifest,
          pluginId,
          activeGeneration.generationId,
        );
        if (!accountHash) {
          throw new Error("[plugin-operation-policy] fresh authenticated account status is required");
        }
        const principal = {
          ownerPluginId: pluginId,
          ownerVersion: manifest.version,
          generationId: activeGeneration.generationId,
          appSessionId,
          accountHash,
        };
        const inspected = pluginSurfaceExecutor.inspectPluginOperationGrant({
          toolName,
          input,
          principal,
          origin,
        });
        const decision = await approvalGate.requestAndWait({
          id: randomUUID(),
          category: "tool",
          kind: "tool",
          allowedChoices: ["allow-once", "deny-once"],
          toolName,
          toolCategory: "write",
          args: inspected.approvalArgs,
          reason: `Plugin '${pluginId}' requests one execution of '${inspected.operation}'`,
          source: "plugin",
          sourcePluginId: pluginId,
          approvalScope: `operation:${inspected.operation}`,
          trustOrigin: "user-keyboard",
          createdAt: Date.now(),
          forceExplicit: true,
          isReadOnly: false,
          mode: "default",
        });
        const governedTool = toolRegistry.findByName(toolName);
        if (!governedTool) {
          throw new Error(`[plugin-operation-policy] governed plugin tool '${toolName}' disappeared`);
        }
        if (decision.choice !== "allow-once") {
          await bootAuditLogger.appendPermissionAuditEntry({
            decision: "deny",
            ts: new Date().toISOString(),
            auditId: randomUUID(),
            tool: toolName,
            source: "plugin",
            category: governedTool.category,
            denyReasons: [{
              layer: 6,
              reason: "plugin operation grant denied by user",
              source: "plugin-operation-grant",
            }],
            trustOrigin: "user-keyboard",
            pluginOperation: {
              pluginId,
              operation: inspected.operation,
              outcome: "denied",
            },
          });
          throw new Error("[plugin-operation-policy] operation grant denied");
        }
        const ttlMs = 60_000;
        const issued = pluginSurfaceExecutor.issueInspectedPluginOperationGrant({
          toolName,
          principal,
          inspected,
          ttlMs,
        });
        try {
          await bootAuditLogger.appendPermissionAuditEntry({
            decision: "allow",
            ts: new Date().toISOString(),
            auditId: randomUUID(),
            tool: toolName,
            source: "plugin",
            category: governedTool.category,
            layer: 6,
            trustOrigin: "user-keyboard",
            pluginOperation: {
              pluginId,
              operation: inspected.operation,
              outcome: "issued",
              grantId: issued.grantId,
            },
          });
        } catch (error) {
          pluginSurfaceExecutor.revokePluginOperationSession(appSessionId);
          throw error;
        }
        return {
          operationGrantToken: issued.token,
          grantId: issued.grantId,
          expiresAt: Date.now() + ttlMs,
        };
      });
    } finally {
      generationLease.release();
    }
  };
  ctx.revokePluginOperationGeneration = (pluginId, generationId) => {
    pluginSurfaceExecutor.revokePluginOperationGeneration(pluginId, generationId);
  };
  ctx.revokePluginOperationSession = (appSessionId) => {
    pluginSurfaceExecutor.revokePluginOperationSession(appSessionId);
  };

  ctx.hookRunner = hookRunner;
  ctx.scriptHookManager = scriptHookManager;
}
