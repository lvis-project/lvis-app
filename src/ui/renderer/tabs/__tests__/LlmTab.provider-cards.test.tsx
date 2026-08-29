import "../../../../../test/renderer/setup.js";
import { useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { installMockLvisApi, type MockLvisApi } from "../../../../../test/renderer/mock-lvis-api.js";
import { TooltipProvider } from "../../../../components/ui/tooltip.js";
import type { LlmModelListResult } from "../../../../shared/llm-model-list.js";
import type {
  MarketplaceInstalledProviderPreset,
  MarketplaceProviderModelDiscoveryPolicy,
} from "../../../../shared/marketplace-package-assets.js";
import type { SubscriptionProviderView } from "../SubscriptionProvidersSection.js";

const useSubscriptionProvidersMock = vi.hoisted(() => vi.fn());

vi.mock("../SubscriptionProvidersController.js", () => ({
  useSubscriptionProviders: useSubscriptionProvidersMock,
}));

const { LlmTab, forgetModelListLaunchRefreshes } = await import("../LlmTab.js");
type ProviderCredentialDraft =
  import("../LlmTab.js").ProviderCredentialDraft;
type ProviderCredentialSave =
  import("../LlmTab.js").ProviderCredentialSave;

type MockApi = MockLvisApi;

/** Stable identity: LlmTab's settings effect keys off this array. */
const NO_PRESETS: readonly MarketplaceInstalledProviderPreset[] = [];

/** The endpoint the custom provider is configured with. */
const CUSTOM_ENDPOINT = "http://localhost:30000/v1";

function preset(
  providerId: string,
  label: string,
  baseUrl: string,
  /** A preset that ships its own catalogue declares it; without a policy the
   *  models are the endpoint's word and there are none until it answers. */
  modelDiscoveryPolicy?: MarketplaceProviderModelDiscoveryPolicy,
): MarketplaceInstalledProviderPreset {
  return {
    providerId,
    label,
    baseUrl,
    defaultModel: `${providerId}-default`,
    modelOptions: [`${providerId}-default`],
    apiKeyPlaceholder: "sk-...",
    requiresApiKey: true,
    ...(modelDiscoveryPolicy ? { modelDiscoveryPolicy } : {}),
  };
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
  };
}

