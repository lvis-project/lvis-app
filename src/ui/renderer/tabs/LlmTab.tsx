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
  llmRouteModel,
  LLM_VENDOR_DEFAULTS,
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
  marketplaceProviderPresetIdFromSecretId,
  marketplaceProviderPresetSecretId,
  modelDiscoveryPolicyAllowsFetch,
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
import { TEST_IDS } from "../../../shared/test-ids.js";

export interface FallbackEntry {
  provider: string;
  model: string;
}

/**
 * The provider card whose credential form is open, and what has been typed
 * into it.
 *
 * Kept apart from the active provider on purpose: `LlmTabProps.vendor` is what
 * chat runs on, and opening a card must not move it. The draft therefore
 * carries its OWN vendor / preset — the row it belongs to — so the fields edit
 * that row's `llm.vendors` block and that row's secret whatever chat is using.
 *
 * It is held by the settings orchestration rather than by this tab because the
 * settings tabs unmount when the user leaves them, and a half-typed key has to
 * survive that.
 */
export interface ProviderCredentialDraft {
  /** The provider card this draft belongs to. */
  readonly rowId: string;
  /** The `llm.vendors` block the fields edit. */
  readonly vendorId: string;
  /** The marketplace preset the row is reached through, or "". */
  readonly presetId: string;
  readonly keyInput: string;
  readonly baseUrl: string;
  readonly vertexProject: string;
  readonly vertexLocation: string;
}

/** What one provider card commits — its own block and its own secret, no more. */
export interface ProviderCredentialSave {
  /** The id the secret is stored under: a preset's scoped id, or the vendor. */
  credentialProviderId: string;
  vendorId: string;
  /** Empty leaves the stored key alone. */
  apiKey: string;
  /**
   * Omitted where the row owns no persisted field — a vendor whose endpoint is
   * fixed, or a preset that carries its own. Writing a block for those would
   * overwrite an endpoint that belongs to another row.
   */
  vendorBlock?: {
    baseUrl?: string | undefined;
    vertexProject?: string | undefined;
    vertexLocation?: string | undefined;
  };
}





/**
 * Every field a model-list state carries besides the status itself.
 *
 * A `Record` of the whole union rather than a hand-kept array: adding a field
 * to any variant leaves a required property missing here and fails to compile,
 * where a list would have gone on comparing the old fields and reported an
 * updated state as unchanged — which is invisible, because an unchanged state
 * is deliberately not re-rendered.
 */
type ModelListStateField = ModelListState extends infer Variant
  ? Variant extends ModelListState ? Exclude<keyof Variant, "status"> : never
  : never;

const COMPARED_MODEL_LIST_FIELDS: Record<ModelListStateField, true> = {
  error: true,
  endpoint: true,
  fetchedAt: true,
  source: true,
  persistError: true,
  options: true,
  entries: true,
};

/** Whether two model-list states say the same thing about the same row. */
function sameModelListState(
  a: ModelListState | undefined,
  b: ModelListState,
): boolean {
  if (!a || a.status !== b.status) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  return Object.keys(COMPARED_MODEL_LIST_FIELDS)
    .every((field) => left[field] === right[field]);
}

/**
 * When a provider's model list is fetched — the whole policy, in one place.
 *
 * A model list is a catalogue, not live data: it changes on the provider's
 * release schedule, not between two clicks. So it is PERSISTED
 * (`llm.modelListCache`), every card and the chooser render straight from that
 * cache without waiting on anything, and a request goes out on exactly three
 * occasions:
 *
 *   1. the row has no catalogue under its current key — and a key is built
 *      from the vendor, the endpoint and the credential scope, so changing an
 *      endpoint or moving to another preset makes a new key and re-syncs once;
 *   2. once per app launch per key, so a catalogue that moved since the last
 *      session is picked up without the user having to ask;
 *   3. the user presses that row's refresh control.
 *
 * (1) and (2) are one test, not two: a key that has not been asked yet THIS
 * LAUNCH is asked, whether or not a cache entry already stands behind it.
 * Nothing else asks — not a settings broadcast, not a tab remount, not another
 * row's edit. Those were what turned one unreachable endpoint into a request
 * per settings write, and a card into a spinner on every visit.
 *
 * The marker lives in this module rather than in component state or in
 * settings, because those two lifetimes are both wrong: component state dies
 * when the settings tab unmounts, which must NOT re-ask, and a persisted
 * record would survive an app restart, which MUST. A renderer module lives
 * exactly as long as its window, which is the launch boundary this policy
 * means.
 */
const modelListRefreshedThisLaunch = new Set<string>();

/**
 * Cross that launch boundary deliberately.
 *
 * Nothing in the app calls this — a launch ends when the window goes — but a
 * test has to be able to say "and then the app started again", and a module
 * that keeps the marker private cannot be asked to forget it.
 */
export function forgetModelListLaunchRefreshes(): void {
  modelListRefreshedThisLaunch.clear();
}

/**
 * Forget one row's launch refresh.
 *
 * The key is built from vendor, endpoint and scope — not from the credential —
 * so storing a working key over a broken one changes nothing the key can see,
 * and the launch marker would hold the row on its old failure until the window
 * reloaded. A credential save IS a change to that row's inputs, so it earns the
 * row its one request again.
 */
function forgetModelListLaunchRefresh(key: string): void {
  modelListRefreshedThisLaunch.delete(key);
}

/**
 * Whether two vendor-block maps say the same thing about every row.
 *
 * Structural, not serialized: a block reaches this from two different writers
 * (the store's normalizer and a broadcast payload), and key ORDER between them
 * is not a promise anyone made — comparing serialized text would report a
 * reordered but identical block as news, which is exactly the churn this
 * exists to stop.
 */
function sameSavedVendorBlocks(
  a: Readonly<Record<string, unknown>>,
  b: Readonly<Record<string, unknown>>,
): boolean {
  return sameSettingsValue(a, b);
}

function sameSettingsValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => sameSettingsValue(item, b[index]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) =>
    Object.prototype.hasOwnProperty.call(right, key)
    && sameSettingsValue(left[key], right[key]));
}

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
/**
 * Why a row's API route cannot serve chat yet, by cause. Kept as a map so the
 * key strings stay greppable from the catalogue, the way `ERROR_MESSAGE_KEYS`
 * does for the subscription runtimes' failures.
 */
const CHAT_BLOCKER_MESSAGE_KEYS = {
  "needs-api-key": "llmTab.chatNeedsApiKey",
  "needs-gcp-project": "llmTab.chatNeedsGcpProject",
  "awaiting-catalogue": "llmTab.chatAwaitingCatalogue",
  "catalogue-empty": "llmTab.chatCatalogueEmpty",
  "catalogue-failed": "llmTab.chatCatalogueFailed",
} as const;

