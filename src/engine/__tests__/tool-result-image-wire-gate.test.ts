/**
 * Tool-result images must reach the model on every API-key route. Native
 * multimodal tool-output routes keep the image in the tool result; Chat
 * Completions routes append a host-origin user image after that result group.
 */
import { describe, expect, it, vi } from "vitest";

import type { GenericMessage, LLMVendor, ToolSchema } from "../llm/types.js";
import { estimateMessagesTokens } from "../auto-compact.js";
import { genericToModelMessages, VercelUnifiedProvider } from "../llm/vercel/adapter.js";
import { estimateRequestInputProjection } from "../request-input-projection.js";
import { prepareMarkedToolResultsForWire } from "../wire-serialize.js";

const IMAGE_ROW: GenericMessage = {
  role: "tool_result",
  toolUseId: "tu-image",
  toolName: "view_image",
  content: "[image loaded]",
  image: { data: "QUJD", mimeType: "image/png" },
};

const PLACEHOLDER_ROW: GenericMessage = {
  role: "tool_result",
  toolUseId: "tu-image",
  toolName: "view_image",
  content: "[image loaded]",
};

const NO_SCHEMAS: ToolSchema[] = [];
const NATIVE_IMAGE_VENDORS: LLMVendor[] = ["claude"];
const DERIVED_GOOGLE_IMAGE_VENDORS: LLMVendor[] = ["gemini", "vertex-ai"];

describe("tool_result image wire gate — native and derived routes", () => {
  it.each(NATIVE_IMAGE_VENDORS)("keeps the image in the native tool result on %s", (vendor) => {
    const [mapped] = genericToModelMessages([IMAGE_ROW], vendor);
    expect(mapped).toMatchObject({
      role: "tool",
      content: [{ output: { type: "content", value: expect.arrayContaining([
        expect.objectContaining({ type: "file", mediaType: "image/png" }),
      ]) } }],
    });
  });

  it.each(DERIVED_GOOGLE_IMAGE_VENDORS)("uses the model-independent derived image route on %s", (vendor) => {
    const mapped = genericToModelMessages([IMAGE_ROW], vendor);
    expect(mapped.map((message) => message.role)).toEqual(["tool", "user"]);
    expect(mapped[0]).toMatchObject({ content: [{ output: { type: "text", value: "[image loaded]" } }] });
    expect(mapped[1]).toMatchObject({ content: [{ type: "text" }, { type: "file", data: "QUJD" }] });
  });

  it("puts a Chat-route image after every paired tool result with explicit provenance", () => {
    const mapped = genericToModelMessages([
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "image-call", name: "view_image", input: {} },
          { id: "failed-call", name: "bash", input: {} },
          { id: "second-image-call", name: "view_image", input: {} },
        ],
      },
      { ...IMAGE_ROW, toolUseId: "image-call" },
      {
        role: "tool_result",
        toolUseId: "failed-call",
        toolName: "bash",
        content: "command failed",
        isError: true,
        image: { data: "REVG", mimeType: "image/png" },
      },
      { ...IMAGE_ROW, toolUseId: "second-image-call", image: { data: "R0hJ", mimeType: "image/png" } },
    ], "openai-compatible", { toolResultImageWire: "derived-user" });

    expect(mapped.map((message) => message.role)).toEqual(["assistant", "tool", "tool", "tool", "user"]);
    const toolResults = mapped.slice(1, 4) as Array<{ content: Array<{ toolCallId: string; output: { type: string; value?: string } }> }>;
    expect(toolResults.map((message) => message.content[0]?.toolCallId)).toEqual([
      "image-call", "failed-call", "second-image-call",
    ]);
    expect(toolResults.map((message) => message.content[0]?.output)).toEqual([
      { type: "text", value: "[image loaded]" },
      { type: "error-text", value: "command failed" },
      { type: "text", value: "[image loaded]" },
    ]);

    const derived = mapped[4] as { content: Array<{ type: string; text?: string; data?: string }> };
    expect(derived.content.map((part) => part.type)).toEqual(["text", "file", "text", "file", "text", "file"]);
    expect(derived.content.filter((part) => part.type === "text").map((part) => part.text)).toEqual([
      expect.stringContaining('tool "view_image", call "image-call"'),
      expect.stringContaining('tool "bash", call "failed-call"'),
      expect.stringContaining('tool "view_image", call "second-image-call"'),
    ]);
    expect(derived.content.filter((part) => part.type === "file").map((part) => part.data)).toEqual([
      "QUJD", "REVG", "R0hJ",
    ]);
  });

  it("combines a following user row with the derived image row", () => {
    const mapped = genericToModelMessages([
      IMAGE_ROW,
      { role: "user", content: "continue from the visual result" },
    ], "openai-compatible", { toolResultImageWire: "derived-user" });

    expect(mapped.map((message) => message.role)).toEqual(["tool", "user"]);
    const user = mapped[1] as { content: Array<{ type: string; text?: string }> };
    expect(user.content.at(-1)).toEqual({ type: "text", text: "continue from the visual result" });
  });

  it("waits through omitted assistant and empty user rows before combining the next nudge", () => {
    const mapped = genericToModelMessages([
      IMAGE_ROW,
      { role: "assistant", content: "", thought: "reasoning-only row" },
      { role: "user", content: [] },
      { role: "user", content: "host progress nudge" },
    ], "openai-compatible", { toolResultImageWire: "derived-user" });

    expect(mapped.map((message) => message.role)).toEqual(["tool", "user"]);
    const user = mapped[1] as { content: Array<{ type: string; text?: string }> };
    expect(user.content.at(-1)).toEqual({ type: "text", text: "host progress nudge" });
  });

  it("keeps an error result as error-text and derives its attached image", () => {
    const mapped = genericToModelMessages([{
      ...IMAGE_ROW,
      isError: true,
      content: "image decoder reported an error",
    }], "claude");

    expect(mapped).toMatchObject([
      { role: "tool", content: [{ output: { type: "error-text", value: "image decoder reported an error" } }] },
      { role: "user", content: [
        { type: "text", text: expect.stringContaining("tool's visual output") },
        { type: "file", data: "QUJD", mediaType: "image/png" },
      ] },
    ]);
  });
});

