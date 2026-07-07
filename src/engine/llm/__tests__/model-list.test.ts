import { describe, expect, it, vi } from "vitest";
import {
  listLlmModelsFromSettings,
  modelListEndpointFromBaseUrl,
  parseStandardModelListResponse,
} from "../model-list.js";
import { NetworkGuardError } from "../../../core/network-guard.js";
import { marketplaceProviderPresetSecretKey } from "../../../shared/marketplace-package-assets.js";

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
        modelListCache: {},
      };
    }),
    getSecret: vi.fn(() => secret),
  };
}

function guardedFetchOptions(fetchImpl: typeof fetch) {
  return {
    fetchImpl,
    ensurePublicUrl: async (url: string) => new URL(url),
    fetchPublicHttpResponseImpl: async (
      url: string,
      init?: RequestInit & { fetchImpl?: typeof fetch },
    ) => (init?.fetchImpl ?? fetch)(url, init),
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
      guardedFetchOptions(fetchImpl),
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
        maxRedirects: 0,
        timeoutMs: 8000,
      }),
    );
  });

  it("rejects credentialed HTTP model-list endpoints before fetching", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: "router/free" }] }), {
        status: 200,
      }),
    ) as unknown as typeof fetch;
    const ensurePublicUrl = vi.fn(async (url: string) => new URL(url));

    const result = await listLlmModelsFromSettings(
      makeSettingsService({ baseUrl: "http://router.example/v1" }) as never,
      { vendor: "openrouter" },
      {
        fetchImpl,
        ensurePublicUrl,
        fetchPublicHttpResponseImpl: async (
          url: string,
          init?: RequestInit & { fetchImpl?: typeof fetch },
        ) => (init?.fetchImpl ?? fetch)(url, init),
      },
    );

    expect(result).toMatchObject({
      ok: false,
      error: "invalid-model-list-endpoint",
      endpoint: "http://router.example/v1/models",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(ensurePublicUrl).not.toHaveBeenCalled();
  });

  it("rejects stored private model-list endpoints before fetching", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: "local/model" }] }), {
        status: 200,
      }),
    ) as unknown as typeof fetch;

    const result = await listLlmModelsFromSettings(
      makeSettingsService({ baseUrl: "http://127.0.0.1:11434/v1" }) as never,
      { vendor: "openrouter" },
      {
        fetchImpl,
        ensurePublicUrl: async () => {
          throw new NetworkGuardError(
            "target resolves to non-public address(es): 127.0.0.1",
          );
        },
      },
    );

    expect(result).toMatchObject({
      ok: false,
      error: "invalid-model-list-endpoint",
      endpoint: "http://127.0.0.1:11434/v1/models",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
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
        ...guardedFetchOptions(fetchImpl),
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
        maxRedirects: 0,
        timeoutMs: 8000,
      }),
    );
  });

  it("uses the selected marketplace provider preset key for saved OpenAI-compatible model sync", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: "future/free" }] }), {
        status: 200,
      }),
    ) as unknown as typeof fetch;
    const settingsService = {
      get: vi.fn((key: string) => {
        if (key === "llm") {
          return {
            authMode: "manual",
            provider: "openai-compatible",
            marketplaceProviderPresetId: "future-router",
            vendors: {
              "openai-compatible": {
                model: "future/free",
                baseUrl: "https://future.example/v1",
                enableThinking: true,
                thinkingBudgetTokens: 10_000,
              },
            },
            streamSmoothing: "none",
            fallbackChain: [],
            modelListCache: {},
          };
        }
        if (key === "marketplace") {
          return {
            installedProviderPresets: [{
              providerId: "future-router",
              label: "Future Router",
              baseUrl: "https://future.example/v1",
              defaultModel: "future/free",
              modelOptions: ["future/free"],
              requiresApiKey: true,
            }],
          };
        }
        throw new Error(`unexpected settings key: ${key}`);
      }),
      getSecret: vi.fn((key: string) =>
        key === marketplaceProviderPresetSecretKey("future-router")
          ? "fr-secret"
          : null
      ),
    };

    const result = await listLlmModelsFromSettings(
      settingsService as never,
      { vendor: "openai-compatible", credentialScope: "future-router" },
      guardedFetchOptions(fetchImpl),
    );

    expect(result).toMatchObject({
      ok: true,
      endpoint: "https://future.example/v1/models",
      models: ["future/free"],
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://future.example/v1/models",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer fr-secret",
        }),
      }),
    );
  });

  it("allows keyless marketplace provider presets to sync loopback model lists", async () => {
    const settingsService = {
      get: vi.fn((key: string) => {
        if (key === "llm") {
          return {
            authMode: "manual",
            provider: "openai-compatible",
            marketplaceProviderPresetId: "local-router",
            vendors: {
              "openai-compatible": {
                model: "local/free",
                baseUrl: "http://localhost:8000/v1",
              },
            },
            streamSmoothing: "none",
            fallbackChain: [],
            modelListCache: {},
          };
        }
        if (key === "marketplace") {
          return {
            installedProviderPresets: [{
              providerId: "local-router",
              label: "Local Router",
              baseUrl: "http://localhost:8000/v1",
              defaultModel: "local/free",
              modelOptions: ["local/free"],
              requiresApiKey: false,
            }],
          };
        }
        throw new Error(`unexpected settings key: ${key}`);
      }),
      getSecret: vi.fn(() => null),
    };
    const ensurePublicUrl = vi.fn(async (url: string, options?: { allowLoopback?: (url: URL) => boolean }) => {
      expect(options?.allowLoopback?.(new URL(url))).toBe(true);
      return new URL(url);
    });
    const fetchPublicHttpResponseImpl = vi.fn(async (
      url: string,
      init?: { allowLoopback?: (url: URL) => boolean; headers?: Record<string, string> },
    ) => {
      expect(init?.allowLoopback?.(new URL(url))).toBe(true);
      expect(init?.headers?.Authorization).toBeUndefined();
      return new Response(JSON.stringify({ data: [{ id: "local/free" }] }), {
        status: 200,
      });
    }) as unknown as typeof import("../../../core/network-guard.js").fetchPublicHttpResponse;

    const result = await listLlmModelsFromSettings(
      settingsService as never,
      { vendor: "openai-compatible", credentialScope: "local-router" },
      {
        ensurePublicUrl: ensurePublicUrl as never,
        fetchPublicHttpResponseImpl,
      },
    );

    expect(result).toMatchObject({
      ok: true,
      endpoint: "http://localhost:8000/v1/models",
      models: ["local/free"],
    });
    expect(ensurePublicUrl).toHaveBeenCalledOnce();
    expect(fetchPublicHttpResponseImpl).toHaveBeenCalledOnce();
  });

  it("rejects a marketplace credential scope that is not the active persisted preset", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: "future/free" }] }), {
        status: 200,
      }),
    ) as unknown as typeof fetch;
    const settingsService = {
      get: vi.fn((key: string) => {
        if (key === "llm") {
          return {
            authMode: "manual",
            provider: "openai-compatible",
            marketplaceProviderPresetId: "router-b",
            vendors: {
              "openai-compatible": {
                model: "shared/free",
                baseUrl: "https://shared.example/v1",
              },
            },
            streamSmoothing: "none",
            fallbackChain: [],
            modelListCache: {},
          };
        }
        if (key === "marketplace") {
          return {
            installedProviderPresets: [
              {
                providerId: "router-a",
                label: "Router A",
                baseUrl: "https://shared.example/v1",
                defaultModel: "shared/free",
                modelOptions: ["shared/free"],
                requiresApiKey: true,
              },
              {
                providerId: "router-b",
                label: "Router B",
                baseUrl: "https://shared.example/v1",
                defaultModel: "shared/free",
                modelOptions: ["shared/free"],
                requiresApiKey: true,
              },
            ],
          };
        }
        throw new Error(`unexpected settings key: ${key}`);
      }),
      getSecret: vi.fn(() => "should-not-be-used"),
    };

    const result = await listLlmModelsFromSettings(
      settingsService as never,
      { vendor: "openai-compatible", credentialScope: "router-a" },
      guardedFetchOptions(fetchImpl),
    );

    expect(result).toMatchObject({
      ok: false,
      error: "provider-not-installed",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(settingsService.getSecret).not.toHaveBeenCalled();
  });

  it("rejects a marketplace credential scope when the resolved endpoint does not match the preset", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: "other/free" }] }), {
        status: 200,
      }),
    ) as unknown as typeof fetch;
    const settingsService = {
      get: vi.fn((key: string) => {
        if (key === "llm") {
          return {
            authMode: "manual",
            provider: "openai-compatible",
            marketplaceProviderPresetId: "future-router",
            vendors: {
              "openai-compatible": {
                model: "other/free",
                baseUrl: "https://other.example/v1",
              },
            },
            streamSmoothing: "none",
            fallbackChain: [],
            modelListCache: {},
          };
        }
        if (key === "marketplace") {
          return {
            installedProviderPresets: [{
              providerId: "future-router",
              label: "Future Router",
              baseUrl: "https://future.example/v1",
              defaultModel: "future/free",
              modelOptions: ["future/free"],
              requiresApiKey: true,
            }],
          };
        }
        throw new Error(`unexpected settings key: ${key}`);
      }),
      getSecret: vi.fn(() => "should-not-be-used"),
    };

    const result = await listLlmModelsFromSettings(
      settingsService as never,
      { vendor: "openai-compatible", credentialScope: "future-router" },
      guardedFetchOptions(fetchImpl),
    );

    expect(result).toMatchObject({
      ok: false,
      error: "invalid-model-list-endpoint",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(settingsService.getSecret).not.toHaveBeenCalled();
  });

  it("rejects an uninstalled marketplace provider preset scope before fetching", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: "future/free" }] }), {
        status: 200,
      }),
    ) as unknown as typeof fetch;
    const settingsService = {
      get: vi.fn((key: string) => {
        if (key === "marketplace") return { installedProviderPresets: [] };
        if (key === "llm") {
          return {
            authMode: "manual",
            provider: "openai-compatible",
            vendors: {
              "openai-compatible": {
                model: "future/free",
                baseUrl: "https://future.example/v1",
              },
            },
            streamSmoothing: "none",
            fallbackChain: [],
            modelListCache: {},
          };
        }
        throw new Error(`unexpected settings key: ${key}`);
      }),
      getSecret: vi.fn(() => "should-not-be-used"),
    };

    const result = await listLlmModelsFromSettings(
      settingsService as never,
      { vendor: "openai-compatible", credentialScope: "missing-router" },
      guardedFetchOptions(fetchImpl),
    );

    expect(result).toMatchObject({
      ok: false,
      error: "provider-not-installed",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(settingsService.getSecret).not.toHaveBeenCalled();
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
      guardedFetchOptions(fetchImpl),
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
      guardedFetchOptions(fetchImpl),
    );

    expect(result).toMatchObject({
      ok: false,
      error: "invalid-model-list-response",
    });
  });
});
