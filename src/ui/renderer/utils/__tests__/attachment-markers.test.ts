import { describe, it, expect } from "vitest";
import {
  parseMarkers,
  collapsePath,
  buildMarkerText,
  findMarkerAt,
} from "../attachment-markers.js";
import type {
  ImageAttachment,
  FileAttachment,
  PasteAttachment,
} from "../../types/attachments.js";

describe("parseMarkers", () => {
  it("returns empty array for plain text", () => {
    expect(parseMarkers("hello world")).toEqual([]);
  });

  it("extracts a single image marker", () => {
    expect(parseMarkers("look at [Image #1] please")).toEqual([1]);
  });

  it("extracts mixed markers in order", () => {
    const text = "see [Image #1] and [File #2] then [Pasted text #4 +12 lines]";
    expect(parseMarkers(text)).toEqual([1, 2, 4]);
  });

  it("deduplicates identical markers", () => {
    expect(parseMarkers("[Image #1] vs [Image #1] again")).toEqual([1]);
  });

  it("ignores non-marker bracket text", () => {
    expect(parseMarkers("[note] [Foo #1] [Image bar]")).toEqual([]);
  });

  it("preserves N when intermediate marker is removed by user", () => {
    expect(parseMarkers("[Image #1] [Pasted text #3 +5 lines]")).toEqual([1, 3]);
  });
});

describe("collapsePath", () => {
  it("preserves short paths unchanged", () => {
    expect(collapsePath("memo.txt")).toBe("memo.txt");
    expect(collapsePath("~/docs/x.pdf")).toBe("~/docs/x.pdf");
  });

  it("collapses long absolute paths", () => {
    expect(collapsePath("/Users/ken/Desktop/budget-2026.pdf")).toBe(
      "/User…-2026.pdf",
    );
  });

  it("collapses long temp paths", () => {
    expect(collapsePath("/var/folders/clipboard-005935.png")).toBe(
      "/var/…05935.png",
    );
  });

  it("collapses long basename with no parent dirs", () => {
    expect(collapsePath("quarterly-summary-final.xlsx")).toBe(
      "quart…final.xlsx",
    );
  });

  it("handles paths without extension", () => {
    expect(collapsePath("/very/long/path/no-extension-here")).toBe(
      "/very…-here",
    );
  });
});

describe("buildMarkerText", () => {
  it("formats image marker", () => {
    const a: ImageAttachment = {
      id: "a1",
      n: 1,
      kind: "image",
      path: "/tmp/x.png",
      mimeType: "image/png",
      width: 100,
      height: 100,
      bytes: 1024,
      dataUrl: "data:image/png;base64,xxx",
    };
    expect(buildMarkerText(a)).toBe("[Image #1]");
  });

  it("formats file marker", () => {
    const a: FileAttachment = {
      id: "a2",
      n: 2,
      kind: "file",
      path: "/tmp/x.pdf",
      name: "x.pdf",
      ext: "pdf",
      bytes: 4096,
    };
    expect(buildMarkerText(a)).toBe("[File #2]");
  });

  it("formats paste marker with line count", () => {
    const a: PasteAttachment = {
      id: "a3",
      n: 3,
      kind: "paste",
      text: "long...\nlong",
      lines: 12,
      chars: 487,
    };
    expect(buildMarkerText(a)).toBe("[Pasted text #3 +12 lines]");
  });
});

describe("findMarkerAt", () => {
  it("returns null for plain text", () => {
    expect(findMarkerAt("hello world", 5)).toBeNull();
  });

  it("returns the marker range when caret is just after `]`", () => {
    const text = "see [Image #1] here";
    // text:    s e e   [ I m a g e   # 1 ]   h e r e
    // index:   0 1 2 3 4 5 6 7 8 9 10 11 12 13 14...
    expect(findMarkerAt(text, 14)).toEqual({ start: 4, end: 14 });
  });

  it("returns the marker range when caret is in the middle", () => {
    const text = "see [Image #1] here";
    expect(findMarkerAt(text, 9)).toEqual({ start: 4, end: 14 });
  });

  it("returns null when caret is on the opening `[`", () => {
    const text = "see [Image #1] here";
    expect(findMarkerAt(text, 4)).toBeNull();
  });

  it("returns null when caret is past the closing `]`", () => {
    const text = "see [Image #1] here";
    expect(findMarkerAt(text, 15)).toBeNull();
  });

  it("matches a paste marker with line suffix", () => {
    const text = "before [Pasted text #4 +12 lines] after";
    // [Pasted text #4 +12 lines] = 26 chars starting at index 7 → end = 33
    expect(findMarkerAt(text, 33)).toEqual({ start: 7, end: 33 });
  });

  it("ignores non-marker brackets", () => {
    const text = "see [a note] here";
    expect(findMarkerAt(text, 11)).toBeNull();
  });

  it("returns null at cursor 0 or negative", () => {
    expect(findMarkerAt("[Image #1]", 0)).toBeNull();
  });
});
