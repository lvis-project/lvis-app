/**
 * S14 — Plugin dependency resolution.
 *
 * Resolves `requires.capabilities[]` from a catalog item against the
 * capability tags advertised by currently-installed plugins.  Used as a
 * preflight check in the marketplace install flow.
 */
import type { PluginManifest } from "./types.js";

/**
 * Collect the set of capability tags from a list of installed plugin manifests.
 * Manifests without a `capabilities` array contribute nothing.
 */
export function installedCapabilities(manifests: PluginManifest[]): Set<string> {
  const caps = new Set<string>();
  for (const m of manifests) {
    if (Array.isArray(m.capabilities)) {
      for (const c of m.capabilities) {
        caps.add(c);
      }
    }
  }
  return caps;
}

/**
 * Resolve a list of required capability tags against the installed capability set.
 *
 * @param required  - capability tags declared in the to-be-installed plugin's
 *                    `requires.capabilities` field.
 * @param installed - manifests of all currently-installed (and enabled) plugins.
 * @returns `{ ok: true }` when all required capabilities are satisfied, or
 *          `{ ok: false, missing: string[] }` listing unsatisfied capabilities.
 */
export function resolveDependencies(
  required: string[],
  installed: PluginManifest[],
): { ok: true } | { ok: false; missing: string[] } {
  if (required.length === 0) return { ok: true };
  const available = installedCapabilities(installed);
  const missing = required.filter((cap) => !available.has(cap));
  if (missing.length === 0) return { ok: true };
  return { ok: false, missing };
}
