/**
 * Snapshot tests for VercelUnifiedProvider — azure-foundry slot.
 *
 * Azure AI Foundry exposes an OpenAI-compatible surface. We route through
 * createOpenAICompatible with the user-supplied deployment endpoint baseURL.
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
  it("requires baseUrl and routes through createOpenAICompatible with azure-foundry name", async () => {
    vi.resetModules();
    const modelFactory = vi.fn(() => ({ __mock: "azure" }));
    const createCompatSpy = vi.fn(() => modelFactory);

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
    vi.doMock("@ai-sdk/openai-compatible", () => ({
      createOpenAICompatible: createCompatSpy,
    }));

    const { VercelUnifiedProvider } = await import("../adapter.js");
    const endpoint =
      "https://myresource.openai.azure.com/openai/deployments/gpt-4o/";
    const provider = new VercelUnifiedProvider(
      "azure-foundry",
      "azure-key",
      endpoint,
    );

    const events = await collect(
      provider.streamTurn({
        model: "gpt-4o",
        systemPrompt: "sys",
        messages: [{ role: "user", content: "hi" }],
      }),
    );

    expect(createCompatSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "azure-foundry",
        baseURL: endpoint,
        apiKey: "azure-key",
      }),
    );
    expect(modelFactory).toHaveBeenCalledWith("gpt-4o");
    expect(events.at(-1)?.type).toBe("message_complete");

    vi.doUnmock("ai");
    vi.doUnmock("@ai-sdk/openai-compatible");
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
});
