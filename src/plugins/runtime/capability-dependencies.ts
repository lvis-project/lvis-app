import { resolveDependencies } from "../dependency-resolver.js";
import type { PluginManifest } from "../types.js";

/** Resolves capability providers from the runtime's installed enabled state. */
export class CapabilityDependencies {
  constructor(
    private readonly manifests: ReadonlyMap<string, PluginManifest>,
    private readonly inactivePluginIds: ReadonlySet<string>,
    private readonly disabledPluginIds: ReadonlySet<string>,
  ) {}

  enabledManifests(excludePluginId: string): PluginManifest[] {
    return [...this.manifests.entries()]
      .filter(([pluginId]) =>
        pluginId !== excludePluginId
        && !this.inactivePluginIds.has(pluginId)
        && !this.disabledPluginIds.has(pluginId),
      )
      .map(([, manifest]) => manifest);
  }

  missing(manifest: PluginManifest): string[] {
    const requiredCapabilities = manifest.requires?.capabilities ?? [];
    if (requiredCapabilities.length === 0) return [];
    const result = resolveDependencies(requiredCapabilities, this.enabledManifests(manifest.id));
    return result.ok ? [] : result.missing;
  }
}
