/**
 * PR-2 — Conversation Meta Output section (id 9.9).
 *
 * Verifies:
 *   - Title + checkpoint instructions are emitted when experimentalContinuousBackend is ON
 *   - Session title is injected when set
 *   - No session title line emitted when title is null
 *   - setSessionTitle("") normalises to null (no injection)
 *   - sanitizeTitle() strips dangerous characters (newline, quote, backslash, angle brackets)
 *   - sanitizeTitle() + setSessionTitle() whitespace-only → normalised to null
 *   - Section 9.9 is absent when experimentalContinuousBackend is OFF (safety flag)
 */
import { describe, it, expect } from "vitest";

import { SystemPromptBuilder } from "../system-prompt-builder.js";
import { ToolRegistry } from "../../tools/registry.js";

function makeBuilder({ continuousBackend = true }: { continuousBackend?: boolean } = {}): SystemPromptBuilder {
  const builder = new SystemPromptBuilder({
    memoryManager: {
      getLvisMd: () => "",
      getUserPreferences: () => "",
      getMemoryContext: () => "",
    } as never,
    toolRegistry: new ToolRegistry(),
  });
  builder.setContinuousBackendEnabled(continuousBackend);
  return builder;
}

describe("SystemPromptBuilder — Conversation Meta Output", () => {
  it("prioritizes direct plugin tool calls over agent_spawn", () => {
    const builder = makeBuilder();
    const prompt = builder.build();
    expect(prompt).toContain("Agent Hub work board 직접 조회");
    expect(prompt).toContain("agent_spawn 을 쓰지 마세요");
    expect(prompt).toContain("request_plugin");
    expect(prompt).toContain("agent_hub_* 도구를 직접 호출하세요");
  });

  it("always emits the <title> emit instruction in the prompt", () => {
    const builder = makeBuilder();
    const prompt = builder.build();
    expect(prompt).toContain("## 대화 메타 출력 (final answer 끝에 추가)");
    expect(prompt).toContain("<title>10-20자 한국어 제목</title>");
    expect(prompt).toContain("[checkpoint]");
  });

  it("always emits Title 정책 and Checkpoint 마커 sections", () => {
    const builder = makeBuilder();
    const prompt = builder.build();
    expect(prompt).toContain("### Title 정책");
    expect(prompt).toContain("### Checkpoint 마커");
    expect(prompt).toContain("제안이 아니라 당신의 결정");
    expect(prompt).toContain("누적 진화 제목");
    expect(prompt).toContain("즉시 새 세션으로 회전");
  });

  it("injects current session title when set", () => {
    const builder = makeBuilder();
    builder.setSessionTitle("MS Graph 메일 조회");
    const prompt = builder.build();
    expect(prompt).toContain('현재 세션 제목: "MS Graph 메일 조회"');
  });

  it("omits session title line when title is null", () => {
    const builder = makeBuilder();
    builder.setSessionTitle(null);
    const prompt = builder.build();
    expect(prompt).not.toContain("현재 세션 제목:");
  });

  it("omits session title line when title is empty string (normalised to null)", () => {
    const builder = makeBuilder();
    builder.setSessionTitle("");
    const prompt = builder.build();
    expect(prompt).not.toContain("현재 세션 제목:");
  });

  it("updates session title between turns", () => {
    const builder = makeBuilder();
    builder.setSessionTitle("첫 번째 제목");
    expect(builder.build()).toContain('현재 세션 제목: "첫 번째 제목"');
    builder.setSessionTitle("두 번째 제목 — 업데이트");
    expect(builder.build()).toContain('현재 세션 제목: "두 번째 제목 — 업데이트"');
    expect(builder.build()).not.toContain("첫 번째 제목");
  });

  it("clears session title when set back to null", () => {
    const builder = makeBuilder();
    builder.setSessionTitle("어떤 제목");
    expect(builder.build()).toContain("현재 세션 제목:");
    builder.setSessionTitle(null);
    expect(builder.build()).not.toContain("현재 세션 제목:");
    // Meta output instructions must still be present after clearing
    expect(builder.build()).toContain("## 대화 메타 출력 (final answer 끝에 추가)");
  });
});

