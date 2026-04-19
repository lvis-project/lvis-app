/**
 * S8 — Plugin Update Detector
 *
 * Compares catalog latest versions against installed plugin versions
 * by reading each installed manifest from the registry. Returns only
 * plugins where a newer version is available in the catalog.
 *
 * Feature flag: LVIS_MARKETPLACE_UPDATE_CHECK (default ON).
 * Set to "0" or "false" to disable the check entirely.
 */
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve, dirname } from "node:path";
import type { MarketplaceFetcher } from "./marketplace-fetcher.js";
import { readPluginRegistry } from "./registry.js";

export interface UpdateInfo {
  pluginId: string;
  installedVersion: string;
  latestVersion: string;
}

/**
 * Returns true when the update-check feature flag is enabled.
 * Default ON — set LVIS_MARKETPLACE_UPDATE_CHECK=0 to opt out.
 */
export function isUpdateCheckEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.LVIS_MARKETPLACE_UPDATE_CHECK;
  if (v === undefined) return true; // default ON
  return v !== "0" && v.toLowerCase() !== "false";
}

export interface UpdateDetectorOptions {
  /** When true, canary catalog entries are included in update notifications. Default false. */
  canaryOptIn?: boolean;
}

export class PluginUpdateDetector {
  private readonly canaryOptIn: boolean;

  constructor(
    private readonly registryPath: string,
    private readonly fetcher: MarketplaceFetcher,
    options: UpdateDetectorOptions = {},
  ) {
    this.canaryOptIn = options.canaryOptIn ?? false;
  }

  /**
   * Checks every installed plugin against the catalog.
   * Returns an array of plugins that have a newer version available.
   * Never throws — errors are logged and an empty array is returned.
   */
  async checkForUpdates(): Promise<UpdateInfo[]> {
    try {
      const [registry, catalogPlugins] = await Promise.all([
        readPluginRegistry(this.registryPath),
        this.fetcher.listPlugins(),
      ]);

      const updates: UpdateInfo[] = [];

      for (const entry of registry.plugins) {
        const installedVersion = await this.readInstalledVersion(entry.manifestPath);
        if (!installedVersion) continue;

        const catalogEntry = catalogPlugins.find((p) => p.id === entry.id);
        if (!catalogEntry?.version) continue;

        // Skip canary entries unless user opted in
        if (catalogEntry.channel === "canary" && !this.canaryOptIn) continue;

        if (isNewer(catalogEntry.version, installedVersion)) {
          updates.push({
            pluginId: entry.id,
            installedVersion,
            latestVersion: catalogEntry.version,
          });
        }
      }

      return updates;
    } catch (err) {
      console.warn("[update-detector] checkForUpdates failed:", (err as Error).message);
      return [];
    }
  }

  private async readInstalledVersion(manifestPath: string): Promise<string | null> {
    const abs = isAbsolute(manifestPath)
      ? manifestPath
      : resolve(dirname(this.registryPath), manifestPath);
    try {
      const raw = await readFile(abs, "utf-8");
      const parsed = JSON.parse(raw) as { version?: string };
      return parsed.version ?? null;
    } catch {
      return null;
    }
  }
}

/**
 * Simple semver comparison: returns true when `candidate` > `installed`.
 * Falls back to string comparison for non-semver values.
 */
export function isNewer(candidate: string, installed: string): boolean {
  const parse = (v: string): number[] =>
    v
      .replace(/^v/, "")
      .split(".")
      .map((n) => parseInt(n, 10));

  const a = parse(candidate);
  const b = parse(installed);
  const len = Math.max(a.length, b.length);

  for (let i = 0; i < len; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    if (Number.isNaN(ai) || Number.isNaN(bi)) return candidate > installed;
    if (ai !== bi) return ai > bi;
  }
  return false;
}
