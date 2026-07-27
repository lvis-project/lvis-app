import { resolveDependencies } from "../dependency-resolver.js";
import type { PluginManifest } from "../types.js";

/**
 * Resolves capability providers from runtime generations that are actually
 * admitted. A manifest being installed, registry-enabled, or merely loaded is
 * not sufficient: its provider must have completed startup and published an
 * active generation before another plugin can rely on its capabilities.
 */
export class CapabilityDependencies {
  constructor(
    private readonly manifests: ReadonlyMap<string, PluginManifest>,
    private readonly isActive: (pluginId: string) => boolean,
  ) {}

  activeManifests(excludePluginIds: readonly string[] = []): PluginManifest[] {
    const excluded = new Set(excludePluginIds);
    return [...this.manifests.entries()]
      .filter(([pluginId]) =>
        !excluded.has(pluginId)
        && this.isActive(pluginId),
      )
      .map(([, manifest]) => manifest);
  }

  missing(
    manifest: PluginManifest,
    additionallyUnavailablePluginIds: readonly string[] = [],
  ): string[] {
    const requiredCapabilities = manifest.requires?.capabilities ?? [];
    if (requiredCapabilities.length === 0) return [];
    const result = resolveDependencies(
      requiredCapabilities,
      this.activeManifests([
        manifest.id,
        ...additionallyUnavailablePluginIds,
      ]),
    );
    return result.ok ? [] : result.missing;
  }
}
