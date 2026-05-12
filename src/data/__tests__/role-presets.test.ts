import { describe, it, expect } from "vitest";
import {
  DEFAULT_ROLE_PRESETS,
  buildPresetPrefix,
  cloneDefaultRolePresets,
  normalizeRolePresets,
} from "../role-presets.js";

describe("role-presets", () => {
  it("ships the 6 advertised presets", () => {
    const names = DEFAULT_ROLE_PRESETS.map((p) => p.name);
    expect(names).toEqual(["기본", "요약가", "코드 리뷰어", "번역가", "개발 비서", "에디터"]);
  });

  it("default preset yields an empty prefix — user message flows unchanged", () => {
    const def = DEFAULT_ROLE_PRESETS.find((p) => p.isDefault)!;
    expect(buildPresetPrefix(def)).toBe("");
    expect(buildPresetPrefix(null)).toBe("");
  });

  it("non-default preset injects a labeled prompt prefix", () => {
    const summarizer = DEFAULT_ROLE_PRESETS.find((p) => p.id === "summarizer")!;
    const prefix = buildPresetPrefix(summarizer);
    expect(prefix).toContain("[Role: 요약가]");
    expect(prefix).toContain("professional summarizer");
    expect(prefix.endsWith("\n\n")).toBe(true);
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
});
