import {
  type PluginRuntime,
  type PluginToolInvocationContext,
} from "../plugins/runtime.js";
import { isUiOnly, isModelVisible } from "../plugins/runtime/tool-visibility.js";

type RuntimeManifestView = Pick<PluginRuntime, "listPluginManifests">;

type AppOnlyRuntimeView = Pick<
  PluginRuntime,
  "listPluginManifests" | "callDeclaredAppOnlyTool"
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

export function isAppOnlyRuntimeInvocation(
  pluginRuntime: RuntimeManifestView,
  toolName: string,
  context: PluginToolInvocationContext,
  effectiveOrigin: "plugin" | "ui" | undefined,
): boolean {
  // #1556 — an LLM-origin ("plugin") call to ANY visibility ALWAYS takes the
  // governed executor; the ungoverned bypass is unreachable from the model.
  if (effectiveOrigin !== "ui") return false;

  const manifest = findOwnerManifest(pluginRuntime, context.ownerPluginId);
  if (!manifest) return false;
  // #885 v6 — single-source predicate: ONE array read on ONE object. `isUiOnly`
  // (SoT §2.3) = `app ∈ vis ∧ model ∉ vis`, the bit-identical restatement of the
  // old `declaredUiInvokableMethods(m).includes(name) ∧ tools[].includes(name) !==
  // true` conjunction. A model-visible tool (model-only or dual) is isUiOnly=false
  // → governed (the load-bearing #1554 rule; "model wins" for dual).
  const tool = manifest.tools.find((t) => t.name === toolName);
  return tool != null && isUiOnly(tool);
}

export function appOnlyRuntimeInvocationRequiresUserAction(
  pluginRuntime: RuntimeManifestView,
  toolName: string,
  context: PluginToolInvocationContext,
): boolean {
  const manifest = findOwnerManifest(pluginRuntime, context.ownerPluginId);
  if (!manifest) return true;
  return manifest.auth?.statusTool !== toolName;
}

/**
 * Dispatch an app-only runtime invocation — an app-only-visibility method
 * (`_meta.ui.visibility === ["app"]`, so app-visible but NOT model-visible),
 * reached on a UI-effective chain. The caller (`plugin-tool-executor.ts`) has
 * already established via {@link isAppOnlyRuntimeInvocation} that `toolName` is
 * an app-only-visibility method before delegating here.
 *
 * Responsibility: enforce the user-activation requirement for non-status
 * app-only methods (and the #1556 nested plugin-origin clarity error), then
 * delegate to `PluginRuntime.callDeclaredAppOnlyTool`.
 *
 * The global tool-execution ceiling is NOT applied here. It now lives
 * STRUCTURALLY inside `PluginRuntime.callDeclaredAppOnlyTool` — the sole entry
 * point of the app-only dispatch path — so a hung app-only handler cannot block
 * the renderer caller forever regardless of how boot wires this dispatch
 * (CLAUDE.md §Tool Execution Timeout Policy: every tool path passes through
 * `runWithCeiling`). Relocating the ceiling to the runtime method closes the
 * regression class where a future revert of the boot wiring back to a direct
 * `callDeclaredAppOnlyTool` call would silently drop the cap. See
 * `callDeclaredAppOnlyTool`'s abort-parity note for why the ceiling only
 * unblocks the caller and does not abort the detached handler work.
 */
export async function dispatchAppOnlyRuntimeInvocation(
  pluginRuntime: AppOnlyRuntimeView,
  toolName: string,
  input: Record<string, unknown>,
  context: PluginToolInvocationContext,
): Promise<unknown> {
  // Defense-in-depth (cluster-review security LOW): this function is exported
  // and trusts its caller to have routed here via `isAppOnlyRuntimeInvocation`,
  // which fail-closes a model-visible tool to the governed ToolExecutor path.
  // Re-assert that app-only invariant at the boundary itself so a future caller
  // that forgets the predicate cannot smuggle a governed tool through the
  // reviewer-skipping app-only dispatch bypass. Cheap: the same owner manifest
  // resolution the gate below already performs.
  const ownerManifest = findOwnerManifest(pluginRuntime, context.ownerPluginId);
  // #885 v6 — a MODEL-visible tool (model-only OR dual) must never take the
  // ungoverned app-only dispatch path. Refuse to route any model-visible tool
  // through the bypass, so a future caller that forgets
  // `isAppOnlyRuntimeInvocation` cannot smuggle a governed tool here.
  const ownerTool = ownerManifest?.tools.find((t) => t.name === toolName);
  if (ownerTool && isModelVisible(ownerTool)) {
    throw new Error(
      `'${toolName}' is a model-visible tool; refusing ungoverned app-only dispatch`,
    );
  }
  if (
    appOnlyRuntimeInvocationRequiresUserAction(pluginRuntime, toolName, context) &&
    context.userAction !== true
  ) {
    // #1556 — A nested `ctx.callTool` reaches here with `context.origin ===
    // "plugin"` (HostApi.callTool builds the inner context with `origin:
    // "plugin"` and never forwards `userAction`), even though the UI-rooted
    // chain's *effective* origin is "ui". Such a call can NEVER satisfy the
    // user-activation requirement for an app-only-visibility non-status method,
    // and forwarding userAction through HostApi.callTool is intentionally out of
    // scope (that would be building the nested mechanism, which no shipped
    // first-party plugin uses). Throw an error that names the real manifest
    // constraint instead of the generic activation error, which misleads the
    // plugin author into thinking a missing user gesture is the problem.
    // The genuine direct-UI-without-activation case (`origin: "ui"`) keeps the
    // user-activation error. See origin-chain.ts + architecture.md §9.4a.
    if (context.origin === "plugin") {
      throw new Error(
        `'${toolName}' is an app-only-visibility method (_meta.ui.visibility:["app"]) and cannot be ` +
          `invoked from a plugin-origin ctx.callTool — give it model visibility ` +
          `(_meta.ui.visibility including "model") for governed model/plugin invocation, or drive it ` +
          `from a direct UI activation`,
      );
    }
    throw new Error(`UI action '${toolName}' requires an active user activation`);
  }
  // The global tool-execution ceiling is enforced structurally inside
  // `callDeclaredAppOnlyTool` (see its docstring) — not here — so this dispatch
  // stays a thin gate.
  return pluginRuntime.callDeclaredAppOnlyTool(toolName, input);
}