function installSubscription(
  providers: readonly SubscriptionProviderView[],
  actions: Record<string, unknown> = {},
) {
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
      actions,
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

interface Profile {
  vendors?: Record<string, unknown>;
  installedProviderIds?: string[];
  installedProviderPresets?: readonly MarketplaceInstalledProviderPreset[];
  modelListCache?: Record<string, unknown>;
}

/**
 * An api whose settings store answers a write with the profile under test.
 *
 * The shared mock keeps its own default profile, so a row persisting the
 * catalogue it just fetched would broadcast a settings object holding none of
 * this test's providers — and cards would vanish, or lose the endpoint they
 * are configured for, mid-test and for a reason no user ever meets.
 */
function profileApi(profile: Profile, rest: MockApi = {}) {
  let settings: { llm: Record<string, unknown>; marketplace: Record<string, unknown> } = {
    llm: {
      pinnedModels: [],
      vendors: profile.vendors ?? {},
      modelListCache: profile.modelListCache ?? {},
    },
    marketplace: {
      installedProviderIds: profile.installedProviderIds ?? [],
      installedProviderPresets: profile.installedProviderPresets ?? [],
    },
  };
  const listeners = new Set<(next: unknown) => void>();
  const publish = () => {
    for (const listener of listeners) listener(settings);
  };
  const api = makeApi({
    getSettings: vi.fn(async () => settings),
    updateSettings: vi.fn(async (patch: { llm?: Record<string, unknown> }) => {
      settings = { ...settings, llm: { ...settings.llm, ...(patch.llm ?? {}) } };
      publish();
      return settings;
    }),
    onSettingsUpdated: vi.fn((listener: (next: unknown) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    ...rest,
  });
  return {
    api,
    /** A settings write landing from elsewhere, as every save broadcasts. */
    broadcast: async (vendors: Record<string, unknown>) => {
      settings = { ...settings, llm: { ...settings.llm, vendors } };
      await act(async () => {
        publish();
        await Promise.resolve();
      });
      // A second act, so the effects the broadcast queued are mounted before
      // this one waits on them — inside a single act they would not be.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
    },
  };
}

/** The generic custom provider: one stored key, one endpoint of its own. */
function genericRowApi(
  listLlmModels: MockApi["listLlmModels"] | undefined,
  baseUrl = CUSTOM_ENDPOINT,
  rest: MockApi = {},
): MockApi {
  return profileApi(
    { vendors: { "openai-compatible": baseUrl ? { baseUrl } : {} } },
    {
      hasApiKey: storedKeysFor("openai-compatible"),
      ...(listLlmModels ? { listLlmModels } : {}),
      ...rest,
    },
  ).api;
}

/** `getSettings` carrying a model-list cache, so a handshake can be pre-landed. */
function settingsWithCache(cache: Record<string, unknown>) {
  return vi.fn().mockResolvedValue({
    llm: { pinnedModels: [], modelListCache: cache },
    marketplace: { installedProviderIds: [] },
  });
}

/** `getSettings` with stored blocks, for the per-row endpoint and dirty signal. */
function settingsWithVendorBlocks(vendors: Record<string, Record<string, string>>) {
  return vi.fn().mockResolvedValue({
    llm: { pinnedModels: [], modelListCache: {}, vendors },
    marketplace: { installedProviderIds: [] },
  });
}

interface TabProps {
  vendor?: string;
  baseUrl?: string;
  /** Seeds the parent-held credential draft, as a half-typed card would. */
  draft?: ProviderCredentialDraft | null;
  hasKey?: boolean;
  model?: string;
  marketplaceProviderPresets?: readonly MarketplaceInstalledProviderPreset[];
  marketplaceProviderPresetId?: string;
  fallbackChain?: { provider: string; model: string }[];
  fallbackOpen?: boolean;
}

/** A draft for a row whose only content is a typed key. */
function keyDraft(rowId: string, vendorId: string, keyInput: string): ProviderCredentialDraft {
  return {
    rowId,
    vendorId,
    presetId: "",
    keyInput,
    baseUrl: "",
    vertexProject: "",
    vertexLocation: "",
  };
}

interface TabHooks {
  selectApiVendorModel: Mock<(vendorId: string, modelId: string) => void>;
  onSelectMarketplaceProviderPreset: Mock<(preset: MarketplaceInstalledProviderPreset) => void>;
  onClearMarketplaceProviderPreset: Mock<() => void>;
  onImmediateChange: Mock<() => void>;
  onSaveProviderCredential: Mock<(input: ProviderCredentialSave) => Promise<boolean>>;
}

function makeHooks(): TabHooks {
  return {
    selectApiVendorModel: vi.fn(),
    onSelectMarketplaceProviderPreset: vi.fn(),
    onClearMarketplaceProviderPreset: vi.fn(),
    onImmediateChange: vi.fn(),
    onSaveProviderCredential: vi.fn(async () => true),
  };
}

/**
 * The tab under its real parent contract: the credential draft is owned above
 * it, so the harness holds it in state and hands the setter down. A `vi.fn()`
 * here would make every card look permanently empty.
 */
function TabHarness({
  api,
  props,
  hooks,
}: {
  api: MockApi;
  props: TabProps;
  hooks: TabHooks;
}) {
  const [draft, setDraft] = useState<ProviderCredentialDraft | null>(props.draft ?? null);
  return (
    <TooltipProvider>
      <LlmTab
        api={api as never}
        marketplaceProviderPresets={props.marketplaceProviderPresets ?? NO_PRESETS}
        marketplaceProviderPresetId={props.marketplaceProviderPresetId ?? ""}
        vendor={props.vendor ?? "openai"}
        baseUrl={props.baseUrl ?? ""}
        hasKey={props.hasKey ?? true}
        setHasKey={vi.fn()}
        providerCredentialDraft={draft}
        onProviderCredentialDraftChange={setDraft}
        onSaveProviderCredential={hooks.onSaveProviderCredential}
        onSelectMarketplaceProviderPreset={hooks.onSelectMarketplaceProviderPreset}
        onClearMarketplaceProviderPreset={hooks.onClearMarketplaceProviderPreset}
        model={props.model ?? "gpt-5.4"}
        setModel={vi.fn()}
        selectApiVendorModel={hooks.selectApiVendorModel}
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
        onImmediateChange={hooks.onImmediateChange}
        settingsLoaded={true}
      />
    </TooltipProvider>
  );
}

async function renderTab(api: MockApi, props: TabProps = {}) {
  const hooks = makeHooks();
  const result = render(<TabHarness api={api} props={props} hooks={hooks} />);
  // The tab syncs the active vendor's catalogue on a debounce after mount.
  await act(async () => {
    await Promise.resolve();
  });
  let current = props;
  return {
    ...result,
    hooks,
    /** Move the props the parent owns — the ACTIVE provider above all — as an
     *  explicit switch really does. */
    rerender: async (next: TabProps) => {
      current = { ...current, ...next };
      result.rerender(<TabHarness api={api} props={current} hooks={hooks} />);
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

/**
 * The model chooser's contents, by the model id each row prints.
 *
 * The rendered text runs provider and id together in adjacent spans, so a
 * substring match on it can land on the wrong row; the id attribute is the
 * only unambiguous handle.
 */
async function chooserModelIds(): Promise<string[]> {
  if (!document.querySelector("[role='option']")) {
    openMenu(screen.getByTestId("llm-model-select"));
  }
  return waitFor(() => {
    const found = [...document.querySelectorAll<HTMLElement>("[role='option']")];
    if (found.length === 0) throw new Error("the model chooser did not open");
    return found.map((option) =>
      option.querySelector("[data-model-id]")?.getAttribute("data-model-id") ?? "");
  });
}

/** The open chooser's row for this model id. */
function chooserOption(modelId: string): HTMLElement {
  const option = document
    .querySelector(`[data-model-id="${modelId}"]`)
    ?.closest("[role='option']");
  if (!option) throw new Error(`the chooser offers no ${modelId}`);
  return option as HTMLElement;
}

/** The provider group a chooser row sits under, label included. */
function chooserGroupText(modelId: string): string {
  return chooserOption(modelId).closest("[role='group']")?.textContent ?? "";
}

/** Radix commits a chooser row on Enter, and only for the focused one. */
function pickChooserOption(modelId: string) {
  const option = chooserOption(modelId);
  option.focus();
  fireEvent.keyDown(option, { key: "Enter" });
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
  // Each test is its own app launch. The once-per-launch marker lives in the
  // module, so without this the second test in the file would inherit the
  // first one's "already asked" and every catalogue assertion after it would
  // be measuring the wrong run.
  forgetModelListLaunchRefreshes();
});

describe("LlmTab provider cards", () => {
  it("puts Save inside the card being edited, not on the page", async () => {
    await renderTab(makeApi(), { draft: keyDraft("openai", "openai", "sk-typed") });

    expect(screen.queryByTestId("llm-tab:save-providers")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("llm-tab:connection-toggle:openai"));

    const card = screen.getByTestId("llm-tab:connection:openai");
    expect(card).toContainElement(screen.getByTestId("llm-tab:save-providers"));
  });

  it("hides the API key field until the API-key route is chosen", async () => {
    installSubscription([codexView()]);
    await renderTab(makeApi({ hasApiKey: storedKeysFor("openai") }));

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
    const api = makeApi({
      getSettings: settingsWithVendorBlocks({ ollama: { baseUrl: "http://127.0.0.1:11434/v1" } }),
    });
    await renderTab(api, { vendor: "ollama", model: "llama3" });
    fireEvent.click(screen.getByTestId("llm-tab:connection-toggle:ollama"));
    expect(screen.getByTestId("llm-base-url-input")).toHaveValue("http://127.0.0.1:11434/v1");
  });

  it("appends an added provider below every existing card", async () => {
    installSubscription([codexView({
      status: { runtime: "ready", connection: "connected", models: [] },
    })]);
    await renderTab(makeApi());

    openMenu(screen.getByTestId("llm-tab:add-provider"));
    fireEvent.click(await screen.findByTestId("llm-tab:add-provider-item:claude"));

    const rows = rowOrder();
    expect(rows[rows.length - 1]).toBe("claude");
    expect(rows.length).toBeGreaterThan(1);
  });
});

describe("LlmTab provider cards leave the chat route alone", () => {
  it("opens an added provider's card without switching what chat runs on", async () => {
    // The live regression: picking a vendor from the add menu persisted
    // `llm.provider`, so chat moved to a provider with no credential at all.
    const api = makeApi({ hasApiKey: storedKeysFor("openai") });
    const { hooks } = await renderTab(api, { vendor: "openai", model: "" });

    openMenu(screen.getByTestId("llm-tab:add-provider"));
    fireEvent.click(await screen.findByTestId("llm-tab:add-provider-item:claude"));

    // The card is open and editable...
    expect(screen.getByTestId("llm-tab:connection:claude"))
      .toContainElement(screen.getByTestId("llm-tab:manual-section"));
    // ...and nothing was persisted by opening it.
    expect(hooks.selectApiVendorModel).not.toHaveBeenCalled();
    expect(hooks.onSelectMarketplaceProviderPreset).not.toHaveBeenCalled();
    expect(hooks.onImmediateChange).not.toHaveBeenCalled();
    expect(api.updateSettings).not.toHaveBeenCalledWith(
      expect.objectContaining({ llm: expect.objectContaining({ provider: expect.anything() }) }),
    );
    // The badge is still on the provider chat is actually using.
    expect(screen.getByTestId("llm-tab:connection-mode:openai")).toBeInTheDocument();
    expect(screen.queryByTestId("llm-tab:connection-mode:claude")).toBeNull();
  });

  it("offers no way to choose a provider on the card itself", async () => {
    // Picking a model is the whole decision. A second control that also moved
    // the route made "which provider answers" a question the screen asked
    // twice, in two places that could disagree.
    const api = makeApi({ hasApiKey: storedKeysFor("openai", "claude") });
    await renderTab(api, { vendor: "openai", model: "" });

    await screen.findByTestId("llm-tab:connection:claude");
    expect(document.querySelector("[data-testid^='llm-tab:connection-use']")).toBeNull();
  });

  it("writes only the row's own secret when its key is saved", async () => {
    const api = makeApi({ hasApiKey: storedKeysFor("openai") });
    const { hooks } = await renderTab(api, { vendor: "openai", model: "" });

    openMenu(screen.getByTestId("llm-tab:add-provider"));
    fireEvent.click(await screen.findByTestId("llm-tab:add-provider-item:claude"));
    fireEvent.change(screen.getByTestId("llm-api-key-input"), {
      target: { value: "sk-ant-new" },
    });
    await waitFor(() => expect(screen.getByTestId("llm-tab:save-providers")).toBeEnabled());
    fireEvent.click(screen.getByTestId("llm-tab:save-providers"));

    await waitFor(() => expect(hooks.onSaveProviderCredential).toHaveBeenCalledWith({
      credentialProviderId: "claude",
      vendorId: "claude",
      apiKey: "sk-ant-new",
    }));
    // A fixed-endpoint vendor owns no persisted field here, so no block is
    // written — and saving a credential is not choosing who answers.
    expect(hooks.selectApiVendorModel).not.toHaveBeenCalled();
    expect(screen.getByTestId("llm-tab:connection-mode:openai")).toBeInTheDocument();
    // The card stays open on what it committed, with the key field emptied.
    await waitFor(() => expect(screen.getByTestId("llm-api-key-input")).toHaveValue(""));
    expect(screen.getByTestId("llm-tab:connection:claude"))
      .toContainElement(screen.getByTestId("llm-tab:manual-section"));
  });

  it("edits each row's own endpoint while a third provider is the active one", async () => {
    const generic = "http://localhost:8001/v1";
    const selfHosted = "http://127.0.0.1:11434/v1";
    const api = makeApi({
      hasApiKey: storedKeysFor("openai", "openai-compatible", "ollama"),
      getSettings: vi.fn().mockResolvedValue({
        llm: {
          pinnedModels: [],
          modelListCache: {},
          vendors: {
            "openai-compatible": { baseUrl: generic },
            ollama: { baseUrl: selfHosted },
          },
        },
        marketplace: { installedProviderIds: ["ollama"], installedProviderPresets: [] },
      }),
    });
    await renderTab(api, { vendor: "openai", model: "" });

    await screen.findByTestId("llm-tab:connection:openai-compatible");
    fireEvent.click(screen.getByTestId("llm-tab:connection-toggle:openai-compatible"));
    expect(screen.getByTestId("llm-base-url-input")).toHaveValue(generic);

    fireEvent.click(screen.getByTestId("llm-tab:connection-toggle:ollama"));
    expect(screen.getByTestId("llm-base-url-input")).toHaveValue(selfHosted);
    // Neither card is the one chat is on, and neither claims to be.
    expect(screen.getByTestId("llm-tab:connection-mode:openai")).toBeInTheDocument();
  });

  it("offers no chat switch on a signed-out subscription runtime", async () => {
    installSubscription([codexView()]);
    await renderTab(makeApi({ hasApiKey: storedKeysFor("openai") }), { vendor: "openai", model: "" });

    // The runtime's own action is the single source for that route, and it is
    // simply not on offer until the user is signed in.
    expect(screen.queryByTestId("subscription-provider:codex:use-for-chat")).toBeNull();
  });

  it("names the active provider on its own card, not the open one", async () => {
    const api = makeApi({ hasApiKey: storedKeysFor("openai", "claude") });
    await renderTab(api, { vendor: "openai", model: "" });

    await screen.findByTestId("llm-tab:connection:claude");
    fireEvent.click(screen.getByTestId("llm-tab:connection-toggle:claude"));

    // Opening a card is reading, not choosing: the badge stays where the route
    // is, and the card that is merely open says nothing about it.
    expect(screen.getByTestId("llm-tab:connection-status:openai"))
      .toHaveTextContent(/API|사용/);
    expect(screen.queryByTestId("llm-tab:connection-mode:claude")).toBeNull();
  });

  it("keeps the card on screen after its only credential is deleted", async () => {
    // This row exists because of the stored key and nothing else, so removing
    // the key used to remove the place a replacement could be entered.
    const api = makeApi({ hasApiKey: storedKeysFor("claude") });
    await renderTab(api, { vendor: "openai", model: "" });

    await screen.findByTestId("llm-tab:connection:claude");
    fireEvent.click(screen.getByTestId("llm-tab:connection-toggle:claude"));
    api.hasApiKey = vi.fn(async () => false);
    fireEvent.click(screen.getByText(/^(삭제|Delete|Remove)$/));

    await waitFor(() => expect(api.deleteApiKey).toHaveBeenCalledWith("claude"));
    expect(screen.getByTestId("llm-tab:connection:claude")).toBeInTheDocument();
    expect(screen.getByTestId("llm-api-key-input")).toBeInTheDocument();
  });
});

describe("LlmTab model chooser is the whole switch", () => {
  it("leaves an uncredentialed provider out of the chooser and says so on its card", async () => {
    const api = makeApi({ hasApiKey: storedKeysFor("gemini") });
    await renderTab(api, { vendor: "gemini", model: "" });

    openMenu(screen.getByTestId("llm-tab:add-provider"));
    fireEvent.click(await screen.findByTestId("llm-tab:add-provider-item:claude"));

    // The card is there to type a key into, and it says what the key buys.
    expect(screen.getByTestId("llm-tab:connection-blocked:claude"))
      .toHaveTextContent(/키|key|Schlüssel|clave|clé|キー|密钥/i);
    // The chooser is populated — by the provider that CAN answer, only.
    const offered = await chooserModelIds();
    expect(offered).toContain("gemini-2.5-flash");
    expect(offered.some((id) => id.startsWith("claude"))).toBe(false);
  });

  it("offers a keyed provider's models and moves the route on the pick alone", async () => {
    const api = makeApi({ hasApiKey: storedKeysFor("openai", "claude") });
    const { hooks } = await renderTab(api, { vendor: "openai", model: "" });

    const offered = await chooserModelIds();
    // A curated vendor's bundled line is its catalogue, so a saved key is all
    // it takes for its models to be choosable from another provider's row.
    expect(offered).toContain("claude-sonnet-4-6");
    expect(offered).toContain("claude-opus-4-6");
    expect(chooserGroupText("claude-opus-4-6")).toMatch(/Claude/);

    pickChooserOption("claude-opus-4-6");

    // Provider and model move together, in one write, with no Save button in
    // the path — the same way the thinking controls persist.
    await waitFor(() => expect(hooks.selectApiVendorModel)
      .toHaveBeenCalledWith("claude", "claude-opus-4-6"));
    expect(hooks.onImmediateChange).toHaveBeenCalled();
    expect(hooks.onSaveProviderCredential).not.toHaveBeenCalled();
  });

  it("offers a connected subscription's models beside the API providers", async () => {
    const useForChat = vi.fn();
    installSubscription(
      [codexView({
        status: {
          runtime: "ready",
          connection: "connected",
          models: [{ id: "codex-mini", label: "codex-mini" }],
        },
      })],
      { useForChat, useApiForChat: vi.fn() },
    );
    await renderTab(makeApi({ hasApiKey: storedKeysFor("openai") }), {
      vendor: "openai",
      model: "",
    });

    expect(await chooserModelIds()).toContain("codex-mini");
    expect(chooserGroupText("codex-mini")).toMatch(/Codex/);

    pickChooserOption("codex-mini");

    // A subscription pick still goes through the runtime's own action: it is
    // a sign-in-backed route, not an API credential.
    await waitFor(() => expect(useForChat).toHaveBeenCalledWith("codex", "codex-mini"));
  });
});

describe("LlmTab preset and generic custom provider are separate rows", () => {
  // A preset that ships its own model list, so the row has something to offer
  // before any endpoint has answered.
  const acme = preset("acme-gw", "Acme Gateway", "https://acme.example/v1", "static");
  const GENERIC_ENDPOINT = "http://localhost:8001/v1";

  /** A preset is the active route; the generic row has its own saved endpoint. */
  function bothRows() {
    return makeApi({
      hasApiKey: storedKeysFor("marketplace-provider:acme-gw", "openai-compatible"),
      getSettings: vi.fn().mockResolvedValue({
        llm: {
          pinnedModels: [],
          modelListCache: {},
          vendors: { "openai-compatible": { baseUrl: GENERIC_ENDPOINT, model: "local-model" } },
        },
        marketplace: { installedProviderIds: [], installedProviderPresets: [acme] },
      }),
    });
  }

  const activePreset = {
    vendor: "openai-compatible",
    marketplaceProviderPresetId: "acme-gw",
    marketplaceProviderPresets: [acme],
    model: "acme-gw-default",
  } as const;

  it("opens the generic card on the generic endpoint, not the active preset's", async () => {
    await renderTab(bothRows(), activePreset);

    await screen.findByTestId("llm-tab:connection:openai-compatible");
    fireEvent.click(screen.getByTestId("llm-tab:connection-toggle:openai-compatible"));

    const field = screen.getByTestId("llm-base-url-input");
    expect(field).toHaveValue(GENERIC_ENDPOINT);
    expect(field).not.toHaveValue(acme.baseUrl);
  });

  it("offers a preset's models under its own name and selects the preset on the pick", async () => {
    const { hooks, rerender } = await renderTab(bothRows(), {
      vendor: "openai-compatible",
      marketplaceProviderPresets: [acme],
      model: "local-model",
    });

    await screen.findByTestId("llm-tab:connection:marketplace-provider:acme-gw");
    expect(await chooserModelIds()).toContain("acme-gw-default");
    // Two presets are two providers reached through one vendor, so the name on
    // the group has to be the preset's, not the vendor's.
    expect(chooserGroupText("acme-gw-default")).toMatch(/Acme Gateway/);

    pickChooserOption("acme-gw-default");

    await waitFor(() => expect(hooks.onSelectMarketplaceProviderPreset).toHaveBeenCalledWith(acme));
    expect(hooks.onImmediateChange).toHaveBeenCalled();

    // The parent moves the active route; the badge follows it, not the form.
    await rerender(activePreset);
    expect(screen.getByTestId("llm-tab:connection-mode:marketplace-provider:acme-gw"))
      .toBeInTheDocument();
    expect(screen.queryByTestId("llm-tab:connection-mode:openai-compatible")).toBeNull();
  });

  it("drops the preset when the generic row's own model is picked, endpoint intact", async () => {
    const { hooks, rerender } = await renderTab(bothRows(), activePreset);

    await screen.findByTestId("llm-tab:connection:openai-compatible");
    expect(await chooserModelIds()).toContain("local-model");

    pickChooserOption("local-model");

    // The generic custom provider IS this vendor without a preset.
    await waitFor(() => expect(hooks.onClearMarketplaceProviderPreset).toHaveBeenCalled());
    expect(hooks.selectApiVendorModel).toHaveBeenCalledWith("openai-compatible", "local-model");
    expect(hooks.onImmediateChange).toHaveBeenCalled();

    await rerender({
      vendor: "openai-compatible",
      marketplaceProviderPresetId: "",
      model: "local-model",
    });
    expect(screen.getByTestId("llm-tab:connection-mode:openai-compatible")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("llm-tab:connection-toggle:openai-compatible"));
    // The endpoint the user saved is still the generic row's own.
    expect(screen.getByTestId("llm-base-url-input")).toHaveValue(GENERIC_ENDPOINT);
  });
});

describe("LlmTab chat-route availability", () => {
  it("asks Vertex for a project rather than a key it never stores", async () => {
    // Vertex authenticates out of band, so the key question can never be
    // satisfied on this card — it used to leave the row permanently unusable.
    const withoutProject = makeApi({
      hasApiKey: storedKeysFor("claude"),
      getSettings: vi.fn().mockResolvedValue({
        llm: { pinnedModels: [], modelListCache: {}, vendors: {} },
        marketplace: { installedProviderIds: ["vertex-ai"], installedProviderPresets: [] },
      }),
    });
    const { unmount } = await renderTab(withoutProject, { vendor: "claude", model: "" });
    openMenu(screen.getByTestId("llm-tab:add-provider"));
    fireEvent.click(await screen.findByTestId("llm-tab:add-provider-item:vertex-ai"));

    // The card asks for the project, and says that is what is missing.
    expect(screen.getByTestId("llm-tab:manual-section")).toBeInTheDocument();
    expect(screen.queryByTestId("llm-api-key-input")).toBeNull();
    expect(screen.getByTestId("llm-tab:connection-blocked:vertex-ai"))
      .toHaveTextContent(/GCP|프로젝트|project|Projekt|proyecto|projet|プロジェクト|项目/i);
    // And nothing of Vertex's is choosable while it cannot answer.
    expect((await chooserModelIds()).some((id) => id.startsWith("gemini"))).toBe(false);
    unmount();

    const withProject = makeApi({
      hasApiKey: storedKeysFor("claude"),
      getSettings: vi.fn().mockResolvedValue({
        llm: {
          pinnedModels: [],
          modelListCache: {},
          vendors: { "vertex-ai": { vertexProject: "my-gcp-project" } },
        },
        marketplace: { installedProviderIds: ["vertex-ai"], installedProviderPresets: [] },
      }),
    });
    const { hooks } = await renderTab(withProject, { vendor: "claude", model: "" });
    openMenu(screen.getByTestId("llm-tab:add-provider"));
    fireEvent.click(await screen.findByTestId("llm-tab:add-provider-item:vertex-ai"));

    await waitFor(() =>
      expect(screen.queryByTestId("llm-tab:connection-blocked:vertex-ai")).toBeNull());
    // With the project stored the row is choosable like any other — through
    // the one chooser, with no second control of its own.
    expect(await chooserModelIds()).toContain("gemini-2.5-flash");
    expect(chooserGroupText("gemini-2.5-flash")).toMatch(/Vertex/i);

    pickChooserOption("gemini-2.5-flash");
    await waitFor(() => expect(hooks.selectApiVendorModel)
      .toHaveBeenCalledWith("vertex-ai", "gemini-2.5-flash"));
  });
});

describe("LlmTab rows that are not the active one", () => {
  const acme = preset("acme-gw", "Acme Gateway", "https://acme.example/v1");
  const zenith = preset("zenith-gw", "Zenith Gateway", "https://zenith.example/v1");

  it("syncs a credentialed row against its OWN endpoint and offers what it answers", async () => {
    // The regression: the catalogue sync only ever carried the ACTIVE route's
    // address, so a configured generic custom provider that was not the active
    // one synced against nothing — its models could never land, and a provider
    // the user had fully set up was absent from the only switch there is.
    const api = genericRowApi(
      vi.fn(async (request: { vendor: string; baseUrl?: string }) =>
        request.vendor === "openai-compatible" && request.baseUrl === CUSTOM_ENDPOINT
          ? {
            ok: true,
            vendor: "openai-compatible",
            endpoint: `${CUSTOM_ENDPOINT}/models`,
            models: ["served-by-the-endpoint"],
            fetchedAt: "2026-01-01T00:00:00.000Z",
          } satisfies LlmModelListResult
          : FETCH_FAILED),
      CUSTOM_ENDPOINT,
      { hasApiKey: storedKeysFor("claude", "openai-compatible") },
    );
    await renderTab(api, { vendor: "claude", model: "claude-sonnet-4-6" });

    await waitFor(() => expect(api.listLlmModels).toHaveBeenCalledWith(
      expect.objectContaining({ vendor: "openai-compatible", baseUrl: CUSTOM_ENDPOINT }),
    ));
    await waitFor(async () =>
      expect(await chooserModelIds()).toContain("served-by-the-endpoint"));
    expect(chooserGroupText("served-by-the-endpoint")).not.toMatch(/Claude/);
  });

  it("says a credentialed row has nothing to choose until its endpoint answers", async () => {
    const api = genericRowApi(
      vi.fn(() => new Promise<LlmModelListResult>(() => {})),
      CUSTOM_ENDPOINT,
      { hasApiKey: storedKeysFor("claude", "openai-compatible") },
    );
    await renderTab(api, { vendor: "claude", model: "claude-sonnet-4-6" });

    // The card says why it is not in the list, rather than looking ready while
    // the chooser silently omits it.
    const note = await screen.findByTestId("llm-tab:connection-blocked:openai-compatible");
    expect(note.textContent?.trim()).not.toBe("");
    expect((await chooserModelIds()).every((id) => id.startsWith("claude"))).toBe(true);
  });

  it("reads each preset row's own stored model, never another row's", async () => {
    // Every one of these rows is reached through the openai-compatible vendor.
    // They used to share that block's single `model`, so the chooser showed the
    // same id under all three names.
    const api = makeApi({
      hasApiKey: storedKeysFor(
        "claude",
        "marketplace-provider:acme-gw",
        "marketplace-provider:zenith-gw",
        "openai-compatible",
      ),
      getSettings: vi.fn().mockResolvedValue({
        llm: {
          pinnedModels: [],
          modelListCache: {},
          vendors: {
            "openai-compatible": {
              baseUrl: CUSTOM_ENDPOINT,
              model: "generic-own-model",
              presetModels: { "acme-gw": "acme/chosen", "zenith-gw": "zenith/chosen" },
            },
          },
        },
        marketplace: { installedProviderIds: [], installedProviderPresets: [acme, zenith] },
      }),
      listLlmModels: vi.fn(() => new Promise<LlmModelListResult>(() => {})),
    });
    await renderTab(api, {
      vendor: "claude",
      model: "claude-sonnet-4-6",
      marketplaceProviderPresets: [acme, zenith],
    });

    await screen.findByTestId("llm-tab:connection:marketplace-provider:acme-gw");
    const offered = await chooserModelIds();
    expect(offered).toContain("acme/chosen");
    expect(offered).toContain("zenith/chosen");
    expect(offered).toContain("generic-own-model");
    expect(chooserGroupText("acme/chosen")).toMatch(/Acme Gateway/);
    expect(chooserGroupText("zenith/chosen")).toMatch(/Zenith Gateway/);
  });

  it("points at the model list after a save instead of switching to what was saved", async () => {
    // The user's decision: saving a credential never moves the conversation,
    // not even when the provider it is on cannot answer. What the save owes is
    // the pointer to the one switch there is.
    const api = makeApi({ hasApiKey: storedKeysFor() });
    const { hooks } = await renderTab(api, { vendor: "openai", hasKey: false, model: "" });

    openMenu(screen.getByTestId("llm-tab:add-provider"));
    fireEvent.click(await screen.findByTestId("llm-tab:add-provider-item:claude"));
    fireEvent.change(screen.getByTestId("llm-api-key-input"), {
      target: { value: "sk-ant-new" },
    });
    await waitFor(() => expect(screen.getByTestId("llm-tab:save-providers")).toBeEnabled());
    fireEvent.click(screen.getByTestId("llm-tab:save-providers"));

    await screen.findByTestId("llm-tab:connection-pick-model:claude");
    expect(hooks.selectApiVendorModel).not.toHaveBeenCalled();
    expect(hooks.onSelectMarketplaceProviderPreset).not.toHaveBeenCalled();
    expect(hooks.onImmediateChange).not.toHaveBeenCalled();
  });
});

describe("LlmTab asks only the rows that have a catalogue to give", () => {
  /**
   * Let the sync debounce elapse. Asserting "nothing was asked" before the
   * window opens proves nothing at all.
   */
  async function settleSyncDebounce() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 550));
    });
  }

  /** Every endpoint the tab actually asked for a model list, in call order. */
  function requestedEndpoints(api: MockApi): string[] {
    return (api.listLlmModels as Mock<(request: {
      vendor: string; baseUrl?: string;
    }) => unknown>).mock.calls
      .map(([request]) => request.baseUrl ?? `<fixed:${request.vendor}>`);
  }

  it("asks a paired vendor's fixed endpoint, since a stored key makes it an API row too", async () => {
    // OpenAI's `/models` is fixed and known, so a stored key is all it takes to
    // ask — the card is the Codex runtime's AND a configured API route's, and
    // the API half is entitled to its own catalogue. What must not happen is
    // that call being reported on a card with no API route: see
    // "keeps a subscription card free of a sync line…" above.
    const api = makeApi({ hasApiKey: storedKeysFor("openai") });
    installSubscription([codexView()]);
    await renderTab(api, { vendor: "claude", model: "claude-sonnet-4-6", hasKey: false });

    await waitFor(() => expect(rowOrder()).toEqual(["codex"]));
    await settleSyncDebounce();
    expect(requestedEndpoints(api)).toEqual(["<fixed:openai>"]);
  });

  it("keeps a subscription card free of a sync line for an API path it has not configured", async () => {
    // The card borrows its API counterpart's cache key, so whatever is filed
    // under that key — here the active route's own "no credential stored"
    // answer — would otherwise be printed on a signed-in runtime's card as if
    // the runtime had made that call.
    const api = makeApi({ hasApiKey: storedKeysFor() });
    installSubscription([codexView({
      status: { runtime: "ready", connection: "connected", models: [] },
    })]);
    await renderTab(api, { vendor: "openai", model: "", hasKey: false });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 550));
    });

    expect(rowOrder()).toEqual(["codex"]);
    expect(screen.queryByTestId("llm-tab:connection-subline:codex")).toBeNull();
  });

  it("asks nothing of a vendor whose model list is curated here", async () => {
    // Azure AI Foundry's endpoint is one deployment's address, not a catalogue,
    // and its models are the bundled list — so there is nothing to ask it for.
    const api = makeApi({
      hasApiKey: storedKeysFor("azure-foundry"),
      getSettings: vi.fn().mockResolvedValue({
        llm: {
          pinnedModels: [],
          modelListCache: {},
          vendors: { "azure-foundry": { baseUrl: "https://example-resource.example/deployments/gpt" } },
        },
        marketplace: { installedProviderIds: ["azure-foundry"], installedProviderPresets: [] },
      }),
    });
    await renderTab(api, { vendor: "claude", model: "claude-sonnet-4-6" });

    await screen.findByTestId("llm-tab:connection:azure-foundry");
    await settleSyncDebounce();
    expect(requestedEndpoints(api)).toEqual([]);
    // And its curated models are still choosable, so nothing was lost.
    expect(await chooserModelIds()).toContain("gpt-5.4-mini");
  });

  it("asks a preset that declares its models nothing, and one that does not for its list", async () => {
    const declared = preset("declared-gw", "Declared Gateway", "https://declared.example/v1", "static");
    const asked = preset("asked-gw", "Asked Gateway", "https://asked.example/v1");
    const api = makeApi({
      hasApiKey: storedKeysFor(
        "marketplace-provider:declared-gw",
        "marketplace-provider:asked-gw",
      ),
      getSettings: vi.fn().mockResolvedValue({
        llm: { pinnedModels: [], modelListCache: {}, vendors: {} },
        marketplace: {
          installedProviderIds: [],
          installedProviderPresets: [declared, asked],
        },
      }),
    });
    await renderTab(api, {
      vendor: "claude",
      model: "claude-sonnet-4-6",
      marketplaceProviderPresets: [declared, asked],
    });

    await screen.findByTestId("llm-tab:connection:marketplace-provider:declared-gw");
    await waitFor(() => expect(requestedEndpoints(api)).toEqual(["https://asked.example/v1"]));
    // The declaring preset needs no handshake to be choosable.
    expect(await chooserModelIds()).toContain("declared-gw-default");
  });

  it("asks a credentialed custom provider for the list at its own endpoint", async () => {
    const api = makeApi({
      hasApiKey: storedKeysFor("openai-compatible"),
      getSettings: vi.fn().mockResolvedValue({
        llm: {
          pinnedModels: [],
          modelListCache: {},
          vendors: { "openai-compatible": { baseUrl: CUSTOM_ENDPOINT } },
        },
        marketplace: { installedProviderIds: [], installedProviderPresets: [] },
      }),
    });
    await renderTab(api, { vendor: "claude", model: "claude-sonnet-4-6" });

    await waitFor(() => expect(requestedEndpoints(api)).toEqual([CUSTOM_ENDPOINT]));
  });

  it("asks nothing for a row with no credential, and says that is what is missing", async () => {
    const api = makeApi({
      hasApiKey: storedKeysFor(),
      getSettings: vi.fn().mockResolvedValue({
        llm: { pinnedModels: [], modelListCache: {}, vendors: {} },
        marketplace: { installedProviderIds: ["openrouter"], installedProviderPresets: [] },
      }),
    });
    await renderTab(api, { vendor: "claude", model: "claude-sonnet-4-6" });

    for (const vendorId of ["openrouter", "gemini", "openai"]) {
      openMenu(screen.getByTestId("llm-tab:add-provider"));
      fireEvent.click(await screen.findByTestId(`llm-tab:add-provider-item:${vendorId}`));
      expect(screen.getByTestId(`llm-tab:connection-blocked:${vendorId}`))
        .toHaveTextContent(/키|key|Schlüssel|clave|clé|キー|密钥/i);
    }
    await settleSyncDebounce();
    expect(requestedEndpoints(api)).toEqual([]);
  });
});

