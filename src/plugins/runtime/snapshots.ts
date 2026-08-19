/**
 * Snapshot helpers — readEnabledManifestSnapshots, load plan resolution,
 * trust-boundary checks for registry manifest paths.
 */

import { isAbsolute, resolve, dirname } from "node:path";
import type { ValidateFunction } from "ajv";
import type { PluginAccessSpec } from "../types.js";
import type { ManifestLoadPlan, ManifestSnapshot } from "./types.js";
import { parsePluginJson } from "./manifest-validation.js";
import { readPluginRegistry } from "../registry.js";
import { isTrustedRegistryManifestPath } from "../registry-manifest-trust.js";
import { createLogger } from "../../lib/logger.js";
const log = createLogger("plugin-runtime");

// The trust predicate lives in `../registry-manifest-trust.js` — one authority
// shared with `resolveManifestPathsFromRegistry` (registry.ts), which resolves
// the SAME field from the SAME registry for the same purpose. It cannot live
// in registry.ts: this module already imports that one.
export { isTrustedRegistryManifestPath } from "../registry-manifest-trust.js";

/**
 * A registry row the load plan refuses to carry: it names an installed plugin
 * — `marketplace.list()` keeps reporting it as installed — whose manifest the
 * runtime must never read, so it cannot become a plan entry.
 *
 * It is reported OUT OF BAND rather than as a plan entry carrying a flag, and
 * that is the point. `readEnabledManifestSnapshots`, `restartAll`, `addPlugin`
 * and the re-enable path all consume the plan and all reach for
 * `plan.manifestPath`. A refused row inside the plan would be one forgotten
 * `if` away from handing an untrusted path to `readManifest`; keeping the plan
 * exclusively trusted makes that mistake unavailable rather than merely
 * avoided.
 */
export type RegistryLoadRefusal = {
  pluginId: string;
  /** The resolved candidate, for the diagnostic the user is shown. Never read. */
  manifestPath: string;
  reason: string;
};

/**
 * Build a ManifestLoadPlan from manifestPaths + registry.
 *
 * `onRefused` receives every registry row dropped for an untrusted
 * `manifestPath`. Callers that only need the trusted plan omit it; boot passes
 * one so the drop reaches a card instead of only a log line.
 */
export async function resolveManifestLoadPlan(opts: {
  manifestPaths: string[];
  registryPath?: string;
  pluginsRoot?: string;
  onRefused?: (refusal: RegistryLoadRefusal) => void;
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
      if (entry.pendingUpdate) {
        log.warn(`skipping pending-update registry entry for ${entry.id}`);
        return [];
      }
      const manifestPath = isAbsolute(entry.manifestPath)
        ? entry.manifestPath
        : resolve(dirname(opts.registryPath!), entry.manifestPath);
      if (!opts.pluginsRoot || !isTrustedRegistryManifestPath(manifestPath, opts.pluginsRoot)) {
        const reason = opts.pluginsRoot
          ? `registry manifest path is not inside the plugin root: ${manifestPath}`
          : `registry manifest path cannot be trusted without a plugin root: ${manifestPath}`;
        log.warn(`ignoring untrusted registry manifest path for ${entry.id}: ${manifestPath}`);
        opts.onRefused?.({ pluginId: entry.id, manifestPath, reason });
        return [];
      }
      return [{
        pluginIdHint: entry.id,
        manifestPath,
        enabled: entry.enabled !== false,
        approvedPluginAccess: entry.approvedPluginAccess as PluginAccessSpec | undefined,
        installSource: entry.installSource,
        manifestSha256: entry.manifestSha256,
      }];
    }),
  );
  return plans;
}

/**
 * For every plan entry (enabled or inactive), read and validate the manifest.
 * Returns a map keyed by pluginIdHint (or manifest.id when no hint). Failed
 * reads are skipped with a warning.
 *
 * Inactive manifests are parsed into metadata so settings can offer re-enable,
 * but PluginRuntime does not instantiate or publish them until receipt and
 * package bytes have been reverified.
 */
export async function readEnabledManifestSnapshots(
  loadPlan: ManifestLoadPlan[],
  validator: ValidateFunction,
): Promise<Map<string, ManifestSnapshot>> {
  const snapshots = new Map<string, ManifestSnapshot>();
  for (const plan of loadPlan) {
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
