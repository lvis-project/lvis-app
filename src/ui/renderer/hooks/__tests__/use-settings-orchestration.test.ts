import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useSettingsOrchestration } from "../use-settings-orchestration.js";
import type { AppSettings, LvisApi } from "../../types.js";

function makeSettings(): AppSettings {
  return {
    llm: {
      authMode: "manual",
      provider: "openai",
      vendors: {
        openai: {
          model: "gpt-4o",
          enableThinking: true,
          thinkingBudgetTokens: 10_000,
        },
      },
      streamSmoothing: "none",
      fallbackChain: [],
    },
    chat: { systemPrompt: "", autoCompact: true },
    roles: { presets: [] },
    webSearch: { provider: "duckduckgo" },
    privacy: { piiRedactEnabled: false },
    marketplace: {
      realCloudBaseUrl: "",
      realCloudAllowPrivateNetwork: false,
    },
  };
}

function makeApi(updateResult: Awaited<ReturnType<LvisApi["updateSettings"]>>): LvisApi {
  const settings = makeSettings();
  return {
    getSettings: vi.fn(async () => settings),
    updateSettings: vi.fn(async () => updateResult),
    onSettingsUpdated: vi.fn(() => () => undefined),
    hasApiKey: vi.fn(async () => false),
    hasWebApiKey: vi.fn(async () => false),
    hasMarketplaceApiKey: vi.fn(async () => false),
    setApiKey: vi.fn(async () => ({ ok: true as const })),
    setWebApiKey: vi.fn(async () => ({ ok: true as const })),
    setMarketplaceApiKey: vi.fn(async () => ({ ok: true as const })),
  } as unknown as LvisApi;
}

describe("useSettingsOrchestration", () => {
  it("aborts LLM key persistence when settings:update returns reviewer-rewire-failed", async () => {
    const api = makeApi({ ok: false, error: "reviewer-rewire-failed" });
    const onSaved = vi.fn();
    const { result } = renderHook(() => useSettingsOrchestration(api, onSaved));

    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
    act(() => {
      result.current.setKeyInput("sk-new-key");
    });
    await waitFor(() => expect(result.current.keyInput).toBe("sk-new-key"));

    let saved = true;
    await act(async () => {
      saved = await result.current.save("llm");
    });

    expect(saved).toBe(false);
    expect(api.updateSettings).toHaveBeenCalled();
    expect(api.setApiKey).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(result.current.lastSaveError).toMatchObject({
      tab: "llm",
      message: expect.stringContaining("권한 검토 모델"),
    });
  });
});
