/**
 * Auto-Compact tests.
 *
 * markStaleToolResults: preventive tool_result stub 교체.
 */
import { describe, it, expect } from "vitest";

import {
  markStaleToolResults,
  estimateTokens,
  countHangul,
  getModelPreflightThreshold,
  setRuntimePreflightOverride,
  getRuntimePreflightOverride,
} from "../auto-compact.js";
import type { GenericMessage } from "../llm/types.js";

function makeToolUseId(i: number): string {
  return `toolu_${String(i).padStart(3, "0")}`;
}

/** 10개의 tool_use/tool_result 쌍을 가진 합성 대화 */
function synth(withLargeResults = true): GenericMessage[] {
  const msgs: GenericMessage[] = [{ role: "user", content: "시작하자" }];
  for (let i = 0; i < 10; i++) {
    const id = makeToolUseId(i);
    msgs.push({
      role: "assistant",
      content: `step ${i}`,
      toolCalls: [{ id, name: "search", input: { q: `query-${i}` } }],
    });
    msgs.push({
      role: "tool_result",
      toolUseId: id,
      toolName: "search",
      content: withLargeResults ? "x".repeat(5000) + `#${i}` : `small-${i}`,
    });
  }
  msgs.push({ role: "assistant", content: "끝" });
  return msgs;
}

describe("markStaleToolResults", () => {
  it("marks older tool_results while preserving the most recent N (memory verbatim)", () => {
    const messages = synth();
    const { messages: out, result } = markStaleToolResults(messages, {
      preserveRecentToolResults: 4,
    });

    expect(result.marked).toBe(true);
    expect(result.markedCount).toBe(6); // 10 - 4
    expect(result.freedCharsOnSerialize).toBeGreaterThan(0);

    const toolResults = out.filter((m) => m.role === "tool_result");
    expect(toolResults).toHaveLength(10);

    // 처음 6개: marked (compactedAt set) + content *verbatim*.
    for (let i = 0; i < 6; i++) {
      const m = toolResults[i];
      expect(m.role).toBe("tool_result");
      if (m.role === "tool_result") {
        expect(m.meta?.compactedAt).toMatch(/^\d{4}-/); // ISO timestamp set
        // content 는 *원본* 그대로 — wire-serialize 단계에서 stub 변환됨
        expect(m.content.length).toBeGreaterThan(1000);
        expect(m.content).not.toContain("[tool_result stripped");
      }
    }
    // 끝 4개: 마킹 없음, content 그대로
    for (let i = 6; i < 10; i++) {
      const m = toolResults[i];
      if (m.role === "tool_result") {
        expect(m.meta?.compactedAt).toBeUndefined();
        expect(m.content.length).toBeGreaterThan(1000);
      }
    }
  });

  it("is idempotent — second call produces no changes", () => {
    const messages = synth();
    const first = markStaleToolResults(messages, { preserveRecentToolResults: 4 });
    const second = markStaleToolResults(first.messages, { preserveRecentToolResults: 4 });

    expect(second.result.marked).toBe(false);
    expect(second.result.markedCount).toBe(0);
  });

  it("preserves tool_use_id linkage for marked messages", () => {
    const messages = synth();
    const { messages: out } = markStaleToolResults(messages, {
      preserveRecentToolResults: 4,
    });

    // 모든 assistant toolCall id가 대응 tool_result에 그대로 보존
    const callIds: string[] = [];
    for (const m of out) {
      if (m.role === "assistant" && m.toolCalls) {
        for (const tc of m.toolCalls) callIds.push(tc.id);
      }
    }
    const resultIds: string[] = [];
    for (const m of out) {
      if (m.role === "tool_result") resultIds.push(m.toolUseId);
    }
    expect(resultIds.sort()).toEqual(callIds.sort());
  });

  it("returns input unchanged when fewer tool_results than preserve count", () => {
    const messages: GenericMessage[] = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "t1", name: "f", input: {} }],
      },
      { role: "tool_result", toolUseId: "t1", toolName: "f", content: "data" },
    ];
    const { messages: out, result } = markStaleToolResults(messages, {
      preserveRecentToolResults: 4,
    });
    expect(result.marked).toBe(false);
    expect(out).toBe(messages); // reference-equal
  });

  it("skips tool_results below minStubThreshold (OpenCode pattern, default 200 chars)", () => {
    const msgs: GenericMessage[] = [{ role: "user", content: "go" }];
    for (let i = 0; i < 10; i++) {
      const id = makeToolUseId(i);
      msgs.push({
        role: "assistant",
        content: `s${i}`,
        toolCalls: [{ id, name: "search", input: {} }],
      });
      msgs.push({
        role: "tool_result",
        toolUseId: id,
        toolName: "search",
        content: "y".repeat(100), // 100 < 200
      });
    }
    const { messages: out, result } = markStaleToolResults(msgs, {
      preserveRecentToolResults: 4,
    });
    expect(result.marked).toBe(false);
    expect(result.markedCount).toBe(0);
    expect(out).toBe(msgs); // reference-equal — no allocation
  });

  it("respects custom minStubThreshold", () => {
    const msgs: GenericMessage[] = [{ role: "user", content: "go" }];
    for (let i = 0; i < 10; i++) {
      const id = makeToolUseId(i);
      msgs.push({
        role: "assistant",
        content: `s${i}`,
        toolCalls: [{ id, name: "search", input: {} }],
      });
      msgs.push({
        role: "tool_result",
        toolUseId: id,
        toolName: "search",
        content: "z".repeat(50), // 50 >= 10
      });
    }
    const { result } = markStaleToolResults(msgs, {
      preserveRecentToolResults: 4,
      minStubThreshold: 10,
    });
    expect(result.marked).toBe(true);
    expect(result.markedCount).toBe(6);
  });
});

