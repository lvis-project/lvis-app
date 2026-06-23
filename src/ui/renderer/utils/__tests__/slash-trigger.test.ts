import { describe, it, expect } from "vitest";
import { detectSlashQuery } from "../slash-trigger.js";

describe("detectSlashQuery", () => {
  it("triggers on a slash at the start of the text", () => {
    expect(detectSlashQuery("/comp", 5)).toEqual({ query: "comp", start: 0, end: 5 });
  });

  it("triggers on a bare slash (empty query)", () => {
    expect(detectSlashQuery("/", 1)).toEqual({ query: "", start: 0, end: 1 });
  });

  it("triggers on a slash right after a space (mid-message)", () => {
    const text = "hello /se";
    expect(detectSlashQuery(text, text.length)).toEqual({ query: "se", start: 6, end: 9 });
  });

  it("triggers on a slash at the start of a new line", () => {
    const text = "line one\n/help";
    expect(detectSlashQuery(text, text.length)).toEqual({ query: "help", start: 9, end: 14 });
  });

  it("does NOT trigger inside a URL (https://)", () => {
    const text = "see https://example.com";
    expect(detectSlashQuery(text, text.length)).toBeNull();
  });

  it("does NOT trigger inside a mid-word slash (TCP/IP)", () => {
    const text = "TCP/IP";
    expect(detectSlashQuery(text, text.length)).toBeNull();
  });

  it("closes once a space follows the command (query ends at whitespace)", () => {
    const text = "/help me";
    expect(detectSlashQuery(text, text.length)).toBeNull();
  });

  it("returns the query only up to the caret, not the whole token", () => {
    const text = "/sessions";
    expect(detectSlashQuery(text, 4)).toEqual({ query: "ses", start: 0, end: 4 });
  });

  it("returns null when the caret is at index 0", () => {
    expect(detectSlashQuery("/x", 0)).toBeNull();
  });

  it("returns null for an out-of-range caret", () => {
    expect(detectSlashQuery("/x", 99)).toBeNull();
  });

  it("returns null when there is no slash before the caret", () => {
    expect(detectSlashQuery("hello", 5)).toBeNull();
  });
});
