import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "../../../components/ui/badge.js";
import { Button } from "../../../components/ui/button.js";
import { Input } from "../../../components/ui/input.js";
import { Label } from "../../../components/ui/label.js";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../components/ui/select.js";
import { Slider } from "../../../components/ui/slider.js";
import { Switch } from "../../../components/ui/switch.js";
import { Textarea } from "../../../components/ui/textarea.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog.js";
import { Loader2, RefreshCw, Store } from "lucide-react";
import {
  REASONING_EFFORT_STEPS,
  VENDORS,
  budgetToEffortIndex,
  getVendorOption,
  visibleVendorsFor,
  type VendorOption,
} from "../constants.js";
import { parseHostResolverMap } from "../../../shared/host-resolver-map.js";
import {
  canUseLlmVendorWithoutApiKey,
  isLLMVendor,
  isOpenAICompatibleVendor,
  isRetiredLlmModel,
} from "../../../shared/llm-vendor-defaults.js";
import {
  llmModelListCacheKey,
  type LlmModelListCache,
  type LlmModelListCacheEntry,
  type LlmModelListEntry,
} from "../../../shared/llm-model-list.js";
import {
  isOpenRouterFreeModel,
} from "../../../shared/openrouter-free-models.js";
import {
  marketplaceProviderPresetSecretId,
  type MarketplaceInstalledProviderPreset,
  type MarketplaceProviderModelDiscoveryPolicy,
} from "../../../shared/marketplace-package-assets.js";
import { isIpcErrorResult, type LvisApi } from "../types.js";
import { SettingsPageHeader } from "../components/SettingsPageHeader.js";
import { SettingsSection } from "../components/SettingsSection.js";
import { useTranslation } from "../../../i18n/react.js";
import { formatIpcError } from "../format-ipc-error.js";

export interface FallbackEntry {
  provider: string;
  model: string;
}

/** Extract the user honorific ("호칭: …") from MEMORY.md for the account card. */
function extractHonorific(userPrefsMd: string): string | null {
  const m = userPrefsMd.match(/(?:사용자\s*)?호칭\s*[:：]\s*(.+)/);
  return m ? m[1].trim().split(/\s+/)[0] : null;
}

/** First non-metadata line of MEMORY.md as a short preview. */
function extractIntroPreview(userPrefsMd: string): string | null {
  const lines = userPrefsMd
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#") && !line.startsWith("-"));
  if (lines.length === 0) return null;
  const first = lines[0];
  return first.length > 120 ? first.slice(0, 117) + "…" : first;
}




const DEMO_VENDOR_VALUE = "__demo__";
const VENDOR_SCROLL_THRESHOLD = 10;
const VENDOR_SELECT_MAX_HEIGHT = "max-h-[386px]";
const MODEL_LIST_SYNC_DEBOUNCE_MS = 350;

type ModelListState =
  | {
      status: "loading";
      options?: string[];
      entries?: LlmModelListEntry[];
      endpoint?: string;
      fetchedAt?: string;
      source?: "cache" | "network";
    }
  | {
      status: "ready";
      options: string[];
      entries?: LlmModelListEntry[];
      endpoint: string;
      fetchedAt: string;
      source?: "cache" | "network";
      persistError?: string;
    }
  | {
      status: "error";
      error: string;
      options?: string[];
      entries?: LlmModelListEntry[];
      endpoint?: string;
      fetchedAt?: string;
      source?: "cache" | "network";
    };

interface ProviderSelectProps {
  value: string;
  onValueChange: (value: string) => void;
  triggerId?: string;
  triggerClassName?: string;
  triggerTestId?: string;
  placeholder?: string;
  vendorOptions?: readonly ProviderOption[];
  marketplaceProviderIds?: readonly string[];
}

type ProviderOption = Omit<VendorOption, "id"> & {
  id: string;
  requiresApiKey?: boolean;
  modelDiscoveryPolicy?: MarketplaceProviderModelDiscoveryPolicy;
};

