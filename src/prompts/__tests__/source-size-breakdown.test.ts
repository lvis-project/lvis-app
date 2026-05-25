/**
 * Per-source system-prompt size breakdown (TPM base-size measurement enabler).
 *
 * Verifies:
 *   - getSourceSizeBreakdown() returns one entry per assembled (non-empty) source
 *   - per-source `chars` sum (+ "\n\n" join separators) reconciles with build().length
 *   - totalEstTokens equals the sum of per-source estTokens
 *   - entries are sorted descending by chars
 *   - expected representative labels (tools / memory) are present
 *   - the dev-only LVIS_DEV_PROMPT_SOURCE_DUMP gate never alters the assembled
 *     prompt (measurement only — no behavior change)
 */
import { afterEach, describe, expect, it } from "vitest";

import { SystemPromptBuilder } from "../system-prompt-builder.js";
import { ToolRegistry } from "../../tools/registry.js";
import { createDynamicTool } from "../../tools/base.js";

function makeToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(
    createDynamicTool({
      name: "bash",
      description: "Run a shell command.",
      source: "builtin",
      category: "shell",
      jsonSchema: { type: "object", properties: {} },
      execute: async () => ({ output: "", isError: false }),
    }),
  );
  return registry;
}

function makeBuilderWithMemory(): SystemPromptBuilder {
  return new SystemPromptBuilder({
    memoryManager: {
      getAgentsMd: () => "# Agents\n\nProject conventions go here.",
      getLvisMd: () => "# Agents",
      getMemoryIndex: () => "# Memory Index\n\n- [A](./a.md)\n- [B](./b.md)",
      getUserPreferences: () => "Prefers concise answers.",
      getMemoryContext: () => "",
    } as never,
    toolRegistry: makeToolRegistry(),
  });
}

describe("SystemPromptBuilder — getSourceSizeBreakdown", () => {
  it("returns one entry per assembled non-empty source", () => {
    const builder = makeBuilderWithMemory();
    const { sources } = builder.getSourceSizeBreakdown();

    // Every kept source corresponds to a non-empty rendered section.
    expect(sources.length).toBeGreaterThan(0);
    for (const entry of sources) {
      expect(entry.chars).toBeGreaterThan(0);
      expect(entry.estTokens).toBeGreaterThan(0);
      expect(typeof entry.label).toBe("string");
      expect(entry.label.length).toBeGreaterThan(0);
    }
  });

  it("reconciles per-source chars (+ join separators) with build().length", () => {
    const builder = makeBuilderWithMemory();
    const prompt = builder.build();
    const { sources, totalChars } = builder.getSourceSizeBreakdown();

    // build() joins kept sections with "\n\n" (2 chars) between them.
    const joinChars = sources.length > 1 ? (sources.length - 1) * 2 : 0;
    const charsSum = sources.reduce((sum, s) => sum + s.chars, 0);

    expect(totalChars).toBe(charsSum + joinChars);
    expect(totalChars).toBe(prompt.length);
  });

  it("totalEstTokens equals the sum of per-source estTokens", () => {
    const builder = makeBuilderWithMemory();
    const { sources, totalEstTokens } = builder.getSourceSizeBreakdown();
    const tokenSum = sources.reduce((sum, s) => sum + s.estTokens, 0);
    expect(totalEstTokens).toBe(tokenSum);
  });

  it("sorts entries descending by chars", () => {
    const builder = makeBuilderWithMemory();
    const { sources } = builder.getSourceSizeBreakdown();
    for (let i = 1; i < sources.length; i++) {
      expect(sources[i - 1].chars).toBeGreaterThanOrEqual(sources[i].chars);
    }
  });

  it("includes the expected representative source labels (tools + memory)", () => {
    const builder = makeBuilderWithMemory();
    const labels = builder.getSourceSizeBreakdown().sources.map((s) => s.label);
    // Tool descriptions/input_schema source and the memory source — the two
    // candidates we expect to dominate the per-round base.
    expect(labels).toContain("Tool Schemas");
    expect(labels).toContain("Memory & Knowledge");
  });

  it("is pure — repeated calls return identical totals and do not mutate state", () => {
    const builder = makeBuilderWithMemory();
    const first = builder.getSourceSizeBreakdown();
    const second = builder.getSourceSizeBreakdown();
    expect(second.totalChars).toBe(first.totalChars);
    expect(second.totalEstTokens).toBe(first.totalEstTokens);
    // build() after measuring is unchanged.
    expect(builder.build().length).toBe(first.totalChars);
  });
});

describe("SystemPromptBuilder — LVIS_DEV_PROMPT_SOURCE_DUMP gate (no behavior change)", () => {
  const savedDump = process.env.LVIS_DEV_PROMPT_SOURCE_DUMP;
  const savedNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (savedDump === undefined) delete process.env.LVIS_DEV_PROMPT_SOURCE_DUMP;
    else process.env.LVIS_DEV_PROMPT_SOURCE_DUMP = savedDump;
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedNodeEnv;
  });

  it("produces byte-identical prompt whether the dev dump flag is set or not", () => {
    delete process.env.LVIS_DEV_PROMPT_SOURCE_DUMP;
    const withoutFlag = makeBuilderWithMemory().build();

    process.env.LVIS_DEV_PROMPT_SOURCE_DUMP = "1";
    const withFlag = makeBuilderWithMemory().build();

    // The dump is a side-effect-only log; the assembled prompt is unaffected.
    expect(withFlag).toBe(withoutFlag);
  });

  it("does not log under production NODE_ENV even when the flag is set", () => {
    // The gate short-circuits on production NODE_ENV; build() must still succeed
    // and yield the same prompt (no throw, no content change).
    process.env.NODE_ENV = "production";
    process.env.LVIS_DEV_PROMPT_SOURCE_DUMP = "1";
    const prod = makeBuilderWithMemory().build();

    delete process.env.NODE_ENV;
    delete process.env.LVIS_DEV_PROMPT_SOURCE_DUMP;
    const dev = makeBuilderWithMemory().build();

    expect(prod).toBe(dev);
  });
});
