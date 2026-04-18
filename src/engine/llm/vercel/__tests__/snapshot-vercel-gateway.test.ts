/**
 * Snapshot tests for VercelUnifiedProvider — vercel-gateway slot.
 *
 * Vercel AI Gateway is an OpenAI-compatible fan-out endpoint. Model IDs use
 * `{provider}/{model}` form. We route through createOpenAICompatible with the
 * gateway baseURL (default `https://ai-gateway.vercel.sh/v1`).
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

describe("VercelUnifiedProvider vercel-gateway", () => {
  it("uses default gateway baseURL and routes through createOpenAICompatible", async () => {
    vi.resetModules();
    const modelFactory = vi.fn(() => ({ __mock: "gateway" }));
    const createCompatSpy = vi.fn(() => modelFactory);

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
    const provider = new VercelUnifiedProvider("vercel-gateway", "gw-key");

    const events = await collect(
      provider.streamTurn({
        model: "openai/gpt-4o",
        systemPrompt: "sys",
        messages: [{ role: "user", content: "hi" }],
      }),
    );

    expect(createCompatSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "vercel-gateway",
        baseURL: "https://ai-gateway.vercel.sh/v1",
        apiKey: "gw-key",
      }),
    );
    expect(modelFactory).toHaveBeenCalledWith("openai/gpt-4o");
    expect(events.at(-1)?.type).toBe("message_complete");

    vi.doUnmock("ai");
    vi.doUnmock("@ai-sdk/openai-compatible");
  });

  it("honors custom baseUrl override", async () => {
    vi.resetModules();
    const createCompatSpy = vi.fn(() => vi.fn(() => ({ __mock: "gw" })));

    vi.doMock("ai", async () => {
      const actual = await vi.importActual<typeof import("ai")>("ai");
      return {
        ...actual,
        streamText: vi.fn(() => ({
          fullStream: (async function* () {
            yield {
              type: "finish",
              finishReason: "stop",
              totalUsage: { inputTokens: 0, outputTokens: 0 },
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
      "vercel-gateway",
      "gw-key",
      "https://custom.gateway.example/v1",
    );

    await collect(
      provider.streamTurn({
        model: "anthropic/claude-3.5",
        systemPrompt: "sys",
        messages: [{ role: "user", content: "hi" }],
      }),
    );

    expect(createCompatSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: "https://custom.gateway.example/v1",
      }),
    );

    vi.doUnmock("ai");
    vi.doUnmock("@ai-sdk/openai-compatible");
  });

  it("is vercel-routed via factory regardless of useVercelSdk flag", async () => {
    vi.resetModules();
    const { createProvider } = await import("../../provider-factory.js");
    const p = createProvider(
      { vendor: "vercel-gateway", apiKey: "k" },
      { useVercelSdk: "none" },
    );
    expect(p.constructor.name).toBe("VercelUnifiedProvider");
  });
});
