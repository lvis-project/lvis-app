import { describe, expect, it } from "vitest";
import { stripUntrustedTags } from "../strip-untrusted-tags.js";

describe("stripUntrustedTags", () => {
  it("strips open + close tags, preserves inner content", () => {
    const input = "- 제목: <untrusted-meeting-title>과자 시식안</untrusted-meeting-title>";
    expect(stripUntrustedTags(input)).toBe("- 제목: 과자 시식안");
  });

  it("strips multiple wrap classes", () => {
    const input =
      "<untrusted-subject>제목</untrusted-subject> | <untrusted-sender-domain>finance.example.com</untrusted-sender-domain>";
    expect(stripUntrustedTags(input)).toBe("제목 | finance.example.com");
  });

  it("handles unbalanced / missing close tag", () => {
    const input = "<untrusted-title>잘림 케이스";
    expect(stripUntrustedTags(input)).toBe("잘림 케이스");
  });

  it("preserves user-content that happens to contain XML-like strings", () => {
    // 사용자 컨텐츠 안의 일반 XML/HTML 흔적은 건드리지 않음 (less aggressive).
    const input =
      "- 본문: <untrusted-body><tag>example</tag></untrusted-body>";
    expect(stripUntrustedTags(input)).toBe("- 본문: <tag>example</tag>");
  });

  it("only matches untrusted- namespace", () => {
    const input = "<other>keep</other> <untrusted-x>strip</untrusted-x>";
    expect(stripUntrustedTags(input)).toBe("<other>keep</other> strip");
  });

  it("returns empty string for empty / undefined-like input", () => {
    expect(stripUntrustedTags("")).toBe("");
  });

  it("works with multi-line prompts", () => {
    const input = [
      "미팅이 방금 종료되었습니다.",
      "- 제목: <untrusted-meeting-title>Q3 분석</untrusted-meeting-title>",
      "- 주요 내용:",
      "  - <untrusted-highlight>매출 증가</untrusted-highlight>",
    ].join("\n");
    const expected = [
      "미팅이 방금 종료되었습니다.",
      "- 제목: Q3 분석",
      "- 주요 내용:",
      "  - 매출 증가",
    ].join("\n");
    expect(stripUntrustedTags(input)).toBe(expected);
  });

  it("is case-sensitive (XML convention) — does not strip uppercase variants", () => {
    // wrapUntrusted 는 항상 lowercase 만 생성. 대문자 변형은 사용자 content 일
    // 가능성이 높으므로 보존.
    const input = "<UNTRUSTED-TITLE>x</UNTRUSTED-TITLE>";
    expect(stripUntrustedTags(input)).toBe(input);
  });
});
