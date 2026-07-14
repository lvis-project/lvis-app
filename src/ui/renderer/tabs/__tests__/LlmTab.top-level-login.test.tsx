/**
 * LlmTab manual-only Model-tab UI tests.
 *
 * ①안 — the settings login/demo auth affordances were removed. The Model tab
 * is manual-only now: the vendor dropdown + per-vendor fields (API key,
 * baseUrl, model, vertex…) and the host-resolver map are ALWAYS enabled and
 * editable, regardless of the persisted `authMode`. A former demo/login user
 * (authMode="login") still sees the editable manual form; `authMode` only
 * drives the Account section badge now.
 */
import "../../../../../test/renderer/setup.js";
import { describe, it, expect, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { LlmTab, type FallbackEntry } from "../LlmTab.js";
import { ALL_VENDORS, VENDORS } from "../../constants.js";
import { TooltipProvider } from "../../../../components/ui/tooltip.js";
import { makeMockLvisApi } from "../../../../../test/renderer/mock-lvis-api.js";
import { llmModelListCacheKey } from "../../../../shared/llm-model-list.js";
import { marketplaceProviderPresetSecretId, type MarketplaceInstalledProviderPreset } from "../../../../shared/marketplace-package-assets.js";

type HarnessApi = Parameters<typeof LlmTab>[0]["api"];

function llmTabApi(): HarnessApi {
  const { api } = makeMockLvisApi();
  return api as unknown as HarnessApi;
}

function Harness({
  initialAuthMode,
  initialHostResolverMap = "",
  loadedHostResolverMap = "",
  initialVendor = "openai",
  initialBaseUrl = "",
  initialModel = "gpt-5.4-mini",
  settingsLoaded = true,
  api,
  onOpenMarketplace,
  marketplaceProviderPresets = [],
  initialMarketplaceProviderPresetId = "",
  initialHasKey = false,
  onLogout,
}: {
  initialAuthMode: "manual" | "login";
  initialHostResolverMap?: string;
  loadedHostResolverMap?: string;
  initialVendor?: string;
  initialBaseUrl?: string;
  initialModel?: string;
  settingsLoaded?: boolean;
  api?: HarnessApi;
  onOpenMarketplace?: () => void;
  marketplaceProviderPresets?: readonly MarketplaceInstalledProviderPreset[];
  initialMarketplaceProviderPresetId?: string;
  initialHasKey?: boolean;
  onLogout?: () => void;
  onReactivateDemo?: () => void;
}) {
  const [authMode] = useState<"manual" | "login">(initialAuthMode);
  const [vendor, setVendor] = useState(initialVendor);
  const [keyInput, setKeyInput] = useState("");
  const [model, setModel] = useState(initialModel);
  const [baseUrl, setBaseUrl] = useState(initialBaseUrl);
  const [vertexProject, setVertexProject] = useState("");
  const [vertexLocation, setVertexLocation] = useState("");
  const [hasKey, setHasKey] = useState(initialHasKey);
  const [enableThinking, setEnableThinking] = useState(true);
  const [thinkingBudget, setThinkingBudget] = useState(10_000);
  const [fallbackChain, setFallbackChain] = useState<FallbackEntry[]>([]);
  const [fallbackOpen, setFallbackOpen] = useState(false);
  const [hostResolverMap, setHostResolverMap] = useState(initialHostResolverMap);
  const [marketplaceProviderPresetId, setMarketplaceProviderPresetId] =
    useState(initialMarketplaceProviderPresetId);
  return (
    <TooltipProvider>
      <LlmTab
        api={api ?? llmTabApi()}
        vendor={vendor}
        setVendor={setVendor}
        baseUrl={baseUrl}
        setBaseUrl={setBaseUrl}
        vertexProject={vertexProject}
        setVertexProject={setVertexProject}
        vertexLocation={vertexLocation}
        setVertexLocation={setVertexLocation}
        hasKey={hasKey}
        setHasKey={setHasKey}
        keyInput={keyInput}
        setKeyInput={setKeyInput}
        authMode={authMode}
        marketplaceProviderPresetId={marketplaceProviderPresetId}
        marketplaceProviderPresets={marketplaceProviderPresets}
        onSelectMarketplaceProviderPreset={(preset) => {
          setMarketplaceProviderPresetId(preset.providerId);
          setVendor("openai-compatible");
          setBaseUrl(preset.baseUrl);
          setModel(preset.defaultModel);
        }}
        onClearMarketplaceProviderPreset={() => setMarketplaceProviderPresetId("")}
        onOpenMarketplace={onOpenMarketplace}
        model={model}
        setModel={setModel}
        enableThinking={enableThinking}
        setEnableThinking={setEnableThinking}
        thinkingBudget={thinkingBudget}
        setThinkingBudget={setThinkingBudget}
        fallbackChain={fallbackChain}
        setFallbackChain={setFallbackChain}
        fallbackOpen={fallbackOpen}
        setFallbackOpen={setFallbackOpen}
        hostResolverMap={hostResolverMap}
        setHostResolverMap={setHostResolverMap}
        loadedHostResolverMap={loadedHostResolverMap}
        onSaved={vi.fn()}
        settingsLoaded={settingsLoaded}
        onLogout={onLogout}
      />
    </TooltipProvider>
  );
}

describe("LlmTab — manual-only Model tab", () => {
  // ①안 — the login/demo affordances were removed. Even for a former demo/login
  // user (authMode="login") the manual API-key section renders ENABLED and there
  // is no login section: the settings surface is manual-only.
  it("renders the manual section enabled with no login section, even when authMode='login'", () => {
    const { container } = render(<Harness initialAuthMode="login" initialVendor="openai" />);
    // No login section / login button in the settings surface anymore.
    expect(container.querySelector('[data-testid="llm-tab:login-section"]')).toBeNull();
    expect(container.querySelector('[data-testid="llm-tab:open-login"]')).toBeNull();
    // Manual section IS in the DOM and NOT aria-disabled.
    const manualSection = container.querySelector('[data-testid="llm-tab:manual-section"]');
    expect(manualSection).not.toBeNull();
    expect(manualSection?.getAttribute("aria-disabled")).not.toBe("true");
    // Vendor select + model selector rendered.
    expect(container.querySelector('#vendor-select')).not.toBeNull();
    expect(container.querySelector('[data-testid="llm-model-select"]')).not.toBeNull();
    // API key input is editable (not disabled).
    const keyInput = container.querySelector('[data-testid="llm-api-key-input"]') as HTMLInputElement | null;
    expect(keyInput).not.toBeNull();
    expect(keyInput?.disabled).toBe(false);
  });

  it("renders vendor dropdown and per-vendor fields enabled when authMode='manual'", () => {
    const { container } = render(<Harness initialAuthMode="manual" />);
    const manualSection = container.querySelector('[data-testid="llm-tab:manual-section"]');
    expect(manualSection).not.toBeNull();
    // Not aria-disabled="true" in manual mode.
    expect(manualSection?.getAttribute("aria-disabled")).not.toBe("true");
    expect(container.querySelector('#vendor-select')).not.toBeNull();
    expect(container.querySelector('[data-testid="llm-model-select"]')).not.toBeNull();
    // Login section NOT shown in manual mode.
    expect(container.querySelector('[data-testid="llm-tab:login-section"]')).toBeNull();
  });

  it("renders a searchable default provider dropdown", async () => {
    const { container } = render(<Harness initialAuthMode="manual" />);
    const vendorTrigger = container.querySelector("#vendor-select") as HTMLElement | null;
    expect(vendorTrigger).not.toBeNull();

    fireEvent.mouseDown(vendorTrigger!);
    fireEvent.keyDown(vendorTrigger!, { key: "ArrowDown" });

    const search = await screen.findByTestId("llm-tab:vendor-search");
    expect(search).toHaveAttribute("placeholder", "공급자 검색...");
    expect(screen.getByTestId("llm-tab:vendor-content")).not.toHaveClass("max-h-[386px]");

    fireEvent.change(search, { target: { value: "openrouter" } });
    expect(screen.getByText("OpenRouter")).toBeInTheDocument();
    expect(screen.queryByText("Google Gemini")).toBeNull();

    fireEvent.change(search, { target: { value: "groq" } });
    expect(screen.queryByText("Groq")).toBeNull();
  });

  it("preserves a legacy marketplace-candidate provider when it is already selected", async () => {
    const { container } = render(<Harness initialAuthMode="manual" initialVendor="groq" />);
    const vendorTrigger = container.querySelector("#vendor-select") as HTMLElement | null;
    expect(vendorTrigger).not.toBeNull();

    fireEvent.mouseDown(vendorTrigger!);
    fireEvent.keyDown(vendorTrigger!, { key: "ArrowDown" });

    const search = await screen.findByTestId("llm-tab:vendor-search");
    fireEvent.change(search, { target: { value: "groq" } });

    expect(screen.getAllByText("Groq").length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText("DeepSeek")).toBeNull();
  });

  it("shows marketplace-installed providers even when they are not selected", async () => {
    const api = llmTabApi();
    (api.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      marketplace: {
        installedProviderIds: ["groq"],
      },
    });
    const { container } = render(<Harness initialAuthMode="manual" initialVendor="openai" api={api} />);
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());

    const vendorTrigger = container.querySelector("#vendor-select") as HTMLElement | null;
    expect(vendorTrigger).not.toBeNull();

    fireEvent.mouseDown(vendorTrigger!);
    fireEvent.keyDown(vendorTrigger!, { key: "ArrowDown" });

    const search = await screen.findByTestId("llm-tab:vendor-search");
    fireEvent.change(search, { target: { value: "groq" } });

    expect(screen.getByText("Groq")).toBeInTheDocument();
    expect(screen.getByTestId("llm-tab:vendor-marketplace-badge:groq")).toHaveTextContent(
      "마켓플레이스",
    );
  });

  it("reflects provider packages installed after a Marketplace settings broadcast", async () => {
    const api = llmTabApi();
    const { container } = render(
      <Harness initialAuthMode="manual" initialVendor="openai" api={api} />,
    );
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());

    await act(async () => {
      await api.updateSettings({ marketplace: { installedProviderIds: ["groq"] } });
    });

    const vendorTrigger = container.querySelector("#vendor-select") as HTMLElement | null;
    expect(vendorTrigger).not.toBeNull();
    fireEvent.mouseDown(vendorTrigger!);
    fireEvent.keyDown(vendorTrigger!, { key: "ArrowDown" });

    const search = await screen.findByTestId("llm-tab:vendor-search");
    fireEvent.change(search, { target: { value: "groq" } });

    expect(screen.getByText("Groq")).toBeInTheDocument();
    expect(screen.getByTestId("llm-tab:vendor-marketplace-badge:groq")).toHaveTextContent(
      "마켓플레이스",
    );
  });

  it("marks the selected provider when it came from Marketplace", async () => {
    const api = llmTabApi();
    (api.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      marketplace: {
        installedProviderIds: ["groq"],
      },
    });
    render(<Harness initialAuthMode="manual" initialVendor="groq" api={api} />);

    expect(await screen.findByTestId("llm-tab:selected-provider-marketplace:groq"))
      .toHaveTextContent("마켓플레이스");
  });

  it("shows and applies marketplace custom provider presets", async () => {
    const futureRouter: MarketplaceInstalledProviderPreset = {
      providerId: "future-router",
      label: "Future Router",
      baseUrl: "https://future.example/v1",
      apiKeyPlaceholder: "fr_...",
      defaultModel: "future/free",
      modelOptions: ["future/free", "future/pro"],
      requiresApiKey: false,
    };
    const { container } = render(
      <Harness
        initialAuthMode="manual"
        initialVendor="openai"
        marketplaceProviderPresets={[futureRouter]}
      />,
    );

    const vendorTrigger = container.querySelector("#vendor-select") as HTMLElement | null;
    expect(vendorTrigger).not.toBeNull();
    fireEvent.mouseDown(vendorTrigger!);
    fireEvent.keyDown(vendorTrigger!, { key: "ArrowDown" });

    const search = await screen.findByTestId("llm-tab:vendor-search");
    fireEvent.change(search, { target: { value: "future" } });
    fireEvent.click(await screen.findByText("Future Router"));

    expect(await screen.findByTestId(
      `llm-tab:selected-provider-marketplace:${marketplaceProviderPresetSecretId("future-router")}`,
    )).toHaveTextContent("마켓플레이스");
    expect((screen.getByTestId("llm-base-url-input") as HTMLInputElement).value)
      .toBe("https://future.example/v1");
    expect(screen.getByTestId("llm-tab:api-key-section"))
      .toHaveAttribute("data-api-key-required", "false");
    expect(container.querySelector('[data-testid="llm-model-select"]')?.textContent)
      .toContain("future/free");
  });

  it("scopes synced model-list cache by marketplace provider preset id", async () => {
    const api = llmTabApi();
    const listLlmModels = api.listLlmModels as ReturnType<typeof vi.fn>;
    const routerAResult = {
      ok: true,
      vendor: "openai-compatible",
      endpoint: "https://shared.example/v1/models",
      models: ["router-a/free"],
      fetchedAt: "2026-07-07T00:00:00.000Z",
    };
    const routerBResult = {
      ok: true,
      vendor: "openai-compatible",
      endpoint: "https://shared.example/v1/models",
      models: ["router-b/free"],
      fetchedAt: "2026-07-07T00:00:01.000Z",
    };
    const routerA: MarketplaceInstalledProviderPreset = {
      providerId: "router-a",
      label: "Router A",
      baseUrl: "https://shared.example/v1",
      defaultModel: "router-a/free",
      modelOptions: ["router-a/free"],
      requiresApiKey: true,
    };
    const routerB: MarketplaceInstalledProviderPreset = {
      providerId: "router-b",
      label: "Router B",
      baseUrl: "https://shared.example/v1",
      defaultModel: "router-b/free",
      modelOptions: ["router-b/free"],
      requiresApiKey: true,
    };
    const { container } = render(
      <Harness
        initialAuthMode="manual"
        initialVendor="openai"
        api={api}
        marketplaceProviderPresets={[routerA, routerB]}
      />,
    );
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());
    await waitFor(() => expect(listLlmModels).toHaveBeenCalledWith({ vendor: "openai" }));
    listLlmModels
      .mockClear()
      .mockResolvedValueOnce(routerAResult)
      .mockResolvedValueOnce(routerBResult);

    const vendorTrigger = container.querySelector("#vendor-select") as HTMLElement;
    fireEvent.mouseDown(vendorTrigger);
    fireEvent.keyDown(vendorTrigger, { key: "ArrowDown" });
    fireEvent.change(await screen.findByTestId("llm-tab:vendor-search"), {
      target: { value: "Router A" },
    });
    fireEvent.click(await screen.findByText("Router A"));
    expect(screen.getByTestId("llm-tab:api-key-section"))
      .toHaveAttribute("data-api-key-required", "true");
    await waitFor(() => expect(listLlmModels).toHaveBeenCalledTimes(1));
    expect(listLlmModels).toHaveBeenLastCalledWith({
      vendor: "openai-compatible",
      baseUrl: "https://shared.example/v1",
      credentialScope: "router-a",
    });

    fireEvent.mouseDown(vendorTrigger);
    fireEvent.keyDown(vendorTrigger, { key: "ArrowDown" });
    fireEvent.change(await screen.findByTestId("llm-tab:vendor-search"), {
      target: { value: "Router B" },
    });
    fireEvent.click(await screen.findByText("Router B"));
    await waitFor(() => expect(listLlmModels).toHaveBeenCalledTimes(2));
    expect(listLlmModels).toHaveBeenLastCalledWith({
      vendor: "openai-compatible",
      baseUrl: "https://shared.example/v1",
      credentialScope: "router-b",
    });

    await waitFor(() => {
      expect(api.updateSettings).toHaveBeenCalledWith({
        llm: {
          modelListCache: {
            [llmModelListCacheKey("openai-compatible", "https://shared.example/v1", "router-a")]: {
              vendor: "openai-compatible",
              baseUrl: "https://shared.example/v1",
              credentialScope: "router-a",
              endpoint: "https://shared.example/v1/models",
              models: ["router-a/free"],
              fetchedAt: "2026-07-07T00:00:00.000Z",
            },
          },
        },
      });
      expect(api.updateSettings).toHaveBeenCalledWith({
        llm: {
          modelListCache: expect.objectContaining({
            [llmModelListCacheKey("openai-compatible", "https://shared.example/v1", "router-b")]: {
              vendor: "openai-compatible",
              baseUrl: "https://shared.example/v1",
              credentialScope: "router-b",
              endpoint: "https://shared.example/v1/models",
              models: ["router-b/free"],
              fetchedAt: "2026-07-07T00:00:01.000Z",
            },
          }),
        },
      });
    });
  });

  it("does not auto-sync model lists for manual marketplace provider presets", async () => {
    const api = llmTabApi();
    const manualRouter: MarketplaceInstalledProviderPreset = {
      providerId: "manual-router",
      label: "Manual Router",
      baseUrl: "https://manual.example/v1",
      defaultModel: "manual/default",
      modelOptions: ["manual/default", "manual/large"],
      requiresApiKey: true,
      modelDiscoveryPolicy: "manual",
    };
    (api.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      llm: {
        modelListCache: {
          [llmModelListCacheKey("openai-compatible", "https://manual.example/v1", "manual-router")]: {
            vendor: "openai-compatible",
            baseUrl: "https://manual.example/v1",
            credentialScope: "manual-router",
            endpoint: "https://manual.example/v1/models",
            models: ["cached/network-only"],
            fetchedAt: "2026-07-06T00:00:00.000Z",
          },
        },
      },
      marketplace: {},
    });

    render(
      <Harness
        initialAuthMode="manual"
        initialVendor="openai-compatible"
        initialBaseUrl="https://manual.example/v1"
        initialMarketplaceProviderPresetId="manual-router"
        api={api}
        marketplaceProviderPresets={[manualRouter]}
      />,
    );
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 800));
    });

    expect(api.listLlmModels).not.toHaveBeenCalled();
    expect(screen.queryByTestId("llm-tab:model-sync")).toBeNull();

    const modelTrigger = screen.getByTestId("llm-model-select");
    fireEvent.mouseDown(modelTrigger);
    fireEvent.keyDown(modelTrigger, { key: "ArrowDown" });

    expect(await screen.findByText("manual/default")).toBeInTheDocument();
    expect(screen.getByText("manual/large")).toBeInTheDocument();
    expect(screen.queryByText("cached/network-only")).toBeNull();
  });

  it("opens the Marketplace from provider and model discovery buttons", () => {
    const onOpenMarketplace = vi.fn();
    const { getByTestId } = render(
      <Harness
        initialAuthMode="manual"
        initialVendor="openrouter"
        onOpenMarketplace={onOpenMarketplace}
      />,
    );

    fireEvent.click(getByTestId("llm-tab:marketplace-providers"));
    fireEvent.click(getByTestId("llm-tab:marketplace-models"));
    expect(onOpenMarketplace).toHaveBeenCalledTimes(2);
  });
  it("uses synced provider model ids in the model dropdown", async () => {
    const api = llmTabApi();
    (api.listLlmModels as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      vendor: "openrouter",
      endpoint: "https://openrouter.ai/api/v1/models",
      models: ["openrouter/free", "google/gemini-2.5-flash:free"],
      modelEntries: [
        {
          id: "openrouter/free",
          name: "Free Router",
          tags: { free: true, router: true },
        },
        {
          id: "google/gemini-2.5-flash:free",
          name: "Gemini 2.5 Flash Free",
          pricing: { prompt: "0", completion: "0" },
          tags: { free: true },
        },
      ],
      fetchedAt: "2026-07-06T00:00:00.000Z",
    });
    const { container } = render(
      <Harness initialAuthMode="manual" initialVendor="openrouter" api={api} />,
    );

    await waitFor(() =>
      expect(api.listLlmModels).toHaveBeenCalledWith({ vendor: "openrouter" }),
    );
    expect(screen.getByTestId("llm-tab:model-sync-status").textContent).toContain("2");

    const modelTrigger = container.querySelector(
      '[data-testid="llm-model-select"]',
    ) as HTMLElement | null;
    expect(modelTrigger).not.toBeNull();
    fireEvent.mouseDown(modelTrigger!);
    fireEvent.keyDown(modelTrigger!, { key: "ArrowDown" });

    expect(await screen.findByText("openrouter/free")).toBeInTheDocument();
    expect(screen.getByText("google/gemini-2.5-flash:free")).toBeInTheDocument();
    expect(screen.getAllByText("무료")).toHaveLength(2);
    expect(screen.getByText("라우터")).toBeInTheDocument();
    expect(screen.getAllByText(/속도 제한.*사용 가능 여부/))
      .toHaveLength(2);
    await waitFor(() =>
      expect(api.updateSettings).toHaveBeenCalledWith({
        llm: {
          modelListCache: {
            [llmModelListCacheKey("openrouter")]: {
              vendor: "openrouter",
              endpoint: "https://openrouter.ai/api/v1/models",
              models: ["openrouter/free", "google/gemini-2.5-flash:free"],
              modelEntries: [
                {
                  id: "openrouter/free",
                  name: "Free Router",
                  tags: { free: true, router: true },
                },
                {
                  id: "google/gemini-2.5-flash:free",
                  name: "Gemini 2.5 Flash Free",
                  pricing: { prompt: "0", completion: "0" },
                  tags: { free: true },
                },
              ],
              fetchedAt: "2026-07-06T00:00:00.000Z",
            },
          },
        },
      }),
    );
  });

  it("hydrates cached provider model ids before another network sync", async () => {
    const api = llmTabApi();
    (api.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      llm: {
        modelListCache: {
          [llmModelListCacheKey("openrouter")]: {
            vendor: "openrouter",
            endpoint: "https://openrouter.ai/api/v1/models",
            models: ["cached/free-router", "cached/paid-router"],
            fetchedAt: "2026-07-06T00:00:00.000Z",
          },
        },
      },
      marketplace: {},
    });
    const { container } = render(
      <Harness
        initialAuthMode="manual"
        initialVendor="openrouter"
        api={api}
        settingsLoaded={false}
      />,
    );
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());

    const modelTrigger = container.querySelector(
      '[data-testid="llm-model-select"]',
    ) as HTMLElement | null;
    expect(modelTrigger).not.toBeNull();
    fireEvent.mouseDown(modelTrigger!);
    fireEvent.keyDown(modelTrigger!, { key: "ArrowDown" });

    expect(await screen.findByText("cached/free-router")).toBeInTheDocument();
    expect(screen.getByText("cached/paid-router")).toBeInTheDocument();
    expect(api.listLlmModels).not.toHaveBeenCalled();
  });

  it("uses cached provider model ids when an earlier background refresh failed", async () => {
    const api = llmTabApi();
    let resolveSettings!: (settings: unknown) => void;
    (api.getSettings as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise((resolve) => {
        resolveSettings = resolve;
      }),
    );
    (api.listLlmModels as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      error: "model-list-fetch-failed",
      message: "offline",
    });

    const { container } = render(
      <Harness initialAuthMode="manual" initialVendor="openrouter" api={api} />,
    );
    await waitFor(() => expect(api.listLlmModels).toHaveBeenCalledTimes(1));

    await act(async () => {
      resolveSettings({
        llm: {
          modelListCache: {
            [llmModelListCacheKey("openrouter")]: {
              vendor: "openrouter",
              endpoint: "https://openrouter.ai/api/v1/models",
              models: ["cached/offline-router"],
              fetchedAt: "2026-07-06T00:00:00.000Z",
            },
          },
        },
        marketplace: {},
      });
    });

    const modelTrigger = container.querySelector(
      '[data-testid="llm-model-select"]',
    ) as HTMLElement | null;
    expect(modelTrigger).not.toBeNull();
    fireEvent.mouseDown(modelTrigger!);
    fireEvent.keyDown(modelTrigger!, { key: "ArrowDown" });

    expect(await screen.findByText("cached/offline-router")).toBeInTheDocument();
  });

  it("keeps hydrated cache when an in-flight background refresh fails later", async () => {
    const api = llmTabApi();
    let resolveSettings!: (settings: unknown) => void;
    let resolveModelList!: (result: unknown) => void;
    (api.getSettings as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise((resolve) => {
        resolveSettings = resolve;
      }),
    );
    (api.listLlmModels as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise((resolve) => {
        resolveModelList = resolve;
      }),
    );
    function ReloadToggleHarness() {
      const [settingsLoaded, setSettingsLoaded] = useState(true);
      return (
        <>
          <button
            type="button"
            data-testid="in-flight-cache-race:unload"
            onClick={() => setSettingsLoaded(false)}
          >
            unload
          </button>
          <button
            type="button"
            data-testid="in-flight-cache-race:load"
            onClick={() => setSettingsLoaded(true)}
          >
            load
          </button>
          <Harness
            initialAuthMode="manual"
            initialVendor="openrouter"
            api={api}
            settingsLoaded={settingsLoaded}
          />
        </>
      );
    }

    const { container } = render(<ReloadToggleHarness />);
    await waitFor(() => expect(api.listLlmModels).toHaveBeenCalledTimes(1));

    await act(async () => {
      resolveSettings({
        llm: {
          modelListCache: {
            [llmModelListCacheKey("openrouter")]: {
              vendor: "openrouter",
              endpoint: "https://openrouter.ai/api/v1/models",
              models: ["cached/in-flight-router"],
              fetchedAt: "2026-07-06T00:00:00.000Z",
            },
          },
        },
        marketplace: {},
      });
    });
    await act(async () => {
      resolveModelList({
        ok: false,
        error: "model-list-fetch-failed",
        message: "offline",
      });
    });

    const modelTrigger = container.querySelector(
      '[data-testid="llm-model-select"]',
    ) as HTMLElement | null;
    expect(modelTrigger).not.toBeNull();
    fireEvent.mouseDown(modelTrigger!);
    fireEvent.keyDown(modelTrigger!, { key: "ArrowDown" });
    expect(await screen.findByText("cached/in-flight-router")).toBeInTheDocument();

    (api.listLlmModels as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      vendor: "openrouter",
      endpoint: "https://openrouter.ai/api/v1/models",
      models: ["live/after-race-router"],
      fetchedAt: "2026-07-07T00:00:00.000Z",
    });
    fireEvent.click(screen.getByTestId("in-flight-cache-race:unload"));
    fireEvent.click(screen.getByTestId("in-flight-cache-race:load"));

    await waitFor(() => expect(api.listLlmModels).toHaveBeenCalledTimes(2));
  });

  it("refreshes cached provider model ids in the background", async () => {
    const api = llmTabApi();
    (api.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      llm: {
        modelListCache: {
          [llmModelListCacheKey("openrouter")]: {
            vendor: "openrouter",
            endpoint: "https://openrouter.ai/api/v1/models",
            models: ["cached/free-router"],
            fetchedAt: "2026-07-06T00:00:00.000Z",
          },
        },
      },
      marketplace: {},
    });
    (api.listLlmModels as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      vendor: "openrouter",
      endpoint: "https://openrouter.ai/api/v1/models",
      models: ["live/free-router", "live/new-router"],
      fetchedAt: "2026-07-07T00:00:00.000Z",
    });

    render(<Harness initialAuthMode="manual" initialVendor="openrouter" api={api} />);

    await waitFor(() =>
      expect(api.listLlmModels).toHaveBeenCalledWith({ vendor: "openrouter" }),
    );
    await waitFor(() =>
      expect(api.updateSettings).toHaveBeenCalledWith({
        llm: {
          modelListCache: {
            [llmModelListCacheKey("openrouter")]: {
              vendor: "openrouter",
              endpoint: "https://openrouter.ai/api/v1/models",
              models: ["live/free-router", "live/new-router"],
              fetchedAt: "2026-07-07T00:00:00.000Z",
            },
          },
        },
      }),
    );
  });

  it("does not let pruned persisted caches block a later auto-refresh", async () => {
    const api = llmTabApi();
    (api.listLlmModels as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      vendor: "openrouter",
      endpoint: "https://openrouter.ai/api/v1/models",
      models: ["live/free-router"],
      fetchedAt: "2026-07-07T00:00:00.000Z",
    });
    function ReloadToggleHarness() {
      const [settingsLoaded, setSettingsLoaded] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setSettingsLoaded(false)}>unload</button>
          <button type="button" onClick={() => setSettingsLoaded(true)}>load</button>
          <Harness
            initialAuthMode="manual"
            initialVendor="openrouter"
            api={api}
            settingsLoaded={settingsLoaded}
          />
        </>
      );
    }

    render(<ReloadToggleHarness />);
    await waitFor(() => expect(api.listLlmModels).toHaveBeenCalledTimes(1));

    await act(async () => {
      await api.updateSettings({ llm: { modelListCache: {} } });
    });
    fireEvent.click(screen.getByRole("button", { name: "unload" }));
    fireEvent.click(screen.getByRole("button", { name: "load" }));

    await waitFor(() => expect(api.listLlmModels).toHaveBeenCalledTimes(2));
  });

  it("does not automatically retry a failed model sync", async () => {
    const api = llmTabApi();
    (api.listLlmModels as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      error: "model-list-fetch-failed",
      message: "missing provider key",
    });
    render(<Harness initialAuthMode="manual" initialVendor="openrouter" api={api} />);

    await waitFor(() => expect(api.listLlmModels).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("llm-tab:model-sync-status").textContent).toBeTruthy();

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 800));
    });
    expect(api.listLlmModels).toHaveBeenCalledTimes(1);
  });

  it("does not auto-sync a required-baseUrl provider before a URL exists", async () => {
    const api = llmTabApi();
    render(
      <Harness initialAuthMode="manual" initialVendor="openai-compatible" api={api} />,
    );

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 800));
    });
    expect(api.listLlmModels).not.toHaveBeenCalled();
    expect(screen.queryByTestId("llm-tab:model-sync")).toBeNull();
  });

  it("syncs model ids from the configured provider base URL", async () => {
    const api = llmTabApi();
    (api.listLlmModels as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      vendor: "openai-compatible",
      endpoint: "https://router.example.com/v1/models",
      models: ["router/free-model"],
      fetchedAt: "2026-07-06T00:00:00.000Z",
    });

    const { container } = render(
      <Harness
        initialAuthMode="manual"
        initialVendor="openai-compatible"
        initialBaseUrl="https://router.example.com/v1"
        api={api}
      />,
    );

    await waitFor(() =>
      expect(api.listLlmModels).toHaveBeenCalledWith({
        vendor: "openai-compatible",
        baseUrl: "https://router.example.com/v1",
      }),
    );
    expect(screen.getByTestId("llm-tab:model-sync-status").textContent).toContain("1");

    const modelTrigger = container.querySelector(
      '[data-testid="llm-model-select"]',
    ) as HTMLElement | null;
    expect(modelTrigger).not.toBeNull();
    fireEvent.mouseDown(modelTrigger!);
    fireEvent.keyDown(modelTrigger!, { key: "ArrowDown" });

    expect(await screen.findByText("router/free-model")).toBeInTheDocument();
  });

  // Handshake-only: the openai-compatible model dropdown must be EMPTY before
  // an endpoint is entered — no hardcoded seed. Previously it rendered the
  // LVIS-cluster seed (Qwen3.6-.../Nemotron-...) before any address was typed.
  it("openai-compatible shows no hardcoded seed models before an endpoint is entered", async () => {
    const api = llmTabApi();
    const { container } = render(
      <Harness
        initialAuthMode="manual"
        initialVendor="openai-compatible"
        initialModel=""
        initialBaseUrl=""
        api={api}
      />,
    );
    // No live handshake fires without a base URL, and nothing is shown.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
    });
    expect(api.listLlmModels).not.toHaveBeenCalled();

    const modelTrigger = container.querySelector(
      '[data-testid="llm-model-select"]',
    ) as HTMLElement | null;
    expect(modelTrigger).not.toBeNull();
    fireEvent.mouseDown(modelTrigger!);
    fireEvent.keyDown(modelTrigger!, { key: "ArrowDown" });

    // The former hardcoded LVIS-cluster seed is gone.
    expect(screen.queryByText("Qwen3.6-35B-A3B-NVFP4")).toBeNull();
    expect(screen.queryByText("Nemotron-3-Nano-30B-A3B-FP8")).toBeNull();
  });

  it("openai-compatible populates the model dropdown from the live handshake, not a seed", async () => {
    const api = llmTabApi();
    (api.listLlmModels as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      vendor: "openai-compatible",
      endpoint: "https://vllm.example/v1/models",
      models: ["team/qwen-real", "team/nemotron-real"],
      fetchedAt: "2026-07-08T00:00:00.000Z",
    });

    const { container } = render(
      <Harness
        initialAuthMode="manual"
        initialVendor="openai-compatible"
        initialModel=""
        initialBaseUrl="https://vllm.example/v1"
        api={api}
      />,
    );

    await waitFor(() =>
      expect(api.listLlmModels).toHaveBeenCalledWith({
        vendor: "openai-compatible",
        baseUrl: "https://vllm.example/v1",
      }),
    );

    const modelTrigger = container.querySelector(
      '[data-testid="llm-model-select"]',
    ) as HTMLElement | null;
    expect(modelTrigger).not.toBeNull();
    fireEvent.mouseDown(modelTrigger!);
    fireEvent.keyDown(modelTrigger!, { key: "ArrowDown" });

    expect(await screen.findByText("team/qwen-real")).toBeInTheDocument();
    expect(screen.getByText("team/nemotron-real")).toBeInTheDocument();
    // Live list only — never the hardcoded seed.
    expect(screen.queryByText("Qwen3.6-35B-A3B-NVFP4")).toBeNull();
  });

  it("host-resolver map textarea is enabled even for a former login/demo user", () => {
    const { container } = render(<Harness initialAuthMode="login" />);
    const textarea = container.querySelector('[data-testid="llm-host-resolver-map-input"]') as HTMLTextAreaElement | null;
    expect(textarea).not.toBeNull();
    expect(textarea?.disabled).toBe(false);
  });

  it("host-resolver map textarea is enabled in manual mode", () => {
    const { container } = render(<Harness initialAuthMode="manual" />);
    const textarea = container.querySelector('[data-testid="llm-host-resolver-map-input"]') as HTMLTextAreaElement | null;
    expect(textarea).not.toBeNull();
    expect(textarea?.disabled).toBe(false);
  });

  it("apply-host-map button is shown regardless of authMode", () => {
    const { container: loginContainer } = render(<Harness initialAuthMode="login" />);
    expect(loginContainer.querySelector('[data-testid="llm-tab:apply-host-map"]')).not.toBeNull();

    const { container: manualContainer } = render(<Harness initialAuthMode="manual" />);
    expect(manualContainer.querySelector('[data-testid="llm-tab:apply-host-map"]')).not.toBeNull();
  });

  it("disables Apply when the host map is unchanged from the loaded value", () => {
    const { container } = render(
      <Harness
        initialAuthMode="manual"
        initialHostResolverMap={"10.0.0.10 endpoint.example.com"}
        loadedHostResolverMap={"10.0.0.10 endpoint.example.com"}
      />,
    );
    const applyBtn = container.querySelector(
      '[data-testid="llm-tab:apply-host-map"]',
    ) as HTMLButtonElement | null;
    expect(applyBtn).not.toBeNull();
    expect(applyBtn?.disabled).toBe(true);
  });

  it("enables Apply once the host map differs from the loaded value", () => {
    const { container } = render(
      <Harness
        initialAuthMode="manual"
        initialHostResolverMap={"10.0.0.10 changed.example.com"}
        loadedHostResolverMap={"10.0.0.10 endpoint.example.com"}
      />,
    );
    const applyBtn = container.querySelector(
      '[data-testid="llm-tab:apply-host-map"]',
    ) as HTMLButtonElement | null;
    expect(applyBtn?.disabled).toBe(false);
  });

  it("opens the relaunch dialog and applies the textarea value on confirm", async () => {
    const api = llmTabApi();
    const applyHostMap = vi.spyOn(
      api as unknown as { applyHostMap: (v: string) => Promise<{ ok: boolean }> },
      "applyHostMap",
    );
    const { container, getByTestId } = render(
      <Harness
        initialAuthMode="manual"
        initialHostResolverMap={"10.0.0.10 changed.example.com"}
        loadedHostResolverMap={"10.0.0.10 endpoint.example.com"}
        api={api}
      />,
    );

    // No dialog confirm button until Apply is clicked.
    expect(container.querySelector('[data-testid="llm-tab:relaunch-confirm"]')).toBeNull();

    fireEvent.click(getByTestId("llm-tab:apply-host-map"));

    // Dialog now open with confirm button.
    const confirm = getByTestId("llm-tab:relaunch-confirm");
    expect(confirm).not.toBeNull();
    expect(applyHostMap).not.toHaveBeenCalled();

    // Confirm → api.applyHostMap called with the current textarea value.
    await act(async () => {
      fireEvent.click(confirm);
    });
    expect(applyHostMap).toHaveBeenCalledWith("10.0.0.10 changed.example.com");
  });

  it("renders the parsed entry count for a valid host map in manual mode", () => {
    const { container } = render(
      <Harness
        initialAuthMode="manual"
        initialHostResolverMap={"10.0.0.10 a.example.com\n10.0.0.11 b.example.com"}
        loadedHostResolverMap={""}
      />,
    );
    const section = container.querySelector('[data-testid="llm-tab:host-resolver-section"]');
    // i18n plural form interpolates the count (en: "2 entries parsed").
    expect(section?.textContent).toContain("2");
  });

  // ①안 — the auth-mode radio group and the login-section (with its logout
  // hint) were removed from the settings surface entirely. There is no toggle
  // into login mode here anymore; logout lives in the Account section header
  // (covered by "LlmTab — account + auth management" below).
  it("no longer renders the auth-mode radio or login section in any mode", () => {
    const { container: manualContainer } = render(<Harness initialAuthMode="manual" />);
    expect(manualContainer.querySelector('[data-testid="llm-tab:auth-mode"]')).toBeNull();
    expect(manualContainer.querySelector('#auth-mode-login')).toBeNull();

    const { container: loginContainer } = render(<Harness initialAuthMode="login" />);
    expect(loginContainer.querySelector('[data-testid="llm-tab:auth-mode"]')).toBeNull();
    expect(loginContainer.querySelector('[data-testid="llm-tab:login-section"]')).toBeNull();
    expect(loginContainer.querySelector('[data-testid="llm-tab:logout-hint"]')).toBeNull();
  });

  // (2) When api.applyHostMap rejects, the relaunch confirm dialog must stay
  // open with an inline error and must not leave an unhandled promise
  // rejection. relaunchPending is also released so the user can retry.
  it("keeps the relaunch dialog open and surfaces an error when applyHostMap fails", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: PromiseRejectionEvent) => {
      e.preventDefault();
      unhandled.push(e.reason);
    };
    window.addEventListener("unhandledrejection", onUnhandled);
    try {
      const api = llmTabApi();
      vi.spyOn(
        api as unknown as { applyHostMap: (v: string) => Promise<{ ok: boolean }> },
        "applyHostMap",
      ).mockRejectedValue(new Error("ipc failed"));

      // Dialog renders in a portal (document.body), so query via the
      // testing-library helpers that scope to the document, not `container`.
      const { getByTestId, queryByTestId } = render(
        <Harness
          initialAuthMode="manual"
          initialHostResolverMap={"10.0.0.10 changed.example.com"}
          loadedHostResolverMap={"10.0.0.10 endpoint.example.com"}
          api={api}
        />,
      );

      fireEvent.click(getByTestId("llm-tab:apply-host-map"));
      await act(async () => {
        fireEvent.click(getByTestId("llm-tab:relaunch-confirm"));
      });
      // Let any pending microtasks/rejections settle.
      await act(async () => {
        await Promise.resolve();
      });

      // Dialog still open: confirm button + inline error present.
      expect(queryByTestId("llm-tab:relaunch-confirm")).not.toBeNull();
      const error = queryByTestId("llm-tab:relaunch-error");
      expect(error).not.toBeNull();
      expect(error?.getAttribute("role")).toBe("alert");
      // Confirm button re-enabled so the user can retry (relaunchPending released).
      const confirm = getByTestId("llm-tab:relaunch-confirm") as HTMLButtonElement;
      expect(confirm.disabled).toBe(false);
      // No unhandled promise rejection escaped.
      expect(unhandled).toHaveLength(0);
    } finally {
      window.removeEventListener("unhandledrejection", onUnhandled);
    }
  });

  // (2b) The IPC handler signals failure by RESOLVING { ok: false } (e.g.
  // authMode-not-manual, invalid payload, or an unauthorized frame) rather
  // than throwing. The dialog must behave identically to the thrown case:
  // stay open with the inline error and release relaunchPending — never
  // proceed as if the relaunch succeeded.
  it("keeps the relaunch dialog open when applyHostMap resolves { ok: false }", async () => {
    const api = llmTabApi();
    vi.spyOn(
      api as unknown as {
        applyHostMap: (
          v: string,
        ) => Promise<{ ok: boolean; error?: string; message?: string }>;
      },
      "applyHostMap",
    ).mockResolvedValue({ ok: false, error: "auth-mode-not-manual", message: "locked" });

    const { getByTestId, queryByTestId } = render(
      <Harness
        initialAuthMode="manual"
        initialHostResolverMap={"10.0.0.10 changed.example.com"}
        loadedHostResolverMap={"10.0.0.10 endpoint.example.com"}
        api={api}
      />,
    );

    fireEvent.click(getByTestId("llm-tab:apply-host-map"));
    await act(async () => {
      fireEvent.click(getByTestId("llm-tab:relaunch-confirm"));
    });
    await act(async () => {
      await Promise.resolve();
    });

    // Dialog still open with inline error; the relaunch never proceeded.
    expect(queryByTestId("llm-tab:relaunch-confirm")).not.toBeNull();
    const error = queryByTestId("llm-tab:relaunch-error");
    expect(error).not.toBeNull();
    expect(error?.getAttribute("role")).toBe("alert");
    // Confirm button re-enabled so the user can retry.
    const confirm = getByTestId("llm-tab:relaunch-confirm") as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
  });

  // (3) Pre-hydration the parent passes vendor="" / settingsLoaded=false. The
  // API-key label must not flash the stale first-vendor name (VENDORS[0]).
  it("does not render a stale vendor label before hydration (vendor='')", () => {
    const { container } = render(
      <Harness initialAuthMode="manual" initialVendor="" settingsLoaded={false} />,
    );
    const label = container.querySelector('[data-testid="llm-tab:api-key-label"]');
    expect(label).not.toBeNull();
    // No vendor name leaked — neither the fallback first vendor nor any other.
    for (const v of ALL_VENDORS) {
      expect(label?.textContent ?? "").not.toContain(v.label);
    }
  });

  it("renders the hydrated vendor label once settings load (vendor set)", () => {
    const { container } = render(
      <Harness initialAuthMode="manual" initialVendor="openai" settingsLoaded={true} />,
    );
    const label = container.querySelector('[data-testid="llm-tab:api-key-label"]');
    const openai = VENDORS.find((v) => v.id === "openai")!;
    expect(label?.textContent ?? "").toContain(openai.label);
  });
});

