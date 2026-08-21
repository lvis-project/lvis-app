import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const MAX_IMPLEMENTATION_LINES = 1_600;

/**
 * Per-module ceilings for hubs that deliberately hold a whole axis in one file.
 *
 * Line count is not the defect this suite exists to catch — an owner boundary
 * is. A module that owns one axis end to end may legitimately be large; what is
 * not legitimate is a module that has quietly absorbed a second axis. For those
 * hubs the ceiling only has to stop runaway growth, so it is set far above the
 * default rather than at a size that would force the axis back apart.
 */
const MODULE_CEILINGS: Readonly<Record<string, number>> = {
  // Owns the conversation turn loop end to end, including the meta-tool
  // intercepts (`request_plugin`, `tool_search`) and their cross-agent gate,
  // which have no consumer outside this module.
  "src/engine/turn/query-loop.ts": 20_000,
  // Owns the plugin runtime end to end: `PluginRuntime` and the abstract bases
  // it extends (`PluginRuntimeState` -> `PluginRuntimePublicationState` ->
  // `PluginRuntimeCapabilityLifecycle` -> `PluginRuntimeLifecycle`) are a single
  // inheritance chain over one `this`, together with the helpers only that chain
  // uses. Splitting them again would divide one object, not two axes.
  "src/plugins/runtime/index.ts": 20_000,
};

const scopedModules = [
  "src/engine/turn/query-loop.ts",
  "src/plugins/runtime/index.ts",
  "src/preload/internal-surface.ts",
  "src/preload/internal-api-surface.ts",
  "src/data/settings-store.ts",
  "src/data/settings-defaults.ts",
  "src/data/settings-normalization.ts",
  "src/ui/renderer/components/ChatSidePanel.tsx",
  "src/ui/renderer/components/ChatSidePanelPreview.tsx",
  "src/ui/renderer/components/ChatSidePanelLayout.tsx",
  "src/ui/renderer/components/ChatSidePanelWorkspaces.tsx",
] as const;

describe("large module ownership boundaries", () => {
  it.each(scopedModules)("keeps %s below the implementation ceiling", (modulePath) => {
    const source = readFileSync(resolve(process.cwd(), modulePath), "utf8");
    const lines = source.split(/\r?\n/).length;
    const ceiling = MODULE_CEILINGS[modulePath] ?? MAX_IMPLEMENTATION_LINES;
    expect(lines, `${modulePath} has ${lines} lines`).toBeLessThanOrEqual(ceiling);
  });
});
