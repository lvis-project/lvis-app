/**
 * Test-only helper: a REAL {@link PluginRuntime} that knows two plugins'
 * manifests, so `listPluginCards(registry)` runs its production projection
 * (`getModelVisibleTools()` -> `visibleNames` -> `buildPluginCard`) over
 * whichever registry the caller passes.
 *
 * The one seam is `isPluginGenerationActive`: a card is `active:false` (and so
 * carries no `sampleTools`) until a generation has published, and publishing one
 * needs on-disk fixtures. Everything the registry argument decides is left to
 * production code.
 *
 * NOT a `*.test.ts` file → vitest does not execute it as a suite.
 */
import { TestPluginRuntime } from "./test-helpers.js";
import type { PluginRuntime } from "../runtime.js";

export const CARD_FIXTURE_IN_SCOPE_PLUGIN = "com.example.allowed";
export const CARD_FIXTURE_OUT_OF_SCOPE_PLUGIN = "com.example.secret";
export const CARD_FIXTURE_IN_SCOPE_TOOL = "allowed_read";
export const CARD_FIXTURE_OUT_OF_SCOPE_TOOLS = ["secret_tool", "secret_tool2"] as const;

export function pluginCardRuntimeFixture(hostRoot: string): PluginRuntime {
  const rt = new TestPluginRuntime({ hostRoot, manifestPaths: [] });
  const internals = rt as unknown as {
    knownPluginManifests: Map<string, unknown>;
    plugins: Map<string, unknown>;
    isPluginGenerationActive: (pluginId: string) => boolean;
  };
  const specs = [
    [CARD_FIXTURE_IN_SCOPE_PLUGIN, "Allowed Plugin", [CARD_FIXTURE_IN_SCOPE_TOOL]],
    [CARD_FIXTURE_OUT_OF_SCOPE_PLUGIN, "Secret Plugin", [...CARD_FIXTURE_OUT_OF_SCOPE_TOOLS]],
  ] as const;
  for (const [pluginId, name, tools] of specs) {
    internals.knownPluginManifests.set(pluginId, {
      id: pluginId,
      name,
      description: `${name} does things`,
      tools: tools.map((toolName) => ({ name: toolName, description: `${toolName} description` })),
    });
    internals.plugins.set(pluginId, { manifest: { id: pluginId }, started: true });
  }
  internals.isPluginGenerationActive = () => true;
  return rt as unknown as PluginRuntime;
}
