import { describe, expect, it, vi } from "vitest";

const createMock = vi.fn();

vi.mock("openai", () => {
  class MockOpenAI {
    static APIError = class APIError extends Error {
      status = 500;
    };

    chat = {
      completions: {
        create: createMock,
      },
    };
  }

  return { default: MockOpenAI };
});

import { OpenAIProvider } from "../openai-provider.js";

async function collectEvents(provider: OpenAIProvider) {
  const events: Array<Record<string, unknown>> = [];
  for await (const event of provider.streamTurn({
    model: "o3-mini",
    systemPrompt: "system",
    messages: [
      {
        role: "assistant",
        content: "먼저 확인하겠습니다.",
        thought: "프로젝트 구조를 먼저 조사합니다.",
        toolCalls: [{ id: "tool-1", name: "list_directory", input: { path: "src" } }],
      },
      {
        role: "tool_result",
        toolUseId: "tool-1",
        content: "src\npackage.json",
      },
    ],
    tools: [],
    maxTokens: 64,
  })) {
    events.push(event);
  }
  return events;
}

describe("OpenAIProvider", () => {
  it("emits reasoning deltas and replays reasoning_content for reasoning models", async () => {
    createMock.mockReset();
    createMock.mockResolvedValue((async function* () {
      yield { choices: [{ delta: { reasoning_content: "구조를 먼저 봅니다." }, finish_reason: null }] };
      yield { choices: [{ delta: { content: "구조를 확인했습니다." }, finish_reason: null }] };
      yield { choices: [{ delta: {}, finish_reason: "stop" }] };
    })());

    const provider = new OpenAIProvider("test-key");
    const events = await collectEvents(provider);

    expect(events).toEqual([
      { type: "reasoning_delta", text: "구조를 먼저 봅니다." },
      { type: "text_delta", text: "구조를 확인했습니다." },
      {
        type: "message_complete",
        stopReason: "end_turn",
        usage: { inputTokens: 0, outputTokens: 0 },
      },
    ]);

    const request = createMock.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      model: "o3-mini",
      max_completion_tokens: 64,
      stream: true,
    });
    expect(request.messages[0]).toMatchObject({
      role: "developer",
      content: "system",
    });
    expect(request.messages[1]).toMatchObject({
      role: "assistant",
      content: "먼저 확인하겠습니다.",
      reasoning_content: "프로젝트 구조를 먼저 조사합니다.",
      tool_calls: [{
        id: "tool-1",
        type: "function",
        function: {
          name: "list_directory",
          arguments: JSON.stringify({ path: "src" }),
        },
      }],
    });
  });
});
