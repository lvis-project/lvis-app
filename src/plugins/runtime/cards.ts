/**
 * Plugin catalog card construction (Option C).
 *
 * `buildPluginCard` is a pure projection of a manifest + resolved runtime
 * state into the `PluginCard` shape consumed by the marketplace/settings UI.
 * The runtime resolves load-status, visibility, preparation status, and
 * install aliases, then delegates the shaping here.
 */
import type { PluginManifest } from "../types.js";
import { normalizeInstallPolicy } from "./manifest-validation.js";
import { isModelVisible } from "./tool-visibility.js";
import type { PluginCard, PluginPreparationStatus } from "./index.js";

export function buildPluginCard(
  pluginId: string,
  manifest: PluginManifest,
  loadStatus: PluginCard["loadStatus"],
  visibleNames: Set<string> | null,
  state: { active: boolean; runtimeLoaded: boolean },
  extras: {
    preparationStatus: PluginPreparationStatus | undefined;
    installAliases: string[] | undefined;
  },
): PluginCard {
  // #885 v6 — the card stays LLM-facing: model-visible tools only. `visibleNames`
  // (the ToolRegistry-visible set) is itself model-facing, so the pre-filter is a
  // no-op when it is provided; it matters for the `visibleNames === null` fallback
  // (listPluginCards with no registry), keeping app-only auth tools from surfacing
  // as "tools" in the settings/marketplace UI (they are app-only-visibility, not
  // model-facing).
  const modelTools = (manifest.tools ?? []).filter(isModelVisible);
  const filteredTools = !state.active
    ? []
    : visibleNames
    ? modelTools.filter((t) => visibleNames.has(t.name))
    : modelTools;
  const filteredNames = filteredTools.map((t) => t.name);
  const sampleTools = filteredNames.slice(0, 3);
  let description: string;
  if (manifest.description) {
    description = manifest.description;
  } else {
    // v6: `toolSchemas` is gone — fall back to the first-3 tools' own descriptions.
    const parts = filteredTools
      .slice(0, 3)
      .map((t) => t.description)
      .filter((d): d is string => !!d);
    description = parts.length > 0 ? parts.join(" / ") : `Plugin: ${manifest.name}`;
  }
  const toolDescriptions: Record<string, string> = {};
  for (const t of filteredTools) {
    if (t.description) toolDescriptions[t.name] = t.description;
  }
  const uiExtensions = manifest.ui?.filter((extension) => extension.slot === "sidebar");
  return {
    id: pluginId,
    name: manifest.name ?? manifest.id,
    description,
    sampleTools,
    tools: filteredNames,
    capabilities: manifest.capabilities ?? [],
    toolDescriptions: Object.keys(toolDescriptions).length > 0 ? toolDescriptions : undefined,
    isManaged: normalizeInstallPolicy(manifest) === "admin",
    installPolicy: manifest.installPolicy ?? "user",
    loadStatus,
    active: state.active,
    runtimeLoaded: state.runtimeLoaded,
    preparationStatus: loadStatus === "preparing" ? extras.preparationStatus : undefined,
    icon: manifest.icon,
    iconText: manifest.iconText,
    uiExtensions: uiExtensions && uiExtensions.length > 0 ? uiExtensions : undefined,
    version: manifest.version,
    publisher: manifest.publisher,
    configSchema: manifest.configSchema,
    auth: manifest.auth,
    networkAccess: manifest.networkAccess,
    installAliases: extras.installAliases,
  };
}
