import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { KeywordEngine } from "../../core/keyword-engine.js";
import { RouteEngine } from "../../core/route-engine.js";
import { fakeLlmSettings } from "../../shared/__tests__/fake-llm-settings.js";
import { marketplaceProviderPresetSecretKey } from "../../shared/marketplace-package-assets.js";
import { ToolRegistry } from "../../tools/registry.js";

describe("ConversationLoop LLM fetch wiring", () => {
  beforeEach(() => {
    vi.resetModules();
  });

afterEach(() => {
  vi.useRealTimers();
  vi.doUnmock("../llm/provider-factory.js");
});

async function collectStream(iterable: AsyncIterable<unknown>): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

  it("passes the injected main-process fetch implementation to the active provider", async () => {
    const createProvider = vi.fn(() => ({
      vendor: "azure-foundry" as const,
      streamTurn: async function* () {},
    }));
    vi.doMock("../llm/provider-factory.js", () => ({
      createProvider,
      secretKeyFor: (vendor: string) => `llm.apiKey.${vendor}`,
    }));
    const { ConversationLoop } = await import("../conversation-loop.js");

    const toolRegistry = new ToolRegistry();
    const settings = fakeLlmSettings({
      provider: "azure-foundry",
      model: "gpt-5.4-mini",
    });
    settings.vendors["azure-foundry"].baseUrl =
      "https://aif.example.openai.azure.com/openai/v1/";
    const llmFetch = vi.fn() as unknown as typeof fetch;

    new ConversationLoop(({
      settingsService: {
        get: () => settings,
        getSecret: () => "test-key",
      },
      systemPromptBuilder: { build: () => "system" },
      keywordEngine: new KeywordEngine(),
      routeEngine: new RouteEngine({ toolRegistry }),
      toolRegistry,
      memoryManager: { saveSession: () => {}, listSessions: () => [] },
      llmFetch,
    } as unknown) as ConstructorParameters<typeof ConversationLoop>[0]);

    expect(createProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        vendor: "azure-foundry",
        apiKey: "test-key",
        model: "gpt-5.4-mini",
        baseUrl: "https://aif.example.openai.azure.com/openai/v1/",
        fetch: llmFetch,
      }),
    );
  });

  it("does not pass the injected fetch to non-Azure providers", async () => {
    const createProvider = vi.fn(() => ({
      vendor: "openai" as const,
      streamTurn: async function* () {},
    }));
    vi.doMock("../llm/provider-factory.js", () => ({
      createProvider,
      secretKeyFor: (vendor: string) => `llm.apiKey.${vendor}`,
    }));
    const { ConversationLoop } = await import("../conversation-loop.js");

    const toolRegistry = new ToolRegistry();
    const settings = fakeLlmSettings({
      provider: "openai",
      model: "gpt-5.4-mini",
    });
    settings.vendors.openai.baseUrl = "https://proxy.example.test/v1";
    const llmFetch = vi.fn() as unknown as typeof fetch;

    new ConversationLoop(({
      settingsService: {
        get: () => settings,
        getSecret: () => "test-key",
      },
      systemPromptBuilder: { build: () => "system" },
      keywordEngine: new KeywordEngine(),
      routeEngine: new RouteEngine({ toolRegistry }),
      toolRegistry,
      memoryManager: { saveSession: () => {}, listSessions: () => [] },
      llmFetch,
    } as unknown) as ConstructorParameters<typeof ConversationLoop>[0]);

    expect(createProvider).toHaveBeenCalledWith(
      expect.not.objectContaining({
        fetch: llmFetch,
      }),
    );
    expect(createProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        vendor: "openai",
        apiKey: "test-key",
        model: "gpt-5.4-mini",
        baseUrl: "https://proxy.example.test/v1",
      }),
    );
  });

  it("creates OpenAI-compatible providers without an API key when a base URL is configured", async () => {
    const createProvider = vi.fn(() => ({
      vendor: "openai-compatible" as const,
      streamTurn: async function* () {},
    }));
    vi.doMock("../llm/provider-factory.js", () => ({
      createProvider,
      secretKeyFor: (vendor: string) => `llm.apiKey.${vendor}`,
    }));
    const { ConversationLoop } = await import("../conversation-loop.js");

    const toolRegistry = new ToolRegistry();
    const settings = fakeLlmSettings({
      provider: "openai-compatible",
      model: "Qwen3.6-35B-A3B-NVFP4",
    });
    settings.vendors["openai-compatible"].baseUrl = "http://localhost:8000/v1";

    new ConversationLoop(({
      settingsService: {
        get: () => settings,
        getSecret: () => null,
      },
      systemPromptBuilder: { build: () => "system" },
      keywordEngine: new KeywordEngine(),
      routeEngine: new RouteEngine({ toolRegistry }),
      toolRegistry,
      memoryManager: { saveSession: () => {}, listSessions: () => [] },
    } as unknown) as ConstructorParameters<typeof ConversationLoop>[0]);

    expect(createProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        vendor: "openai-compatible",
        apiKey: "",
        model: "Qwen3.6-35B-A3B-NVFP4",
        baseUrl: "http://localhost:8000/v1",
      }),
    );
  });

  it("uses the selected marketplace provider preset key for OpenAI-compatible providers", async () => {
    const createProvider = vi.fn(() => ({
      vendor: "openai-compatible" as const,
      streamTurn: async function* () {},
    }));
    vi.doMock("../llm/provider-factory.js", () => ({
      createProvider,
      secretKeyFor: (vendor: string) => `llm.apiKey.${vendor}`,
    }));
    const { ConversationLoop } = await import("../conversation-loop.js");

    const toolRegistry = new ToolRegistry();
    const settings = fakeLlmSettings({
      provider: "openai-compatible",
      model: "future/free",
    });
    settings.marketplaceProviderPresetId = "future-router";
    settings.vendors["openai-compatible"].baseUrl = "https://stale.example/v1";

    new ConversationLoop(({
      settingsService: {
        get: (key: string) => {
          if (key === "llm") return settings;
          if (key === "marketplace") {
            return {
              installedProviderPresets: [{
                providerId: "future-router",
                label: "Future Router",
                baseUrl: "https://future.example/v1",
                defaultModel: "future/free",
                modelOptions: ["future/free"],
                requiresApiKey: true,
                modelDiscoveryPolicy: "models-api",
                capabilities: { streaming: true, toolCalls: true },
              }],
            };
          }
          throw new Error(`unexpected settings key: ${key}`);
        },
        getSecret: (key: string) =>
          key === marketplaceProviderPresetSecretKey("future-router")
            ? "fr-secret"
            : null,
      },
      systemPromptBuilder: { build: () => "system" },
      keywordEngine: new KeywordEngine(),
      routeEngine: new RouteEngine({ toolRegistry }),
      toolRegistry,
      memoryManager: { saveSession: () => {}, listSessions: () => [] },
    } as unknown) as ConstructorParameters<typeof ConversationLoop>[0]);

    expect(createProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        vendor: "openai-compatible",
        apiKey: "fr-secret",
        model: "future/free",
        baseUrl: "https://future.example/v1",
        providerMetadata: expect.objectContaining({
          providerId: "future-router",
          baseUrl: "https://future.example/v1",
          modelDiscoveryPolicy: "models-api",
          capabilities: { streaming: true, toolCalls: true },
        }),
      }),
    );
  });

  it("does not fall back to generic OpenAI-compatible credentials when the selected preset is uninstalled", async () => {
    const createProvider = vi.fn(() => ({
      vendor: "openai-compatible" as const,
      streamTurn: async function* () {},
    }));
    vi.doMock("../llm/provider-factory.js", () => ({
      createProvider,
      secretKeyFor: (vendor: string) => `llm.apiKey.${vendor}`,
    }));
    const { ConversationLoop } = await import("../conversation-loop.js");

    const toolRegistry = new ToolRegistry();
    const settings = fakeLlmSettings({
      provider: "openai-compatible",
      model: "future/free",
    });
    settings.marketplaceProviderPresetId = "future-router";
    settings.vendors["openai-compatible"].baseUrl = "https://future.example/v1";

    new ConversationLoop(({
      settingsService: {
        get: (key: string) => {
          if (key === "llm") return settings;
          if (key === "marketplace") return { installedProviderPresets: [] };
          throw new Error(`unexpected settings key: ${key}`);
        },
        getSecret: (key: string) =>
          key === "llm.apiKey.openai-compatible"
            ? "generic-secret"
            : null,
      },
      systemPromptBuilder: { build: () => "system" },
      keywordEngine: new KeywordEngine(),
      routeEngine: new RouteEngine({ toolRegistry }),
      toolRegistry,
      memoryManager: { saveSession: () => {}, listSessions: () => [] },
    } as unknown) as ConstructorParameters<typeof ConversationLoop>[0]);

    expect(createProvider).not.toHaveBeenCalled();
  });

  it("does not resolve generic OpenAI-compatible fallback credentials while a marketplace preset is active", async () => {
    vi.useFakeTimers();
    const primaryProvider = {
      vendor: "openai-compatible" as const,
      streamTurn: vi.fn(async function* () {
        yield { type: "error" as const, error: "503 unavailable", classification: "network" };
      }),
    };
    const createProvider = vi.fn(() => primaryProvider);
    vi.doMock("../llm/provider-factory.js", () => ({
      createProvider,
      secretKeyFor: (vendor: string) => `llm.apiKey.${vendor}`,
    }));
    const { ConversationLoop } = await import("../conversation-loop.js");

    const toolRegistry = new ToolRegistry();
    const settings = fakeLlmSettings({
      provider: "openai-compatible",
      model: "future/free",
    });
    settings.marketplaceProviderPresetId = "future-router";
    settings.vendors["openai-compatible"].baseUrl = "https://future.example/v1";
    settings.fallbackChain = [{ provider: "openai-compatible", model: "fallback/free" }];
    const getSecret = vi.fn((key: string) =>
      key === marketplaceProviderPresetSecretKey("future-router")
        ? "fr-secret"
        : key === "llm.apiKey.openai-compatible"
          ? "generic-secret"
          : null
    );

    const loop = new ConversationLoop(({
      settingsService: {
        get: (key: string) => {
          if (key === "llm") return settings;
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
        },
        getSecret,
      },
      systemPromptBuilder: { build: () => "system" },
      keywordEngine: new KeywordEngine(),
      routeEngine: new RouteEngine({ toolRegistry }),
      toolRegistry,
      memoryManager: { saveSession: () => {}, listSessions: () => [] },
    } as unknown) as ConstructorParameters<typeof ConversationLoop>[0]);

    const pending = collectStream(loop.provider!.streamTurn({
      model: "future/free",
      systemPrompt: "sys",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
    }));
    const rejection = expect(pending).rejects.toThrow("503 unavailable");
    await vi.advanceTimersByTimeAsync(5_000);

    await rejection;
    expect(createProvider).toHaveBeenCalledTimes(1);
    expect(getSecret).toHaveBeenCalledWith(
      marketplaceProviderPresetSecretKey("future-router"),
    );
    expect(getSecret).not.toHaveBeenCalledWith("llm.apiKey.openai-compatible");
  });

  it("does not create ordinary keyed providers when the API key is missing", async () => {
    const createProvider = vi.fn(() => ({
      vendor: "openai" as const,
      streamTurn: async function* () {},
    }));
    vi.doMock("../llm/provider-factory.js", () => ({
      createProvider,
      secretKeyFor: (vendor: string) => `llm.apiKey.${vendor}`,
    }));
    const { ConversationLoop } = await import("../conversation-loop.js");

    const toolRegistry = new ToolRegistry();
    const settings = fakeLlmSettings({
      provider: "openai",
      model: "gpt-5.4-mini",
    });

    new ConversationLoop(({
      settingsService: {
        get: () => settings,
        getSecret: () => null,
      },
      systemPromptBuilder: { build: () => "system" },
      keywordEngine: new KeywordEngine(),
      routeEngine: new RouteEngine({ toolRegistry }),
      toolRegistry,
      memoryManager: { saveSession: () => {}, listSessions: () => [] },
    } as unknown) as ConstructorParameters<typeof ConversationLoop>[0]);

    expect(createProvider).not.toHaveBeenCalled();
  });
});
