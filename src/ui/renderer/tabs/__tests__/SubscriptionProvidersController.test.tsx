import "../../../../../test/renderer/setup.js";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLocale, setLocale } from "../../../../i18n/runtime.js";
import type {
  SubscriptionRuntimeId,
  SubscriptionRuntimeStatus,
  SubscriptionRuntimeStatusUpdatedEvent,
} from "../../../../shared/subscription-runtime.js";
import type { AppSettings, LvisApi } from "../../types.js";
import { useSubscriptionProviders } from "../SubscriptionProvidersController.js";
import { SubscriptionAuthControls } from "../SubscriptionProvidersSection.js";

/**
 * What the settings tab does with the hook, in one place.
 *
 * The hook used to BE this component. It became a hook because the model
 * chooser needs subscription state beside the API-vendor state, and a component
 * could only hand its state downward. These tests still exercise the same pair
 * — the state and the section it feeds — so the pairing lives here rather than
 * as a production component with no production caller.
 */
function SubscriptionProvidersController({ api }: { api: LvisApi }) {
  const { props } = useSubscriptionProviders(api);
  return (
    <div>
      {/* The settings page returns chat to the API path by CHOOSING an API
          model in the unified chooser; there is no separate button any more.
          The harness calls the same action directly so these tests keep
          exercising the controller rather than a particular control. */}
      <button
        type="button"
        data-testid="subscription-providers:use-api-for-chat"
        disabled={props.apiChatActive || props.apiChatBusy || props.chatSelectionBusy}
        onClick={() => void props.actions.useApiForChat?.()}
      >
        use api
      </button>
      {props.apiChatError ? (
        <p data-testid="subscription-providers:api-chat-error">{props.apiChatError}</p>
      ) : null}
      {props.providers.map((provider) => (
        <div key={provider.descriptor.id}>
          <SubscriptionAuthControls provider={provider} actions={props.actions} />
          {/* The connection word is the settings row's to draw; what the tests
              need from the controller is the projection behind it. */}
          <span data-testid={`subscription-state:${provider.descriptor.id}`}>
            {provider.status?.connection ?? "unknown"}
          </span>
          {/* The provider card carries no model list and no "use for chat"
              button any more: both live in the settings page's one chooser.
              These stand in for that chooser so the tests keep exercising the
              controller rather than a particular control. */}
          <button
            type="button"
            data-testid={`subscription-chooser:${provider.descriptor.id}:provider-default`}
            disabled={props.chatSelectionBusy}
            onClick={() => void props.actions.useForChat?.(provider.descriptor.id, null)}
          >
            use provider default
          </button>
          {(provider.status?.models ?? []).map((model) => (
            <button
              key={model.id}
              type="button"
              data-testid={`subscription-chooser:${provider.descriptor.id}:${model.id}`}
              disabled={props.chatSelectionBusy}
              onClick={() => void props.actions.useForChat?.(provider.descriptor.id, model.id)}
            >
              {model.label}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

function connectedStatus(provider: SubscriptionRuntimeId): SubscriptionRuntimeStatus {
  return {
    provider,
    runtime: "ready",
    connection: "connected",
    planType: "subscription",
    pendingLogin: null,
    pendingDeviceCode: null,
    canOpenVerificationUrl: false,
    version: "test",
    capabilities: {
      chat: true,
      images: true,
      imageAttachmentLimits: {
        maxCount: 5,
        maxBytesPerImage: 25 * 1024 * 1024,
        maxTotalBytes: 25 * 1024 * 1024,
      },
      files: true,
      tools: true,
      projectAccess: true,
      plugins: true,
      mcp: true,
      generateText: true,
      compaction: true,
      routine: true,
      subagent: true,
    },
  };
}

function signedOutStatus(provider: SubscriptionRuntimeId): SubscriptionRuntimeStatus {
  const status = connectedStatus(provider);
  return {
    ...status,
    connection: "signed-out",
    capabilities: {
      ...status.capabilities,
      chat: false,
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function controllerApi() {
  const subscriptionRuntimeStatus = vi.fn(async (provider: SubscriptionRuntimeId) => ({
    ok: true as const,
    status: connectedStatus(provider),
  }));
  const subscriptionListModels = vi.fn(async (provider: SubscriptionRuntimeId) => ({
    ok: true as const,
    status: connectedStatus(provider),
    models: provider === "codex"
      ? [{ id: "gpt-5.6-codex", displayName: "GPT-5.6 Codex", isDefault: true }]
      : [],
  }));
  const subscriptionUseForChat = vi.fn(async (
    provider: SubscriptionRuntimeId,
    _model: string | undefined,
  ) => ({ ok: true as const, status: connectedStatus(provider) }));
  const api = {
    getSettings: vi.fn(async () => ({ llm: { activeChatRuntime: { kind: "api" } } })),
    onSettingsUpdated: vi.fn(() => () => {}),
    subscriptionRuntimeStatus,
    onSubscriptionRuntimeStatusUpdated: vi.fn(() => () => {}),
    subscriptionListModels,
    subscriptionUseForChat,
  } as unknown as LvisApi;
  return { api, subscriptionRuntimeStatus, subscriptionListModels, subscriptionUseForChat };
}

let localeBeforeTest = getLocale();

beforeEach(() => {
  localeBeforeTest = getLocale();
  setLocale("en");
});

afterEach(() => {
  setLocale(localeBeforeTest);
});

describe("SubscriptionProvidersController", () => {
  it("loads every common provider status and uses the generic selected chat runtime", async () => {
    const {
      api,
      subscriptionRuntimeStatus,
      subscriptionListModels,
      subscriptionUseForChat,
    } = controllerApi();
    render(<SubscriptionProvidersController api={api} />);

    await waitFor(() => {
      expect(subscriptionRuntimeStatus).toHaveBeenCalledWith("codex");
      expect(subscriptionRuntimeStatus).toHaveBeenCalledWith("kimi-code");
      expect(subscriptionRuntimeStatus).toHaveBeenCalledWith("grok-build");
    });

    // Asked for on its own, as soon as the provider reports itself connected:
    // the chooser cannot offer what nothing fetched, and there is no longer a
    // button on the card to fetch it with.
    fireEvent.click(await screen.findByTestId("subscription-chooser:codex:gpt-5.6-codex"));
    await waitFor(() => {
      expect(subscriptionListModels).toHaveBeenCalledWith("codex");
      expect(subscriptionUseForChat).toHaveBeenCalledWith("codex", "gpt-5.6-codex");
      expect(subscriptionRuntimeStatus.mock.calls.filter(([provider]) => provider === "codex")).toHaveLength(2);
    });
  });

  it("keeps the newest status when an older read completes after a status invalidation", async () => {
    const staleCodexStatus = deferred<{
      ok: true;
      status: SubscriptionRuntimeStatus;
    }>();
    let codexStatusReads = 0;
    let emitStatusUpdated: ((event: SubscriptionRuntimeStatusUpdatedEvent) => void) | undefined;
    const subscriptionRuntimeStatus = vi.fn((provider: SubscriptionRuntimeId) => {
      if (provider !== "codex") {
        return Promise.resolve({ ok: true as const, status: connectedStatus(provider) });
      }
      codexStatusReads += 1;
      return codexStatusReads === 1
        ? staleCodexStatus.promise
        : Promise.resolve({ ok: true as const, status: connectedStatus(provider) });
    });
    const api = {
      getSettings: vi.fn(async () => ({ llm: { activeChatRuntime: { kind: "api" } } })),
      onSettingsUpdated: vi.fn(() => () => {}),
      onSubscriptionRuntimeStatusUpdated: vi.fn((handler: (event: SubscriptionRuntimeStatusUpdatedEvent) => void) => {
        emitStatusUpdated = handler;
        return () => {};
      }),
      subscriptionRuntimeStatus,
    } as unknown as LvisApi;

    render(<SubscriptionProvidersController api={api} />);
    await waitFor(() => expect(subscriptionRuntimeStatus).toHaveBeenCalledWith("codex"));

    act(() => emitStatusUpdated?.({ provider: "codex", revision: 1 }));
    await waitFor(() => expect(subscriptionRuntimeStatus).toHaveBeenCalledTimes(4));
    await waitFor(() => {
      expect(screen.getByTestId("subscription-state:codex")).toHaveTextContent("connected");
    });

    await act(async () => {
      staleCodexStatus.resolve({ ok: true, status: signedOutStatus("codex") });
      await staleCodexStatus.promise;
    });
    expect(screen.getByTestId("subscription-state:codex")).toHaveTextContent("connected");
  });

  it("does not let a status event clear an in-flight login action", async () => {
    const pendingLogin = deferred<{
      ok: true;
      status: SubscriptionRuntimeStatus;
    }>();
    let emitStatusUpdated: ((event: SubscriptionRuntimeStatusUpdatedEvent) => void) | undefined;
    const subscriptionRuntimeStatus = vi.fn(async (provider: SubscriptionRuntimeId) => ({
      ok: true as const,
      status: signedOutStatus(provider),
    }));
    const subscriptionStartLogin = vi.fn(() => pendingLogin.promise);
    const api = {
      getSettings: vi.fn(async () => ({ llm: { activeChatRuntime: { kind: "api" } } })),
      onSettingsUpdated: vi.fn(() => () => {}),
      onSubscriptionRuntimeStatusUpdated: vi.fn((handler: (event: SubscriptionRuntimeStatusUpdatedEvent) => void) => {
        emitStatusUpdated = handler;
        return () => {};
      }),
      subscriptionRuntimeStatus,
      subscriptionStartLogin,
    } as unknown as LvisApi;

    render(<SubscriptionProvidersController api={api} />);
    const login = await screen.findByTestId("subscription-provider:codex:login-browser");
    fireEvent.click(login);
    await waitFor(() => expect(subscriptionStartLogin).toHaveBeenCalledWith("codex", "browser"));

    act(() => emitStatusUpdated?.({ provider: "codex", revision: 1 }));
    await waitFor(() => {
      expect(subscriptionRuntimeStatus.mock.calls.filter(([provider]) => provider === "codex").length)
        .toBeGreaterThan(1);
    });
    expect(screen.getByTestId("subscription-provider:codex:login-browser")).toBeDisabled();

    await act(async () => {
      pendingLogin.resolve({ ok: true, status: { ...signedOutStatus("codex"), connection: "pending" } });
      await pendingLogin.promise;
    });
  });

  it("serializes local chat selection and clears obsolete API failures after a runtime update", async () => {
    const pendingSelection = deferred<{
      ok: true;
      status: SubscriptionRuntimeStatus;
    }>();
    let emitSettings: ((settings: AppSettings) => void) | undefined;
    const subscriptionUseApiForChat = vi.fn(async () => ({
      ok: false as const,
      error: "subscription-operation-failed" as const,
    }));
    const subscriptionUseForChat = vi.fn(() => pendingSelection.promise);
    const api = {
      getSettings: vi.fn(async () => ({
        llm: { activeChatRuntime: { kind: "subscription" as const, provider: "codex" as const } },
      })),
      onSettingsUpdated: vi.fn((handler: (settings: AppSettings) => void) => {
        emitSettings = handler;
        return () => {};
      }),
      onSubscriptionRuntimeStatusUpdated: vi.fn(() => () => {}),
      subscriptionRuntimeStatus: vi.fn(async (provider: SubscriptionRuntimeId) => ({
        ok: true as const,
        status: connectedStatus(provider),
      })),
      subscriptionUseApiForChat,
      subscriptionUseForChat,
    } as unknown as LvisApi;

    render(<SubscriptionProvidersController api={api} />);
    const useApiForChat = await screen.findByTestId("subscription-providers:use-api-for-chat");
    // Wait for the initial subscription setting to land. Clicking while the
    // controller still has its default API projection races the initial
    // refresh, which legitimately clears the newly rendered API error.
    await waitFor(() => expect(useApiForChat).not.toBeDisabled());
    fireEvent.click(useApiForChat);
    await waitFor(() => {
      expect(screen.getByTestId("subscription-providers:api-chat-error")).toBeTruthy();
    });

    // A newer main-owned runtime selection makes a prior API error obsolete.
    act(() => {
      emitSettings?.({
        llm: { activeChatRuntime: { kind: "subscription", provider: "kimi-code" } },
      } as AppSettings);
    });
    expect(screen.queryByTestId("subscription-providers:api-chat-error")).toBeNull();

    const kimiUseForChat = await screen.findByTestId("subscription-chooser:kimi-code:provider-default");
    await waitFor(() => expect(kimiUseForChat).not.toBeDisabled());
    fireEvent.click(kimiUseForChat);
    await waitFor(() => {
      expect(subscriptionUseForChat).toHaveBeenCalledWith("kimi-code", undefined);
    });

    // One renderer must not issue a second, conflicting API/provider choice
    // while the first selection is still awaiting main-process completion.
    await waitFor(() => {
      expect(screen.getByTestId("subscription-providers:use-api-for-chat")).toBeDisabled();
      expect(screen.getByTestId("subscription-chooser:codex:provider-default")).toBeDisabled();
    });

    await act(async () => {
      pendingSelection.resolve({ ok: true, status: connectedStatus("kimi-code") });
      await pendingSelection.promise;
    });
    await waitFor(() => {
      expect(screen.getByTestId("subscription-providers:use-api-for-chat")).not.toBeDisabled();
    });
  });

  it("offers a connected provider's catalogue without anyone pressing anything", async () => {
    const subscriptionListModels = vi.fn(async (provider: SubscriptionRuntimeId) => ({
      ok: true as const,
      status: connectedStatus(provider),
      models: provider === "codex"
        ? [
          { id: "gpt-5.6-codex", displayName: "GPT-5.6 Codex", isDefault: true },
          { id: "gpt-5.4-mini", displayName: "GPT-5.4 mini", isDefault: false },
        ]
        : [],
    }));
    const subscriptionUseForChat = vi.fn(async (provider: SubscriptionRuntimeId) => ({
      ok: true as const,
      status: connectedStatus(provider),
    }));
    const api = {
      getSettings: vi.fn(async () => ({ llm: { activeChatRuntime: { kind: "api" as const } } })),
      onSettingsUpdated: vi.fn(() => () => {}),
      onSubscriptionRuntimeStatusUpdated: vi.fn(() => () => {}),
      subscriptionRuntimeStatus: vi.fn(async (provider: SubscriptionRuntimeId) => ({
        ok: true as const,
        status: connectedStatus(provider),
      })),
      subscriptionListModels,
      subscriptionUseForChat,
    } as unknown as LvisApi;

    render(<SubscriptionProvidersController api={api} />);

    fireEvent.click(await screen.findByTestId("subscription-chooser:codex:gpt-5.4-mini"));
    await waitFor(() => {
      expect(subscriptionUseForChat).toHaveBeenCalledWith("codex", "gpt-5.4-mini");
    });
    // One ask per connection, not one per render.
    expect(subscriptionListModels.mock.calls.filter(([provider]) => provider === "codex"))
      .toHaveLength(1);
  });
});
