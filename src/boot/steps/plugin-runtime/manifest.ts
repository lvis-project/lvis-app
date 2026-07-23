/**
 * Boot §4.2 — plugin manifest inspection helpers.
 *
 * Extracted from `plugin-runtime.ts` (C5, behavior-preserving). Pure and
 * self-contained: structural reads over a PluginManifest with no runtime state
 * or host services.
 */
import type { PluginManifest } from "../../../plugins/types.js";

export function declaresHostManagedPythonRuntime(
  manifest: Pick<PluginManifest, "python">,
): boolean {
  return manifest.python?.managedBy === "lvis-app" ||
    typeof manifest.python?.requirementsLock === "string";
}