describe("countHangul", () => {
  it("counts 가-힣 characters only", () => {
    expect(countHangul("안녕하세요")).toBe(5);
    expect(countHangul("hello")).toBe(0);
    expect(countHangul("안녕 hello 세계")).toBe(4); // 안녕 (2) + 세계 (2) = 4
  });

  it("ignores hangul jamo (ㄱ-ㅎ, ㅏ-ㅣ outside 가-힣 syllable block)", () => {
    // U+3131 (ㄱ) is *outside* 가-힣 (U+AC00~U+D7A3) syllable range — not counted
    expect(countHangul("ㄱㄴㄷ")).toBe(0);
  });

  it("returns 0 for empty string", () => {
    expect(countHangul("")).toBe(0);
  });
});

describe("estimateTokens — chars/4 + 1 with Korean weighting (P11)", () => {
  it("100% English: weight 1.0", () => {
    // length 8 / 4 + 1 = 3
    expect(estimateTokens("hello123")).toBe(3);
  });

  it("100% Korean (ratio = 1.0): weight 1.3", () => {
    // length 5 (안녕하세요), ratio 1.0 → ceil(5 × 1.3 / 4) + 1 = ceil(1.625) + 1 = 2 + 1 = 3
    expect(estimateTokens("안녕하세요")).toBe(3);
  });

  it("Korean ≥ 50% triggers weight 1.3", () => {
    // 한글 5 chars + ABC 3 chars = 8 total, ratio 5/8 = 0.625 ≥ 0.5
    // ceil(8 × 1.3 / 4) + 1 = ceil(2.6) + 1 = 3 + 1 = 4
    expect(estimateTokens("한글ABC글한")).toBe(4);
  });

  it("Korean < 50% does NOT trigger weight (mixed code+comment)", () => {
    // "function 한글() { return 1; }" — 30 chars total, hangul 2 = ratio 0.067 < 0.5 → weight 1.0
    const text = "function 한글() { return 1; }";
    const expected = Math.ceil(text.length / 4) + 1;
    expect(estimateTokens(text)).toBe(expected);
  });

  it("50:50 boundary edge — exactly 50% triggers weight", () => {
    // 5 hangul + 5 ASCII = 10 chars, ratio 0.5 → weight 1.3
    // ceil(10 × 1.3 / 4) + 1 = ceil(3.25) + 1 = 4 + 1 = 5
    expect(estimateTokens("ABCDE안녕하세요")).toBe(5);
  });

  it("empty string returns 1 (no division by zero)", () => {
    expect(estimateTokens("")).toBe(1);
  });

  it("Korean estimate is strictly larger than naive chars/4 for hangul-heavy", () => {
    const longHangul = "안녕".repeat(100); // 200 hangul chars
    const naive = Math.ceil(200 / 4) + 1; // 51
    const weighted = estimateTokens(longHangul);
    expect(weighted).toBeGreaterThan(naive);
    expect(weighted).toBe(Math.ceil(200 * 1.3 / 4) + 1); // 66
  });
});