describe("LlmTab says which kind of nothing a row has", () => {
  const NOT_ASKED = /아직|yet|noch|Aún|encore|まだ|暂无/i;
  const EMPTY = /비어|empty|leere|vacía|vide|空/i;
  const FAILED = /못했습니다|Could not|konnte nicht|No se pudo|Impossible|できませんでした|无法/i;

  const genericRow = genericRowApi;

  async function blockerText(): Promise<string> {
    const note = await screen.findByTestId("llm-tab:connection-blocked:openai-compatible");
    return note.textContent ?? "";
  }

  it("says the list has not been asked for when the row has no endpoint yet", async () => {
    const api = genericRow(undefined, "");
    await renderTab(api, { vendor: "claude", model: "claude-sonnet-4-6" });

    expect(await blockerText()).toMatch(NOT_ASKED);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 550));
    });
    expect(api.listLlmModels).not.toHaveBeenCalled();
  });

  it("says the same while the endpoint has been asked and has not answered", async () => {
    const api = genericRow(vi.fn(() => new Promise<LlmModelListResult>(() => {})));
    await renderTab(api, { vendor: "claude", model: "claude-sonnet-4-6" });

    await waitFor(() => expect(api.listLlmModels).toHaveBeenCalled());
    expect(await blockerText()).toMatch(NOT_ASKED);
  });

  it("says the list could not be read when the handshake failed", async () => {
    const api = genericRow(vi.fn(async () => FETCH_FAILED));
    await renderTab(api, { vendor: "claude", model: "claude-sonnet-4-6" });

    await waitFor(async () => expect(await blockerText()).toMatch(FAILED));
  });

  it("says the list came back empty when the endpoint answered with none", async () => {
    const api = genericRow(vi.fn(async () => ({
      ok: true,
      vendor: "openai-compatible",
      endpoint: `${CUSTOM_ENDPOINT}/models`,
      models: [],
      fetchedAt: "2026-01-01T00:00:00.000Z",
    } satisfies LlmModelListResult)));
    await renderTab(api, { vendor: "claude", model: "claude-sonnet-4-6" });

    await waitFor(async () => expect(await blockerText()).toMatch(EMPTY));
  });

  it("says it on the ACTIVE row too, whose own catalogue came back empty", async () => {
    // The row chat is running on is the one where an empty list matters most:
    // with no model saved there is nothing to send, and "has not answered yet"
    // would be the wrong account of an endpoint that answered with nothing.
    const api = genericRow(vi.fn(async () => ({
      ok: true,
      vendor: "openai-compatible",
      endpoint: `${CUSTOM_ENDPOINT}/models`,
      models: [],
      fetchedAt: "2026-01-01T00:00:00.000Z",
    } satisfies LlmModelListResult)));
    await renderTab(api, {
      vendor: "openai-compatible",
      baseUrl: CUSTOM_ENDPOINT,
      model: "",
    });

    await waitFor(async () => expect(await blockerText()).toMatch(EMPTY));
  });

  /** Longer than the sync debounce, so a queued request has actually fired. */
  const PAST_THE_SYNC_DEBOUNCE_MS = 550;

  function broadcast(api: MockApi, vendors: Record<string, unknown>) {
    const handler = (api.onSettingsUpdated as Mock).mock.calls.at(-1)?.[0] as
      ((s: unknown) => void) | undefined;
    expect(handler).toBeTruthy();
    return (async () => {
      await act(async () => {
        handler!({
          llm: { provider: "claude", pinnedModels: [], modelListCache: {}, vendors },
          marketplace: { installedProviderIds: [], installedProviderPresets: [] },
        });
        await Promise.resolve();
      });
      // A second act, so the effects the broadcast queued are already mounted
      // when the debounce window opens — inside one act they would not be.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, PAST_THE_SYNC_DEBOUNCE_MS));
      });
    })();
  }

  it("does not ask a failed endpoint again on a broadcast that changed nothing", async () => {
    // Every settings write broadcasts one of these, and a fresh object identity
    // each time re-ran every effect reading a row's endpoint — including the
    // one that asks endpoints for their catalogues.
    const api = genericRow(vi.fn(async () => FETCH_FAILED));
    await renderTab(api, { vendor: "claude", model: "claude-sonnet-4-6" });

    await waitFor(async () => expect(await blockerText()).toMatch(FAILED));
    const asked = (api.listLlmModels as Mock).mock.calls.length;

    await broadcast(api, { "openai-compatible": { baseUrl: CUSTOM_ENDPOINT } });

    expect((api.listLlmModels as Mock).mock.calls.length).toBe(asked);
  });

  it("does not re-ask an endpoint mid-handshake when a broadcast changed nothing", async () => {
    // The broadcast carries the same vendor content, so nothing about this row
    // moved. A fresh object identity for the vendor map on every settings write
    // was enough to re-run the sync and ask again while the first ask was
    // still in flight.
    const api = genericRow(vi.fn(() => new Promise<LlmModelListResult>(() => {})));
    await renderTab(api, { vendor: "claude", model: "claude-sonnet-4-6" });

    await waitFor(() => expect((api.listLlmModels as Mock).mock.calls.length).toBe(1));

    await broadcast(api, { "openai-compatible": { baseUrl: CUSTOM_ENDPOINT } });

    expect((api.listLlmModels as Mock).mock.calls.length).toBe(1);
  });

  it("does not ask a failed endpoint again when some other row changes", async () => {
    // Here the broadcast IS news — another vendor's block moved — so the effect
    // legitimately re-runs. This row's own inputs did not change, and a failure
    // is an answer: re-asking on someone else's edit is how one unreachable
    // endpoint became a request per settings write.
    const api = genericRow(vi.fn(async () => FETCH_FAILED));
    await renderTab(api, { vendor: "claude", model: "claude-sonnet-4-6" });

    await waitFor(async () => expect(await blockerText()).toMatch(FAILED));
    const asked = (api.listLlmModels as Mock).mock.calls.length;

    await broadcast(api, {
      "openai-compatible": { baseUrl: CUSTOM_ENDPOINT },
      ollama: { baseUrl: "http://127.0.0.1:11434/v1" },
    });

    expect((api.listLlmModels as Mock).mock.calls.length).toBe(asked);
  });
});

