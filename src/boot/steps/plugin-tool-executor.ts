/**
 * Boot step — plugin tool execution surface (permission policy P4 Layer 6 +
 * §8, extracted from boot.ts C18).
 *
 * Builds the in-process HookRunner, the script-hook system, the plugin-surface
 * ToolExecutor (with the sandbox-filesystem-contained relaxation coupling), the
 * plugin-surface permission scope, and the `invokePluginTool` delegate that
 * routes plugin/UI-origin tool calls through the executor (UI-only runtime
 * invocations skip straight to the runtime). Installs the delegate on the late-
 * binding ref + the plugin runtime.
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
// reads the published active-sandbox capability snapshot (no asrt-sandbox.js
// import) and reports whether plugin off-hostApi filesystem residuals are
// actually contained. Windows plugin workers stay fail-closed under ASRT until
// worker-scoped filesystem grants exist, so this provider deliberately excludes
// the generic Windows host-shell filesystem signal.
import { isActiveSandboxFilesystemContainedForPluginEffects } from "../../permissions/sandbox-capability.js";
import type { PluginToolInvocationContext } from "../../plugins/runtime.js";
import {
  currentInvocationOrigin,
  runWithInvocationOrigin,
} from "../../plugins/runtime/origin-chain.js";
import {
  isUiOnlyRuntimeInvocation,
  uiOnlyRuntimeInvocationRequiresUserAction,
} from "../plugin-tool-invocation.js";
import type { BootContext } from "../context.js";

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

  const pluginSurfaceExecutor = new ToolExecutor(
    toolRegistry,
    hookRunner,
    permissionManager,
    bashAstValidator,
    approvalGate,
    scriptHookManager,
    bootAuditLogger,
    () => settingsService.get("features")?.hostClassifiesRisk ?? false,
    // Couple the foreground plugin read-relaxation to the active OS sandbox
    // FILESYSTEM-CONTAINING the host (evaluated per tool-call, after boot's
    // sandbox gate has run + published the active capability). The relaxation
    // relies on the effect-boundary, which only contains the off-hostApi
    // `node:fs` WRITE residual when the sandbox filesystem-contains; a degraded
    // or sandbox-off host (`confines.filesystem !== true`) returns false here so
    // the pre-exec ask stands (see
    // ToolExecutor.sandboxFsContainedProvider).
    isActiveSandboxFilesystemContainedForPluginEffects,
  );
  const pluginSurfacePermissionScope = createPluginSurfacePermissionScope({
    readPersistedDirectories: () => readPermissionSettings().permissions.additionalDirectories,
    onSessionDirectoryAdded: () => {
      broadcastPermissionConfigChangedFromIpc({ getMainWindow, getAppWindows: () => BrowserWindowValue.getAllWindows() } as Parameters<typeof broadcastPermissionConfigChangedFromIpc>[0]);
    },
  });
  const invokePluginTool = async (
    toolName: string,
    payload: unknown,
    context: PluginToolInvocationContext,
  ): Promise<unknown> => {
    // Issue #664 P2 — UI-origin chain propagation. Enter an
    // AsyncLocalStorage frame so nested ctx.callTool(...) invocations from
    // a wrapper handler inherit the outermost UI origin. `parentOrigin`
    // is the explicit handoff (e.g. tests / future bridges that want to
    // pin the chain start); the ambient chain (set by an outer
    // invokePluginTool) takes precedence over a bare "plugin" current so
    // a UI→wrapper→inner chain stays UI all the way down.
    return runWithInvocationOrigin(context.origin, context.parentOrigin, async () => {
      const effectiveOrigin = currentInvocationOrigin() ?? context.origin;
      if (isUiOnlyRuntimeInvocation(pluginRuntime, toolName, context, effectiveOrigin)) {
        if (
          uiOnlyRuntimeInvocationRequiresUserAction(pluginRuntime, toolName, context) &&
          context.userAction !== true
        ) {
          throw new Error(`UI action '${toolName}' requires an active user activation`);
        }
        return pluginRuntime.callDeclaredUiAction(toolName, toPluginToolInput(payload));
      }

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
            // honoured and the reviewer lane is not re-engaged.
            headless: effectiveOrigin !== "ui",
            trustOrigin: "plugin-emitted",
            pluginPanelUserAction: effectiveOrigin === "ui" && context.userAction === true,
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
        return result.rawResult;
      }
      return result.content;
    });
  };
  lateBinding.pluginToolInvokerRef.fn = invokePluginTool;
  pluginRuntime.setToolInvocationDelegate(invokePluginTool);

  ctx.hookRunner = hookRunner;
  ctx.scriptHookManager = scriptHookManager;
}
