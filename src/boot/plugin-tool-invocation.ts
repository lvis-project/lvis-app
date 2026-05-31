import type { PluginRuntime, PluginToolInvocationContext } from "../plugins/runtime.js";

type RuntimeManifestView = Pick<PluginRuntime, "listPluginManifests">;

export function isUiOnlyRuntimeInvocation(
  pluginRuntime: RuntimeManifestView,
  toolName: string,
  context: PluginToolInvocationContext,
  effectiveOrigin: "plugin" | "ui" | undefined,
): boolean {
  if (effectiveOrigin !== "ui") return false;

  const ownerPluginId = context.ownerPluginId;
  if (!ownerPluginId) return false;

  const entry = pluginRuntime
    .listPluginManifests()
    .find((candidate) => candidate.pluginId === ownerPluginId);
  const manifest = entry?.manifest;
  return manifest?.uiCallable?.includes(toolName) === true
    && manifest.tools?.includes(toolName) !== true;
}
