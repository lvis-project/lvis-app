/**
 * Auto-Compact — 2-stage compaction tests.
 *
 * Stage 1 (markStaleToolResults): preventive tool_result stub 교체.
 * Stage 2 (compactMessages): threshold 초과 시 요약 생성 + boundary marker.
 */
import { describe, it, expect } from "vitest";

import {
  markStaleToolResults,
  compactMessages,
  estimateTokens,
  countHangul,
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
  it("strips older tool_results while preserving the most recent N", () => {
    const messages = synth();
    const { messages: out, result } = markStaleToolResults(messages, {
      preserveRecentToolResults: 4,
    });

    expect(result.stripped).toBe(true);
    expect(result.strippedCount).toBe(6); // 10 - 4
    expect(result.freedChars).toBeGreaterThan(0);

    const toolResults = out.filter((m) => m.role === "tool_result");
    expect(toolResults).toHaveLength(10);

    // 처음 6개는 stripped, 끝 4개는 raw
    for (let i = 0; i < 6; i++) {
      const m = toolResults[i];
      expect(m.role).toBe("tool_result");
      if (m.role === "tool_result") {
        expect(m.meta?.stripped).toBe(true);
        expect(m.meta?.originalLength).toBeGreaterThan(1000);
        expect(m.content).toContain("[tool_result stripped");
      }
    }
    for (let i = 6; i < 10; i++) {
      const m = toolResults[i];
      if (m.role === "tool_result") {
        expect(m.meta?.stripped).toBeUndefined();
        expect(m.content.length).toBeGreaterThan(1000);
      }
    }
  });

  it("is idempotent — second call produces no changes", () => {
    const messages = synth();
    const first = markStaleToolResults(messages, { preserveRecentToolResults: 4 });
    const second = markStaleToolResults(first.messages, { preserveRecentToolResults: 4 });

    expect(second.result.stripped).toBe(false);
    expect(second.result.strippedCount).toBe(0);
    // 새 객체를 만들지 않고 reference 유지 기대 (stripped 후보 없음 → early return 또는 map pass-through)
    // 여기선 strippedCount만 확인해도 idempotency 충족
  });

  it("preserves tool_use_id linkage for stripped messages", () => {
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
    expect(result.stripped).toBe(false);
    expect(out).toBe(messages); // reference-equal
  });

  it("skips tool_results below minStubThreshold (OpenCode pattern, default 200 chars)", () => {
    // 10개 모두 100자짜리 (default threshold 200 미만). preserveRecentToolResults=4 라도 모두 skip.
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
    expect(result.stripped).toBe(false);
    expect(result.strippedCount).toBe(0);
    expect(out).toBe(msgs); // reference-equal — no allocation
  });

  it("respects custom minStubThreshold", () => {
    // 10개 모두 50자짜리. minStubThreshold=10 이면 처음 6개는 strip 됨.
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
    expect(result.stripped).toBe(true);
    expect(result.strippedCount).toBe(6);
  });
});

describe("compactMessages — boundary marker", () => {
  it("tags the generated summary user message with compactBoundary=true", () => {
    const messages: GenericMessage[] = [];
    for (let i = 0; i < 20; i++) {
      messages.push({ role: "user", content: `q${i}` });
      messages.push({ role: "assistant", content: `a${i}` });
    }
    const { messages: out, result } = compactMessages(messages);
    expect(result.compacted).toBe(true);

    const marker = out.find(
      (m) => m.role === "user" && m.meta?.compactBoundary === true,
    );
    expect(marker).toBeDefined();
    expect(marker?.content).toContain("[이전 대화 요약]");
    expect(marker?.meta?.removedCount).toBeGreaterThan(0);
    expect(marker?.meta?.compactedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("does not re-summarize an existing boundary marker (double-compact prevention)", () => {
    // 1) 첫 compact
    const initial: GenericMessage[] = [];
    for (let i = 0; i < 20; i++) {
      initial.push({ role: "user", content: `q${i}` });
      initial.push({ role: "assistant", content: `a${i}` });
    }
    const first = compactMessages(initial);
    expect(first.result.compacted).toBe(true);
    const originalMarker = first.messages.find(
      (m) => m.role === "user" && m.meta?.compactBoundary === true,
    );

    // 2) 대화를 더 이어서 두 번째 compact 트리거
    const extended: GenericMessage[] = [...first.messages];
    for (let i = 0; i < 20; i++) {
      extended.push({ role: "user", content: `q2-${i}` });
      extended.push({ role: "assistant", content: `a2-${i}` });
    }
    const second = compactMessages(extended);
    expect(second.result.compacted).toBe(true);

    // 원본 marker가 여전히 메시지 배열 안에 reference-equal로 존재
    const stillThere = second.messages.find((m) => m === originalMarker);
    expect(stillThere).toBeDefined();

    // 새 marker도 생성됨 (두 개의 boundary 가능)
    const markerCount = second.messages.filter(
      (m) => m.role === "user" && m.meta?.compactBoundary === true,
    ).length;
    expect(markerCount).toBeGreaterThanOrEqual(2);
  });
});

// ─── Korean weighting (P11) ────────────────────────────

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
