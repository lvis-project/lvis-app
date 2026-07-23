import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const MAX_IMPLEMENTATION_LINES = 1_600;

const scopedModules = [
  "src/engine/turn/query-loop.ts",
  "src/engine/turn/intercepted-meta-gate.ts",
  "src/plugins/runtime/index.ts",
  "src/plugins/runtime/runtime-state.ts",
  "src/plugins/runtime/runtime-lifecycle.ts",
  "src/preload/internal-surface.ts",
  "src/preload/internal-api-surface.ts",
  "src/data/settings-store.ts",
  "src/data/settings-defaults.ts",
  "src/data/settings-normalization.ts",
  "src/ui/renderer/components/ChatSidePanel.tsx",
  "src/ui/renderer/components/chat-side-panel-preview.tsx",
  "src/ui/renderer/components/chat-side-panel-layout.tsx",
  "src/ui/renderer/components/chat-side-panel-workspaces.tsx",
] as const;

describe("large module ownership boundaries", () => {
  it.each(scopedModules)("keeps %s below the implementation ceiling", (modulePath) => {
    const source = readFileSync(resolve(process.cwd(), modulePath), "utf8");
    const lines = source.split(/\r?\n/).length;
    expect(lines, `${modulePath} has ${lines} lines`).toBeLessThanOrEqual(MAX_IMPLEMENTATION_LINES);
  });
});
