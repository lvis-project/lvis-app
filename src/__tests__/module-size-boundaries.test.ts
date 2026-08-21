import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A runaway backstop, not a design rule.
 *
 * Line count is not the defect this suite exists to catch — an owner boundary
 * is. A module that owns one axis end to end may legitimately be large; what is
 * not legitimate is a module that has quietly absorbed a second axis, and that
 * is a question no counter can answer.
 *
 * This used to be 1,600, and it was doing the opposite of its name. Every module
 * below sat within a dozen lines of it — query-loop.ts at 1599, runtime/index.ts
 * at 1588, runtime-state.ts at 1589 — so the next change to any of them had to
 * leave as a new file. That produced clusters of small fragments whose only
 * reason to exist was staying under this number, several of which said exactly
 * that in their own header comments. A module split on a line counter scatters
 * one concept across files that then drift apart, and two copies of a check that
 * stop agreeing leave a gap neither side covers.
 *
 * So the ceiling is one number, set far above any module here, and it is not a
 * budget to spend or a target to approach. Nothing should be split to satisfy
 * it. Split on axis boundaries instead: a module reaching into another domain, a
 * reverse dependency, one concept spread across several files.
 */
const MAX_IMPLEMENTATION_LINES = 20_000;

const scopedModules = [
  // Owns the conversation turn loop end to end, including the meta-tool
  // intercepts (`request_plugin`, `tool_search`) and their cross-agent gate,
  // which have no consumer outside this module.
  "src/engine/turn/query-loop.ts",
  // Owns the plugin runtime end to end: `PluginRuntime` and the abstract bases
  // it extends (`PluginRuntimeState` -> `PluginRuntimePublicationState` ->
  // `PluginRuntimeCapabilityLifecycle` -> `PluginRuntimeLifecycle`) are a single
  // inheritance chain over one `this`, together with the helpers only that chain
  // uses. Splitting them again would divide one object, not two axes.
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
  it.each(scopedModules)("keeps %s below the runaway ceiling", (modulePath) => {
    const source = readFileSync(resolve(process.cwd(), modulePath), "utf8");
    const lines = source.split(/\r?\n/).length;
    expect(lines, `${modulePath} has ${lines} lines`).toBeLessThanOrEqual(MAX_IMPLEMENTATION_LINES);
  });
});
