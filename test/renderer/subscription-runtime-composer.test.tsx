import "./setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, waitFor } from "@testing-library/react";
import { renderApp } from "./render-app.js";
import { submitChatMessage } from "./helpers.js";
import { fakeLlmSettings } from "../../src/shared/__tests__/fake-llm-settings.js";

const CODEX_CHAT_READY = {
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
};

function subscriptionChatReady(provider: "codex" | "kimi-code") {
  return {
    ...CODEX_CHAT_READY,
    status: {
      ...CODEX_CHAT_READY.status,
      provider,
    },
  };
}

const SUBSCRIPTION_UNAVAILABLE = {
  ok: false,
  error: { code: "subscription-runtime-not-configured", message: "not configured" },
};

describe("subscription runtime composer readiness", () => {
  it("hides fallback API usage projections until a delayed subscription settings snapshot is authoritative", async () => {
    const settings = {
      llm: {
        ...fakeLlmSettings({ provider: "openai", model: "gpt-5.4-nano" }),
        activeChatRuntime: { kind: "subscription" as const, provider: "codex" as const },
      },
      chat: { systemPrompt: "", autoCompact: true },
      webSearch: { provider: "none" },
      routine: {},
      privacy: { piiRedactEnabled: false },
    };
    let resolveSettings!: (value: typeof settings) => void;
    const delayedSettings = new Promise<typeof settings>((resolve) => {
      resolveSettings = resolve;
    });
    const { container, api } = await renderApp({
      hasApiKey: true,
      getSettings: () => delayedSettings,
      subscriptionRuntimeStatus: CODEX_CHAT_READY,
    });

    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());
    // The initial renderer defaults are API settings, but the persisted active
    // runtime is unknown until this promise resolves. Do not briefly present
    // those default pricing/context values as subscription usage.
    expect(container.querySelector('[data-testid="token-progress-ring"]')).toBeNull();
    expect(container.querySelector('[data-testid="token-cost-badge"]')).toBeNull();
    // The persisted runtime might be a subscription, whose effort setting is
    // provider-owned. Do not briefly expose the API-only control before the
    // authoritative selection has loaded.
    expect(container.querySelector('[data-testid="iab-status-reasoning"]')).toBeNull();

    resolveSettings(settings);
    await waitFor(() => expect(api.subscriptionRuntimeStatus).toHaveBeenCalledWith("codex"));
    await waitFor(() => {
      expect(container.querySelector('[data-testid="token-progress-ring"]')).toBeNull();
      expect(container.querySelector('[data-testid="token-cost-badge"]')).toBeNull();
      expect(container.querySelector('[data-testid="iab-status-reasoning"]')).toBeNull();
    });
  });

  it("enables the composer and sends with no API key only after chat capability is verified", async () => {
    const { container, api } = await renderApp({
      hasApiKey: false,
      subscriptionRuntimeStatus: CODEX_CHAT_READY,
      settings: {
        llm: {
          ...fakeLlmSettings({ provider: "openai", model: "gpt-4o-mini" }),
          activeChatRuntime: { kind: "subscription", provider: "codex" },
        },
        chat: { systemPrompt: "", autoCompact: true },
        webSearch: { provider: "none" },
        routine: {},
        privacy: { piiRedactEnabled: false },
      },
    });

    await waitFor(() => expect(api.subscriptionRuntimeStatus).toHaveBeenCalledWith("codex"));
    await waitFor(() => {
      const textarea = container.querySelector("textarea") as HTMLTextAreaElement | null;
      expect(textarea).toBeTruthy();
      expect(textarea?.disabled).toBe(false);
      expect(container.querySelector('[data-testid="composer-api-key-chip"]')).toBeNull();
      expect(container.querySelector('[data-testid="iab-status-reasoning"]')).toBeNull();
      expect(container.querySelector('[data-testid="token-progress-ring"]')).toBeNull();
      const attach = container.querySelector('[data-testid="iab-attach-button"]') as HTMLButtonElement | null;
      expect(attach?.disabled).toBe(false);
      expect(attach?.title).toContain("첨부");
    });

    await submitChatMessage(container, "subscription-only chat");
    await waitFor(() => expect(api.chatSend).toHaveBeenCalled());
  });

  it("keeps raw attachment controls blocked when chat is ready but attachment egress is not verified", async () => {
    const { container, api } = await renderApp({
      hasApiKey: false,
      subscriptionRuntimeStatus: {
        ...CODEX_CHAT_READY,
        status: {
          ...CODEX_CHAT_READY.status,
          capabilities: {
            ...CODEX_CHAT_READY.status.capabilities,
            images: false,
            files: false,
          },
        },
      },
      settings: {
        llm: {
          ...fakeLlmSettings({ provider: "openai", model: "gpt-4o-mini" }),
          activeChatRuntime: { kind: "subscription", provider: "codex" },
        },
        chat: { systemPrompt: "", autoCompact: true },
        webSearch: { provider: "none" },
        routine: {},
        privacy: { piiRedactEnabled: false },
      },
    });

    await waitFor(() => expect(api.subscriptionRuntimeStatus).toHaveBeenCalledWith("codex"));
    await waitFor(() => {
      const attach = container.querySelector('[data-testid="iab-attach-button"]') as HTMLButtonElement | null;
      expect(attach?.disabled).toBe(true);
      expect(attach?.title).toContain("구독 런타임");
    });
  });

  it("keeps the picker available when the verified file flow is available but native images are not", async () => {
    const { container, api } = await renderApp({
      hasApiKey: false,
      subscriptionRuntimeStatus: {
        ...CODEX_CHAT_READY,
        status: {
          ...CODEX_CHAT_READY.status,
          capabilities: {
            ...CODEX_CHAT_READY.status.capabilities,
            images: false,
            files: true,
          },
        },
      },
      settings: {
        llm: {
          ...fakeLlmSettings({ provider: "openai", model: "gpt-4o-mini" }),
          activeChatRuntime: { kind: "subscription", provider: "codex" },
        },
        chat: { systemPrompt: "", autoCompact: true },
        webSearch: { provider: "none" },
        routine: {},
        privacy: { piiRedactEnabled: false },
      },
    });

    await waitFor(() => expect(api.subscriptionRuntimeStatus).toHaveBeenCalledWith("codex"));
    await waitFor(() => {
      const attach = container.querySelector('[data-testid="iab-attach-button"]') as HTMLButtonElement | null;
      expect(attach?.disabled).toBe(false);
    });

    const nativeAttach = {
      openFile: vi.fn(async () => ({
        canceled: false,
        rejected: [],
        files: [
          {
            path: "C:/workspace/blocked-image.png",
            name: "blocked-image.png",
            ext: "png",
            bytes: 8,
            isImage: true,
          },
          {
            path: "C:/workspace/allowed-file.md",
            name: "allowed-file.md",
            ext: "md",
            bytes: 8,
            isImage: false,
          },
        ],
      })),
      readImage: vi.fn(async () => ({ ok: false, error: "must not read blocked image" })),
      saveClipboardImage: vi.fn(async () => ({ ok: false })),
      openExternal: vi.fn(async () => ({ ok: true })),
    };
    (window.lvis as unknown as { attach: typeof nativeAttach }).attach = nativeAttach;
    fireEvent.click(container.querySelector('[data-testid="iab-attach-button"]')!);

    await waitFor(() => {
      const textarea = container.querySelector('[data-testid="composer-textarea"]') as HTMLTextAreaElement;
      expect(textarea.value).toContain("[File #1]");
      expect(textarea.value).not.toContain("[Image #");
    });
    expect(nativeAttach.readImage).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(container.querySelector('[data-testid="status-toast-message"]')?.textContent).toContain("첨부 유형");
    });
  });

  it("forwards a verified native image attachment to chatSend", async () => {
    const { container, api } = await renderApp({
      hasApiKey: false,
      subscriptionRuntimeStatus: CODEX_CHAT_READY,
      settings: {
        llm: {
          ...fakeLlmSettings({ provider: "openai", model: "gpt-4o-mini" }),
          activeChatRuntime: { kind: "subscription", provider: "codex" },
        },
        chat: { systemPrompt: "", autoCompact: true },
        webSearch: { provider: "none" },
        routine: {},
        privacy: { piiRedactEnabled: false },
      },
    });

    const nativeAttach = {
      openFile: vi.fn(async () => ({
        canceled: false,
        rejected: [],
        files: [{
          path: "C:/workspace/verified-image.png",
          name: "verified-image.png",
          ext: "png",
          bytes: 2048,
          isImage: true,
        }],
      })),
      readImage: vi.fn(async () => ({
        ok: true,
        dataUrl: "data:image/png;base64,VERIFIED",
        mimeType: "image/png",
        width: 24,
        height: 16,
        bytes: 2048,
      })),
      saveClipboardImage: vi.fn(async () => ({ ok: false })),
      openExternal: vi.fn(async () => ({ ok: true })),
    };
    (window.lvis as unknown as { attach: typeof nativeAttach }).attach = nativeAttach;

    await waitFor(() => {
      const attach = container.querySelector('[data-testid="iab-attach-button"]') as HTMLButtonElement | null;
      expect(attach?.disabled).toBe(false);
    });
    fireEvent.click(container.querySelector('[data-testid="iab-attach-button"]')!);

    const textarea = container.querySelector('[data-testid="composer-textarea"]') as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toContain("[Image #1]"));
    fireEvent.change(textarea, { target: { value: `Inspect this ${textarea.value}` } });
    fireEvent.keyDown(textarea, { key: "Enter", code: "Enter" });

    await waitFor(() => expect(api.chatSend).toHaveBeenCalledTimes(1));
    const sentAttachments = api.chatSend.mock.calls[0]?.[1] as Array<{
      type?: string;
      mimeType?: string;
      image?: string;
    }>;
    expect(sentAttachments).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "image",
        mimeType: "image/png",
        image: "data:image/png;base64,VERIFIED",
      }),
    ]));
  });

  it("does not revive an unavailable subscription selection with a stored API key", async () => {
    const { container, api } = await renderApp({
      // This is deliberately true: it belongs to the inactive legacy OpenAI
      // configuration and must not make the Codex selection sendable.
      hasApiKey: true,
      subscriptionRuntimeStatus: SUBSCRIPTION_UNAVAILABLE,
      settings: {
        llm: {
          ...fakeLlmSettings({ provider: "openai", model: "gpt-5.4-nano" }),
          activeChatRuntime: { kind: "subscription", provider: "codex" },
        },
        chat: { systemPrompt: "", autoCompact: true },
        webSearch: { provider: "none" },
        routine: {},
        privacy: { piiRedactEnabled: false },
      },
    });

    await waitFor(() => expect(api.subscriptionRuntimeStatus).toHaveBeenCalledWith("codex"));
    await waitFor(() => {
      expect(container.querySelector('[data-testid="composer-api-key-chip"]')).toBeNull();
      expect(container.querySelector('[data-testid="composer-subscription-runtime-chip"]')).toBeTruthy();
      // Preserve the draft, but make every send path visibly unavailable.
      expect((container.querySelector("textarea") as HTMLTextAreaElement | null)?.disabled).toBe(false);
      expect((container.querySelector('[data-testid="composer-send-button"]') as HTMLButtonElement | null)?.disabled).toBe(true);
      expect(container.querySelector('[data-testid="sidebar-settings"]')?.textContent).not.toContain("API");
    });
  });

  it.each(["codex", "kimi-code"] as const)(
    "does not expose stale API billing or context UI for a ready %s subscription",
    async (provider) => {
      const { container, api } = await renderApp({
        // This configuration is deliberately stale: it belongs to inactive
        // API-key OpenAI settings, not the selected subscription runtime.
        hasApiKey: true,
        subscriptionRuntimeStatus: subscriptionChatReady(provider),
        settings: {
          llm: {
            ...fakeLlmSettings({ provider: "openai", model: "gpt-5.4-nano" }),
            activeChatRuntime: { kind: "subscription", provider },
          },
          chat: { systemPrompt: "", autoCompact: true },
          webSearch: { provider: "none" },
          routine: {},
          privacy: { piiRedactEnabled: false },
        },
      });

      await waitFor(() => expect(api.subscriptionRuntimeStatus).toHaveBeenCalledWith(provider));
      await waitFor(() => {
        expect(container.querySelector('[data-testid="composer-api-key-chip"]')).toBeNull();
        expect(container.querySelector('[data-testid="token-progress-ring"]')).toBeNull();
        expect(container.querySelector('[data-testid="token-progress-ring-detail"]')).toBeNull();
      });
    },
  );

  it.each([
    ["codex", "gpt-5.4", "Codex · gpt-5.4"],
    ["kimi-code", "", "Kimi Code"],
  ] as const)(
    "shows the selected %s subscription runtime rather than the stale API provider in the status row",
    async (provider, model, expectedLabel) => {
      const { container, api } = await renderApp({
        hasApiKey: true,
        subscriptionRuntimeStatus: subscriptionChatReady(provider),
        settings: {
          llm: {
            ...fakeLlmSettings({ provider: "openai", model: "gpt-5.4-nano" }),
            activeChatRuntime: model
              ? { kind: "subscription", provider, model }
              : { kind: "subscription", provider },
          },
          chat: { systemPrompt: "", autoCompact: true },
          webSearch: { provider: "none" },
          routine: {},
          privacy: { piiRedactEnabled: false },
        },
      });

      await waitFor(() => expect(api.subscriptionRuntimeStatus).toHaveBeenCalledWith(provider));
      await waitFor(() => {
        const modelCell = container.querySelector('[data-testid="iab-status-model"]');
        expect(modelCell?.getAttribute("title")).toBe(expectedLabel);
        expect(container.querySelector('[data-testid="iab-status-active-dot"]')?.className).toContain("bg-success");
      });
    },
  );

  it("keeps a subscription selection non-sendable while readiness is checking", async () => {
    let resolveStatus!: (value: typeof CODEX_CHAT_READY) => void;
    const pendingStatus = new Promise<typeof CODEX_CHAT_READY>((resolve) => {
      resolveStatus = resolve;
    });
    const { container, api } = await renderApp({
      // A legacy key must not revive a subscription selection before its login
      // status has been verified.
      hasApiKey: true,
      subscriptionRuntimeStatus: pendingStatus,
      settings: {
        llm: {
          ...fakeLlmSettings({ provider: "openai", model: "gpt-5.4-nano" }),
          activeChatRuntime: { kind: "subscription", provider: "codex" },
        },
        chat: { systemPrompt: "", autoCompact: true },
        webSearch: { provider: "none" },
        routine: {},
        privacy: { piiRedactEnabled: false },
      },
    });

    await waitFor(() => expect(api.subscriptionRuntimeStatus).toHaveBeenCalledWith("codex"));
    await waitFor(() => {
      // A pending probe is non-sendable without destroying an in-progress draft.
      expect((container.querySelector("textarea") as HTMLTextAreaElement | null)?.disabled).toBe(false);
      expect((container.querySelector('[data-testid="composer-send-button"]') as HTMLButtonElement | null)?.disabled).toBe(true);
      const attach = container.querySelector('[data-testid="iab-attach-button"]') as HTMLButtonElement | null;
      expect(attach?.disabled).toBe(true);
      expect(attach?.title).toContain("연결 확인 중");
      expect(container.querySelector('[data-testid="composer-api-key-chip"]')).toBeNull();
      expect(container.querySelector('[data-testid="composer-subscription-runtime-chip"]')).toBeTruthy();
      expect(container.querySelector('[data-testid="sidebar-settings"]')?.textContent).not.toContain("API");
    });

    // Resolve so the intentionally deferred mock cannot retain test state.
    resolveStatus(CODEX_CHAT_READY);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
