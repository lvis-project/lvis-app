/**
 * Structured Compact tests — Layer 2 interface + parser + freeze invariant.
 * 호출자가 아직 없으므로 실제 LLM call 회귀는 PR-2-D 에서 추가.
 */
import { describe, it, expect } from "vitest";
import {
  SUMMARY_TEMPLATE_HEADERS_V1,
  SUMMARY_TEMPLATE_PROMPT_V1,
  parseSummary,
  freezeBoundary,
  compactWithBoundary,
  renderBoundaryAsPreamble,
  type CompactBoundary,
} from "../structured-compact.js";
import type { GenericMessage, LLMProvider, StreamEvent } from "../llm/types.js";

// ─── parseSummary ──────────────────────────────────────

describe("parseSummary — 12-section template", () => {
  function makeFullSummary(): string {
    // 12 헤더 모두 채워진 valid 응답
    return [
      "# Session State as of 2026-05-08T00:00:00Z (compact #1, templateVersion 1)",
      "",
      "## Goal",
      "auth refactor 완료",
      "",
      "## Constraints & Preferences",
      "- TypeScript strict mode",
      "",
      "## Progress",
      "- [x] schema 정의",
      "- [-] 마이그레이션 진행 중",
      "",
      "## Key Decisions",
      "- JWT 기반 (이유: stateless)",
      "",
      "## Relevant Files",
      "src/auth.ts:edited:done",
      "",
      "## Next Steps",
      "마이그레이션 테스트",
      "",
      "## Critical Context",
      "- 활성 plugin: agent-hub",
      "",
      "## Current Plan",
      "step 2/4 진행",
      "",
      "## Verification State",
      "build pass, e2e 미실행",
      "",
      "## Open Blockers",
      "(미정)",
      "",
      "## Unsafe Pending Actions",
      "(미정)",
      "",
      "## Last Tool Boundary",
      "round 5: read_file → src/auth.ts (200 줄)",
    ].join("\n");
  }

  it("parses all 12 sections from a valid response", () => {
    const result = parseSummary(makeFullSummary());
    expect(result.templateVersion).toBe(1);
    expect(result.raw).toBeUndefined();
    for (const header of SUMMARY_TEMPLATE_HEADERS_V1) {
      expect(result.sections[header]).toBeDefined();
      expect(result.sections[header]?.length).toBeGreaterThan(0);
    }
  });

  it("preserves Goal section content verbatim", () => {
    const r = parseSummary(makeFullSummary());
    expect(r.sections.Goal).toBe("auth refactor 완료");
  });

  it("preserves multi-line Progress section", () => {
    const r = parseSummary(makeFullSummary());
    expect(r.sections.Progress).toContain("[x] schema 정의");
    expect(r.sections.Progress).toContain("[-] 마이그레이션 진행 중");
  });

  it("falls back to raw when a header is missing", () => {
    // Open Blockers 헤더 누락
    const broken = makeFullSummary().replace("## Open Blockers\n(미정)\n\n", "");
    const r = parseSummary(broken);
    expect(r.raw).toBeDefined();
    // sections 일부는 채워질 수 있으나, raw 가 set 됨이 핵심 — caller 가 retry 또는 raw 사용 결정
  });

  it("falls back to raw when section body is empty (not (미정))", () => {
    // Goal 섹션이 빈 본문
    const broken = makeFullSummary().replace("## Goal\nauth refactor 완료\n", "## Goal\n\n");
    const r = parseSummary(broken);
    expect(r.raw).toBeDefined();
    expect(r.sections.Goal).toBeUndefined();
  });

  it("returns raw fallback for entirely malformed text", () => {
    const r = parseSummary("just a plain text response without any headers");
    expect(r.raw).toBeDefined();
    expect(Object.keys(r.sections)).toHaveLength(0);
  });
});

// ─── SUMMARY_TEMPLATE_PROMPT_V1 contract ──────────────

