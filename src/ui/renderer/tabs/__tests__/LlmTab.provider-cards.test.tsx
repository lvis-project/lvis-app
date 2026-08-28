import "../../../../../test/renderer/setup.js";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installMockLvisApi, type MockLvisApi } from "../../../../../test/renderer/mock-lvis-api.js";
import { TooltipProvider } from "../../../../components/ui/tooltip.js";
import type { LlmModelListResult } from "../../../../shared/llm-model-list.js";
import type { MarketplaceInstalledProviderPreset } from "../../../../shared/marketplace-package-assets.js";
import type { SubscriptionProviderView } from "../SubscriptionProvidersSection.js";

const useSubscriptionProvidersMock = vi.hoisted(() => vi.fn());

vi.mock("../SubscriptionProvidersController.js", () => ({
  useSubscriptionProviders: useSubscriptionProvidersMock,
}));

const { LlmTab } = await import("../LlmTab.js");

type MockApi = MockLvisApi;

/** Stable identity: LlmTab's settings effect keys off this array. */
const NO_PRESETS: readonly MarketplaceInstalledProviderPreset[] = [];

/** The endpoint the live custom provider is configured with. */
const CUSTOM_ENDPOINT = "http://10.232.178.100:30000/v1";

function preset(
  providerId: string,
  label: string,
  baseUrl: string,
): MarketplaceInstalledProviderPreset {
  return {
    providerId,
    label,
    baseUrl,
    defaultModel: `${providerId}-default`,
    modelOptions: [`${providerId}-default`],
    apiKeyPlaceholder: "sk-...",
    requiresApiKey: true,
  } as MarketplaceInstalledProviderPreset;
}

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

const FETCH_FAILED: LlmModelListResult = {
  ok: false,
  error: "model-list-fetch-failed",
  message: "no",
};

function makeApi(overrides: MockApi = {}): MockApi {
  const api = installMockLvisApi();
  api.listLlmModels = vi.fn().mockResolvedValue(FETCH_FAILED);
  api.hasApiKey = vi.fn().mockResolvedValue(false);
  for (const [name, impl] of Object.entries(overrides)) api[name] = impl;
  return api;
}

/** A credential store holding keys for exactly these providers. */
function storedKeysFor(...providerIds: string[]) {
  return vi.fn(async (providerId: string) => providerIds.includes(providerId));
}

/** `getSettings` carrying a model-list cache, so a handshake can be pre-landed. */
function settingsWithCache(cache: Record<string, unknown>) {
  return vi.fn().mockResolvedValue({
    llm: { pinnedModels: [], modelListCache: cache },
    marketplace: { installedProviderIds: [] },
  });
}

/** `getSettings` with a stored block for one vendor, for the dirty signal. */
function settingsWithVendorBlock(vendor: string, block: Record<string, string>) {
  return vi.fn().mockResolvedValue({
    llm: { pinnedModels: [], modelListCache: {}, vendors: { [vendor]: block } },
    marketplace: { installedProviderIds: [] },
  });
}

interface TabProps {
  vendor?: string;
  baseUrl?: string;
  keyInput?: string;
  hasKey?: boolean;
  model?: string;
  marketplaceProviderPresets?: readonly MarketplaceInstalledProviderPreset[];
  marketplaceProviderPresetId?: string;
  fallbackChain?: { provider: string; model: string }[];
  fallbackOpen?: boolean;
}

function tabTree(api: MockApi, props: TabProps) {
  return (
    <TooltipProvider>
      <LlmTab
        api={api as never}
        marketplaceProviderPresets={props.marketplaceProviderPresets ?? NO_PRESETS}
        marketplaceProviderPresetId={props.marketplaceProviderPresetId ?? ""}
        vendor={props.vendor ?? "openai"}
        setVendor={vi.fn()}
        baseUrl={props.baseUrl ?? ""}
        setBaseUrl={vi.fn()}
        vertexProject=""
        setVertexProject={vi.fn()}
        vertexLocation=""
        setVertexLocation={vi.fn()}
        hasKey={props.hasKey ?? true}
        setHasKey={vi.fn()}
        keyInput={props.keyInput ?? ""}
        setKeyInput={vi.fn()}
        model={props.model ?? "gpt-5.4"}
        setModel={vi.fn()}
        selectApiVendorModel={vi.fn()}
        enableThinking={false}
        setEnableThinking={vi.fn()}
        thinkingBudget={10_000}
        setThinkingBudget={vi.fn()}
        fallbackChain={props.fallbackChain ?? []}
        setFallbackChain={vi.fn()}
        fallbackOpen={props.fallbackOpen ?? false}
        setFallbackOpen={vi.fn()}
        onSaved={vi.fn()}
        onSave={vi.fn()}
        settingsLoaded={true}
      />
    </TooltipProvider>
  );
}

