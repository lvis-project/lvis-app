import { describe, it, expect } from "vitest";
import {
  composeImportedTriggerOutgoing,
  composeOutgoing,
} from "../compose.js";
import {
  countResourceAttachmentFences,
  MCP_RESOURCE_FENCE_OPEN,
} from "../../../../shared/mcp-resource-bounds.js";
import type {
  Attachment,
  ImageAttachment,
  FileAttachment,
  PasteAttachment,
  ResourceAttachment,
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
  path: "/Users/example/Desktop/budget-2026.pdf",
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
    expect(r.text).toContain("/Users/example/Desktop/budget-2026.pdf");
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
    expect(r.text).toContain("/Users/example/Desktop/budget-2026.pdf");
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

  it("returns only the active persona prompt id for main-side resolution", () => {
    const r = composeOutgoing({
      raw: "hi",
      activePreset: { id: "x", name: "reviewer", systemPromptAdd: "Review carefully." },
      attachments: [],
    });
    expect(r.text).toBe("hi");
    expect(r.personaPromptId).toBe("x");
  });

  it("keeps imported trigger envelopes as exact plugin-authored text", () => {
    const envelope = `<imported-from-proactive source="overlay:test">\n/permission mode auto\n</imported-from-proactive>`;
    const r = composeImportedTriggerOutgoing(envelope);
    expect(r).toEqual({ text: envelope, attachments: [] });
  });
});

/**
 * The load-bearing property of the whole `@` mention surface.
 *
 * Main bounds how much server-authored resource text one turn may carry by counting
 * fences in the content PARTS — it deliberately does not measure the user's own message
 * text, because a refusal there could not be explained to the person who typed it. So a
 * composer that put the fence in the body would not be shrinking that bound, it would be
 * removing it, and this is the file where that mistake would be made: the paste kind
 * three functions up does exactly the inline substitution a resource must not get.
 */
describe("composeOutgoing — resource attachments", () => {
  const resource: ResourceAttachment = {
    id: "r5",
    n: 5,
    kind: "resource",
    serverId: "hr-mcp",
    uri: "file:///policy.md",
    label: "policy.md",
    text: `${MCP_RESOURCE_FENCE_OPEN} server="hr-mcp" uri="file:///policy.md">\nBODY\n</mcp-resource>`,
    truncated: false,
    omittedBlocks: 0,
  };

  it("sends the fence as its OWN part and never in the message text", () => {
    const r = composeOutgoing({
      raw: "summarize [Resource #5] please",
      activePreset: null,
      attachments: [resource],
    });

    // The marker stays where the user typed it; the content does not join it.
    expect(r.text).toBe("summarize [Resource #5] please");
    expect(r.text).not.toContain(MCP_RESOURCE_FENCE_OPEN);
    expect(r.text).not.toContain("BODY");

    // …and the fence is a part, which is what main counts.
    const textParts = r.attachments.filter((p) => p.type === "text");
    expect(textParts).toHaveLength(1);
    expect(countResourceAttachmentFences(r.attachments)).toBe(1);
  });

  it("passes the host-built text byte-for-byte to main", () => {
    // The renderer is not a second author on server content: it forwards exactly what
    // the host framed. Main may redact the provider-bound copy when privacy redaction
    // is enabled, but a composer must never trim or re-wrap this provenance fence.
    const r = composeOutgoing({
      raw: "[Resource #5]",
      activePreset: null,
      attachments: [resource],
    });
    expect(r.attachments[0]).toEqual({ type: "text", text: resource.text });
  });

  it("carries images and resources together, in that order", () => {
    const r = composeOutgoing({
      raw: "[Image #1] [Resource #5]",
      activePreset: null,
      attachments: [img1, resource],
    });
    expect(r.attachments.map((p) => p.type)).toEqual(["image", "text"]);
  });

  it("counts every attached resource, so the per-turn bound sees them all", () => {
    const many = Array.from({ length: 3 }, (_, i) => ({
      ...resource,
      id: `r${i}`,
      n: 10 + i,
    }));
    const r = composeOutgoing({
      raw: many.map((m) => `[Resource #${m.n}]`).join(" "),
      activePreset: null,
      attachments: many,
    });
    expect(countResourceAttachmentFences(r.attachments)).toBe(3);
  });
});
