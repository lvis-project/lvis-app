import { describe, it, expect } from "vitest";
import {
  DEFAULT_ROLE_PRESETS,
  buildActiveRolePrompt,
  cloneDefaultRolePresets,
  normalizeRolePresets,
} from "../role-presets.js";

describe("role-presets", () => {
  it("ships the 6 advertised presets", () => {
    const names = DEFAULT_ROLE_PRESETS.map((p) => p.name);
    expect(names).toEqual(["기본", "요약가", "코드 리뷰어", "번역가", "개발 비서", "에디터"]);
  });

  it("default preset yields no role prompt — user message flows unchanged", () => {
    const def = DEFAULT_ROLE_PRESETS.find((p) => p.isDefault)!;
    expect(buildActiveRolePrompt(def)).toBeNull();
    expect(buildActiveRolePrompt(null)).toBeNull();
  });

  it("non-default preset builds a per-turn system role prompt payload", () => {
    const summarizer = DEFAULT_ROLE_PRESETS.find((p) => p.id === "summarizer")!;
    const payload = buildActiveRolePrompt(summarizer);
    expect(payload).toEqual({
      name: "요약가",
      systemPromptAdd: expect.stringContaining("professional summarizer"),
    });
  });

  it("cloneDefaultRolePresets returns independent objects", () => {
    const first = cloneDefaultRolePresets();
    first[0].name = "changed";
    expect(cloneDefaultRolePresets()[0].name).toBe("기본");
  });

  it("normalizes stored role settings and preserves the default preset", () => {
    const normalized = normalizeRolePresets([
      { id: "review", name: "Review", systemPromptAdd: "review carefully" },
      { id: "review", name: "Duplicate", systemPromptAdd: "ignored" },
      { id: "", name: "Invalid", systemPromptAdd: "ignored" },
    ]);
    expect(normalized.map((preset) => preset.id)).toEqual(["default", "review"]);
    expect(normalized[1].systemPromptAdd).toBe("review carefully");
  });

  it("canonicalizes the default role and strips forged isDefault flags", () => {
    const normalized = normalizeRolePresets([
      { id: "default", name: "Forged", systemPromptAdd: "inject" },
      { id: "custom", name: "Custom", systemPromptAdd: "custom", isDefault: true },
    ]);
    expect(normalized).toEqual([
      { id: "default", name: "기본", systemPromptAdd: "", isDefault: true },
      { id: "custom", name: "Custom", systemPromptAdd: "custom" },
    ]);
  });
});
