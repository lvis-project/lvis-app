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
import { existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, dirname } from "node:path";
import type { MarketplaceFetcher } from "./marketplace-fetcher.js";
import { readPluginRegistry } from "./registry.js";
import { createLogger } from "../lib/logger.js";
const log = createLogger("update-detector");

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

      // Build an O(1) lookup map to avoid O(n*m) catalog scans when many
      // plugins are installed and the catalog is large.
      const catalogById = new Map(catalogPlugins.map((p) => [p.id, p]));

      for (const entry of registry.plugins) {
        // Dev-synced installs (`bun run dev:sync`) copy real files into
        // pluginsRoot but should not be compared against the catalog —
        // the source workspace is the authoritative manifest, not the
        // marketplace catalog. Skip both the current marker (`"dev"`)
        // and the legacy literal (`"dev-link"`). The deprecated
        // `_devLinked` boolean is also skipped here as a cleanup hint so a
        // stale legacy registry does not spam path-escape warnings; it still
        // grants NO trust bypass in the runtime.
        if (
          entry.installSource === "dev" ||
          entry.installSource === "dev-link" ||
          entry._devLinked
        ) continue;

        const installedVersion = await this.readInstalledVersion(entry.manifestPath);
        if (!installedVersion) continue;

        const catalogEntry = catalogById.get(entry.id);
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
      log.warn("checkForUpdates failed: %s", (err as Error).message);
      return [];
    }
  }

  private async readInstalledVersion(manifestPath: string): Promise<string | null> {
    const registryDir = canonicalizeExistingPath(dirname(this.registryPath));
    const abs = canonicalizeExistingPath(
      isAbsolute(manifestPath)
        ? manifestPath
        : resolve(dirname(this.registryPath), manifestPath),
    );
    // Path-escape defense: resolved manifest must live beneath the registry
    // directory (= pluginsRoot — every install lives at
    // `<pluginsRoot>/<id>/plugin.json`). A crafted registry entry like
    // "../../etc/passwd" is rejected.
    if (!isWithin(registryDir, abs)) {
      log.warn("manifestPath escapes allowed roots, skipping: %s", manifestPath);
      return null;
    }
    try {
      const raw = await readFile(abs, "utf-8");
      const parsed = JSON.parse(raw) as { version?: string };
      return parsed.version ?? null;
    } catch {
      return null;
    }
  }
}

function canonicalizeExistingPath(path: string): string {
  const absolute = resolve(path);
  return existsSync(absolute) ? realpathSync(absolute) : absolute;
}

function isWithin(basePath: string, targetPath: string): boolean {
  const rel = relative(basePath, targetPath);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Semver comparison: returns true when `candidate` > `installed`.
 *
 * Honors the semver precedence rule that a version with a pre-release tag
 * has LOWER precedence than the same version without one
 * (e.g. `1.0.0-beta.1` < `1.0.0`). Pre-release identifiers themselves are
 * compared field-by-field: numeric identifiers compared numerically, non-
 * numeric compared lexically, numeric always lower than non-numeric, and a
 * shorter prerelease chain is lower when all preceding fields are equal
 * (per semver.org §11).
 *
 * Falls back to string comparison for fully non-semver inputs.
 */
export function isNewer(candidate: string, installed: string): boolean {
  const split = (v: string): { main: number[]; pre: string[] | null } => {
    const stripped = v.replace(/^v/, "");
    const [core, preTag] = stripped.split("-", 2);
    const main = core.split(".").map((n) => parseInt(n, 10));
    const pre = preTag ? preTag.split(".") : null;
    return { main, pre };
  };

  const a = split(candidate);
  const b = split(installed);
  const len = Math.max(a.main.length, b.main.length);

  for (let i = 0; i < len; i++) {
    const ai = a.main[i] ?? 0;
    const bi = b.main[i] ?? 0;
    if (Number.isNaN(ai) || Number.isNaN(bi)) return candidate > installed;
    if (ai !== bi) return ai > bi;
  }

  // Main versions equal — apply pre-release precedence.
  // A version WITHOUT a prerelease outranks one WITH a prerelease.
  if (a.pre === null && b.pre === null) return false;
  if (a.pre === null && b.pre !== null) return true;   // candidate is stable, installed is pre
  if (a.pre !== null && b.pre === null) return false;  // candidate is pre, installed is stable

  // Both have prereleases — compare field-by-field.
  const aPre = a.pre as string[];
  const bPre = b.pre as string[];
  const preLen = Math.max(aPre.length, bPre.length);
  for (let i = 0; i < preLen; i++) {
    const ax = aPre[i];
    const bx = bPre[i];
    // Shorter prerelease chain has lower precedence when all preceding fields match.
    if (ax === undefined) return false;
    if (bx === undefined) return true;
    const aNum = /^\d+$/.test(ax);
    const bNum = /^\d+$/.test(bx);
    if (aNum && bNum) {
      const an = parseInt(ax, 10);
      const bn = parseInt(bx, 10);
      if (an !== bn) return an > bn;
    } else if (aNum !== bNum) {
      // Numeric identifiers always have lower precedence than non-numeric.
      return !aNum;
    } else {
      if (ax !== bx) return ax > bx;
    }
  }
  return false;
}
