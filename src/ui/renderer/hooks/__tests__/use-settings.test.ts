import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useSettings } from "../use-settings.js";
import type { AppSettings, LvisApi } from "../../types.js";
import { makeMockLvisApi } from "../../../../../test/renderer/mock-lvis-api.js";

function makeSettings(): AppSettings {
  return {
    llm: {
      authMode: "manual",
      provider: "openai",
      vendors: {
        openai: {
          model: "gpt-5.4-mini",
          enableThinking: true,
          thinkingBudgetTokens: 10_000,
        },
      },
      streamSmoothing: "none",
      fallbackChain: [],
    },
    chat: { systemPrompt: "", autoCompact: true },
    webSearch: { provider: "duckduckgo" },
    privacy: { piiRedactEnabled: false },
    marketplace: {
      cloudBaseUrl: "",
      cloudAllowPrivateNetwork: false,
    },
  };
}

describe("useSettings", () => {
  it("marks no-key marketplace provider presets ready when they have a base URL", async () => {
    const settings = makeSettings();
    settings.llm.provider = "openai-compatible";
    settings.llm.marketplaceProviderPresetId = "future-router";
    settings.llm.vendors["openai-compatible"] = {
      model: "future/free",
      baseUrl: "https://future.example/v1",
      enableThinking: true,
      thinkingBudgetTokens: 10_000,
    };
    settings.marketplace = {
      ...settings.marketplace,
      installedProviderPresets: [
        {
          providerId: "future-router",
          label: "Future Router",
          baseUrl: "https://future.example/v1",
          defaultModel: "future/free",
          modelOptions: ["future/free"],
          requiresApiKey: false,
        },
      ],
    };
    const { api } = makeMockLvisApi({ settings, hasApiKey: false });

    const { result } = renderHook(() => useSettings(api as unknown as LvisApi));

    await waitFor(() => {
      expect(result.current.llmVendor).toBe("openai-compatible");
      expect(result.current.llmReadyWithoutApiKey).toBe(true);
    });
  });

  it("uses the marketplace preset base URL for no-key readiness when the vendor block has not materialized it yet", async () => {
    const settings = makeSettings();
    settings.llm.provider = "openai-compatible";
    settings.llm.marketplaceProviderPresetId = "local-router";
    settings.llm.vendors["openai-compatible"] = {
      model: "local/free",
      enableThinking: true,
      thinkingBudgetTokens: 10_000,
    };
    settings.marketplace = {
      ...settings.marketplace,
      installedProviderPresets: [
        {
          providerId: "local-router",
          label: "Local Router",
          baseUrl: "http://127.0.0.1:11434/v1",
          defaultModel: "local/free",
          modelOptions: ["local/free"],
          requiresApiKey: false,
        },
      ],
    };
    const { api } = makeMockLvisApi({ settings, hasApiKey: false });

    const { result } = renderHook(() => useSettings(api as unknown as LvisApi));

    await waitFor(() => {
      expect(result.current.llmVendor).toBe("openai-compatible");
      expect(result.current.llmReadyWithoutApiKey).toBe(true);
    });
  });
});
