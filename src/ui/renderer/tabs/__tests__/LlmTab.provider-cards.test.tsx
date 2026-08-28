import "../../../../../test/renderer/setup.js";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installMockLvisApi, type MockLvisApi } from "../../../../../test/renderer/mock-lvis-api.js";
import { TooltipProvider } from "../../../../components/ui/tooltip.js";
import type { LlmModelListResult } from "../../../../shared/llm-model-list.js";
import type { SubscriptionProviderView } from "../SubscriptionProvidersSection.js";

const useSubscriptionProvidersMock = vi.hoisted(() => vi.fn());

vi.mock("../SubscriptionProvidersController.js", () => ({
  useSubscriptionProviders: useSubscriptionProvidersMock,
}));

const { LlmTab } = await import("../LlmTab.js");

type MockApi = MockLvisApi;

/** Stable identity: LlmTab's settings effect keys off this array. */
const NO_PRESETS: never[] = [];

function codexView(
  overrides: Partial<SubscriptionProviderView> = {},
): SubscriptionProviderView {
  return {
    descriptor: {
      id: "codex",
      label: "Codex",
      description: "",
      loginMethods: ["browser", "device-code"],
      supportsLogout: true,
      modelSelection: "none",
    },
    status: {
      runtime: "ready",
      connection: "signed-out",
      models: [],
    },
    busyAction: null,
    refreshPending: false,
    ...overrides,
  } as SubscriptionProviderView;
}

function installSubscription(providers: readonly SubscriptionProviderView[]) {
  useSubscriptionProvidersMock.mockReturnValue({
    providers,
    activeRuntime: { kind: "api" as const },
    props: {
      providers,
      activeSelection: null,
      apiChatActive: true,
      apiChatBusy: false,
      chatSelectionBusy: false,
      apiChatError: null,
      actions: {},
    },
  });
}

function makeApi(overrides: MockApi = {}): MockApi {
  const api = installMockLvisApi();
  api.listLlmModels = vi.fn().mockResolvedValue({
    ok: false,
    error: "model-list-fetch-failed",
    message: "no",
  } satisfies LlmModelListResult);
  for (const [name, impl] of Object.entries(overrides)) api[name] = impl;
  return api;
}

async function renderTab(
  api: MockApi,
  props: Partial<Record<string, unknown>> = {},
) {
  const result = render(
    <TooltipProvider>
    <LlmTab
      api={api as never}
      marketplaceProviderPresets={NO_PRESETS}
      vendor={(props.vendor as string) ?? "openai"}
      setVendor={(props.setVendor as never) ?? vi.fn()}
      baseUrl={(props.baseUrl as string) ?? ""}
      setBaseUrl={(props.setBaseUrl as never) ?? vi.fn()}
      vertexProject=""
      setVertexProject={vi.fn()}
      vertexLocation=""
      setVertexLocation={vi.fn()}
      hasKey={(props.hasKey as boolean) ?? true}
      setHasKey={vi.fn()}
      keyInput=""
      setKeyInput={vi.fn()}
      model={(props.model as string) ?? "gpt-5.4"}
      setModel={vi.fn()}
      selectApiVendorModel={vi.fn()}
      enableThinking={false}
      setEnableThinking={vi.fn()}
      thinkingBudget={10_000}
      setThinkingBudget={vi.fn()}
      fallbackChain={[]}
      setFallbackChain={vi.fn()}
      fallbackOpen={false}
      setFallbackOpen={vi.fn()}
      onSaved={vi.fn()}
      onSave={(props.onSave as never) ?? vi.fn()}
      settingsLoaded={true}
    />
    </TooltipProvider>,
  );
  // The tab syncs the active vendor's catalogue on a debounce after mount.
  await act(async () => {
    await Promise.resolve();
  });
  return result;
}

beforeEach(() => {
  vi.useRealTimers();
  useSubscriptionProvidersMock.mockReset();
  installSubscription([]);
});

