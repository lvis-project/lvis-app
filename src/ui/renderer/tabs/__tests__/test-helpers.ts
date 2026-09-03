import type { HookTrustRow } from "../../../../hooks/hook-trust-commands.js";
import type { PluginCardSummary } from "../../types.js";

export function makeHookTrustRow(name: string): HookTrustRow {
  return {
    fileName: name,
    hookType: "pre",
    sha256: "a".repeat(64),
    state: "disabled",
  };
}

/**
 * An installed plugin as the renderer's catalog surfaces see it.
 *
 * The lookup and version-assertion paths read `id` and `version` and nothing
 * else, so the rest of the card is inert padding that only exists to satisfy
 * the type — which is exactly why it belongs in one place.
 */
export function pluginCardSummary(
  over: Partial<PluginCardSummary> & { id: string },
): PluginCardSummary {
  return {
    name: over.id,
    description: "",
    sampleTools: [],
    capabilities: [],
    tools: [],
    ...over,
  };
}
