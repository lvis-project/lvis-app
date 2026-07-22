/**
 * Auto-Compact tests.
 *
 * markStaleToolResults: preventive tool_result stub 교체.
 */
import { describe, it, expect } from "vitest";

import {
  markStaleToolResults,
  evictAgedToolResultImages,
  estimateTokens,
  estimateMessagesTokens,
  countHangul,
  getModelPreflightThreshold,
  setRuntimePreflightOverride,
  getRuntimePreflightOverride,
} from "../auto-compact.js";
import { stubMarkedToolResults } from "../wire-serialize.js";
import { isToolResultStubContent } from "../../shared/tool-result-stub.js";
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

  it("skips tool_results below minStubThreshold (default 200 chars)", () => {
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

/** N개의 tool_use/tool_result 쌍 (각 result > minStubThreshold). */
function synthN(count: number): GenericMessage[] {
  const msgs: GenericMessage[] = [{ role: "user", content: "시작하자" }];
  for (let i = 0; i < count; i++) {
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
      content: "x".repeat(5000) + `#${i}`,
    });
  }
  return msgs;
}

describe("markStaleToolResults — view_image image eviction", () => {
  function imageRow(id: string, data = "QUJD"): GenericMessage {
    return {
      role: "tool_result",
      toolUseId: id,
      toolName: "view_image",
      content: "[image loaded]", // tiny placeholder, well under the 200-char floor
      image: { data, mimeType: "image/png" },
    };
  }

  it("marks an aged image tool_result on the image alone and drops its base64", () => {
    const msgs: GenericMessage[] = [
      { role: "user", content: "hi" },
      imageRow("t0", "A".repeat(4000)),
      { role: "tool_result", toolUseId: "t1", toolName: "search", content: "small" },
      { role: "tool_result", toolUseId: "t2", toolName: "search", content: "recent" },
    ];
    const { messages: out, result } = markStaleToolResults(msgs, { preserveRecentToolResults: 1 });
    const t0 = out.find((m) => m.role === "tool_result" && m.toolUseId === "t0");
    expect(t0?.role).toBe("tool_result");
    if (t0?.role === "tool_result") {
      expect(t0.meta?.compactedAt).toMatch(/^\d{4}-/); // marked
      expect(t0.image).toBeUndefined(); // base64 dropped from the row
    }
    expect(result.marked).toBe(true);
    // freed count includes the dropped base64 chars, not just the tiny content.
    expect(result.freedCharsOnSerialize).toBeGreaterThan(3000);
  });

  it("does NOT mark a recent image tool_result inside the preserve window", () => {
    const msgs: GenericMessage[] = [
      { role: "user", content: "hi" },
      { role: "tool_result", toolUseId: "t1", toolName: "search", content: "x".repeat(5000) },
      imageRow("t2"),
    ];
    const { messages: out } = markStaleToolResults(msgs, { preserveRecentToolResults: 1 });
    const t2 = out.find((m) => m.role === "tool_result" && m.toolUseId === "t2");
    if (t2?.role === "tool_result") {
      expect(t2.meta?.compactedAt).toBeUndefined();
      expect(t2.image).toBeDefined(); // still visible to the model
    }
  });

  it("counts a live image tool_result's token overhead, and none once marked", () => {
    const placeholderOnly: GenericMessage[] = [
      { role: "tool_result", toolUseId: "t0", toolName: "view_image", content: "[image loaded]" },
    ];
    const baseline = estimateMessagesTokens(placeholderOnly);
    const withImage = estimateMessagesTokens([imageRow("t0")]);
    expect(withImage).toBeGreaterThan(baseline + 500); // ~765 image overhead added

    const marked: GenericMessage[] = [
      { ...imageRow("t0"), meta: { compactedAt: "2026-01-01T00:00:00.000Z" } },
    ];
    // Once marked, the image is not counted (gated on the not-stubbed predicate).
    expect(estimateMessagesTokens(marked)).toBeLessThan(withImage);
  });
});

