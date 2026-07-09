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
