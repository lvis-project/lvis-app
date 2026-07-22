import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useSettings } from "../use-settings.js";
import type { AppSettings, LvisApi } from "../../types.js";
import { makeMockLvisApi } from "../../../../../test/renderer/mock-lvis-api.js";
import { LLM_VENDOR_DEFAULTS } from "../../../../shared/llm-vendor-defaults.js";

function makeSettings(): AppSettings {
  return {
    llm: {
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
  it("updates the full LLM cache from settings broadcasts", async () => {
    const initial = makeSettings();
    let onSettingsUpdated: ((settings: AppSettings) => void) | undefined;
    const unsubscribe = vi.fn();
    const { api } = makeMockLvisApi({ settings: initial, hasApiKey: false });
    api.onSettingsUpdated = vi.fn((handler) => {
      onSettingsUpdated = handler as (settings: AppSettings) => void;
      return unsubscribe;
    });

    const { result, unmount } = renderHook(() => useSettings(api as unknown as LvisApi));
    await waitFor(() => expect(result.current.llmModel).toBe("gpt-5.4-mini"));

    const next = makeSettings();
    next.llm.provider = "openai-compatible";
    next.llm.marketplaceProviderPresetId = "local-router";
    next.llm.vendors["openai-compatible"] = {
      model: "local/reasoner",
      baseUrl: "http://127.0.0.1:11434/v1",
      enableThinking: false,
      thinkingBudgetTokens: 32_000,
    };
    next.marketplace = {
      ...next.marketplace,
      installedProviderPresets: [
        {
          providerId: "local-router",
          label: "Local Router",
          baseUrl: "http://127.0.0.1:11434/v1",
          defaultModel: "local/reasoner",
          modelOptions: ["local/reasoner"],
          requiresApiKey: false,
        },
      ],
    };

    act(() => onSettingsUpdated!(next));

    expect(result.current.llmVendor).toBe("openai-compatible");
    expect(result.current.llmModel).toBe("local/reasoner");
    expect(result.current.enableThinkingChat).toBe(false);
    expect(result.current.llmReadyWithoutApiKey).toBe(true);

    unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("does not let a stale initial read overwrite a newer broadcast", async () => {
    const initial = makeSettings();
    let resolveInitial!: (settings: AppSettings) => void;
    const initialRead = new Promise<AppSettings>((resolve) => {
      resolveInitial = resolve;
    });
    let onSettingsUpdated: ((settings: AppSettings) => void) | undefined;
    const { api } = makeMockLvisApi({ settings: initial, hasApiKey: false });
    api.getSettings = vi.fn(() => initialRead);
    api.onSettingsUpdated = vi.fn((handler) => {
      onSettingsUpdated = handler as (settings: AppSettings) => void;
      return vi.fn();
    });

    const { result } = renderHook(() => useSettings(api as unknown as LvisApi));
    expect(api.onSettingsUpdated.mock.invocationCallOrder[0]).toBeLessThan(
      api.getSettings.mock.invocationCallOrder[0],
    );
    const next = makeSettings();
    next.llm.vendors.openai = {
      ...next.llm.vendors.openai,
      model: "gpt-5.4",
      enableThinking: false,
    };

    act(() => onSettingsUpdated!(next));
    expect(result.current.llmModel).toBe("gpt-5.4");

    await act(async () => {
      resolveInitial(initial);
      await initialRead;
    });

    expect(result.current.llmModel).toBe("gpt-5.4");
    expect(result.current.enableThinkingChat).toBe(false);
  });

  it("falls back to vendor defaults when a broadcast omits the active vendor block", async () => {
    let onSettingsUpdated: ((settings: AppSettings) => void) | undefined;
    const { api } = makeMockLvisApi({ settings: makeSettings(), hasApiKey: false });
    api.onSettingsUpdated = vi.fn((handler) => {
      onSettingsUpdated = handler as (settings: AppSettings) => void;
      return vi.fn();
    });
    const { result } = renderHook(() => useSettings(api as unknown as LvisApi));
    await waitFor(() => expect(result.current.llmModel).toBe("gpt-5.4-mini"));

    const next = makeSettings();
    next.llm.provider = "claude";
    delete next.llm.vendors.claude;
    act(() => onSettingsUpdated!(next));

    expect(result.current.llmVendor).toBe("claude");
    expect(result.current.llmModel).toBe(LLM_VENDOR_DEFAULTS.claude.model);
    expect(result.current.enableThinkingChat).toBe(true);
  });

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
