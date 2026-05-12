/**
 * Unit tests for `host-allow-list.ts` — the shared suffix-match helper
 * that gates `openAuthPartitionViewer` navigation and (eventually) other
 * partition-bound surfaces. These tests are the security boundary for
 * issue #649's allow-list — every regression here would mean a phishing
 * navigation can land inside a plugin auth partition.
 */
import { describe, expect, it } from "vitest";

import {
  normalizeAllowedHosts,
  normalizeHost,
  urlHostMatchesAllowList,
  urlMatchesAllowList,
} from "../host-allow-list.js";

describe("normalizeHost", () => {
  it("lowercases + trims + strips a leading dot", () => {
    expect(normalizeHost(" .Outlook.OFFICE.com ")).toBe("outlook.office.com");
  });

  it("returns an empty string for an empty/whitespace input", () => {
    expect(normalizeHost("   ")).toBe("");
    expect(normalizeHost("")).toBe("");
  });
});

describe("normalizeAllowedHosts", () => {
  it("dedupes + normalizes + preserves order", () => {
    expect(
      normalizeAllowedHosts([
        "Outlook.Office.com",
        ".outlook.office.com",
        "login.microsoftonline.com",
      ]),
    ).toEqual(["outlook.office.com", "login.microsoftonline.com"]);
  });

  it("refuses wildcard entries", () => {
    expect(() => normalizeAllowedHosts(["*"])).toThrow(/wildcard/);
    expect(() => normalizeAllowedHosts(["*.office.com"])).toThrow(/wildcard/);
  });

  it("refuses single-label hosts (would blanket-match every subdomain)", () => {
    expect(() => normalizeAllowedHosts(["localhost"])).toThrow(/at least one dot/);
  });

  // The list mirrored by the SDK's plugin-manifest.schema.json `not.enum`
  // gate. Drift would mean a manifest passes AJV at publish but throws at
  // plugin load. If you change this list, also update the SDK schema in
  // lockstep (cross-repo sync per CLAUDE.md "Cross-repo contract sync").
  it.each([
    "com", "net", "org", "kr", "co.kr", "or.kr", "go.kr",
    "io", "ai", "dev", "app",
  ])("refuses bare public-suffix-style top level %s", (suffix) => {
    expect(() => normalizeAllowedHosts([suffix])).toThrow(/public-suffix/);
  });

  // Defense-in-depth against IDN homoglyph phishing: SDK schema rejects
  // `xn--*` at publish time, host normalizer rejects at load time. Both
  // layers required — a hand-edited manifest bypasses the SDK schema.
  it("refuses IDN-punycode labels (xn--*) — homoglyph risk", () => {
    expect(() => normalizeAllowedHosts(["xn--80ak6aa92e.com"])).toThrow(
      /punycode/,
    );
    expect(() => normalizeAllowedHosts(["outlook.xn--p1ai"])).toThrow(
      /punycode/,
    );
    expect(() => normalizeAllowedHosts(["mail.xn--abc.example.com"])).toThrow(
      /punycode/,
    );
  });

  it("accepts mid-label `xn--` (not actual IDN encoding, just a literal substring)", () => {
    expect(() => normalizeAllowedHosts(["foo-xn--bar.example.com"])).not.toThrow();
  });

  it("refuses a URL pasted in place of a hostname", () => {
    expect(() => normalizeAllowedHosts(["https://outlook.office.com/"])).toThrow(
      /hostname, not a URL/,
    );
  });

  it("caps the allow-list length", () => {
    const many = Array.from({ length: 20 }, (_, i) => `host${i}.example.com`);
    expect(() => normalizeAllowedHosts(many)).toThrow(/at most/);
  });
});

describe("urlHostMatchesAllowList — dot-boundary suffix-match", () => {
  const allow = normalizeAllowedHosts(["outlook.office.com", "login.microsoftonline.com"]);

  it("matches the exact host", () => {
    expect(urlHostMatchesAllowList("outlook.office.com", allow)).toBe(true);
  });

  it("matches a sub-domain via dot boundary", () => {
    expect(urlHostMatchesAllowList("mail.outlook.office.com", allow)).toBe(true);
  });

  it("does NOT match a domain that merely ends with the literal suffix", () => {
    // The classic typosquat — string-endsWith would say yes, but dot-boundary
    // rejects it because `outlook.office.com.attacker.com` is not under
    // `outlook.office.com`.
    expect(
      urlHostMatchesAllowList("outlook.office.com.attacker.com", allow),
    ).toBe(false);
  });

  it("does NOT match an unrelated host that shares a final-label", () => {
    expect(urlHostMatchesAllowList("notoutlook.office.com", allow)).toBe(false);
  });

  it("does NOT match a different IdP", () => {
    expect(urlHostMatchesAllowList("login.live.com", allow)).toBe(false);
  });
});

describe("urlMatchesAllowList — URL parsing", () => {
  const allow = normalizeAllowedHosts(["outlook.office.com"]);

  it("accepts https URLs whose host matches", () => {
    expect(
      urlMatchesAllowList("https://outlook.office.com/calendar/view/week", allow),
    ).toBe(true);
  });

  it("rejects non-http(s) schemes", () => {
    expect(urlMatchesAllowList("javascript:alert(1)", allow)).toBe(false);
    expect(urlMatchesAllowList("file:///etc/passwd", allow)).toBe(false);
  });

  it("rejects an unparseable URL", () => {
    expect(urlMatchesAllowList("not a url", allow)).toBe(false);
  });

  it("uses URL.hostname rather than string searching (subdomain in the path is not a match)", () => {
    expect(
      urlMatchesAllowList(
        "https://attacker.example/redirect?to=https://outlook.office.com/",
        allow,
      ),
    ).toBe(false);
  });
});
