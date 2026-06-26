/**
 * L1–L3 snapshot parity tests for VercelUnifiedProvider (OpenAI + Copilot paths).
 *
 * Per docs/references/vercel-ai-sdk-migration.md §11:
 *   L1 — Structural: StreamEvent type sequence matches expectation
 *   L2 — Content:    concatenated text_delta + reasoning_delta matches
 *   L3 — Tool:       tool_call payload (id/name/input) matches
 *
 * Also exercises:
 *   - Reasoning-effort mapping (4 cases).
 *   - Copilot tool-turn reasoning_effort drop guard (Chat Completions 400 fix).
 *   - OpenAI gpt-5.x → /v1/responses routing (Responses API).
 */
import { describe, it, expect, vi } from "vitest";
import { collectStreamEvents as collect } from "./test-helpers.js";
import type { StreamEvent } from "../../types.js";
import { mapReasoningEffort, isOpenAIReasoningModel } from "../adapter.js";
import { TOOL_SEARCH_TOOL_NAME } from "../../../../tools/registry.js";


describe("VercelUnifiedProvider openai — reasoning_effort mapping", () => {
  it("maps 4 budget bands: none / low / medium / high", () => {
    expect(mapReasoningEffort(500)).toBe("none");
    expect(mapReasoningEffort(100)).toBe("none");
    expect(mapReasoningEffort(2000)).toBe("low");
    expect(mapReasoningEffort(3000)).toBe("low");
    expect(mapReasoningEffort(5000)).toBe("medium");
    expect(mapReasoningEffort(7999)).toBe("medium");
    expect(mapReasoningEffort(8000)).toBe("medium");
    expect(mapReasoningEffort(8001)).toBe("high");
    expect(mapReasoningEffort(32_000)).toBe("high");
  });

  it("detects OpenAI reasoning-model families", () => {
    expect(isOpenAIReasoningModel("gpt-5.4-mini")).toBe(true);
    expect(isOpenAIReasoningModel("gpt-5")).toBe(true);
    expect(isOpenAIReasoningModel("o1")).toBe(true);
    expect(isOpenAIReasoningModel("o3-mini")).toBe(true);
    expect(isOpenAIReasoningModel("o4-mini")).toBe(true);
    expect(isOpenAIReasoningModel("gpt-4.1")).toBe(false);
    expect(isOpenAIReasoningModel("gpt-4o")).toBe(false);
  });
});

