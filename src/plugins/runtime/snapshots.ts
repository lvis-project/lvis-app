/**
 * Snapshot helpers — readEnabledManifestSnapshots, load plan resolution,
 * trust-boundary checks for registry manifest paths.
 */

import { isAbsolute, relative, resolve, dirname } from "node:path";
import { realpathSync } from "node:fs";
import type { ValidateFunction } from "ajv";
import type { PluginAccessSpec } from "../types.js";
import type { ManifestLoadPlan, ManifestSnapshot } from "./types.js";
import { parsePluginJson } from "./manifest-validation.js";
import { readPluginRegistry } from "../registry.js";
import { createLogger } from "../../lib/logger.js";
const log = createLogger("plugin-runtime");

/**
 * Trust-root containment check for registry-recorded manifest paths.
 *
 * A registry entry's manifestPath is trusted iff its `realpathSync()`
 * (symlinks resolved) is contained under `realpathSync(pluginsRoot)`.
 */
export function isTrustedRegistryManifestPath(
  manifestPath: string,
  pluginsRoot: string,
): boolean {
  if (!isAbsolute(manifestPath)) return true;
  let realManifest: string;
  let realRoot: string;
  try {
    realManifest = realpathSync(manifestPath);
    realRoot = realpathSync(pluginsRoot);
  } catch {
    return false;
  }
  return isPathContained(realRoot, realManifest);
}

/**
 * Containment via `path.relative` — null/empty/`..`/absolute means the
 * candidate is outside `parent`.
 */
export function isPathContained(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  if (rel === "" || rel === ".") return false;
  if (rel.startsWith("..")) return false;
  if (isAbsolute(rel)) return false;
  return true;
}

/**
 * Build a ManifestLoadPlan from manifestPaths + registry.
 */
export async function resolveManifestLoadPlan(opts: {
  manifestPaths: string[];
  registryPath?: string;
  pluginsRoot?: string;
}): Promise<ManifestLoadPlan[]> {
  const plans: ManifestLoadPlan[] = opts.manifestPaths.map((manifestPath) => ({
    manifestPath,
    enabled: true,
  }));
  if (!opts.registryPath) {
    if (plans.length > 0) return plans;
    throw new Error("Either manifestPaths or registryPath must be provided.");
  }
  const registry = await readPluginRegistry(opts.registryPath);
  plans.push(
    ...registry.plugins.flatMap((entry) => {
      const manifestPath = isAbsolute(entry.manifestPath)
        ? entry.manifestPath
        : resolve(dirname(opts.registryPath!), entry.manifestPath);
      // STRICT trust boundary (see PR #414): the registry-recorded
      // manifestPath's `realpathSync()` MUST be contained under
      // `realpathSync(pluginsRoot)`. We do NOT bypass this for
      // `installSource: "dev-link"` / `_devLinked: true` — that bypass was
      // proposed in PR #458 and rejected because it lets any registry entry
      // self-flag as a dev-link to load arbitrary `../` paths. The correct
      // dev-install workflow now copies `plugin.json` into pluginsRoot and
      // only symlinks `dist/`; see scripts/dev-link-plugins.mjs.
      if (!opts.pluginsRoot || !isTrustedRegistryManifestPath(manifestPath, opts.pluginsRoot)) {
        const isDevLinked = entry.installSource === "dev-link" || entry._devLinked === true;
        if (isDevLinked) {
          // Legacy dev-link entries (registries written by pre-convergence
          // versions of dev-link-plugins.mjs that symlinked plugin.json to
          // the workspace) escape pluginsRoot and are quarantined here. The
          // remediation is to re-run `bun run dev:link`, which now copies
          // plugin.json into `~/.lvis/plugins/<id>/` so the realpath stays
          // inside the trust root. Surfacing the quarantine explicitly so
          // operators don't mistake it for a generic untrusted-path warning.
          log.warn(
            `quarantining legacy dev-link entry for ${entry.id}: manifestPath ${manifestPath} escapes pluginsRoot — re-run \`bun run dev:link\` to migrate (artifacts must live under ${opts.pluginsRoot})`,
          );
        } else {
          log.warn(
            `ignoring untrusted registry manifest path for ${entry.id}: ${manifestPath}`,
          );
        }
        return [];
      }
      return [{
        pluginIdHint: entry.id,
        manifestPath,
        enabled: entry.enabled !== false,
        approvedPluginAccess: entry.approvedPluginAccess as PluginAccessSpec | undefined,
        devLinked: entry.installSource === "dev-link" || entry._devLinked === true,
      }];
    }),
  );
  return plans;
}

/**
 * For each enabled plan entry, read and validate the manifest. Returns a map
 * keyed by pluginIdHint (or manifest.id when no hint). Failed reads are
 * skipped with a warning.
 */
export async function readEnabledManifestSnapshots(
  loadPlan: ManifestLoadPlan[],
  validator: ValidateFunction | null,
): Promise<Map<string, ManifestSnapshot>> {
  const snapshots = new Map<string, ManifestSnapshot>();
  for (const plan of loadPlan) {
    if (!plan.enabled) continue;
    try {
      const manifest = await parsePluginJson(plan.manifestPath, validator);
      // Key by pluginIdHint (registry id) when available so addPlugin() lookups
      // by registry id remain consistent even if manifest.id diverges.
      const key = plan.pluginIdHint ?? manifest.id;
      snapshots.set(key, {
        manifest,
        approvedPluginAccess: plan.approvedPluginAccess,
      });
    } catch (err) {
      log.warn(
        `failed to read manifest at ${plan.manifestPath} (plugin: ${plan.pluginIdHint ?? "<unknown>"}) — skipping: %s`,
        (err as Error).message,
      );
      continue;
    }
  }
  return snapshots;
}
