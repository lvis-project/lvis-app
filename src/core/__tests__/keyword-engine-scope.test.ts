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

  it("unregisterByPlugin() removes only that plugin's keywords", () => {
    const eng = new KeywordEngine();
    eng.registerKeywords([
      { keyword: "회의록", skillId: "m.s", pluginId: "com.lge.meeting" },
      { keyword: "이메일", skillId: "e.l", pluginId: "com.lge.email" },
      { keyword: "번역", skillId: "b.t" }, // builtin — no pluginId
    ]);
    eng.unregisterByPlugin("com.lge.meeting");
    // meeting keyword gone
    expect(eng.matchAllPluginIds("회의록")).toEqual(new Set());
    // email keyword still present
    expect(eng.matchAllPluginIds("이메일")).toEqual(new Set(["com.lge.email"]));
    // builtin keyword still classifies
    const r = eng.classify("이 문장 번역해줘");
    expect(r.type).toBe("skill");
  });
});

describe("KeywordEngine — imported-from-proactive envelope bypass", () => {
  it("envelope with valid proactive: source is classified as `general`, NOT `skill`", () => {
    // Ensures the trigger-import path doesn't get tagged with
    // "[스킬: email_list]" just because the brain prompt happens to
    // mention the word "이메일/메일/email" (which it always does for
    // the meeting-detection detector). Regression cover for the
    // "[스킬: email_list] 회의 요청 이메일이 도착했습니다…" bug.
    const eng = new KeywordEngine();
    eng.registerKeywords([
      { keyword: "이메일", skillId: "email_list", pluginId: "email" },
      { keyword: "메일", skillId: "email_list", pluginId: "email" },
    ]);
    const envelope =
      `<imported-from-proactive source="proactive:meeting-detection">\n` +
      `회의 요청 이메일이 도착했습니다.\n- 제목: 라이코펜 회의요청\n` +
      `</imported-from-proactive>`;
    const r = eng.classify(envelope);
    expect(r.type).toBe("general");
  });

  it("envelope with malformed source (uppercase) does NOT bypass — falls through to skill match", () => {
    // Tightens the matcher to the same strict pattern that
    // ipc-bridge.ts' detectImportedTriggerSource accepts. A pasted
    // envelope with non-conforming source must NOT skip skill
    // routing here while ALSO failing to activate
    // <proactive-origin-guidance> over there — that asymmetry would
    // be a security gap (plugin-supplied imperatives reach the LLM
    // with no guard).
    const eng = new KeywordEngine();
    eng.registerKeywords([
      { keyword: "이메일", skillId: "email_list", pluginId: "email" },
    ]);
    const envelope =
      `<imported-from-proactive source="Proactive:bad">\n` +
      `이메일 본문\n` +
      `</imported-from-proactive>`;
    const r = eng.classify(envelope);
    expect(r.type).toBe("skill");
  });

  it("envelope embedded mid-input (not at start) does NOT bypass", () => {
    const eng = new KeywordEngine();
    eng.registerKeywords([
      { keyword: "이메일", skillId: "email_list", pluginId: "email" },
    ]);
    const r = eng.classify(
      `이메일 정리 부탁: <imported-from-proactive source="proactive:x">…`,
    );
    expect(r.type).toBe("skill");
  });
});
