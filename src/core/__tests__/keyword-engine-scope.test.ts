/**
 * Phase 1 Lazy Tool Scoping — KeywordEngine pluginId propagation tests.
 */
import { describe, it, expect } from "vitest";
import { KeywordEngine } from "../keyword-engine.js";

describe("KeywordEngine — pluginId propagation (Phase 1 scoping)", () => {
  it("classify() returns pluginId when keyword is plugin-owned", () => {
    const eng = new KeywordEngine();
    eng.registerKeywords([
      { keyword: "회의록", skillId: "meeting.start", pluginId: "com.lge.meeting" },
    ]);
    const r = eng.classify("오늘 회의록 작성해줘");
    expect(r.type).toBe("skill");
    if (r.type === "skill") {
      expect(r.pluginId).toBe("com.lge.meeting");
    }
  });

  it("classify() omits pluginId for builtin-registered keywords", () => {
    const eng = new KeywordEngine();
    eng.registerKeywords([{ keyword: "번역", skillId: "builtin.translate" }]);
    const r = eng.classify("이 문장 번역해줘");
    expect(r.type).toBe("skill");
    if (r.type === "skill") {
      expect(r.pluginId).toBeUndefined();
    }
  });

  it("matchAllPluginIds() returns union of matched plugin IDs", () => {
    const eng = new KeywordEngine();
    eng.registerKeywords([
      { keyword: "회의록", skillId: "m.s", pluginId: "com.lge.meeting" },
      { keyword: "이메일", skillId: "e.l", pluginId: "com.lge.email" },
      { keyword: "번역", skillId: "b.t" }, // builtin — ignored
    ]);
    const ids = eng.matchAllPluginIds("회의록 정리해서 이메일로 보내고 번역도");
    expect(ids).toEqual(new Set(["com.lge.meeting", "com.lge.email"]));
  });

  it("matchAllPluginIds() returns empty Set when nothing matches", () => {
    const eng = new KeywordEngine();
    eng.registerKeywords([
      { keyword: "회의록", skillId: "m.s", pluginId: "com.lge.meeting" },
    ]);
    expect(eng.matchAllPluginIds("날씨 어때")).toEqual(new Set());
  });
});