describe("LlmTab model lists are cached, not re-fetched", () => {
  const gateway = preset("acme-gw", "Acme Gateway", "https://acme.example/v1");
  const GATEWAY_SECRET = "marketplace-provider:acme-gw";
  const CACHED_MODEL = "cached-from-the-endpoint";
  const genericKey = ["openai-compatible", CUSTOM_ENDPOINT, ""].join("\n");
  const AZURE_ENDPOINT = "https://example-resource.example/deployments/gpt";

  /** This block's profile, with its gateway preset installed throughout. */
  const presetProfile = (profile: Profile, rest: MockApi = {}) =>
    profileApi({ ...profile, installedProviderPresets: [gateway] }, rest);

  function cacheEntry(baseUrl: string, models: string[], credentialScope?: string) {
    return {
      vendor: "openai-compatible",
      baseUrl,
      ...(credentialScope ? { credentialScope } : {}),
      endpoint: `${baseUrl}/models`,
      models,
      fetchedAt: "2026-01-01T00:00:00.000Z",
    };
  }

  /** An endpoint that answers, so a request can be told from a cache read. */
  function answering(models: string[]) {
    return vi.fn(async (request: { vendor: string; baseUrl?: string }) => ({
      ok: true,
      vendor: request.vendor,
      endpoint: `${request.baseUrl ?? ""}/models`,
      models,
      fetchedAt: "2026-02-02T00:00:00.000Z",
    } satisfies LlmModelListResult));
  }

  function askedCount(api: MockApi): number {
    return (api.listLlmModels as Mock).mock.calls.length;
  }

  function askedAddresses(api: MockApi): string[] {
    return (api.listLlmModels as Mock).mock.calls
      .map(([request]) => (request as { baseUrl?: string }).baseUrl ?? "");
  }

  it("renders the cached catalogue without waiting on a request", async () => {
    // A model list is a catalogue, not live data. A chooser that blanks itself
    // until a network call returns is what this policy exists to remove: the
    // request below never resolves, and the list is still there.
    const { api } = presetProfile({
      vendors: { "openai-compatible": { baseUrl: CUSTOM_ENDPOINT } },
      modelListCache: { [genericKey]: cacheEntry(CUSTOM_ENDPOINT, [CACHED_MODEL]) },
    }, {
      hasApiKey: storedKeysFor("openai-compatible"),
      listLlmModels: vi.fn(() => new Promise<LlmModelListResult>(() => {})),
    });
    await renderTab(api, { vendor: "claude", model: "claude-sonnet-4-6" });

    expect(await chooserModelIds()).toContain(CACHED_MODEL);
  });

  it("asks nothing when the settings tab is opened again in the same launch", async () => {
    const { api } = presetProfile({
      vendors: { "openai-compatible": { baseUrl: CUSTOM_ENDPOINT } },
      modelListCache: { [genericKey]: cacheEntry(CUSTOM_ENDPOINT, [CACHED_MODEL]) },
    }, {
      hasApiKey: storedKeysFor("openai-compatible"),
      listLlmModels: answering([CACHED_MODEL]),
    });
    const first = await renderTab(api, { vendor: "claude", model: "claude-sonnet-4-6" });
    await waitFor(() => expect(askedCount(api)).toBe(1));
    first.unmount();

    await renderTab(api, { vendor: "claude", model: "claude-sonnet-4-6" });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });

    // Leaving the settings tab and coming back is not a new launch.
    expect(askedCount(api)).toBe(1);
  });

  it("asks each routed row exactly once when the app runs again", async () => {
    const { api } = presetProfile({
      vendors: { "openai-compatible": { baseUrl: CUSTOM_ENDPOINT }, "azure-foundry": { baseUrl: AZURE_ENDPOINT } },
      installedProviderIds: ["azure-foundry"],
      modelListCache: {
        [genericKey]: cacheEntry(CUSTOM_ENDPOINT, [CACHED_MODEL]),
        [["openai-compatible", gateway.baseUrl, gateway.providerId].join("\n")]:
          cacheEntry(gateway.baseUrl, ["gateway-model"], gateway.providerId),
      },
    }, {
      hasApiKey: storedKeysFor("openai-compatible", GATEWAY_SECRET, "azure-foundry"),
      listLlmModels: answering([CACHED_MODEL]),
    });
    // The marker is per launch and lives in the module, so a test crosses that
    // boundary by forgetting it — which is the whole of what a restart does.
    forgetModelListLaunchRefreshes();
    await renderTab(api, {
      vendor: "claude",
      model: "claude-sonnet-4-6",
      marketplaceProviderPresets: [gateway],
    });

    await waitFor(() => expect(askedCount(api)).toBe(2));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    // The two routed rows, once each — and never Foundry, whose list is
    // curated here however its endpoint is configured.
    expect(askedAddresses(api).sort()).toEqual([CUSTOM_ENDPOINT, gateway.baseUrl].sort());
  });

  it("asks once more when a row's endpoint moves", async () => {
    const MOVED = "http://localhost:31000/v1";
    const { api, broadcast } = presetProfile({
      vendors: { "openai-compatible": { baseUrl: CUSTOM_ENDPOINT } },
      modelListCache: { [genericKey]: cacheEntry(CUSTOM_ENDPOINT, [CACHED_MODEL]) },
    }, {
      hasApiKey: storedKeysFor("openai-compatible"),
      listLlmModels: answering([CACHED_MODEL]),
    });
    await renderTab(api, { vendor: "claude", model: "claude-sonnet-4-6" });
    await waitFor(() => expect(askedCount(api)).toBe(1));

    await broadcast({ "openai-compatible": { baseUrl: MOVED } });

    // A different address is a different catalogue, and no cache entry names
    // this one yet.
    await waitFor(() => expect(askedCount(api)).toBe(2));
    expect((api.listLlmModels as Mock).mock.calls.at(-1)?.[0]).toMatchObject({ baseUrl: MOVED });
  });

  it("asks nothing when a broadcast says the same thing in a different order", async () => {
    const { api, broadcast } = presetProfile({
      vendors: { "openai-compatible": { baseUrl: CUSTOM_ENDPOINT, enableThinking: true } },
      modelListCache: { [genericKey]: cacheEntry(CUSTOM_ENDPOINT, [CACHED_MODEL]) },
    }, {
      hasApiKey: storedKeysFor("openai-compatible"),
      listLlmModels: answering([CACHED_MODEL]),
    });
    await renderTab(api, { vendor: "claude", model: "claude-sonnet-4-6" });
    await waitFor(() => expect(askedCount(api)).toBe(1));

    // The same block with its keys written the other way round: identical
    // settings, which a serialized comparison would have called news.
    await broadcast({ "openai-compatible": { enableThinking: true, baseUrl: CUSTOM_ENDPOINT } });

    expect(askedCount(api)).toBe(1);
  });

  it("asks again when the card's refresh is pressed, cached or not", async () => {
    const { api } = presetProfile({
      vendors: { "openai-compatible": { baseUrl: CUSTOM_ENDPOINT } },
      modelListCache: { [genericKey]: cacheEntry(CUSTOM_ENDPOINT, [CACHED_MODEL]) },
    }, {
      hasApiKey: storedKeysFor("openai-compatible"),
      listLlmModels: answering([CACHED_MODEL, "and-a-new-one"]),
    });
    await renderTab(api, { vendor: "claude", model: "claude-sonnet-4-6" });
    await waitFor(() => expect(askedCount(api)).toBe(1));

    fireEvent.click(screen.getByTestId("llm-tab:connection-refresh:openai-compatible"));

    // The press is the one thing that lifts both the cache and the marker.
    await waitFor(() => expect(askedCount(api)).toBe(2));
    expect(await chooserModelIds()).toContain("and-a-new-one");
  });

  it("offers a refresh only on the cards that have a list to refresh", async () => {
    const { api } = presetProfile({
      vendors: { "openai-compatible": { baseUrl: CUSTOM_ENDPOINT }, "azure-foundry": { baseUrl: AZURE_ENDPOINT } },
      installedProviderIds: ["azure-foundry"],
      modelListCache: { [genericKey]: cacheEntry(CUSTOM_ENDPOINT, [CACHED_MODEL]) },
    }, {
      hasApiKey: storedKeysFor("openai-compatible", "azure-foundry", "claude"),
      listLlmModels: answering([CACHED_MODEL]),
    });
    await renderTab(api, { vendor: "claude", model: "claude-sonnet-4-6" });

    await screen.findByTestId("llm-tab:connection:azure-foundry");
    expect(screen.getByTestId("llm-tab:connection-refresh:openai-compatible")).toBeInTheDocument();
    // A curated list has no endpoint to ask, so there is nothing to offer.
    expect(screen.queryByTestId("llm-tab:connection-refresh:azure-foundry")).toBeNull();
    expect(screen.queryByTestId("llm-tab:connection-refresh:claude")).toBeNull();
  });

  it("asks a row again once its credential is replaced", async () => {
    // The cache key is built from vendor, address and scope — never from the
    // credential — so a key stored over a broken one changes nothing the key
    // can see, and the launch marker alone would hold the row on its failure.
    let answer: LlmModelListResult = FETCH_FAILED;
    const { api } = presetProfile({
      vendors: { "openai-compatible": { baseUrl: CUSTOM_ENDPOINT } },
    }, {
      hasApiKey: storedKeysFor("openai-compatible"),
      listLlmModels: vi.fn(async () => answer),
    });
    const { hooks } = await renderTab(api, { vendor: "claude", model: "claude-sonnet-4-6" });

    await waitFor(() => expect(screen.getByTestId("llm-tab:connection-subline:openai-compatible"))
      .toHaveAttribute("data-provider-sync-status", "error"));
    expect(askedCount(api)).toBe(1);

    answer = {
      ok: true,
      vendor: "openai-compatible",
      endpoint: `${CUSTOM_ENDPOINT}/models`,
      models: ["works-now"],
      fetchedAt: "2026-03-03T00:00:00.000Z",
    };
    fireEvent.click(screen.getByTestId("llm-tab:connection-toggle:openai-compatible"));
    fireEvent.change(screen.getByTestId("llm-api-key-input"), { target: { value: "sk-fixed" } });
    await waitFor(() => expect(screen.getByTestId("llm-tab:save-providers")).toBeEnabled());
    fireEvent.click(screen.getByTestId("llm-tab:save-providers"));

    await waitFor(() => expect(hooks.onSaveProviderCredential).toHaveBeenCalled());
    await waitFor(() => expect(askedCount(api)).toBe(2));
    await waitFor(() => expect(screen.getByTestId("llm-tab:connection-subline:openai-compatible"))
      .toHaveAttribute("data-provider-sync-status", "ready"));
  });

  it("lands a fetched list where the fallback chain reads it", async () => {
    // The write went to `vendor\n<address>\n` and the read looked under
    // `vendor\n\n`, so a vendor with an address of its own offered the
    // fallback dropdown nothing however well its endpoint had answered.
    const { api } = presetProfile({
      installedProviderIds: ["openrouter"],
    }, {
      hasApiKey: storedKeysFor("openrouter"),
      listLlmModels: answering(["router/one", "router/two"]),
    });
    await renderTab(api, {
      vendor: "claude",
      model: "claude-sonnet-4-6",
      fallbackOpen: true,
      fallbackChain: [{ provider: "openrouter", model: "router/one" }],
    });

    await waitFor(() => expect(askedCount(api)).toBeGreaterThan(0));
    const section = screen.getByTestId("fallback-chain-section");
    const triggers = [...section.querySelectorAll<HTMLElement>("[role='combobox']")];
    openMenu(triggers[triggers.length - 1]!);

    await waitFor(() => {
      const offered = [...document.querySelectorAll<HTMLElement>("[role='option'] [data-model-id]")]
        .map((node) => node.getAttribute("data-model-id"));
      expect(offered).toContain("router/two");
    });
  });

  it("ignores a cache entry filed under an address the row no longer uses", async () => {
    // An older build filed this vendor's catalogue under a different address.
    // Binding the row to that entry left it reading a key nothing writes any
    // more — an old catalogue with no way to refresh.
    const { api } = presetProfile({
      vendors: { "openai-compatible": { baseUrl: CUSTOM_ENDPOINT } },
      modelListCache: {
        [["openai-compatible", "http://stale.invalid/v1", ""].join("\n")]:
          cacheEntry("http://stale.invalid/v1", ["from-the-old-address"]),
      },
    }, {
      hasApiKey: storedKeysFor("openai-compatible"),
      listLlmModels: answering(["from-the-current-address"]),
    });
    await renderTab(api, { vendor: "claude", model: "claude-sonnet-4-6" });

    await waitFor(() => expect(askedCount(api)).toBeGreaterThan(0));
    expect(askedAddresses(api)).toContain(CUSTOM_ENDPOINT);
    expect(askedAddresses(api)).not.toContain("http://stale.invalid/v1");
    const offered = await chooserModelIds();
    expect(offered).toContain("from-the-current-address");
    expect(offered).not.toContain("from-the-old-address");
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
      // The launch refresh confirms the cached catalogue, so the endpoint
      // answers here; a failure would leave the row on its cached list and say
      // so, which is a different test.
      listLlmModels: vi.fn(async () => ({
        ok: true,
        vendor: "openai-compatible",
        endpoint: "https://acme.example/v1/models",
        models: ["acme-1", "acme-2"],
        fetchedAt: "2026-01-02T00:00:00.000Z",
      } satisfies LlmModelListResult)),
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
    await renderTab(
      makeApi({ getSettings: settingsWithVendorBlocks({ "openai-compatible": saved }) }),
      { vendor: "openai-compatible", model: "local-model" },
    );
    fireEvent.click(screen.getByTestId("llm-tab:connection-toggle:openai-compatible"));
    // Opened on the stored endpoint, so there is nothing to commit yet.
    await waitFor(() => expect(screen.getByTestId("llm-tab:save-providers")).toBeDisabled());

    fireEvent.change(screen.getByTestId("llm-base-url-input"), {
      target: { value: "http://localhost:9999/v1" },
    });
    await waitFor(() => expect(screen.getByTestId("llm-tab:save-providers")).toBeEnabled());
  });

  it("keeps a card with uncommitted input on screen and marks it when collapsed", async () => {
    // Nothing was added and nothing is configured: this row exists only
    // because the draft does — which is the part that survives a remount.
    await renderTab(makeApi(), {
      vendor: "claude",
      hasKey: false,
      draft: keyDraft("claude", "claude", "sk-ant-typed"),
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
    })]);
    await renderTab(api, { model: "", hasKey: false });

    await waitFor(() => expect(api.hasApiKey).toHaveBeenCalledWith("openai"));
    expect(api.listLlmModels).not.toHaveBeenCalled();

    // Nothing is stored, so this card has no API path — and no sync line for
    // one. The runtime it does have is signed in and healthy, so the card says
    // nothing is missing either.
    expect(screen.queryByTestId("llm-tab:connection-subline:codex")).toBeNull();
    expect(screen.queryByTestId("llm-tab:connection-blocked:codex")).toBeNull();
    // And no second, API-side OpenAI row conjured out of the attempt.
    expect(rowOrder()).toEqual(["codex"]);
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
    // The live shape: the active provider is OpenAI, and the openai-compatible
    // provider is configured with a custom endpoint of its own. Clicking its
    // card must show THAT endpoint, without the active provider moving.
    const api = makeApi({
      hasApiKey: storedKeysFor("openai", "openai-compatible"),
      getSettings: vi.fn().mockResolvedValue({
        llm: {
          pinnedModels: [],
          vendors: { "openai-compatible": { baseUrl: CUSTOM_ENDPOINT, model: "local-27b" } },
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
    const { hooks } = await renderTab(api, { vendor: "openai", model: "", hasKey: true });
    await waitFor(() =>
      expect(screen.getByTestId("llm-tab:connection:openai-compatible")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("llm-tab:connection-toggle:openai-compatible"));
    const card = screen.getByTestId("llm-tab:connection:openai-compatible");
    expect(card).toContainElement(screen.getByTestId("llm-tab:manual-section"));
    // Row X's field, while the active provider is still Y.
    expect(screen.getByTestId("llm-base-url-input")).toHaveValue(CUSTOM_ENDPOINT);
    expect(hooks.selectApiVendorModel).not.toHaveBeenCalled();
    expect(hooks.onImmediateChange).not.toHaveBeenCalled();
    // And the badge stays where chat actually is.
    expect(screen.getByTestId("llm-tab:connection-mode:codex")).toBeInTheDocument();
    expect(screen.queryByTestId("llm-tab:connection-mode:openai-compatible")).toBeNull();
  });

  it("locks the endpoint on a preset row and not on the generic one beside it", async () => {
    const presets = [preset("acme-gw", "Acme Gateway", "https://acme.example/v1")];
    const api = makeApi({
      hasApiKey: storedKeysFor("openai-compatible"),
      getSettings: settingsWithVendorBlocks({ "openai-compatible": { baseUrl: CUSTOM_ENDPOINT } }),
    });
    await renderTab(api, {
      vendor: "openai-compatible",
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
    const api = makeApi({
      hasApiKey: storedKeysFor("openai-compatible"),
      getSettings: settingsWithVendorBlocks({ "openai-compatible": { baseUrl: CUSTOM_ENDPOINT } }),
    });
    await renderTab(api, {
      vendor: "openai-compatible",
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
    await renderTab(api, { vendor: "claude", hasKey: false, model: "" });

    // Radix opens the menu on pointerdown; a bare click never renders items.
    fireEvent.click(screen.getByTestId("llm-tab:add-provider"));
    expect(screen.queryByTestId("llm-tab:add-provider-item:ollama")).toBeNull();

    openMenu(screen.getByTestId("llm-tab:add-provider"));
    fireEvent.click(await screen.findByTestId("llm-tab:add-provider-item:ollama"));

    // Directly above the button that created it.
    const rows = rowOrder();
    expect(rows[rows.length - 1]).toBe("ollama");

    // The card offers its endpoint straight away and the caret is in it.
    const field = await screen.findByTestId("llm-base-url-input");
    expect(screen.getByTestId("llm-tab:connection:ollama")).toContainElement(field);
    await waitFor(() => expect(field).toHaveFocus());
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
