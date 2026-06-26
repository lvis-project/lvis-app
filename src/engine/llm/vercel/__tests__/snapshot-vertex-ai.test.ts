/**
 * Snapshot tests for VercelUnifiedProvider — vertex-ai slot.
 *
 * Google Vertex AI is the Gemini-on-GCP surface. It requires a GCP project +
 * location (region) and authenticates via service account / ADC (no apiKey).
 * We route through `@ai-sdk/google-vertex` via `createVertex()`.
 */
import { describe, it, expect, vi } from "vitest";
import { collectStreamEvents as collect } from "./test-helpers.js";


describe("VercelUnifiedProvider vertex-ai", () => {
  it("creates the Vertex client with project + default location", async () => {
    vi.resetModules();
    const modelFactory = vi.fn(() => ({ __mock: "vertex" }));
    const createVertexSpy = vi.fn(() => modelFactory);

    vi.doMock("ai", async () => {
      const actual = await vi.importActual<typeof import("ai")>("ai");
      return {
        ...actual,
        streamText: vi.fn(() => ({
          stream: (async function* () {
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
    vi.doMock("@ai-sdk/google-vertex", () => ({
      createVertex: createVertexSpy,
    }));

    const { VercelUnifiedProvider } = await import("../adapter.js");
    const provider = new VercelUnifiedProvider(
      "vertex-ai",
      "", // apiKey unused for Vertex
      undefined,
      undefined,
      { vertexProject: "my-proj" },
    );

    const events = await collect(
      provider.streamTurn({
        model: "gemini-2.5-flash",
        systemPrompt: "sys",
        messages: [{ role: "user", content: "hi" }],
      }),
    );

    expect(createVertexSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        project: "my-proj",
        location: "us-central1",
      }),
    );
    expect(modelFactory).toHaveBeenCalledWith("gemini-2.5-flash");
    expect(events.at(-1)?.type).toBe("message_complete");

    vi.doUnmock("ai");
    vi.doUnmock("@ai-sdk/google-vertex");
  });

  it("honors custom location override", async () => {
    vi.resetModules();
    const createVertexSpy = vi.fn(() => vi.fn(() => ({ __mock: "v" })));

    vi.doMock("ai", async () => {
      const actual = await vi.importActual<typeof import("ai")>("ai");
      return {
        ...actual,
        streamText: vi.fn(() => ({
          stream: (async function* () {
            yield {
              type: "finish",
              finishReason: "stop",
              totalUsage: { inputTokens: 0, outputTokens: 0 },
            };
          })(),
        })),
      };
    });
    vi.doMock("@ai-sdk/google-vertex", () => ({
      createVertex: createVertexSpy,
    }));

    const { VercelUnifiedProvider } = await import("../adapter.js");
    const provider = new VercelUnifiedProvider(
      "vertex-ai",
      "",
      undefined,
      undefined,
      { vertexProject: "p1", vertexLocation: "europe-west4" },
    );

    await collect(
      provider.streamTurn({
        model: "gemini-2.5-pro",
        systemPrompt: "sys",
        messages: [{ role: "user", content: "hi" }],
      }),
    );

    expect(createVertexSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        project: "p1",
        location: "europe-west4",
      }),
    );

    vi.doUnmock("ai");
    vi.doUnmock("@ai-sdk/google-vertex");
  });

  it("surfaces an error when project is missing (no env, no extras)", async () => {
    vi.resetModules();
    const prev = {
      GOOGLE_CLOUD_PROJECT: process.env.GOOGLE_CLOUD_PROJECT,
      GCLOUD_PROJECT: process.env.GCLOUD_PROJECT,
    };
    delete process.env.GOOGLE_CLOUD_PROJECT;
    delete process.env.GCLOUD_PROJECT;

    vi.doMock("ai", async () => {
      const actual = await vi.importActual<typeof import("ai")>("ai");
      return {
        ...actual,
        streamText: vi.fn(() => ({
          stream: (async function* () { /* empty */ })(),
        })),
      };
    });
    vi.doMock("@ai-sdk/google-vertex", () => ({
      createVertex: vi.fn(() => vi.fn()),
    }));

    const { VercelUnifiedProvider } = await import("../adapter.js");
    const provider = new VercelUnifiedProvider("vertex-ai", "");

    const events = await collect(
      provider.streamTurn({
        model: "gemini-2.5-flash",
        systemPrompt: "sys",
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    expect(events.some((e) => e.type === "error")).toBe(true);

    if (prev.GOOGLE_CLOUD_PROJECT !== undefined) process.env.GOOGLE_CLOUD_PROJECT = prev.GOOGLE_CLOUD_PROJECT;
    if (prev.GCLOUD_PROJECT !== undefined) process.env.GCLOUD_PROJECT = prev.GCLOUD_PROJECT;
    vi.doUnmock("ai");
    vi.doUnmock("@ai-sdk/google-vertex");
  });

  it("is vercel-routed via factory", async () => {
    vi.resetModules();
    const { createProvider } = await import("../../provider-factory.js");
    const p = createProvider({ vendor: "vertex-ai", apiKey: "", vertexProject: "p" });
    // PR #705: factory returns a lazy proxy that defers the Vercel adapter
    // module load until first `streamTurn`. The vendor surface is preserved
    // synchronously so reviewer-wiring + IPC handlers stay unchanged.
    expect(p.constructor.name).toBe("LazyVercelProvider");
    expect(p.vendor).toBe("vertex-ai");
  });
});
