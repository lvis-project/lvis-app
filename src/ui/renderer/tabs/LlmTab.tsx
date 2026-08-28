import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "../../../components/ui/badge.js";
import { Button } from "../../../components/ui/button.js";
import { Input } from "../../../components/ui/input.js";
import { Label } from "../../../components/ui/label.js";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectLabel,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../components/ui/select.js";
import { Slider } from "../../../components/ui/slider.js";
import { Switch } from "../../../components/ui/switch.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip.js";
import { ChevronDown, ChevronRight, ChevronUp, Loader2, Pin, Plus, RefreshCw, Store } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../../components/ui/dropdown-menu.js";
import {
  REASONING_EFFORT_STEPS,
  VENDORS,
  budgetToEffortIndex,
  getVendorOption,
  visibleVendorsFor,
  type VendorOption,
} from "../constants.js";
import {
  canUseLlmVendorWithoutApiKey,
  isLLMVendor,
  isOpenAICompatiblePresetVendor,
  isOpenAICompatibleVendor,
  isRetiredLlmModel,
  isSelfHostedTrustedNetworkVendor,
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
  modelDiscoveryPolicyUsesSeededOptions,
  type MarketplaceInstalledProviderPreset,
  type MarketplaceProviderModelDiscoveryPolicy,
} from "../../../shared/marketplace-package-assets.js";
import { isIpcErrorResult, type LvisApi } from "../types.js";
import { SettingsHelpPopover, SettingsPageHeader, SettingsSection } from "../components/PageShell.js";
import { PricingOverridesSection } from "./PricingOverridesSection.js";
import { useTranslation, type I18nContextValue } from "../../../i18n/react.js";
import {
  API_PATH_RUNTIME_CAPABILITIES,
  DEFAULT_SUBSCRIPTION_RUNTIME_CAPABILITIES,
  SUBSCRIPTION_RUNTIME_API_COUNTERPART,
  type SubscriptionRuntimeId,
} from "../../../shared/subscription-runtime.js";
import { useSubscriptionProviders } from "./SubscriptionProvidersController.js";
import {
  ERROR_MESSAGE_KEYS,
  ProviderCapabilityGrid,
  SubscriptionProviderRow,
  type SubscriptionProviderView,
} from "./SubscriptionProvidersSection.js";

export interface FallbackEntry {
  provider: string;
  model: string;
}





const MODEL_LIST_SYNC_DEBOUNCE_MS = 350;

/** The credential form's element id. One form is open at a time, so the button
 *  that reveals it can name it in `aria-controls`. */
const CREDENTIAL_FORM_ID = "llm-provider-credential-form";

/**
 * Catalog-specific bounds for the provider/model popups.
 *
 * Anchoring and width now come from `SelectContent` itself. What is still local
 * is the SIZE OF THIS LIST: a provider catalog is long ids plus a
 * provider/context/price detail line, so `min-w-64` keeps a narrow trigger's
 * popup readable and the height is capped at whichever is smaller — a list a
 * person can scan, or the room Radix reports.
 */
const SELECT_POPUP_LAYOUT =
  "min-w-64 max-h-[min(386px,var(--radix-select-content-available-height))]";

type ModelListState =
  | {
      /**
       * Not attempted, and here is why: this provider's endpoint is fixed and
       * its /models call is credentialed, so with nothing stored the request
       * could only come back 401. Reporting that as an error would paint a
       * healthy card red for a state that is not a failure.
       */
      status: "needs-credential";
      options?: string[];
      entries?: LlmModelListEntry[];
      endpoint?: string;
      fetchedAt?: string;
      source?: "cache" | "network";
    }
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
        className={SELECT_POPUP_LAYOUT}
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
  /** Moves vendor and model together when the pick belongs to another vendor. */
  selectApiVendorModel: (vendorId: string, modelId: string) => void;
  enableThinking: boolean;
  setEnableThinking: (v: boolean) => void;
  thinkingBudget: number;
  setThinkingBudget: (v: number) => void;
  fallbackChain: FallbackEntry[];
  setFallbackChain: (updater: FallbackEntry[] | ((c: FallbackEntry[]) => FallbackEntry[])) => void;
  fallbackOpen: boolean;
  setFallbackOpen: (updater: boolean | ((o: boolean) => boolean)) => void;
  onSaved: () => void;
  /**
   * Called after the user changes an immediate-apply control (the model
   * chooser / vendor / thinking toggle / reasoning slider). The dialog
   * debounces these and persists via `s.save("llm")` so the user gets
   * immediate-feel application without spamming saves.
   */
  onImmediateChange?: () => void;
  /**
   * Section-anchored explicit save handler, for the TYPED fields — an API
   * key, a base URL — where a keystroke is not yet a decision. A pick from
   * a chooser is, and goes through `onImmediateChange` instead. Both the
   * 공급자 구성 and Fallback Chain sections render their own Save button
   * that calls this — the orchestration save() persists the whole `llm`
   * payload, so the two buttons are functionally identical and the visual
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
  dirty = true,
  testId,
}: {
  onSave: () => void;
  saving: boolean;
  settingsLoaded: boolean;
  /** Omitted where the section has no dirty signal to offer, in which case
   *  Save stays available. */
  dirty?: boolean;
  testId: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex justify-end border-t border-border/(--opacity-medium) pt-2">
      <Button
        size="sm"
        onClick={onSave}
        disabled={saving || !settingsLoaded || !dirty}
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
    <span data-testid="llm-tab:immediate-badge" className="inline-flex h-5 shrink-0 items-center whitespace-nowrap rounded-full border border-transparent bg-secondary px-2.5 text-xs font-semibold text-secondary-foreground">
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

/**
 * Vendors whose model-list endpoint is fixed and known, so their catalogue is
 * always fetchable without the user supplying a base URL.
 *
 * This is the renderer's half of `STANDARD_MODEL_LIST_BASE_URLS` in
 * `engine/llm/model-list.ts`: main resolves the URL, this decides that asking
 * is worthwhile. Kept as one set so the two questions the tab asks about these
 * vendors — "sync it?" and "may a static seed stand in?" — cannot disagree.
 */
const STANDARD_CATALOGUE_ENDPOINT_VENDORS: ReadonlySet<string> = new Set([
  "openai",
  "copilot",
]);

