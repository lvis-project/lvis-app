import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useSettingsOrchestration } from "../use-settings-orchestration.js";
import type { AppSettings, LvisApi } from "../../types.js";
import { makeMockLvisApi } from "../../../../../test/renderer/mock-lvis-api.js";
import { marketplaceProviderPresetSecretId } from "../../../../shared/marketplace-package-assets.js";

function makeSettings(): AppSettings {
  return {
    llm: {
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

function makeSettingsWithVendor(vendor: string): AppSettings {
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

  it("aborts a card's key persistence when settings:update returns reviewer-rewire-failed", async () => {
    const api = settingsOrchestrationApi({ ok: false, error: "reviewer-rewire-failed" });
    const onSaved = vi.fn();
    const { result } = renderHook(() => useSettingsOrchestration(api, onSaved));

    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));

    let saved = true;
    await act(async () => {
      saved = await result.current.saveProviderCredential({
        credentialProviderId: "openai-compatible",
        vendorId: "openai-compatible",
        apiKey: "sk-new-key",
        vendorBlock: { baseUrl: "https://gateway.example/v1" },
      });
    });

    expect(saved).toBe(false);
    expect(api.updateSettings).toHaveBeenCalled();
    // A key must never land beside an endpoint the store refused.
    expect(api.setApiKey).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(result.current.lastSaveError).toMatchObject({
      tab: "llm",
      message: expect.stringContaining("권한 검토 모델"),
    });
  });

  it("queues a card's save behind an in-flight one instead of dropping it", async () => {
    // A debounced llm save can be mid-flight when the user presses Save on a
    // provider card. The credential save used to return false on the spot and
    // say nothing, leaving the card looking committed with nothing written.
    let releaseFirstSave: (() => void) | undefined;
    const { api } = makeMockLvisApi({ settings: makeSettings(), hasApiKey: false });
    Object.assign(api, {
      updateSettings: vi.fn(async () => {
        await new Promise<void>((resolve) => { releaseFirstSave = resolve; });
        return { ok: true };
      }),
      hasWebApiKey: vi.fn(async () => false),
      hasMarketplaceApiKey: vi.fn(async () => false),
      setApiKey: vi.fn(async () => ({ ok: true })),
    });
    const { result } = renderHook(() =>
      useSettingsOrchestration(api as unknown as LvisApi, vi.fn())
    );
    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));

    let queued: Promise<boolean> | undefined;
    await act(async () => {
      void result.current.save("llm");
      await Promise.resolve();
      queued = result.current.saveProviderCredential({
        credentialProviderId: "claude",
        vendorId: "claude",
        apiKey: "sk-ant-queued",
      });
    });
    // Still in the queue: the key has not been written yet.
    expect(api.setApiKey).not.toHaveBeenCalled();

    await act(async () => {
      releaseFirstSave?.();
      expect(await queued).toBe(true);
    });
    expect(api.setApiKey).toHaveBeenCalledWith("claude", "sk-ant-queued");
  });

  it("writes a card's own block and secret without touching the active provider", async () => {
    const { api } = makeMockLvisApi({ settings: makeSettings(), hasApiKey: false });
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
    expect(result.current.vendor).toBe("openai");

    await act(async () => {
      await result.current.saveProviderCredential({
        credentialProviderId: "claude",
        vendorId: "claude",
        apiKey: "sk-ant-1",
      });
    });

    expect(api.setApiKey).toHaveBeenCalledWith("claude", "sk-ant-1");
    // No settings write at all: a fixed-endpoint vendor owns no field here,
    // and `llm.provider` is not this call's to move.
    expect(api.updateSettings).not.toHaveBeenCalled();
    expect(result.current.vendor).toBe("openai");
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
    });
    await waitFor(() => expect(result.current.vendor).toBe("openai-compatible"));

    let saved = false;
    await act(async () => {
      saved = await result.current.saveProviderCredential({
        credentialProviderId: marketplaceProviderPresetSecretId("future-router"),
        vendorId: "openai-compatible",
        apiKey: "fr-secret",
      });
      saved = await result.current.save("llm");
    });

    expect(saved).toBe(true);
    expect(api.updateSettings).toHaveBeenCalledWith(expect.objectContaining({
      llm: expect.objectContaining({
        provider: "openai-compatible",
        marketplaceProviderPresetId: "future-router",
        vendors: {
          // The preset's own slot, and NOT the block's `model` — that one is
          // the generic custom-provider row's, and a preset writing it is how
          // the two rows used to overwrite each other.
          "openai-compatible": expect.objectContaining({
            presetModels: { "future-router": "future/free" },
          }),
        },
      }),
    }));
    const savedBlock = (api.updateSettings as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => call[0] as { llm?: { vendors?: Record<string, { model?: string }> } })
      .filter((call) => Boolean(call.llm?.vendors))
      .at(-1)?.llm?.vendors?.["openai-compatible"];
    expect(savedBlock).not.toHaveProperty("model");
    // The preset's address is the registry's, never the generic row's block:
    // writing it here is what used to revert the generic card's own endpoint.
    const presetSave = (api.updateSettings as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => call[0] as { llm?: { vendors?: Record<string, { baseUrl?: string }> } })
      .filter((call) => Boolean(call.llm?.vendors))
      .at(-1);
    expect(presetSave?.llm?.vendors?.["openai-compatible"]?.baseUrl)
      .not.toBe("https://future.example/v1");
    expect(api.setApiKey).toHaveBeenCalledWith(
      marketplaceProviderPresetSecretId("future-router"),
      "fr-secret",
    );
    expect(onSaved).toHaveBeenCalled();
  });

  it("leaves the generic OpenAI-compatible endpoint alone across a preset selection", async () => {
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
    settings.llm.vendors["openai-compatible"] = {
      model: "local-model",
      baseUrl: "http://localhost:8001/v1",
      enableThinking: true,
      thinkingBudgetTokens: 10_000,
    };
    const { result } = renderHook(() =>
      useSettingsOrchestration(api as unknown as LvisApi, vi.fn())
    );
    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));

    act(() => {
      result.current.selectMarketplaceProviderPreset(futureRouter);
    });
    await waitFor(() => expect(result.current.vendor).toBe("openai-compatible"));
    // Selecting a preset must not park the preset's address in the generic
    // row's endpoint: that field is written back on every save.
    expect(result.current.baseUrl).toBe("http://localhost:8001/v1");

    act(() => {
      result.current.clearMarketplaceProviderPreset();
    });
    // And switching back restores the generic row's own endpoint rather than
    // resetting it to defaults.
    await waitFor(() => expect(result.current.baseUrl).toBe("http://localhost:8001/v1"));

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
      .toBe("http://localhost:8001/v1");
  });

  it("defaults idle long-term consolidation off and persists an explicit opt-in immediately", async () => {
    const settings = makeSettings();
    const updated: AppSettings = {
      ...settings,
      features: { idleMemoryConsolidation: true },
    };
    const { api } = makeMockLvisApi({ settings, hasApiKey: false });
    Object.assign(api, {
      updateSettings: vi.fn(async () => updated),
      hasWebApiKey: vi.fn(async () => false),
      hasMarketplaceApiKey: vi.fn(async () => false),
    });
    const onSaved = vi.fn();
    const { result } = renderHook(() =>
      useSettingsOrchestration(api as unknown as LvisApi, onSaved)
    );

    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
    expect(result.current.idleMemoryConsolidation).toBe(false);

    act(() => {
      result.current.setIdleMemoryConsolidation(true);
    });

    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({
      features: { idleMemoryConsolidation: true },
    }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(result.current.idleMemoryConsolidation).toBe(true);
  });

  it("defaults model-reviewed memory capture off and persists an explicit mode immediately", async () => {
    const settings = makeSettings();
    const updated: AppSettings = {
      ...settings,
      features: { memoryCaptureMode: "review" },
    };
    const { api } = makeMockLvisApi({ settings, hasApiKey: false });
    Object.assign(api, {
      updateSettings: vi.fn(async () => updated),
      hasWebApiKey: vi.fn(async () => false),
      hasMarketplaceApiKey: vi.fn(async () => false),
    });
    const onSaved = vi.fn();
    const { result } = renderHook(() =>
      useSettingsOrchestration(api as unknown as LvisApi, onSaved)
    );

    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
    expect(result.current.memoryCaptureMode).toBe("off");

    act(() => {
      result.current.setMemoryCaptureMode("review");
    });

    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({
      features: { memoryCaptureMode: "review" },
    }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(result.current.memoryCaptureMode).toBe("review");
  });

  it("defaults autonomous sub-agent wake off and persists an opt-in immediately", async () => {
    const settings = makeSettings();
    const updated: AppSettings = {
      ...settings,
      features: { subAgentAutonomousWake: true },
    };
    const { api } = makeMockLvisApi({ settings, hasApiKey: false });
    Object.assign(api, {
      updateSettings: vi.fn(async () => updated),
      hasWebApiKey: vi.fn(async () => false),
      hasMarketplaceApiKey: vi.fn(async () => false),
    });
    const onSaved = vi.fn();
    const { result } = renderHook(() =>
      useSettingsOrchestration(api as unknown as LvisApi, onSaved)
    );

    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
    expect(result.current.subAgentAutonomousWake).toBe(false);

    act(() => {
      result.current.setSubAgentAutonomousWake(true);
    });

    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({
      features: { subAgentAutonomousWake: true },
    }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(result.current.subAgentAutonomousWake).toBe(true);
  });

  it("hydrates autonomous sub-agent wake from persisted settings", async () => {
    const settings = makeSettings();
    settings.features = { subAgentAutonomousWake: true };
    const { api } = makeMockLvisApi({ settings, hasApiKey: false });
    Object.assign(api, {
      hasWebApiKey: vi.fn(async () => false),
      hasMarketplaceApiKey: vi.fn(async () => false),
    });
    const { result } = renderHook(() =>
      useSettingsOrchestration(api as unknown as LvisApi, vi.fn())
    );

    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
    expect(result.current.subAgentAutonomousWake).toBe(true);
  });

  it("keeps every openai-compatible row's model to itself", async () => {
    // Three rows are reached through one vendor — the generic custom provider
    // and two marketplace presets — and each has its own model. They used to
    // share the block's single `model`, so choosing on one row silently
    // rewrote the others.
    const alpha = {
      providerId: "alpha-gw",
      label: "Alpha Gateway",
      baseUrl: "https://alpha.example/v1",
      defaultModel: "alpha/seed",
      modelOptions: ["alpha/seed"],
      requiresApiKey: true,
    };
    const beta = { ...alpha, providerId: "beta-gw", label: "Beta Gateway", baseUrl: "https://beta.example/v1", defaultModel: "beta/seed", modelOptions: ["beta/seed"] };
    const settings = makeSettings();
    settings.llm.vendors["openai-compatible"] = {
      model: "local-model",
      baseUrl: "http://localhost:8001/v1",
      presetModels: { "beta-gw": "beta/chosen" },
      enableThinking: true,
      thinkingBudgetTokens: 10_000,
    };
    settings.marketplace = {
      ...settings.marketplace,
      installedProviderPresets: [alpha, beta],
    };
    const { api } = makeMockLvisApi({ settings, hasApiKey: false });
    Object.assign(api, {
      updateSettings: vi.fn(async () => ({ ok: true })),
      hasWebApiKey: vi.fn(async () => false),
      hasMarketplaceApiKey: vi.fn(async () => false),
    });
    const { result } = renderHook(() =>
      useSettingsOrchestration(api as unknown as LvisApi, vi.fn())
    );
    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));

    act(() => { result.current.selectMarketplaceProviderPreset(alpha); });
    await waitFor(() => expect(result.current.marketplaceProviderPresetId).toBe("alpha-gw"));
    act(() => { result.current.setModel("alpha/chosen"); });
    await act(async () => { await result.current.save("llm"); });

    const block = (api.updateSettings as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => call[0] as { llm?: { vendors?: Record<string, {
        model?: string; presetModels?: Record<string, string>;
      }> } })
      .filter((call) => Boolean(call.llm?.vendors))
      .at(-1)?.llm?.vendors?.["openai-compatible"];
    // Alpha's pick lands in alpha's slot; beta's stays exactly as stored, and
    // the generic row's `model` is not written at all, so it survives the merge.
    expect(block?.presetModels).toEqual({ "beta-gw": "beta/chosen", "alpha-gw": "alpha/chosen" });
    expect(block).not.toHaveProperty("model");

    // Switching rows restores what each row was last set to.
    act(() => { result.current.selectMarketplaceProviderPreset(beta); });
    await waitFor(() => expect(result.current.model).toBe("beta/chosen"));
    act(() => { result.current.clearMarketplaceProviderPreset(); });
    await waitFor(() => expect(result.current.model).toBe("local-model"));
  });});
