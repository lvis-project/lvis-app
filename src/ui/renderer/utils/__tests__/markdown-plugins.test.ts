import { describe, it, expect } from "vitest";
import remarkGfm from "remark-gfm";
import { MARKDOWN_REMARK_PLUGINS } from "../markdown-plugins.js";

// Single source of truth check. Every chat-side ReactMarkdown
// (AssistantCard, TriggerCard, RoutineCard, ImportedTriggerCard summary +
// response) imports MARKDOWN_REMARK_PLUGINS, so verifying the constant
// here verifies every consumer transitively. If a future change inlines
// `[remarkGfm]` (or different options) in any of those surfaces, this
// test won't catch it — but the typed import itself prevents silent
// drift, and a `grep -r remarkGfm` would surface any new direct usage.

describe("MARKDOWN_REMARK_PLUGINS shared config", () => {
  it("exposes exactly one plugin entry (remark-gfm with options)", () => {
    expect(MARKDOWN_REMARK_PLUGINS).toBeDefined();
    expect(MARKDOWN_REMARK_PLUGINS).toHaveLength(1);
  });

  it("plugin is remark-gfm with singleTilde disabled", () => {
    const list = MARKDOWN_REMARK_PLUGINS as Array<[unknown, { singleTilde: boolean }]>;
    expect(Array.isArray(list[0])).toBe(true);
    expect(list[0]![0]).toBe(remarkGfm);
    expect(list[0]![1]).toEqual({ singleTilde: false });
  });
});
