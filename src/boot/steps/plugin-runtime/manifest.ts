/**
 * Boot §4.2 — plugin manifest inspection helpers.
 *
 * Extracted from `plugin-runtime.ts` (C5, behavior-preserving). Pure and
 * self-contained: structural reads over a PluginManifest with no runtime state
 * or host services.
 */
import type { PluginManifest } from "../../../plugins/types.js";

export function declaresHostManagedPythonRuntime(manifest: PluginManifest): boolean {
  const pluginManifest = manifest as PluginManifest & {
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