describe("SystemPromptBuilder — sanitizeTitle via setSessionTitle", () => {
  it("strips newline characters (\\n, \\r) from title", () => {
    const builder = makeBuilder();
    builder.setSessionTitle("제목\n주입\r시도");
    const prompt = builder.build();
    // newlines replaced by spaces and trimmed — result should not contain raw newlines inside quotes
    expect(prompt).not.toContain("제목\n주입");
    expect(prompt).not.toContain("제목\r주입");
    expect(prompt).toContain("현재 세션 제목:");
  });

  it("strips double-quote characters from title", () => {
    const builder = makeBuilder();
    builder.setSessionTitle('MS Graph "이메일" 조회');
    const prompt = builder.build();
    // double quotes inside title are replaced with spaces
    expect(prompt).not.toContain('"MS Graph "이메일"');
    expect(prompt).toContain("현재 세션 제목:");
  });

  it("strips backslash characters from title", () => {
    const builder = makeBuilder();
    builder.setSessionTitle("C:\\Users\\test 파일");
    const prompt = builder.build();
    expect(prompt).not.toContain("C:\\Users");
    expect(prompt).toContain("현재 세션 제목:");
  });

  it("strips angle brackets (<>) to prevent prompt-template injection", () => {
    const builder = makeBuilder();
    builder.setSessionTitle("<script>악의적 태그</script>");
    const prompt = builder.build();
    expect(prompt).not.toContain("<script>");
    expect(prompt).not.toContain("</script>");
    // content is preserved but angle brackets removed
    expect(prompt).toContain("현재 세션 제목:");
  });

  it("caps title at 50 characters", () => {
    const builder = makeBuilder();
    const longTitle = "가".repeat(60);
    builder.setSessionTitle(longTitle);
    const prompt = builder.build();
    // 50-char cap: the stored title must not exceed 50 chars
    expect(prompt).toContain("현재 세션 제목:");
    expect(prompt).not.toContain("가".repeat(51));
  });

  it("whitespace-only title after sanitize is normalised to null (no injection)", () => {
    const builder = makeBuilder();
    // A title that is all spaces should become empty after trim → treated as null
    builder.setSessionTitle("   ");
    const prompt = builder.build();
    expect(prompt).not.toContain("현재 세션 제목:");
  });

  it("title with only dangerous chars normalised to null after strip+trim", () => {
    const builder = makeBuilder();
    // Only angle brackets and newlines — after strip all that remains is spaces → null
    builder.setSessionTitle("<>\r\n<>");
    const prompt = builder.build();
    expect(prompt).not.toContain("현재 세션 제목:");
  });
});

describe("SystemPromptBuilder — safety flag (experimentalContinuousBackend)", () => {
  it("Section 9.9 is absent when flag is OFF (default)", () => {
    const builder = makeBuilder({ continuousBackend: false });
    const prompt = builder.build();
    expect(prompt).not.toContain("## 대화 메타 출력 (final answer 끝에 추가)");
    expect(prompt).not.toContain("<title>10-20자 한국어 제목</title>");
    expect(prompt).not.toContain("[checkpoint-suggested]");
  });

  it("Section 8 (Rolling Summary Preamble) is absent when flag is OFF even with preamble set", () => {
    const builder = makeBuilder({ continuousBackend: false });
    builder.setSummaryPreamble("이전 세션 요약 내용입니다.");
    const prompt = builder.build();
    expect(prompt).not.toContain("<prior-context-summary>");
    expect(prompt).not.toContain("이전 세션 요약 내용입니다.");
  });

  it("Section 9.9 appears when flag is turned ON", () => {
    const builder = makeBuilder({ continuousBackend: true });
    const prompt = builder.build();
    expect(prompt).toContain("## 대화 메타 출력 (final answer 끝에 추가)");
    expect(prompt).toContain("<title>10-20자 한국어 제목</title>");
  });

  it("Section 8 appears when flag is ON and preamble is set", () => {
    const builder = makeBuilder({ continuousBackend: true });
    builder.setSummaryPreamble("이전 세션 요약 내용입니다.");
    const prompt = builder.build();
    expect(prompt).toContain("<prior-context-summary>");
    expect(prompt).toContain("이전 세션 요약 내용입니다.");
  });
});