describe("getModelPreflightThreshold — LVIS_DEV_PREFLIGHT_OVERRIDE", () => {
  const origOverride = process.env.LVIS_DEV_PREFLIGHT_OVERRIDE;
  const origNodeEnv = process.env.NODE_ENV;

  function restore(): void {
    if (origOverride === undefined) delete process.env.LVIS_DEV_PREFLIGHT_OVERRIDE;
    else process.env.LVIS_DEV_PREFLIGHT_OVERRIDE = origOverride;
    if (origNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = origNodeEnv;
  }

  it("returns computed threshold when override is unset", () => {
    delete process.env.LVIS_DEV_PREFLIGHT_OVERRIDE;
    delete process.env.NODE_ENV;
    const t = getModelPreflightThreshold("claude", "claude-sonnet-4-5");
    expect(t).toBeGreaterThan(0);
    expect(t).not.toBe(5000);
    restore();
  });

  it("returns override value when LVIS_DEV_PREFLIGHT_OVERRIDE is set in non-prod", () => {
    process.env.LVIS_DEV_PREFLIGHT_OVERRIDE = "5000";
    delete process.env.NODE_ENV;
    expect(getModelPreflightThreshold("claude", "claude-sonnet-4-5")).toBe(5000);
    restore();
  });

  it("ignores override in production NODE_ENV", () => {
    process.env.LVIS_DEV_PREFLIGHT_OVERRIDE = "5000";
    process.env.NODE_ENV = "production";
    const t = getModelPreflightThreshold("claude", "claude-sonnet-4-5");
    expect(t).not.toBe(5000);
    expect(t).toBeGreaterThan(50_000);
    restore();
  });

  it("ignores malformed override values", () => {
    process.env.LVIS_DEV_PREFLIGHT_OVERRIDE = "not-a-number";
    delete process.env.NODE_ENV;
    const t = getModelPreflightThreshold("claude", "claude-sonnet-4-5");
    expect(t).toBeGreaterThan(50_000);
    restore();
  });

  it("ignores zero and negative override values", () => {
    process.env.LVIS_DEV_PREFLIGHT_OVERRIDE = "0";
    delete process.env.NODE_ENV;
    expect(getModelPreflightThreshold("claude", "claude-sonnet-4-5")).toBeGreaterThan(50_000);
    process.env.LVIS_DEV_PREFLIGHT_OVERRIDE = "-100";
    expect(getModelPreflightThreshold("claude", "claude-sonnet-4-5")).toBeGreaterThan(50_000);
    restore();
  });
});

describe("getModelPreflightThreshold — setRuntimePreflightOverride (Dev Tools panel)", () => {
  const origOverride = process.env.LVIS_DEV_PREFLIGHT_OVERRIDE;
  const origNodeEnv = process.env.NODE_ENV;

  function restore(): void {
    setRuntimePreflightOverride(null);
    if (origOverride === undefined) delete process.env.LVIS_DEV_PREFLIGHT_OVERRIDE;
    else process.env.LVIS_DEV_PREFLIGHT_OVERRIDE = origOverride;
    if (origNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = origNodeEnv;
  }

  it("runtime override takes priority over env override", () => {
    process.env.LVIS_DEV_PREFLIGHT_OVERRIDE = "1000";
    delete process.env.NODE_ENV;
    setRuntimePreflightOverride(7500);
    expect(getModelPreflightThreshold("claude", "claude-sonnet-4-5")).toBe(7500);
    expect(getRuntimePreflightOverride()).toBe(7500);
    restore();
  });

  it("setRuntimePreflightOverride is a no-op in production NODE_ENV", () => {
    process.env.NODE_ENV = "production";
    setRuntimePreflightOverride(7500);
    expect(getRuntimePreflightOverride()).toBeNull();
    expect(getModelPreflightThreshold("claude", "claude-sonnet-4-5")).toBeGreaterThan(50_000);
    restore();
  });

  it("setRuntimePreflightOverride(null) clears runtime override and falls back to env/computed", () => {
    process.env.LVIS_DEV_PREFLIGHT_OVERRIDE = "3000";
    delete process.env.NODE_ENV;
    setRuntimePreflightOverride(7500);
    expect(getModelPreflightThreshold("claude", "claude-sonnet-4-5")).toBe(7500);
    setRuntimePreflightOverride(null);
    expect(getRuntimePreflightOverride()).toBeNull();
    // After clear, env override should take effect
    expect(getModelPreflightThreshold("claude", "claude-sonnet-4-5")).toBe(3000);
    // Clear env too — should fall back to computed
    delete process.env.LVIS_DEV_PREFLIGHT_OVERRIDE;
    expect(getModelPreflightThreshold("claude", "claude-sonnet-4-5")).toBeGreaterThan(50_000);
    restore();
  });

  it("setRuntimePreflightOverride rejects malformed values (no state change)", () => {
    delete process.env.NODE_ENV;
    setRuntimePreflightOverride(7500);
    setRuntimePreflightOverride(Number.NaN);
    expect(getRuntimePreflightOverride()).toBe(7500); // unchanged
    setRuntimePreflightOverride(0);
    expect(getRuntimePreflightOverride()).toBe(7500); // unchanged
    setRuntimePreflightOverride(-100);
    expect(getRuntimePreflightOverride()).toBe(7500); // unchanged
    restore();
  });
});