type ChatBlocker = keyof typeof CHAT_BLOCKER_MESSAGE_KEYS;

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
  /**
   * The provider chat runs on. Read-only here: a card is opened by this tab,
   * but WHICH provider serves chat moves only through the explicit switch,
   * `selectApiVendorModel`, or a subscription runtime's own action.
   */
  vendor: string;
  /** The active provider's endpoint — what its model-list handshake reaches. */
  baseUrl: string;
  /** Whether the ACTIVE provider has a stored key. Rows read their own. */
  hasKey: boolean;
  setHasKey: (v: boolean) => void;
  /** The card being edited, and what has been typed into it. */
  providerCredentialDraft?: ProviderCredentialDraft | null;
  onProviderCredentialDraftChange?: (next: ProviderCredentialDraft | null) => void;
  /** Commits one card: that row's vendor block and that row's secret only. */
  onSaveProviderCredential?: (input: ProviderCredentialSave) => Promise<boolean>;
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

/**
 * Whether this provider has a model list worth asking its endpoint for.
 *
 * The two contract questions come FIRST, before any address is considered:
 * may the host fetch this provider's list at all, and is that list the
 * endpoint's word rather than ours. An address is not a catalogue — Azure AI
 * Foundry's `baseUrl` names one deployment while its models are the curated
 * table here — so letting a configured endpoint short-circuit these made a
 * card fetch a list it does not read, and paint itself red when the fetch
 * failed. Only once both are answered does the address decide: a user-supplied
 * endpoint is asked, and so are the vendors whose `/models` is fixed and known.
 */
