/**
 * Auto-Compact — 2-stage compaction tests.
 *
 * Stage 1 (microcompact): preventive tool_result stub 교체.
 * Stage 2 (compactMessages): threshold 초과 시 요약 생성 + boundary marker.
 */
import { describe, it, expect } from "vitest";

import {
  microcompactMessages,
  compactMessages,
  extractCarryover,
  decideRotation,
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

describe("microcompactMessages", () => {
  it("strips older tool_results while preserving the most recent N", () => {
    const messages = synth();
    const { messages: out, result } = microcompactMessages(messages, {
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
    const first = microcompactMessages(messages, { preserveRecentToolResults: 4 });
    const second = microcompactMessages(first.messages, { preserveRecentToolResults: 4 });

    expect(second.result.stripped).toBe(false);
    expect(second.result.strippedCount).toBe(0);
    // 새 객체를 만들지 않고 reference 유지 기대 (stripped 후보 없음 → early return 또는 map pass-through)
    // 여기선 strippedCount만 확인해도 idempotency 충족
  });

  it("preserves tool_use_id linkage for stripped messages", () => {
    const messages = synth();
    const { messages: out } = microcompactMessages(messages, {
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
    const { messages: out, result } = microcompactMessages(messages, {
      preserveRecentToolResults: 4,
    });
    expect(result.stripped).toBe(false);
    expect(out).toBe(messages); // reference-equal
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

describe("extractCarryover", () => {
  it("extracts goals from user messages containing action keywords", () => {
    const messages: GenericMessage[] = [
      { role: "user", content: "auth 모듈 구현해줘" },
      { role: "assistant", content: "네, 구현하겠습니다." },
      { role: "user", content: "테스트도 작성해줘" },
    ];
    const { goals } = extractCarryover(messages);
    expect(goals.length).toBeGreaterThanOrEqual(1);
    expect(goals.some((g) => g.includes("구현"))).toBe(true);
  });

  it("caps goals at 5, keeping the most recent", () => {
    const messages: GenericMessage[] = Array.from({ length: 8 }, (_, i) => ({
      role: "user" as const,
      content: `task-${i} 구현해줘`,
    }));
    const { goals } = extractCarryover(messages);
    expect(goals.length).toBeLessThanOrEqual(5);
    // 가장 최신 항목이 포함되어야 함
    expect(goals.some((g) => g.includes("task-7"))).toBe(true);
  });

  it("extracts file artifacts from assistant messages", () => {
    const messages: GenericMessage[] = [
      { role: "user", content: "파일 만들어줘" },
      {
        role: "assistant",
        content:
          "src/engine/auto-compact.ts 파일을 생성했습니다.\n" +
          "또한 src/engine/__tests__/auto-compact.test.ts도 업데이트했습니다.",
      },
    ];
    const { artifacts } = extractCarryover(messages);
    expect(artifacts.length).toBeGreaterThan(0);
    expect(artifacts.some((a) => a.includes(".ts"))).toBe(true);
  });

  it("extracts decisions from assistant messages", () => {
    const messages: GenericMessage[] = [
      { role: "user", content: "어떤 방식 쓸지 알려줘" },
      {
        role: "assistant",
        content: "결정: extractCarryover를 LLM-free 추출 방식으로 구현합니다.",
      },
    ];
    const { decisions } = extractCarryover(messages);
    expect(decisions.length).toBeGreaterThan(0);
    expect(decisions[0]).toContain("extractCarryover");
  });

  it("returns empty arrays when no relevant content found", () => {
    const messages: GenericMessage[] = [
      { role: "user", content: "안녕하세요" },
      { role: "assistant", content: "안녕하세요! 무엇을 도와드릴까요?" },
    ];
    const { goals, artifacts, decisions } = extractCarryover(messages);
    expect(goals).toEqual([]);
    expect(artifacts).toEqual([]);
    expect(decisions).toEqual([]);
  });

  it("ignores [이전 대화 요약] user messages for goal extraction", () => {
    const messages: GenericMessage[] = [
      {
        role: "user",
        content: "[이전 대화 요약]\n## 사용자 요청\n- auth 구현해줘",
        meta: { compactBoundary: true },
      },
    ];
    const { goals } = extractCarryover(messages);
    expect(goals).toEqual([]);
  });

  it("compactMessages boundary marker includes carryover in meta", () => {
    const messages: GenericMessage[] = [];
    for (let i = 0; i < 20; i++) {
      messages.push({ role: "user", content: `기능 ${i} 구현해줘` });
      messages.push({
        role: "assistant",
        content: `src/feature-${i}.ts 작성 완료했습니다. 결정: 방식 ${i} 채택합니다.`,
      });
    }
    const { messages: out } = compactMessages(messages);
    const marker = out.find(
      (m) => m.role === "user" && m.meta?.compactBoundary === true,
    );
    expect(marker).toBeDefined();
    expect(marker?.meta?.carryover).toBeDefined();
    const carryover = marker?.meta?.carryover;
    expect(Array.isArray(carryover?.goals)).toBe(true);
    expect(Array.isArray(carryover?.artifacts)).toBe(true);
    expect(Array.isArray(carryover?.decisions)).toBe(true);
  });
});

// ─── decideRotation ───────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1_000;

describe("decideRotation — 3-tier rotation decision tree", () => {
  // ── Tier 1: hard-token ────────────────────────────

  it("tier-1: ctxUsage=0.85 triggers hard-token rotation", () => {
    const r = decideRotation({ ctxUsage: 0.85, sessionAgeMs: 0, userMessageCount: 0, semanticHint: false });
    expect(r.shouldRotate).toBe(true);
    expect(r.trigger).toBe("hard-token");
    expect(r.shouldSkipSummary).toBe(false);
  });

  it("tier-1: ctxUsage=1.0 triggers hard-token rotation with shouldSkipSummary=false", () => {
    const r = decideRotation({ ctxUsage: 1.0, sessionAgeMs: 0, userMessageCount: 0, semanticHint: false });
    expect(r.shouldRotate).toBe(true);
    expect(r.trigger).toBe("hard-token");
    expect(r.shouldSkipSummary).toBe(false);
  });

  it("tier-1: ctxUsage=0.84 does NOT trigger hard-token", () => {
    const r = decideRotation({ ctxUsage: 0.84, sessionAgeMs: 0, userMessageCount: 0, semanticHint: false });
    // no tier-2 or tier-3 hints → no rotation
    expect(r.shouldRotate).toBe(false);
    expect(r.trigger).toBeUndefined();
  });

  // ── Tier 2: semantic-llm ──────────────────────────

  it("tier-2: semanticHint=true triggers semantic-llm rotation", () => {
    const r = decideRotation({ ctxUsage: 0.5, sessionAgeMs: 0, userMessageCount: 5, semanticHint: true });
    expect(r.shouldRotate).toBe(true);
    expect(r.trigger).toBe("semantic-llm");
  });

  it("tier-2: semanticHint at low ctx (0.05) skips summary", () => {
    const r = decideRotation({ ctxUsage: 0.05, sessionAgeMs: 0, userMessageCount: 5, semanticHint: true });
    expect(r.shouldRotate).toBe(true);
    expect(r.trigger).toBe("semantic-llm");
    expect(r.shouldSkipSummary).toBe(true); // ctxUsage 0.05 < 0.10
  });

  it("tier-2: semanticHint at 0.10 ctx generates summary", () => {
    const r = decideRotation({ ctxUsage: 0.10, sessionAgeMs: 0, userMessageCount: 5, semanticHint: true });
    expect(r.shouldRotate).toBe(true);
    expect(r.trigger).toBe("semantic-llm");
    expect(r.shouldSkipSummary).toBe(false); // ctxUsage 0.10 is NOT < 0.10
  });

  it("tier-2: hard-token takes precedence over semantic hint", () => {
    const r = decideRotation({ ctxUsage: 0.90, sessionAgeMs: 0, userMessageCount: 5, semanticHint: true });
    expect(r.trigger).toBe("hard-token"); // tier-1 wins
    expect(r.shouldSkipSummary).toBe(false);
  });

  // ── Tier 3: soft-time ─────────────────────────────

  it("tier-3: sessionAgeMs >= 24h triggers soft-time rotation", () => {
    const r = decideRotation({ ctxUsage: 0.05, sessionAgeMs: DAY_MS, userMessageCount: 5, semanticHint: false });
    expect(r.shouldRotate).toBe(true);
    expect(r.trigger).toBe("soft-time");
  });

  it("tier-3: sessionAgeMs < 24h does NOT trigger by time alone", () => {
    const r = decideRotation({ ctxUsage: 0.05, sessionAgeMs: DAY_MS - 1, userMessageCount: 5, semanticHint: false });
    expect(r.shouldRotate).toBe(false);
  });

  it("tier-3: userMessageCount >= 30 triggers soft-time rotation (user requests, not history.length)", () => {
    const r = decideRotation({ ctxUsage: 0.05, sessionAgeMs: 0, userMessageCount: 30, semanticHint: false });
    expect(r.shouldRotate).toBe(true);
    expect(r.trigger).toBe("soft-time");
  });

  it("tier-3: userMessageCount=29 does NOT trigger by count alone", () => {
    const r = decideRotation({ ctxUsage: 0.05, sessionAgeMs: 0, userMessageCount: 29, semanticHint: false });
    expect(r.shouldRotate).toBe(false);
  });

  it("tier-3: low ctx (0.09) with 30 msgs skips summary", () => {
    const r = decideRotation({ ctxUsage: 0.09, sessionAgeMs: 0, userMessageCount: 30, semanticHint: false });
    expect(r.shouldRotate).toBe(true);
    expect(r.trigger).toBe("soft-time");
    expect(r.shouldSkipSummary).toBe(true);
  });

  it("tier-3: high ctx (0.50) with 24h generates summary", () => {
    const r = decideRotation({ ctxUsage: 0.50, sessionAgeMs: DAY_MS, userMessageCount: 1, semanticHint: false });
    expect(r.shouldRotate).toBe(true);
    expect(r.trigger).toBe("soft-time");
    expect(r.shouldSkipSummary).toBe(false);
  });

  // ── No rotation ───────────────────────────────────

  it("no rotation when none of the conditions met", () => {
    const r = decideRotation({ ctxUsage: 0.50, sessionAgeMs: DAY_MS - 1, userMessageCount: 29, semanticHint: false });
    expect(r.shouldRotate).toBe(false);
    expect(r.trigger).toBeUndefined();
    expect(r.shouldSkipSummary).toBe(false);
  });

  it("shouldSkipSummary is always false when shouldRotate is false", () => {
    const r = decideRotation({ ctxUsage: 0.0, sessionAgeMs: 0, userMessageCount: 0, semanticHint: false });
    expect(r.shouldRotate).toBe(false);
    expect(r.shouldSkipSummary).toBe(false);
  });

  // ── Safety gate: continuousBackendEnabled ─────────

  it("safety gate OFF: always returns { shouldRotate: false } regardless of inputs", () => {
    // Even with hard-token threshold exceeded and semantic hint, OFF gate wins.
    const r = decideRotation({
      ctxUsage: 0.90,
      sessionAgeMs: DAY_MS * 2,
      userMessageCount: 50,
      semanticHint: true,
      continuousBackendEnabled: false,
    });
    expect(r.shouldRotate).toBe(false);
    expect(r.trigger).toBeUndefined();
  });

  it("safety gate ON (explicit): hard-token still triggers rotation", () => {
    const r = decideRotation({
      ctxUsage: 0.85,
      sessionAgeMs: 0,
      userMessageCount: 0,
      semanticHint: false,
      continuousBackendEnabled: true,
    });
    expect(r.shouldRotate).toBe(true);
    expect(r.trigger).toBe("hard-token");
  });

  // ── Dev mode thresholds ───────────────────────────

  it("devMode: soft-time triggers at 5 messages (vs 30 in prod)", () => {
    const r = decideRotation({
      ctxUsage: 0.05,
      sessionAgeMs: 0,
      userMessageCount: 5,
      semanticHint: false,
      continuousBackendEnabled: true,
      devMode: true,
    });
    expect(r.shouldRotate).toBe(true);
    expect(r.trigger).toBe("soft-time");
  });

  it("devMode: 4 messages does NOT trigger soft-time", () => {
    const r = decideRotation({
      ctxUsage: 0.05,
      sessionAgeMs: 0,
      userMessageCount: 4,
      semanticHint: false,
      continuousBackendEnabled: true,
      devMode: true,
    });
    expect(r.shouldRotate).toBe(false);
  });

  it("devMode: soft-time triggers at 1h (vs 24h in prod)", () => {
    const ONE_HOUR_MS = 60 * 60 * 1_000;
    const r = decideRotation({
      ctxUsage: 0.05,
      sessionAgeMs: ONE_HOUR_MS,
      userMessageCount: 0,
      semanticHint: false,
      continuousBackendEnabled: true,
      devMode: true,
    });
    expect(r.shouldRotate).toBe(true);
    expect(r.trigger).toBe("soft-time");
  });
});
