import {
  declaredUiInvokableMethods,
  type PluginRuntime,
  type PluginToolInvocationContext,
} from "../plugins/runtime.js";

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
 * Responsibility: enforce the user-activation requirement for non-status
 * uiActions (and the #1556 nested plugin-origin clarity error), then delegate
 * to `PluginRuntime.callDeclaredUiAction`.
 *
 * The global tool-execution ceiling is NOT applied here. It now lives
 * STRUCTURALLY inside `PluginRuntime.callDeclaredUiAction` — the sole entry
 * point of the uiActions bypass — so a hung uiActions handler cannot block the
 * renderer caller forever regardless of how boot wires this dispatch (CLAUDE.md
 * §Tool Execution Timeout Policy: every tool path passes through
 * `runWithCeiling`). Relocating the ceiling to the runtime method closes the
 * regression class where a future revert of the boot wiring back to a direct
 * `callDeclaredUiAction` call would silently drop the cap. See
 * `callDeclaredUiAction`'s abort-parity note for why the ceiling only unblocks
 * the caller and does not abort the detached handler work.
 */
export async function dispatchUiOnlyRuntimeInvocation(
  pluginRuntime: UiOnlyRuntimeView,
  toolName: string,
  input: Record<string, unknown>,
  context: PluginToolInvocationContext,
): Promise<unknown> {
  // Defense-in-depth (cluster-review security LOW): this function is exported
  // and trusts its caller to have routed here via `isUiOnlyRuntimeInvocation`,
  // which fail-closes a `tools[]`-declared method to the governed ToolExecutor
  // path. Re-assert that not-in-tools[] invariant at the boundary itself so a
  // future caller that forgets the predicate cannot smuggle a governed tool
  // through the reviewer-skipping uiActions bypass. Cheap: the same owner
  // manifest resolution the gate below already performs.
  const ownerManifest = findOwnerManifest(pluginRuntime, context.ownerPluginId);
  if (ownerManifest?.tools?.includes(toolName) === true) {
    throw new Error(
      `'${toolName}' is a tools[] method; refusing ungoverned uiActions dispatch`,
    );
  }
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
  // The global tool-execution ceiling is enforced structurally inside
  // `callDeclaredUiAction` (see its docstring) — not here — so this dispatch
  // stays a thin gate.
  return pluginRuntime.callDeclaredUiAction(toolName, input);
}
