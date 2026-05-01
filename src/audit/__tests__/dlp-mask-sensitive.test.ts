/**
 * maskSensitiveData() — DLP_PATTERNS coverage, edge cases, no false positives.
 *
 * UQ-QUALITY SEV-2 #2
 */
import { describe, it, expect } from "vitest";
import { maskSensitiveData } from "../dlp-filter.js";

describe("maskSensitiveData — 주민등록번호 (Korean RRN)", () => {
  it("masks a valid RRN with hyphen", () => {
    const { masked, detections } = maskSensitiveData("주민번호: 900101-1234567");
    expect(masked).not.toContain("900101-1234567");
    expect(masked).toContain("******-*******");
    expect(detections).toContain("주민등록번호");
  });

  it("does not mask a RRN-like string with gender digit outside [1-4]", () => {
    // Gender digit 5 → not a valid RRN pattern
    const { masked } = maskSensitiveData("900101-5234567");
    expect(masked).toContain("900101-5234567");
  });

  it("masks multiple RRNs in a single string", () => {
    const { masked, detections } = maskSensitiveData("A 900101-1234567 B 851212-2345678");
    expect(masked).not.toContain("900101-1234567");
    expect(masked).not.toContain("851212-2345678");
    expect(detections).toContain("주민등록번호");
  });
});

describe("maskSensitiveData — 신용카드 (credit card)", () => {
  it("masks a 16-digit card number with spaces, preserves last 4", () => {
    const { masked, detections } = maskSensitiveData("카드: 1234 5678 9012 3456");
    expect(masked).not.toContain("1234 5678 9012 3456");
    expect(masked).toContain("****-****-****-3456");
    expect(detections).toContain("신용카드");
  });

  it("masks a 16-digit card number with hyphens", () => {
    const { masked } = maskSensitiveData("card: 1234-5678-9012-3456");
    expect(masked).not.toContain("1234-5678-9012-3456");
    expect(masked).toContain("****-****-****-3456");
  });

  it("masks a 16-digit card number without separators", () => {
    const { masked, detections } = maskSensitiveData("num: 1234567890123456");
    expect(masked).not.toContain("1234567890123456");
    expect(detections).toContain("신용카드");
  });
});

describe("maskSensitiveData — API 키 (sk- prefix)", () => {
  it("masks OpenAI-style API key", () => {
    const { masked, detections } = maskSensitiveData("key=sk-abcdefghijklmnopqrst");
    expect(masked).not.toContain("sk-abcdefghijklmnopqrst");
    expect(masked).toContain("sk-****");
    expect(detections).toContain("API 키");
  });

  it("masks longer API key", () => {
    const { masked } = maskSensitiveData(`key=sk-${"x".repeat(40)}`);
    expect(masked).toContain("sk-****");
  });

  it("does NOT mask sk- with fewer than 20 chars (too short to be a real key)", () => {
    const { masked, detections } = maskSensitiveData("sk-abc123");
    // Pattern requires 20+ alphanum chars after sk-
    expect(detections).not.toContain("API 키");
    expect(masked).toContain("sk-abc123");
  });
});

describe("maskSensitiveData — 전화번호 (Korean 010)", () => {
  it("masks 010-XXXX-XXXX format", () => {
    const { masked, detections } = maskSensitiveData("내 번호: 010-1234-5678");
    expect(masked).not.toContain("010-1234-5678");
    expect(masked).toContain("010-****-****");
    expect(detections).toContain("전화번호");
  });

  it("masks multiple phone numbers", () => {
    const { masked } = maskSensitiveData("010-1111-2222 and 010-3333-4444");
    expect(masked).not.toContain("010-1111-2222");
    expect(masked).not.toContain("010-3333-4444");
  });
});

describe("maskSensitiveData — 이메일 (email)", () => {
  it("preserves domain while masking local part", () => {
    const { masked, detections } = maskSensitiveData("이메일: user@example.com");
    expect(masked).not.toContain("user@example.com");
    expect(masked).toContain("***@example.com");
    expect(detections).toContain("이메일");
  });

  it("masks email in plain text context", () => {
    const { masked } = maskSensitiveData("contact admin@company.co.kr for help");
    expect(masked).not.toContain("admin@company.co.kr");
    expect(masked).toContain("***@company.co.kr");
  });
});

describe("maskSensitiveData — clean text (no false positives)", () => {
  it("returns text unchanged when no PII present", () => {
    const text = "Hello LVIS, this is a normal message without any sensitive data.";
    const { masked, detections } = maskSensitiveData(text);
    expect(masked).toBe(text);
    expect(detections).toHaveLength(0);
  });

  it("does not flag a normal number sequence as a credit card", () => {
    const { detections } = maskSensitiveData("order #12345 shipped");
    expect(detections).not.toContain("신용카드");
  });

  it("returns detections array listing only matched pattern names", () => {
    const { detections } = maskSensitiveData("api key: sk-abcdefghijklmnopqrstu email: x@y.com");
    expect(detections).toContain("API 키");
    expect(detections).toContain("이메일");
    expect(detections).not.toContain("신용카드");
    expect(detections).not.toContain("전화번호");
  });

  it("handles empty string", () => {
    const { masked, detections } = maskSensitiveData("");
    expect(masked).toBe("");
    expect(detections).toHaveLength(0);
  });
});
