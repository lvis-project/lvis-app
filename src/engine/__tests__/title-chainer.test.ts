/**
 * Title Chainer tests — §PR-3
 */
import { describe, it, expect, vi } from "vitest";
import { chainTitle } from "../title-chainer.js";
import type { LLMProvider } from "../llm/types.js";

/** Build a mock LLMProvider that streams the given text then completes. */
function makeLlm(responseText: string): LLMProvider {
  return {
    vendor: "claude" as const,
    streamTurn: vi.fn().mockImplementation(async function* () {
      yield { type: "text_delta" as const, text: responseText };
      yield { type: "message_complete" as const, stopReason: "end_turn" as const };
    }),
  };
}

describe("chainTitle", () => {
  it("returns a valid chained title from LLM response (>=10 chars)", async () => {
    // "오늘 회의 결과 정리" = 10 chars
    const llm = makeLlm("오늘 회의 결과 정리");
    const result = await chainTitle(llm, "이전 세션 제목이야", "오늘 회의에서 결정된 사항들입니다.");
    expect(result).toBe("오늘 회의 결과 정리");
  });

  it("strips leading and trailing quotes from LLM response", async () => {
    // "업무 보고서 요약 정리" = 11 chars
    const llm = makeLlm('"업무 보고서 요약 정리"');
    const result = await chainTitle(llm, "기존 제목 내용입니다", "업무 결과를 정리했습니다.");
    expect(result).toBe("업무 보고서 요약 정리");
  });

  it("strips extra whitespace from LLM response", async () => {
    // "AI 답변 최종 요약" = 10 chars
    const llm = makeLlm("  AI 답변 최종 요약  ");
    const result = await chainTitle(llm, "기존 제목 내용 다시", "이것은 AI 답변입니다.");
    expect(result).toBe("AI 답변 최종 요약");
  });

  it("returns null for empty finalAnswer", async () => {
    const llm = makeLlm("오늘 회의 결과 정리");
    const result = await chainTitle(llm, "기존 제목 내용입니다", "");
    expect(result).toBeNull();
  });

  it("returns null when LLM returns text shorter than 10 chars", async () => {
    // "짧음" = 2 chars
    const llm = makeLlm("짧음");
    const result = await chainTitle(llm, "기존 제목 내용 다시", "답변 내용입니다.");
    expect(result).toBeNull();
  });

  it("truncates LLM response longer than 20 chars to 20 chars", async () => {
    const longResponse = "매우 긴 제목으로 20자를 초과하는 응답입니다 정말로";
    const llm = makeLlm(longResponse);
    const result = await chainTitle(llm, "기존 제목 내용 다시", "답변 내용입니다.");
    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThanOrEqual(20);
  });

  it("returns null when LLM stream throws an error", async () => {
    const llm: LLMProvider = {
      vendor: "claude" as const,
      streamTurn: vi.fn().mockImplementation(async function* () {
        throw new Error("network error");
        // eslint-disable-next-line no-unreachable
        yield { type: "text_delta" as const, text: "" };
      }),
    };
    const result = await chainTitle(llm, "기존 제목 내용 다시", "답변 내용입니다.");
    expect(result).toBeNull();
  });
});
