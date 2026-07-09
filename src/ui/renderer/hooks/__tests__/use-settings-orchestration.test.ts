import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useSettingsOrchestration } from "../use-settings-orchestration.js";
import type { AppSettings, LvisApi } from "../../types.js";
import { makeMockLvisApi } from "../../../../../test/renderer/mock-lvis-api.js";
import { marketplaceProviderPresetSecretId } from "../../../../shared/marketplace-package-assets.js";

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

  it("persists custom marketplace provider presets through openai-compatible with a preset-scoped key", async () => {
    const settings = makeSettings();
    const futureRouter = {
      providerId: "future-router",
      label: "Future Router",
      baseUrl: "https://future.example/v1",
      defaultModel: "future/free",
      modelOptions: ["future/free"],
      requiresApiKey: true,
    };
    settings.marketplace = {
      ...settings.marketplace,
      installedProviderPresets: [futureRouter],
    };
    const { api } = makeMockLvisApi({ settings, hasApiKey: false });
    Object.assign(api, {
      updateSettings: vi.fn(async () => ({ ok: true })),
      hasWebApiKey: vi.fn(async () => false),
      hasMarketplaceApiKey: vi.fn(async () => false),
      setApiKey: vi.fn(async () => ({ ok: true })),
    });
    const onSaved = vi.fn();
    const { result } = renderHook(() =>
      useSettingsOrchestration(api as unknown as LvisApi, onSaved)
    );
    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));

    act(() => {
      result.current.selectMarketplaceProviderPreset(futureRouter);
      result.current.setKeyInput("fr-secret");
    });
    await waitFor(() => expect(result.current.vendor).toBe("openai-compatible"));

    let saved = false;
    await act(async () => {
      saved = await result.current.save("llm");
    });

    expect(saved).toBe(true);
    expect(api.updateSettings).toHaveBeenCalledWith(expect.objectContaining({
      llm: expect.objectContaining({
        provider: "openai-compatible",
        marketplaceProviderPresetId: "future-router",
        vendors: {
          "openai-compatible": expect.objectContaining({
            baseUrl: "https://future.example/v1",
            model: "future/free",
          }),
        },
      }),
    }));
    expect(api.setApiKey).toHaveBeenCalledWith(
      marketplaceProviderPresetSecretId("future-router"),
      "fr-secret",
    );
    expect(onSaved).toHaveBeenCalled();
  });

  it("restores generic OpenAI-compatible defaults when clearing a marketplace provider preset", async () => {
    const settings = makeSettings();
    const futureRouter = {
      providerId: "future-router",
      label: "Future Router",
      baseUrl: "https://future.example/v1",
      defaultModel: "future/free",
      modelOptions: ["future/free"],
      requiresApiKey: true,
    };
    settings.marketplace = {
      ...settings.marketplace,
      installedProviderPresets: [futureRouter],
    };
    const { api } = makeMockLvisApi({ settings, hasApiKey: false });
    Object.assign(api, {
      updateSettings: vi.fn(async () => ({ ok: true })),
      hasWebApiKey: vi.fn(async () => false),
      hasMarketplaceApiKey: vi.fn(async () => false),
      setApiKey: vi.fn(async () => ({ ok: true })),
    });
    const { result } = renderHook(() =>
      useSettingsOrchestration(api as unknown as LvisApi, vi.fn())
    );
    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));

    act(() => {
      result.current.selectMarketplaceProviderPreset(futureRouter);
    });
    await waitFor(() => expect(result.current.baseUrl).toBe("https://future.example/v1"));

    act(() => {
      result.current.clearMarketplaceProviderPreset();
    });
    await waitFor(() => expect(result.current.baseUrl).not.toBe("https://future.example/v1"));

    await act(async () => {
      await result.current.save("llm");
    });

    const payload = (api.updateSettings as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
    expect(payload).toMatchObject({
      llm: {
        provider: "openai-compatible",
        marketplaceProviderPresetId: "",
      },
    });
    expect(payload.llm.vendors["openai-compatible"].baseUrl)
      .not.toBe("https://future.example/v1");
  });

  // ①안 — the settings Model tab is manual-only now. Saving the LLM tab WITH a
  // manual key transitions a former demo user (authMode="login") to manual and
  // persists their own key + vendor draft (previously blocked by login mode).
  it("transitions a demo user (authMode='login') to manual when they save an LLM key", async () => {
    const settings = makeSettings();
    settings.llm.authMode = "login";
    const { api } = makeMockLvisApi({ settings, hasApiKey: false });
    Object.assign(api, {
      updateSettings: vi.fn(async () => ({ ok: true })),
      hasWebApiKey: vi.fn(async () => false),
      hasMarketplaceApiKey: vi.fn(async () => false),
      setApiKey: vi.fn(async () => ({ ok: true })),
    });
    const onSaved = vi.fn();
    const { result } = renderHook(() =>
      useSettingsOrchestration(api as unknown as LvisApi, onSaved)
    );
    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
    await waitFor(() => expect(result.current.authMode).toBe("login"));

    act(() => {
      result.current.setKeyInput("sk-my-own-key");
    });
    await waitFor(() => expect(result.current.keyInput).toBe("sk-my-own-key"));

    await act(async () => {
      await result.current.save("llm");
    });

    const payload = (api.updateSettings as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
    expect(payload.llm.authMode).toBe("manual");
    // The manual vendor draft is now persisted (login mode no longer skips it).
    expect(payload.llm.vendors).toBeDefined();
    // The user's own key is persisted for the active vendor.
    expect(api.setApiKey).toHaveBeenCalledWith("openai", "sk-my-own-key");
  });

  // ①안 (guard) — a keyless LLM save must NOT force-rewrite authMode: a demo
  // user who only tweaks an immediate-apply control keeps their trial endpoint.
  it("keeps a demo user on authMode='login' for a keyless LLM save", async () => {
    const settings = makeSettings();
    settings.llm.authMode = "login";
    const { api } = makeMockLvisApi({ settings, hasApiKey: false });
    Object.assign(api, {
      updateSettings: vi.fn(async () => ({ ok: true })),
      hasWebApiKey: vi.fn(async () => false),
      hasMarketplaceApiKey: vi.fn(async () => false),
      setApiKey: vi.fn(async () => ({ ok: true })),
    });
    const { result } = renderHook(() =>
      useSettingsOrchestration(api as unknown as LvisApi, vi.fn())
    );
    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
    await waitFor(() => expect(result.current.authMode).toBe("login"));

    await act(async () => {
      await result.current.save("llm");
    });

    const payload = (api.updateSettings as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
    expect(payload.llm.authMode).toBe("login");
    // Host-managed fields are left untouched and no key is persisted.
    expect(payload.llm.vendors).toBeUndefined();
    expect(api.setApiKey).not.toHaveBeenCalled();
  });
});