describe("SUMMARY_TEMPLATE_PROMPT_V1 placeholders", () => {
  it("contains {{conversationText}} placeholder", () => {
    expect(SUMMARY_TEMPLATE_PROMPT_V1).toContain("{{conversationText}}");
  });

  it("contains {{timestamp}} placeholder", () => {
    expect(SUMMARY_TEMPLATE_PROMPT_V1).toContain("{{timestamp}}");
  });

  it("contains {{compactNum}} placeholder", () => {
    expect(SUMMARY_TEMPLATE_PROMPT_V1).toContain("{{compactNum}}");
  });

  it("references all 12 headers", () => {
    for (const header of SUMMARY_TEMPLATE_HEADERS_V1) {
      expect(SUMMARY_TEMPLATE_PROMPT_V1).toContain(`## ${header}`);
    }
  });

  it("references the 5 procedural rules (P4 GPT-5 prompting)", () => {
    expect(SUMMARY_TEMPLATE_PROMPT_V1).toContain("context-gathering budget");
    expect(SUMMARY_TEMPLATE_PROMPT_V1).toContain("early stop");
    expect(SUMMARY_TEMPLATE_PROMPT_V1).toContain("done criteria");
    expect(SUMMARY_TEMPLATE_PROMPT_V1).toContain("persistence stop condition");
    expect(SUMMARY_TEMPLATE_PROMPT_V1).toContain("unsafe pending action");
  });
});

// ─── freezeBoundary (P7 invariant) ────────────────────

describe("freezeBoundary — Object.freeze invariant (P7)", () => {
  function makeBoundary(): CompactBoundary {
    return {
      templateVersion: 1,
      structuredSummary: {
        templateVersion: 1,
        sections: { Goal: "test" },
      },
      recentVerbatim: [],
      pinnedArtifacts: ["lock-1"],
      toolBoundaryLedger: [{ round: 1, toolName: "read_file", resultSummary: "ok" }],
      createdAt: "2026-05-08T00:00:00Z",
      compactNum: 1,
    };
  }

  it("returns the same object reference (in-place freeze)", () => {
    const b = makeBoundary();
    const frozen = freezeBoundary(b);
    expect(frozen).toBe(b);
  });

  it("blocks top-level mutation", () => {
    const b = makeBoundary();
    freezeBoundary(b);
    expect(Object.isFrozen(b)).toBe(true);
  });

  it("freezes structuredSummary deeply", () => {
    const b = makeBoundary();
    freezeBoundary(b);
    expect(Object.isFrozen(b.structuredSummary)).toBe(true);
    expect(Object.isFrozen(b.structuredSummary.sections)).toBe(true);
  });

  it("freezes nested arrays (recentVerbatim, pinnedArtifacts, toolBoundaryLedger)", () => {
    const b = makeBoundary();
    freezeBoundary(b);
    expect(Object.isFrozen(b.recentVerbatim)).toBe(true);
    expect(Object.isFrozen(b.pinnedArtifacts)).toBe(true);
    expect(Object.isFrozen(b.toolBoundaryLedger)).toBe(true);
  });

  it("freezes vendorOpaqueState when present", () => {
    const b: CompactBoundary = {
      ...makeBoundary(),
      vendorOpaqueState: {
        vendor: "openai",
        openaiCompactionItem: { type: "compaction", encrypted_content: "abc" },
      },
    };
    freezeBoundary(b);
    expect(Object.isFrozen(b.vendorOpaqueState)).toBe(true);
  });

  it("strict mode throws on mutation attempt", () => {
    const b = makeBoundary();
    freezeBoundary(b);
    expect(() => {
      (b as unknown as { compactNum: number }).compactNum = 999;
    }).toThrow(TypeError);
  });

  it("deep-freezes nested msg.content array and elements (Copilot round 2)", () => {
    const contentParts = [{ type: "text" as const, text: "hello" }];
    const msg: GenericMessage = { role: "user", content: contentParts };
    const b: CompactBoundary = {
      ...makeBoundary(),
      recentVerbatim: [msg],
    };
    freezeBoundary(b);
    expect(Object.isFrozen(contentParts)).toBe(true);
    expect(Object.isFrozen(contentParts[0])).toBe(true);
  });

  it("deep-freezes msg.toolCalls array and each ToolCall input (Copilot round 2)", () => {
    const toolInput = { query: "search term" };
    const msg: GenericMessage = {
      role: "assistant",
      content: "calling tool",
      toolCalls: [{ id: "t1", name: "search", input: toolInput }],
    };
    const b: CompactBoundary = {
      ...makeBoundary(),
      recentVerbatim: [msg],
    };
    freezeBoundary(b);
    expect(Object.isFrozen(msg.toolCalls)).toBe(true);
    expect(Object.isFrozen(msg.toolCalls![0])).toBe(true);
    expect(Object.isFrozen(toolInput)).toBe(true);
  });

  it("deep-freezes msg.thinkingBlocks array (Copilot round 2)", () => {
    const block = { thinking: "let me think", signature: "sig123" };
    const msg: GenericMessage = {
      role: "assistant",
      content: "result",
      thinkingBlocks: [block],
    };
    const b: CompactBoundary = {
      ...makeBoundary(),
      recentVerbatim: [msg],
    };
    freezeBoundary(b);
    expect(Object.isFrozen(msg.thinkingBlocks)).toBe(true);
    expect(Object.isFrozen(block)).toBe(true);
  });

  it("deepFreeze is idempotent — already-frozen boundary re-frozen safely", () => {
    const b = makeBoundary();
    const frozen1 = freezeBoundary(b);
    const frozen2 = freezeBoundary(b); // second call must not throw
    expect(frozen1).toBe(frozen2);
    expect(Object.isFrozen(frozen2)).toBe(true);
  });
});

