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
import type { StreamEvent } from "../../types.js";
import { mapReasoningEffort, isOpenAIReasoningModel } from "../adapter.js";

async function collect(
  iter: AsyncIterable<StreamEvent>,
): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

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
