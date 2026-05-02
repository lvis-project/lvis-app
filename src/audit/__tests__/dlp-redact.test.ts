/**
 * Sprint E §3 — redactForLLM pattern coverage (email / phone / CC).
 * Also covers redactFsPath (audit log PII redact, #449).
 */
import { describe, it, expect } from "vitest";
import os from "node:os";
import { redactForLLM, redactFsPath } from "../dlp-filter.js";

describe("redactForLLM", () => {
  it("redacts emails", () => {
    const r = redactForLLM("ping me at foo.bar+baz@example.com please");
    expect(r.redacted).toContain("[REDACTED:EMAIL]");
    expect(r.redacted).not.toContain("foo.bar+baz@example.com");
    expect(r.counts.EMAIL).toBe(1);
    expect(r.totalCount).toBe(1);
  });

  it("redacts Korean mobile phone numbers (with and without hyphens)", () => {
    const r1 = redactForLLM("내 번호 010-1234-5678");
    expect(r1.redacted).toContain("[REDACTED:PHONE]");
    expect(r1.counts.PHONE_KR).toBe(1);
    const r2 = redactForLLM("01098765432");
    expect(r2.redacted).toContain("[REDACTED:PHONE]");
    expect(r2.counts.PHONE_KR).toBe(1);
  });

  it("redacts US phone numbers", () => {
    const r = redactForLLM("Call 415-555-1234 or (415) 555-9876");
    expect(r.counts.PHONE_US).toBe(2);
    expect(r.redacted).not.toMatch(/415-555-1234/);
  });

  it("redacts credit card numbers that pass Luhn, preserves fakes", () => {
    // Visa test number 4111111111111111 passes Luhn
    const r = redactForLLM("card 4111 1111 1111 1111 vs 1234 5678 9012 3456");
    expect(r.counts.CREDIT_CARD).toBe(1);
    expect(r.redacted).toContain("[REDACTED:CC]");
    expect(r.redacted).toContain("1234 5678 9012 3456");
  });

  it("redacts Korean SSN (RRN)", () => {
    const r = redactForLLM("주민번호 900101-1234567 입니다");
    expect(r.counts.SSN_KR).toBe(1);
    expect(r.redacted).toContain("[REDACTED:SSN]");
  });

  it("returns zero counts on clean text", () => {
    const r = redactForLLM("안녕하세요, LVIS 입니다.");
    expect(r.totalCount).toBe(0);
    expect(r.redacted).toBe("안녕하세요, LVIS 입니다.");
  });
});

describe("redactFsPath", () => {
  const home = os.homedir();

  it("replaces home-dir prefix in a plain FS path", () => {
    const p = home + "/.lvis/plugins/com.example/dist/ui.js";
    const result = redactFsPath(p);
    expect(result).toMatch(/^<home>/);
    expect(result).not.toContain(home);
  });

  it("replaces home-dir prefix in a file:// URL", () => {
    const p = "file://" + home + "/.lvis/plugins/com.example/dist/ui.js";
    const result = redactFsPath(p);
    expect(result).toMatch(/^file:\/\/<home>/);
    expect(result).not.toContain(home);
  });

  it("leaves unrelated paths unchanged", () => {
    const p = "/tmp/some-random-path/file.js";
    expect(redactFsPath(p)).toBe(p);
  });

  it("caps paths longer than 256 characters", () => {
    const long = home + "/" + "a".repeat(300);
    const result = redactFsPath(long);
    expect(result.length).toBeLessThanOrEqual(257); // 256 chars + ellipsis char
    expect(result).toContain("…");
  });

  it("returns the input unchanged for empty string", () => {
    expect(redactFsPath("")).toBe("");
  });

  it("handles exact home-dir match without trailing slash", () => {
    expect(redactFsPath(home)).toBe("<home>");
  });
});
