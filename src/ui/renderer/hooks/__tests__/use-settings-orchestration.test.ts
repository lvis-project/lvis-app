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
    webSearch: { provider: "duckduckgo" },
    privacy: { piiRedactEnabled: false },
    marketplace: {
      cloudBaseUrl: "",
      cloudAllowPrivateNetwork: false,
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

function makeSettingsWithVendor(vendor: string, hostResolverMap?: string): AppSettings {
  const base = makeSettings();
  return {
    ...base,
    llm: {
      ...base.llm,
      provider: vendor as AppSettings["llm"]["provider"],
      vendors: {
        ...base.llm.vendors,
        [vendor]: {
          model: "some-model",
          enableThinking: true,
          thinkingBudgetTokens: 10_000,
        },
      },
      ...(hostResolverMap !== undefined ? { hostResolverMap } : {}),
    },
  } as AppSettings;
}

describe("useSettingsOrchestration", () => {
  // (B) Vendor default-selection fix: the hook now initialises vendor to ""
  // (empty string) instead of "claude", preventing a stale "claude" label
  // from flashing in the UI before the settings load effect hydrates the
  // persisted value. After hydration the vendor must match what was stored.
  it("initialises vendor to empty string before settings load (no stale 'claude' flash)", () => {
    const { api } = makeMockLvisApi({ settings: makeSettingsWithVendor("openai") });
    // Pause getSettings so we can inspect the pre-hydration state.
    let resolve: () => void;
    const blocked = new Promise<void>((r) => { resolve = r; });
    const blockedGetSettings = vi.fn(async () => { await blocked; return makeSettingsWithVendor("openai"); });
    Object.assign(api, { getSettings: blockedGetSettings });

    const { result } = renderHook(() => useSettingsOrchestration(api as unknown as LvisApi, vi.fn()));
    // Before hydration the vendor must be "" — not "claude".
    expect(result.current.vendor).toBe("");
    expect(result.current.settingsLoaded).toBe(false);
    // Unblock so further tests are clean.
    resolve!();
  });

  it("hydrates vendor from persisted settings on mount (not the old 'claude' default)", async () => {
    const settings = makeSettingsWithVendor("openai");
    const { api } = makeMockLvisApi({ settings, hasApiKey: false });
    Object.assign(api, {
      hasWebApiKey: vi.fn(async () => false),
      hasMarketplaceApiKey: vi.fn(async () => false),
    });

    const { result } = renderHook(() => useSettingsOrchestration(api as unknown as LvisApi, vi.fn()));
    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
    // After hydration: vendor must be "openai", not "claude".
    expect(result.current.vendor).toBe("openai");
  });

  it("hydrates hostResolverMap from persisted settings on mount", async () => {
    const expectedMap = "10.1.2.3 api.example.com\n10.4.5.6 cdn.example.com";
    const settings = makeSettingsWithVendor("openai", expectedMap);
    const { api } = makeMockLvisApi({ settings, hasApiKey: false });
    Object.assign(api, {
      hasWebApiKey: vi.fn(async () => false),
      hasMarketplaceApiKey: vi.fn(async () => false),
    });

    const { result } = renderHook(() => useSettingsOrchestration(api as unknown as LvisApi, vi.fn()));
    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
    expect(result.current.hostResolverMap).toBe(expectedMap);
  });

  it("defaults hostResolverMap to empty string when not present in settings", async () => {
    const settings = makeSettingsWithVendor("openai");
    const { api } = makeMockLvisApi({ settings, hasApiKey: false });
    Object.assign(api, {
      hasWebApiKey: vi.fn(async () => false),
      hasMarketplaceApiKey: vi.fn(async () => false),
    });

    const { result } = renderHook(() => useSettingsOrchestration(api as unknown as LvisApi, vi.fn()));
    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
    expect(result.current.hostResolverMap).toBe("");
  });

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