// Account identity + auth management were relocated from the former General
// tab onto this Model surface (login + key + account on one surface). Logout
// reads the active vendor + marketplace preset from the props already hydrated
// here — no separate settings fetch, so there is no provider-load race.
describe("LlmTab — account + auth management", () => {
  function accountApi(overrides: Record<string, unknown> = {}): HarnessApi {
    const { api } = makeMockLvisApi();
    Object.assign(api, overrides);
    return api as unknown as HarnessApi;
  }

  it("renders the logout button in the account section", async () => {
    render(<Harness initialAuthMode="login" onLogout={() => {}} />);
    const logout = await screen.findByTestId("general-tab-logout");
    expect(logout.textContent).toContain("로그아웃");
    // The redundant "Re-enter activation key" button was removed — login /
    // re-activation is a single flow via the "Login" auth method.
    expect(screen.queryByTestId("general-tab-reactivate-demo")).toBeNull();
  });

  it("로그아웃 → confirm → active vendor 의 deleteApiKey + demo clear + onboardingCompleted=false + onLogout", async () => {
    const api = accountApi();
    const onLogout = vi.fn();
    render(
      <Harness
        initialAuthMode="login"
        initialVendor="openai"
        api={api}
        onLogout={onLogout}
      />,
    );
    fireEvent.click(await screen.findByTestId("general-tab-logout"));
    fireEvent.click(await screen.findByTestId("general-tab-logout-confirm-button"));

    await waitFor(() => {
      expect(api.deleteApiKey).toHaveBeenCalledWith("openai");
      expect(api.demo.clearDemo).toHaveBeenCalledTimes(1);
      expect(api.updateSettings).toHaveBeenCalledWith({
        llm: { authMode: "manual" },
        features: { onboardingCompleted: false },
      });
      expect(onLogout).toHaveBeenCalledTimes(1);
    });
    await waitFor(() =>
      expect(screen.queryByTestId("general-tab-logout-confirm")).toBeNull(),
    );
  });

  it("custom marketplace provider logout deletes the preset-scoped API key", async () => {
    const presetId = "future-router";
    const api = accountApi();
    const onLogout = vi.fn();
    render(
      <Harness
        initialAuthMode="login"
        initialVendor="openai-compatible"
        initialMarketplaceProviderPresetId={presetId}
        api={api}
        onLogout={onLogout}
      />,
    );
    fireEvent.click(await screen.findByTestId("general-tab-logout"));
    fireEvent.click(await screen.findByTestId("general-tab-logout-confirm-button"));

    await waitFor(() => {
      expect(api.deleteApiKey).toHaveBeenCalledWith(
        marketplaceProviderPresetSecretId(presetId),
      );
      expect(api.demo.clearDemo).toHaveBeenCalledTimes(1);
      expect(onLogout).toHaveBeenCalledTimes(1);
    });
  });

  it("clearDemo 가 실패하면 onLogout 을 호출하지 않고 error 메시지를 노출", async () => {
    const api = accountApi({
      demo: {
        status: vi.fn(),
        activate: vi.fn(),
        relaunchAfterActivation: vi.fn(),
        clearDemo: vi.fn().mockResolvedValue({ ok: false, error: "clear-failed" }),
      },
    });
    const onLogout = vi.fn();
    render(
      <Harness initialAuthMode="login" initialVendor="openai" api={api} onLogout={onLogout} />,
    );
    fireEvent.click(await screen.findByTestId("general-tab-logout"));
    fireEvent.click(await screen.findByTestId("general-tab-logout-confirm-button"));
    await screen.findByTestId("general-tab-logout-error");
    expect(onLogout).not.toHaveBeenCalled();
  });

  it("active vendor 키 삭제가 실패하면 demo clear/onLogout 없이 fail-closed", async () => {
    const api = accountApi({
      deleteApiKey: vi.fn().mockRejectedValue(new Error("keychain failed")),
    });
    const onLogout = vi.fn();
    render(
      <Harness initialAuthMode="login" initialVendor="openai" api={api} onLogout={onLogout} />,
    );
    fireEvent.click(await screen.findByTestId("general-tab-logout"));
    fireEvent.click(await screen.findByTestId("general-tab-logout-confirm-button"));

    const err = await screen.findByTestId("general-tab-logout-error");
    expect(err.textContent).toContain("API 키 삭제");
    expect(api.demo.clearDemo).not.toHaveBeenCalled();
    expect(api.updateSettings).not.toHaveBeenCalled();
    expect(onLogout).not.toHaveBeenCalled();
  });
});
