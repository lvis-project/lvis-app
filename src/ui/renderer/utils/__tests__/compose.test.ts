import { describe, it, expect } from "vitest";
import { composeOutgoing } from "../compose.js";
import type {
  Attachment,
  ImageAttachment,
  FileAttachment,
  PasteAttachment,
} from "../../types/attachments.js";

const img1: ImageAttachment = {
  id: "i1",
  n: 1,
  kind: "image",
  path: "/tmp/a.png",
  mimeType: "image/png",
  width: 100,
  height: 80,
  bytes: 1024,
  dataUrl: "data:image/png;base64,xxx",
};
const file2: FileAttachment = {
  id: "f2",
  n: 2,
  kind: "file",
  path: "/Users/ken/Desktop/budget-2026.pdf",
  name: "budget-2026.pdf",
  ext: "pdf",
  bytes: 1_200_000,
};
const paste3: PasteAttachment = {
  id: "p3",
  n: 3,
  kind: "paste",
  text: "line1\nline2\nline3",
  lines: 3,
  chars: 17,
};

describe("composeOutgoing", () => {
  it("returns plain text + empty attachments when no attachments", () => {
    const r = composeOutgoing({
      raw: "hello",
      activePreset: null,
      attachments: [],
    });
    expect(r.text).toBe("hello");
    expect(r.attachments).toEqual([]);
  });

  it("preserves [Image #N] markers in body and emits vision parts", () => {
    const list: Attachment[] = [img1];
    const r = composeOutgoing({
      raw: "see [Image #1]",
      activePreset: null,
      attachments: list,
    });
    expect(r.text).toContain("[Image #1]");
    expect(r.attachments).toEqual([
      { type: "image", image: img1.dataUrl, mimeType: "image/png" },
    ]);
  });

  it("augments [File #N] marker with absolute path", () => {
    const list: Attachment[] = [file2];
    const r = composeOutgoing({
      raw: "use [File #2] please",
      activePreset: null,
      attachments: list,
    });
    expect(r.text).toContain("/Users/ken/Desktop/budget-2026.pdf");
    expect(r.attachments).toEqual([]);
  });

  it("inline-expands [Pasted text #N +X lines] marker", () => {
    const list: Attachment[] = [paste3];
    const r = composeOutgoing({
      raw: "analyse [Pasted text #3 +3 lines] thanks",
      activePreset: null,
      attachments: list,
    });
    expect(r.text).toContain("Pasted text #3");
    expect(r.text).toContain("line1\nline2\nline3");
    expect(r.text).not.toContain("[Pasted text #3 +3 lines]");
    expect(r.attachments).toEqual([]);
  });

  it("handles mixed attachments in one turn", () => {
    const list: Attachment[] = [img1, file2, paste3];
    const r = composeOutgoing({
      raw: "compare [Image #1] with [File #2] then [Pasted text #3 +3 lines]",
      activePreset: null,
      attachments: list,
    });
    expect(r.text).toContain("[Image #1]");
    expect(r.text).toContain("/Users/ken/Desktop/budget-2026.pdf");
    expect(r.text).toContain("line1\nline2\nline3");
    expect(r.attachments).toHaveLength(1);
    expect(r.attachments[0].type).toBe("image");
  });

  it("applies role-preset prefix when active", () => {
    const r = composeOutgoing({
      raw: "hi",
      activePreset: { id: "x", name: "x", systemPromptAdd: "" },
      attachments: [],
    });
    expect(r.text).toBe("hi");
  });
});
