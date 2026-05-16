/**
 * Conversation Continuity Guard section (id 9.9) — always-on after gate removal.
 *
 * Verifies:
 *   - Hidden title/checkpoint markers are forbidden in the continuity guard
 *   - Session title is injected when set
 *   - No session title line emitted when title is null
 *   - setSessionTitle("") normalises to null (no injection)
 *   - sanitizeTitle() strips dangerous characters (newline, quote, backslash, angle brackets)
 *   - sanitizeTitle() + setSessionTitle() whitespace-only → normalised to null
 *   - Section 8 (Rolling Summary Preamble) injected when preamble set, omitted otherwise
 */
import { describe, it, expect } from "vitest";

import { SystemPromptBuilder } from "../system-prompt-builder.js";
import { ToolRegistry } from "../../tools/registry.js";

function makeBuilder(): SystemPromptBuilder {
  return new SystemPromptBuilder({
    memoryManager: {
      getAgentsMd: () => "",
      getLvisMd: () => "",
      getMemoryIndex: () => "",
      getUserPreferences: () => "",
      getMemoryContext: () => "",
    } as never,
    toolRegistry: new ToolRegistry(),
  });
}

function makeMemoryBuilder(memoryIndex: string): SystemPromptBuilder {
  return new SystemPromptBuilder({
    memoryManager: {
      getAgentsMd: () => "# Agents",
      getLvisMd: () => "# Agents",
      getMemoryIndex: () => memoryIndex,
      getUserPreferences: () => "",
      getMemoryContext: () => "",
    } as never,
    toolRegistry: new ToolRegistry(),
  });
}

describe("SystemPromptBuilder — Conversation Continuity Guard", () => {
  it("injects AGENTS.md and MEMORY.md index as distinct context sections", () => {
    const prompt = makeMemoryBuilder("# Memory Index\n\n- [A](./a.md)").build();
    expect(prompt).toContain("<lvis-agents-context>");
    expect(prompt).toContain("# Agents");
    expect(prompt).toContain("<lvis-memory-index>");
    expect(prompt).toContain("- [A](./a.md)");
    expect(prompt).not.toContain("<lvis-context>");
  });

  it("injects the selected role preset as a per-turn system prompt section", () => {
    const builder = makeBuilder();
    builder.setActiveRolePrompt({ name: "Reviewer", systemPromptAdd: "Review carefully." });
    const prompt = builder.build();
    expect(prompt).toContain('<lvis-active-role-prompt name="Reviewer">');
    expect(prompt).toContain("Review carefully.");
  });

  it("prioritizes direct plugin tool calls over agent_spawn", () => {
    const builder = makeBuilder();
    const prompt = builder.build();
    expect(prompt).toContain("플러그인 UI/업무보드 직접 조회");
    expect(prompt).toContain("agent_spawn 을 쓰지 마세요");
    expect(prompt).toContain("request_plugin");
    expect(prompt).toContain("해당 도구가 현재 보이면 직접 호출");
  });

  it("emits the continuity guard instead of hidden marker output instructions", () => {
    const builder = makeBuilder();
    const prompt = builder.build();
    expect(prompt).toContain("## 대화 연속성 출력 규칙");
    expect(prompt).toContain("최종 답변에는 사용자에게 보여줄 본문만 작성하세요");
    expect(prompt).toContain("`<title>...</title>`, `[checkpoint]`, `[checkpoint-suggested]` 문자열은 출력 금지입니다");
    expect(prompt).not.toContain("## 대화 메타 출력 (final answer 끝에 추가)");
    expect(prompt).not.toContain("<title>10-20자 한국어 제목</title>");
  });

  it("describes checkpoint handling as host-owned next-turn preflight", () => {
    const builder = makeBuilder();
    const prompt = builder.build();
    expect(prompt).toContain("체크포인트와 세션 요약은 host 가 다음 턴 시작 전 context preflight 에서 자동 처리합니다");
    expect(prompt).not.toContain("### Title 정책");
    expect(prompt).not.toContain("### Checkpoint 마커");
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
    // Continuity guard must still be present after clearing
    expect(builder.build()).toContain("## 대화 연속성 출력 규칙");
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

describe("SystemPromptBuilder — Section 8 Rolling Summary Preamble (always-on)", () => {
  it("Section 9.9 is always present (no gate)", () => {
    const builder = makeBuilder();
    const prompt = builder.build();
    expect(prompt).toContain("## 대화 연속성 출력 규칙");
    expect(prompt).toContain("체크포인트 마커를 출력하지 마세요");
    expect(prompt).not.toContain("<title>10-20자 한국어 제목</title>");
  });

  it("Section 8 (Rolling Summary Preamble) appears when preamble set", () => {
    const builder = makeBuilder();
    builder.setSummaryPreamble("이전 세션 요약 내용입니다.");
    const prompt = builder.build();
    expect(prompt).toContain("<prior-context-summary>");
    expect(prompt).toContain("이전 세션 요약 내용입니다.");
  });

  it("Section 8 is absent when preamble is null (first-turn / fresh session)", () => {
    const builder = makeBuilder();
    const prompt = builder.build();
    expect(prompt).not.toContain("<prior-context-summary>");
  });
});
