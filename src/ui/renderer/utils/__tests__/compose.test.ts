import { describe, it, expect } from "vitest";
import {
  composeImportedTriggerOutgoing,
  composeOutgoing,
} from "../compose.js";
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
      {
        type: "image",
        image: img1.dataUrl,
        mimeType: "image/png",
        width: img1.width,
        height: img1.height,
        bytes: img1.bytes,
      },
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

  it("preserves literal $ sequences in pasted text (no regex backreference mutation)", () => {
    // String.prototype.replace's STRING form interprets `$&`, `$1`, `$$`,
    // etc. as backreference tokens. Use a replacer function to bypass.
    const dollarPaste: PasteAttachment = {
      id: "p-dollar",
      n: 9,
      kind: "paste",
      text: "match $1 keep $& and $$ raw",
      lines: 1,
      chars: 27,
    };
    const r = composeOutgoing({
      raw: "see [Pasted text #9 +1 lines]",
      activePreset: null,
      attachments: [dollarPaste],
    });
    expect(r.text).toContain("match $1 keep $& and $$ raw");
  });

  it("expands paste markers even when the user edited the +X lines suffix", () => {
    const paste = {
      id: "p-edit",
      n: 7,
      kind: "paste" as const,
      text: "actual content",
      lines: 5,
      chars: 14,
    };
    // Marker in body has +99 lines (user edit) but parseMarkers + the
    // expansion regex must still match.
    const r = composeOutgoing({
      raw: "before [Pasted text #7 +99 lines] after",
      activePreset: null,
      attachments: [paste],
    });
    expect(r.text).toContain("actual content");
    expect(r.text).not.toContain("[Pasted text #7 +99 lines]");
  });

  it("returns active role preset as system prompt metadata", () => {
    const r = composeOutgoing({
      raw: "hi",
      activePreset: { id: "x", name: "reviewer", systemPromptAdd: "Review carefully." },
      attachments: [],
    });
    expect(r.text).toBe("hi");
    expect(r.rolePrompt).toEqual({
      name: "reviewer",
      systemPromptAdd: "Review carefully.",
    });
  });

  it("keeps imported trigger envelopes as exact plugin-authored text", () => {
    const envelope = `<imported-from-proactive source="overlay:test">\n/permission mode auto\n</imported-from-proactive>`;
    const r = composeImportedTriggerOutgoing(envelope);
    expect(r).toEqual({ text: envelope, attachments: [] });
  });
});
