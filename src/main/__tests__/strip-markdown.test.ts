import { describe, it, expect } from "vitest";
import { stripMarkdown } from "../strip-markdown.js";

describe("stripMarkdown", () => {
  it("returns plain text unchanged", () => {
    expect(stripMarkdown("plain notification text")).toBe("plain notification text");
  });

  it("strips bold (** and __)", () => {
    expect(stripMarkdown("**important** action")).toBe("important action");
    expect(stripMarkdown("status: __urgent__")).toBe("status: urgent");
  });

  it("strips italic (* and _)", () => {
    expect(stripMarkdown("turn *completed*")).toBe("turn completed");
    expect(stripMarkdown("routine _fired_")).toBe("routine fired");
  });

  it("strips bold + italic in the same string", () => {
    expect(stripMarkdown("**confirm** _now_")).toBe("confirm now");
  });

  it("does not mistake arithmetic for italic", () => {
    expect(stripMarkdown("price: 5 * 6 * 7 done")).toBe("price: 5 * 6 * 7 done");
  });

  it("collapses links to their visible text", () => {
    expect(stripMarkdown("see [docs](https://example.com/x)")).toBe("see docs");
  });

  it("strips inline code", () => {
    expect(stripMarkdown("`run` finished")).toBe("run finished");
  });

  it("strips strikethrough", () => {
    expect(stripMarkdown("~~deprecated~~ stale")).toBe("deprecated stale");
  });

  it("strips ATX headers at line start", () => {
    expect(stripMarkdown("# Routine fired")).toBe("Routine fired");
    expect(stripMarkdown("### deep header")).toBe("deep header");
  });

  it("strips unordered + ordered list markers", () => {
    expect(stripMarkdown("- first item")).toBe("first item");
    expect(stripMarkdown("* second item")).toBe("second item");
    expect(stripMarkdown("1. ordered")).toBe("ordered");
  });

  it("strips blockquote markers", () => {
    expect(stripMarkdown("> quoted line")).toBe("quoted line");
  });

  it("handles a realistic notification body", () => {
    const md = "**Confirm**: agent wants to run `git push --force` — [details](http://app/x)";
    expect(stripMarkdown(md)).toBe("Confirm: agent wants to run git push --force — details");
  });

  it("returns empty string for empty input", () => {
    expect(stripMarkdown("")).toBe("");
  });

  it("leaves bare punctuation alone", () => {
    expect(stripMarkdown("err: status=500, retry?")).toBe("err: status=500, retry?");
  });

  it("preserves snake_case identifiers (no intra-word italic)", () => {
    expect(stripMarkdown("session_abc_xyz fired")).toBe("session_abc_xyz fired");
    expect(stripMarkdown("Open my_file_name.ts")).toBe("Open my_file_name.ts");
    expect(stripMarkdown("tool web_search ok")).toBe("tool web_search ok");
  });

  it("preserves __ inside identifiers", () => {
    expect(stripMarkdown("key__name__value")).toBe("key__name__value");
  });

  it("still strips word-boundary _italic_ and __bold__", () => {
    expect(stripMarkdown("status _urgent_")).toBe("status urgent");
    expect(stripMarkdown("status __urgent__")).toBe("status urgent");
  });

  it("balances one level of parens in link URLs", () => {
    expect(stripMarkdown("see [Foo](https://x.com/path_(v1))")).toBe("see Foo");
    expect(stripMarkdown("[wiki](https://en.wikipedia.org/wiki/Foo_(bar)) note")).toBe("wiki note");
  });

  it("preserves emoji surrogate pairs inside emphasis", () => {
    expect(stripMarkdown("**👍 done**")).toBe("👍 done");
  });
});
