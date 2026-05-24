/**
 * Snapshot tests for VercelUnifiedProvider — azure-foundry slot.
 *
 * Azure AI Foundry exposes OpenAI v1 Responses API. We route through
 * @ai-sdk/azure so reasoning summaries can stream as reasoning-delta events.
 */
import { describe, it, expect, vi } from "vitest";
import { collectStreamEvents as collect } from "./test-helpers.js";
import { TOOL_SEARCH_TOOL_NAME } from "../../../../tools/registry.js";


describe("VercelUnifiedProvider azure-foundry", () => {
  it("normalizes Azure endpoints and routes through @ai-sdk/azure Responses API", async () => {
    vi.resetModules();
    const responsesSpy = vi.fn(() => ({ __mock: "azure-responses" }));
    const createAzureSpy = vi.fn(() => ({ responses: responsesSpy }));

    vi.doMock("ai", async () => {
      const actual = await vi.importActual<typeof import("ai")>("ai");
      return {
        ...actual,
        streamText: vi.fn(() => ({
          fullStream: (async function* () {
            yield { type: "text-delta", id: "t1", text: "hi" };
            yield {
              type: "finish",
              finishReason: "stop",
              totalUsage: { inputTokens: 1, outputTokens: 1 },
            };
          })(),
        })),
      };
    });
    vi.doMock("@ai-sdk/azure", () => ({
      createAzure: createAzureSpy,
    }));

    const { VercelUnifiedProvider } = await import("../adapter.js");
    const endpoint =
      "https://myresource.openai.azure.com/openai/deployments/gpt-5.4-mini/chat/completions?api-version=2025-01-01-preview";
    const provider = new VercelUnifiedProvider(
      "azure-foundry",
      "azure-key",
      endpoint,
    );

    const events = await collect(
      provider.streamTurn({
        model: "gpt-5.4-mini",
        systemPrompt: "sys",
        messages: [{ role: "user", content: "hi" }],
      }),
    );

    expect(createAzureSpy).toHaveBeenCalledWith({
      baseURL: "https://myresource.openai.azure.com/openai",
      apiKey: "azure-key",
    });
    expect(responsesSpy).toHaveBeenCalledWith("gpt-5.4-mini");
    expect(events.at(-1)?.type).toBe("message_complete");

    vi.doUnmock("ai");
    vi.doUnmock("@ai-sdk/azure");
  });

  it("passes Azure reasoning options when thinking is enabled", async () => {
    vi.resetModules();
    const streamTextSpy = vi.fn(() => ({
      fullStream: (async function* () {
        yield { type: "reasoning-start", id: "r1" };
        yield { type: "reasoning-delta", id: "r1", text: "checking" };
        yield { type: "reasoning-end", id: "r1" };
        yield { type: "text-delta", id: "t1", text: "ok" };
        yield {
          type: "finish",
          finishReason: "stop",
          totalUsage: { inputTokens: 1, outputTokens: 1 },
        };
      })(),
    }));
    const responsesSpy = vi.fn(() => ({ __mock: "azure-responses" }));
    const createAzureSpy = vi.fn(() => ({ responses: responsesSpy }));

    vi.doMock("ai", async () => {
      const actual = await vi.importActual<typeof import("ai")>("ai");
      return { ...actual, streamText: streamTextSpy };
    });
    vi.doMock("@ai-sdk/azure", () => ({
      createAzure: createAzureSpy,
    }));

    const { VercelUnifiedProvider } = await import("../adapter.js");
    const provider = new VercelUnifiedProvider(
      "azure-foundry",
      "azure-key",
      "https://myresource.openai.azure.com/openai/v1/",
    );

    const events = await collect(
      provider.streamTurn({
        model: "gpt-5.4-mini",
        systemPrompt: "sys",
        messages: [{ role: "user", content: "hi" }],
        enableThinking: true,
        thinkingBudgetTokens: 10_000,
      }),
    );

    const callArg = streamTextSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(callArg.providerOptions).toEqual({
      azure: { reasoningEffort: "high", reasoningSummary: "detailed" },
    });
    expect(events).toContainEqual({ type: "reasoning_delta", text: "checking" });

    vi.doUnmock("ai");
    vi.doUnmock("@ai-sdk/azure");
  });

  it("aliases LVIS tool_search on Azure Responses wire and restores stream events", async () => {
    vi.resetModules();
    const streamTextSpy = vi.fn(() => ({
      fullStream: (async function* () {
        yield {
          type: "reasoning-delta",
          id: "rsn-1",
          text: "lvis_tool_search 노출 여부를 확인합니다.",
        };
        yield {
          type: "text-delta",
          id: "txt-1",
          text: "현재 빌트인 도구에는 lvis_tool_search 가 있습니다.",
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
    const responsesSpy = vi.fn(() => ({ __mock: "azure-responses" }));
    const createAzureSpy = vi.fn(() => ({ responses: responsesSpy }));

    vi.doMock("ai", async () => {
      const actual = await vi.importActual<typeof import("ai")>("ai");
      return { ...actual, streamText: streamTextSpy };
    });
    vi.doMock("@ai-sdk/azure", () => ({
      createAzure: createAzureSpy,
    }));

    const { VercelUnifiedProvider } = await import("../adapter.js");
    const provider = new VercelUnifiedProvider(
      "azure-foundry",
      "azure-key",
      "https://myresource.openai.azure.com/openai/v1/",
    );

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
            content: "필요한 도구는 tool_search 로 로드하세요.",
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
    expect(callArg.system).toBe("call lvis_tool_search({ query }) when needed");
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
            value: "필요한 도구는 lvis_tool_search 로 로드하세요.",
          },
        },
      ],
    });
    expect(events).toContainEqual({
      type: "reasoning_delta",
      text: "tool_search 노출 여부를 확인합니다.",
    });
    expect(events).toContainEqual({
      type: "text_delta",
      text: "현재 빌트인 도구에는 tool_search 가 있습니다.",
    });
    expect(events.find((event) => event.type === "tool_call")).toMatchObject({
      type: "tool_call",
      id: "tu-2",
      name: TOOL_SEARCH_TOOL_NAME,
      input: { query: "index_scan_status" },
    });

    vi.doUnmock("ai");
    vi.doUnmock("@ai-sdk/azure");
  });

  it("throws without baseUrl", async () => {
    vi.resetModules();
    vi.doMock("ai", async () => {
      const actual = await vi.importActual<typeof import("ai")>("ai");
      return { ...actual, streamText: vi.fn() };
    });

    const { VercelUnifiedProvider } = await import("../adapter.js");
    const provider = new VercelUnifiedProvider("azure-foundry", "k");

    const events = await collect(
      provider.streamTurn({
        model: "gpt-4o",
        systemPrompt: "sys",
        messages: [{ role: "user", content: "hi" }],
      }),
    );

    // Missing baseUrl surfaces as a mapped stream error (no sync throw).
    expect(events.some((e) => e.type === "error")).toBe(true);

    vi.doUnmock("ai");
  });

  it("is vercel-routed via factory", async () => {
    vi.resetModules();
    const { createProvider } = await import("../../provider-factory.js");
    const p = createProvider({
      vendor: "azure-foundry",
      apiKey: "k",
      baseUrl: "https://example.openai.azure.com/openai/deployments/x/",
    });
    // PR #705: factory returns a lazy proxy that defers the Vercel adapter
    // module load until first `streamTurn`. The vendor surface is preserved
    // synchronously so reviewer-wiring + IPC handlers stay unchanged.
    expect(p.constructor.name).toBe("LazyVercelProvider");
    expect(p.vendor).toBe("azure-foundry");
  });

  it("normalizes documented /openai/v1 base URLs for @ai-sdk/azure", async () => {
    vi.resetModules();
    const { normalizeAzureFoundryBaseURL } = await import("../adapter.js");

    expect(
      normalizeAzureFoundryBaseURL("https://example.openai.azure.com/openai/v1/"),
    ).toBe("https://example.openai.azure.com/openai");
    expect(
      normalizeAzureFoundryBaseURL(
        "https://example.openai.azure.com/openai/deployments/gpt/chat/completions?api-version=2025-01-01-preview",
      ),
    ).toBe("https://example.openai.azure.com/openai");
    expect(
      normalizeAzureFoundryBaseURL("https://example.openai.azure.com/"),
    ).toBe("https://example.openai.azure.com/openai");
  });
});
