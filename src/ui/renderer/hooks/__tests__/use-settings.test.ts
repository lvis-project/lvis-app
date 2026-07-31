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

  it("never writes API thinking while settings are unresolved or subscription chat is selected", async () => {
    const subscriptionSettings = makeSettings();
    subscriptionSettings.llm.activeChatRuntime = { kind: "subscription", provider: "codex" };
    let resolveSettings!: (settings: AppSettings) => void;
    const pendingSettings = new Promise<AppSettings>((resolve) => {
      resolveSettings = resolve;
    });
    const { api } = makeMockLvisApi({ settings: subscriptionSettings, hasApiKey: true });
    api.getSettings = vi.fn(() => pendingSettings);

    const { result } = renderHook(() => useSettings(api as unknown as LvisApi));

    // Before hydration a delayed persisted subscription must not let the
    // initial API thinking default persist against the inactive vendor.
    await act(async () => {
      await result.current.toggleThinking(false);
    });
    expect(api.updateSettings).not.toHaveBeenCalled();

    await act(async () => {
      resolveSettings(subscriptionSettings);
      await pendingSettings;
    });
    await waitFor(() => expect(result.current.activeSubscriptionRuntime).toEqual({
      kind: "subscription",
      provider: "codex",
    }));

    await act(async () => {
      await result.current.toggleThinking(false);
    });
    expect(api.updateSettings).not.toHaveBeenCalled();
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

  it("uses only an explicitly chat-capable selected subscription runtime as no-key chat readiness", async () => {
    const settings = makeSettings();
    settings.llm.activeChatRuntime = { kind: "subscription", provider: "codex" };
    const { api } = makeMockLvisApi({ settings, hasApiKey: false });
    api.subscriptionRuntimeStatus = vi.fn(async () => ({
      ok: true,
      status: {
        provider: "codex",
        runtime: "ready",
        connection: "connected",
        planType: "subscription",
        pendingLogin: null,
        pendingDeviceCode: null,
        canOpenVerificationUrl: false,
        version: "test",
        capabilities: {
          chat: true,
          tools: false,
          projectAccess: false,
          plugins: false,
          mcp: false,
          generateText: false,
          compaction: false,
          routine: false,
          subagent: false,
          images: true,
          imageAttachmentLimits: {
            maxCount: 5,
            maxBytesPerImage: 25 * 1024 * 1024,
            maxTotalBytes: 25 * 1024 * 1024,
          },
          files: true,
        },
      },
    }));

    const { result } = renderHook(() => useSettings(api as unknown as LvisApi));

    await waitFor(() => {
      expect(result.current.activeSubscriptionRuntime).toEqual({ kind: "subscription", provider: "codex" });
      expect(result.current.subscriptionChatReady).toBe(true);
      expect(result.current.subscriptionImagesReady).toBe(true);
      expect(result.current.subscriptionFilesReady).toBe(true);
    });
    expect(api.subscriptionRuntimeStatus).toHaveBeenCalledWith("codex");
  });

  it("fails closed synchronously when an active subscription status revision arrives", async () => {
    const settings = makeSettings();
    settings.llm.activeChatRuntime = { kind: "subscription", provider: "codex" };
    const { api, emitSubscriptionRuntimeStatusUpdated } = makeMockLvisApi({ settings, hasApiKey: false });
    api.subscriptionRuntimeStatus = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: {
          provider: "codex",
          runtime: "ready",
          connection: "connected",
          planType: "subscription",
          pendingLogin: null,
          pendingDeviceCode: null,
          canOpenVerificationUrl: false,
          version: "test",
          capabilities: {
            chat: true,
            tools: false,
            projectAccess: false,
            plugins: false,
            mcp: false,
            generateText: false,
            compaction: false,
            routine: false,
            subagent: false,
            images: true,
            imageAttachmentLimits: {
              maxCount: 5,
              maxBytesPerImage: 25 * 1024 * 1024,
              maxTotalBytes: 25 * 1024 * 1024,
            },
            files: true,
          },
        },
      })
      .mockImplementation(() => new Promise<never>(() => {}));

    const { result } = renderHook(() => useSettings(api as unknown as LvisApi));
    await waitFor(() => {
      expect(result.current.subscriptionRuntimePolicy.chatReady).toBe(true);
      expect(result.current.subscriptionRuntimePolicy.imagesEnabled).toBe(true);
      expect(result.current.subscriptionRuntimePolicy.filesEnabled).toBe(true);
    });

    act(() => {
      emitSubscriptionRuntimeStatusUpdated({ provider: "codex", revision: 1 });
    });

    // The event invalidates the old safe projection before its re-probe settles,
    // so send, picker, paste, and file ingress all see a non-permissive policy.
    expect(result.current.subscriptionRuntimePolicy.chatReady).toBeNull();
    expect(result.current.subscriptionRuntimePolicy.imagesReady).toBeNull();
    expect(result.current.subscriptionRuntimePolicy.filesReady).toBeNull();
    expect(result.current.subscriptionRuntimePolicy.attachmentInputsReady).toBe(false);
    expect(result.current.subscriptionRuntimePolicy.imagesEnabled).toBe(false);
    expect(result.current.subscriptionRuntimePolicy.filesEnabled).toBe(false);
  });

  it("fails closed when the selected subscription runtime has not verified chat capability", async () => {
    const settings = makeSettings();
    settings.llm.activeChatRuntime = { kind: "subscription", provider: "codex", model: "gpt-5.4" };
    const { api } = makeMockLvisApi({ settings, hasApiKey: false });
    api.subscriptionRuntimeStatus = vi.fn(async () => ({
      ok: false,
      error: { code: "subscription-runtime-not-configured", message: "not configured" },
    }));

    const { result } = renderHook(() => useSettings(api as unknown as LvisApi));

    await waitFor(() => {
      expect(result.current.activeSubscriptionRuntime).toEqual({ kind: "subscription", provider: "codex", model: "gpt-5.4" });
      expect(result.current.subscriptionChatReady).toBe(false);
      expect(result.current.subscriptionImagesReady).toBe(false);
      expect(result.current.subscriptionFilesReady).toBe(false);
    });
    expect(api.subscriptionRuntimeStatus).toHaveBeenCalledWith("codex");
  });
});