// ─── compactWithBoundary (Layer 2 LLM call) ──────────

function makeMockLlm(responses: string[]): LLMProvider {
  let idx = 0;
  return {
    vendor: "claude",
    async *streamTurn(): AsyncIterable<StreamEvent> {
      const text = responses[idx++] ?? responses[responses.length - 1] ?? "";
      yield { type: "text_delta", text } satisfies StreamEvent;
      yield { type: "message_complete", stopReason: "end_turn" } satisfies StreamEvent;
    },
  };
}

function makeFullSummaryText(): string {
  return [
    "# Session State as of 2026-05-08T00:00:00Z (compact #1, templateVersion 1)",
    "",
    "## Goal",
    "auth refactor",
    "## Constraints & Preferences",
    "TypeScript strict",
    "## Progress",
    "- [x] schema",
    "- [-] migration",
    "## Key Decisions",
    "JWT (이유: stateless)",
    "## Relevant Files",
    "src/auth.ts:edited:done",
    "## Next Steps",
    "마이그레이션 테스트",
    "## Critical Context",
    "활성 plugin: agent-hub",
    "## Current Plan",
    "step 2/4",
    "## Verification State",
    "build pass",
    "## Open Blockers",
    "(미정)",
    "## Unsafe Pending Actions",
    "(미정)",
    "## Last Tool Boundary",
    "round 5: read_file",
  ].join("\n");
}

function makeLongHistory(turnCount: number): GenericMessage[] {
  const out: GenericMessage[] = [];
  for (let i = 1; i <= turnCount; i++) {
    out.push({ role: "user", content: `질문 ${i} `.repeat(20) });
    out.push({ role: "assistant", content: `응답 ${i} `.repeat(20) });
  }
  return out;
}