function shouldSyncModelList(
  vendorId: string,
  info: ProviderOption | VendorOption,
  baseUrl?: string,
  modelDiscoveryPolicy?: MarketplaceProviderModelDiscoveryPolicy,
): boolean {
  if (!vendorId) return false;
  if (modelDiscoveryPolicyUsesSeededOptions(modelDiscoveryPolicy)) return false;
  if (baseUrl?.trim()) return true;
  if (STANDARD_CATALOGUE_ENDPOINT_VENDORS.has(vendorId)) return true;
  if (!info.needsBaseUrl) return false;
  return vendorId !== "openai-compatible" && vendorId !== "azure-foundry";
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

/**
 * Whether this vendor's catalogue is the endpoint's word rather than ours.
 *
 * Two kinds qualify: the openai-compatible family, whose catalogue is defined
 * by whatever endpoint it points at, and the vendors with a fixed, known
 * `/models` endpoint. For both, a bundled list of model ids is a guess about
 * someone else's inventory, so it must never stand in for the answer — a
 * failed handshake has to READ as a failed handshake, not as a short catalogue.
 */
function usesEndpointModelCatalogue(vendorId: string): boolean {
  return isOpenAICompatibleFamilyVendor(vendorId)
    || STANDARD_CATALOGUE_ENDPOINT_VENDORS.has(vendorId);
}

/**
 * Whether the endpoint is the user's to supply.
 *
 * A vendor whose endpoint is fixed has nothing to ask for here, and an empty
 * optional field beside a fixed endpoint reads as a setting that still needs
 * filling in. A commercial preset vendor ships the one address it serves from
 * in `LLM_VENDOR_DEFAULTS`, and a marketplace preset carries its own, so both
 * are already answered.
 *
 * The self-hosted class is the exception, and it is not ours to guess: the
 * seeded localhost port is a starting point, not the address — the same
 * installation reason that makes these endpoints a user-owned trust boundary
 * (`isSelfHostedTrustedNetworkVendor`, the SOT this reads) makes the ADDRESS
 * the user's too. Azure joins them, its resource host differing per account.
 */
function endpointIsUserSupplied(
  vendorId: string,
  info: ProviderOption | VendorOption,
  lockedToMarketplacePreset: boolean,
): boolean {
  if (lockedToMarketplacePreset) return false;
  if (!info.needsBaseUrl) return false;
  if (isLLMVendor(vendorId) && isSelfHostedTrustedNetworkVendor(vendorId)) return true;
  return !isOpenAICompatiblePresetVendor(vendorId);
}

function modelOptionsFor(
  vendorId: string,
  selectedModel: string,
  syncedOptions?: readonly string[],
  info: ProviderOption | VendorOption = getVendorInfo(vendorId),
  modelDiscoveryPolicy?: MarketplaceProviderModelDiscoveryPolicy,
): string[] {
  const hasSynced = Boolean(syncedOptions && syncedOptions.length > 0);
  // Handshake-only: for every provider whose catalogue is the endpoint's word
  // (see `usesEndpointModelCatalogue`) and whose discovery policy is not seeded
  // (static/manual), never fall back to the static `info.modelOptions` seed or
  // the seeded default model. The list stays empty until a live /models fetch
  // succeeds; only the user's persisted selection is surfaced so an
  // already-configured provider still shows its saved model.
  const handshakeOnly =
    !hasSynced &&
    usesEndpointModelCatalogue(vendorId) &&
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

/**
 * The saved model, when the endpoint's catalogue no longer lists it.
 *
 * `modelOptionsFor` keeps the saved id in the chooser so a configured provider
 * never shows a blank selection — but that also lets a model the server has
 * since dropped sit at the top of the list looking exactly like one it still
 * serves, while every request to it is rejected. This names that case so the
 * chooser and the status line can say it. Only a catalogue that actually
 * landed counts: with nothing synced yet there is nothing to disagree with.
 */
export function unlistedSavedModel(
  selectedModel: string,
  catalogue: readonly string[] | undefined,
): string | null {
  const model = selectedModel.trim();
  if (!model || !catalogue || catalogue.length === 0) return null;
  return catalogue.includes(model) ? null : model;
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

/**
 * One model row, on ONE line: who serves it, then what it is.
 *
 * It used to stack the id over a muted detail line, which made the trigger two
 * rows tall for a control that shows a single choice, and made the popup's rows
 * scan as pairs rather than as a list. The provider leads because that is how
 * the choice is actually made — a person picks a provider's catalogue first and
 * a model inside it second — and it is the short, repeating half, so it forms a
 * readable left column while the ids ellipsize beside it.
 *
 * The free-route disclaimer is prose and cannot share the line. The FREE badge
 * carries the signal; the sentence rides on the row's `title`, where it is one
 * hover away instead of one line tall on every row.
 */
function ModelSelectItemContent({
  option,
  entry,
  providerOverride,
  factsOverride,
  tone,
}: {
  option: string;
  entry?: LlmModelListEntry;
  /** Leading column when there is no catalogue entry to read a provider from —
   *  a subscription model has a provider but no `LlmModelListEntry`. */
  providerOverride?: string;
  /** Trailing facts for the same case. */
  factsOverride?: string;
  /** The facts carry a problem, not a number — a saved model the endpoint dropped. */
  tone?: "destructive";
}) {
  const { t } = useTranslation();
  const isFree = entry?.tags?.free === true || isOpenRouterFreeModel(option);
  const isRouter = entry?.tags?.router === true;
  const isLocal = entry?.tags?.local === true;
  const provider = entry?.provider ?? entry?.ownedBy ?? providerOverride;
  // Provider is the leading column now, so it is NOT repeated in the trailing
  // facts — those are the numbers that differ between models.
  const facts = factsOverride ? [factsOverride] : [
    entry?.contextLength !== undefined
      ? t("llmTab.modelContextTokens", { count: compactNumber(entry.contextLength) })
      : undefined,
    modelEntryPricingLabel(entry) ?? undefined,
  ].filter((part): part is string => Boolean(part));
  return (
    <span
      className="flex w-full min-w-0 items-center gap-2"
      data-model-id={option}
      {...(isFree ? { title: t("llmTab.openRouterFreeDisclaimer") } : {})}
    >
      {provider && (
        <span
          className="max-w-[9rem] shrink-0 truncate text-muted-foreground"
          data-testid={`llm-tab:model-provider:${option}`}
        >
          {provider}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate">{option}</span>
      {isFree && (
        <Badge variant="secondary" className="h-4 shrink-0 px-1 text-[9px] uppercase">
          {t("llmTab.openRouterFreeBadge")}
        </Badge>
      )}
      {isRouter && (
        <Badge variant="outline" className="h-4 shrink-0 px-1 text-[9px] uppercase">
          {t("llmTab.modelRouterBadge")}
        </Badge>
      )}
      {isLocal && (
        <Badge variant="outline" className="h-4 shrink-0 px-1 text-[9px] uppercase">
          {t("llmTab.modelLocalBadge")}
        </Badge>
      )}
      {facts.length > 0 && (
        <span
          className={`shrink-0 text-[10px] ${tone === "destructive" ? "text-destructive" : "text-muted-foreground"}`}
          data-testid={`llm-tab:model-facts:${option}`}
        >
          {facts.join(" · ")}
        </span>
      )}
    </span>
  );
}

/**
 * One choosable model, wherever it comes from.
 *
 * The API vendor's catalogue and every connected subscription's models are the
 * same kind of choice — "who answers, with what" — and the user makes exactly
 * one of them. Keeping them in two lists made the screen say otherwise.
 */
interface UnifiedModelOption {
  /** `providerId::modelId`. The Select's value, so a model id repeated by two
   *  providers still resolves to the right one. */
  value: string;
  providerId: string;
  providerLabel: string;
  modelId: string;
  /** Short vendor word shown as the row's leading column. */
  vendorTag: string;
  entry?: LlmModelListEntry;
  /** Subscription-side facts, where there is no catalogue entry to read them from. */
  facts?: string;
  /** The provider exposes no model choice — this row IS the provider. */
  fixed?: boolean;
  /** Saved, but no longer in the endpoint's catalogue — see `unlistedSavedModel`. */
  unlisted?: boolean;
}

/** Marks the API-key provider inside a unified option value. */
/**
 * One provider, however it is reached.
 *
 * A provider with both halves is ONE row: the same company, two ways in. The
 * settings list must not make a user learn that "OpenAI" and "Codex" are the
 * same account seen from two angles.
 */
interface ProviderConnection {
  /** The subscription runtime id when paired, the marketplace preset's secret
   *  id when the row IS a preset, otherwise the API vendor id. */
  id: string;
  label: string;
  /** Present when this provider can be reached with an API key. */
  apiVendorId?: string;
  /** The marketplace preset this row is reached through, when there is one. */
  presetId?: string;
  /** The `modelLists` key whose handshake belongs to THIS row. Folding the
   *  keys onto the vendor made two presets share one set of facts, so one
   *  preset's failure was reported on the other's card. */
  modelListKey?: string;
  apiConfigured: boolean;
  subscription?: SubscriptionProviderView;
  connected: boolean;
}

/** One configured way in to an API vendor — see `configuredApiRoutes`. */
interface ConfiguredApiRoute {
  vendorId: string;
  presetId?: string;
  modelListKey: string;
}

function apiRouteRowId(route: ConfiguredApiRoute): string {
  return route.presetId ? marketplaceProviderPresetSecretId(route.presetId) : route.vendorId;
}

const API_PROVIDER_PREFIX = "api:";

function apiProviderId(vendorId: string): string {
  return `${API_PROVIDER_PREFIX}${vendorId}`;
}

function unifiedValue(providerId: string, modelId: string): string {
  return `${providerId}::${modelId}`;
}

function parseUnifiedValue(value: string): { providerId: string; modelId: string } | null {
  const at = value.indexOf("::");
  if (at <= 0) return null;
  return { providerId: value.slice(0, at), modelId: value.slice(at + 2) };
}

/**
 * The model chooser.
 *
 * Two rules make this list readable when a catalogue runs to hundreds of
 * entries. PINS come first, and they come first ACROSS providers — a pin exists
 * so a model someone reaches for daily is one glance away, and a per-provider
 * pin list would still make them find the provider first. Everything else is
 * grouped BY provider, because that is the other thing a person navigates by.
 *
 * A stored pin is never trusted: it is matched against what is actually
 * offered right now, so a model that left the catalogue, or one whose provider
 * is disconnected, simply does not appear. The stored id survives that, and the
 * pin comes back with the provider.
 */
function UnifiedModelSelect({
  options,
  value,
  onValueChange,
  pinned,
  onTogglePin,
  placeholder,
  popupClassName,
}: {
  options: readonly UnifiedModelOption[];
  value: string;
  onValueChange: (value: string) => void;
  pinned: readonly string[];
  onTogglePin: (modelId: string) => void;
  placeholder: string;
  popupClassName: string;
}) {
  const { t } = useTranslation();
  const pinnedSet = new Set(pinned);
  const pinnedOptions = options.filter((option) => pinnedSet.has(option.modelId));
  const restByProvider: Array<{ label: string; items: UnifiedModelOption[] }> = [];
  for (const option of options) {
    if (pinnedSet.has(option.modelId)) continue;
    const last = restByProvider[restByProvider.length - 1];
    if (last && last.label === option.providerLabel) last.items.push(option);
    else restByProvider.push({ label: option.providerLabel, items: [option] });
  }

  const row = (option: UnifiedModelOption) => {
    const isPinned = pinnedSet.has(option.modelId);
    return (
      <SelectItem
        key={option.value}
        value={option.value}
        leading={
          /* Outside ItemText so the pin stays in the row and never mirrors
             into the collapsed trigger. Radix commits a row on POINTERUP, so
             both pointer events stop here — pinning is not choosing. */
          <span
            role="button"
            tabIndex={-1}
            aria-label={isPinned ? t("llmTab.modelUnpin") : t("llmTab.modelPin")}
            aria-pressed={isPinned}
            data-testid={`llm-tab:model-pin:${option.value}`}
            className={[
              "inline-flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded",
              "hover:bg-accent",
              isPinned ? "text-primary" : "text-muted-foreground/(--opacity-strong)",
            ].join(" ")}
            onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); }}
            onPointerUp={(event) => { event.preventDefault(); event.stopPropagation(); }}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onTogglePin(option.modelId);
            }}
          >
            <Pin className={`h-3 w-3 ${isPinned ? "fill-current" : ""}`} aria-hidden={true} />
          </span>
        }
      >
        <ModelSelectItemContent
          option={option.modelId}
          {...(option.entry ? { entry: option.entry } : {})}
          {...(option.entry ? {} : { providerOverride: option.vendorTag })}
          {...(option.facts ? { factsOverride: option.facts } : {})}
          {...(option.unlisted ? { tone: "destructive" as const } : {})}
        />
      </SelectItem>
    );
  };

  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger id="model-select" className="w-full" data-testid="llm-model-select">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent className={popupClassName}>
        {pinnedOptions.length > 0 && (
          <SelectGroup>
            <SelectLabel className="text-[10px] uppercase tracking-normal text-muted-foreground">
              {t("llmTab.modelPinnedGroup")}
            </SelectLabel>
            {pinnedOptions.map(row)}
          </SelectGroup>
        )}
        {restByProvider.map((group) => (
          <SelectGroup key={group.label}>
            <SelectLabel className="text-[10px] uppercase tracking-normal text-muted-foreground">
              {group.label}
            </SelectLabel>
            {group.items.map(row)}
          </SelectGroup>
        ))}
        {options.length === 0 && (
          <div className="px-2 py-3 text-center text-xs text-muted-foreground" data-testid="llm-tab:model-none">
            {t("llmTab.modelNoConnectedProvider")}
          </div>
        )}
      </SelectContent>
    </Select>
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

/**
 * What the last handshake did, in one phrase.
 *
 * The row's subline and the chooser's status line read it from here so the two
 * can never disagree. It separates a failure that left a previously synced
 * catalogue standing from one that left nothing — the first is still a usable
 * list and the second is not, and a single message claiming saved options
 * would be wrong in one of the two cases whichever way it was worded.
 */
function modelSyncLabel(t: I18nContextValue["t"], state: ModelListState): string {
  switch (state.status) {
    case "needs-credential":
      return t("llmTab.modelSyncNeedsApiKey");
    case "loading":
      return t("llmTab.modelSyncing");
    case "error":
      return hasUsableModelListOptions(state)
        ? t("llmTab.modelSyncFailedUsingCache")
        : t("llmTab.modelSyncFailed");
    case "ready":
      return t("llmTab.modelSynced", { count: state.options.length });
  }
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
    selectApiVendorModel,
    enableThinking,
    setEnableThinking,
    thinkingBudget,
    setThinkingBudget,
    fallbackChain,
    setFallbackChain,
    fallbackOpen,
    setFallbackOpen,
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
  /** What is actually stored for each vendor, mirrored so the typed fields can
   *  say whether they still hold something uncommitted. */
  const [savedVendorBlocks, setSavedVendorBlocks] = useState<
    Readonly<Record<string, { baseUrl?: string; vertexProject?: string; vertexLocation?: string }>>
  >({});
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
      // A fixed-endpoint vendor reaches its own /models with a stored key, so a
      // request with nothing stored could only come back 401 — and a red "sync
      // failed" on a card whose subscription is signed in and healthy says the
      // wrong thing. Asked here, on the edge of actually fetching, so a
      // catalogue that is already in hand still stands.
      if (!baseUrl && STANDARD_CATALOGUE_ENDPOINT_VENDORS.has(provider)) {
        const hasCredential = await api.hasApiKey(provider);
        if (!hasCredential) {
          setModelListState(key, { status: "needs-credential" });
          return;
        }
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
  // Only a synced catalogue can disqualify the saved model; a seeded vendor's
  // curated line is not the server's word on what it serves.
  const unlistedModel = unlistedSavedModel(
    activeModelValue,
    activeSyncedModelOptions,
  );
  // Subscription providers live beside the API vendor in ONE chooser, so this
  // tab owns both halves of the state rather than handing one down.
  const subscription = useSubscriptionProviders(api);
  // Mirrored from settings rather than held locally: another window may pin a
  // model too, and the chooser must show one truth.
  const [pinnedModels, setPinnedModels] = useState<readonly string[]>([]);

  const unifiedOptions = useMemo<UnifiedModelOption[]>(() => {
    const options: UnifiedModelOption[] = [];
    // `modelOptionsFor` is the single authority on what an API vendor can
    // offer: a curated line for a first-party vendor, and nothing at all for
    // an endpoint-defined openai-compatible provider until its /models
    // handshake lands. Do not add a second key-based gate on top — two
    // policies answering the same question is how a vendor ends up with an
    // empty chooser while its catalogue is right there.
    const pushed = new Set<string>();
    const pushApiOption = (
      vendorId: string,
      modelId: string,
      entry: LlmModelListEntry | undefined,
    ) => {
      const value = unifiedValue(apiProviderId(vendorId), modelId);
      if (pushed.has(value)) return;
      pushed.add(value);
      options.push({
        value,
        providerId: apiProviderId(vendorId),
        providerLabel: getVendorInfo(vendorId).label,
        modelId,
        vendorTag: entry?.provider ?? entry?.ownedBy ?? vendorId,
        ...(entry ? { entry } : {}),
      });
    };
    // The vendor the configuration form points at goes first: it is the only
    // one whose curated seed list and current selection are known here.
    for (const modelId of activeModelOptions) {
      pushApiOption(vendor, modelId, activeModelEntryById.get(modelId));
      if (modelId === unlistedModel) {
        const last = options[options.length - 1]!;
        options[options.length - 1] = { ...last, unlisted: true, facts: t("llmTab.modelUnlisted") };
      }
    }
    // Then every OTHER vendor whose /models handshake already landed. Without
    // this, switching the form's vendor emptied the chooser of every vendor
    // the user had configured — the catalogue was cached, just never offered.
    for (const [cacheKey, state] of Object.entries(modelLists)) {
      const cachedVendor = cacheKey.split("\n")[0];
      if (!cachedVendor || cachedVendor === vendor) continue;
      const entries = modelEntryMap(state.entries);
      for (const modelId of state.options ?? []) {
        pushApiOption(cachedVendor, modelId, entries.get(modelId));
      }
    }
    for (const view of subscription.providers) {
      // Connected only. A signed-out provider has nothing to offer yet, and
      // listing its models would invite a choice that cannot be honoured.
      if (view.status?.connection !== "connected") continue;
      const models = view.status.models ?? [];
      if (models.length === 0) {
        // No model choice at all — the row IS the provider. It still belongs in
        // the list, because picking it is exactly as much of a choice as
        // picking a model from a provider that has several.
        options.push({
          value: unifiedValue(view.descriptor.id, ""),
          providerId: view.descriptor.id,
          providerLabel: view.descriptor.label,
          modelId: t("llmTab.providerDefaultModel"),
          vendorTag: view.descriptor.id,
          facts: t("llmTab.modelFixedByProvider"),
          fixed: true,
        });
        continue;
      }
      for (const model of models) {
        options.push({
          value: unifiedValue(view.descriptor.id, model.id),
          providerId: view.descriptor.id,
          providerLabel: view.descriptor.label,
          modelId: model.label || model.id,
          vendorTag: view.descriptor.id,
        });
      }
    }
    return options;
  }, [
    vendor, activeModelOptions, activeModelEntryById, modelLists,
    subscription.providers, t, unlistedModel,
  ]);

  const selectedUnifiedValue = subscription.activeRuntime.kind === "subscription"
    ? unifiedValue(subscription.activeRuntime.provider, subscription.activeRuntime.model ?? "")
    : unifiedValue(apiProviderId(vendor), activeModelValue);

  const handleUnifiedModelChange = useCallback((value: string) => {
    const parsed = parseUnifiedValue(value);
    if (!parsed) return;
    if (parsed.providerId.startsWith(API_PROVIDER_PREFIX)) {
      const pickedVendor = parsed.providerId.slice(API_PROVIDER_PREFIX.length);
      if (pickedVendor === vendor) setModel(parsed.modelId);
      else selectApiVendorModel(pickedVendor, parsed.modelId);
      // A pick is the decision. It persists the way the vendor row and the
      // thinking controls do — through the debounced save — rather than
      // waiting on the section's Save button, which exists for the typed
      // fields (a key, a base URL) where a keystroke is not yet a decision.
      onImmediateChange?.();
      // Only switch the runtime when it is not already the API path. Calling
      // it unconditionally rewrites settings on every pick, and that broadcast
      // is what used to snap the chosen model back to the persisted one.
      if (subscription.activeRuntime.kind !== "api") {
        void subscription.props.actions.useApiForChat?.();
      }
      return;
    }
    void subscription.props.actions.useForChat?.(
      parsed.providerId as SubscriptionRuntimeId,
      parsed.modelId === "" ? null : parsed.modelId,
    );
  }, [
    onImmediateChange, selectApiVendorModel, setModel, vendor,
    subscription.activeRuntime.kind, subscription.props.actions,
  ]);

  const handleTogglePin = useCallback((modelId: string) => {
    const next = pinnedModels.includes(modelId)
      ? pinnedModels.filter((id: string) => id !== modelId)
      : [...pinnedModels, modelId];
    setPinnedModels(next);
    void api.updateSettings({ llm: { pinnedModels: next } });
  }, [api, pinnedModels]);

  const [providerConfigOpen, setProviderConfigOpen] = useState(false);
  const [addedRowIds, setAddedRowIds] = useState<readonly string[]>([]);
  /** The row a click just revealed, until it has been scrolled to and focused. */
  const [rowToReveal, setRowToReveal] = useState<string | null>(null);
  const connectionsRef = useRef<HTMLDivElement | null>(null);
  // A vendor with no usable credential has not answered the checklist yet.
  const apiPathConfigured = hasKey || !activeProviderRequiresApiKey;

  const marketplaceProviderPresetOptions = useMemo(
    () => providerOptionsForPresets(marketplaceProviderPresets),
    [marketplaceProviderPresets],
  );

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    const applySettings = (settings: Awaited<ReturnType<LvisApi["getSettings"]>>) => {
      const ids = settings.marketplace?.installedProviderIds;
      setMarketplaceProviderIds(Array.isArray(ids) ? ids : []);
      setSavedVendorBlocks(settings.llm?.vendors ?? {});
      setPinnedModels(settings.llm?.pinnedModels ?? []);
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
    // The credential gates the handshake, so storing one has to retry it.
    hasKey,
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

  // A provider that arrived from the marketplace says so on its row. The badge
  // used to hang off the vendor dropdown; the dropdown is gone, but where a
  // provider CAME FROM is still something the user needs to be able to see.
  const marketplaceVendorIds = useMemo(
    () => new Set<string>([
      ...marketplaceProviderIds,
      ...marketplaceProviderPresets.map((preset) =>
        marketplaceProviderPresetSecretId(preset.providerId)),
    ]),
    [marketplaceProviderIds, marketplaceProviderPresets],
  );
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
  // ─── Connections ────────────────────────────────────────────────────────
  // ONE list. A provider a user recognises as one company is one row, whether
  // it is reached with an API key, by signing in to its subscription runtime,
  // or both — `SUBSCRIPTION_RUNTIME_API_COUNTERPART` is the join that says
  // which pairs are the same company.
  /**
   * One configured API route: a vendor, plus the marketplace preset it is
   * reached THROUGH when there is one, plus the `modelLists` key whose
   * handshake belongs to it. Two presets are two routes through the same
   * `openai-compatible` vendor, so a route — not a vendor id — is what a row
   * is built from, and what its facts are looked up by.
   */
  const configuredApiRoutes = useMemo<readonly ConfiguredApiRoute[]>(() => {
    const routes = new Map<string, ConfiguredApiRoute>();
    const add = (route: ConfiguredApiRoute) => {
      const rowId = apiRouteRowId(route);
      if (!routes.has(rowId)) routes.set(rowId, route);
    };
    // The route the form points at goes first: its credential is known here
    // directly, so a key that was just entered counts before any fetch lands,
    // and its key is the current configuration rather than a stale cache entry.
    if (apiPathConfigured) {
      add({
        vendorId: vendor,
        ...(marketplaceProviderPresetId ? { presetId: marketplaceProviderPresetId } : {}),
        modelListKey: activeModelListKey,
      });
    }
    for (const [cacheKey, state] of Object.entries(modelLists)) {
      // A handshake that only STARTED is not evidence of configuration. A bare
      // `loading` key used to be enough to draw a "connected" row for a
      // provider with nothing stored; only a catalogue that actually landed
      // counts, and a later failure does not un-configure what already did.
      if (state.status !== "ready" && !hasUsableModelListOptions(state)) continue;
      const [cachedVendor, , scope] = cacheKey.split("\n");
      if (!cachedVendor) continue;
      add({ vendorId: cachedVendor, ...(scope ? { presetId: scope } : {}), modelListKey: cacheKey });
    }
    return [...routes.values()];
  }, [modelLists, apiPathConfigured, vendor, marketplaceProviderPresetId, activeModelListKey]);

  const configuredRowIds = useMemo(
    () => new Set(configuredApiRoutes.map(apiRouteRowId)),
    [configuredApiRoutes],
  );

  const installedPresetById = useMemo(
    () => new Map(marketplaceProviderPresets.map((preset) => [preset.providerId, preset])),
    [marketplaceProviderPresets],
  );

  /**
   * Whether the typed fields still hold something the store has not been told.
   *
   * Compared against the mirrored settings rather than a snapshot taken when
   * the card opened: a save clears `keyInput` and rewrites the block, and the
   * broadcast that follows is what makes this go quiet again.
   */
  const credentialDirty = useMemo(() => {
    if (keyInput.trim()) return true;
    const saved = savedVendorBlocks[vendor];
    if (endpointIsUserSupplied(vendor, vendorInfo, endpointLockedToMarketplacePreset)
      && baseUrl.trim() !== (saved?.baseUrl ?? "").trim()) {
      return true;
    }
    if (vendor !== "vertex-ai") return false;
    return vertexProject.trim() !== (saved?.vertexProject ?? "").trim()
      || vertexLocation.trim() !== (saved?.vertexLocation ?? "").trim();
  }, [
    keyInput, savedVendorBlocks, vendor, vendorInfo, endpointLockedToMarketplacePreset,
    baseUrl, vertexProject, vertexLocation,
  ]);

  /** The row the credential form currently belongs to. */
  const activeFormRowId = marketplaceProviderPresetId
    ? marketplaceProviderPresetSecretId(marketplaceProviderPresetId)
    : vendor;

  // Rows that must stay on screen although nothing is connected on them yet:
  // the ones the user added, plus whichever provider holds uncommitted input.
  // That draft lives in the parent and outlives this component, so the row that
  // owns it is DERIVED from the draft — otherwise a tab switch takes the card
  // away while the half-typed key it belongs to is still there.
  const pinnedRowIds = useMemo<readonly string[]>(
    () => (credentialDirty && activeFormRowId && !addedRowIds.includes(activeFormRowId)
      ? [...addedRowIds, activeFormRowId]
      : addedRowIds),
    [addedRowIds, credentialDirty, activeFormRowId],
  );

  const connections = useMemo<ProviderConnection[]>(() => {
    const claimed = new Set<string>();
    const rows: ProviderConnection[] = [];
    const routeLabel = (route: ConfiguredApiRoute): string => {
      const preset = route.presetId ? installedPresetById.get(route.presetId) : undefined;
      return preset ? providerOptionFromPreset(preset).label : getVendorInfo(route.vendorId).label;
    };
    for (const view of subscription.providers) {
      const counterpart = SUBSCRIPTION_RUNTIME_API_COUNTERPART[view.descriptor.id];
      if (counterpart) claimed.add(counterpart);
      const route = counterpart
        ? configuredApiRoutes.find((candidate) =>
          !candidate.presetId && candidate.vendorId === counterpart)
        : undefined;
      rows.push({
        id: view.descriptor.id,
        // The company's name, not the runtime's: "OpenAI", not "Codex".
        label: counterpart ? getVendorInfo(counterpart).label : view.descriptor.label,
        ...(counterpart ? { apiVendorId: counterpart } : {}),
        ...(counterpart
          ? { modelListKey: route?.modelListKey ?? llmModelListCacheKey(counterpart, "", "") }
          : {}),
        apiConfigured: Boolean(route),
        subscription: view,
        connected: view.status?.connection === "connected" || Boolean(route),
      });
    }
    for (const route of configuredApiRoutes) {
      if (!route.presetId && claimed.has(route.vendorId)) continue;
      rows.push({
        id: apiRouteRowId(route),
        label: routeLabel(route),
        apiVendorId: route.vendorId,
        ...(route.presetId ? { presetId: route.presetId } : {}),
        modelListKey: route.modelListKey,
        apiConfigured: true,
        connected: true,
      });
    }
    // A provider picked from "add a provider" has no row yet — it is neither a
    // subscription runtime nor configured — and its credential form lives ON a
    // row, so without this the provider a user just chose does not appear at
    // all. `providerSelectOptions` is the only source that knows the label for
    // both a built-in vendor and a marketplace preset.
    for (const rowId of pinnedRowIds) {
      if (rows.some((row) => row.id === rowId || row.apiVendorId === rowId)) continue;
      const option = providerSelectOptions.find((candidate) => candidate.id === rowId);
      if (!option) continue;
      const preset = marketplaceProviderPresets.find(
        (entry) => marketplaceProviderPresetSecretId(entry.providerId) === rowId,
      );
      rows.push({
        id: rowId,
        label: option.label,
        // A preset is REACHED through the openai-compatible vendor but is not
        // that vendor: the row keeps its own identity so two presets are two
        // cards, and so the generic custom provider is still addable beside it.
        apiVendorId: preset ? "openai-compatible" : rowId,
        ...(preset ? { presetId: preset.providerId } : {}),
        modelListKey: preset
          ? llmModelListCacheKey("openai-compatible", preset.baseUrl, preset.providerId)
          : llmModelListCacheKey(rowId, "", ""),
        apiConfigured: false,
        connected: false,
      });
    }
    return rows;
  }, [
    subscription.providers, configuredApiRoutes, pinnedRowIds, providerSelectOptions,
    marketplaceProviderPresets, installedPresetById,
  ]);

  // The order the user built the list in: everything already connected, then
  // each provider they added, in the order they added it. A newly added card
  // therefore lands at the END — directly above the button that created it —
  // instead of wherever the catalogue happens to sort it. A provider picked
  // from "add a provider" also has to STAY on screen while it is being set up:
  // signing in to a subscription runtime happens on its row, and a row that
  // vanishes because it is not connected yet takes the login button with it.
  const visibleRows = useMemo<ProviderConnection[]>(() => {
    const rows = connections.filter((row) => row.connected);
    const seen = new Set(rows.map((row) => row.id));
    for (const rowId of pinnedRowIds) {
      if (seen.has(rowId)) continue;
      const row = connections.find((candidate) => candidate.id === rowId);
      if (!row) continue;
      seen.add(rowId);
      rows.push(row);
    }
    return rows;
  }, [connections, pinnedRowIds]);
  const visibleRowKey = visibleRows.map((row) => row.id).join("\n");
  // Everything else goes behind "add a provider". The catalogue keeps growing
  // with marketplace presets, so the list's length has to track the number of
  // providers the user actually USES, not the number that exist.
  const addableRows = connections.filter(
    (row) => !row.connected && !pinnedRowIds.includes(row.id),
  );
  const addableVendors = useMemo(
    () => providerSelectOptions.filter((option) =>
      !configuredRowIds.has(option.id)
      && !pinnedRowIds.includes(option.id)
      // A preset row is matched by its OWN id; only a plain vendor row claims
      // the vendor option, or every preset would hide the generic provider.
      && !connections.some((row) =>
        row.id === option.id || (!row.presetId && row.apiVendorId === option.id))),
    [providerSelectOptions, configuredRowIds, connections, pinnedRowIds],
  );

  /** Whether the credential form currently belongs to this row. */
  const formTargetsRow = useCallback(
    (row: ProviderConnection): boolean =>
      Boolean(row.apiVendorId)
      && row.apiVendorId === vendor
      && (row.presetId ?? "") === marketplaceProviderPresetId,
    [vendor, marketplaceProviderPresetId],
  );

  /** What `handleVendorChange` has to be handed to point the form at this row. */
  const rowConfigTargetId = (row: ProviderConnection): string =>
    row.presetId ? marketplaceProviderPresetSecretId(row.presetId) : row.apiVendorId!;

  const revealRow = useCallback((rowId: string) => {
    setAddedRowIds((current) => current.includes(rowId) ? current : [...current, rowId]);
    setRowToReveal(rowId);
  }, []);

  const openApiConfig = useCallback((vendorId: string) => {
    if (vendorId !== vendor) handleVendorChange(vendorId);
    setProviderConfigOpen(true);
  }, [handleVendorChange, vendor]);

  // A row that was just revealed has to be findable: the list can already be
  // longer than the panel, and a card that appears below the fold reads as a
  // click that did nothing.
  useEffect(() => {
    if (!rowToReveal) return;
    const node = connectionsRef.current?.querySelector<HTMLElement>(
      `[data-provider-row="${rowToReveal}"]`,
    );
    if (!node) return;
    setRowToReveal(null);
    node.scrollIntoView?.({ block: "nearest" });
    const focusTarget = node.querySelector<HTMLElement>('[data-testid="llm-base-url-input"]')
      ?? node.querySelector<HTMLElement>('[data-testid="llm-api-key-input"]')
      ?? node.querySelector<HTMLElement>("button");
    focusTarget?.focus();
  }, [rowToReveal, visibleRowKey]);

  // The credential form for whichever provider row is open. One form, because
  // one vendor is being edited at a time — the row that owns it just moved.
  const credentialForm = (
      <div
        className="space-y-3"
        id={CREDENTIAL_FORM_ID}
        data-testid="llm-tab:manual-section"
      >
        {vendor !== "vertex-ai" && endpointIsUserSupplied(vendor, vendorInfo, endpointLockedToMarketplacePreset) && (
          <div className="space-y-2">
            <Label className="text-sm font-medium">
              {t("llmTab.endpointBaseUrlLabel")} *
            </Label>
            <Input
              data-testid="llm-base-url-input"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={vendorInfo.baseUrlPlaceholder ?? "https://..."}
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
            className="min-w-0 space-y-2"
            data-testid="llm-tab:api-key-section"
            data-api-key-required={activeProviderRequiresApiKey ? "true" : "false"}
          >
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <Label className="min-w-0 text-sm font-medium" data-testid="llm-tab:api-key-label">
              {vendorLabel ? `${vendorLabel} ` : ""}{t("llmTab.apiKey")}
              {!activeProviderRequiresApiKey ? ` (${t("llmTab.optional")})` : ""}
            </Label>
              {hasKey ? (
                <Badge variant="default" data-testid="llm-tab:api-key-status" className="h-5 shrink-0 whitespace-nowrap px-2.5 text-xs">{t("llmTab.apiKeySet")}</Badge>
              ) : (
                <Badge variant="secondary" data-testid="llm-tab:api-key-status" className="h-5 shrink-0 whitespace-nowrap px-2.5 text-xs">
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
        {/* Save belongs to the card whose fields it commits. A page-level
            button sat below every provider and the "add provider" control, so
            the one thing a half-filled new card needed was the one control
            furthest from it — and it read as committing the whole page. */}
        {hasOnSave && (
          <SectionSaveBar
            onSave={onSave!}
            saving={saving}
            settingsLoaded={settingsLoaded}
            dirty={credentialDirty}
            testId="llm-tab:save-providers"
          />
        )}
        </div>
  );

  // Which of this provider's two routes is serving chat right now. The user
  // asked for exactly this: the row says the provider, the badge says the mode.
  /** Which path this row is serving chat through right now, or null. */
  const activeMode = (row: ProviderConnection): "subscription" | "api" | null =>
    subscription.activeRuntime.kind === "subscription"
      ? (subscription.activeRuntime.provider === row.id ? "subscription" : null)
      : (formTargetsRow(row) ? "api" : null);

  const modeBadge = (row: ProviderConnection) => {
    const active = activeMode(row);
    if (!active) return null;
    return (
      <Badge variant="default" className="h-5 px-2 text-[10px]" data-testid={`llm-tab:connection-mode:${row.id}`}>
        {active === "subscription" ? t("llmTab.modeSubscription") : t("llmTab.modeApiKey")}
      </Badge>
    );
  };

  /**
   * The row's state, as one dot and one word.
   *
   * Every row carries it, including the ones that are merely connected — a row
   * that only speaks up when it is the active one leaves the rest of the list
   * saying nothing about itself, which is the state this list exists to show.
   */
  const statusChip = (row: ProviderConnection) => {
    const live = activeMode(row) !== null;
    const label = live
      ? t("subscriptionProvidersSection.apiChatActive")
      : row.connected
        ? t("subscriptionProvidersSection.statusConnected")
        : t("subscriptionProvidersSection.statusSignedOut");
    const tone = live
      ? "bg-primary"
      : row.connected
        ? "bg-success"
        : "bg-muted-foreground/(--opacity-half)";
    return (
      <span
        className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground"
        data-testid={`llm-tab:connection-status:${row.id}`}
      >
        <span className={`size-1.5 shrink-0 rounded-full ${tone}`} aria-hidden={true} />
        {label}
      </span>
    );
  };

  /**
   * What this connection is, in the row itself: the endpoint it reaches and how
   * much of a catalogue came back. Without it the row is a bare name, and the
   * user cannot tell two OpenAI-compatible endpoints apart.
   */
  const connectionSubline = (row: ProviderConnection) => {
    if (!row.apiVendorId || !row.modelListKey) return null;
    const state = modelLists[row.modelListKey];
    if (!state) return null;
    const endpoint = state.endpoint ?? row.modelListKey.split("\n")[1] ?? "";
    const syncLabel = modelSyncLabel(t, state);
    const parts = [endpoint, syncLabel].filter(Boolean);
    if (parts.length === 0) return null;
    return (
      <p
        className={`truncate text-[11px] ${state.status === "error" ? "text-destructive" : "text-muted-foreground"}`}
        title={parts.join(" · ")}
        data-provider-sync-status={state.status}
        data-testid={`llm-tab:connection-subline:${row.id}`}
      >
        {parts.join(" · ")}
      </p>
    );
  };

  /**
   * The API-key route, as a third way in beside the sign-in buttons.
   *
   * It sits with them because it IS one of them — the same decision, taken the
   * same way — and the key field itself stays folded away until this is pressed,
   * so a provider a user signs in to never shows a key box it does not need.
   */
  const apiKeyChip = (row: ProviderConnection) => {
    if (!row.apiVendorId) return null;
    const isOpen = providerConfigOpen && formTargetsRow(row);
    return (
      <Button
        type="button"
        size="sm"
        variant={isOpen ? "secondary" : "outline"}
        aria-expanded={isOpen}
        {...(isOpen ? { "aria-controls": CREDENTIAL_FORM_ID } : {})}
        onClick={() => {
          if (isOpen) {
            setProviderConfigOpen(false);
            return;
          }
          openApiConfig(rowConfigTargetId(row));
          // Revealing a form and leaving the caret outside it makes the button
          // look like it did nothing; the reveal effect moves focus in.
          setRowToReveal(row.id);
        }}
        data-testid={`llm-tab:connection-api-key:${row.id}`}
      >
        {t("llmTab.authApiKey")}
      </Button>
    );
  };

  /**
   * Says that a collapsed card is still holding input.
   *
   * Collapsing is allowed — trapping a card open is worse — but a card that
   * folds away with a half-typed key must not read as finished. The header is
   * the disclosure, so the marker sits on the control that reopens it and
   * brings Save back.
   */
  const unsavedBadge = (row: ProviderConnection) => {
    if (!credentialDirty || !formTargetsRow(row)) return null;
    if (providerConfigOpen) return null;
    return (
      <Badge
        variant="outline"
        className="h-5 shrink-0 whitespace-nowrap px-2 text-[10px]"
        data-testid={`llm-tab:connection-unsaved:${row.id}`}
      >
        {t("llmTab.unsavedChanges")}
      </Badge>
    );
  };

  const connectionsList = (
    <div className="space-y-3" data-testid="llm-tab:connections" ref={connectionsRef}>
      <p className="rounded-md border bg-muted/(--opacity-muted) px-3 py-2 text-xs text-muted-foreground">
        {t("subscriptionProvidersSection.securityNotice")}
      </p>
      {subscription.props.apiChatError ? (
        <p
          role="alert"
          className="rounded-md border border-destructive/(--opacity-medium) bg-destructive/(--opacity-subtle) px-3 py-2 text-xs text-destructive"
          data-testid="llm-tab:connections-error"
        >
          {t(ERROR_MESSAGE_KEYS[subscription.props.apiChatError])}
        </p>
      ) : null}
      {visibleRows.length === 0 ? (
        <p className="rounded-md border px-3 py-4 text-center text-xs text-muted-foreground" data-testid="llm-tab:connections-empty">
          {t("llmTab.connectionsEmpty")}
        </p>
      ) : null}
      {visibleRows.map((row) => row.subscription ? (
        <SubscriptionProviderRow
          key={row.id}
          provider={row.subscription}
          label={row.label}
          activeSelection={subscription.props.activeSelection}
          chatSelectionBusy={subscription.props.chatSelectionBusy ?? false}
          actions={subscription.props.actions}
          leading={<>{statusChip(row)}{modeBadge(row)}{unsavedBadge(row)}</>}
          subline={connectionSubline(row)}
          authAction={apiKeyChip(row)}
          {...(providerConfigOpen && formTargetsRow(row) ? { trailing: credentialForm } : {})}
        />
      ) : (
        <div
          key={row.id}
          className="space-y-3 rounded-md border bg-card p-3"
          data-provider-row={row.id}
          data-testid={`llm-tab:connection:${row.id}`}
        >
          {/* The whole head is the disclosure: the row IS the provider, so
              managing it should not require finding a particular control on it. */}
          <button
            type="button"
            className="flex w-full min-w-0 items-center gap-2 text-left"
            aria-expanded={providerConfigOpen && formTargetsRow(row)}
            {...(providerConfigOpen && formTargetsRow(row)
              ? { "aria-controls": CREDENTIAL_FORM_ID }
              : {})}
            onClick={() => {
              if (providerConfigOpen && formTargetsRow(row)) {
                setProviderConfigOpen(false);
                return;
              }
              openApiConfig(rowConfigTargetId(row));
              setRowToReveal(row.id);
            }}
            data-testid={`llm-tab:connection-toggle:${row.id}`}
          >
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="truncate text-sm font-medium">{row.label}</span>
                {modeBadge(row)}
                {unsavedBadge(row)}
                {row.apiVendorId && marketplaceVendorIds.has(row.apiVendorId) ? (
                  <span
                    className="inline-flex h-5 items-center rounded-full bg-secondary px-1.5 text-[10px] font-medium text-secondary-foreground"
                    data-testid={`llm-tab:selected-provider-marketplace:${row.apiVendorId}`}
                  >
                    {t("llmTab.marketplaceInstalledBadge")}
                  </span>
                ) : null}
              </span>
              {connectionSubline(row)}
            </span>
            {statusChip(row)}
            <ChevronRight
              className={`size-4 shrink-0 text-muted-foreground transition-transform ${
                providerConfigOpen && row.apiVendorId === vendor ? "rotate-90" : ""
              }`}
              aria-hidden={true}
            />
          </button>
          {providerConfigOpen && formTargetsRow(row) ? credentialForm : null}
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" size="sm" variant="outline" className="h-7 gap-1.5 text-xs" data-testid="llm-tab:add-provider">
              <Plus className="size-3.5" aria-hidden={true} />
              {t("llmTab.addProvider")}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-80 w-64 overflow-y-auto">
            {addableRows.map((row) => (
              <DropdownMenuItem
                key={row.id}
                data-testid={`llm-tab:add-provider-item:${row.id}`}
                onClick={() => {
                  revealRow(row.id);
                  if (row.apiVendorId) openApiConfig(rowConfigTargetId(row));
                }}
              >
                {row.label}
              </DropdownMenuItem>
            ))}
            {addableVendors.map((option) => (
              <DropdownMenuItem
                key={option.id}
                data-testid={`llm-tab:add-provider-item:${option.id}`}
                onClick={() => {
                  revealRow(option.id);
                  openApiConfig(option.id);
                }}
              >
                {option.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );

  return (
    <div className="min-w-0 space-y-6">
      <SettingsPageHeader
        title={t("llmTab.pageTitle")}
        description={t("llmTab.pageDescription")}
      />

      {/* Provider configuration — API keys and endpoint settings are edited
          directly here. */}
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
          data-settings-loaded={settingsLoaded ? "true" : "false"}
          data-testid="llm-tab:section-providers"
        >
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
            {/* ONE chooser across every connected provider. Picking a model
                is what selects the provider — there is no second "switch"
                control, because there was never a second choice to make. */}
            <UnifiedModelSelect
              options={unifiedOptions}
              value={selectedUnifiedValue}
              onValueChange={handleUnifiedModelChange}
              pinned={pinnedModels}
              onTogglePin={handleTogglePin}
              placeholder={vendorInfo.defaultModel}
              popupClassName={SELECT_POPUP_LAYOUT}
            />
            {unlistedModel && subscription.activeRuntime.kind === "api" && (
              <p
                role="alert"
                className="text-[11px] text-destructive"
                data-testid="llm-tab:model-unlisted"
              >
                {t("llmTab.modelUnlistedWarning", { model: unlistedModel })}
              </p>
            )}
            {activeModelList && (
              <p
                className="text-[11px] text-muted-foreground"
                data-provider-sync-status={activeModelList.status}
                data-testid="llm-tab:model-sync-status"
              >
                {activeModelList.status === "ready" && activeModelList.persistError
                  ? t("llmTab.modelSyncCacheSaveFailed")
                  : modelSyncLabel(t, activeModelList)}
              </p>
            )}
          </div>
          {/* The same checklist the subscription runtimes answer. A vendor
              that is not configured yet has answered nothing, so its row
              reads unknown rather than claiming the host's features. */}
          <ProviderCapabilityGrid
            capabilities={apiPathConfigured
              ? API_PATH_RUNTIME_CAPABILITIES
              : DEFAULT_SUBSCRIPTION_RUNTIME_CAPABILITIES}
            known={() => apiPathConfigured}
            testIdPrefix="llm-tab:api-provider"
          />
          {connectionsList}
        </div>
      </SettingsSection>

      {/* Section B — Extended Thinking / Reasoning */}
      <SettingsSection
        title={t("llmTab.thinkingTitle")}
        description={t("llmTab.thinkingDesc")}
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
          className="min-w-0"
          data-testid="llm-tab:section-thinking"
        >
          {enableThinking && (
            <div className="space-y-2">
              <div className="flex min-w-0 items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-1.5">
                  <Label className="text-xs text-muted-foreground">{t("llmTab.reasoningEffortLabel")}</Label>
                  <SettingsHelpPopover ariaLabel={t("llmTab.reasoningEffortLabel")}>
                    {t("llmTab.reasoningEffortDesc")}
                  </SettingsHelpPopover>
                </span>
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
            </div>
          )}
        </div>
      </SettingsSection>

      {/* Section C — Fallback Chain */}
      <SettingsSection
        title={t("llmTab.fallbackTitle")}
        description={t("llmTab.fallbackDesc")}
        id="llm-fallback"
        actions={
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label={t("llmTab.fallbackTitle")}
            aria-controls="fallback-chain-content"
            aria-expanded={fallbackOpen}
            onClick={() => setFallbackOpen((open) => !open)}
            data-testid="fallback-chain-toggle"
          >
            {fallbackOpen ? <ChevronUp className="size-4" aria-hidden="true" /> : <ChevronDown className="size-4" aria-hidden="true" />}
          </Button>
        }
      >
        <div
          className="min-w-0"
          data-testid="fallback-chain-section"
        >
          {fallbackOpen && (
            <div id="fallback-chain-content" className="min-w-0 space-y-3">
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
                  <div key={idx} className="flex min-w-0 flex-col gap-2 sm:flex-row">
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
                      triggerClassName="w-full text-xs sm:w-36"
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
                      <SelectContent className={SELECT_POPUP_LAYOUT}>
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
                      className="h-8 self-end text-xs text-destructive sm:self-auto"
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

      {/* Per-model price corrections — self-contained: it reads and writes the
          one settings key it owns, so it does not join this tab's prop chain. */}
      <PricingOverridesSection />
    </div>
  );
}
