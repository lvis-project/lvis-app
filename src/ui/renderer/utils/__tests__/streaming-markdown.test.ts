import { describe, expect, it } from "vitest";
import { clampDanglingMarkdownLink } from "../streaming-markdown.js";

describe("clampDanglingMarkdownLink", () => {
  it("returns the input unchanged when there is no dangling link", () => {
    expect(clampDanglingMarkdownLink("plain text")).toBe("plain text");
    expect(clampDanglingMarkdownLink("[a](https://x.test) plain")).toBe(
      "[a](https://x.test) plain",
    );
  });

  it("hides the dangling URL while a markdown link is mid-stream", () => {
    // Reproduces the calendar_create webLink leak: until the closing `)`
    // arrives, the partial `[label](URL` would otherwise show the entire
    // base64 URL fragment as plain text (with remark-gfm autolinking it).
    const partial =
      "추가했습니다. [여기서 확인하세요](https://outlook.live.com/owa/?itemid=AQMk%3D%3D&exvsurl=1&path=/calendar/item";
    expect(clampDanglingMarkdownLink(partial)).toBe(
      "추가했습니다. [여기서 확인하세요](…)",
    );
  });

  it("does not touch a complete markdown link", () => {
    const full =
      "추가했습니다. [여기서 확인하세요](https://outlook.live.com/owa/?itemid=AQMk%3D%3D&exvsurl=1&path=/calendar/item).";
    expect(clampDanglingMarkdownLink(full)).toBe(full);
  });

  it("handles the empty `[label](` case (just `(` after `]`)", () => {
    expect(clampDanglingMarkdownLink("see [here](")).toBe("see [here](…)");
  });

  it("only clamps the trailing dangling link, leaving earlier complete links intact", () => {
    const mixed =
      "first [a](https://x.test/a) then [b](https://x.test/b-very-long";
    expect(clampDanglingMarkdownLink(mixed)).toBe(
      "first [a](https://x.test/a) then [b](…)",
    );
  });

  it("does not match across newlines (a dangling link on a prior line is not the streaming tail)", () => {
    // The regex anchors to end-of-string with no newline in the URL part,
    // so a multi-line buffer with a complete-then-broken link earlier is
    // left alone — only the actual streaming tail is rewritten.
    const text = "intro [a](https://x.test/a\nnext line here";
    expect(clampDanglingMarkdownLink(text)).toBe(text);
  });
});