function shouldSyncModelList(
  vendorId: string,
  baseUrl?: string,
  modelDiscoveryPolicy?: MarketplaceProviderModelDiscoveryPolicy,
): boolean {
  if (!vendorId) return false;
  if (!modelDiscoveryPolicyAllowsFetch(modelDiscoveryPolicy)) return false;
  if (!usesEndpointModelCatalogue(vendorId)) return false;
  if (baseUrl?.trim()) return true;
  return STANDARD_CATALOGUE_ENDPOINT_VENDORS.has(vendorId);
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
      <SelectTrigger id="model-select" className="w-full" data-testid={TEST_IDS.llmModelSelect}>
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
    baseUrl,
    hasKey,
    setHasKey,
    providerCredentialDraft = null,
    onProviderCredentialDraftChange,
    onSaveProviderCredential,
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
  const activeModelListCredentialScope = selectedMarketplaceProviderPreset?.providerId ?? "";
  const hasOnSave = typeof onSave === "function";
  const trimmedModel = model.trim();
  const activeModelValue = trimmedModel && !isRetiredLlmModel(trimmedModel)
    ? trimmedModel
    : vendorInfo.defaultModel;
  const [marketplaceProviderIds, setMarketplaceProviderIds] = useState<readonly string[]>([]);
  /** What is actually stored for each vendor, mirrored so the typed fields can
   *  say whether they still hold something uncommitted. */
  const [savedVendorBlocks, setSavedVendorBlocks] = useState<
    Readonly<Record<string, {
      model?: string;
      presetModels?: Record<string, string>;
      baseUrl?: string;
      vertexProject?: string;
      vertexLocation?: string;
    }>>
  >({});
  /**
   * Which providers actually have a key in the store.
   *
   * A stored credential IS a configuration, whatever the endpoint has since
   * said back. Reading configuration off the handshake alone made a provider
   * whose key had gone stale vanish from the page — taking with it the only
   * place that key can be replaced or deleted.
   */
  const [credentialedProviderIds, setCredentialedProviderIds] = useState<ReadonlySet<string>>(
    new Set(),
  );
  /** The row whose credential was saved on this screen, if any. Saving never
   *  moves the chat route, so that row may need telling where the switch is. */
  const [credentialSavedRowId, setCredentialSavedRowId] = useState<string | null>(null);
  /**
   * The address this row's catalogue lives at, or "" when the row has none of
   * its own. Whether that address is ever ASKED is `shouldSyncModelList`'s
   * question, not this one — one decision, in one place.
   */
  const rowModelListBaseUrl = useCallback((
    vendorId: string,
    preset: MarketplaceInstalledProviderPreset | undefined,
  ): string => {
    if (preset) return preset.baseUrl.trim();
    const saved = savedVendorBlocks[vendorId]?.baseUrl?.trim();
    if (saved) return saved;
    // A preset vendor ships the one address it serves from; the generic custom
    // provider ships none until the user supplies one.
    return isLLMVendor(vendorId)
      ? LLM_VENDOR_DEFAULTS[vendorId].baseUrl?.trim() ?? ""
      : "";
  }, [savedVendorBlocks]);

  /** Bumped on every settings broadcast; `setApiKey`/`deleteApiKey` send one,
   *  so this is what re-asks the credential store. */
  const [settingsRevision, setSettingsRevision] = useState(0);
  const [modelLists, setModelLists] = useState<Record<string, ModelListState>>({});
  const modelListsRef = useRef<Record<string, ModelListState>>({});
  const modelListCacheRef = useRef<LlmModelListCache>({});
  const setModelListState = useCallback((key: string, state: ModelListState) => {
    setModelLists((current) => {
      // Writing an identical state must not produce a new map: `connections`
      // is derived from this, and a fresh identity re-runs the launch refresh,
      // which would write the same state again. Payload fields are compared by
      // reference because a fetch that actually landed always brings new ones.
      if (sameModelListState(current[key], state)) return current;
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
      const baseUrl = options.baseUrl?.trim() ?? "";
      if (!shouldSyncModelList(provider, baseUrl, options.modelDiscoveryPolicy)) return;
      const credentialScope =
        provider === "openai-compatible" ? options.credentialScope?.trim() ?? "" : "";
      const key = llmModelListCacheKey(provider, baseUrl, credentialScope);
      const existing = modelListsRef.current[key];
      // One request in flight per key. This is the only guard `force` does not
      // lift: a second press while the first is still out would not produce a
      // newer answer, only a second spinner.
      if (existing?.status === "loading") return;
      // See `modelListRefreshedThisLaunch` for the policy this enforces.
      if (!options.force && modelListRefreshedThisLaunch.has(key)) return;
      // Claimed BEFORE anything is awaited. More than one caller asks for the
      // same key — a row's card, the fallback panel, the launch pass — and a
      // guard set only after an await is no guard at all for whoever reads it
      // during that await.
      modelListRefreshedThisLaunch.add(key);
      // A fixed-endpoint vendor reaches its own /models with a stored key, so a
      // request with nothing stored could only come back 401 — and a red "sync
      // failed" on a card whose subscription is signed in and healthy says the
      // wrong thing. Asked here, on the edge of actually fetching, so a
      // catalogue that is already in hand still stands.
      if (!baseUrl && STANDARD_CATALOGUE_ENDPOINT_VENDORS.has(provider)) {
        const hasCredential = await api.hasApiKey(provider);
        if (!hasCredential) {
          // Nothing was asked, so the launch owes this key a request still:
          // storing a key is a change to this row's inputs, and it gets that
          // request then.
          forgetModelListLaunchRefresh(key);
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
    activeModelListBaseUrl,
    activeModelDiscoveryPolicy,
  );
  const activeSyncedModelOptions = modelDiscoveryPolicyUsesSeededOptions(activeModelDiscoveryPolicy)
    ? undefined
    : optionsFromModelListState(activeModelList);
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

  const handleTogglePin = useCallback((modelId: string) => {
    const next = pinnedModels.includes(modelId)
      ? pinnedModels.filter((id: string) => id !== modelId)
      : [...pinnedModels, modelId];
    setPinnedModels(next);
    void api.updateSettings({ llm: { pinnedModels: next } });
  }, [api, pinnedModels]);

  /**
   * The row whose credential form is open, by row id.
   *
   * It used to be a bare boolean, which meant "open" and "which row" were two
   * different questions answered by two different pieces of state: the flag
   * here, and the ambient vendor over in the parent. Opening a row set the flag
   * immediately but moved the vendor through the parent, so between those two
   * renders the form hung under whichever row the OLD vendor still matched —
   * a person clicking one provider saw a form appear under another.
   */
  const [openRowId, setOpenRowId] = useState<string | null>(null);
  const [addedRowIds, setAddedRowIds] = useState<readonly string[]>([]);
  /** The row a click just revealed, until it has been scrolled to and focused. */
  const [rowToReveal, setRowToReveal] = useState<string | null>(null);
  /** The row the add menu revealed, until the menu has let go of the caret. */
  const menuRevealedRowRef = useRef<string | null>(null);
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
      // Content-compared, like the credential set below it: a broadcast arrives
      // for every settings write, and a fresh object identity each time would
      // re-run every effect that reads a row's endpoint — including the one
      // that asks endpoints for their catalogues.
      setSavedVendorBlocks((current) => {
        const next = settings.llm?.vendors ?? {};
        return sameSavedVendorBlocks(current, next) ? current : next;
      });
      setSettingsRevision((current) => current + 1);
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
  // Every provider that could own a row, including the API counterparts of the
  // subscription runtimes — a paired provider's key belongs to its runtime's
  // row, and that runtime need not be in the vendor catalogue.
  const credentialCandidateKey = useMemo(
    () => [...new Set([
      ...providerSelectOptions.map((option) => option.id),
      ...Object.values(SUBSCRIPTION_RUNTIME_API_COUNTERPART),
    ])].filter(Boolean).sort().join("\n"),
    [providerSelectOptions],
  );
  useEffect(() => {
    let cancelled = false;
    const candidates = credentialCandidateKey.split("\n").filter(Boolean);
    void (async () => {
      const found = new Set<string>();
      await Promise.all(candidates.map(async (providerId) => {
        try {
          if (await api.hasApiKey(providerId)) found.add(providerId);
        } catch {
          /* a provider we cannot ask about is not one we can claim is keyed */
        }
      }));
      if (cancelled) return;
      setCredentialedProviderIds((current) =>
        current.size === found.size && [...found].every((id) => current.has(id))
          ? current
          : found);
    })();
    return () => { cancelled = true; };
  }, [api, credentialCandidateKey, settingsRevision]);
  const fallbackProviderKey = useMemo(
    () => [...new Set(fallbackChain.map((entry) => entry.provider).filter(Boolean))]
      .sort()
      .join("\n"),
    [fallbackChain],
  );
  useEffect(() => {
    if (!settingsLoaded || !fallbackOpen) return;
    for (const provider of fallbackProviderKey.split("\n").filter(Boolean)) {
      // A fallback entry need not have a row of its own, so this is the only
      // thing that would ever ask for its catalogue. It rides the same
      // once-per-launch marker as everything else, so opening the panel twice
      // asks once.
      const baseUrl = rowModelListBaseUrl(provider, undefined);
      void requestModelList(provider, { ...(baseUrl ? { baseUrl } : {}) });
    }
  }, [fallbackOpen, fallbackProviderKey, requestModelList, rowModelListBaseUrl, settingsLoaded]);

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
  const installedPresetById = useMemo(
    () => new Map(marketplaceProviderPresets.map((preset) => [preset.providerId, preset])),
    [marketplaceProviderPresets],
  );

  /** The id this row's secret is stored under. */
  const rowCredentialId = (row: ProviderConnection): string =>
    row.presetId ? marketplaceProviderPresetSecretId(row.presetId) : row.apiVendorId!;

  /** Whether this row's credential form has to ask for a key at all. */
  const rowRequiresApiKey = useCallback((row: ProviderConnection): boolean => {
    const preset = row.presetId ? installedPresetById.get(row.presetId) : undefined;
    if (preset) return preset.requiresApiKey !== false;
    const vendorId = row.apiVendorId ?? "";
    return !(isLLMVendor(vendorId) && canUseLlmVendorWithoutApiKey(vendorId, {
      baseUrl: savedVendorBlocks[vendorId]?.baseUrl ?? "",
    }));
  }, [installedPresetById, savedVendorBlocks]);

  /**
   * Where a plain vendor's catalogue is filed.
   *
   * The write and the read have to agree, and they only do if they build the
   * key the same way: a preset vendor ships its own address, so its catalogue
   * lands under `vendor\n<address>\n` and reading `vendor\n\n` finds nothing —
   * the fallback dropdown then showed only the saved model, as if the endpoint
   * had never answered.
   */
  const vendorModelListKey = useCallback(
    (vendorId: string): string =>
      llmModelListCacheKey(vendorId, rowModelListBaseUrl(vendorId, undefined), ""),
    [rowModelListBaseUrl],
  );

  /**
   * The catalogue request this row's own key names, or null when the row has
   * no catalogue to ask anyone for.
   *
   * Read back OUT of `modelListKey` rather than rebuilt from the row's parts,
   * so the answer can only land where the row is already looking. The launch
   * refresh and the card's refresh control both go through here, which is what
   * makes "the button refreshes THIS card" true by construction.
   */
  const rowModelListRequest = useCallback((row: ProviderConnection): {
    vendorId: string;
    options: {
      baseUrl?: string;
      credentialScope?: string;
      modelDiscoveryPolicy?: MarketplaceProviderModelDiscoveryPolicy;
    };
  } | null => {
    if (!row.apiVendorId || !row.modelListKey) return null;
    const [vendorId, baseUrl, credentialScope] = row.modelListKey.split("\n");
    if (!vendorId) return null;
    const preset = credentialScope ? installedPresetById.get(credentialScope) : undefined;
    const modelDiscoveryPolicy = preset?.modelDiscoveryPolicy;
    if (!shouldSyncModelList(vendorId, baseUrl, modelDiscoveryPolicy)) return null;
    // A route reached with no credential can only come back 401. There is
    // nothing to ask yet and nothing to refresh, so the card says what is
    // missing (`rowChatBlocker`) instead of showing a control that would fail.
    if (rowRequiresApiKey(row) && !credentialedProviderIds.has(rowCredentialId(row))) return null;
    return {
      vendorId,
      options: {
        ...(baseUrl ? { baseUrl } : {}),
        ...(credentialScope ? { credentialScope } : {}),
        ...(modelDiscoveryPolicy ? { modelDiscoveryPolicy } : {}),
      },
    };
  }, [credentialedProviderIds, installedPresetById, rowRequiresApiKey]);

  const configuredApiRoutes = useMemo<readonly ConfiguredApiRoute[]>(() => {
    const routes = new Map<string, ConfiguredApiRoute>();
    const add = (route: ConfiguredApiRoute) => {
      const rowId = apiRouteRowId(route);
      if (!routes.has(rowId)) routes.set(rowId, route);
    };
    // The ACTIVE route goes first: its credential is known here directly, so it
    // counts before any fetch lands, and its key is the current configuration
    // rather than a stale cache entry. (It is the active route, not the one
    // whose card happens to be open — opening a card moves nothing.)
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
      const [cachedVendor, cachedBaseUrl, scope] = cacheKey.split("\n");
      if (!cachedVendor) continue;
      const preset = scope ? installedPresetById.get(scope) : undefined;
      if (scope && !preset) continue;
      // The key a persisted entry is filed under names the address it was
      // fetched from. If that is not the address this row is configured for
      // now, the entry describes a route that no longer exists — and binding
      // the row to it would leave the row reading a key nothing writes,
      // holding an old catalogue that can never refresh.
      if ((cachedBaseUrl ?? "") !== rowModelListBaseUrl(cachedVendor, preset)) continue;
      add({ vendorId: cachedVendor, ...(scope ? { presetId: scope } : {}), modelListKey: cacheKey });
    }
    // And a stored key is a configuration in its own right. This is the half
    // that does not depend on the endpoint agreeing: a provider whose key has
    // gone stale must keep its row, because that row is where the key is
    // replaced or removed.
    for (const providerId of credentialedProviderIds) {
      const presetId = marketplaceProviderPresetIdFromSecretId(providerId);
      const preset = presetId ? installedPresetById.get(presetId) : undefined;
      if (presetId && !preset) continue;
      const vendorId = presetId ? "openai-compatible" : providerId;
      const rowAddress = preset?.baseUrl ?? rowModelListBaseUrl(vendorId, undefined);
      add({
        vendorId,
        ...(presetId ? { presetId } : {}),
        // Built from the row's CURRENT address, never resolved by searching
        // what happens to be in the cache. That search matched on vendor and
        // scope alone and took the first hit, so an entry written by an older
        // build under a different address could bind the row to a key nothing
        // writes any more — a catalogue that could never refresh. Entries that
        // no row's address names are simply never read.
        modelListKey: llmModelListCacheKey(vendorId, rowAddress, presetId ?? ""),
      });
    }
    return [...routes.values()];
  }, [
    modelLists, apiPathConfigured, vendor, marketplaceProviderPresetId, activeModelListKey,
    credentialedProviderIds, installedPresetById, rowModelListBaseUrl,
  ]);

  const configuredRowIds = useMemo(
    () => new Set(configuredApiRoutes.map(apiRouteRowId)),
    [configuredApiRoutes],
  );

  /** The provider option a draft's fields describe — preset first, else vendor. */
  const draftProviderOption = useMemo<ProviderOption | VendorOption | null>(() => {
    if (!providerCredentialDraft) return null;
    const preset = providerCredentialDraft.presetId
      ? installedPresetById.get(providerCredentialDraft.presetId)
      : undefined;
    return preset
      ? providerOptionFromPreset(preset)
      : getVendorInfo(providerCredentialDraft.vendorId);
  }, [installedPresetById, providerCredentialDraft]);

  /**
   * Whether the open card still holds something the store has not been told.
   *
   * Read off the DRAFT's own vendor, not the active one: the card being edited
   * and the provider chat runs on are different questions, and comparing one
   * row's typed endpoint against another row's saved block reported both a
   * dirty card that was clean and a clean card that was dirty.
   */
  const credentialDirty = useMemo(() => {
    const draft = providerCredentialDraft;
    if (!draft || !draftProviderOption) return false;
    if (draft.keyInput.trim()) return true;
    const saved = savedVendorBlocks[draft.vendorId];
    if (draft.vendorId === "vertex-ai") {
      return draft.vertexProject.trim() !== (saved?.vertexProject ?? "").trim()
        || draft.vertexLocation.trim() !== (saved?.vertexLocation ?? "").trim();
    }
    return endpointIsUserSupplied(draft.vendorId, draftProviderOption, Boolean(draft.presetId))
      && draft.baseUrl.trim() !== (saved?.baseUrl ?? "").trim();
  }, [draftProviderOption, providerCredentialDraft, savedVendorBlocks]);

  /** The row the ACTIVE API provider is drawn on. */
  const activeApiRowId = marketplaceProviderPresetId
    ? marketplaceProviderPresetSecretId(marketplaceProviderPresetId)
    : vendor;

  // Rows that must stay on screen although nothing is connected on them yet:
  // the ones the user added, plus whichever card holds uncommitted input.
  // That draft lives in the parent and outlives this component, so the row that
  // owns it is DERIVED from the draft — otherwise a tab switch takes the card
  // away while the half-typed key it belongs to is still there.
  const draftRowId = credentialDirty ? providerCredentialDraft?.rowId ?? null : null;
  const pinnedRowIds = useMemo<readonly string[]>(
    () => (draftRowId && !addedRowIds.includes(draftRowId)
      ? [...addedRowIds, draftRowId]
      : addedRowIds),
    [addedRowIds, draftRowId],
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
          : llmModelListCacheKey(rowId, rowModelListBaseUrl(rowId, undefined), ""),
        apiConfigured: false,
        connected: false,
      });
    }
    return rows;
  }, [
    subscription.providers, configuredApiRoutes, pinnedRowIds, providerSelectOptions,
    marketplaceProviderPresets, installedPresetById, rowModelListBaseUrl,
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
  // The launch refresh (see `modelListRefreshedThisLaunch`). An effect runs
  // after the commit, and this one additionally waits for the first settings
  // apply — so every card and the chooser have already painted from the
  // persisted cache before anything is asked, and nothing here can delay what
  // the user sees. Re-runs are free: `requestModelList` decides per key whether
  // this launch has asked yet.
  useEffect(() => {
    if (!settingsLoaded || settingsRevision === 0) return;
    for (const row of connections) {
      const request = rowModelListRequest(row);
      if (!request) continue;
      void requestModelList(request.vendorId, request.options);
    }
  }, [
    connections, requestModelList, rowModelListRequest, settingsLoaded, settingsRevision,
  ]);

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

  /**
   * Whether this row is the API provider chat is running on.
   *
   * This is the row's own question about the ACTIVE provider, and it is no
   * longer the same question as "is this row's form open" — opening a card used
   * to move the active provider, so one predicate answered both and every
   * opened card claimed to be live.
   */
  const rowIsActiveApiProvider = useCallback(
    (row: ProviderConnection): boolean =>
      Boolean(row.apiVendorId)
      && row.apiVendorId === vendor
      && (row.presetId ?? "") === marketplaceProviderPresetId,
    [vendor, marketplaceProviderPresetId],
  );

  /**
   * The model this row has stored — its own, never another row's.
   *
   * A preset is a provider reached through the openai-compatible vendor, so
   * its model lives in that block's per-preset map rather than the block's
   * single `model`, which belongs to the generic custom-provider row.
   */
  const rowSavedModel = useCallback((row: ProviderConnection): string => {
    const block = savedVendorBlocks[row.apiVendorId ?? ""];
    if (!block) return "";
    return llmRouteModel(
      { model: block.model ?? "", ...(block.presetModels ? { presetModels: block.presetModels } : {}) },
      row.presetId,
    );
  }, [savedVendorBlocks]);

  /**
   * What this row can be asked for right now.
   *
   * The one computation behind both the chooser's options and the card's
   * status line, so the two can never disagree about whether a provider has
   * anything to offer. The active row's selection is live state; every other
   * row's is what it has stored, so a configured provider always shows its own
   * saved model even when its endpoint has said nothing yet.
   */
  const rowModelIds = useCallback((row: ProviderConnection): readonly string[] => {
    const vendorId = row.apiVendorId ?? "";
    if (!vendorId) return [];
    const preset = row.presetId ? installedPresetById.get(row.presetId) : undefined;
    const rowInfo = preset ? providerOptionFromPreset(preset) : getVendorInfo(vendorId);
    const discoveryPolicy = preset?.modelDiscoveryPolicy;
    const state = row.modelListKey ? modelLists[row.modelListKey] : undefined;
    const synced = modelDiscoveryPolicyUsesSeededOptions(discoveryPolicy)
      ? undefined
      : optionsFromModelListState(state);
    const selectedModel = rowCredentialId(row) === activeApiRowId
      ? activeModelValue
      : rowSavedModel(row);
    return modelOptionsFor(vendorId, selectedModel, synced, rowInfo, discoveryPolicy);
  }, [activeApiRowId, activeModelValue, installedPresetById, modelLists, rowSavedModel]);

  /**
   * What stops this row's API route from answering a chat turn, or null.
   *
   * "Configured" is not one uniform question. An API-key vendor needs a stored
   * key; Vertex authenticates out of band, so what it needs saved is a project
   * id and it stores no key at all. Asking only the key question left the
   * Vertex card permanently unusable — it could never look ready, because the
   * thing it was being asked for is not the thing it uses.
   *
   * A credentialed row with nothing to offer is the third case, and it is not
   * a failure: a provider whose catalogue is the endpoint's word has nothing
   * choosable until the endpoint answers. Deriving it from `rowModelIds` — the
   * chooser's own list — is what keeps the card from claiming readiness for a
   * provider the chooser is not offering.
   */
  const rowChatBlocker = useCallback((row: ProviderConnection): ChatBlocker | null => {
    // A signed-in subscription row answers turns through its runtime. Whether
    // its API counterpart also has a key is a different question, and asking
    // it here told a working card to go set one up.
    if (row.subscription?.status?.connection === "connected") return null;
    const vendorId = row.apiVendorId ?? "";
    if (vendorId === "vertex-ai" && !savedVendorBlocks[vendorId]?.vertexProject?.trim()) {
      return "needs-gcp-project";
    }
    if (
      vendorId !== "vertex-ai"
      && rowRequiresApiKey(row)
      && !credentialedProviderIds.has(rowCredentialId(row))
    ) {
      return "needs-api-key";
    }
    if (rowModelIds(row).length > 0) return null;
    // Nothing to choose, and the four ways to arrive there are four different
    // sentences: a list that never came, one that failed, and one that came
    // back empty are not the same news, and saying "has not sent its list" for
    // the last two would be false.
    const state = row.modelListKey ? modelLists[row.modelListKey] : undefined;
    if (state?.status === "error") return "catalogue-failed";
    if (state?.status === "ready") return "catalogue-empty";
    return "awaiting-catalogue";
  }, [credentialedProviderIds, modelLists, rowModelIds, rowRequiresApiKey, savedVendorBlocks]);

  /**
   * Every model a connected provider can be asked for, in ONE list.
   *
   * This list IS the provider switch. Picking a model picks the provider that
   * serves it, so there is no second "use this provider" control anywhere on
   * the page — which means the list has to be complete, or a provider the user
   * configured would be unreachable.
   *
   * A row contributes exactly what `rowModelIds` says it has, and exactly when
   * `rowChatBlocker` says it can answer — both derived from that one list, so
   * the chooser and the card's status line cannot disagree about whether a
   * provider is ready. Do not add a second key-based gate on top: two policies
   * answering the same question is how a vendor ends up with an empty chooser
   * while its catalogue is right there.
   */
  const unifiedOptions = useMemo<UnifiedModelOption[]>(() => {
    const options: UnifiedModelOption[] = [];
    const pushed = new Set<string>();
    for (const row of connections) {
      if (!row.apiVendorId) continue;
      if (rowChatBlocker(row) !== null) continue;
      const rowId = rowCredentialId(row);
      const state = row.modelListKey ? modelLists[row.modelListKey] : undefined;
      const isActiveRow = rowId === activeApiRowId;
      const entries = modelEntryMap(state?.entries);
      for (const modelId of rowModelIds(row)) {
        // Keyed by the ROW, not the vendor: two marketplace presets are two
        // providers reached through one vendor, and a pick has to say which.
        const value = unifiedValue(apiProviderId(rowId), modelId);
        if (pushed.has(value)) continue;
        pushed.add(value);
        const entry = entries.get(modelId);
        options.push({
          value,
          providerId: apiProviderId(rowId),
          providerLabel: row.label,
          modelId,
          vendorTag: entry?.provider ?? entry?.ownedBy ?? row.apiVendorId,
          ...(entry ? { entry } : {}),
          ...(isActiveRow && modelId === unlistedModel
            ? { unlisted: true, facts: t("llmTab.modelUnlisted") }
            : {}),
        });
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
    connections, rowChatBlocker, rowModelIds, modelLists, activeApiRowId,
    unlistedModel, subscription.providers, t,
  ]);

  const selectedUnifiedValue = subscription.activeRuntime.kind === "subscription"
    ? unifiedValue(subscription.activeRuntime.provider, subscription.activeRuntime.model ?? "")
    : unifiedValue(apiProviderId(activeApiRowId), activeModelValue);

  /**
   * A pick moves BOTH halves of the decision: which provider answers, and with
   * what model. It persists the way the thinking controls do — through the
   * debounced save — rather than waiting on a Save button, which exists for
   * the typed fields where a keystroke is not yet a decision.
   */
  const handleUnifiedModelChange = useCallback((value: string) => {
    const parsed = parseUnifiedValue(value);
    if (!parsed) return;
    if (parsed.providerId.startsWith(API_PROVIDER_PREFIX)) {
      const pickedRowId = parsed.providerId.slice(API_PROVIDER_PREFIX.length);
      const pickedPresetId = marketplaceProviderPresetIdFromSecretId(pickedRowId);
      const pickedPreset = pickedPresetId ? installedPresetById.get(pickedPresetId) : undefined;
      if (pickedRowId === activeApiRowId) {
        // Same provider, different model: moving the vendor as well would
        // re-hydrate fields the user may have just changed.
        setModel(parsed.modelId);
      } else if (pickedPreset) {
        onSelectMarketplaceProviderPreset?.(pickedPreset);
        setModel(parsed.modelId);
      } else {
        // The generic custom provider IS this vendor without a preset, so
        // dropping the preset is what selects it.
        if (pickedRowId === "openai-compatible" && marketplaceProviderPresetId) {
          onClearMarketplaceProviderPreset?.();
        }
        selectApiVendorModel(pickedRowId, parsed.modelId);
      }
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
    activeApiRowId, installedPresetById, marketplaceProviderPresetId,
    onClearMarketplaceProviderPreset, onImmediateChange, onSelectMarketplaceProviderPreset,
    selectApiVendorModel, setModel,
    subscription.activeRuntime.kind, subscription.props.actions,
  ]);

  const revealRow = useCallback((rowId: string) => {
    setAddedRowIds((current) => current.includes(rowId) ? current : [...current, rowId]);
    setRowToReveal(rowId);
  }, []);

  /** Reveal a row picked from the add menu — see the menu's close handler. */
  const revealRowFromAddMenu = useCallback((rowId: string) => {
    menuRevealedRowRef.current = rowId;
    revealRow(rowId);
  }, [revealRow]);

  /**
   * Show one card's credential form.
   *
   * Opening is not choosing: this touches no setting. It names the row and
   * starts a draft seeded from what that row already has stored, so the fields
   * below describe the card the user clicked whatever chat is running on.
   */
  const openRowCredentialForm = useCallback((target: {
    rowId: string;
    vendorId: string;
    presetId: string;
  }) => {
    setOpenRowId(target.rowId);
    if (providerCredentialDraft?.rowId === target.rowId) return;
    const preset = target.presetId ? installedPresetById.get(target.presetId) : undefined;
    const saved = savedVendorBlocks[target.vendorId];
    onProviderCredentialDraftChange?.({
      rowId: target.rowId,
      vendorId: target.vendorId,
      presetId: target.presetId,
      keyInput: "",
      // A preset ships the one address it serves from; every other row's
      // endpoint is whatever that vendor has stored.
      baseUrl: preset ? preset.baseUrl : saved?.baseUrl ?? "",
      vertexProject: saved?.vertexProject ?? "",
      vertexLocation: saved?.vertexLocation ?? "",
    });
  }, [
    installedPresetById, onProviderCredentialDraftChange, providerCredentialDraft,
    savedVendorBlocks,
  ]);

  /** What `openRowCredentialForm` has to be handed to open this row. */
  const rowFormTarget = (row: ProviderConnection) => ({
    rowId: row.id,
    vendorId: row.apiVendorId!,
    presetId: row.presetId ?? "",
  });

  /** Whether this row is showing its credential form. */
  const rowFormOpen = useCallback(
    (row: ProviderConnection): boolean => openRowId === row.id,
    [openRowId],
  );

  /** Which row is actually showing a form right now — the signal the reveal
   *  waits on, since the form arrives a render after the row does. */
  const openFormRowId = visibleRows.find((row) => rowFormOpen(row))?.id ?? null;

  // A row that was just revealed has to be findable: the list can already be
  // longer than the panel, and a card that appears below the fold reads as a
  // click that did nothing.
  useEffect(() => {
    if (!rowToReveal) return;
    const node = connectionsRef.current?.querySelector<HTMLElement>(
      `[data-provider-row="${rowToReveal}"]`,
    );
    if (!node) return;
    // A row added from the menu can be on screen a render before its form is —
    // the draft it needs is the parent's to hold. Consuming the reveal on the
    // bare row would put the caret on the disclosure button and leave nothing
    // to move when the endpoint field finally lands, so wait for the form the
    // reveal was actually asking for.
    const form = node.querySelector<HTMLElement>(`#${CREDENTIAL_FORM_ID}`);
    if (openRowId === rowToReveal && !form) return;
    setRowToReveal(null);
    node.scrollIntoView?.({ block: "nearest" });
    const focusTarget = node.querySelector<HTMLElement>('[data-testid="llm-base-url-input"]')
      ?? node.querySelector<HTMLElement>('[data-testid="llm-api-key-input"]')
      ?? node.querySelector<HTMLElement>("button");
    focusTarget?.focus();
  }, [openFormRowId, openRowId, rowToReveal, visibleRowKey]);

  /**
   * Persist ONE card. Only what this row owns is written: its secret, and the
   * fields the row itself is asked for. A vendor whose endpoint is fixed and a
   * preset that ships its own both write no block at all — sending one would
   * overwrite an address that belongs to the generic provider's card.
   */
  const saveRowCredential = async (row: ProviderConnection) => {
    const draft = providerCredentialDraft;
    if (!draft || draft.rowId !== row.id || !onSaveProviderCredential) return;
    const preset = row.presetId ? installedPresetById.get(row.presetId) : undefined;
    const rowInfo = preset ? providerOptionFromPreset(preset) : getVendorInfo(draft.vendorId);
    const vendorBlock = draft.vendorId === "vertex-ai"
      ? {
        vertexProject: draft.vertexProject.trim() || undefined,
        vertexLocation: draft.vertexLocation.trim() || undefined,
      }
      : endpointIsUserSupplied(draft.vendorId, rowInfo, Boolean(row.presetId))
        ? { baseUrl: draft.baseUrl.trim() || undefined }
        : undefined;
    const saved = await onSaveProviderCredential({
      credentialProviderId: rowCredentialId(row),
      vendorId: draft.vendorId,
      apiKey: draft.keyInput,
      ...(vendorBlock ? { vendorBlock } : {}),
    });
    if (!saved) return;
    setCredentialSavedRowId(row.id);
    // Storing a key is not a settings write on every path, so re-ask the
    // credential store directly rather than waiting on a broadcast that a
    // secret-only save never sends.
    setSettingsRevision((current) => current + 1);
    // ...and let this row ask its endpoint again with the credential it now
    // holds, whether the last answer was a failure or nothing at all.
    if (row.modelListKey) forgetModelListLaunchRefresh(row.modelListKey);
    // The same submit may also MOVE the row: the address it just wrote is the
    // one the row will read from next, and typing back an address that failed
    // earlier this launch must still earn a fresh request.
    if (vendorBlock && "baseUrl" in vendorBlock) {
      forgetModelListLaunchRefresh(
        llmModelListCacheKey(draft.vendorId, draft.baseUrl.trim(), row.presetId ?? ""),
      );
    }
    // The card stays open on what it just committed, minus the key it no
    // longer holds. Dropping the draft here would collapse the form under a
    // header still drawn as expanded.
    onProviderCredentialDraftChange?.({ ...draft, keyInput: "" });
  };

  /**
   * The credential form for one provider row.
   *
   * Every field here is the ROW's: its stored endpoint, its secret, its
   * "requires a key" answer. Nothing is read off the active provider, so the
   * form for one card is the same form whichever provider chat is running on.
   */
  const credentialFormFor = (row: ProviderConnection) => {
    const draft = providerCredentialDraft;
    if (!draft || draft.rowId !== row.id) return null;
    const rowPreset = row.presetId ? installedPresetById.get(row.presetId) : undefined;
    const rowVendorId = draft.vendorId;
    const rowInfo = rowPreset ? providerOptionFromPreset(rowPreset) : getVendorInfo(rowVendorId);
    const rowEndpointLocked = Boolean(row.presetId);
    const rowHasKey = credentialedProviderIds.has(rowCredentialId(row));
    const rowNeedsApiKey = rowRequiresApiKey(row);
    const patchDraft = (next: Partial<ProviderCredentialDraft>) =>
      onProviderCredentialDraftChange?.({ ...draft, ...next });
    return (
      <div
        className="space-y-3"
        id={CREDENTIAL_FORM_ID}
        data-testid="llm-tab:manual-section"
      >
        {rowVendorId !== "vertex-ai" && endpointIsUserSupplied(rowVendorId, rowInfo, rowEndpointLocked) && (
          <div className="space-y-2">
            <Label className="text-sm font-medium">
              {t("llmTab.endpointBaseUrlLabel")} *
            </Label>
            <Input
              data-testid="llm-base-url-input"
              value={draft.baseUrl}
              onChange={(e) => patchDraft({ baseUrl: e.target.value })}
              placeholder={rowInfo.baseUrlPlaceholder ?? "https://..."}
            />
            <p className="text-[11px] text-muted-foreground">
              {t("llmTab.baseUrlDiscardWarning")}
            </p>
            {rowVendorId === "azure-foundry" && (
              <p className="text-[11px] text-muted-foreground">
                {t("llmTab.azureEndpointFormat")}
                {" "}<code>https://{"{resource}"}.openai.azure.com/openai/v1/</code>
                {" "}— {t("llmTab.azureDeploymentNote")}
              </p>
            )}
          </div>
        )}
        {rowVendorId === "vertex-ai" && (
          <div className="space-y-2 rounded-md border p-3">
            <p className="text-sm font-medium">{t("llmTab.vertexTitle")}</p>
            <p className="text-[11px] text-muted-foreground">
              {t("llmTab.vertexAuthDesc1")}<code>gcloud auth application-default login</code>{t("llmTab.vertexAuthDesc2")}
              {t("llmTab.vertexAuthDesc3")}<code>GOOGLE_APPLICATION_CREDENTIALS</code>{t("llmTab.vertexAuthDesc4")}
            </p>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">{t("llmTab.gcpProjectIdLabel")}</Label>
              <Input
                value={draft.vertexProject}
                onChange={(e) => patchDraft({ vertexProject: e.target.value })}
                placeholder="my-gcp-project"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">
                {t("llmTab.vertexLocationLabel", { optional: t("llmTab.optional") })}
              </Label>
              <Input
                value={draft.vertexLocation}
                onChange={(e) => patchDraft({ vertexLocation: e.target.value })}
                placeholder={t("llmTab.vertexLocationPlaceholder")}
              />
            </div>
          </div>
        )}
        {rowVendorId !== "vertex-ai" && (
          <div
            className="min-w-0 space-y-2"
            data-testid="llm-tab:api-key-section"
            data-api-key-required={rowNeedsApiKey ? "true" : "false"}
          >
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <Label className="min-w-0 text-sm font-medium" data-testid="llm-tab:api-key-label">
              {row.label} {t("llmTab.apiKey")}
              {!rowNeedsApiKey ? ` (${t("llmTab.optional")})` : ""}
            </Label>
              {rowHasKey ? (
                <Badge variant="default" data-testid="llm-tab:api-key-status" className="h-5 shrink-0 whitespace-nowrap px-2.5 text-xs">{t("llmTab.apiKeySet")}</Badge>
              ) : (
                <Badge variant="secondary" data-testid="llm-tab:api-key-status" className="h-5 shrink-0 whitespace-nowrap px-2.5 text-xs">
                  {rowNeedsApiKey ? t("llmTab.apiKeyNotSet") : t("llmTab.optional")}
                </Badge>
              )}
              {rowHasKey && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs text-destructive"
                  onClick={() => void api.deleteApiKey(rowCredentialId(row)).then(() => {
                    if (rowIsActiveApiProvider(row)) setHasKey(false);
                    // A row that existed only because of the key it held would
                    // otherwise disappear the moment the key does — taking the
                    // open card, and the field for entering a replacement,
                    // with it. Pin it so removing a key leaves somewhere to
                    // put the next one.
                    revealRow(row.id);
                    setSettingsRevision((current) => current + 1);
                    onSaved();
                  })}
                >
                  {t("llmTab.delete")}
                </Button>
              )}
            </div>
            <Input
              data-testid="llm-api-key-input"
              type="password"
              placeholder={rowHasKey ? t("llmTab.replaceKey") : rowInfo.placeholder}
              value={draft.keyInput}
              onChange={(e) => patchDraft({ keyInput: e.target.value })}
            />
          </div>
        )}
        {/* Save belongs to the card whose fields it commits. A page-level
            button sat below every provider and the "add provider" control, so
            the one thing a half-filled new card needed was the one control
            furthest from it — and it read as committing the whole page. */}
        {onSaveProviderCredential && (
          <SectionSaveBar
            onSave={() => void saveRowCredential(row)}
            saving={saving}
            settingsLoaded={settingsLoaded}
            dirty={credentialDirty}
            testId="llm-tab:save-providers"
          />
        )}
      </div>
    );
  };

  // Which of this provider's two routes is serving chat right now. The user
  // asked for exactly this: the row says the provider, the badge says the mode.
  /** Which path this row is serving chat through right now, or null. */
  const activeMode = (row: ProviderConnection): "subscription" | "api" | null =>
    subscription.activeRuntime.kind === "subscription"
      ? (subscription.activeRuntime.provider === row.id ? "subscription" : null)
      : (rowIsActiveApiProvider(row) ? "api" : null);

  /**
   * What this card still needs before its models join the chooser.
   *
   * The card carries no switch of its own: picking a model IS picking the
   * provider, so a provider that cannot answer a turn is simply absent from
   * the one list. Absent with no explanation reads as a bug, so the card that
   * owns the missing piece says what it is, in the same words the list would
   * have needed.
   */
  /**
   * Whether the route chat is on right now can actually answer a turn.
   *
   * Saving a credential deliberately does NOT adopt the provider it belongs
   * to — the model list is the one switch, and a save silently moving the
   * route would make it two. What a save does owe the user is the pointer:
   * this is what says the key landed but chat is still elsewhere.
   */
  const activeRouteCanChat = useMemo(() => {
    if (subscription.activeRuntime.kind === "subscription") return true;
    const active = connections.find(
      (row) => row.apiVendorId && rowCredentialId(row) === activeApiRowId,
    );
    return Boolean(active) && rowChatBlocker(active!) === null;
  }, [activeApiRowId, connections, rowChatBlocker, subscription.activeRuntime.kind]);

  const pickModelGuidance = (row: ProviderConnection) => {
    if (credentialSavedRowId !== row.id || activeRouteCanChat) return null;
    return (
      <p
        className="text-[11px] text-muted-foreground"
        data-testid={`llm-tab:connection-pick-model:${row.id}`}
      >
        {t("llmTab.pickModelToUse")}
      </p>
    );
  };

  const chatAvailabilityNote = (row: ProviderConnection) => {
    if (!row.apiVendorId) return null;
    const blocker = rowChatBlocker(row);
    if (!blocker) return null;
    return (
      <p
        className="text-[11px] text-muted-foreground"
        data-testid={`llm-tab:connection-blocked:${row.id}`}
      >
        {t(CHAT_BLOCKER_MESSAGE_KEYS[blocker])}
      </p>
    );
  };

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
    // A subscription row borrows its API counterpart's cache key, so anything
    // filed under that key — a leftover entry from a previous session above
    // all — would paint a signed-in runtime's card with a handshake it never
    // made. The line belongs to the API path, so it appears only where that
    // path is actually configured.
    if (!row.apiConfigured) return null;
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
    const isOpen = rowFormOpen(row);
    return (
      <Button
        type="button"
        size="sm"
        variant={isOpen ? "secondary" : "outline"}
        aria-expanded={isOpen}
        {...(isOpen ? { "aria-controls": CREDENTIAL_FORM_ID } : {})}
        onClick={() => {
          if (isOpen) {
            setOpenRowId(null);
            return;
          }
          openRowCredentialForm(rowFormTarget(row));
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
   * This card's own refresh.
   *
   * Every card whose catalogue is fetchable gets one, because the launch
   * refresh is the only automatic one there is — when a provider ships a model
   * mid-session, this is how the user picks it up without restarting. A card
   * with no catalogue route (Azure AI Foundry, Claude, Gemini: their lists are
   * curated here) has nothing to refresh and shows no control.
   */
  const rowRefreshControl = (row: ProviderConnection) => {
    const request = rowModelListRequest(row);
    if (!request) return null;
    const loading = row.modelListKey
      ? modelLists[row.modelListKey]?.status === "loading"
      : false;
    return (
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-7 w-7 shrink-0 p-0"
        aria-label={t("llmTab.modelSync")}
        title={t("llmTab.modelSync")}
        data-testid={`llm-tab:connection-refresh:${row.id}`}
        disabled={loading}
        onClick={() => void requestModelList(request.vendorId, {
          ...request.options,
          force: true,
        })}
      >
        {loading
          ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden={true} />
          : <RefreshCw className="h-3.5 w-3.5" aria-hidden={true} />}
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
    if (!credentialDirty || providerCredentialDraft?.rowId !== row.id) return null;
    if (rowFormOpen(row)) return null;
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
          subline={<>{connectionSubline(row)}{chatAvailabilityNote(row)}{pickModelGuidance(row)}</>}
          authAction={<>{apiKeyChip(row)}{rowRefreshControl(row)}</>}
          {...(rowFormOpen(row) ? { trailing: credentialFormFor(row) } : {})}
        />
      ) : (
        <div
          key={row.id}
          className="space-y-3 rounded-md border bg-card p-3"
          data-provider-row={row.id}
          data-testid={`llm-tab:connection:${row.id}`}
        >
          {/* The whole head is the disclosure: the row IS the provider, so
              managing it should not require finding a particular control on it.
              The refresh sits BESIDE it, never inside — a button nested in a
              button is not a control the browser can give anyone. */}
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              className="flex w-full min-w-0 items-center gap-2 text-left"
              aria-expanded={rowFormOpen(row)}
              {...(rowFormOpen(row) ? { "aria-controls": CREDENTIAL_FORM_ID } : {})}
              onClick={() => {
                if (rowFormOpen(row)) {
                  setOpenRowId(null);
                  return;
                }
                openRowCredentialForm(rowFormTarget(row));
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
                  rowFormOpen(row) ? "rotate-90" : ""
                }`}
                aria-hidden={true}
              />
            </button>
            {rowRefreshControl(row)}
          </div>
          {chatAvailabilityNote(row)}
          {pickModelGuidance(row)}
          {rowFormOpen(row) ? credentialFormFor(row) : null}
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
          <DropdownMenuContent
            align="start"
            className="max-h-80 w-64 overflow-y-auto"
            /* Every item here reveals a card and moves the caret into it. That
               move cannot land while this menu's focus scope is still up, and
               the menu's own restore would put the caret back on the trigger
               afterwards — so decline the restore and re-arm the reveal for
               once the menu is gone. Closing without picking anything leaves
               the default restore alone. */
            onCloseAutoFocus={(event) => {
              const revealed = menuRevealedRowRef.current;
              menuRevealedRowRef.current = null;
              if (!revealed) return;
              event.preventDefault();
              setRowToReveal(revealed);
            }}
          >
            {addableRows.map((row) => (
              <DropdownMenuItem
                key={row.id}
                data-testid={`llm-tab:add-provider-item:${row.id}`}
                onClick={() => {
                  revealRowFromAddMenu(row.id);
                  if (row.apiVendorId) openRowCredentialForm(rowFormTarget(row));
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
                  revealRowFromAddMenu(option.id);
                  const presetId = marketplaceProviderPresetIdFromSecretId(option.id) ?? "";
                  openRowCredentialForm({
                    rowId: option.id,
                    vendorId: presetId ? "openai-compatible" : option.id,
                    presetId,
                  });
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
                const fallbackModelList = modelLists[vendorModelListKey(entry.provider)];
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
