import { describe, it, expect } from "vitest";
import {
  genericToModelMessages,
  fullStreamToStreamEvent,
} from "../adapter.js";
import type { GenericMessage, StreamEvent, ToolCallBlock } from "../../types.js";
import { MAX_LOCAL_USER_CONTENT_PARTS } from "../../../../main/subscription-attachment-input.js";
import { collectStreamEvents, streamFromArray } from "./test-helpers.js";

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
    const img = "data:image/png;base64,iVBORw0KGgo=";
    const file = "data:text/plain;base64,eXl5";
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

  it("drops tampered remote attachments while preserving verified local input", () => {
    const localImage = "data:image/png;base64,iVBORw0KGgo=";
    const localFile = "data:text/plain;base64,SGVsbG8=";
    const out = genericToModelMessages([{
      role: "user",
      content: [
        { type: "text", text: "keep this" },
        { type: "image", image: "https://attacker.example/image.png", mimeType: "image/png" },
        { type: "file", data: "https://attacker.example/document.txt", mimeType: "text/plain" },
        { type: "image", image: localImage, mimeType: "image/png" },
        { type: "file", data: localFile, mimeType: "text/plain" },
      ],
    }]);

    expect(out).toEqual([{
      role: "user",
      content: [
        { type: "text", text: "keep this" },
        { type: "image", image: localImage, mediaType: "image/png" },
        { type: "file", data: localFile, mediaType: "text/plain" },
      ],
    }]);
    expect(JSON.stringify(out)).not.toContain("attacker.example");
    expect(genericToModelMessages([{
      role: "user",
      content: [
        { type: "image", image: "https://attacker.example/only.png", mimeType: "image/png" },
      ],
    }])).toEqual([]);
  });

  it("drops oversized multipart input before provider mapping", () => {
    const oversized: GenericMessage[] = [{
      role: "user",
      content: Array.from(
        { length: MAX_LOCAL_USER_CONTENT_PARTS + 1 },
        () => ({ type: "text" as const, text: "bounded" }),
      ),
    }];

    expect(genericToModelMessages(oversized)).toEqual([]);
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

  it("defaults Chat routes to a host-origin user image instead of dropping it", () => {
    const out = genericToModelMessages([imageMsg], "openai");
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      role: "tool",
      content: [{ output: { type: "text", value: "[image loaded]" } }],
    });
    expect(out[1]).toMatchObject({
      role: "user",
      content: [
        { type: "text", text: expect.stringContaining('call "tu_1"') },
        { type: "file", data: "QUJD", mediaType: "image/png" },
      ],
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

// ────────────────────────────────────────────────────────────────
// Malformed tool-call arguments must be contained, not replayed.
//
// The AI SDK returns the argument text verbatim when JSON.parse fails on it
// (`parseToolCall`'s outer catch keeps `toolCall.input`, a string, and marks
// the part `invalid: true`). A string that reaches history is replayed on
// every later round, and a provider whose chat template iterates the argument
// object rejects the WHOLE request — one malformed call would end the turn.
// ────────────────────────────────────────────────────────────────

describe("fullStreamToStreamEvent — tool-call input normalisation", () => {
  const finish = { type: "finish", finishReason: "tool-calls" };

  async function toolCallEvent(input: unknown) {
    const events = await collectStreamEvents(
      fullStreamToStreamEvent(
        streamFromArray([
          { type: "start" },
          { type: "tool-call", toolCallId: "tu-1", toolName: "bash", input },
          finish,
        ]),
        "claude",
      ),
    );
    const call = events.find((e) => e.type === "tool_call");
    expect(call?.type).toBe("tool_call");
    return call as Extract<StreamEvent, { type: "tool_call" }>;
  }

  it("passes an object input through untouched and marks nothing", async () => {
    const call = await toolCallEvent({ command: "ls" });
    expect(call.input).toEqual({ command: "ls" });
    expect(call.invalidInput).toBeUndefined();
  });

  it("parses a JSON string input into an object (unknown-tool fallback path)", async () => {
    const call = await toolCallEvent('{"command":"ls"}');
    expect(call.input).toEqual({ command: "ls" });
    expect(call.invalidInput).toBeUndefined();
  });

  it("marks truncated JSON as invalid and yields an empty object", async () => {
    const truncated = '{"command":"echo hello wor';
    const call = await toolCallEvent(truncated);
    expect(call.input).toEqual({});
    expect(call.invalidInput).toEqual({
      raw: truncated,
      reason: "unparsable-json",
      rawChars: truncated.length,
    });
  });

  it("bounds the excerpt it keeps from a runaway argument string", async () => {
    const runaway = `{"command":"${"x".repeat(5000)}`;
    const call = await toolCallEvent(runaway);
    expect(call.invalidInput?.raw.length).toBe(200);
    expect(call.invalidInput?.rawChars).toBe(runaway.length);
  });

  it("marks valid JSON that is not an object as invalid", async () => {
    const call = await toolCallEvent("[1,2,3]");
    expect(call.input).toEqual({});
    expect(call.invalidInput?.reason).toBe("non-object");
  });

  it("keeps absent arguments as an empty object without marking a defect", async () => {
    const call = await toolCallEvent(undefined);
    expect(call.input).toEqual({});
    expect(call.invalidInput).toBeUndefined();
  });

  // A no-argument call is how a zero-parameter tool is invoked. Answering it
  // with a parse error would break a working call, so blank argument text has
  // to read the same as no argument text — which is how the SDK reads it too.
  it.each([
    ["", "empty"],
    ["   ", "spaces"],
    ["\n\t", "blank lines"],
  ])("reads %j (%s) as a no-argument call, not a parse failure", async (input) => {
    const call = await toolCallEvent(input);
    expect(call.input).toEqual({});
    expect(call.invalidInput).toBeUndefined();
  });
});

describe("genericToModelMessages — tool-call input never leaves as a non-object", () => {
  function assistantWithToolCall(input: unknown): GenericMessage[] {
    return [
      { role: "user", content: "run it" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "tu-1", name: "bash", input } as unknown as ToolCallBlock],
      },
    ];
  }

  function toolCallPart(input: unknown): { type: string; input: unknown } {
    const out = genericToModelMessages(assistantWithToolCall(input), "openai");
    const parts = (out[1] as { content: Array<{ type: string; input: unknown }> }).content;
    const part = parts.find((p) => p.type === "tool-call");
    expect(part).toBeDefined();
    return part!;
  }

  it("sends a persisted string input as an empty object", () => {
    const part = toolCallPart('{"command":"echo hel');
    // Strict: a string here is what the provider rejects the whole request over.
    expect(typeof part.input).toBe("object");
    expect(part.input).toEqual({});
  });

  it("leaves a well-formed object input byte-identical", () => {
    const input = { command: "ls" };
    expect(toolCallPart(input).input).toBe(input);
  });
});
