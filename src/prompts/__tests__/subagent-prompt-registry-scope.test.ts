/**
 * A sub-agent's ADVERTISED plugin surface must be bounded by the SAME registry
 * its EXECUTABLE surface is bounded by.
 *
 * Enforcement freezes the child with `toolRegistry.createScopedView(baseToolNames)`
 * (src/engine/subagent-runner.ts) and hands that scoped registry to the prompt
 * builder via `createIsolated({ memoryManager, toolRegistry })`. Advertisement,
 * however, ran through `deps.getPluginCards` — and the boot factory used to build
 * that as a closure over the boot-time GLOBAL registry
 * (`() => pluginRuntime.listPluginCards(toolRegistry)`), which `createIsolated`'s
 * `{ ...this.deps, ...overrides }` cannot reach. Two authorities, one capability.
 *
 * The fix makes the registry a PARAMETER, so the builder passes its own
 * `deps.toolRegistry` — the overridden one for a child.
 *
 * WHAT IS DRIVEN HERE
 *  - `createSystemPromptBuilder` — the REAL production factory (src/boot/conversation.ts)
 *    that constructs the card provider. Nothing in this file re-implements it.
 *  - `ToolRegistry.createScopedView` — the REAL narrowing sub-agents perform.
 *  - `SystemPromptBuilder.createIsolated` — the REAL call subagent-runner makes,
 *    with the same override shape (`memoryManager` + `toolRegistry`).
 *  - `PluginRuntime.listPluginCards` — the REAL card projection, on a real
 *    `PluginRuntime` instance. Only `isPluginGenerationActive` is forced true
 *    (a card is `active:false` without a published generation, and a generation
 *    needs on-disk fixtures); everything the registry argument touches —
 *    `getModelVisibleTools()` → `visibleNames` → `buildPluginCard`'s tool filter
 *    → `sampleTools` → the section's zero-tool drop — is production code.
 */
import { describe, it, expect, vi } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSystemPromptBuilder } from "../../boot/conversation.js";
import { ToolRegistry } from "../../tools/registry.js";
import {
  CARD_FIXTURE_IN_SCOPE_PLUGIN as IN_SCOPE_PLUGIN,
  CARD_FIXTURE_IN_SCOPE_TOOL,
  CARD_FIXTURE_OUT_OF_SCOPE_PLUGIN as OUT_OF_SCOPE_PLUGIN,
  CARD_FIXTURE_OUT_OF_SCOPE_TOOLS,
  pluginCardRuntimeFixture,
} from "../../plugins/__tests__/plugin-card-runtime-fixture.js";
import type { Tool } from "../../tools/base.js";
import { makePromptMemorySource } from "./test-helpers.js";

const HOST_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const memoryManager = makePromptMemorySource();

function pluginTool(pluginId: string, name: string): Tool {
  return {
    name,
    description: `${name} description`,
    source: "plugin",
    pluginId,
    modelVisible: true,
    version: "1.0.0",
    inputSchema: { type: "object", properties: {} },
    toJsonSchema: () => ({ type: "object", properties: {} }),
    execute: async () => ({ output: "" }),
  } as unknown as Tool;
}

/** A registry holding both plugins' model-visible tools — the boot-time global. */
function globalRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(pluginTool(IN_SCOPE_PLUGIN, CARD_FIXTURE_IN_SCOPE_TOOL));
  for (const name of CARD_FIXTURE_OUT_OF_SCOPE_TOOLS) {
    registry.register(pluginTool(OUT_OF_SCOPE_PLUGIN, name));
  }
  return registry;
}

function buildWithScope(builder: ReturnType<typeof createSystemPromptBuilder>): string {
  builder.setToolScope({
    activePluginIds: new Set<string>(),
    includeBuiltins: true,
    includeMcp: true,
    includeEgress: true,
  });
  return builder.build();
}

describe("sub-agent prompt scope — advertisement is bounded by the child's registry", () => {
  it("the card provider receives the CHILD's scoped registry, not the boot-time global", () => {
    const registry = globalRegistry();
    const runtime = pluginCardRuntimeFixture(HOST_ROOT);
    const spy = vi.spyOn(runtime, "listPluginCards");

    // REAL production factory — this is the closure under test.
    const parent = createSystemPromptBuilder({ memoryManager, toolRegistry: registry, pluginRuntime: runtime });
    buildWithScope(parent);
    expect(spy).toHaveBeenCalledWith(registry);

    // REAL sub-agent narrowing + the REAL override subagent-runner performs.
    const scoped = registry.createScopedView([CARD_FIXTURE_IN_SCOPE_TOOL]);
    const child = parent.createIsolated({ memoryManager, toolRegistry: scoped });
    spy.mockClear();
    buildWithScope(child);

    expect(spy).toHaveBeenCalledWith(scoped);
    expect(spy).not.toHaveBeenCalledWith(registry);
    spy.mockRestore();
  });

  it("an out-of-scope plugin is NOT advertised to the child (and the in-scope one still is)", () => {
    const registry = globalRegistry();
    const runtime = pluginCardRuntimeFixture(HOST_ROOT);
    const parent = createSystemPromptBuilder({ memoryManager, toolRegistry: registry, pluginRuntime: runtime });

    // Control: with the FULL registry the secret plugin IS advertised. Without
    // this the scoped assertion below could pass for the wrong reason (a card
    // that never renders at all).
    const parentPrompt = buildWithScope(parent);
    expect(parentPrompt).toContain(OUT_OF_SCOPE_PLUGIN);
    expect(parentPrompt).toContain("secret_tool");
    expect(parentPrompt).toContain(IN_SCOPE_PLUGIN);

    const scoped = registry.createScopedView([CARD_FIXTURE_IN_SCOPE_TOOL]);
    const childPrompt = buildWithScope(parent.createIsolated({ memoryManager, toolRegistry: scoped }));

    expect(scoped.getModelVisibleTools().map((tool) => tool.name)).toEqual([CARD_FIXTURE_IN_SCOPE_TOOL]);
    expect(childPrompt).not.toContain(OUT_OF_SCOPE_PLUGIN);
    expect(childPrompt).not.toContain("secret_tool");
    // The plugin the child CAN call is still advertised — the fix narrows, it
    // does not blank the section.
    expect(childPrompt).toContain(IN_SCOPE_PLUGIN);
  });

  it("a child scoped to zero plugin tools gets no plugin catalog section at all", () => {
    const registry = globalRegistry();
    const runtime = pluginCardRuntimeFixture(HOST_ROOT);
    const parent = createSystemPromptBuilder({ memoryManager, toolRegistry: registry, pluginRuntime: runtime });
    expect(buildWithScope(parent)).toContain(OUT_OF_SCOPE_PLUGIN);

    const childPrompt = buildWithScope(
      parent.createIsolated({ memoryManager, toolRegistry: registry.createScopedView([]) }),
    );
    expect(childPrompt).not.toContain(IN_SCOPE_PLUGIN);
    expect(childPrompt).not.toContain(OUT_OF_SCOPE_PLUGIN);
  });
});