describe("tool_result image wire gate — actual request and estimates", () => {
  it("captures the OpenAI-compatible Chat body with paired results before visible image bytes", async () => {
    const customFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify({ error: { message: "synthetic endpoint response" } }),
      { status: 400, headers: { "content-type": "application/json" } },
    ));
    const provider = new VercelUnifiedProvider(
      "openai-compatible",
      "test-key",
      "https://provider.invalid/v1",
      customFetch,
    );

    for await (const _event of provider.streamTurn({
      model: "vision-model",
      systemPrompt: "",
      messages: [
        { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "view_image", input: {} }] },
        { ...IMAGE_ROW, toolUseId: "call-1" },
      ],
    })) {
      // Draining reaches the synthetic response without an external request.
    }

    expect(customFetch).toHaveBeenCalledTimes(1);
    const init = customFetch.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body)) as { messages: Array<Record<string, unknown>> };
    const toolIndex = body.messages.findIndex((message) => message.role === "tool");
    const userIndex = body.messages.findIndex((message, index) => index > toolIndex && message.role === "user");
    expect(toolIndex).toBeGreaterThanOrEqual(0);
    expect(userIndex).toBe(toolIndex + 1);
    expect(body.messages[toolIndex]).toMatchObject({ role: "tool", tool_call_id: "call-1", content: "[image loaded]" });
    const userContent = body.messages[userIndex]?.content as Array<Record<string, unknown>>;
    expect(userContent[0]).toMatchObject({ type: "text", text: expect.stringContaining('call "call-1"') });
    expect(userContent[1]).toMatchObject({ type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } });
  });

  it("captures the OpenAI Responses body with an image in function_call_output", async () => {
    const customFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify({ error: { message: "synthetic endpoint response" } }),
      { status: 400, headers: { "content-type": "application/json" } },
    ));
    const provider = new VercelUnifiedProvider("openai", "test-key", undefined, customFetch);

    for await (const _event of provider.streamTurn({
      model: "gpt-5.4-mini",
      systemPrompt: "",
      messages: [
        { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "view_image", input: {} }] },
        { ...IMAGE_ROW, toolUseId: "call-1" },
      ],
    })) {
      // Draining reaches the synthetic response without an external request.
    }

    expect(customFetch).toHaveBeenCalledTimes(1);
    const init = customFetch.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body)) as { input: Array<Record<string, unknown>> };
    const output = body.input.find((item) => item.type === "function_call_output");
    expect(output).toMatchObject({
      call_id: "call-1",
      output: [
        { type: "input_text", text: "[image loaded]" },
        { type: "input_image", image_url: "data:image/png;base64,QUJD" },
      ],
    });
  });

  it("captures the Gemini body with paired functionResponse then a derived inlineData image", async () => {
    const customFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify({ error: { message: "synthetic endpoint response" } }),
      { status: 400, headers: { "content-type": "application/json" } },
    ));
    const provider = new VercelUnifiedProvider("gemini", "test-key", undefined, customFetch);

    for await (const _event of provider.streamTurn({
      model: "gemini-2.5-flash",
      systemPrompt: "",
      messages: [
        { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "view_image", input: {} }] },
        { ...IMAGE_ROW, toolUseId: "call-1" },
      ],
    })) {
      // Draining reaches the synthetic response without an external request.
    }

    expect(customFetch).toHaveBeenCalledTimes(1);
    const init = customFetch.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body)) as { contents: Array<{ parts: Array<Record<string, unknown>> }> };
    const functionResponseIndex = body.contents.findIndex((content) =>
      content.parts.some((part) => "functionResponse" in part),
    );
    expect(functionResponseIndex).toBeGreaterThanOrEqual(0);
    const functionResponse = body.contents[functionResponseIndex]?.parts.find((part) => "functionResponse" in part)
      ?.functionResponse as Record<string, unknown>;
    expect(functionResponse).toMatchObject({
      id: "call-1",
      response: { content: "[image loaded]" },
    });
    expect(functionResponse).not.toHaveProperty("parts");
    const derivedImage = body.contents[functionResponseIndex + 1]?.parts.find((part) => "inlineData" in part)
      ?.inlineData;
    expect(derivedImage).toEqual({ mimeType: "image/png", data: "QUJD" });
  });

  it("captures the native Claude tool-result image payload", async () => {
    const customFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify({ error: { message: "synthetic endpoint response" } }),
      { status: 400, headers: { "content-type": "application/json" } },
    ));
    const provider = new VercelUnifiedProvider("claude", "test-key", undefined, customFetch);

    for await (const _event of provider.streamTurn({
      model: "claude-sonnet-4-6",
      systemPrompt: "",
      messages: [
        { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "view_image", input: {} }] },
        { ...IMAGE_ROW, toolUseId: "call-1" },
      ],
    })) {
      // Draining reaches the synthetic response without an external request.
    }

    expect(customFetch).toHaveBeenCalledTimes(1);
    const init = customFetch.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body)) as { messages: Array<{ content: Array<Record<string, unknown>> }> };
    const toolResult = body.messages.flatMap((message) => message.content).find((part) => part.type === "tool_result");
    expect(toolResult).toMatchObject({
      tool_use_id: "call-1",
      content: [
        { type: "text", text: "[image loaded]" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } },
      ],
    });
  });

  it("charges every live image route and not a compacted image stub", () => {
    for (const vendor of ["claude", "openai", "openai-compatible"] as LLMVendor[]) {
      expect(estimateMessagesTokens([IMAGE_ROW], vendor)).toBeGreaterThan(
        estimateMessagesTokens([PLACEHOLDER_ROW], vendor) + 500,
      );
    }
    const compacted = prepareMarkedToolResultsForWire([{
      ...IMAGE_ROW,
      meta: { compactedAt: "2026-09-10T00:00:00.000Z" },
    }]);
    expect(compacted[0]).not.toHaveProperty("image");
    expect(estimateMessagesTokens(compacted, "openai-compatible")).toBeGreaterThan(0);
  });

  it("keeps the input projection equal to the provider-aware message estimate", () => {
    const projection = estimateRequestInputProjection(
      { systemPrompt: "", messages: [IMAGE_ROW], toolSchemas: NO_SCHEMAS },
      { vendor: "openai-compatible" } as never,
    );
    expect(projection.messageTokens).toBe(estimateMessagesTokens([IMAGE_ROW], "openai-compatible"));
    expect(projection.totalTokens).toBe(
      projection.systemPromptTokens + projection.messageTokens + projection.toolSchemaTokens,
    );
  });
});
