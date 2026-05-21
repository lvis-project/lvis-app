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
});