describe("VercelUnifiedProvider openai — L1/L2/L3 (mocked streamText)", () => {
  it("vanilla gpt-5.4-mini turn: text_delta sequence + message_complete", async () => {
    vi.resetModules();
    vi.doMock("ai", async () => {
      const actual = await vi.importActual<typeof import("ai")>("ai");
      return {
        ...actual,
        streamText: vi.fn(() => ({
          fullStream: (async function* () {
            yield { type: "text-delta", id: "t1", text: "hello " };
            yield { type: "text-delta", id: "t1", text: "world" };
            yield {
              type: "finish",
              finishReason: "stop",
              totalUsage: { inputTokens: 3, outputTokens: 2 },
            };
          })(),
        })),
      };
    });
    vi.doMock("@ai-sdk/openai", () => ({
      createOpenAI: () => {
        const mk = () => ({ __mock: true });
        return {
          responses: mk,
          chat: mk,
        };
      },
    }));

    const { VercelUnifiedProvider } = await import("../adapter.js");
    const provider = new VercelUnifiedProvider("openai", "test-key");

    const events = await collect(
      provider.streamTurn({
        model: "gpt-5.4-mini",
        systemPrompt: "sys",
        messages: [{ role: "user", content: "hi" }],
      }),
    );

    expect(events.map((e) => e.type)).toEqual([
      "text_delta",
      "text_delta",
      "message_complete",
    ]);

    const text = events
      .filter(
        (e): e is Extract<StreamEvent, { type: "text_delta" }> =>
          e.type === "text_delta",
      )
      .map((e) => e.text)
      .join("");
    expect(text).toBe("hello world");

    vi.doUnmock("ai");
    vi.doUnmock("@ai-sdk/openai");
  });

  it("tool turn on gpt-5.4-mini goes through Responses API (.responses())", async () => {
    vi.resetModules();
    const responsesSpy = vi.fn(() => ({ __mock: "responses" }));
    const chatSpy = vi.fn(() => ({ __mock: "chat" }));

    vi.doMock("ai", async () => {
      const actual = await vi.importActual<typeof import("ai")>("ai");
      return {
        ...actual,
        streamText: vi.fn(() => ({
          fullStream: (async function* () {
            yield {
              type: "tool-call",
              toolCallId: "call_1",
              toolName: "index_scan",
              input: { q: "foo" },
            };
            yield {
              type: "finish",
              finishReason: "tool-calls",
              totalUsage: { inputTokens: 1, outputTokens: 1 },
            };
          })(),
        })),
      };
    });
    vi.doMock("@ai-sdk/openai", () => ({
      createOpenAI: () => ({
        responses: responsesSpy,
        chat: chatSpy,
      }),
    }));

    const { VercelUnifiedProvider } = await import("../adapter.js");
    const provider = new VercelUnifiedProvider("openai", "test-key");

    const events = await collect(
      provider.streamTurn({
        model: "gpt-5.4-mini",
        systemPrompt: "sys",
        messages: [{ role: "user", content: "use tool" }],
        tools: [
          {
            name: "index_scan",
            description: "scan",
            inputSchema: {
              type: "object",
              properties: { q: { type: "string" } },
            },
          },
        ],
      }),
    );

    // Route MUST be the Responses API for gpt-5.x.
    expect(responsesSpy).toHaveBeenCalledWith("gpt-5.4-mini");
    expect(chatSpy).not.toHaveBeenCalled();

    const toolEv = events.find((e) => e.type === "tool_call");
    expect(toolEv).toBeDefined();
    if (toolEv?.type === "tool_call") {
      expect(toolEv.name).toBe("index_scan");
      expect(toolEv.input).toEqual({ q: "foo" });
    }
    const finish = events.find((e) => e.type === "message_complete");
    expect(finish).toBeDefined();
    if (finish?.type === "message_complete") {
      expect(finish.stopReason).toBe("tool_use");
    }

    vi.doUnmock("ai");
    vi.doUnmock("@ai-sdk/openai");
  });

  it("aliases LVIS tool_search on OpenAI Responses wire and restores stream events", async () => {
    vi.resetModules();
    const streamTextSpy = vi.fn(() => ({
      fullStream: (async function* () {
        yield {
          type: "text-delta",
          id: "txt-1",
          text: "현재 빌트인 도구에는 `lvis",
        };
        yield {
          type: "text-delta",
          id: "txt-1",
          text: "\\_tool",
        };
        yield {
          type: "text-delta",
          id: "txt-1",
          text: "_search` 가 있습니다.",
        };
        yield {
          type: "tool-call",
          toolCallId: "tu-2",
          toolName: "lvis_tool_search",
          input: { query: "index_scan_status" },
        };
        yield {
          type: "finish",
          finishReason: "tool-calls",
          totalUsage: { inputTokens: 1, outputTokens: 1 },
        };
      })(),
    }));

    vi.doMock("ai", async () => {
      const actual = await vi.importActual<typeof import("ai")>("ai");
      return { ...actual, streamText: streamTextSpy };
    });
    vi.doMock("@ai-sdk/openai", () => ({
      createOpenAI: () => ({
        responses: vi.fn(() => ({ __mock: "responses" })),
        chat: vi.fn(() => ({ __mock: "chat" })),
      }),
    }));

    const { VercelUnifiedProvider } = await import("../adapter.js");
    const provider = new VercelUnifiedProvider("openai", "test-key");

    const events = await collect(
      provider.streamTurn({
        model: "gpt-5.4-mini",
        systemPrompt: "call tool_search({ query }) when needed",
        messages: [
          { role: "user", content: "로컬 인덱서 확인해보자" },
          {
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "tu-0",
                name: "request_plugin",
                input: { pluginId: "local-indexer" },
              },
            ],
          },
          {
            role: "tool_result",
            toolUseId: "tu-0",
            toolName: "request_plugin",
            content: "local-indexer 카탈로그가 활성화되었습니다.",
          },
          {
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "tu-1",
                name: TOOL_SEARCH_TOOL_NAME,
                input: { query: "index_scan_status" },
              },
            ],
          },
          {
            role: "tool_result",
            toolUseId: "tu-1",
            toolName: TOOL_SEARCH_TOOL_NAME,
            content: "필요한 도구는 lvis_tool_search 로 로드하세요.",
          },
        ],
        tools: [
          {
            name: TOOL_SEARCH_TOOL_NAME,
            description: "도구 검색",
            inputSchema: {
              type: "object",
              required: ["query"],
              properties: { query: { type: "string" } },
            },
          },
        ],
      }),
    );

    const callArg = streamTextSpy.mock.calls[0]![0] as {
      system?: string;
      tools?: Record<string, unknown>;
      messages?: Array<{ role: string; content: unknown[] }>;
    };
    expect(callArg.system).toBe("call tool_search({ query }) when needed");
    expect(Object.keys(callArg.tools ?? {})).toEqual(["lvis_tool_search"]);
    expect(callArg.messages?.[1]).toMatchObject({
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "tu-0",
          toolName: "request_plugin",
          input: { pluginId: "local-indexer" },
        },
      ],
    });
    expect(callArg.messages?.[2]).toMatchObject({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "tu-0",
          toolName: "request_plugin",
          output: {
            type: "text",
            value: "local-indexer 카탈로그가 활성화되었습니다.",
          },
        },
      ],
    });
    expect(callArg.messages?.[3]).toMatchObject({
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "tu-1",
          toolName: "lvis_tool_search",
          input: { query: "index_scan_status" },
        },
      ],
    });
    expect(callArg.messages?.[4]).toMatchObject({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "tu-1",
          toolName: "lvis_tool_search",
          output: {
            type: "text",
            value: "필요한 도구는 tool_search 로 로드하세요.",
          },
        },
      ],
    });

    expect(events
      .filter((event): event is Extract<StreamEvent, { type: "text_delta" }> =>
        event.type === "text_delta")
      .map((event) => event.text)
      .join("")).toBe("현재 빌트인 도구에는 `tool_search` 가 있습니다.");
    const toolEv = events.find((event) => event.type === "tool_call");
    expect(toolEv).toMatchObject({
      type: "tool_call",
      id: "tu-2",
      name: TOOL_SEARCH_TOOL_NAME,
      input: { query: "index_scan_status" },
    });

    vi.doUnmock("ai");
    vi.doUnmock("@ai-sdk/openai");
  });

  it("legacy gpt-4.1 goes through Chat Completions (.chat())", async () => {
    vi.resetModules();
    const responsesSpy = vi.fn(() => ({ __mock: "responses" }));
    const chatSpy = vi.fn(() => ({ __mock: "chat" }));

    vi.doMock("ai", async () => {
      const actual = await vi.importActual<typeof import("ai")>("ai");
      return {
        ...actual,
        streamText: vi.fn(() => ({
          fullStream: (async function* () {
            yield { type: "text-delta", id: "t1", text: "ok" };
            yield {
              type: "finish",
              finishReason: "stop",
              totalUsage: { inputTokens: 1, outputTokens: 1 },
            };
          })(),
        })),
      };
    });
    vi.doMock("@ai-sdk/openai", () => ({
      createOpenAI: () => ({
        responses: responsesSpy,
        chat: chatSpy,
      }),
    }));

    const { VercelUnifiedProvider } = await import("../adapter.js");
    const provider = new VercelUnifiedProvider("openai", "test-key");

    await collect(
      provider.streamTurn({
        model: "gpt-4.1",
        systemPrompt: "sys",
        messages: [{ role: "user", content: "hi" }],
      }),
    );

    expect(chatSpy).toHaveBeenCalledWith("gpt-4.1");
    expect(responsesSpy).not.toHaveBeenCalled();

    vi.doUnmock("ai");
    vi.doUnmock("@ai-sdk/openai");
  });
});

