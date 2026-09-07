import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  listLlmModelsFromSettings,
  modelListEndpointFromBaseUrl,
  MODEL_LIST_REFRESH_TTL_MS,
  parseStandardModelListEntries,
  parseStandardModelListResponse,
  refreshRouteModelList,
  resetModelListProbeStateForTesting,
} from "../model-list.js";
import { NetworkGuardError } from "../../../core/network-guard.js";
import { llmModelListCacheKey } from "../../../shared/llm-model-list.js";
import { resolveContextWindowForRoute } from "../../../shared/context-budget.js";
import { marketplaceProviderPresetSecretKey } from "../../../shared/marketplace-package-assets.js";
import { unusedNetworkFetch } from "../../../__tests__/support/network-fetch-stubs.js";

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

  it("reads the prompt ceiling a gateway or a self-hosted server reports", () => {
    // A LiteLLM gateway answers with max_input_tokens/max_output_tokens; vLLM
    // answers with max_model_len. Both name the same limit the host budgets
    // compaction against, and reading neither leaves a served model on the
    // conservative fallback window.
    expect(
      parseStandardModelListEntries({
        object: "list",
        data: [
          { id: "gateway-served", max_input_tokens: 229_376, max_output_tokens: 32_768 },
          { id: "self-hosted-served", max_model_len: 131_072 },
          { id: "nested-limits", limits: { max_input_tokens: 65_536, max_output_tokens: 8_192 } },
          { id: "says-nothing" },
        ],
      }),
    ).toEqual([
      { id: "gateway-served", contextLength: 229_376, maxOutputTokens: 32_768 },
      { id: "self-hosted-served", contextLength: 131_072 },
      { id: "nested-limits", contextLength: 65_536, maxOutputTokens: 8_192 },
      { id: "says-nothing" },
    ]);
  });

  it("prefers an explicit context_length over the gateway aliases for it", () => {
    expect(
      parseStandardModelListEntries({
        object: "list",
        data: [{ id: "both", context_length: 200_000, max_input_tokens: 128_000 }],
      }),
    ).toEqual([{ id: "both", contextLength: 200_000 }]);
  });

  it("ignores a malformed reported limit rather than budgeting against it", () => {
    expect(
      parseStandardModelListEntries({
        object: "list",
        data: [
          { id: "negative", max_input_tokens: -1 },
          { id: "not-a-number", max_model_len: "131072" },
          { id: "bad-output", max_input_tokens: 1_000, max_output_tokens: -8 },
        ],
      }),
    ).toEqual([
      { id: "negative" },
      { id: "not-a-number" },
      { id: "bad-output", contextLength: 1_000 },
    ]);
  });

  it("preserves extended model metadata from OpenRouter-compatible model lists", () => {
    expect(
      parseStandardModelListEntries({
        object: "list",
        data: [
          {
            id: "google/gemini-2.5-flash:free",
            name: "Gemini 2.5 Flash Free",
            description: "Free routed model",
            context_length: 1_048_576,
            architecture: {
              input_modalities: ["text", "image"],
              output_modalities: ["text"],
            },
            pricing: {
              prompt: "0",
              completion: "0",
              request: "0",
            },
            supported_parameters: ["tools", "response_format"],
            top_provider: { name: "Google" },
          },
          {
            id: "openrouter/auto",
            name: "Auto Router",
            pricing: {
              prompt: "0.000001",
              completion: "0.000002",
            },
          },
        ],
      }),
    ).toMatchObject([
      {
        id: "google/gemini-2.5-flash:free",
        name: "Gemini 2.5 Flash Free",
        description: "Free routed model",
        contextLength: 1_048_576,
        inputModalities: ["text", "image"],
        outputModalities: ["text"],
        supportedParameters: ["tools", "response_format"],
        pricing: {
          prompt: "0",
          completion: "0",
          request: "0",
        },
        tags: {
          free: true,
        },
      },
      {
        id: "openrouter/auto",
        name: "Auto Router",
        pricing: {
          prompt: "0.000001",
          completion: "0.000002",
        },
        tags: {
          router: true,
        },
      },
    ]);
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
      modelEntries: [
        { id: "anthropic/claude-sonnet-4.6" },
        { id: "openrouter/free", tags: { free: true, router: true } },
      ],
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

  it("uses GitHub Models' catalog endpoint and parses its top-level array response", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify([
          {
            id: "openai/gpt-4.1",
            name: "OpenAI GPT-4.1",
            publisher: "OpenAI",
            summary: "A capable general-purpose model",
            limits: { max_input_tokens: 1_048_576 },
            supported_input_modalities: ["text", "image"],
            supported_output_modalities: ["text"],
          },
        ]),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;

    const result = await listLlmModelsFromSettings(
      makeSettingsService({
        provider: "copilot",
        baseUrl: "",
        secret: "github-models-token",
      }) as never,
      { vendor: "copilot" },
      guardedFetchOptions(fetchImpl),
    );

    expect(result).toMatchObject({
      ok: true,
      vendor: "copilot",
      endpoint: "https://models.github.ai/catalog/models",
      models: ["openai/gpt-4.1"],
      modelEntries: [{
        id: "openai/gpt-4.1",
        name: "OpenAI GPT-4.1",
        provider: "OpenAI",
        description: "A capable general-purpose model",
        contextLength: 1_048_576,
        inputModalities: ["text", "image"],
        outputModalities: ["text"],
      }],
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://models.github.ai/catalog/models",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Accept: "application/vnd.github+json",
          Authorization: "Bearer github-models-token",
          "X-GitHub-Api-Version": "2026-03-10",
        }),
      }),
    );
  });

  it("does not add GitHub's API-version header to a custom Copilot endpoint", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: "custom/copilot" }] }), {
        status: 200,
      }),
    ) as unknown as typeof fetch;

    await listLlmModelsFromSettings(
      makeSettingsService({
        provider: "copilot",
        baseUrl: "https://copilot-proxy.example/v1",
        secret: "custom-copilot-token",
      }) as never,
      { vendor: "copilot" },
      guardedFetchOptions(fetchImpl),
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://copilot-proxy.example/v1/models",
      expect.objectContaining({
        headers: expect.not.objectContaining({
          "X-GitHub-Api-Version": expect.any(String),
        }),
      }),
    );
  });

  it("does not fetch model lists for manual or static discovery policies", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: "router/free" }] }), {
        status: 200,
      }),
    ) as unknown as typeof fetch;

    for (const modelDiscoveryPolicy of ["manual", "static"] as const) {
      const result = await listLlmModelsFromSettings(
        makeSettingsService() as never,
        { vendor: "openrouter", modelDiscoveryPolicy },
        guardedFetchOptions(fetchImpl),
      );

      expect(result).toMatchObject({
        ok: false,
        error: "model-list-not-supported",
      });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("syncs a saved credentialed private model-provider endpoint", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: "Qwen3.6-35B-A3B-NVFP4" }] }), {
        status: 200,
      }),
    ) as unknown as typeof fetch;
    const ensurePublicUrl = vi.fn(async (
      url: string,
      options?: {
        allowPrivateNetworks?: (url: URL) => boolean;
        allowLoopback?: (url: URL) => boolean;
      },
    ) => {
      expect(options?.allowPrivateNetworks?.(new URL(url))).toBe(true);
      expect(options?.allowLoopback?.(new URL(url))).toBe(true);
      return new URL(url);
    });
    const fetchPublicHttpResponseImpl = vi.fn(async (
      url: string,
      init?: {
        allowPrivateNetworks?: (url: URL) => boolean;
        allowLoopback?: (url: URL) => boolean;
        fetchImpl?: typeof fetch;
      },
    ) => {
      expect(init?.allowPrivateNetworks?.(new URL(url))).toBe(true);
      expect(init?.allowLoopback?.(new URL(url))).toBe(true);
      return (init?.fetchImpl ?? fetch)(url, init);
    }) as unknown as typeof import("../../../core/network-guard.js").fetchPublicHttpResponse;

    const result = await listLlmModelsFromSettings(
      makeSettingsService({
        provider: "openai-compatible",
        baseUrl: "http://10.232.178.100:30000/v1",
        secret: "internal-key",
      }) as never,
      { vendor: "openai-compatible" },
      {
        fetchImpl,
        ensurePublicUrl,
        fetchPublicHttpResponseImpl,
      },
    );

    expect(result).toMatchObject({
      ok: true,
      endpoint: "http://10.232.178.100:30000/v1/models",
      models: ["Qwen3.6-35B-A3B-NVFP4"],
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://10.232.178.100:30000/v1/models",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer internal-key" }),
      }),
    );
  });

  it("syncs a saved self-hosted non-openai-compatible endpoint (ollama) over private HTTP", async () => {
    // Covers isSavedSelfHostedModelListEndpoint's `vendor !== "openai-compatible"
    // → return true` branch: a saved self-hosted trusted-network vendor other
    // than openai-compatible is treated as a saved self-hosted endpoint, so it
    // gets same-origin private + loopback access and credentialed HTTP.
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: "llama3.3" }] }), {
        status: 200,
      }),
    ) as unknown as typeof fetch;
    const ensurePublicUrl = vi.fn(async (
      url: string,
      options?: {
        allowPrivateNetworks?: (url: URL) => boolean;
        allowLoopback?: (url: URL) => boolean;
      },
    ) => {
      expect(options?.allowPrivateNetworks?.(new URL(url))).toBe(true);
      expect(options?.allowLoopback?.(new URL(url))).toBe(true);
      return new URL(url);
    });
    const fetchPublicHttpResponseImpl = vi.fn(async (
      url: string,
      init?: {
        allowPrivateNetworks?: (url: URL) => boolean;
        allowLoopback?: (url: URL) => boolean;
        fetchImpl?: typeof fetch;
      },
    ) => {
      expect(init?.allowPrivateNetworks?.(new URL(url))).toBe(true);
      expect(init?.allowLoopback?.(new URL(url))).toBe(true);
      return (init?.fetchImpl ?? fetch)(url, init);
    }) as unknown as typeof import("../../../core/network-guard.js").fetchPublicHttpResponse;

    const result = await listLlmModelsFromSettings(
      makeSettingsService({
        provider: "ollama",
        baseUrl: "http://10.10.0.5:11434/v1",
        secret: "ollama-key",
      }) as never,
      { vendor: "ollama" },
      { fetchImpl, ensurePublicUrl, fetchPublicHttpResponseImpl },
    );

    expect(result).toMatchObject({
      ok: true,
      endpoint: "http://10.10.0.5:11434/v1/models",
      models: ["llama3.3"],
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://10.10.0.5:11434/v1/models",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer ollama-key" }),
      }),
    );
  });

  it("denies private access for a keyless openai-compatible draft endpoint with no preset", async () => {
    // Covers keylessMarketplaceModelListNetworkAccess's `!presetId` branch: a
    // keyless openai-compatible DRAFT endpoint (differs from the saved baseUrl,
    // so not a saved self-hosted endpoint) with no active marketplace preset id
    // resolves to no private/loopback access.
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: "draft/model" }] }), {
        status: 200,
      }),
    ) as unknown as typeof fetch;
    const ensurePublicUrl = vi.fn(async (
      _url: string,
      options?: {
        allowPrivateNetworks?: false | ((url: URL) => boolean);
        allowLoopback?: false | ((url: URL) => boolean);
      },
    ) => {
      expect(options?.allowPrivateNetworks).toBe(false);
      expect(options?.allowLoopback).toBe(false);
      return new URL(_url);
    });
    const fetchPublicHttpResponseImpl = vi.fn(async (
      url: string,
      init?: {
        allowPrivateNetworks?: false | ((url: URL) => boolean);
        allowLoopback?: false | ((url: URL) => boolean);
        fetchImpl?: typeof fetch;
      },
    ) => {
      expect(init?.allowPrivateNetworks).toBe(false);
      expect(init?.allowLoopback).toBe(false);
      return (init?.fetchImpl ?? fetch)(url, init);
    }) as unknown as typeof import("../../../core/network-guard.js").fetchPublicHttpResponse;

    const result = await listLlmModelsFromSettings(
      makeSettingsService({
        provider: "openai-compatible",
        baseUrl: "http://saved.example/v1",
      }) as never,
      { vendor: "openai-compatible", baseUrl: "http://draft.example/v1" },
      { fetchImpl, ensurePublicUrl, fetchPublicHttpResponseImpl },
    );

    expect(result).toMatchObject({
      ok: true,
      endpoint: "http://draft.example/v1/models",
      models: ["draft/model"],
    });
    // Keyless draft → no Authorization header forwarded.
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://draft.example/v1/models",
      expect.objectContaining({ headers: { Accept: "application/json" } }),
    );
  });

  it("denies private access for a keyless openai-compatible endpoint whose active preset is not installed", async () => {
    // Covers keylessMarketplaceModelListNetworkAccess's non-matching-preset
    // branch (`!preset`): the active provider is openai-compatible with a
    // marketplaceProviderPresetId that is not installed, keyless, so the preset
    // lookup misses and no private/loopback access is granted.
    const settingsService = {
      get: vi.fn((key: string) => {
        if (key === "llm") {
          return {
            authMode: "manual",
            provider: "openai-compatible",
            marketplaceProviderPresetId: "ghost-router",
            vendors: {
              "openai-compatible": {
                model: "ghost/model",
                baseUrl: "https://ghost.example/v1",
              },
            },
            streamSmoothing: "none",
            fallbackChain: [],
            modelListCache: {},
          };
        }
        if (key === "marketplace") return { installedProviderPresets: [] };
        throw new Error(`unexpected settings key: ${key}`);
      }),
      getSecret: vi.fn(() => null),
    };
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: "ghost/model" }] }), {
        status: 200,
      }),
    ) as unknown as typeof fetch;
    const ensurePublicUrl = vi.fn(async (
      url: string,
      options?: {
        allowPrivateNetworks?: false | ((url: URL) => boolean);
        allowLoopback?: false | ((url: URL) => boolean);
      },
    ) => {
      expect(options?.allowPrivateNetworks).toBe(false);
      expect(options?.allowLoopback).toBe(false);
      return new URL(url);
    });
    const fetchPublicHttpResponseImpl = vi.fn(async (
      url: string,
      init?: {
        allowPrivateNetworks?: false | ((url: URL) => boolean);
        allowLoopback?: false | ((url: URL) => boolean);
        fetchImpl?: typeof fetch;
      },
    ) => {
      expect(init?.allowPrivateNetworks).toBe(false);
      expect(init?.allowLoopback).toBe(false);
      return (init?.fetchImpl ?? fetch)(url, init);
    }) as unknown as typeof import("../../../core/network-guard.js").fetchPublicHttpResponse;

    const result = await listLlmModelsFromSettings(
      settingsService as never,
      { vendor: "openai-compatible" },
      { fetchImpl, ensurePublicUrl, fetchPublicHttpResponseImpl },
    );

    expect(result).toMatchObject({
      ok: true,
      endpoint: "https://ghost.example/v1/models",
      models: ["ghost/model"],
    });
    expect(ensurePublicUrl).toHaveBeenCalledOnce();
  });

  it("keeps unsaved private model-list endpoints blocked", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: "local/model" }] }), {
        status: 200,
      }),
    ) as unknown as typeof fetch;

    const result = await listLlmModelsFromSettings(
      makeSettingsService({ baseUrl: "https://router.example/v1" }) as never,
      { vendor: "openrouter", baseUrl: "http://10.232.178.100:30000/v1" },
      {
        fetchImpl,
        ensurePublicUrl: async (_url, options) => {
          expect(options?.allowPrivateNetworks).toBe(false);
          expect(options?.allowLoopback).toBe(false);
          throw new NetworkGuardError(
            "target resolves to non-public address(es): 10.232.178.100",
          );
        },
      },
    );

    expect(result).toMatchObject({
      ok: false,
      error: "invalid-model-list-endpoint",
      endpoint: "http://10.232.178.100:30000/v1/models",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps saved commercial provider endpoints HTTPS-only and public-only", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const ensurePublicUrl = vi.fn();

    const result = await listLlmModelsFromSettings(
      makeSettingsService({
        provider: "openrouter",
        baseUrl: "http://10.232.178.100:30000/v1",
        secret: "commercial-key",
      }) as never,
      { vendor: "openrouter" },
      { fetchImpl, ensurePublicUrl },
    );

    expect(result).toMatchObject({
      ok: false,
      error: "invalid-model-list-endpoint",
      endpoint: "http://10.232.178.100:30000/v1/models",
    });
    expect(ensurePublicUrl).not.toHaveBeenCalled();
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
    const ensurePublicUrl = vi.fn(async (url: string, options?: {
      allowPrivateNetworks?: (url: URL) => boolean;
      allowLoopback?: (url: URL) => boolean;
    }) => {
      expect(options?.allowPrivateNetworks).toBe(false);
      expect(options?.allowLoopback?.(new URL(url))).toBe(true);
      return new URL(url);
    });
    const fetchPublicHttpResponseImpl = vi.fn(async (
      url: string,
      init?: {
        allowPrivateNetworks?: (url: URL) => boolean;
        allowLoopback?: (url: URL) => boolean;
        headers?: Record<string, string>;
      },
    ) => {
      expect(init?.allowPrivateNetworks).toBe(false);
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
        fetchImpl: unusedNetworkFetch,
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

    // An explicit endpoint that is not the preset's: the preset's stored
    // secret must never be offered to it.
    const result = await listLlmModelsFromSettings(
      settingsService as never,
      {
        vendor: "openai-compatible",
        credentialScope: "future-router",
        baseUrl: "https://other.example/v1",
      },
      guardedFetchOptions(fetchImpl),
    );

    expect(result).toMatchObject({
      ok: false,
      error: "invalid-model-list-endpoint",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(settingsService.getSecret).not.toHaveBeenCalled();
  });

  it("resolves a scoped request to the preset's endpoint, not the vendor block's", async () => {
    // The vendor block belongs to the GENERIC custom-provider row and is no
    // longer a copy of the preset's address, so a scoped request has to read
    // the preset registry. Reading the block would send the preset's secret
    // to whatever another row happens to be pointed at.
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: "future/free" }] }), { status: 200 }),
    ) as unknown as typeof fetch;
    const settingsService = {
      get: vi.fn((key: string) => {
        if (key === "llm") {
          return {
            provider: "openai-compatible",
            marketplaceProviderPresetId: "future-router",
            vendors: {
              "openai-compatible": { model: "other/free", baseUrl: "https://other.example/v1" },
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
      getSecret: vi.fn(() => "fr-secret"),
    };

    const result = await listLlmModelsFromSettings(
      settingsService as never,
      { vendor: "openai-compatible", credentialScope: "future-router" },
      guardedFetchOptions(fetchImpl),
    );

    expect(result).toMatchObject({ ok: true, endpoint: "https://future.example/v1/models" });
    expect(String((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]))
      .toBe("https://future.example/v1/models");
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

  // A request that never reached a server is the case the renderer can say the
  // least about: `fetch` throws the same three words whatever went wrong. The
  // code the runtime parked on `cause` is the whole diagnostic, so it has to
  // survive into the result the renderer carries.
  it("carries the transport cause code into the diagnostic message", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed", {
        cause: { code: "SELF_SIGNED_CERT_IN_CHAIN" },
      });
    }) as unknown as typeof fetch;

    const result = await listLlmModelsFromSettings(
      makeSettingsService() as never,
      { vendor: "openrouter" },
      guardedFetchOptions(fetchImpl),
    );

    expect(result).toMatchObject({
      ok: false,
      error: "model-list-fetch-failed",
    });
    expect((result as { message: string }).message).toContain("SELF_SIGNED_CERT_IN_CHAIN");
  });

  it("uses the injected transport rather than the ambient fetch", async () => {
    const ambient = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", ambient);
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: "m-1" }] }), { status: 200 }),
    ) as unknown as typeof fetch;

    try {
      const result = await listLlmModelsFromSettings(
        makeSettingsService() as never,
        { vendor: "openrouter" },
        guardedFetchOptions(fetchImpl),
      );
      expect(result).toMatchObject({ ok: true, models: ["m-1"] });
      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(ambient).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("refreshRouteModelList — the catalogue a headless run can reach", () => {
  const address = {
    vendor: "openai-compatible" as const,
    baseUrl: "https://models.invalid/v1",
  };

  function makeRefreshSettings(cache: Record<string, unknown> = {}) {
    const patch = vi.fn(async (_partial: {
      llm: { modelListCache: Record<string, { modelEntries?: Array<{ contextLength?: number }> }> };
    }) => ({}));
    const llm = {
      provider: "openai-compatible",
      vendors: {
        "openai-compatible": {
          model: "gateway-served",
          baseUrl: "https://models.invalid/v1",
          enableThinking: true,
          thinkingBudgetTokens: 10_000,
        },
      },
      streamSmoothing: "none",
      fallbackChain: [],
      modelListCache: cache,
    };
    return {
      patch,
      service: {
        // A snapshot per read, the way the real service hands out settings —
        // a caller that holds one across an await is holding stale data.
        get: vi.fn((key: string) =>
          key === "llm" ? { ...llm, modelListCache: { ...cache } } : {},
        ),
        getSecret: vi.fn(() => ""),
        patch,
      },
    };
  }

  const servedCatalogue = () =>
    vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: [{ id: "gateway-served", max_input_tokens: 229_376, max_output_tokens: 32_768 }],
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;

  beforeEach(() => {
    resetModelListProbeStateForTesting();
  });

  it("asks the endpoint and stores the answer where the reader looks for it", async () => {
    // The cache used to be written only by the settings page, so a run with no
    // window open — a routine, a sub-agent, an evaluation — could never reach
    // the provider-reported window at all.
    const { service, patch } = makeRefreshSettings();
    const fetchImpl = servedCatalogue();

    const stored = await refreshRouteModelList({
      settingsService: service as never,
      fetchOptions: guardedFetchOptions(fetchImpl),
      address,
    });

    expect(stored).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const written = patch.mock.calls[0][0];
    const key = llmModelListCacheKey("openai-compatible", "https://models.invalid/v1", "");
    expect(written.llm.modelListCache[key]?.modelEntries?.[0]?.contextLength).toBe(229_376);
    // The window the engine and the ring then read off that row.
    expect(
      resolveContextWindowForRoute({
        provider: "openai-compatible",
        vendors: {
          "openai-compatible": {
            model: "gateway-served",
            baseUrl: "https://models.invalid/v1",
            enableThinking: true,
            thinkingBudgetTokens: 10_000,
          },
        },
        modelListCache: written.llm.modelListCache as never,
      }),
    ).toMatchObject({ contextWindow: 229_376, source: "provider-reported" });
  });

  it("asks once per route, however many turns evaluate the budget", async () => {
    const { service } = makeRefreshSettings();
    const fetchImpl = servedCatalogue();

    await refreshRouteModelList({ settingsService: service as never, fetchOptions: guardedFetchOptions(fetchImpl), address });
    await refreshRouteModelList({ settingsService: service as never, fetchOptions: guardedFetchOptions(fetchImpl), address });
    await refreshRouteModelList({ settingsService: service as never, fetchOptions: guardedFetchOptions(fetchImpl), address });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("leaves a catalogue answer that is still within its lifetime alone", async () => {
    const key = llmModelListCacheKey("openai-compatible", "https://models.invalid/v1", "");
    const { service, patch } = makeRefreshSettings({
      [key]: {
        vendor: "openai-compatible",
        endpoint: "https://models.invalid/v1/models",
        models: ["gateway-served"],
        fetchedAt: new Date(Date.now() - 60_000).toISOString(),
      },
    });
    const fetchImpl = servedCatalogue();

    expect(
      await refreshRouteModelList({ settingsService: service as never, fetchOptions: guardedFetchOptions(fetchImpl), address }),
    ).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
  });

  it("asks again once that answer is older than its lifetime", async () => {
    const key = llmModelListCacheKey("openai-compatible", "https://models.invalid/v1", "");
    const { service } = makeRefreshSettings({
      [key]: {
        vendor: "openai-compatible",
        endpoint: "https://models.invalid/v1/models",
        models: ["gateway-served"],
        fetchedAt: new Date(Date.now() - MODEL_LIST_REFRESH_TTL_MS - 1_000).toISOString(),
      },
    });
    const fetchImpl = servedCatalogue();

    expect(
      await refreshRouteModelList({ settingsService: service as never, fetchOptions: guardedFetchOptions(fetchImpl), address }),
    ).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not ask a preset that declares it has nothing to answer with", async () => {
    // A static or manually configured preset is saying its endpoint does not
    // serve /models. The settings page refuses that sync; a background probe
    // that skipped the check would send the preset's credential scope to an
    // endpoint the user declared off limits.
    const { service, patch } = makeRefreshSettings();
    const fetchImpl = servedCatalogue();

    for (const policy of ["static", "manual"] as const) {
      expect(
        await refreshRouteModelList({
          settingsService: service as never,
          fetchOptions: guardedFetchOptions(fetchImpl),
          address,
          modelDiscoveryPolicy: policy,
        }),
      ).toBe(false);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();

    // And the refusal did not burn the route's one probe: a preset later
    // switched to discovery is asked normally.
    expect(
      await refreshRouteModelList({
        settingsService: service as never,
        fetchOptions: guardedFetchOptions(fetchImpl),
        address,
      }),
    ).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("merges its answer into the cache as it stands after the round trip", async () => {
    // `patch` shallow-merges one settings block, and the request above takes
    // seconds. Writing back the cache this call started with would erase a row
    // the settings page synced while it was waiting.
    const otherKey = llmModelListCacheKey("openai", "", "");
    const cache: Record<string, unknown> = {};
    const { service, patch } = makeRefreshSettings(cache);
    const fetchImpl = vi.fn(async () => {
      // A concurrent sync lands mid-flight.
      cache[otherKey] = {
        vendor: "openai",
        endpoint: "https://api.openai.com/v1/models",
        models: ["gpt-5.4-mini"],
        fetchedAt: new Date().toISOString(),
      };
      return new Response(
        JSON.stringify({ data: [{ id: "gateway-served", max_input_tokens: 229_376 }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    await refreshRouteModelList({
      settingsService: service as never,
      fetchOptions: guardedFetchOptions(fetchImpl),
      address,
    });

    const written = patch.mock.calls[0][0];
    expect(Object.keys(written.llm.modelListCache).sort()).toEqual(
      [otherKey, llmModelListCacheKey("openai-compatible", "https://models.invalid/v1", "")].sort(),
    );
  });

  it("keeps the window it has when the endpoint does not answer", async () => {
    const { service, patch } = makeRefreshSettings();
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;

    expect(
      await refreshRouteModelList({ settingsService: service as never, fetchOptions: guardedFetchOptions(fetchImpl), address }),
    ).toBe(false);
    expect(patch).not.toHaveBeenCalled();
  });
});
