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
  type CompactBoundary,
} from "../structured-compact.js";

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
});
