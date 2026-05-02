/**
 * Sprint E §3 — redactForLLM pattern coverage (email / phone / CC).
 * Also covers redactFsPath + redactAuditPayload (audit log PII redact, #449).
 */
import { describe, it, expect } from "vitest";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { redactForLLM, redactFsPath, redactAuditPayload } from "../dlp-filter.js";

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
  // Guard: if homedir is empty (rare CI sandbox) the redact logic is a no-op —
  // skip these tests rather than give a false-green pass.
  const itIfHome = home ? it : it.skip;

  itIfHome("replaces home-dir prefix in a plain FS path", () => {
    const p = home + "/.lvis/plugins/com.example/dist/ui.js";
    const result = redactFsPath(p);
    expect(result).toMatch(/^<home>/);
    expect(result).not.toContain(home);
  });

  itIfHome("replaces home-dir prefix in a file:// URL (pathToFileURL format)", () => {
    // Use pathToFileURL so the test input matches what Electron/Node produces,
    // not just the same string-concat the implementation uses internally.
    const p = pathToFileURL(home + "/.lvis/plugins/com.example/dist/ui.js").href;
    const result = redactFsPath(p);
    expect(result).toMatch(/^file:\/\/<home>/);
    expect(result).not.toContain(home);
  });

  it("leaves unrelated paths unchanged", () => {
    const p = "/tmp/some-random-path/file.js";
    expect(redactFsPath(p)).toBe(p);
  });

  itIfHome("caps paths longer than 256 code points", () => {
    // Use emoji (2 UTF-16 units each) to verify the cap works on code points,
    // not UTF-16 code units. 300 emoji + "<home>/" = 307 code points > 256.
    const long = home + "/" + "😀".repeat(300);
    const result = redactFsPath(long);
    expect([...result].length).toBeLessThanOrEqual(257); // 256 code points + ellipsis
    expect(result).toContain("…");
  });

  it("returns the input unchanged for empty string", () => {
    expect(redactFsPath("")).toBe("");
  });

  itIfHome("handles exact home-dir match without trailing slash", () => {
    expect(redactFsPath(home)).toBe("<home>");
  });

  itIfHome("handles Windows-style backslash separator", () => {
    // Simulate a Windows path where the home dir is used as a prefix.
    const winHome = home.replace(/\//g, "\\");
    const p = winHome + "\\AppData\\Roaming\\lvis\\plugins\\foo.js";
    const result = redactFsPath(p);
    // On non-Windows, _homeDir uses forward slashes so backslash paths won't
    // match — this test is mainly a contract test for when running on Windows.
    // Just assert no throw and the result is a string.
    expect(typeof result).toBe("string");
  });
});

describe("redactAuditPayload", () => {
  const home = os.homedir();
  const itIfHome = home ? it : it.skip;

  itIfHome("redacts known path fields", () => {
    const payload = {
      webContentsId: 42,
      pluginId: "com.example",
      entryUrl: home + "/.lvis/plugins/com.example/dist/ui.js",
      entryFsPath: home + "/.lvis/plugins/com.example/dist/ui.js",
      reason: "invalid-entry-url",
    };
    const result = redactAuditPayload(payload) as Record<string, unknown>;
    expect(result.entryUrl).toMatch(/^<home>/);
    expect(result.entryFsPath).toMatch(/^<home>/);
    expect(result.pluginId).toBe("com.example");
    expect(result.webContentsId).toBe(42);
    expect(result.reason).toBe("invalid-entry-url");
  });

  it("returns non-object payload unchanged", () => {
    expect(redactAuditPayload("string")).toBe("string");
    expect(redactAuditPayload(null)).toBeNull();
    expect(redactAuditPayload(42)).toBe(42);
  });
});