describe("evictAgedToolResultImages", () => {
  function imgRow(id: string, data = "QUJD"): GenericMessage {
    return {
      role: "tool_result",
      toolUseId: id,
      toolName: "view_image",
      content: "[image loaded]",
      image: { data, mimeType: "image/png" },
    };
  }

  it("drops the image from aged image rows but keeps recent ones", () => {
    const msgs: GenericMessage[] = [
      { role: "user", content: "hi" },
      imgRow("old", "A".repeat(100)),
      { role: "tool_result", toolUseId: "t1", toolName: "search", content: "x" },
      imgRow("recent"),
    ];
    const { messages: out, result } = evictAgedToolResultImages(msgs, 1);
    // 3 tool_results, preserve 1 → only "recent" preserved.
    const old = out.find((m) => m.role === "tool_result" && m.toolUseId === "old");
    const recent = out.find((m) => m.role === "tool_result" && m.toolUseId === "recent");
    expect(old?.role === "tool_result" && old.image).toBeUndefined();
    expect(recent?.role === "tool_result" && recent.image).toBeDefined();
    expect(old?.role === "tool_result" && old.content).toBe("[image loaded]"); // placeholder kept
    expect(result.evicted).toBe(true);
    expect(result.evictedCount).toBe(1);
    expect(result.freedChars).toBe(100);
  });

  it("is a no-op (same array, evicted=false) when no image is aged", () => {
    const msgs: GenericMessage[] = [
      { role: "tool_result", toolUseId: "t1", toolName: "search", content: "x" },
      imgRow("recent"),
    ];
    const { messages: out, result } = evictAgedToolResultImages(msgs, 4);
    expect(result.evicted).toBe(false);
    expect(out).toBe(msgs); // untouched reference
  });

  it("never touches text tool_results or non-tool_result messages", () => {
    const textRow: GenericMessage = { role: "tool_result", toolUseId: "t0", toolName: "search", content: "y".repeat(9000) };
    const msgs: GenericMessage[] = [
      textRow,
      { role: "tool_result", toolUseId: "t1", toolName: "search", content: "z" },
      { role: "tool_result", toolUseId: "t2", toolName: "search", content: "w" },
    ];
    const { messages: out, result } = evictAgedToolResultImages(msgs, 1);
    expect(result.evicted).toBe(false); // no image rows → nothing evicted
    expect(out[0]).toBe(textRow); // text row untouched
  });
});

