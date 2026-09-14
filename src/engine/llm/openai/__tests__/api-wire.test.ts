import { describe, expect, it, vi } from "vitest";
import { createProvider } from "../../provider-factory.js";
import { collectAsyncIterable } from "../../../../__tests__/test-helpers.js";
import { TOOL_SEARCH_TOOL_NAME } from "../../../../tools/registry.js";
import { OPENAI_RESPONSES_TOOL_SEARCH_ALIAS } from "../../../../shared/tool-name-aliases.js";

describe("common provider API wire", () => {
  it.each([
    { model: "gpt-4.1", endpoint: "/chat/completions" },
    { model: "gpt-5.4", endpoint: "/responses" },
  ])("preserves authentication, images and output controls through $endpoint", async ({ model, endpoint }) => {
    const response = endpoint === "/responses"
      ? [{ type: "response.completed", response: { usage: { input_tokens: 7, output_tokens: 2, input_tokens_details: { cached_tokens: 3 } } } }]
      : [{ id: "fixture", model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 3 } } }];
    const wireFetch = vi.fn<typeof fetch>(async () => new Response(response.map((part) => `data: ${JSON.stringify(part)}\n\n`).join(""), {
      headers: { "content-type": "text/event-stream" },
    }));
    const provider = createProvider({ vendor: "openai", apiKey: "fixture-key", fetch: wireFetch });
    const events = await collectAsyncIterable(provider.streamTurn({
      model, systemPrompt: `Use ${TOOL_SEARCH_TOOL_NAME}.`, outputTokenLimit: 3210,
      enableThinking: true, thinkingBudgetTokens: 14000,
      tools: [{ name: TOOL_SEARCH_TOOL_NAME, description: "Find governed tools.", inputSchema: { type: "object", properties: {} } }],
      messages: [
        { role: "user", content: "Inspect the image." },
        { role: "assistant", content: "", thought: "private-local", toolCalls: [{ id: "image-call", name: "inspect_image", input: {}, source: "plugin", pluginId: "private-owner" }] },
        { role: "tool_result", toolUseId: "image-call", toolName: "inspect_image", content: "Image details unavailable.", isError: true, image: { mimeType: "image/png", data: "iVBORw0KGgo=" } },
      ],
    }));
    expect(wireFetch).toHaveBeenCalledOnce();
    const [url, init] = wireFetch.mock.calls[0]!;
    expect(String(url)).toBe(`https://api.openai.com/v1${endpoint}`);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-key");
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe(model);
    expect(JSON.stringify(body)).toContain("image-call");
    expect(JSON.stringify(body)).toContain("Image details unavailable.");
    expect(JSON.stringify(body)).toContain("data:image/png;base64,iVBORw0KGgo=");
    expect(JSON.stringify(body)).not.toContain("private-local");
    expect(JSON.stringify(body)).not.toContain("private-owner");
    if (endpoint === "/responses") {
      expect(body.max_output_tokens).toBe(3210);
      expect(body.reasoning).toEqual({ effort: "high", summary: "detailed" });
      expect(body.tools).toContainEqual(expect.objectContaining({ name: OPENAI_RESPONSES_TOOL_SEARCH_ALIAS }));
    } else {
      expect(body.max_tokens).toBe(3210);
      expect(body.tools).toContainEqual(expect.objectContaining({ function: expect.objectContaining({ name: TOOL_SEARCH_TOOL_NAME }) }));
    }
    expect(events).toEqual([expect.objectContaining({
      type: "message_complete", stopReason: "end_turn", usage: expect.objectContaining({ inputTokens: 7, outputTokens: 2, cacheReadTokens: 3 }),
    })]);
    expect(events[0]).not.toHaveProperty("subscriptionUsage");
  });
});