describe("VercelUnifiedProvider copilot — L1/L2/L3 (mocked streamText)", () => {
  it("reasoning_effort is dropped on tool turns with gpt-5.x (legacy 400 guard)", async () => {
    vi.resetModules();
    const streamTextSpy = vi.fn(() => ({
      fullStream: (async function* () {
        yield {
          type: "tool-call",
          toolCallId: "c1",
          toolName: "t",
          input: {},
        };
        yield {
          type: "finish",
          finishReason: "tool-calls",
          totalUsage: { inputTokens: 1, outputTokens: 1 },
        };
      })(),
    }));

    vi.doMock("ai", async () => {
      const actual = await vi.importActual<typeof import("ai")>("ai");
      return { ...actual, streamText: streamTextSpy };
    });
    vi.doMock("@ai-sdk/openai", () => ({
      createOpenAI: () => ({
        responses: vi.fn(() => ({ __mock: "responses" })),
        chat: vi.fn(() => ({ __mock: "chat" })),
      }),
    }));

    const { VercelUnifiedProvider } = await import("../adapter.js");
    const provider = new VercelUnifiedProvider("copilot", "test-key");

    await collect(
      provider.streamTurn({
        model: "gpt-5-mini",
        systemPrompt: "sys",
        messages: [{ role: "user", content: "hi" }],
        enableThinking: true,
        thinkingBudgetTokens: 10_000,
        tools: [
          {
            name: "t",
            description: "t",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      }),
    );

    expect(streamTextSpy).toHaveBeenCalledOnce();
    const callArg = streamTextSpy.mock.calls[0]![0] as Record<string, unknown>;
    // reasoning_effort MUST be absent on Copilot+tools+gpt-5.x
    expect(callArg.providerOptions).toBeUndefined();

    vi.doUnmock("ai");
    vi.doUnmock("@ai-sdk/openai");
  });

  it("reasoning_effort IS passed on non-tool Copilot turns with gpt-5.x", async () => {
    vi.resetModules();
    const streamTextSpy = vi.fn(() => ({
      fullStream: (async function* () {
        yield { type: "text-delta", id: "t1", text: "ok" };
        yield {
          type: "finish",
          finishReason: "stop",
          totalUsage: { inputTokens: 1, outputTokens: 1 },
        };
      })(),
    }));

    vi.doMock("ai", async () => {
      const actual = await vi.importActual<typeof import("ai")>("ai");
      return { ...actual, streamText: streamTextSpy };
    });
    vi.doMock("@ai-sdk/openai", () => ({
      createOpenAI: () => ({
        responses: vi.fn(() => ({ __mock: "responses" })),
        chat: vi.fn(() => ({ __mock: "chat" })),
      }),
    }));

    const { VercelUnifiedProvider } = await import("../adapter.js");
    const provider = new VercelUnifiedProvider("copilot", "test-key");

    await collect(
      provider.streamTurn({
        model: "gpt-5-mini",
        systemPrompt: "sys",
        messages: [{ role: "user", content: "hi" }],
        enableThinking: true,
        thinkingBudgetTokens: 10_000,
      }),
    );

    const callArg = streamTextSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(callArg.providerOptions).toEqual({
      openai: { reasoningEffort: "high", reasoningSummary: "detailed" },
    });

    vi.doUnmock("ai");
    vi.doUnmock("@ai-sdk/openai");
  });

  it("OpenAI Responses API keeps reasoning_effort on tool turns (no legacy guard)", async () => {
    vi.resetModules();
    const streamTextSpy = vi.fn(() => ({
      fullStream: (async function* () {
        yield {
          type: "tool-call",
          toolCallId: "c1",
          toolName: "t",
          input: {},
        };
        yield {
          type: "finish",
          finishReason: "tool-calls",
          totalUsage: { inputTokens: 1, outputTokens: 1 },
        };
      })(),
    }));

    vi.doMock("ai", async () => {
      const actual = await vi.importActual<typeof import("ai")>("ai");
      return { ...actual, streamText: streamTextSpy };
    });
    vi.doMock("@ai-sdk/openai", () => ({
      createOpenAI: () => ({
        responses: vi.fn(() => ({ __mock: "responses" })),
        chat: vi.fn(() => ({ __mock: "chat" })),
      }),
    }));

    const { VercelUnifiedProvider } = await import("../adapter.js");
    const provider = new VercelUnifiedProvider("openai", "test-key");

    await collect(
      provider.streamTurn({
        model: "gpt-5.4-mini",
        systemPrompt: "sys",
        messages: [{ role: "user", content: "hi" }],
        enableThinking: true,
        thinkingBudgetTokens: 10_000,
        tools: [
          {
            name: "t",
            description: "t",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      }),
    );

    const callArg = streamTextSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(callArg.providerOptions).toEqual({
      openai: { reasoningEffort: "high", reasoningSummary: "detailed" },
    });

    vi.doUnmock("ai");
    vi.doUnmock("@ai-sdk/openai");
  });
});

describe("VercelUnifiedProvider openai-compatible", () => {
  it("requires baseUrl and routes through createOpenAICompatible", async () => {
    vi.resetModules();
    const compatFactory = vi.fn(() => ({ __mock: "compat" }));
    const createCompatSpy = vi.fn(() => compatFactory);

    vi.doMock("ai", async () => {
      const actual = await vi.importActual<typeof import("ai")>("ai");
      return {
        ...actual,
        streamText: vi.fn(() => ({
          fullStream: (async function* () {
            yield { type: "text-delta", id: "t1", text: "ok" };
            yield {
              type: "finish",
              finishReason: "stop",
              totalUsage: { inputTokens: 1, outputTokens: 1 },
            };
          })(),
        })),
      };
    });
    vi.doMock("@ai-sdk/openai-compatible", () => ({
      createOpenAICompatible: createCompatSpy,
    }));

    const { VercelUnifiedProvider } = await import("../adapter.js");
    const provider = new VercelUnifiedProvider(
      "openai-compatible",
      "k",
      "https://example.test/v1",
    );

    const events = await collect(
      provider.streamTurn({
        model: "custom-model-1",
        systemPrompt: "sys",
        messages: [{ role: "user", content: "hi" }],
      }),
    );

    expect(createCompatSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: "https://example.test/v1",
        apiKey: "k",
        name: "lvis-compat",
      }),
    );
    expect(compatFactory).toHaveBeenCalledWith("custom-model-1");
    expect(events.at(-1)?.type).toBe("message_complete");

    vi.doUnmock("ai");
    vi.doUnmock("@ai-sdk/openai-compatible");
  });

  it("forwards enable_thinking per request via chat_template_kwargs (multi-user toggle)", async () => {
    vi.resetModules();
    const streamTextSpy = vi.fn(() => ({
      fullStream: (async function* () {
        yield {
          type: "finish",
          finishReason: "stop",
          totalUsage: { inputTokens: 1, outputTokens: 1 },
        };
      })(),
    }));
    vi.doMock("ai", async () => {
      const actual = await vi.importActual<typeof import("ai")>("ai");
      return { ...actual, streamText: streamTextSpy };
    });
    vi.doMock("@ai-sdk/openai-compatible", () => ({
      createOpenAICompatible: vi.fn(() => vi.fn(() => ({ __mock: "compat" }))),
    }));

    const { VercelUnifiedProvider } = await import("../adapter.js");
    const provider = new VercelUnifiedProvider(
      "openai-compatible",
      "k",
      "https://example.test/v1",
    );

    // The flag travels in each request body, so two concurrent users with
    // opposite settings hit the same stateless server without interfering.
    for (const enableThinking of [true, false]) {
      streamTextSpy.mockClear();
      await collect(
        provider.streamTurn({
          model: "qwen3.6",
          systemPrompt: "sys",
          messages: [{ role: "user", content: "hi" }],
          enableThinking,
        }),
      );
      expect(streamTextSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          providerOptions: expect.objectContaining({
            "lvis-compat": {
              chat_template_kwargs: { enable_thinking: enableThinking },
            },
          }),
        }),
      );
    }

    vi.doUnmock("ai");
    vi.doUnmock("@ai-sdk/openai-compatible");
  });
});

