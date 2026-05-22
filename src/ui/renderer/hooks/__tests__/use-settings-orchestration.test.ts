import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useSettingsOrchestration } from "../use-settings-orchestration.js";
import type { AppSettings, LvisApi } from "../../types.js";
import { makeMockLvisApi } from "../../../../../test/renderer/mock-lvis-api.js";

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

function settingsOrchestrationApi(updateResult: Awaited<ReturnType<LvisApi["updateSettings"]>>): LvisApi {
  const settings = makeSettings();
  const { api } = makeMockLvisApi({
    settings,
    hasApiKey: false,
  });
  Object.assign(api, {
    updateSettings: vi.fn(async () => updateResult),
    hasWebApiKey: vi.fn(async () => false),
    hasMarketplaceApiKey: vi.fn(async () => false),
  });
  return api as unknown as LvisApi;
}

describe("useSettingsOrchestration", () => {
  it("aborts LLM key persistence when settings:update returns reviewer-rewire-failed", async () => {
    const api = settingsOrchestrationApi({ ok: false, error: "reviewer-rewire-failed" });
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
