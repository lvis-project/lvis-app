import { createHash } from "node:crypto";
import type { PluginManifest } from "../../plugins/types.js";

interface PluginOperationAccountResolver {
  getPluginOperationAccountHash(
    pluginId: string,
    generationId: string,
  ): string | undefined;
}

/**
 * Bind app-origin operation policy to a Host-owned principal.
 *
 * Authenticated plugins must use their fresh runtime account binding. Plugins
 * with no auth contract receive a deterministic, generation-scoped anonymous
 * identity so operation grants remain revocable on generation retirement.
 */
export function resolvePluginOperationAccountHash(
  resolver: PluginOperationAccountResolver,
  manifest: PluginManifest | undefined,
  pluginId: string,
  generationId: string,
): string | undefined {
  const authenticated = resolver.getPluginOperationAccountHash(
    pluginId,
    generationId,
  );
  if (authenticated || manifest?.auth) return authenticated;
  return createHash("sha256")
    .update("plugin-operation-anonymous/v1\0")
    .update(pluginId)
    .update("\0")
    .update(generationId)
    .digest("hex");
}
