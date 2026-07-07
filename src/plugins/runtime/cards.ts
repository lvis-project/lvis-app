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
  const allTools = manifest.tools ?? [];
  const filteredTools = !state.active
    ? []
    : visibleNames
    ? allTools.filter((t) => visibleNames.has(t))
    : allTools;
  const sampleTools = filteredTools.slice(0, 3);
  let description: string;
  if (manifest.description) {
    description = manifest.description;
  } else {
    const schemas = manifest.toolSchemas;
    if (schemas) {
      const parts: string[] = [];
      for (const toolName of sampleTools) {
        const desc = schemas[toolName]?.description;
        if (desc) parts.push(desc);
      }
      description = parts.length > 0 ? parts.join(" / ") : `Plugin: ${manifest.name}`;
    } else {
      description = `Plugin: ${manifest.name}`;
    }
  }
  const toolDescriptions: Record<string, string> = {};
  if (manifest.toolSchemas) {
    for (const toolName of filteredTools) {
      const desc = manifest.toolSchemas[toolName]?.description;
      if (desc) toolDescriptions[toolName] = desc;
    }
  }
  const uiExtensions = manifest.ui?.filter((extension) => extension.slot === "sidebar");
  return {
    id: pluginId,
    name: manifest.name,
    description,
    sampleTools,
    tools: filteredTools,
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