function normalizeProviderSearch(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function ProviderSelect({
  value,
  onValueChange,
  triggerId,
  triggerClassName,
  triggerTestId,
  placeholder,
  vendorOptions = VENDORS,
  marketplaceProviderIds = [],
}: ProviderSelectProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const marketplaceProviderIdSet = useMemo(
    () => new Set(marketplaceProviderIds),
    [marketplaceProviderIds],
  );

  const options = useMemo(
    () => vendorOptions.map((vendor) => ({
      id: vendor.id,
      label: vendor.label,
      searchText: `${vendor.id} ${vendor.label}`,
      marketplaceInstalled: marketplaceProviderIdSet.has(vendor.id),
    })),
    [marketplaceProviderIdSet, vendorOptions],
  );

  const normalizedQuery = normalizeProviderSearch(query);
  const filteredOptions = useMemo(
    () => normalizedQuery
      ? options.filter((option) => normalizeProviderSearch(option.searchText).includes(normalizedQuery))
      : options,
    [normalizedQuery, options],
  );
  const scrollClassName = options.length > VENDOR_SCROLL_THRESHOLD
    ? VENDOR_SELECT_MAX_HEIGHT
    : "";

  return (
    <Select
      value={value}
      onValueChange={(nextValue) => {
        onValueChange(nextValue);
        setQuery("");
      }}
      onOpenChange={(open) => {
        if (!open) setQuery("");
      }}
    >
      <SelectTrigger
        id={triggerId}
        className={triggerClassName}
        data-testid={triggerTestId}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent
        className={`min-w-64 ${scrollClassName}`}
        data-testid="llm-tab:vendor-content"
      >
        <div className="sticky top-0 z-10 border-b border-border/(--opacity-medium) bg-popover p-2">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
            placeholder={t("llmTab.vendorSearchPlaceholder")}
            aria-label={t("llmTab.vendorSearchAriaLabel")}
            data-testid="llm-tab:vendor-search"
            className="h-8 text-xs"
          />
        </div>
        <SelectGroup className="p-1" data-testid="llm-tab:vendor-options">
          {filteredOptions.length > 0 ? (
            filteredOptions.map((option) => (
              <SelectItem key={option.id} value={option.id}>
                <span className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 truncate">{option.label}</span>
                  {option.marketplaceInstalled && (
                    <span
                      className="inline-flex h-5 shrink-0 items-center rounded-full bg-secondary px-1.5 text-[10px] font-medium text-secondary-foreground"
                      data-testid={`llm-tab:vendor-marketplace-badge:${option.id}`}
                    >
                      {t("llmTab.marketplaceInstalledBadge")}
                    </span>
                  )}
                </span>
              </SelectItem>
            ))
          ) : (
            <div className="px-2 py-3 text-center text-xs text-muted-foreground">
              {t("llmTab.vendorNoResults")}
            </div>
          )}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

export interface LlmTabProps {
  api: LvisApi;
  vendor: string;
  setVendor: (v: string) => void;
  baseUrl: string;
  setBaseUrl: (v: string) => void;
  vertexProject: string;
  setVertexProject: (v: string) => void;
  vertexLocation: string;
  setVertexLocation: (v: string) => void;
  hasKey: boolean;
  setHasKey: (v: boolean) => void;
  keyInput: string;
  setKeyInput: (v: string) => void;
  marketplaceProviderPresetId?: string;
  marketplaceProviderPresets?: readonly MarketplaceInstalledProviderPreset[];
  onSelectMarketplaceProviderPreset?: (preset: MarketplaceInstalledProviderPreset) => void;
  onClearMarketplaceProviderPreset?: () => void;
  /** Opens Settings → Marketplace with the provider package filter active. */
  onOpenMarketplace?: () => void;
  model: string;
  setModel: (v: string) => void;
  enableThinking: boolean;
  setEnableThinking: (v: boolean) => void;
  thinkingBudget: number;
  setThinkingBudget: (v: number) => void;
  fallbackChain: FallbackEntry[];
  setFallbackChain: (updater: FallbackEntry[] | ((c: FallbackEntry[]) => FallbackEntry[])) => void;
  fallbackOpen: boolean;
  setFallbackOpen: (updater: boolean | ((o: boolean) => boolean)) => void;
  /** Manual-mode host-resolver map (persisted /etc/hosts-style text). */
  hostResolverMap: string;
  setHostResolverMap: (v: string) => void;
  /**
   * The host-resolver map value as last hydrated from persisted settings.
   * Used to detect whether the textarea has actually changed — the Apply
   * (Save and Restart) button is only enabled when the current draft differs
   * from this, so an unchanged Apply click can never trigger a needless
   * relaunch (requirement D).
   */
  loadedHostResolverMap: string;
  onSaved: () => void;
  /**
   * Called after the user changes an immediate-apply control (vendor /
   * thinking toggle / reasoning slider). The dialog debounces these and
   * persists via `s.save("llm")` so the user gets immediate-feel
   * application without spamming saves.
   */
  onImmediateChange?: () => void;
  /**
   * Section-anchored explicit save handler. Both the 공급자 구성 and
   * Fallback Chain sections render their own Save button that calls
   * this — the orchestration save() persists the whole `llm` payload,
   * so the two buttons are functionally identical and the visual
   * placement just anchors each Save to its inputs.
   */
  onSave?: () => void;
  saving?: boolean;
  settingsLoaded?: boolean;
}

/**
 * Inline save bar for a LlmTab subsection. Both 공급자 구성 and Fallback
 * Chain reuse this; the Extended Thinking section is fully immediate-apply
 * (Switch + Slider auto-save via onImmediateChange) and renders no bar.
 */
function SectionSaveBar({
  onSave,
  saving,
  settingsLoaded,
  testId,
}: {
  onSave: () => void;
  saving: boolean;
  settingsLoaded: boolean;
  testId: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex justify-end border-t border-border/(--opacity-medium) pt-2">
      <Button
        size="sm"
        onClick={onSave}
        disabled={saving || !settingsLoaded}
        data-testid={testId}
      >
        {saving ? t("llmTab.saving") : t("llmTab.save")}
      </Button>
    </div>
  );
}

/** Inline badge for "즉시 적용" label. */
function ImmediateBadge() {
  const { t } = useTranslation();
  return (
    <span className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
      {t("llmTab.immediateApply")}
    </span>
  );
}

function getVendorInfo(vendorId: string): VendorOption {
  return getVendorOption(vendorId);
}

function providerOptionFromPreset(
  preset: MarketplaceInstalledProviderPreset,
): ProviderOption {
  return {
    id: marketplaceProviderPresetSecretId(preset.providerId),
    label: preset.label,
    placeholder: preset.apiKeyPlaceholder ?? "sk-...",
    needsBaseUrl: true,
    baseUrlPlaceholder: preset.baseUrl,
    defaultModel: preset.defaultModel,
    modelOptions: preset.modelOptions,
    requiresApiKey: preset.requiresApiKey,
    ...(preset.modelDiscoveryPolicy ? { modelDiscoveryPolicy: preset.modelDiscoveryPolicy } : {}),
  };
}

function providerOptionsForPresets(
  presets: readonly MarketplaceInstalledProviderPreset[],
): ProviderOption[] {
  return presets.map(providerOptionFromPreset);
}

function shouldSyncModelList(
  vendorId: string,
  info: ProviderOption | VendorOption,
  baseUrl?: string,
  modelDiscoveryPolicy?: MarketplaceProviderModelDiscoveryPolicy,
): boolean {
  if (!vendorId || vendorId === DEMO_VENDOR_VALUE) return false;
  if (modelDiscoveryPolicyUsesSeededOptions(modelDiscoveryPolicy)) return false;
  if (baseUrl?.trim()) return true;
  if (vendorId === "openai" || vendorId === "copilot") return true;
  if (!info.needsBaseUrl) return false;
  return vendorId !== "openai-compatible" && vendorId !== "azure-foundry";
}

function modelDiscoveryPolicyUsesSeededOptions(
  modelDiscoveryPolicy: MarketplaceProviderModelDiscoveryPolicy | undefined,
): boolean {
  return modelDiscoveryPolicy === "manual" || modelDiscoveryPolicy === "static";
}

/**
 * The openai-compatible provider family (built-in vendor + marketplace
 * presets). For these, the model catalog is endpoint-defined, so the dropdown
 * must be populated ONLY by a live /models handshake — never a hardcoded
 * seed — unless the provider's discovery policy opts into a static/seeded list.
 */
function isOpenAICompatibleFamilyVendor(vendorId: string): boolean {
  return isLLMVendor(vendorId) && isOpenAICompatibleVendor(vendorId);
}

function modelOptionsFor(
  vendorId: string,
  selectedModel: string,
  syncedOptions?: readonly string[],
  info: ProviderOption | VendorOption = getVendorInfo(vendorId),
  modelDiscoveryPolicy?: MarketplaceProviderModelDiscoveryPolicy,
): string[] {
  const hasSynced = Boolean(syncedOptions && syncedOptions.length > 0);
  // Handshake-only: for openai-compatible-family providers whose discovery
  // policy is not seeded (static/manual), never fall back to the static
  // `info.modelOptions` seed or the seeded default model. The list stays empty
  // until a live /models fetch succeeds; only the user's persisted selection is
  // surfaced so an already-configured provider still shows its saved model.
  const handshakeOnly =
    !hasSynced &&
    isOpenAICompatibleFamilyVendor(vendorId) &&
    !modelDiscoveryPolicyUsesSeededOptions(modelDiscoveryPolicy);

  const options = hasSynced
    ? [...(syncedOptions ?? [])]
    : handshakeOnly
      ? []
      : [...info.modelOptions];

  if (!handshakeOnly) {
    const defaultModel = info.defaultModel.trim();
    if (defaultModel && !options.includes(defaultModel)) {
      options.unshift(defaultModel);
    }
  }

  const currentModel = selectedModel.trim();
  if (currentModel && !isRetiredLlmModel(currentModel) && !options.includes(currentModel)) {
    options.unshift(currentModel);
  }

  return options;
}

function compactNumber(value: number): string {
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`;
  if (value >= 1_000) return `${Math.round(value / 100) / 10}k`;
  return String(value);
}

function modelEntryMap(entries: readonly LlmModelListEntry[] | undefined): Map<string, LlmModelListEntry> {
  const map = new Map<string, LlmModelListEntry>();
  for (const entry of entries ?? []) {
    if (!entry.id || map.has(entry.id)) continue;
    map.set(entry.id, entry);
  }
  return map;
}

function modelEntryPricingLabel(entry: LlmModelListEntry | undefined): string | null {
  const pricing = entry?.pricing;
  if (!pricing) return null;
  if (pricing.prompt === undefined && pricing.completion === undefined) return null;
  return `in ${pricing.prompt ?? "?"} / out ${pricing.completion ?? "?"}`;
}

function ModelSelectItemContent({
  option,
  entry,
}: {
  option: string;
  entry?: LlmModelListEntry;
}) {
  const { t } = useTranslation();
  const isFree = entry?.tags?.free === true || isOpenRouterFreeModel(option);
  const isRouter = entry?.tags?.router === true;
  const isLocal = entry?.tags?.local === true;
  const detailParts = [
    entry?.provider ?? entry?.ownedBy,
    entry?.contextLength !== undefined
      ? t("llmTab.modelContextTokens", { count: compactNumber(entry.contextLength) })
      : undefined,
    modelEntryPricingLabel(entry) ?? undefined,
  ].filter((part): part is string => Boolean(part));
  if (!isFree && !isRouter && !isLocal && detailParts.length === 0) return <>{option}</>;
  return (
    <span className="flex min-w-0 flex-col gap-0.5 py-0.5">
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="min-w-0 truncate">{option}</span>
        {isFree && (
          <Badge variant="secondary" className="h-4 px-1 text-[9px] uppercase">
            {t("llmTab.openRouterFreeBadge")}
          </Badge>
        )}
        {isRouter && (
          <Badge variant="outline" className="h-4 px-1 text-[9px] uppercase">
            {t("llmTab.modelRouterBadge")}
          </Badge>
        )}
        {isLocal && (
          <Badge variant="outline" className="h-4 px-1 text-[9px] uppercase">
            {t("llmTab.modelLocalBadge")}
          </Badge>
        )}
      </span>
      {(isFree || detailParts.length > 0) && (
        <span className="text-[10px] leading-tight text-muted-foreground">
          {isFree ? t("llmTab.openRouterFreeDisclaimer") : detailParts.join(" · ")}
        </span>
      )}
    </span>
  );
}

function modelListStateFromCacheEntry(entry: LlmModelListCacheEntry): ModelListState {
  return {
    status: "ready",
    options: entry.models,
    entries: entry.modelEntries,
    endpoint: entry.endpoint,
    fetchedAt: entry.fetchedAt,
    source: "cache",
  };
}

function modelListStatesFromCache(
  cache?: LlmModelListCache,
  marketplaceProviderPresets: readonly MarketplaceInstalledProviderPreset[] = [],
): Record<string, ModelListState> {
  if (!cache) return {};
  const states: Record<string, ModelListState> = {};
  for (const [key, entry] of Object.entries(cache)) {
    if (!entry.models.length) continue;
    if (entry.vendor === "openai-compatible" && entry.credentialScope) {
      const preset = marketplaceProviderPresets.find((candidate) =>
        candidate.providerId === entry.credentialScope
      );
      if (modelDiscoveryPolicyUsesSeededOptions(preset?.modelDiscoveryPolicy)) continue;
    }
    states[key] = modelListStateFromCacheEntry(entry);
  }
  return states;
}

function optionsFromModelListState(state: ModelListState | undefined): readonly string[] | undefined {
  return state?.options && state.options.length > 0 ? state.options : undefined;
}

function hasUsableModelListOptions(state: ModelListState | undefined): boolean {
  return Boolean(optionsFromModelListState(state));
}

function reconcileModelListStatesWithCache(
  current: Record<string, ModelListState>,
  cachedStates: Record<string, ModelListState>,
): Record<string, ModelListState> {
  const next: Record<string, ModelListState> = {};
  for (const [key, state] of Object.entries(current)) {
    if (state.source === "cache" && !(key in cachedStates)) continue;
    next[key] = state;
  }
  for (const [key, state] of Object.entries(cachedStates)) {
    const currentState = current[key];
    next[key] = currentState && currentState.source !== "cache" && hasUsableModelListOptions(currentState)
      ? currentState
      : state;
  }
  return next;
}

export function LlmTab(props: LlmTabProps) {
  const {
    api,
    vendor,
    setVendor,
    baseUrl,
    setBaseUrl,
    vertexProject,
    setVertexProject,
    vertexLocation,
    setVertexLocation,
    hasKey,
    setHasKey,
    keyInput,
    setKeyInput,
    marketplaceProviderPresetId = "",
    marketplaceProviderPresets = [],
    onSelectMarketplaceProviderPreset,
    onClearMarketplaceProviderPreset,
    onOpenMarketplace,
    model,
    setModel,
    enableThinking,
    setEnableThinking,
    thinkingBudget,
    setThinkingBudget,
    fallbackChain,
    setFallbackChain,
    fallbackOpen,
    setFallbackOpen,
    hostResolverMap,
    setHostResolverMap,
    loadedHostResolverMap,
    onSaved,
    onImmediateChange,
    onSave,
    saving = false,
    settingsLoaded = true,
  } = props;
  const { t } = useTranslation();
  const selectedMarketplaceProviderPreset = vendor === "openai-compatible" && marketplaceProviderPresetId
    ? marketplaceProviderPresets.find((preset) => preset.providerId === marketplaceProviderPresetId)
    : undefined;
  const selectedMarketplaceProviderOption = selectedMarketplaceProviderPreset
    ? providerOptionFromPreset(selectedMarketplaceProviderPreset)
    : undefined;
  const vendorInfo = selectedMarketplaceProviderOption ?? getVendorInfo(vendor);
  const activeCredentialProviderId = selectedMarketplaceProviderPreset
    ? marketplaceProviderPresetSecretId(selectedMarketplaceProviderPreset.providerId)
    : vendor;
  const activeModelListCredentialScope = selectedMarketplaceProviderPreset?.providerId ?? "";
  const endpointLockedToMarketplacePreset = Boolean(selectedMarketplaceProviderPreset);
  // (B) Pre-hydration the parent initializes `vendor` to "" so the dropdown
  // never flashes the wrong vendor. `getVendorInfo("")` still falls back to
  // VENDORS[0], so reading `vendorInfo.label` directly would leak that stale
  // first-vendor name into the API-key heading before settings load. Render
  // the label only once a real vendor is hydrated; until then show nothing.
  const vendorLabelReady = vendor !== "" && settingsLoaded;
  const vendorLabel = vendorLabelReady ? vendorInfo.label : "";
  const hasOnSave = typeof onSave === "function";
  const trimmedModel = model.trim();
  const activeModelValue = trimmedModel && !isRetiredLlmModel(trimmedModel)
    ? trimmedModel
    : vendorInfo.defaultModel;
  const [marketplaceProviderIds, setMarketplaceProviderIds] = useState<readonly string[]>([]);
  const [modelLists, setModelLists] = useState<Record<string, ModelListState>>({});
  const modelListsRef = useRef<Record<string, ModelListState>>({});
  const modelListCacheRef = useRef<LlmModelListCache>({});
  const setModelListState = useCallback((key: string, state: ModelListState) => {
    setModelLists((current) => {
      const next = { ...current, [key]: state };
      modelListsRef.current = next;
      return next;
    });
  }, []);
  const requestModelList = useCallback(
    async (
      provider: string,
      options: {
        baseUrl?: string;
        force?: boolean;
        credentialScope?: string;
        modelDiscoveryPolicy?: MarketplaceProviderModelDiscoveryPolicy;
      } = {},
    ) => {
      if (!settingsLoaded && !options.force) return;
      const providerInfo = getVendorInfo(provider);
      const baseUrl = options.baseUrl?.trim() ?? "";
      if (!shouldSyncModelList(provider, providerInfo, baseUrl, options.modelDiscoveryPolicy)) return;
      const credentialScope =
        provider === "openai-compatible" ? options.credentialScope?.trim() ?? "" : "";
      const key = llmModelListCacheKey(provider, baseUrl, credentialScope);
      const existing = modelListsRef.current[key];
      const persistedCacheHasKey = Object.prototype.hasOwnProperty.call(
        modelListCacheRef.current,
        key,
      );
      if (!options.force) {
        if (existing && existing.source !== "cache" && persistedCacheHasKey) return;
      }
      setModelListState(key, existing?.options
        ? { ...existing, status: "loading" }
        : { status: "loading" });
      try {
        const result = await api.listLlmModels({
          vendor: provider,
          ...(baseUrl ? { baseUrl } : {}),
          ...(credentialScope ? { credentialScope } : {}),
          ...(options.modelDiscoveryPolicy ? { modelDiscoveryPolicy: options.modelDiscoveryPolicy } : {}),
        });
        if (result.ok) {
          const nextEntry: LlmModelListCacheEntry = {
            vendor: result.vendor,
            ...(baseUrl ? { baseUrl } : {}),
            ...(credentialScope ? { credentialScope } : {}),
            endpoint: result.endpoint,
            models: result.models,
            ...(result.modelEntries ? { modelEntries: result.modelEntries } : {}),
            fetchedAt: result.fetchedAt,
          };
          const nextCache = {
            ...modelListCacheRef.current,
            [key]: nextEntry,
          };
          modelListCacheRef.current = nextCache;
          setModelListState(key, {
            status: "ready",
            options: result.models,
            entries: result.modelEntries,
            endpoint: result.endpoint,
            fetchedAt: result.fetchedAt,
            source: "network",
          });
          const markPersistError = (err: unknown): void => {
            const latest = modelListsRef.current[key];
            if (latest?.status !== "ready") return;
            setModelListState(key, {
              ...latest,
              persistError: err instanceof Error ? err.message : String(err),
            });
          };
          void api.updateSettings({ llm: { modelListCache: nextCache } })
            .then((persistResult) => {
              if (isIpcErrorResult(persistResult)) {
                markPersistError(persistResult.message ?? persistResult.error);
              }
            })
            .catch(markPersistError);
        } else {
          const latest = modelListsRef.current[key] ?? existing;
          setModelListState(key, {
            status: "error",
            error: result.message ?? result.error,
            options: latest?.options,
            entries: latest?.entries,
            endpoint: latest?.endpoint,
            fetchedAt: latest?.fetchedAt,
            source: latest?.source,
          });
        }
      } catch (err) {
        const latest = modelListsRef.current[key] ?? existing;
        setModelListState(key, {
          status: "error",
          error: err instanceof Error ? err.message : String(err),
          options: latest?.options,
          entries: latest?.entries,
          endpoint: latest?.endpoint,
          fetchedAt: latest?.fetchedAt,
          source: latest?.source,
        });
      }
    },
    [api, setModelListState, settingsLoaded],
  );
  const activeModelListBaseUrl = selectedMarketplaceProviderPreset?.baseUrl ?? baseUrl.trim();
  const activeModelDiscoveryPolicy = selectedMarketplaceProviderPreset?.modelDiscoveryPolicy;
  const activeProviderRequiresApiKey = selectedMarketplaceProviderPreset
    ? selectedMarketplaceProviderPreset.requiresApiKey !== false
    : !(isLLMVendor(vendor) && canUseLlmVendorWithoutApiKey(vendor, {
      baseUrl: activeModelListBaseUrl,
    }));
  const activeModelListKey = llmModelListCacheKey(
    vendor,
    activeModelListBaseUrl,
    activeModelListCredentialScope,
  );
  const activeModelList = modelLists[activeModelListKey];
  const activeShouldSyncModelList = shouldSyncModelList(
    vendor,
    vendorInfo,
    activeModelListBaseUrl,
    activeModelDiscoveryPolicy,
  );
  const activeSyncedModelOptions = modelDiscoveryPolicyUsesSeededOptions(activeModelDiscoveryPolicy)
    ? undefined
    : optionsFromModelListState(activeModelList);
  const activeModelOptions = modelOptionsFor(
    vendor,
    activeModelValue,
    activeSyncedModelOptions,
    vendorInfo,
    activeModelDiscoveryPolicy,
  );
  const activeModelEntryById = useMemo(
    () => modelEntryMap(activeModelList?.entries),
    [activeModelList],
  );
  const marketplaceProviderPresetOptions = useMemo(
    () => providerOptionsForPresets(marketplaceProviderPresets),
    [marketplaceProviderPresets],
  );
  const marketplaceProviderPresetSelectIds = useMemo(
    () => marketplaceProviderPresets.map((preset) =>
      marketplaceProviderPresetSecretId(preset.providerId)
    ),
    [marketplaceProviderPresets],
  );
  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    const applySettings = (settings: Awaited<ReturnType<LvisApi["getSettings"]>>) => {
      const ids = settings.marketplace?.installedProviderIds;
      setMarketplaceProviderIds(Array.isArray(ids) ? ids : []);
      const cache = settings.llm?.modelListCache ?? {};
      modelListCacheRef.current = cache;
      const cachedStates = modelListStatesFromCache(cache, marketplaceProviderPresets);
      setModelLists((current) => {
        const next = reconcileModelListStatesWithCache(current, cachedStates);
        modelListsRef.current = next;
        return next;
      });
    };
    void (async () => {
      try {
        const settings = await api.getSettings();
        if (cancelled) return;
        applySettings(settings);
        unsubscribe = api.onSettingsUpdated((nextSettings) => {
          if (cancelled) return;
          applySettings(nextSettings);
        });
      } catch {
        /* defaults remain */
      }
    })();
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [api, marketplaceProviderPresets]);
  const providerSelectOptions = useMemo(
    () => [
      ...visibleVendorsFor([vendor, ...marketplaceProviderIds]),
      ...marketplaceProviderPresetOptions,
    ],
    [marketplaceProviderIds, marketplaceProviderPresetOptions, vendor],
  );
  useEffect(() => {
    if (!settingsLoaded) return;
    const timer = window.setTimeout(() => {
      void requestModelList(vendor, {
        baseUrl: activeModelListBaseUrl,
        credentialScope: activeModelListCredentialScope,
        ...(activeModelDiscoveryPolicy ? { modelDiscoveryPolicy: activeModelDiscoveryPolicy } : {}),
      });
    }, MODEL_LIST_SYNC_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [
    activeModelListBaseUrl,
    activeModelListCredentialScope,
    activeModelDiscoveryPolicy,
    requestModelList,
    settingsLoaded,
    vendor,
  ]);
  const fallbackProviderKey = useMemo(
    () => [...new Set(fallbackChain.map((entry) => entry.provider).filter(Boolean))]
      .sort()
      .join("\n"),
    [fallbackChain],
  );
  useEffect(() => {
    if (!settingsLoaded || !fallbackOpen) return;
    for (const provider of fallbackProviderKey.split("\n").filter(Boolean)) {
      void requestModelList(provider);
    }
  }, [fallbackOpen, fallbackProviderKey, requestModelList, settingsLoaded]);

  // Relaunch confirmation dialog state for host map changes.
  const [relaunchConfirmOpen, setRelaunchConfirmOpen] = useState(false);
  const [relaunchPending, setRelaunchPending] = useState(false);
  const [relaunchError, setRelaunchError] = useState<string | null>(null);

  const handleHostMapApply = useCallback(() => {
    setRelaunchError(null);
    setRelaunchConfirmOpen(true);
  }, []);

  const handleRelaunchConfirm = useCallback(async () => {
    setRelaunchPending(true);
    setRelaunchError(null);
    try {
      const result = await api.applyHostMap(hostResolverMap);
      if (!result.ok) {
        // The handler resolved with a structured rejection (unauthorized
        // frame or invalid payload) rather than
        // throwing. The relaunch never happened — surface the specific,
        // localized reason (formatIpcError maps the IPC error code to a
        // ko/en message) and keep the dialog open so the user can cancel;
        // closing silently would falsely imply the change applied.
        setRelaunchError(
          formatIpcError(result.error, result.message) ||
            t("llmTab.relaunchConfirmError"),
        );
        setRelaunchPending(false);
        return;
      }
      // On success the main process calls app.relaunch() + app.exit(0), so
      // this renderer terminates here — no further cleanup runs. We keep the
      // dialog open until then so the user never sees it close without a
      // restart actually happening.
    } catch {
      // Persisting the host map (or scheduling the relaunch) failed. Surface
      // it inline and keep the dialog open so the user can retry or cancel —
      // closing silently would falsely imply the change applied. Awaiting +
      // catching here also prevents an unhandled promise rejection.
      setRelaunchError(t("llmTab.relaunchConfirmError"));
      setRelaunchPending(false);
    }
  }, [api, hostResolverMap, t]);

  const displayVendor = selectedMarketplaceProviderPreset
    ? marketplaceProviderPresetSecretId(selectedMarketplaceProviderPreset.providerId)
    : vendor;
  const isMarketplaceProviderSelected =
    marketplaceProviderIds.includes(vendor) || Boolean(selectedMarketplaceProviderPreset);
  const handleVendorChange = useCallback(
    (v: string) => {
      const preset = marketplaceProviderPresets.find(
        (entry) => marketplaceProviderPresetSecretId(entry.providerId) === v,
      );
      if (preset) {
        onSelectMarketplaceProviderPreset?.(preset);
        onImmediateChange?.();
        return;
      }
      onClearMarketplaceProviderPreset?.();
      setVendor(v);
      onImmediateChange?.();
    },
    [
      marketplaceProviderPresets,
      onClearMarketplaceProviderPreset,
      onImmediateChange,
      onSelectMarketplaceProviderPreset,
      setVendor,
    ],
  );
  // Requirement D — only allow Apply when the host map has ACTUALLY changed
  // from the last-persisted value. `loadedHostResolverMap` is the value
  // hydrated from settings; comparing against it means an unchanged textarea
  // leaves the Apply (Save and Restart) button disabled, so an unchanged
  // click can never trigger a needless relaunch.
  const hostMapChanged = hostResolverMap !== loadedHostResolverMap;
  const hostMapEntryCount = parseHostResolverMap(hostResolverMap).length;

  // ── Account identity (relocated from the former General tab). Honorific and
  //    introduction come from MEMORY.md; provider/key state reuse the props
  //    already hydrated here so no second settings fetch is needed.
  const [userPrefs, setUserPrefs] = useState<string>("");
  useEffect(() => {
    let alive = true;
    void api.memoryGetUserPrefs().then(
      (prefs) => { if (alive) setUserPrefs(prefs); },
      () => { /* MEMORY.md read is non-fatal for the account card */ },
    );
    return () => { alive = false; };
  }, [api]);
  const honorific = useMemo(() => extractHonorific(userPrefs), [userPrefs]);
  const intro = useMemo(() => extractIntroPreview(userPrefs), [userPrefs]);
  const avatarInitial = (honorific?.slice(0, 1) ?? vendor.slice(0, 1) ?? "?").toUpperCase();

  return (
    <div className="space-y-6">
      <SettingsPageHeader
        title={t("llmTab.pageTitle")}
        description={t("llmTab.pageDescription")}
      />

      {/* Account identity (relocated from the former General tab). */}
      <SettingsSection
        title={t("generalTab.accountTitle")}
        description={t("generalTab.accountDescription")}
      >
        <div className="flex items-start gap-4">
          <div
            className="flex size-12 shrink-0 items-center justify-center rounded-full bg-primary/(--opacity-soft) text-lg font-semibold text-primary"
            aria-hidden="true"
          >
            {avatarInitial}
          </div>
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-base font-semibold">{honorific ?? t("generalTab.nameNotSet")}</p>
              {vendor && (
                <Badge variant="secondary" className="text-[10px] uppercase">
                  {vendor}
                </Badge>
              )}
              <Badge variant="outline" className="text-[10px]">
                {t("generalTab.apiKeyModeBadge")}
              </Badge>
              {hasKey && (
                <Badge variant="secondary" className="text-[10px]">
                  {t("generalTab.keyRegisteredBadge")}
                </Badge>
              )}
            </div>
            <p className="text-sm text-muted-foreground" data-testid="general-tab-intro">
              {intro ?? t("generalTab.introNotSet")}
            </p>
          </div>
        </div>
      </SettingsSection>

      {/* Relaunch confirmation dialog — shown before applying host map changes */}
      <Dialog
        open={relaunchConfirmOpen}
        onOpenChange={(open) => {
          if (relaunchPending) return;
          if (!open) setRelaunchError(null);
          setRelaunchConfirmOpen(open);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("llmTab.relaunchConfirmTitle")}</DialogTitle>
            <DialogDescription>{t("llmTab.relaunchConfirmBody")}</DialogDescription>
          </DialogHeader>
          {relaunchError && (
            <p
              role="alert"
              className="rounded-md bg-destructive/(--opacity-subtle) px-3 py-2 text-sm text-destructive"
              data-testid="llm-tab:relaunch-error"
            >
              {relaunchError}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setRelaunchError(null);
                setRelaunchConfirmOpen(false);
              }}
              disabled={relaunchPending}
            >
              {t("llmTab.relaunchConfirmCancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={() => void handleRelaunchConfirm()}
              disabled={relaunchPending}
              data-testid="llm-tab:relaunch-confirm"
            >
              {relaunchPending ? t("llmTab.saving") : t("llmTab.relaunchConfirmOk")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Section A — 공급자 구성.
          Manual-only surface: the user configures their own API key / provider.
          The login/demo auth toggle was removed (product decision "①안") — the
          setup flow lives outside settings. */}
      <SettingsSection
        title={t("llmTab.providerConfig")}
        id="llm-providers"
        actions={onOpenMarketplace ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 gap-1.5 text-xs"
            data-testid="llm-tab:marketplace-providers"
            onClick={onOpenMarketplace}
          >
            <Store className="size-3.5" aria-hidden={true} />
            {t("llmTab.moreProvidersInMarketplace")}
          </Button>
        ) : null}
      >
        <div
          className="space-y-3"
          data-testid="llm-tab:section-providers"
        >
          {/* Provider selector — the single provider switcher for the manual
              API-key configuration. */}
          <div className="space-y-2">
            <Label htmlFor="vendor-select" className="flex items-center gap-2">
              {t("llmTab.vendor")}
              <ImmediateBadge />
              {isMarketplaceProviderSelected && (
                <span
                  className="inline-flex h-5 items-center rounded-full bg-secondary px-1.5 text-[10px] font-medium text-secondary-foreground"
                  data-testid={`llm-tab:selected-provider-marketplace:${displayVendor}`}
                >
                  {t("llmTab.marketplaceInstalledBadge")}
                </span>
              )}
            </Label>
            <ProviderSelect
              value={displayVendor}
              onValueChange={handleVendorChange}
              triggerId="vendor-select"
              triggerClassName="w-full"
              placeholder={t("llmTab.vendorPlaceholder")}
              vendorOptions={providerSelectOptions}
              marketplaceProviderIds={[
                ...marketplaceProviderIds,
                ...marketplaceProviderPresetSelectIds,
              ]}
            />
          </div>
          {/* Provider detail form — the manual API-key configuration. */}
          <div
            className="space-y-3"
            data-testid="llm-tab:manual-section"
          >
            {vendor !== "vertex-ai" && (vendorInfo.needsBaseUrl || vendor === "openai" || vendor === "copilot") && (
              <div className="space-y-2">
                <Label className="text-sm font-medium">
                  {t("llmTab.endpointBaseUrlLabel")}{vendorInfo.needsBaseUrl ? " *" : ` (${t("llmTab.optional")})`}
                </Label>
                <Input
                  data-testid="llm-base-url-input"
                  value={selectedMarketplaceProviderPreset?.baseUrl ?? baseUrl}
                  onChange={(e) => {
                    if (endpointLockedToMarketplacePreset) return;
                    setBaseUrl(e.target.value);
                  }}
                  placeholder={(vendorInfo as any).baseUrlPlaceholder ?? "https://..."}
                  readOnly={endpointLockedToMarketplacePreset}
                />
                <p className="text-[11px] text-muted-foreground">
                  {t("llmTab.baseUrlDiscardWarning")}
                </p>
                {vendor === "azure-foundry" && (
                  <p className="text-[11px] text-muted-foreground">
                    {t("llmTab.azureEndpointFormat")}
                    {" "}<code>https://{"{resource}"}.openai.azure.com/openai/v1/</code>
                    {" "}— {t("llmTab.azureDeploymentNote")}
                  </p>
                )}
                {(vendor === "openai" || vendor === "copilot") && (
                  <p className="text-[11px] text-muted-foreground">
                    {t("llmTab.proxyEndpointNote")}
                  </p>
                )}
              </div>
            )}
            {vendor === "vertex-ai" && (
              <div className="space-y-2 rounded-md border p-3">
                <p className="text-sm font-medium">{t("llmTab.vertexTitle")}</p>
                <p className="text-[11px] text-muted-foreground">
                  {t("llmTab.vertexAuthDesc1")}<code>gcloud auth application-default login</code>{t("llmTab.vertexAuthDesc2")}
                  {t("llmTab.vertexAuthDesc3")}<code>GOOGLE_APPLICATION_CREDENTIALS</code>{t("llmTab.vertexAuthDesc4")}
                </p>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">{t("llmTab.gcpProjectIdLabel")}</Label>
                  <Input
                    value={vertexProject}
                    onChange={(e) => setVertexProject(e.target.value)}
                    placeholder="my-gcp-project"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">
                    {t("llmTab.vertexLocationLabel", { optional: t("llmTab.optional") })}
                  </Label>
                  <Input
                    value={vertexLocation}
                    onChange={(e) => setVertexLocation(e.target.value)}
                    placeholder={t("llmTab.vertexLocationPlaceholder")}
                  />
                </div>
              </div>
            )}
            {vendor !== "vertex-ai" && (
              <div
                className="space-y-2"
                data-testid="llm-tab:api-key-section"
                data-api-key-required={activeProviderRequiresApiKey ? "true" : "false"}
              >
                <Label className="text-sm font-medium" data-testid="llm-tab:api-key-label">
                  {vendorLabel ? `${vendorLabel} ` : ""}{t("llmTab.apiKey")}
                  {!activeProviderRequiresApiKey ? ` (${t("llmTab.optional")})` : ""}
                </Label>
                <div className="flex items-center gap-2">
                  {hasKey ? (
                    <Badge variant="default" className="text-xs">{t("llmTab.apiKeySet")}</Badge>
                  ) : (
                    <Badge variant="secondary" className="text-xs">
                      {activeProviderRequiresApiKey ? t("llmTab.apiKeyNotSet") : t("llmTab.optional")}
                    </Badge>
                  )}
                  {hasKey && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs text-destructive"
                      onClick={() => void api.deleteApiKey(activeCredentialProviderId).then(() => { setHasKey(false); onSaved(); })}
                    >
                      {t("llmTab.delete")}
                    </Button>
                  )}
                </div>
                <Input
                  data-testid="llm-api-key-input"
                  type="password"
                  placeholder={hasKey ? t("llmTab.replaceKey") : vendorInfo.placeholder}
                  value={keyInput}
                  onChange={(e) => setKeyInput(e.target.value)}
                />
              </div>
            )}
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="model-select" className="text-sm font-medium">{t("llmTab.model")}</Label>
                <div className="flex items-center gap-1">
                  {onOpenMarketplace && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="h-7 gap-1.5 px-2 text-xs"
                          data-testid="llm-tab:marketplace-models"
                          onClick={onOpenMarketplace}
                        >
                          <Store className="h-3.5 w-3.5" aria-hidden={true} />
                          {t("llmTab.moreModelsInMarketplace")}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{t("llmTab.moreModelsInMarketplace")}</TooltipContent>
                    </Tooltip>
                  )}
                  {activeShouldSyncModelList && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-7 w-7 p-0"
                        aria-label={t("llmTab.modelSync")}
                        data-testid="llm-tab:model-sync"
                        disabled={activeModelList?.status === "loading"}
                        onClick={() => void requestModelList(vendor, {
                          baseUrl: activeModelListBaseUrl,
                          credentialScope: activeModelListCredentialScope,
                          ...(activeModelDiscoveryPolicy ? { modelDiscoveryPolicy: activeModelDiscoveryPolicy } : {}),
                          force: true,
                        })}
                      >
                        {activeModelList?.status === "loading"
                          ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden={true} />
                          : <RefreshCw className="h-3.5 w-3.5" aria-hidden={true} />}
                      </Button>
                      </TooltipTrigger>
                      <TooltipContent>{t("llmTab.modelSync")}</TooltipContent>
                    </Tooltip>
                  )}
                </div>
              </div>
              <Select
                value={activeModelValue}
                onValueChange={setModel}
              >
                <SelectTrigger
                  id="model-select"
                  className="w-full"
                  data-testid="llm-model-select"
                >
                  <SelectValue placeholder={vendorInfo.defaultModel} />
                </SelectTrigger>
                <SelectContent>
                  {activeModelOptions.map((option) => (
                    <SelectItem key={option} value={option}>
                      <ModelSelectItemContent
                        option={option}
                        {...(activeModelEntryById.has(option)
                          ? { entry: activeModelEntryById.get(option)! }
                          : {})}
                      />
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {activeModelList?.status === "loading" && (
                <p className="text-[11px] text-muted-foreground" data-testid="llm-tab:model-sync-status">
                  {t("llmTab.modelSyncing")}
                </p>
              )}
              {activeModelList?.status === "ready" && (
                <p className="text-[11px] text-muted-foreground" data-testid="llm-tab:model-sync-status">
                  {activeModelList.persistError
                    ? t("llmTab.modelSyncCacheSaveFailed")
                    : t("llmTab.modelSynced", { count: activeModelList.options.length })}
                </p>
              )}
              {activeModelList?.status === "error" && (
                <p className="text-[11px] text-muted-foreground" data-testid="llm-tab:model-sync-status">
                  {t("llmTab.modelSyncFailed")}
                </p>
              )}
            </div>
          </div>

          {hasOnSave && (
            <SectionSaveBar
              onSave={onSave!}
              saving={saving}
              settingsLoaded={settingsLoaded}
              testId="llm-tab:save-providers"
            />
          )}
        </div>
      </SettingsSection>

      {/* Section — Host Resolver Map.
          A dedicated Apply button triggers the relaunch confirm dialog because
          host-resolver-rules cannot be changed at runtime. */}
      <SettingsSection
        title={t("llmTab.hostResolverMapTitle")}
        id="llm-host-resolver"
      >
        <div className="space-y-2" data-testid="llm-tab:host-resolver-section">
          <p className="text-[11px] text-muted-foreground">
            {t("llmTab.hostResolverMapDesc")}
          </p>
          <Textarea
            data-testid="llm-host-resolver-map-input"
            value={hostResolverMap}
            onChange={(e) => setHostResolverMap(e.target.value)}
            placeholder={t("llmTab.hostResolverMapPlaceholder")}
            rows={5}
            className="font-mono text-xs"
            aria-label={t("llmTab.hostResolverMapTitle")}
          />
          {hostMapEntryCount > 0 && (
            <p className="text-[11px] text-muted-foreground">
              {hostMapEntryCount === 1
                ? t("llmTab.entryCountSingular", { count: hostMapEntryCount })
                : t("llmTab.entryCountPlural", { count: hostMapEntryCount })}
            </p>
          )}
          <div className="flex justify-end">
            <Button
              size="sm"
              variant="outline"
              onClick={handleHostMapApply}
              disabled={saving || !settingsLoaded || !hostMapChanged}
              data-testid="llm-tab:apply-host-map"
            >
              {t("llmTab.hostResolverMapApply")}
            </Button>
          </div>
        </div>
      </SettingsSection>

      {/* Section B — Extended Thinking / Reasoning */}
      <SettingsSection
        title={t("llmTab.thinkingTitle")}
        badge={<ImmediateBadge />}
        actions={
          <Switch
            checked={enableThinking}
            onCheckedChange={(c) => {
              setEnableThinking(c);
              onImmediateChange?.();
            }}
            aria-label={t("llmTab.thinkingTitle")}
          />
        }
        id="llm-thinking"
      >
        <div
          className="space-y-2"
          data-testid="llm-tab:section-thinking"
        >
          <p className="text-[11px] text-muted-foreground">{t("llmTab.thinkingDesc")}</p>
          {enableThinking && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-xs text-muted-foreground">{t("llmTab.reasoningEffortLabel")}</Label>
                <span className="text-xs font-medium tabular-nums">
                  {REASONING_EFFORT_STEPS[budgetToEffortIndex(thinkingBudget)]!.label}
                  <span className="ml-2 text-muted-foreground">
                    · {t("llmTab.reasoningBudgetTokens", { count: thinkingBudget.toLocaleString() })}
                  </span>
                </span>
              </div>
              <Slider
                min={0}
                max={REASONING_EFFORT_STEPS.length - 1}
                step={1}
                value={[budgetToEffortIndex(thinkingBudget)]}
                onValueChange={([value]) => {
                  setThinkingBudget(REASONING_EFFORT_STEPS[value ?? 0]!.budget);
                  onImmediateChange?.();
                }}
                aria-label={t("llmTab.reasoningEffortAriaLabel")}
              />
              <div className="flex justify-between text-[10px] text-muted-foreground">
                {REASONING_EFFORT_STEPS.map((s) => (
                  <span key={s.label}>{s.label}</span>
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground">
                {t("llmTab.reasoningEffortDesc")}
              </p>
            </div>
          )}
        </div>
      </SettingsSection>

      {/* Section C — Fallback Chain */}
      <SettingsSection
        title={t("llmTab.fallbackTitle")}
        id="llm-fallback"
      >
        <div
          className="space-y-2"
          data-testid="fallback-chain-section"
        >
          <Button
            type="button"
            variant="ghost"
            className="h-auto w-full justify-between rounded-none px-0 py-1 text-sm font-medium"
            onClick={() => setFallbackOpen((o) => !o)}
          >
            <span className="text-muted-foreground text-xs">{t("llmTab.fallbackSummary")}</span>
            <span className="text-muted-foreground">{fallbackOpen ? "▲" : "▼"}</span>
          </Button>
          {fallbackOpen && (
            <div className="space-y-3">
              <p className="text-[11px] text-muted-foreground">{t("llmTab.fallbackDesc")}</p>
              {fallbackChain.map((entry, idx) => {
                const fallbackVendorInfo = getVendorInfo(entry.provider);
                const trimmedFallbackModel = entry.model.trim();
                const fallbackModelValue = trimmedFallbackModel && !isRetiredLlmModel(trimmedFallbackModel)
                  ? trimmedFallbackModel
                  : fallbackVendorInfo.defaultModel;
                const fallbackModelList = modelLists[llmModelListCacheKey(entry.provider)];
                const fallbackModelOptions = modelOptionsFor(
                  entry.provider,
                  fallbackModelValue,
                  optionsFromModelListState(fallbackModelList),
                );
                return (
                  <div key={idx} className="flex gap-2">
                    <ProviderSelect
                      value={entry.provider}
                      onValueChange={(value) => {
                        const nextVendorInfo = getVendorInfo(value);
                        const next = [...fallbackChain];
                        next[idx] = {
                          ...next[idx]!,
                          provider: value,
                          model: nextVendorInfo.defaultModel,
                        };
                        setFallbackChain(next);
                      }}
                      triggerClassName="w-36 text-xs"
                      vendorOptions={visibleVendorsFor([
                        entry.provider,
                        ...marketplaceProviderIds,
                      ])}
                      marketplaceProviderIds={marketplaceProviderIds}
                    />
                    <Select
                      value={fallbackModelValue}
                      onValueChange={(value) => {
                        const next = [...fallbackChain];
                        next[idx] = { ...next[idx]!, model: value };
                        setFallbackChain(next);
                      }}
                    >
                      <SelectTrigger className="min-w-0 flex-1 text-xs">
                        <SelectValue placeholder={fallbackVendorInfo.defaultModel} />
                      </SelectTrigger>
                      <SelectContent>
                        {fallbackModelOptions.map((option) => (
                          <SelectItem key={option} value={option}>
                            <ModelSelectItemContent option={option} />
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8 text-xs text-destructive"
                      onClick={() => setFallbackChain((c) => c.filter((_, i) => i !== idx))}
                    >
                      {t("llmTab.delete")}
                    </Button>
                  </div>
                );
              })}
              <Button
                size="sm"
                variant="outline"
                className="h-8 text-xs"
                onClick={() => setFallbackChain((c) => [
                  ...c,
                  { provider: "openai", model: getVendorInfo("openai").defaultModel },
                ])}
              >
                {t("llmTab.addEntry")}
              </Button>
              {hasOnSave && (
                <SectionSaveBar
                  onSave={onSave!}
                  saving={saving}
                  settingsLoaded={settingsLoaded}
                  testId="llm-tab:save-fallback"
                />
              )}
            </div>
          )}
        </div>
      </SettingsSection>
    </div>
  );
}
