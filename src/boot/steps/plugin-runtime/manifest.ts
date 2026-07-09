/**
 * Boot §4.2 — plugin manifest inspection helpers.
 *
 * Extracted from `plugin-runtime.ts` (C5, behavior-preserving). Pure and
 * self-contained: structural reads over a PluginManifest with no runtime state
 * or host services.
 */
import type { PluginManifest } from "../../../plugins/types.js";

// #885 v6 — accepts both the legacy `PluginManifest` and the pure
// `NormalizedManifest` (both carry `config`); only shared fields are read.
export function declaresHostManagedPythonRuntime(
  manifest: Pick<PluginManifest, "config">,
): boolean {
  const pluginManifest = manifest as Pick<PluginManifest, "config"> & {
    python?: { managedBy?: unknown; requirementsLock?: unknown };
    pythonRequirementsLock?: unknown;
    runtime?: { python?: { requirementsLock?: unknown } };
    config?: { pythonRequirementsLock?: unknown };
  };
  return pluginManifest.python?.managedBy === "lvis-app" ||
    typeof pluginManifest.python?.requirementsLock === "string" ||
    typeof pluginManifest.pythonRequirementsLock === "string" ||
    typeof pluginManifest.runtime?.python?.requirementsLock === "string" ||
    typeof pluginManifest.config?.pythonRequirementsLock === "string";
}