describe("compactWithBoundary — Layer 2 LLM call integration", () => {
  it("splits, calls LLM, parses, returns frozen boundary + new history", async () => {
    const llm = makeMockLlm([makeFullSummaryText()]);
    const messages = makeLongHistory(50);

    const r = await compactWithBoundary({
      messages,
      llm,
      model: "claude-sonnet-4-6",
      preserveRecentTokens: 200, // 작게 잡아서 split 발생 보장
      compactNum: 1,
    });

    expect(r.removedCount).toBeGreaterThan(0);
    expect(r.newHistory.length).toBeLessThan(messages.length);
    expect(r.newHistory[0].role).toBe("user");
    expect(r.newHistory[0].meta?.compactBoundary).toBe(true);
    expect(r.newHistory[0].meta?.compactNum).toBe(1);
    expect(r.newHistory[0].meta?.boundary).toBe(r.boundary);
    expect(Object.isFrozen(r.boundary)).toBe(true);
    expect(r.boundary.structuredSummary.sections.Goal).toBe("auth refactor");
    expect(r.boundary.compactNum).toBe(1);
  });

  it("returns empty boundary when nothing to compact (preserveRecentTokens covers all)", async () => {
    const llm = makeMockLlm(["(should not be called)"]);
    const messages: GenericMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    const r = await compactWithBoundary({
      messages,
      llm,
      model: "claude-sonnet-4-6",
      preserveRecentTokens: 1_000_000, // 모든 메시지 보존
      compactNum: 1,
    });
    expect(r.removedCount).toBe(0);
    expect(r.newHistory).toBe(messages); // reference-equal
  });

  it("retries parse failure once, then graceful raw fallback", async () => {
    // 두 번 모두 형식 위반 → raw fallback
    const llm = makeMockLlm(["bad response 1", "bad response 2"]);
    const messages = makeLongHistory(50);

    const r = await compactWithBoundary({
      messages,
      llm,
      model: "claude-sonnet-4-6",
      preserveRecentTokens: 200,
      compactNum: 2,
    });
    expect(r.boundary.structuredSummary.raw).toBeDefined();
    expect(r.boundary.structuredSummary.raw).toContain("bad response 2");
  });

  it("recovers when 1st attempt malformed but 2nd succeeds", async () => {
    const llm = makeMockLlm(["malformed", makeFullSummaryText()]);
    const messages = makeLongHistory(50);

    const r = await compactWithBoundary({
      messages,
      llm,
      model: "claude-sonnet-4-6",
      preserveRecentTokens: 200,
      compactNum: 3,
    });
    expect(r.boundary.structuredSummary.raw).toBeUndefined();
    expect(r.boundary.structuredSummary.sections.Goal).toBe("auth refactor");
  });

  it("collects pinnedArtifacts from skill outputs and meta.lock=true", async () => {
    const llm = makeMockLlm([makeFullSummaryText()]);
    const messages: GenericMessage[] = [
      { role: "user", content: "x".repeat(500) },
      {
        role: "assistant",
        content: "skill called",
        toolCalls: [{ id: "s1", name: "skill", input: {} }],
      },
      {
        role: "tool_result",
        toolUseId: "s1",
        toolName: "skill",
        content: "REPL ran successfully\n결과: ok",
      },
      { role: "user", content: "lock me", meta: { lock: true } },
    ];
    // pad with more to ensure split
    for (let i = 0; i < 30; i++) {
      messages.push({ role: "user", content: `q${i} `.repeat(10) });
      messages.push({ role: "assistant", content: `a${i} `.repeat(10) });
    }

    const r = await compactWithBoundary({
      messages,
      llm,
      model: "claude-sonnet-4-6",
      preserveRecentTokens: 200,
      compactNum: 1,
    });
    expect(r.boundary.pinnedArtifacts.length).toBeGreaterThan(0);
    const hasSkill = r.boundary.pinnedArtifacts.some((p) => p.startsWith("skill:"));
    const hasLock = r.boundary.pinnedArtifacts.some((p) => p.startsWith("lock-user:"));
    expect(hasSkill).toBe(true);
    expect(hasLock).toBe(true);
  });

  it("respects abortSignal mid-stream", async () => {
    const ctrl = new AbortController();
    const llm: LLMProvider = {
      vendor: "claude",
      async *streamTurn(): AsyncIterable<StreamEvent> {
        // 첫 chunk 후 abort 시뮬레이션
        yield { type: "text_delta", text: "partial" } satisfies StreamEvent;
        ctrl.abort();
        yield { type: "text_delta", text: " more" } satisfies StreamEvent;
        yield { type: "message_complete", stopReason: "end_turn" } satisfies StreamEvent;
      },
    };
    const messages = makeLongHistory(50);

    await expect(
      compactWithBoundary({
        messages,
        llm,
        model: "claude-sonnet-4-6",
        preserveRecentTokens: 200,
        compactNum: 1,
        abortSignal: ctrl.signal,
      }),
    ).rejects.toThrow(/aborted/);
  });

  it("respects tool_use/tool_result invariant on split", async () => {
    const llm = makeMockLlm([makeFullSummaryText()]);
    // 끝부분에 tool_use → tool_result 페어. preserveRecentTokens 가 작게 설정되어
    // tool_result 만 preserve 영역에 포함되면 split adjust 가 페어 보존하도록 뒤로 밂.
    const messages: GenericMessage[] = [];
    for (let i = 0; i < 30; i++) {
      messages.push({ role: "user", content: `q${i} `.repeat(20) });
      messages.push({ role: "assistant", content: `a${i} `.repeat(20) });
    }
    messages.push({
      role: "assistant",
      content: "tool call",
      toolCalls: [{ id: "t1", name: "search", input: {} }],
    });
    messages.push({
      role: "tool_result",
      toolUseId: "t1",
      toolName: "search",
      content: "result",
    });

    const r = await compactWithBoundary({
      messages,
      llm,
      model: "claude-sonnet-4-6",
      preserveRecentTokens: 50, // 작게 — tool_result 만 preserve 영역에 들어가도 페어 보존
      compactNum: 1,
    });
    // newHistory 의 첫번째 non-stub 이 tool_use 가 있는 assistant 라면 페어 보존.
    // 또는 양쪽 다 toCompact 로 넘어가도 OK (페어 분리 X).
    const preservedToolResults = r.newHistory.filter((m) => m.role === "tool_result");
    if (preservedToolResults.length > 0) {
      // tool_result 가 보존됐다면 그 직전에 매칭 tool_use 도 보존돼야 함.
      const idx = r.newHistory.findIndex((m) => m.role === "tool_result");
      const prev = idx > 0 ? r.newHistory[idx - 1] : undefined;
      expect(prev?.role).toBe("assistant");
      expect(
        prev?.role === "assistant" && prev.toolCalls && prev.toolCalls.length > 0,
      ).toBe(true);
    }
  });
});