describe("intra-turn tool-result stubbing (issue #1171)", () => {
  it("preserve=16 marks the oldest 14 of 30 and keeps the newest 16 verbatim, then wire-stubs only the 14", () => {
    const messages = synthN(30);
    const { messages: afterMark, result } = markStaleToolResults(messages, {
      preserveRecentToolResults: 16,
    });

    expect(result.marked).toBe(true);
    expect(result.markedCount).toBe(14); // 30 - 16

    const markedResults = afterMark.filter((m) => m.role === "tool_result");
    expect(markedResults).toHaveLength(30);

    // In-memory: oldest 14 carry compactedAt, content still verbatim; newest 16 unmarked.
    for (let i = 0; i < 30; i++) {
      const m = markedResults[i];
      if (m.role !== "tool_result") continue;
      expect(m.content.length).toBeGreaterThan(1000); // verbatim in memory either way
      if (i < 14) {
        expect(m.meta?.compactedAt).toMatch(/^\d{4}-/);
      } else {
        expect(m.meta?.compactedAt).toBeUndefined();
      }
    }

    // Wire form: the 14 marked become stubs; the 16 preserved stay verbatim.
    const wire = stubMarkedToolResults(afterMark);
    const wireResults = wire.filter((m) => m.role === "tool_result");
    expect(wireResults).toHaveLength(30);
    for (let i = 0; i < 30; i++) {
      const m = wireResults[i];
      if (m.role !== "tool_result") continue;
      if (i < 14) {
        expect(isToolResultStubContent(m.content)).toBe(true);
        expect(m.content.length).toBeLessThan(200);
      } else {
        expect(isToolResultStubContent(m.content)).toBe(false);
        expect(m.content.length).toBeGreaterThan(1000);
      }
    }
  });

  it("is idempotent and only marks the newly-aged-out subset after more results arrive", () => {
    const first = markStaleToolResults(synthN(30), { preserveRecentToolResults: 16 });
    expect(first.result.markedCount).toBe(14);

    // Second call over the already-marked array marks nothing.
    const second = markStaleToolResults(first.messages, { preserveRecentToolResults: 16 });
    expect(second.result.marked).toBe(false);
    expect(second.result.markedCount).toBe(0);

    // Append 10 fresh tool_results (now 40 total) and call again — only the
    // 10 that just aged out of the protect window are newly marked.
    const grown: GenericMessage[] = [...first.messages];
    for (let i = 30; i < 40; i++) {
      const id = makeToolUseId(i);
      grown.push({
        role: "assistant",
        content: `step ${i}`,
        toolCalls: [{ id, name: "search", input: {} }],
      });
      grown.push({
        role: "tool_result",
        toolUseId: id,
        toolName: "search",
        content: "x".repeat(5000) + `#${i}`,
      });
    }
    const third = markStaleToolResults(grown, { preserveRecentToolResults: 16 });
    // 40 total - 16 preserved = 24 should-be-marked; 14 were already marked,
    // so only the 10 newly-aged-out are marked this pass.
    expect(third.result.markedCount).toBe(10);
    const stillMarked = third.messages.filter(
      (m) => m.role === "tool_result" && m.meta?.compactedAt !== undefined,
    );
    expect(stillMarked).toHaveLength(24);
  });

  it("intra-turn preserve16 then post-turn preserve8 converges to the same state as post-turn alone", () => {
    // Baseline: post-turn-only mark with preserve=8.
    const baseline = markStaleToolResults(synthN(30), { preserveRecentToolResults: 8 });
    expect(baseline.result.markedCount).toBe(22); // 30 - 8

    // Layered: intra-turn (16) first, then post-turn (8).
    const intra = markStaleToolResults(synthN(30), { preserveRecentToolResults: 16 });
    const layered = markStaleToolResults(intra.messages, { preserveRecentToolResults: 8 });
    // Intra marked the oldest 14; post-turn marks the next 8 (indices 14..21)
    // that were still inside the 16-window but outside the 8-window.
    expect(layered.result.markedCount).toBe(8);

    const layeredMarked = layered.messages.filter(
      (m) => m.role === "tool_result" && m.meta?.compactedAt !== undefined,
    );
    const baselineMarked = baseline.messages.filter(
      (m) => m.role === "tool_result" && m.meta?.compactedAt !== undefined,
    );
    expect(layeredMarked).toHaveLength(baselineMarked.length); // both = 22 ("all but last 8")

    // The projected wire token count is identical to the post-turn-only path.
    expect(estimateMessagesTokens(stubMarkedToolResults(layered.messages))).toBe(
      estimateMessagesTokens(stubMarkedToolResults(baseline.messages)),
    );
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

describe("estimateMessagesTokens — provider-wire shape", () => {
  it("counts compacted tool_results as serialization stubs, not verbatim memory", () => {
    const messages = synth();
    const rawEstimate = estimateMessagesTokens(messages);
    const { messages: marked } = markStaleToolResults(messages, {
      preserveRecentToolResults: 4,
    });

    const wireEstimate = estimateMessagesTokens(marked);

    expect(wireEstimate).toBeLessThan(rawEstimate);
    expect(wireEstimate).toBeLessThan(rawEstimate - 5_000);
    const firstMarked = marked.find((m) => m.role === "tool_result" && m.meta?.compactedAt !== undefined);
    expect(firstMarked?.role).toBe("tool_result");
    if (firstMarked?.role === "tool_result") {
      expect(firstMarked.content.length).toBeGreaterThan(1_000);
      expect(estimateMessagesTokens([firstMarked])).toBeLessThan(100);
    }
  });

  it("counts host-truncated tool_results as chunk-reference stubs", () => {
    const verbatim = "x".repeat(20_000);
    const msg: GenericMessage = {
      role: "tool_result",
      toolUseId: "toolu_big",
      toolName: "search",
      content: verbatim,
      meta: {
        truncated: {
          originalLines: 1,
          originalTokens: 5_001,
          originalBytes: verbatim.length,
          trimmedAt: "2026-05-20T00:00:00.000Z",
        },
      },
    };

    const rawEquivalent = estimateTokens(JSON.stringify({
      role: "tool_result",
      toolUseId: "toolu_big",
      toolName: "search",
      content: verbatim,
      isError: false,
    }));
    const wireEstimate = estimateMessagesTokens([msg]);

    expect(wireEstimate).toBeLessThan(rawEquivalent / 10);
    expect(msg.content).toBe(verbatim);
  });

  it("adds multimodal image token overhead beyond the text marker", () => {
    const textOnly: GenericMessage = {
      role: "user",
      content: "[Image #1]",
    };
    const withImage: GenericMessage = {
      role: "user",
      content: [
        { type: "text", text: "[Image #1]" },
        {
          type: "image",
          image: "data:image/png;base64,abc",
          mimeType: "image/png",
          width: 1024,
          height: 1024,
          bytes: 4096,
        },
      ],
    };

    expect(estimateMessagesTokens([withImage]))
      .toBeGreaterThan(estimateMessagesTokens([textOnly]) + 700);
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

describe("getModelPreflightThreshold — TPM-aware preflight (issue #900 #3)", () => {
  it("gpt-5.4-nano — TPM 200K × 0.8 = 160K 가 window 기반 threshold 보다 작음 → tpm 채택", () => {
    // nano: contextWindow 400K → usable = max(360K, 320K) = 360K (context-budget.ts:28-34)
    //       → window threshold = floor(360K × 0.8) = 288K
    // nano: tpmDefault 200K → tpm threshold = floor(200K × 0.8) = 160K
    // min(288K, 160K) = 160K. TPM 가 작은 한도라 채택 — 사용자 사고 prevention.
    const t = getModelPreflightThreshold("openai", "gpt-5.4-nano");
    expect(t).toBe(160_000);
  });

  it("gpt-5.4-mini — TPM 200K × 0.8 = 160K < window threshold 288K → tpm 채택 (인덱서 turn 사고 prevention)", () => {
    // mini: contextWindow 400K → window threshold = floor(360K × 0.8) = 288K
    // mini: tpmDefault 200K (실측 429 "Limit 200000") → tpm threshold = floor(200K × 0.8) = 160K
    // min(288K, 160K) = 160K. window-only 였다면 288K 라 실제 200K TPM 벽 전에 미트리거.
    const t = getModelPreflightThreshold("openai", "gpt-5.4-mini");
    expect(t).toBe(160_000);
  });

  it("gpt-5.4 — tpmDefault 30M >> window-based threshold → window 채택", () => {
    // gpt-5.4: contextWindow 1.05M → 80% × 1.01M = 808K window threshold
    // gpt-5.4: tpmDefault 30M → tpm threshold = 24M
    // min(808K, 24M) = 808K. window 가 작은 한도라 그대로.
    const t = getModelPreflightThreshold("openai", "gpt-5.4");
    expect(t).toBeLessThan(1_000_000);
    expect(t).toBeGreaterThan(400_000);
  });

  it("tpmDefault 미설정 모델 — 기존 동작 유지 (window-based threshold)", () => {
    // claude-sonnet-4-6 는 tpmDefault 등록 안 됨 → window-only 동작 — backward-compat 검증
    const t = getModelPreflightThreshold("claude", "claude-sonnet-4-6");
    expect(t).toBeGreaterThan(50_000);
  });
});
