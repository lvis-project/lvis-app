import { describe, it, expect } from "vitest";
import remarkGfm from "remark-gfm";
import { MARKDOWN_REMARK_PLUGINS, remarkKoreanAdjacentStrong } from "../markdown-plugins.js";

// Single source of truth check. Every chat-side ReactMarkdown
// (AssistantCard, TriggerCard, RoutineCard, ImportedTriggerCard summary +
// response) imports MARKDOWN_REMARK_PLUGINS, so verifying the constant
// here verifies every consumer transitively. If a future change inlines
// `[remarkGfm]` (or different options) in any of those surfaces, this
// test won't catch it — but the typed import itself prevents silent
// drift, and a `grep -r remarkGfm` would surface any new direct usage.

describe("MARKDOWN_REMARK_PLUGINS shared config", () => {
  it("exposes the shared plugin entries", () => {
    expect(MARKDOWN_REMARK_PLUGINS).toBeDefined();
    expect(MARKDOWN_REMARK_PLUGINS).toHaveLength(2);
  });

  it("plugin is remark-gfm with singleTilde disabled", () => {
    const list = MARKDOWN_REMARK_PLUGINS as Array<[unknown, { singleTilde: boolean }] | unknown>;
    expect(Array.isArray(list[0])).toBe(true);
    const gfm = list[0] as [unknown, { singleTilde: boolean }];
    expect(gfm[0]).toBe(remarkGfm);
    expect(gfm[1]).toEqual({ singleTilde: false });
  });

  it("includes the Korean adjacent strong normalizer", () => {
    expect(MARKDOWN_REMARK_PLUGINS?.[1]).toBe(remarkKoreanAdjacentStrong);
  });
});
