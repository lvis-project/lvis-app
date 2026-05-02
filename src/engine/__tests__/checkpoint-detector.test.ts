/**
 * Checkpoint Detector tests — §PR-3
 */
import { describe, it, expect } from "vitest";
import { detectFromStream } from "../checkpoint-detector.js";

describe("detectFromStream", () => {
  it("extracts title from <title>...</title> tag", () => {
    const raw = "답변 내용입니다.<title>업무 회의 요약 정리</title>";
    const result = detectFromStream(raw);
    expect(result.newTitle).toBe("업무 회의 요약 정리");
    expect(result.cleanedText).not.toContain("<title>");
    expect(result.cleanedText).toContain("답변 내용입니다.");
  });

  it("returns null newTitle for incomplete <title tag (no closing >)", () => {
    const raw = "답변 내용입니다.<title>불완전한 태그";
    const result = detectFromStream(raw);
    expect(result.newTitle).toBeNull();
    expect(result.cleanedText).toBe("답변 내용입니다.<title>불완전한 태그");
  });

  it("uses the last <title> when multiple occurrences exist", () => {
    const raw = "첫 번째<title>처음에 쓴 제목</title> 중간 내용<title>두 번째 최종 제목</title>";
    const result = detectFromStream(raw);
    expect(result.newTitle).toBe("두 번째 최종 제목");
    expect(result.cleanedText).not.toContain("<title>");
  });

  it("detects [checkpoint-suggested] marker and sets checkpointSuggested true", () => {
    const raw = "답변 완료.[checkpoint-suggested]";
    const result = detectFromStream(raw);
    expect(result.checkpointSuggested).toBe(true);
    expect(result.cleanedText).not.toContain("[checkpoint-suggested]");
  });

  it("removes both title and checkpoint markers from cleanedText", () => {
    const raw = "내용.<title>오늘 업무 세션 요약</title> 추가 내용.[checkpoint-suggested]";
    const result = detectFromStream(raw);
    expect(result.cleanedText).not.toContain("<title>");
    expect(result.cleanedText).not.toContain("[checkpoint-suggested]");
    expect(result.cleanedText).toContain("내용.");
    expect(result.cleanedText).toContain("추가 내용.");
    expect(result.newTitle).toBe("오늘 업무 세션 요약");
    expect(result.checkpointSuggested).toBe(true);
  });

  it("returns empty cleanedText and null newTitle for empty input", () => {
    const result = detectFromStream("");
    expect(result.cleanedText).toBe("");
    expect(result.newTitle).toBeNull();
    expect(result.checkpointSuggested).toBe(false);
  });

  it("handles Korean and English mixed title", () => {
    const raw = "결과입니다.<title>AI Summary 완료</title>";
    const result = detectFromStream(raw);
    expect(result.newTitle).toBe("AI Summary 완료");
  });

  it("truncates title longer than 20 chars to 20 chars", () => {
    const longTitle = "이것은 매우 긴 제목으로 20자를 훨씬 초과합니다";
    const raw = `내용.<title>${longTitle}</title>`;
    const result = detectFromStream(raw);
    expect(result.newTitle).not.toBeNull();
    expect(result.newTitle!.length).toBeLessThanOrEqual(20);
  });

  it("returns null newTitle for title shorter than 10 chars", () => {
    const raw = "내용.<title>짧은</title>";
    const result = detectFromStream(raw);
    expect(result.newTitle).toBeNull();
  });

  it("does not set checkpointSuggested when marker is absent", () => {
    const raw = "일반 답변입니다.";
    const result = detectFromStream(raw);
    expect(result.checkpointSuggested).toBe(false);
  });

  it("cleanedText equals trimmed input when no markers present", () => {
    const raw = "   일반 답변입니다.   ";
    const result = detectFromStream(raw);
    expect(result.cleanedText).toBe("일반 답변입니다.");
  });
});
