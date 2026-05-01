import { describe, expect, it } from "vitest";
import { composeOutgoing } from "../compose.js";
import type { Attachment } from "../compose.js";

describe("composeOutgoing", () => {
  it("returns raw text unchanged when no preset, no docs, no attachments", () => {
    const result = composeOutgoing({
      raw: "Hello world",
      activePreset: null,
      attachedDocs: [],
      attachments: [],
    });
    expect(result.text).toBe("Hello world");
    expect(result.attachments).toEqual([]);
  });

  it("prepends role preset prefix when activePreset has systemPromptAdd", () => {
    const result = composeOutgoing({
      raw: "What is TypeScript?",
      activePreset: { id: "dev", name: "Developer", systemPromptAdd: "You are a senior dev." },
      attachedDocs: [],
      attachments: [],
    });
    expect(result.text).toMatch(/^\[Role: Developer\]/);
    expect(result.text).toContain("You are a senior dev.");
    expect(result.text).toContain("What is TypeScript?");
  });

  it("does not prepend prefix for default preset (isDefault=true)", () => {
    const result = composeOutgoing({
      raw: "Hello",
      activePreset: { id: "default", name: "기본", systemPromptAdd: "", isDefault: true },
      attachedDocs: [],
      attachments: [],
    });
    expect(result.text).toBe("Hello");
  });

  it("augments text with attached-doc notice when attachedDocs is non-empty", () => {
    const result = composeOutgoing({
      raw: "Summarise these",
      activePreset: null,
      attachedDocs: [
        { id: "doc-1", name: "report.pdf" },
        { id: "doc-2", name: "notes.md" },
      ],
      attachments: [],
    });
    expect(result.text).toContain("[Attached documents");
    expect(result.text).toContain("report.pdf (id: doc-1)");
    expect(result.text).toContain("notes.md (id: doc-2)");
    expect(result.text).toContain("Summarise these");
  });

  it("maps image attachments to attachments with type=image", () => {
    const att: Attachment = { id: "img-1", mimeType: "image/png", data: "base64data==" };
    const result = composeOutgoing({
      raw: "Describe this",
      activePreset: null,
      attachedDocs: [],
      attachments: [att],
    });
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]).toEqual({ type: "image", mimeType: "image/png", data: "base64data==" });
  });

  it("maps multiple image attachments to attachments preserving order", () => {
    const attachments: Attachment[] = [
      { id: "a1", mimeType: "image/jpeg", data: "jpg1" },
      { id: "a2", mimeType: "image/webp", data: "webp1" },
    ];
    const result = composeOutgoing({
      raw: "Compare",
      activePreset: null,
      attachedDocs: [],
      attachments,
    });
    expect(result.attachments).toHaveLength(2);
    expect(result.attachments[0].mimeType).toBe("image/jpeg");
    expect(result.attachments[1].mimeType).toBe("image/webp");
  });

  it("combines preset prefix, attached-doc notice, and raw text in order", () => {
    const result = composeOutgoing({
      raw: "Analyse",
      activePreset: { id: "analyst", name: "Analyst", systemPromptAdd: "Be concise." },
      attachedDocs: [{ id: "d1", name: "data.csv" }],
      attachments: [],
    });
    const lines = result.text;
    const presetIdx = lines.indexOf("[Role: Analyst]");
    const docIdx = lines.indexOf("[Attached documents");
    const rawIdx = lines.lastIndexOf("Analyse");
    expect(presetIdx).toBeLessThan(docIdx);
    expect(docIdx).toBeLessThan(rawIdx);
  });
});