async function renderTab(api: MockApi, props: TabProps = {}) {
  const result = render(tabTree(api, props));
  // The tab syncs the active vendor's catalogue on a debounce after mount.
  await act(async () => {
    await Promise.resolve();
  });
  let current = props;
  return {
    ...result,
    /** Move the props the parent owns — the vendor above all — as a click on
     *  another provider's card really does. */
    rerender: async (next: TabProps) => {
      current = { ...current, ...next };
      result.rerender(tabTree(api, current));
      await act(async () => {
        await Promise.resolve();
      });
    },
  };
}

/** Radix menus open on pointerdown, not click. */
function openMenu(trigger: HTMLElement) {
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
}

function rowOrder(): (string | null)[] {
  return Array.from(
    screen.getByTestId("llm-tab:connections").querySelectorAll("[data-provider-row]"),
  ).map((node) => node.getAttribute("data-provider-row"));
}

beforeEach(() => {
  vi.useRealTimers();
  useSubscriptionProvidersMock.mockReset();
  installSubscription([]);
});

describe("LlmTab provider cards", () => {
  it("puts Save inside the card being edited, not on the page", async () => {
    await renderTab(makeApi(), { keyInput: "sk-typed" });

    expect(screen.queryByTestId("llm-tab:save-providers")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("llm-tab:connection-toggle:openai"));

    const card = screen.getByTestId("llm-tab:connection:openai");
    expect(card).toContainElement(screen.getByTestId("llm-tab:save-providers"));
  });

  it("hides the API key field until the API-key route is chosen", async () => {
    installSubscription([codexView()]);
    await renderTab(makeApi());

    expect(screen.queryByTestId("llm-api-key-input")).not.toBeInTheDocument();

    const useApiKey = screen.getByTestId("llm-tab:connection-api-key:codex");
    // The third way in sits with the other two, not beside the provider name.
    const loginBrowser = screen.getByTestId("subscription-provider:codex:login-browser");
    expect(useApiKey.parentElement).toBe(loginBrowser.parentElement);

    fireEvent.click(useApiKey);
    const form = screen.getByTestId("llm-tab:manual-section");
    expect(screen.getByTestId("llm-api-key-input")).toBeInTheDocument();
    expect(useApiKey).toHaveAttribute("aria-controls", form.id);
    expect(useApiKey).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("llm-tab:api-key-status")).toHaveTextContent(/설정됨|Configured|Set/);
  });

  it("asks for no endpoint where the endpoint is fixed", async () => {
    const { unmount } = await renderTab(makeApi());
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

  it("asks for an endpoint on a self-hosted vendor whose address is per install", async () => {
    await renderTab(makeApi(), {
      vendor: "ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "llama3",
    });
    fireEvent.click(screen.getByTestId("llm-tab:connection-toggle:ollama"));
    expect(screen.getByTestId("llm-base-url-input")).toHaveValue("http://127.0.0.1:11434/v1");
  });

  it("appends an added provider below every existing card", async () => {
    installSubscription([codexView({
      status: { runtime: "ready", connection: "connected", models: [] },
    } as Partial<SubscriptionProviderView>)]);
    await renderTab(makeApi());

    openMenu(screen.getByTestId("llm-tab:add-provider"));
    fireEvent.click(await screen.findByTestId("llm-tab:add-provider-item:claude"));

    const rows = rowOrder();
    expect(rows[rows.length - 1]).toBe("claude");
    expect(rows.length).toBeGreaterThan(1);
  });
});

describe("LlmTab marketplace preset rows", () => {
  const presets = [
    preset("acme-gw", "Acme Gateway", "https://acme.example/v1"),
    preset("bolt-gw", "Bolt Gateway", "https://bolt.example/v1"),
  ] as const;

  async function addBothPresets(api: MockApi) {
    await renderTab(api, {
      vendor: "openai-compatible",
      marketplaceProviderPresets: presets,
      model: "",
      hasKey: false,
    });
    openMenu(screen.getByTestId("llm-tab:add-provider"));
    fireEvent.click(await screen.findByTestId("llm-tab:add-provider-item:marketplace-provider:acme-gw"));
    openMenu(screen.getByTestId("llm-tab:add-provider"));
    fireEvent.click(await screen.findByTestId("llm-tab:add-provider-item:marketplace-provider:bolt-gw"));
  }

  it("gives each installed preset its own named card", async () => {
    await addBothPresets(makeApi());

    expect(screen.getByTestId("llm-tab:connection:marketplace-provider:acme-gw"))
      .toHaveTextContent("Acme Gateway");
    expect(screen.getByTestId("llm-tab:connection:marketplace-provider:bolt-gw"))
      .toHaveTextContent("Bolt Gateway");
    expect(rowOrder()).toEqual(["marketplace-provider:acme-gw", "marketplace-provider:bolt-gw"]);
  });

  it("drops an added preset out of the add menu", async () => {
    await addBothPresets(makeApi());

    openMenu(screen.getByTestId("llm-tab:add-provider"));
    await screen.findByTestId("llm-tab:add-provider-item:claude");
    expect(screen.queryByTestId("llm-tab:add-provider-item:marketplace-provider:acme-gw")).toBeNull();
    expect(screen.queryByTestId("llm-tab:add-provider-item:marketplace-provider:bolt-gw")).toBeNull();
  });

  it("reports each preset's handshake on its own card", async () => {
    const api = makeApi({
      getSettings: settingsWithCache({
        [["openai-compatible", "https://acme.example/v1", "acme-gw"].join("\n")]: {
          vendor: "openai-compatible",
          baseUrl: "https://acme.example/v1",
          credentialScope: "acme-gw",
          endpoint: "https://acme.example/v1/models",
          models: ["acme-1", "acme-2"],
          fetchedAt: "2026-01-01T00:00:00.000Z",
        },
      }),
    });
    await renderTab(api, {
      vendor: "openai-compatible",
      marketplaceProviderPresets: presets,
      model: "",
      hasKey: false,
    });
    // Acme's catalogue landed, so its row is already there; only Bolt is left
    // to add — and the two must not share one set of facts.
    openMenu(screen.getByTestId("llm-tab:add-provider"));
    fireEvent.click(await screen.findByTestId("llm-tab:add-provider-item:marketplace-provider:bolt-gw"));

    await waitFor(() => {
      expect(screen.getByTestId("llm-tab:connection-subline:marketplace-provider:acme-gw"))
        .toHaveAttribute("data-provider-sync-status", "ready");
    });
    expect(screen.queryByTestId("llm-tab:connection-subline:marketplace-provider:bolt-gw")).toBeNull();
  });
});

describe("LlmTab unsaved provider input", () => {
  it("keeps Save unavailable until a field actually changes", async () => {
    const saved = { baseUrl: "http://localhost:8001/v1" };
    const { unmount } = await renderTab(
      makeApi({ getSettings: settingsWithVendorBlock("openai-compatible", saved) }),
      { vendor: "openai-compatible", baseUrl: saved.baseUrl, model: "local-model" },
    );
    fireEvent.click(screen.getByTestId("llm-tab:connection-toggle:openai-compatible"));
    await waitFor(() => expect(screen.getByTestId("llm-tab:save-providers")).toBeDisabled());
    unmount();

    await renderTab(
      makeApi({ getSettings: settingsWithVendorBlock("openai-compatible", saved) }),
      { vendor: "openai-compatible", baseUrl: "http://localhost:9999/v1", model: "local-model" },
    );
    fireEvent.click(screen.getByTestId("llm-tab:connection-toggle:openai-compatible"));
    await waitFor(() => expect(screen.getByTestId("llm-tab:save-providers")).toBeEnabled());
  });

  it("keeps a card with uncommitted input on screen and marks it when collapsed", async () => {
    // Nothing was added and nothing is configured: this row exists only
    // because the draft does — which is the part that survives a remount.
    await renderTab(makeApi(), {
      vendor: "claude",
      hasKey: false,
      keyInput: "sk-ant-typed",
      model: "",
    });

    expect(screen.getByTestId("llm-tab:connection:claude")).toBeInTheDocument();
    // Collapsed, but not silent about what it is holding.
    expect(screen.getByTestId("llm-tab:connection-unsaved:claude")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("llm-tab:connection-toggle:claude"));
    expect(screen.getByTestId("llm-tab:save-providers")).toBeEnabled();
    expect(screen.queryByTestId("llm-tab:connection-unsaved:claude")).toBeNull();
  });
});

describe("LlmTab OpenAI model catalogue", () => {
  it("offers the endpoint's catalogue rather than the bundled list", async () => {
    const api = makeApi({
      hasApiKey: storedKeysFor("openai"),
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
    expect(screen.getByTestId("llm-tab:connection-subline:openai"))
      .toHaveTextContent("https://api.openai.com/v1/models");
    expect(screen.getByTestId("llm-tab:model-sync-status")).toHaveTextContent("1");

    openMenu(screen.getByTestId("llm-model-select"));
    await screen.findByText("gpt-from-endpoint");
    // The bundled catalogue is metadata, never the list: none of its ids may
    // appear once the endpoint has answered.
    expect(document.querySelector("[data-model-id=\"gpt-5.4\"]")).toBeNull();
    expect(document.querySelector("[data-model-id=\"o3\"]")).toBeNull();
  });

  it("says the handshake failed instead of standing in a bundled list", async () => {
    await renderTab(makeApi({ hasApiKey: storedKeysFor("openai") }), { model: "" });

    await waitFor(() => {
      expect(screen.getByTestId("llm-tab:connection-subline:openai"))
        .toHaveAttribute("data-provider-sync-status", "error");
    });
    expect(screen.getByTestId("llm-tab:model-sync-status")).not.toHaveTextContent(/\d+/);
  });

  it("distinguishes a failure that left a catalogue standing from one that did not", async () => {
    const api = makeApi({
      hasApiKey: storedKeysFor("openai"),
      getSettings: settingsWithCache({
        [["openai", "", ""].join("\n")]: {
          vendor: "openai",
          endpoint: "https://api.openai.com/v1/models",
          models: ["gpt-cached"],
          fetchedAt: "2026-01-01T00:00:00.000Z",
        },
      }),
    });
    await renderTab(api, { model: "" });

    const status = await screen.findByTestId("llm-tab:model-sync-status");
    await waitFor(() => {
      expect(status).toHaveAttribute("data-provider-sync-status", "error");
    });
    // A cached catalogue is still on offer, so the message must not read as
    // "nothing to show" — the two failures are different states.
    expect(status.textContent).toMatch(/마지막으로 받은|last catalogue/);
  });

  it("does not spend a credentialed handshake when no key is stored", async () => {
    const api = makeApi();
    installSubscription([codexView({
      status: { runtime: "ready", connection: "connected", models: [] },
    } as Partial<SubscriptionProviderView>)]);
    await renderTab(api, { model: "", hasKey: false });

    await waitFor(() => expect(api.hasApiKey).toHaveBeenCalledWith("openai"));
    expect(api.listLlmModels).not.toHaveBeenCalled();

    const subline = await screen.findByTestId("llm-tab:connection-subline:codex");
    expect(subline).toHaveAttribute("data-provider-sync-status", "needs-credential");
    expect(subline).not.toHaveClass("text-destructive");
    // And no second, API-side OpenAI row conjured out of the attempt.
    expect(rowOrder()).toEqual(["codex"]);
  });

  it("keeps a provider with a stored key on screen when its handshake fails", async () => {
    // The live regression: OpenAI's key is stored but stale, the /models call
    // comes back failed, and the form is pointed at a DIFFERENT provider — so
    // nothing but the credential itself can put this row on the page.
    const api = makeApi({ hasApiKey: storedKeysFor("openai") });
    installSubscription([codexView()]);
    await renderTab(api, { vendor: "claude", model: "", hasKey: false });

    // The pairing carries it: one OpenAI row on the Codex runtime, not a
    // second plain card beside it.
    await waitFor(() => expect(rowOrder()).toEqual(["codex"]));
    const subline = screen.getByTestId("llm-tab:connection-subline:codex");
    expect(subline).toHaveAttribute("data-provider-sync-status", "error");
    // A key exists and it is not working: that is a fault, and it reads as one.
    expect(subline).toHaveClass("text-destructive");
  });

  it("keeps the stored key replaceable on a row whose handshake failed", async () => {
    const api = makeApi({ hasApiKey: storedKeysFor("openai") });
    installSubscription([codexView()]);
    await renderTab(api, { vendor: "openai", model: "", hasKey: true });

    await waitFor(() => {
      expect(screen.getByTestId("llm-tab:connection-subline:codex"))
        .toHaveAttribute("data-provider-sync-status", "error");
    });
    fireEvent.click(screen.getByTestId("llm-tab:connection-api-key:codex"));
    expect(screen.getByTestId("llm-tab:api-key-status")).toHaveTextContent(/설정됨|Configured|Set/);
    expect(screen.getByTestId("llm-api-key-input")).toBeInTheDocument();
    expect(screen.getByTestId("llm-tab:manual-section")).toHaveTextContent(/삭제|Delete|Remove/);
  });

  it("gives a generic openai-compatible row its own endpoint field with the saved value", async () => {
    // The live shape: the persisted provider is OpenAI, so the form starts
    // there, and the openai-compatible provider is configured with a custom
    // endpoint of its own. Clicking its card must show THAT endpoint.
    const api = makeApi({
      hasApiKey: storedKeysFor("openai", "openai-compatible"),
      getSettings: vi.fn().mockResolvedValue({
        llm: {
          pinnedModels: [],
          vendors: { "openai-compatible": { baseUrl: CUSTOM_ENDPOINT, model: "qwen3.8-27b-gguf" } },
          modelListCache: {
            [["openai-compatible", CUSTOM_ENDPOINT, ""].join("\n")]: {
              vendor: "openai-compatible",
              baseUrl: CUSTOM_ENDPOINT,
              endpoint: `${CUSTOM_ENDPOINT}/models`,
              models: ["a", "b", "c", "d"],
              fetchedAt: "2026-01-01T00:00:00.000Z",
            },
          },
        },
        marketplace: { installedProviderIds: [], installedProviderPresets: [] },
      }),
    });
    installSubscription([codexView()]);
    // `vendor` is what the parent moves on a click; the harness mirrors that.
    const { rerender } = await renderTab(api, { vendor: "openai", model: "", hasKey: true });
    await waitFor(() =>
      expect(screen.getByTestId("llm-tab:connection:openai-compatible")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("llm-tab:connection-toggle:openai-compatible"));
    // Mid-move the form belongs to nobody: it must NOT hang under the row the
    // ambient vendor still matches, which is how the OpenAI key field used to
    // appear beside a card the user never opened.
    expect(screen.queryByTestId("llm-tab:manual-section")).toBeNull();

    await rerender({ vendor: "openai-compatible", baseUrl: CUSTOM_ENDPOINT, model: "qwen3.8-27b-gguf", hasKey: true });
    const card = screen.getByTestId("llm-tab:connection:openai-compatible");
    expect(card).toContainElement(screen.getByTestId("llm-tab:manual-section"));
    expect(screen.getByTestId("llm-base-url-input")).toHaveValue(CUSTOM_ENDPOINT);
  });

  it("locks the endpoint on a preset row and not on the generic one beside it", async () => {
    const presets = [preset("acme-gw", "Acme Gateway", "https://acme.example/v1")];
    const api = makeApi({ hasApiKey: storedKeysFor("openai-compatible") });
    await renderTab(api, {
      vendor: "openai-compatible",
      baseUrl: CUSTOM_ENDPOINT,
      model: "local-model",
      marketplaceProviderPresets: presets,
    });

    // The generic row: no preset, so no lock — the field is offered.
    fireEvent.click(screen.getByTestId("llm-tab:connection-toggle:openai-compatible"));
    expect(screen.getByTestId("llm-base-url-input")).toHaveValue(CUSTOM_ENDPOINT);
  });

  it("keeps the generic endpoint field through an unrelated settings broadcast", async () => {
    // A model-list sync persists its cache, which broadcasts settings. That
    // broadcast must not rewrite which provider the form is editing.
    const api = makeApi({ hasApiKey: storedKeysFor("openai-compatible") });
    await renderTab(api, {
      vendor: "openai-compatible",
      baseUrl: CUSTOM_ENDPOINT,
      model: "local-model",
      marketplaceProviderPresets: [preset("acme-gw", "Acme Gateway", "https://acme.example/v1")],
    });
    fireEvent.click(screen.getByTestId("llm-tab:connection-toggle:openai-compatible"));
    expect(screen.getByTestId("llm-base-url-input")).toBeInTheDocument();

    const handler = api.onSettingsUpdated.mock.calls.at(-1)?.[0] as ((s: unknown) => void) | undefined;
    expect(handler).toBeTruthy();
    await act(async () => {
      handler!({
        llm: {
          provider: "openai-compatible",
          marketplaceProviderPresetId: "acme-gw",
          pinnedModels: [],
          modelListCache: {},
          vendors: { "openai-compatible": { baseUrl: CUSTOM_ENDPOINT } },
        },
        marketplace: { installedProviderIds: [], installedProviderPresets: [] },
      });
      await Promise.resolve();
    });
    expect(screen.getByTestId("llm-base-url-input")).toHaveValue(CUSTOM_ENDPOINT);
  });

  it("appends a picked self-hosted provider above the button, with its endpoint focused", async () => {
    // Ollama is not a built-in, so it is offered only once installed.
    const api = makeApi({
      getSettings: vi.fn().mockResolvedValue({
        llm: { pinnedModels: [], modelListCache: {} },
        marketplace: { installedProviderIds: ["ollama"], installedProviderPresets: [] },
      }),
    });
    const { rerender } = await renderTab(api, { vendor: "claude", hasKey: false, model: "" });

    // Radix opens the menu on pointerdown; a bare click never renders items.
    fireEvent.click(screen.getByTestId("llm-tab:add-provider"));
    expect(screen.queryByTestId("llm-tab:add-provider-item:ollama")).toBeNull();

    openMenu(screen.getByTestId("llm-tab:add-provider"));
    fireEvent.click(await screen.findByTestId("llm-tab:add-provider-item:ollama"));

    // Directly above the button that created it.
    const rows = rowOrder();
    expect(rows[rows.length - 1]).toBe("ollama");

    // And once the parent moves the vendor, the card offers its endpoint and
    // the caret is in it.
    await rerender({ vendor: "ollama", baseUrl: "http://127.0.0.1:11434/v1", model: "llama3" });
    const field = screen.getByTestId("llm-base-url-input");
    expect(screen.getByTestId("llm-tab:connection:ollama")).toContainElement(field);
    expect(field).toHaveFocus();
  });

  it("draws no configured row from a handshake that only started", async () => {
    let release: ((result: LlmModelListResult) => void) | undefined;
    const api = makeApi({
      listLlmModels: vi.fn().mockImplementation(() => new Promise((resolve) => {
        release = resolve as (result: LlmModelListResult) => void;
      })),
    });
    await renderTab(api, {
      model: "",
      vendor: "claude",
      hasKey: false,
      fallbackOpen: true,
      fallbackChain: [{ provider: "openrouter", model: "x" }],
    });

    await waitFor(() => expect(api.listLlmModels).toHaveBeenCalled());
    // In flight and nothing stored: a started handshake is not a configured
    // provider, so it must not draw a "connected" row of its own.
    expect(rowOrder()).toEqual([]);

    await act(async () => {
      release?.({
        ok: true,
        vendor: "openrouter",
        endpoint: "https://openrouter.ai/api/v1/models",
        models: ["a", "b"],
        fetchedAt: "2026-01-01T00:00:00.000Z",
      });
      await Promise.resolve();
    });
    // Once the catalogue lands, the same provider IS configured and gets one.
    await waitFor(() => expect(rowOrder()).toEqual(["openrouter"]));
    expect(screen.getByTestId("llm-tab:connection-subline:openrouter"))
      .toHaveAttribute("data-provider-sync-status", "ready");
  });
});