describe("LlmTab provider cards", () => {
  it("puts Save inside the card being edited, not on the page", async () => {
    const api = makeApi();
    await renderTab(api);

    expect(screen.queryByTestId("llm-tab:save-providers")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("llm-tab:connection-toggle:openai"));

    const card = screen.getByTestId("llm-tab:connection:openai");
    const save = screen.getByTestId("llm-tab:save-providers");
    expect(card).toContainElement(save);
  });

  it("hides the API key field until the API-key route is chosen", async () => {
    installSubscription([codexView()]);
    const api = makeApi();
    await renderTab(api);

    expect(screen.queryByTestId("llm-api-key-input")).not.toBeInTheDocument();

    const useApiKey = screen.getByTestId("llm-tab:connection-api-key:codex");
    // The third way in sits with the other two, not beside the provider name.
    const loginBrowser = screen.getByTestId("subscription-provider:codex:login-browser");
    expect(useApiKey.parentElement).toBe(loginBrowser.parentElement);

    fireEvent.click(useApiKey);
    expect(screen.getByTestId("llm-api-key-input")).toBeInTheDocument();
    expect(screen.getByTestId("llm-tab:api-key-status")).toHaveTextContent(/설정됨|Configured|Set/);
  });

  it("asks for an endpoint only where the endpoint is the user's to supply", async () => {
    const api = makeApi();
    const { unmount } = await renderTab(api);
    fireEvent.click(screen.getByTestId("llm-tab:connection-toggle:openai"));
    expect(screen.queryByTestId("llm-base-url-input")).not.toBeInTheDocument();
    unmount();

    await renderTab(makeApi(), { vendor: "openrouter", model: "openai/gpt-5.4" });
    fireEvent.click(screen.getByTestId("llm-tab:connection-toggle:openrouter"));
    expect(screen.queryByTestId("llm-base-url-input")).not.toBeInTheDocument();
  });

  it("asks for an endpoint on the custom OpenAI-compatible provider", async () => {
    await renderTab(makeApi(), {
      vendor: "openai-compatible",
      baseUrl: "http://localhost:8001/v1",
      model: "local-model",
    });
    fireEvent.click(screen.getByTestId("llm-tab:connection-toggle:openai-compatible"));
    expect(screen.getByTestId("llm-base-url-input")).toBeInTheDocument();
  });

  it("appends an added provider below every existing card", async () => {
    installSubscription([codexView({
      status: { runtime: "ready", connection: "connected", models: [] },
    } as Partial<SubscriptionProviderView>)]);
    await renderTab(makeApi(), { vendor: "openai" });

    fireEvent.pointerDown(
      screen.getByTestId("llm-tab:add-provider"),
      { button: 0, ctrlKey: false, pointerType: "mouse" },
    );
    const item = await screen.findByTestId("llm-tab:add-provider-item:claude");
    fireEvent.click(item);

    const rows = Array.from(
      screen.getByTestId("llm-tab:connections").querySelectorAll("[data-provider-row]"),
    ).map((node) => node.getAttribute("data-provider-row"));
    expect(rows[rows.length - 1]).toBe("claude");
    expect(rows.length).toBeGreaterThan(1);
  });
});

describe("LlmTab OpenAI model catalogue", () => {
  it("offers the endpoint's catalogue rather than the bundled list", async () => {
    const api = makeApi({
      listLlmModels: vi.fn().mockResolvedValue({
        ok: true,
        vendor: "openai",
        endpoint: "https://api.openai.com/v1/models",
        models: ["gpt-from-endpoint"],
        fetchedAt: "2026-01-01T00:00:00.000Z",
      } satisfies LlmModelListResult),
    });
    await renderTab(api, { model: "" });

    await waitFor(() => {
      expect(api.listLlmModels).toHaveBeenCalledWith({ vendor: "openai" });
    });
    await waitFor(() => {
      expect(screen.getByTestId("llm-tab:connection-subline:openai"))
        .toHaveAttribute("data-provider-sync-status", "ready");
    });
    const subline = screen.getByTestId("llm-tab:connection-subline:openai");
    expect(subline).toHaveTextContent("https://api.openai.com/v1/models");
    expect(screen.getByTestId("llm-tab:model-sync-status")).toHaveTextContent("1");

    fireEvent.pointerDown(
      screen.getByTestId("llm-model-select"),
      { button: 0, ctrlKey: false, pointerType: "mouse" },
    );
    await screen.findByText("gpt-from-endpoint");
    // The bundled catalogue is metadata, never the list: none of its ids may
    // appear once the endpoint has answered.
    expect(document.querySelector("[data-model-id=\"gpt-5.4\"]")).toBeNull();
    expect(document.querySelector("[data-model-id=\"o3\"]")).toBeNull();
  });

  it("says the handshake failed instead of standing in a bundled list", async () => {
    const api = makeApi();
    await renderTab(api, { model: "" });

    await waitFor(() => {
      expect(screen.getByTestId("llm-tab:connection-subline:openai"))
        .toHaveAttribute("data-provider-sync-status", "error");
    });
    expect(screen.getByTestId("llm-tab:model-sync-status")).not.toHaveTextContent(/\d+/);
  });
});
