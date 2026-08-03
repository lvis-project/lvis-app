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
import type { NetworkAccessGrant } from "../shared/network-access.js";
import { getLvisAppVersion } from "../shared/app-version.js";
import {
  isNewerPluginVersion,
  resolvePluginUpdateCondition,
} from "./update-condition.js";
const log = createLogger("update-detector");

export interface UpdateInfo {
  pluginId: string;
  pluginName: string;
  installedVersion: string;
  latestVersion: string;
  networkAccess?: NetworkAccessGrant;
}

export type PluginUpdateCheckResult =
  | { status: "success"; updates: UpdateInfo[] }
  | { status: "catalog-unavailable" }
  | { status: "error"; error: unknown };

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
  /** Running app version. Injectable for deterministic compatibility tests. */
  appVersion?: string;
}

export class PluginUpdateDetector {
  private readonly canaryOptIn: boolean;
  private readonly appVersion: string;

  constructor(
    private readonly registryPath: string,
    private readonly fetcher: MarketplaceFetcher,
    options: UpdateDetectorOptions = {},
  ) {
    this.canaryOptIn = options.canaryOptIn ?? false;
    this.appVersion = options.appVersion ?? getLvisAppVersion();
  }

  /**
   * Checks every installed plugin against the catalog.
   * Returns an array of plugins that have a newer version available.
   * Never throws — errors are logged and an empty array is returned.
   */
  async checkForUpdates(): Promise<UpdateInfo[]> {
    const result = await this.checkForUpdatesResult();
    return result.status === "success" ? result.updates : [];
  }

  /** Distinguishes catalog failure from a successful empty snapshot. */
  async checkForUpdatesResult(): Promise<PluginUpdateCheckResult> {
    let catalogPlugins: Awaited<ReturnType<MarketplaceFetcher["listPlugins"]>>;
    try {
      catalogPlugins = await this.fetcher.listPlugins();
    } catch (err) {
      log.warn("checkForUpdates catalog unavailable: %s", (err as Error).message);
      return { status: "catalog-unavailable" };
    }

    try {
      const registry = await readPluginRegistry(this.registryPath);
      const updates: UpdateInfo[] = [];

      // Build an O(1) lookup map to avoid O(n*m) catalog scans when many
      // plugins are installed and the catalog is large.
      const catalogById = new Map(catalogPlugins.map((p) => [p.id, p]));

      for (const entry of registry.plugins) {
        if (entry.pendingUpdate) continue;
        const installedVersion = await this.readInstalledVersion(entry.manifestPath);
        if (!installedVersion) continue;

        const catalogEntry = catalogById.get(entry.id);
        if (!catalogEntry?.version) continue;

        const condition = resolvePluginUpdateCondition({
          appVersion: this.appVersion,
          canaryOptIn: this.canaryOptIn,
          installed: { presence: "present", version: installedVersion },
          candidate: catalogEntry,
        });
        if (shouldAdvertisePluginUpdate(condition)) {
          updates.push({
            pluginId: entry.id,
            pluginName: catalogEntry.name || entry.id,
            installedVersion,
            latestVersion: catalogEntry.version,
            ...(catalogEntry.networkAccess ? { networkAccess: catalogEntry.networkAccess } : {}),
          });
        }
      }

      return { status: "success", updates };
    } catch (err) {
      log.warn("checkForUpdates failed: %s", (err as Error).message);
      return { status: "error", error: err };
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
      throw new Error(`installed plugin manifest escapes registry root: ${manifestPath}`);
    }
    try {
      const raw = await readFile(abs, "utf-8");
      const parsed = JSON.parse(raw) as { version?: string };
      if (typeof parsed.version !== "string" || parsed.version.trim().length === 0) {
        throw new Error(`installed plugin manifest has no version: ${manifestPath}`);
      }
      return parsed.version;
    } catch (error) {
      throw new Error(`installed plugin manifest unreadable: ${manifestPath}`, {
        cause: error,
      });
    }
  }
}

function shouldAdvertisePluginUpdate(
  condition: ReturnType<typeof resolvePluginUpdateCondition>,
): boolean {
  switch (condition.kind) {
    case "eligible_user_update":
      return true;
    case "catalog_unavailable":
    case "no_candidate":
    case "installed_state_unreadable":
    case "current":
    case "blocked_by_app":
    case "blocked_by_channel":
    case "transaction_pending":
    case "eligible_user_install":
    case "eligible_managed_install":
    case "eligible_managed_boot_update":
      return false;
    default: {
      const exhaustive: never = condition;
      return exhaustive;
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
  return isNewerPluginVersion(candidate, installed);
}