describe("VercelUnifiedProvider openai — custom baseUrl proxy guard", () => {
  it("drops reasoning_effort on tool turns for gpt-5.x when custom baseUrl is set", async () => {
    vi.resetModules();
    const streamTextSpy = vi.fn(() => ({
      fullStream: (async function* () {
        yield {
          type: "tool-call",
          toolCallId: "c1",
          toolName: "t",
          input: {},
        };
        yield {
          type: "finish",
          finishReason: "tool-calls",
          totalUsage: { inputTokens: 1, outputTokens: 1 },
        };
      })(),
    }));

    vi.doMock("ai", async () => {
      const actual = await vi.importActual<typeof import("ai")>("ai");
      return { ...actual, streamText: streamTextSpy };
    });
    vi.doMock("@ai-sdk/openai", () => ({
      createOpenAI: () => ({
        responses: vi.fn(() => ({ __mock: "responses" })),
        chat: vi.fn(() => ({ __mock: "chat" })),
      }),
    }));

    const { VercelUnifiedProvider } = await import("../adapter.js");
    const provider = new VercelUnifiedProvider(
      "openai",
      "test-key",
      "https://proxy.example/v1",
    );

    await collect(
      provider.streamTurn({
        model: "gpt-5.4-mini",
        systemPrompt: "sys",
        messages: [{ role: "user", content: "hi" }],
        enableThinking: true,
        thinkingBudgetTokens: 10_000,
        tools: [
          {
            name: "t",
            description: "t",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      }),
    );

    const callArg = streamTextSpy.mock.calls[0]![0] as Record<string, unknown>;
    // Custom baseUrl proxy may not support Responses API — treat as Chat-only.
    expect(callArg.providerOptions).toBeUndefined();

    vi.doUnmock("ai");
    vi.doUnmock("@ai-sdk/openai");
  });
});

describe("VercelUnifiedProvider — sampling params removed (CTRL simplification)", () => {
  // PR #342 (CTRL) removed temperature / seed / maxOutputTokens from
  // LLMVendorSettings and StreamTurnParams. Modern frontier models (GPT-5+,
  // Claude 4+) deprecate fine-grained sampling — vendor SDK defaults govern.
  // These tests lock down the removal: the streamText call MUST NOT carry
  // temperature or seed for ANY vendor/model combination, so re-introduction
  // would surface here immediately.
  const runAndCaptureStreamTextArgs = async (
    vendor: "openai" | "copilot",
    model: string,
  ): Promise<Record<string, unknown>> => {
    vi.resetModules();
    const streamTextSpy = vi.fn(() => ({
      fullStream: (async function* () {
        yield { type: "text-delta", id: "t1", text: "ok" };
        yield {
          type: "finish",
          finishReason: "stop",
          totalUsage: { inputTokens: 1, outputTokens: 1 },
        };
      })(),
    }));
    vi.doMock("ai", async () => {
      const actual = await vi.importActual<typeof import("ai")>("ai");
      return { ...actual, streamText: streamTextSpy };
    });
    vi.doMock("@ai-sdk/openai", () => ({
      createOpenAI: () => ({
        responses: vi.fn(() => ({ __mock: "responses" })),
        chat: vi.fn(() => ({ __mock: "chat" })),
      }),
    }));

    const { VercelUnifiedProvider } = await import("../adapter.js");
    const provider = new VercelUnifiedProvider(vendor, "test-key");

    await collect(
      provider.streamTurn({
        model,
        systemPrompt: "sys",
        messages: [{ role: "user", content: "hi" }],
      }),
    );

    const callArg = streamTextSpy.mock.calls[0]![0] as Record<string, unknown>;
    vi.doUnmock("ai");
    vi.doUnmock("@ai-sdk/openai");
    return callArg;
  };

  it("OpenAI + reasoning model (gpt-5.4-mini): no temperature/seed in request", async () => {
    const args = await runAndCaptureStreamTextArgs("openai", "gpt-5.4-mini");
    expect("temperature" in args).toBe(false);
    expect("seed" in args).toBe(false);
  });

  it("OpenAI + reasoning model (o3-mini): no temperature/seed in request", async () => {
    const args = await runAndCaptureStreamTextArgs("openai", "o3-mini");
    expect("temperature" in args).toBe(false);
    expect("seed" in args).toBe(false);
  });

  it("OpenAI + non-reasoning model (gpt-4.1): no temperature/seed in request", async () => {
    const args = await runAndCaptureStreamTextArgs("openai", "gpt-4.1");
    expect("temperature" in args).toBe(false);
    expect("seed" in args).toBe(false);
  });

  it("Copilot + gpt-5 (Chat Completions): no temperature/seed in request", async () => {
    // Pre-CTRL behaviour forwarded sampling controls on the Copilot Chat
    // Completions path. Post-CTRL the fields are gone from StreamTurnParams,
    // so they MUST be absent regardless of route.
    const args = await runAndCaptureStreamTextArgs("copilot", "gpt-5-mini");
    expect("temperature" in args).toBe(false);
    expect("seed" in args).toBe(false);
  });
});

// Claude path now implemented — see snapshot-claude.test.ts for full coverage.
