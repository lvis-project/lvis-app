/**
 * Snapshot tests for VercelUnifiedProvider — azure-foundry slot.
 *
 * Azure AI Foundry exposes OpenAI v1 Responses API. We route through
 * @ai-sdk/azure so reasoning summaries can stream as reasoning-delta events.
 */
import { describe, it, expect, vi } from "vitest";
import type { StreamEvent } from "../../types.js";

async function collect(
  iter: AsyncIterable<StreamEvent>,
): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

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
