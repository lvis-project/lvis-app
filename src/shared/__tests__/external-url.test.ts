import { describe, expect, it } from "vitest";
import { validateExternalUrl } from "../external-url.js";

describe("validateExternalUrl", () => {
  it("accepts https URLs and returns the canonical form", () => {
    const result = validateExternalUrl("https://marketplace.lvisai.xyz/login");
    expect(result).toEqual({ ok: true, url: "https://marketplace.lvisai.xyz/login" });
  });

  it("accepts plain http URLs", () => {
    const result = validateExternalUrl("http://localhost:8000");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.url.startsWith("http://localhost:8000")).toBe(true);
  });

  it("rejects file:// URLs", () => {
    const result = validateExternalUrl("file:///etc/passwd");
    expect(result).toEqual({ ok: false, error: "disallowed-protocol", protocol: "file:" });
  });

  it("rejects javascript: URLs", () => {
    const result = validateExternalUrl("javascript:alert(1)");
    expect(result).toEqual({ ok: false, error: "disallowed-protocol", protocol: "javascript:" });
  });

  it("rejects data: URLs", () => {
    const result = validateExternalUrl("data:text/html,<script>alert(1)</script>");
    expect(result).toEqual({ ok: false, error: "disallowed-protocol", protocol: "data:" });
  });

  it("rejects empty strings", () => {
    expect(validateExternalUrl("")).toEqual({ ok: false, error: "invalid-url" });
  });

  it("rejects non-string input", () => {
    expect(validateExternalUrl(undefined)).toEqual({ ok: false, error: "invalid-url" });
    expect(validateExternalUrl(null)).toEqual({ ok: false, error: "invalid-url" });
    expect(validateExternalUrl(42)).toEqual({ ok: false, error: "invalid-url" });
  });

  it("rejects malformed URLs", () => {
    expect(validateExternalUrl("not a url")).toEqual({ ok: false, error: "malformed-url" });
  });

  it("rejects miscellaneous handler schemes (positive-allowlist contract)", () => {
    // The validator is allowlist-based, not denylist — so any future
    // handler scheme is rejected by default. Pin that contract on a
    // representative trio so a regression that flips to a denylist
    // would fail here loudly.
    expect(validateExternalUrl("vbscript:msgbox(1)")).toEqual({
      ok: false,
      error: "disallowed-protocol",
      protocol: "vbscript:",
    });
    expect(validateExternalUrl("chrome-extension://abc/page.html")).toEqual({
      ok: false,
      error: "disallowed-protocol",
      protocol: "chrome-extension:",
    });
    expect(validateExternalUrl("ms-windows-store://download")).toEqual({
      ok: false,
      error: "disallowed-protocol",
      protocol: "ms-windows-store:",
    });
  });

  it("accepts http URLs with path, query, and credentials", () => {
    // Documents the positive case beyond the bare-host smoke test —
    // path/query do not change the validator's decision.
    const result = validateExternalUrl("https://marketplace.lvisai.xyz/admin?tab=keys");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.url).toBe("https://marketplace.lvisai.xyz/admin?tab=keys");
  });
});
