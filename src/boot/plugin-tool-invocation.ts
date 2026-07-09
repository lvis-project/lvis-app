import {
  declaredUiInvokableMethods,
  type PluginRuntime,
  type PluginToolInvocationContext,
} from "../plugins/runtime.js";
import { runWithCeiling } from "../tools/executor-ceiling.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";

type RuntimeManifestView = Pick<PluginRuntime, "listPluginManifests">;

type UiOnlyRuntimeView = Pick<
  PluginRuntime,
  "listPluginManifests" | "callDeclaredUiAction"
>;

function findOwnerManifest(
  pluginRuntime: RuntimeManifestView,
  ownerPluginId: string | undefined,
) {
  if (!ownerPluginId) return undefined;
  return pluginRuntime
    .listPluginManifests()
    .find((candidate) => candidate.pluginId === ownerPluginId)
    ?.manifest;
}

export function isUiOnlyRuntimeInvocation(
  pluginRuntime: RuntimeManifestView,
  toolName: string,
  context: PluginToolInvocationContext,
  effectiveOrigin: "plugin" | "ui" | undefined,
): boolean {
  if (effectiveOrigin !== "ui") return false;

  const manifest = findOwnerManifest(pluginRuntime, context.ownerPluginId);
  return manifest != null
    && declaredUiInvokableMethods(manifest).includes(toolName)
    && manifest.tools?.includes(toolName) !== true;
}

export function uiOnlyRuntimeInvocationRequiresUserAction(
  pluginRuntime: RuntimeManifestView,
  toolName: string,
  context: PluginToolInvocationContext,
): boolean {
  const manifest = findOwnerManifest(pluginRuntime, context.ownerPluginId);
  if (!manifest) return true;
  return manifest.auth?.statusTool !== toolName;
}

/**
 * Dispatch a UI-only runtime invocation — a method declared in `uiActions`
 * but NOT `tools[]`, reached on a UI-effective chain. The caller
 * (`plugin-tool-executor.ts`) has already established via
 * {@link isUiOnlyRuntimeInvocation} that `toolName` is a uiActions-only method
 * before delegating here.
 *
 * Two responsibilities:
 *   1. Enforce the user-activation requirement for non-status uiActions.
 *   2. Run the runtime handler under the global tool-execution ceiling so a
 *      hung uiActions handler cannot block the renderer caller forever. This
 *      is the same governed-timeout guarantee the ToolExecutor path enforces —
 *      the UI-only bypass must NOT skip it (CLAUDE.md §Tool Execution Timeout
 *      Policy: every tool path passes through `runWithCeiling`).
 *
 * Ceiling parity note (CLAUDE.md "ceiling 에 Promise.race 만 쓰고 AbortController
 * 안 wire" caveat): the governed executor path (ToolExecutor.executeAll →
 * plugin loopback `tools/call` → PluginRuntime.call → `handler(payload)`) does
 * NOT propagate its abort signal into the plugin handler — the handler
 * receives only `payload`, never a signal (see mcp/plugin-tool-from-mcp.ts
 * `execute()` and PluginRuntime.call). Its ceiling therefore only unblocks the
 * *caller*, leaving a hung handler's work detached. We match that exact parity
 * here: ceiling the caller so the renderer is never stuck, and do NOT invent a
 * handler-abort mechanism the executor path itself lacks. `ceilingMs` defaults
 * to the SOT; it is a parameter solely so tests can exercise the ceiling with a
 * small value without weakening the SOT.
 */
export async function dispatchUiOnlyRuntimeInvocation(
  pluginRuntime: UiOnlyRuntimeView,
  toolName: string,
  input: Record<string, unknown>,
  context: PluginToolInvocationContext,
  ceilingMs: number = TOOL_TIMEOUT_POLICY.globalCeilingMs,
): Promise<unknown> {
  if (
    uiOnlyRuntimeInvocationRequiresUserAction(pluginRuntime, toolName, context) &&
    context.userAction !== true
  ) {
    // #1556 — A nested `ctx.callTool` reaches here with `context.origin ===
    // "plugin"` (HostApi.callTool builds the inner context with `origin:
    // "plugin"` and never forwards `userAction`), even though the UI-rooted
    // chain's *effective* origin is "ui". Such a call can NEVER satisfy the
    // user-activation requirement for a uiActions-only non-status method, and
    // forwarding userAction through HostApi.callTool is intentionally out of
    // scope (that would be building the nested mechanism, which no shipped
    // first-party plugin uses). Throw an error that names the real manifest
    // constraint instead of the generic activation error, which misleads the
    // plugin author into thinking a missing user gesture is the problem.
    // The genuine direct-UI-without-activation case (`origin: "ui"`) keeps the
    // user-activation error. See origin-chain.ts + architecture.md §9.4a.
    if (context.origin === "plugin") {
      throw new Error(
        `'${toolName}' is a uiActions-only method and cannot be invoked from a plugin-origin ` +
          `ctx.callTool (declare it in tools[] for governed model/plugin invocation, or drive it ` +
          `from a direct UI activation)`,
      );
    }
    throw new Error(`UI action '${toolName}' requires an active user activation`);
  }
  const outcome = await runWithCeiling(
    () => pluginRuntime.callDeclaredUiAction(toolName, input),
    ceilingMs,
    undefined,
    toolName,
  );
  if (!outcome.ok) {
    throw outcome.error;
  }
  return outcome.value;
}
