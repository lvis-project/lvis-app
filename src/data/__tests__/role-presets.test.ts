import { describe, it, expect, beforeEach } from "vitest";
import {
  DEFAULT_ROLE_PRESETS,
  buildPresetPrefix,
  loadRolePresets,
  saveRolePresets,
  resetRolePresets,
} from "../role-presets.js";

describe("role-presets", () => {
  beforeEach(() => {
    try { (globalThis as any).window?.localStorage?.clear?.(); } catch { /* ignore */ }
  });

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

  it("load falls back to defaults when storage is empty", () => {
    const list = loadRolePresets();
    expect(list.length).toBeGreaterThan(0);
  });

  it("save + load round-trips custom presets when localStorage exists", () => {
    if (typeof window === "undefined" || !window.localStorage) return;
    const custom = [
      { id: "x", name: "X", systemPromptAdd: "hi", effort: "low" as const, temperature: 0.2 },
    ];
    saveRolePresets(custom);
    expect(loadRolePresets()).toEqual(custom);
    resetRolePresets();
    expect(loadRolePresets()).toEqual(DEFAULT_ROLE_PRESETS);
  });
});