// ─── renderBoundaryAsPreamble ──────────────────────────

describe("renderBoundaryAsPreamble — boundary → ⑧ slot text", () => {
  function makeFrozenBoundary(): Readonly<CompactBoundary> {
    return freezeBoundary({
      templateVersion: 1,
      structuredSummary: {
        templateVersion: 1,
        sections: {
          Goal: "test goal",
          "Key Decisions": "decision 1",
        },
      },
      recentVerbatim: [],
      pinnedArtifacts: ["skill:run-tests", "lock-user:중요"],
      toolBoundaryLedger: [
        { round: 1, toolName: "read_file", resultSummary: "read 200 lines" },
        { round: 2, toolName: "run", resultSummary: "exit 1", isError: true },
      ],
      createdAt: "2026-05-08T00:00:00.000Z",
      compactNum: 5,
    });
  }

  it("renders header + included sections + ledger + pinned", () => {
    const text = renderBoundaryAsPreamble(makeFrozenBoundary());
    expect(text).toContain("Compact #5");
    expect(text).toContain("## Goal");
    expect(text).toContain("test goal");
    expect(text).toContain("## Key Decisions");
    expect(text).toContain("decision 1");
    expect(text).toContain("Recent Tool Activity Ledger");
    expect(text).toContain("read_file");
    expect(text).toContain("run [error]");
    expect(text).toContain("Pinned Artifacts");
    expect(text).toContain("skill:run-tests");
  });

  it("returns raw when structuredSummary has raw fallback", () => {
    const b = freezeBoundary({
      templateVersion: 1,
      structuredSummary: { templateVersion: 1, sections: {}, raw: "raw fallback content" },
      recentVerbatim: [],
      pinnedArtifacts: [],
      toolBoundaryLedger: [],
      createdAt: "2026-05-08T00:00:00.000Z",
      compactNum: 1,
    });
    expect(renderBoundaryAsPreamble(b)).toBe("raw fallback content");
  });

  it("omits empty ledger and pinned sections", () => {
    const b = freezeBoundary({
      templateVersion: 1,
      structuredSummary: {
        templateVersion: 1,
        sections: { Goal: "minimal" },
      },
      recentVerbatim: [],
      pinnedArtifacts: [],
      toolBoundaryLedger: [],
      createdAt: "2026-05-08T00:00:00.000Z",
      compactNum: 1,
    });
    const text = renderBoundaryAsPreamble(b);
    expect(text).not.toContain("Recent Tool Activity Ledger");
    expect(text).not.toContain("Pinned Artifacts");
    expect(text).toContain("Goal");
  });
});
