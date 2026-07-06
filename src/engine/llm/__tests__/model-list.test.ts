import { describe, expect, it, vi } from "vitest";
import {
  listLlmModelsFromSettings,
  modelListEndpointFromBaseUrl,
  parseStandardModelListResponse,
} from "../model-list.js";

function makeSettingsService(overrides: {
  provider?: string;
  baseUrl?: string;
  secret?: string | null;
} = {}) {
  const provider = overrides.provider ?? "openrouter";
  const baseUrl = overrides.baseUrl ?? "https://openrouter.ai/api/v1";
  const secret = overrides.secret ?? "sk-or-test";
  return {
    get: vi.fn((key: string) => {
      if (key !== "llm") throw new Error(`unexpected settings key: ${key}`);
      return {
        authMode: "manual",
        provider,
        vendors: {
          [provider]: {
            model: "openrouter/free",
            baseUrl,
            enableThinking: true,
            thinkingBudgetTokens: 10_000,
          },
        },
        streamSmoothing: "none",
        fallbackChain: [],
      };
    }),
    getSecret: vi.fn(() => secret),
  };
}

describe("LLM model list sync", () => {
  it("normalizes baseUrl to the standard /models endpoint", () => {
    expect(modelListEndpointFromBaseUrl("https://openrouter.ai/api/v1")).toBe(
      "https://openrouter.ai/api/v1/models",
    );
    expect(modelListEndpointFromBaseUrl("http://localhost:11434/v1/")).toBe(
      "http://localhost:11434/v1/models",
    );
    expect(modelListEndpointFromBaseUrl("https://proxy.example/v1/models")).toBe(
      "https://proxy.example/v1/models",
    );
    expect(() =>
      modelListEndpointFromBaseUrl("https://user:pass@proxy.example/v1"),
    ).toThrow(/embedded credentials/);
  });

  it("parses standard model list responses and keeps free router model ids", () => {
    expect(
      parseStandardModelListResponse({
        object: "list",
        data: [
          { id: "openai/gpt-5.4" },
          { id: "google/gemini-2.5-flash:free" },
          { id: "google/gemini-2.5-flash:free" },
        ],
      }),
    ).toEqual(["openai/gpt-5.4", "google/gemini-2.5-flash:free"]);
  });

  it("fetches models from the vendor baseUrl using the stored provider key", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: [
            { id: "anthropic/claude-sonnet-4.6" },
            { id: "openrouter/free" },
          ],
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
    const settingsService = makeSettingsService();

    const result = await listLlmModelsFromSettings(
      settingsService as never,
      { vendor: "openrouter" },
      { fetchImpl },
    );

    expect(result).toMatchObject({
      ok: true,
      vendor: "openrouter",
      endpoint: "https://openrouter.ai/api/v1/models",
      models: ["anthropic/claude-sonnet-4.6", "openrouter/free"],
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/models",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Accept: "application/json",
          Authorization: "Bearer sk-or-test",
        }),
      }),
    );
  });

  it("does not send the stored provider key to an unsaved draft baseUrl", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: "draft/model" }] }), {
        status: 200,
      }),
    ) as unknown as typeof fetch;

    const result = await listLlmModelsFromSettings(
      makeSettingsService() as never,
      {
        vendor: "openrouter",
        baseUrl: "https://models.example.com/v1",
      },
      {
        fetchImpl,
        ensurePublicUrl: async (url) => new URL(url),
      },
    );

    expect(result).toMatchObject({
      ok: true,
      endpoint: "https://models.example.com/v1/models",
      models: ["draft/model"],
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://models.example.com/v1/models",
      expect.objectContaining({
        method: "GET",
        headers: { Accept: "application/json" },
        redirect: "manual",
      }),
    );
  });

  it("returns a structured error when the model response has no ids", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ object: "model" }] }), {
        status: 200,
      }),
    ) as unknown as typeof fetch;

    const result = await listLlmModelsFromSettings(
      makeSettingsService() as never,
      { vendor: "openrouter" },
      { fetchImpl },
    );

    expect(result).toMatchObject({
      ok: false,
      error: "invalid-model-list-response",
    });
  });

  it("returns a structured error when the model response is not JSON", async () => {
    const fetchImpl = vi.fn(async () => new Response("not json", { status: 200 })) as unknown as typeof fetch;

    const result = await listLlmModelsFromSettings(
      makeSettingsService() as never,
      { vendor: "openrouter" },
      { fetchImpl },
    );

    expect(result).toMatchObject({
      ok: false,
      error: "invalid-model-list-response",
    });
  });
});
