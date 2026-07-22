import { describe, it, expect } from "vitest";
import { genericToModelMessages } from "../message-mapper.js";
import type { GenericMessage } from "../../types.js";

describe("genericToModelMessages — multimodal user content", () => {
  it("preserves string content as a single text part (backward compat)", () => {
    const msgs: GenericMessage[] = [{ role: "user", content: "hello" }];
    const out = genericToModelMessages(msgs);
    expect(out[0]).toEqual({
      role: "user",
      content: [{ type: "text", text: "hello" }],
    });
  });

  it("maps an image part to vercel { type: image, image, mediaType }", () => {
    const dataUrl = "data:image/png;base64,iVBORw0KGgo=";
    const msgs: GenericMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "image", image: dataUrl, mimeType: "image/png" },
        ],
      },
    ];
    const out = genericToModelMessages(msgs);
    expect(out[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "what is this?" },
        { type: "image", image: dataUrl, mediaType: "image/png" },
      ],
    });
  });

  it("maps a file part to vercel { type: file, data, mediaType }", () => {
    const data = "data:application/pdf;base64,JVBERi0=";
    const msgs: GenericMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "summarize this PDF" },
          { type: "file", data, mimeType: "application/pdf" },
        ],
      },
    ];
    const out = genericToModelMessages(msgs);
    expect(out[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "summarize this PDF" },
        { type: "file", data, mediaType: "application/pdf" },
      ],
    });
  });

  it("maps mixed text + image + file in order", () => {
    const img = "data:image/png;base64,xxx";
    const file = "data:text/plain;base64,yyy";
    const msgs: GenericMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "before" },
          { type: "image", image: img, mimeType: "image/png" },
          { type: "text", text: "between" },
          { type: "file", data: file, mimeType: "text/plain" },
          { type: "text", text: "after" },
        ],
      },
    ];
    const out = genericToModelMessages(msgs);
    const content = (out[0] as { content: unknown[] }).content;
    expect(content).toHaveLength(5);
    expect((content[0] as { type: string }).type).toBe("text");
    expect((content[1] as { type: string }).type).toBe("image");
    expect((content[2] as { type: string }).type).toBe("text");
    expect((content[3] as { type: string }).type).toBe("file");
    expect((content[4] as { type: string }).type).toBe("text");
  });

  it("does not regress assistant or tool_result handling", () => {
    const msgs: GenericMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      {
        role: "tool_result",
        toolUseId: "t1",
        toolName: "read",
        content: "file content",
      },
    ];
    const out = genericToModelMessages(msgs);
    expect(out).toHaveLength(3);
    expect(out[0].role).toBe("user");
    expect(out[1].role).toBe("assistant");
    expect(out[2].role).toBe("tool");
  });
});

describe("genericToModelMessages — tool_result image (view_image)", () => {
  const imageMsg: GenericMessage = {
    role: "tool_result",
    toolUseId: "tu_1",
    toolName: "view_image",
    content: "[image loaded]",
    image: { data: "QUJD", mimeType: "image/png", bytes: 3 },
  };

  it("emits a content output with a file part on Claude", () => {
    const out = genericToModelMessages([imageMsg], "claude");
    expect(out[0]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "tu_1",
          toolName: "view_image",
          output: {
            type: "content",
            value: [
              { type: "text", text: "[image loaded]" },
              { type: "file", data: { type: "data", data: "QUJD" }, mediaType: "image/png" },
            ],
          },
        },
      ],
    });
  });

  it("degrades to a text placeholder on non-Claude vendors (tool results are text-only there)", () => {
    const out = genericToModelMessages([imageMsg], "openai");
    expect(out[0]).toMatchObject({
      role: "tool",
      content: [{ type: "tool-result", output: { type: "text", value: "[image loaded]" } }],
    });
  });

  it("keeps an imageless tool_result as plain text on Claude", () => {
    const out = genericToModelMessages(
      [{ role: "tool_result", toolUseId: "t", content: "ok" }],
      "claude",
    );
    expect(out[0]).toMatchObject({
      content: [{ output: { type: "text", value: "ok" } }],
    });
  });
});
