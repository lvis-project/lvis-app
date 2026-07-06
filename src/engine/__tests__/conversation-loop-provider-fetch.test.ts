import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { KeywordEngine } from "../../core/keyword-engine.js";
import { RouteEngine } from "../../core/route-engine.js";
import { fakeLlmSettings } from "../../shared/__tests__/fake-llm-settings.js";
import { ToolRegistry } from "../../tools/registry.js";

describe("ConversationLoop LLM fetch wiring", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("../llm/provider-factory.js");
  });

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
