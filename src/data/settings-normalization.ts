import { isIP } from "node:net";
import { isCanonicalA2APublicHttpsOrigin } from "../shared/a2a-public-origin.js";
import {
  SIDE_PANEL_DEFAULT_WIDTH,
  SIDE_PANEL_MIN_WIDTH,
  SIDE_PANEL_SPLIT_DEFAULT_PERCENT,
  SIDEBAR_DEFAULT_WIDTH,
  clampSidePanelSplitPercent,
  clampSidebarWidth,
} from "../shared/side-panel.js";
import {
  sanitizePluginConfig,
  sanitizePluginConfigPluginId,
  type PluginConfigRecord,
} from "../shared/plugin-config.js";
import {
  DEFAULT_LLM_VENDOR,
  getLlmVendorSettings,
  isLLMVendor,
  isMarketplaceEligibleLLMVendor,
  type LLMVendor,
  type LLMVendorSettingsMap,
  type LLMVendorSettings,
  type MarketplaceEligibleLLMVendor,
  normalizeLlmVendorModel,
} from "../shared/llm-vendor-defaults.js";
import {
  BUNDLE_IDS,
  DEFAULT_BUNDLE_ID,
  isMarketplaceEligibleThemeBundleId,
} from "../shared/theme-bundles.js";
import {
  FONT_SIZE_SCALE_VALUES,
  type FontSizeScale,
  type AppearanceFontSettings,
  isValidFontFamilyOverride,
} from "../shared/appearance-font.js";
import {
  isMarketplaceEligibleLocale,
  normalizeLocale,
} from "../i18n/index.js";
import { normalizeAppMode } from "../shared/initial-app-mode.js";
import { isSidebarTab } from "../shared/sidebar-tab.js";
import {
  MAX_CACHED_LLM_MODEL_ID_LENGTH,
  MAX_CACHED_LLM_MODEL_IDS,
  MAX_LLM_MODEL_LIST_CACHE_ENTRIES,
  llmModelListCacheKey,
  type LlmModelListCache,
  type LlmModelListCacheEntry,
  type LlmModelListEntry,
} from "../shared/llm-model-list.js";
import {
  isMarketplaceProviderPresetId,
  normalizeMarketplaceProviderPreset,
  type MarketplaceInstalledProviderPreset,
} from "../shared/marketplace-package-assets.js";
import { projectRootKey } from "../shared/project-identity.js";
import { clampLogRetentionDays } from "../shared/log-retention.js";
import { createLogger } from "../lib/logger.js";
import { DEFAULT_SETTINGS } from "./settings-defaults.js";
import type {
  A2ARemoteSettings,
  AppearanceSettings,
  AppearanceSettingsV1,
  ChatThemePreference,
  CodeThemePreference,
  DiagnosticsSettings,
  FeatureFlags,
  LLMSettings,
  LLMSettingsPatch,
  MarketplaceSettings,
  SystemCloseBehavior,
  SystemSettings,
  ThemePreference,
  WebViewPreferredFlow,
  WebViewSettings,
} from "./settings-store.js";

const log = createLogger("settings");

function isLlmProviderEnabled(
  vendor: LLMVendor,
  installedProviderIds: readonly MarketplaceEligibleLLMVendor[],
): boolean {
  return (
    !isMarketplaceEligibleLLMVendor(vendor) ||
    installedProviderIds.includes(vendor)
  );
}

function isMarketplaceProviderPresetInstalled(
  providerId: string | undefined,
  installedProviderPresets: readonly MarketplaceInstalledProviderPreset[] | undefined,
): boolean {
  if (!providerId || !isMarketplaceProviderPresetId(providerId)) return false;
  if (installedProviderPresets === undefined) return true;
  return installedProviderPresets.some((preset) => preset.providerId === providerId);
}

function normalizeActiveMarketplaceProviderPresetId(
  provider: LLMVendor,
  requested: unknown,
  installedProviderPresets: readonly MarketplaceInstalledProviderPreset[] | undefined,
): string | undefined {
  if (provider !== "openai-compatible") return undefined;
  if (!isMarketplaceProviderPresetId(requested)) return undefined;
  return isMarketplaceProviderPresetInstalled(requested, installedProviderPresets)
    ? requested
    : undefined;
}

function marketplaceProviderPresetForId(
  providerId: string | undefined,
  installedProviderPresets: readonly MarketplaceInstalledProviderPreset[] | undefined,
): MarketplaceInstalledProviderPreset | undefined {
  if (!providerId || !installedProviderPresets) return undefined;
  return installedProviderPresets.find((preset) => preset.providerId === providerId);
}

function marketplaceProviderPresetUsesSeededModelOptions(
  providerId: string,
  installedProviderPresets: readonly MarketplaceInstalledProviderPreset[] | undefined,
): boolean {
  const preset = marketplaceProviderPresetForId(providerId, installedProviderPresets);
  return preset?.modelDiscoveryPolicy === "manual" || preset?.modelDiscoveryPolicy === "static";
}

function bindOpenAICompatibleVendorBlockToMarketplaceProviderPreset(
  vendors: LLMVendorSettingsMap,
  preset: MarketplaceInstalledProviderPreset | undefined,
): void {
  if (!preset) return;
  const current = getLlmVendorSettings(vendors, "openai-compatible");
  vendors["openai-compatible"] = getLlmVendorSettings(
    {
      ...vendors,
      "openai-compatible": {
        ...current,
        baseUrl: preset.baseUrl,
      },
    },
    "openai-compatible",
  );
}

function isValidCachedModelId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const id = value.trim();
  return (
    id.length > 0 &&
    id.length <= MAX_CACHED_LLM_MODEL_ID_LENGTH &&
    !/[\u0000-\u001f\u007f]/.test(id)
  );
}

function normalizeCachedModelIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const models: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!isValidCachedModelId(raw)) continue;
    const model = raw.trim();
    if (seen.has(model)) continue;
    seen.add(model);
    models.push(model);
    if (models.length >= MAX_CACHED_LLM_MODEL_IDS) break;
  }
  return models;
}

function normalizeCachedModelListString(
  value: unknown,
  maxLength = MAX_CACHED_LLM_MODEL_ID_LENGTH,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function normalizeCachedModelListNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}

function normalizeCachedModelListStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const entry = normalizeCachedModelListString(raw, 64);
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);
    entries.push(entry);
    if (entries.length >= 32) break;
  }
  return entries.length > 0 ? entries : undefined;
}

function normalizeCachedModelListPricing(value: unknown): LlmModelListEntry["pricing"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const pricing: NonNullable<LlmModelListEntry["pricing"]> = {};
  for (const key of [
    "prompt",
    "completion",
    "request",
    "image",
    "webSearch",
    "internalReasoning",
    "inputCacheRead",
    "inputCacheWrite",
  ] as const) {
    const entry = normalizeCachedModelListString(record[key], 64);
    if (entry !== undefined) pricing[key] = entry;
  }
  return Object.keys(pricing).length > 0 ? pricing : undefined;
}

function normalizeCachedModelListTags(value: unknown): LlmModelListEntry["tags"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const tags: NonNullable<LlmModelListEntry["tags"]> = {};
  if (record.free === true) tags.free = true;
  if (record.router === true) tags.router = true;
  if (record.local === true) tags.local = true;
  return Object.keys(tags).length > 0 ? tags : undefined;
}

function normalizeCachedModelListEntries(
  value: unknown,
  models: readonly string[],
): LlmModelListEntry[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const allowed = new Set(models);
  const entries: LlmModelListEntry[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const record = raw as Partial<LlmModelListEntry>;
    const id = normalizeCachedModelListString(record.id);
    if (!id || !allowed.has(id) || seen.has(id)) continue;
    seen.add(id);
    const entry: LlmModelListEntry = { id };
    const name = normalizeCachedModelListString(record.name);
    const provider = normalizeCachedModelListString(record.provider);
    const ownedBy = normalizeCachedModelListString(record.ownedBy);
    const description = normalizeCachedModelListString(record.description, 4_096);
    const contextLength = normalizeCachedModelListNumber(record.contextLength);
    const inputModalities = normalizeCachedModelListStringArray(record.inputModalities);
    const outputModalities = normalizeCachedModelListStringArray(record.outputModalities);
    const supportedParameters = normalizeCachedModelListStringArray(record.supportedParameters);
    const pricing = normalizeCachedModelListPricing(record.pricing);
    const tags = normalizeCachedModelListTags(record.tags);
    if (name && name !== id) entry.name = name;
    if (provider) entry.provider = provider;
    if (ownedBy) entry.ownedBy = ownedBy;
    if (description) entry.description = description;
    if (contextLength !== undefined) entry.contextLength = contextLength;
    if (inputModalities) entry.inputModalities = inputModalities;
    if (outputModalities) entry.outputModalities = outputModalities;
    if (supportedParameters) entry.supportedParameters = supportedParameters;
    if (pricing) entry.pricing = pricing;
    if (tags) entry.tags = tags;
    entries.push(entry);
    if (entries.length >= models.length) break;
  }
  return entries.length > 0 ? entries : undefined;
}

function isValidModelListUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value.trim());
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

function normalizeLlmModelListCache(
  input: unknown,
  installedProviderIds: readonly MarketplaceEligibleLLMVendor[],
  installedProviderPresets?: readonly MarketplaceInstalledProviderPreset[],
): LlmModelListCache {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const result: LlmModelListCache = {};
  for (const value of Object.values(input as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const entry = value as Partial<LlmModelListCacheEntry>;
    if (!isLLMVendor(entry.vendor)) continue;
    if (!isLlmProviderEnabled(entry.vendor, installedProviderIds)) continue;
    if (!isValidModelListUrl(entry.endpoint)) continue;
    const models = normalizeCachedModelIds(entry.models);
    if (models.length === 0) continue;
    const modelEntries = normalizeCachedModelListEntries(entry.modelEntries, models);
    const baseUrl = typeof entry.baseUrl === "string" ? entry.baseUrl.trim() : "";
    let credentialScope = "";
    if (entry.credentialScope !== undefined) {
      if (!isMarketplaceProviderPresetId(entry.credentialScope)) continue;
      const scopedPresetId = entry.credentialScope.trim();
      if (!isMarketplaceProviderPresetInstalled(scopedPresetId, installedProviderPresets)) continue;
      if (marketplaceProviderPresetUsesSeededModelOptions(scopedPresetId, installedProviderPresets)) continue;
      credentialScope = scopedPresetId;
    }
    const fetchedAt = typeof entry.fetchedAt === "string" && entry.fetchedAt.trim()
      ? entry.fetchedAt.trim()
      : new Date(0).toISOString();
    const key = llmModelListCacheKey(entry.vendor, baseUrl, credentialScope);
    result[key] = {
      vendor: entry.vendor,
      ...(baseUrl ? { baseUrl } : {}),
      ...(credentialScope ? { credentialScope } : {}),
      endpoint: entry.endpoint.trim(),
      models,
      ...(modelEntries ? { modelEntries } : {}),
      fetchedAt,
    };
    if (Object.keys(result).length >= MAX_LLM_MODEL_LIST_CACHE_ENTRIES) break;
  }
  return result;
}

export function mergeLlmPatch(
  base: LLMSettings,
  partial: LLMSettingsPatch,
  installedProviderIds: readonly MarketplaceEligibleLLMVendor[],
  installedProviderPresets: readonly MarketplaceInstalledProviderPreset[] | undefined,
): LLMSettings {
  const vendors: LLMVendorSettingsMap = { ...base.vendors };
  if (partial.vendors) {
    for (const [vendorId, incoming] of Object.entries(partial.vendors)) {
      if (!isLLMVendor(vendorId) || !incoming) continue;
      const v = vendorId;
      if (!isLlmProviderEnabled(v, installedProviderIds)) continue;
      // Spread carries explicit `undefined` keys through (e.g. clearing `seed`).
      // Omitting a key from the patch leaves the previous value intact —
      // omit ≠ clear by design.
      vendors[v] = getLlmVendorSettings(
        {
          ...vendors,
          [v]: {
            ...getLlmVendorSettings(vendors, v),
            ...incoming,
          },
        },
        v,
      );
    }
  }
  for (const vendorId of Object.keys(vendors)) {
    if (!isLLMVendor(vendorId)) continue;
    vendors[vendorId] = getLlmVendorSettings(vendors, vendorId);
  }
  // Coerce stale on-disk `provider` (e.g. a since-removed vendor name) to the
  // base provider — `vendors[provider]` would otherwise be undefined and
  // crash refreshProvider/stream-collector at first turn. The type guard
  // narrows `partial.provider` so the assignment below is cast-free.
  const requestedProvider: LLMVendor = isLLMVendor(partial.provider)
    ? partial.provider
    : base.provider;
  const provider = isLlmProviderEnabled(requestedProvider, installedProviderIds)
    ? requestedProvider
    : DEFAULT_LLM_VENDOR;
  const requestedMarketplaceProviderPresetId =
    partial.marketplaceProviderPresetId !== undefined
      ? partial.marketplaceProviderPresetId
      : base.marketplaceProviderPresetId;
  const activeMarketplaceProviderPresetExplicitlyCleared =
    provider === "openai-compatible" &&
    partial.marketplaceProviderPresetId !== undefined &&
    isMarketplaceProviderPresetId(base.marketplaceProviderPresetId) &&
    !isMarketplaceProviderPresetId(partial.marketplaceProviderPresetId);
  let activeProvider = provider;
  const marketplaceProviderPresetId = normalizeActiveMarketplaceProviderPresetId(
    provider,
    requestedMarketplaceProviderPresetId,
    installedProviderPresets,
  );
  const activeMarketplaceProviderPreset = marketplaceProviderPresetForId(
    marketplaceProviderPresetId,
    installedProviderPresets,
  );
  const removedActiveMarketplaceProviderPreset =
    provider === "openai-compatible" &&
    isMarketplaceProviderPresetId(requestedMarketplaceProviderPresetId) &&
    !marketplaceProviderPresetId;
  if (activeMarketplaceProviderPresetExplicitlyCleared || removedActiveMarketplaceProviderPreset) {
    vendors["openai-compatible"] = getLlmVendorSettings(undefined, "openai-compatible");
  }
  if (removedActiveMarketplaceProviderPreset) {
    activeProvider = DEFAULT_LLM_VENDOR;
  }
  bindOpenAICompatibleVendorBlockToMarketplaceProviderPreset(
    vendors,
    activeMarketplaceProviderPreset,
  );
  vendors[activeProvider] = getLlmVendorSettings(vendors, activeProvider);
  const fallbackChain = (partial.fallbackChain ?? base.fallbackChain)
    .filter((entry) =>
      isLLMVendor(entry.provider) &&
      isLlmProviderEnabled(entry.provider, installedProviderIds) &&
      !(marketplaceProviderPresetId && entry.provider === "openai-compatible")
    )
    .map((entry) => ({
      ...entry,
      model: normalizeLlmVendorModel(entry.provider, entry.model),
    }));
  return {
    provider: activeProvider,
    ...(marketplaceProviderPresetId ? { marketplaceProviderPresetId } : {}),
    vendors,
    streamSmoothing: partial.streamSmoothing ?? base.streamSmoothing,
    fallbackChain,
    modelListCache: normalizeLlmModelListCache(
      "modelListCache" in partial ? partial.modelListCache : base.modelListCache,
      installedProviderIds,
      installedProviderPresets,
    ),
    // `undefined` means "no mapping"; an explicit empty string clears the map.
    hostResolverMap: "hostResolverMap" in partial ? partial.hostResolverMap : base.hostResolverMap,
  };
}

const LLM_VENDOR_SETTING_KEYS = [
  "model",
  "baseUrl",
  "vertexProject",
  "vertexLocation",
  "enableThinking",
  "thinkingBudgetTokens",
] as const satisfies readonly (keyof LLMVendorSettings)[];

function hasCustomLlmVendorSettings(
  vendor: LLMVendor,
  block: LLMVendorSettings,
): boolean {
  const normalized = getLlmVendorSettings({ [vendor]: block }, vendor);
  const defaults = getLlmVendorSettings(undefined, vendor);
  return LLM_VENDOR_SETTING_KEYS.some(
    (key) => normalized[key] !== defaults[key],
  );
}

function addUniqueMarketplaceProvider(
  values: MarketplaceEligibleLLMVendor[],
  vendor: LLMVendor,
): MarketplaceEligibleLLMVendor[] {
  if (!isMarketplaceEligibleLLMVendor(vendor)) return values;
  return values.includes(vendor) ? values : [...values, vendor];
}

export function pruneLazyLlmVendorBlocks(
  llm: LLMSettings,
  installedProviderIds: MarketplaceEligibleLLMVendor[],
  installedProviderPresets: readonly MarketplaceInstalledProviderPreset[],
  options: { inferInstalledFromCustom: boolean },
): {
  llm: LLMSettings;
  installedProviderIds: MarketplaceEligibleLLMVendor[];
} {
  const vendors: LLMVendorSettingsMap = {};
  let inferredInstalledProviderIds = installedProviderIds;

  if (options.inferInstalledFromCustom) {
    for (const [vendorId, block] of Object.entries(llm.vendors)) {
      if (!isLLMVendor(vendorId) || !block) continue;
      if (!isMarketplaceEligibleLLMVendor(vendorId)) continue;
      const normalized = getLlmVendorSettings({ [vendorId]: block }, vendorId);
      if (!hasCustomLlmVendorSettings(vendorId, normalized)) continue;
      inferredInstalledProviderIds = addUniqueMarketplaceProvider(
        inferredInstalledProviderIds,
        vendorId,
      );
    }
  }

  let provider = isLlmProviderEnabled(llm.provider, inferredInstalledProviderIds)
    ? llm.provider
    : DEFAULT_LLM_VENDOR;
  const marketplaceProviderPresetId = normalizeActiveMarketplaceProviderPresetId(
    provider,
    llm.marketplaceProviderPresetId,
    installedProviderPresets,
  );
  const activeMarketplaceProviderPreset = marketplaceProviderPresetForId(
    marketplaceProviderPresetId,
    installedProviderPresets,
  );
  const removedActiveMarketplaceProviderPreset =
    provider === "openai-compatible" &&
    isMarketplaceProviderPresetId(llm.marketplaceProviderPresetId) &&
    !marketplaceProviderPresetId;
  if (removedActiveMarketplaceProviderPreset) {
    provider = DEFAULT_LLM_VENDOR;
  }
  const fallbackChain = llm.fallbackChain.filter((entry) =>
    isLlmProviderEnabled(entry.provider, inferredInstalledProviderIds) &&
    !(marketplaceProviderPresetId && entry.provider === "openai-compatible")
  );
  const required = new Set<LLMVendor>(inferredInstalledProviderIds);
  required.add(provider);
  for (const entry of fallbackChain) {
    required.add(entry.provider);
  }

  for (const [vendorId, block] of Object.entries(llm.vendors)) {
    if (!isLLMVendor(vendorId) || !block) continue;
    const vendor = vendorId;
    const normalized = getLlmVendorSettings({ [vendor]: block }, vendor);
    const marketplaceOnly = isMarketplaceEligibleLLMVendor(vendor);
    const custom = hasCustomLlmVendorSettings(vendor, normalized);
    const keep =
      !marketplaceOnly ||
      required.has(vendor) ||
      (options.inferInstalledFromCustom && custom);
    if (!keep) continue;
    vendors[vendor] = normalized;
    if (options.inferInstalledFromCustom && marketplaceOnly && custom) {
      inferredInstalledProviderIds = addUniqueMarketplaceProvider(
        inferredInstalledProviderIds,
        vendor,
      );
    }
  }

  if (removedActiveMarketplaceProviderPreset) {
    vendors["openai-compatible"] = getLlmVendorSettings(undefined, "openai-compatible");
  }
  bindOpenAICompatibleVendorBlockToMarketplaceProviderPreset(
    vendors,
    activeMarketplaceProviderPreset,
  );
  vendors[provider] = getLlmVendorSettings(vendors, provider);
  const prunedLlm: LLMSettings = {
    ...llm,
    provider,
    fallbackChain,
    vendors,
    modelListCache: normalizeLlmModelListCache(
      llm.modelListCache,
      inferredInstalledProviderIds,
      installedProviderPresets,
    ),
  };
  if (marketplaceProviderPresetId) {
    prunedLlm.marketplaceProviderPresetId = marketplaceProviderPresetId;
  } else {
    delete prunedLlm.marketplaceProviderPresetId;
  }

  return {
    llm: prunedLlm,
    installedProviderIds: inferredInstalledProviderIds,
  };
}

function uniqueValidList<T extends string>(
  values: unknown,
  isValid: (value: unknown) => value is T,
): T[] {
  if (!Array.isArray(values)) return [];
  const result: T[] = [];
  for (const value of values) {
    if (!isValid(value)) continue;
    if (result.includes(value)) continue;
    result.push(value);
  }
  return result;
}

function uniqueValidProviderPresets(value: unknown): MarketplaceInstalledProviderPreset[] {
  if (!Array.isArray(value)) return [];
  const result: MarketplaceInstalledProviderPreset[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const preset = normalizeMarketplaceProviderPreset(raw);
    if (!preset || seen.has(preset.providerId)) continue;
    seen.add(preset.providerId);
    result.push(preset);
  }
  return result;
}

function removedMarketplaceProviderPresetIds(
  previous: readonly MarketplaceInstalledProviderPreset[],
  next: readonly MarketplaceInstalledProviderPreset[],
): string[] {
  const nextIds = new Set(next.map((preset) => preset.providerId));
  return previous
    .map((preset) => preset.providerId)
    .filter((providerId) => !nextIds.has(providerId));
}

export function marketplaceProviderPresetSecretInvalidationIds(
  previous: readonly MarketplaceInstalledProviderPreset[],
  next: readonly MarketplaceInstalledProviderPreset[],
): string[] {
  const ids = new Set(removedMarketplaceProviderPresetIds(previous, next));
  const previousById = new Map(previous.map((preset) => [preset.providerId, preset]));
  for (const nextPreset of next) {
    const previousPreset = previousById.get(nextPreset.providerId);
    if (!previousPreset) continue;
    if (
      previousPreset.baseUrl !== nextPreset.baseUrl ||
      previousPreset.requiresApiKey !== nextPreset.requiresApiKey
    ) {
      ids.add(nextPreset.providerId);
    }
  }
  return [...ids];
}

export function preserveInstalledProviderPresetMetadata(
  previous: readonly MarketplaceInstalledProviderPreset[],
  next: readonly MarketplaceInstalledProviderPreset[],
): MarketplaceInstalledProviderPreset[] {
  const previousById = new Map(previous.map((preset) => [preset.providerId, preset]));
  return next.map((preset) => previousById.get(preset.providerId) ?? preset);
}

export function normalizeMarketplace(input: unknown): MarketplaceSettings {
  const raw = input && typeof input === "object" && !Array.isArray(input)
    ? (input as Partial<MarketplaceSettings>)
    : {};
  const merged: MarketplaceSettings = {
    ...DEFAULT_SETTINGS.marketplace,
    ...raw,
    backend: "real-cloud",
  };
  if (typeof raw.cloudBaseUrl === "string") {
    const trimmed = raw.cloudBaseUrl.trim();
    merged.cloudBaseUrl = trimmed || DEFAULT_SETTINGS.marketplace.cloudBaseUrl;
  } else {
    merged.cloudBaseUrl = DEFAULT_SETTINGS.marketplace.cloudBaseUrl;
  }
  merged.cloudAllowPrivateNetwork = typeof raw.cloudAllowPrivateNetwork === "boolean"
    ? raw.cloudAllowPrivateNetwork
    : DEFAULT_SETTINGS.marketplace.cloudAllowPrivateNetwork;
  merged.installedProviderIds = uniqueValidList(
    raw.installedProviderIds,
    isMarketplaceEligibleLLMVendor,
  );
  merged.installedProviderPresets = uniqueValidProviderPresets(
    raw.installedProviderPresets,
  );
  merged.installedThemeBundleIds = uniqueValidList(
    raw.installedThemeBundleIds,
    isMarketplaceEligibleThemeBundleId,
  );
  merged.installedLanguagePacks = uniqueValidList(
    raw.installedLanguagePacks,
    isMarketplaceEligibleLocale,
  );
  return merged;
}

/**
 * UX Track 3 — coerce on-disk `appearance` block into AppearanceSettings v2.
 *
 * Detects whether the on-disk value is v1 (has `theme`/`chatTheme`/`codeTheme`)
 * or v2 (has `schemaVersion: 2`). v1 inputs are migrated; v2 inputs are
 * validated and returned as-is. Unknown bundleId falls back to DEFAULT_BUNDLE_ID.
 *
 * Settings load must never crash boot over a UI-only field.
 */

/** @internal — v1 legacy axis validation sets, used in migration only. */
const VALID_THEMES_V1: readonly ThemePreference[] = ["system", "light", "dark", "high-contrast"];
const VALID_CHAT_THEMES_V1: readonly ChatThemePreference[] = ["default", "lg", "purple", "orange", "blue"];

/** All valid bundle IDs — §C3: single source from src/shared/theme-bundles.ts. */
const VALID_BUNDLE_IDS: readonly string[] = BUNDLE_IDS;

/**
 * Migrate a v1 tri-axis appearance object to a v2 bundleId.
 *
 * Migration matrix (12 cases, per spec §3):
 *  dark + default/auto  → tokyo-night
 *  dark + lg            → violet-dark
 *  light + default/auto → forest
 *  light + lg           → violet-light
 *  system + default     → DEFAULT_BUNDLE_ID (renderer may apply followSystem)
 *  system + lg          → violet-dark + followSystem:true (renderer tracks OS scheme)
 *  * + purple|orange|blue → midnight (closest dark accent coercion)
 *  high-contrast + *    → high-contrast (HC always wins)
 *  code override (dark+default+light / light+default+dark) → bundle wins, code override ignored
 *  dark + lg + dark     → violet-dark
 *  invalid/unknown      → DEFAULT_BUNDLE_ID
 *
 * Note: "system" is intentionally NOT resolved via window.matchMedia here.
 * This function runs in the Electron main process where `window` is undefined.
 * System-theme users get DEFAULT_BUNDLE_ID (or violet-dark+followSystem),
 * and the renderer's followSystem toggle can track the OS scheme from there.
 */
function migrateAppearanceV1ToV2(
  legacy: AppearanceSettingsV1,
): AppearanceSettings {
  const theme = VALID_THEMES_V1.includes(legacy.theme) ? legacy.theme : "system";
  const chatTheme = VALID_CHAT_THEMES_V1.includes(legacy.chatTheme) ? legacy.chatTheme : "default";

  // High-contrast always wins — accessibility first.
  if (theme === "high-contrast") {
    return { schemaVersion: 2, bundleId: "high-contrast" };
  }

  // Accent-only chat themes (purple/orange/blue) → midnight (closest dark accent).
  if (chatTheme === "purple" || chatTheme === "orange" || chatTheme === "blue") {
    return { schemaVersion: 2, bundleId: "midnight" };
  }

  // Violet pair (migrated from legacy "lg" chat theme).
  if (chatTheme === "lg") {
    if (theme === "light") return { schemaVersion: 2, bundleId: "violet-light" };
    if (theme === "dark")  return { schemaVersion: 2, bundleId: "violet-dark" };
    // system: default to violet-dark; renderer followSystem will track OS from here.
    return { schemaVersion: 2, bundleId: "violet-dark", followSystem: true };
  }

  // Default chat (no overlay) — preserve explicit legacy shell; "system" → DEFAULT.
  if (theme === "light") return { schemaVersion: 2, bundleId: "forest" };
  if (theme === "dark")  return { schemaVersion: 2, bundleId: "tokyo-night" };

  // system or unknown → DEFAULT_BUNDLE_ID
  return { schemaVersion: 2, bundleId: DEFAULT_BUNDLE_ID };
}

export const appearanceMigration = Object.freeze({
  migrateV1ToV2: migrateAppearanceV1ToV2,
});

export function normalizeAppearance(input: unknown): AppearanceSettings {
  if (!input || typeof input !== "object") {
    return { ...DEFAULT_SETTINGS.appearance };
  }
  const obj = input as Record<string, unknown>;

  // v2 path — schemaVersion:2 present.
  if (obj.schemaVersion === 2) {
    // Retired bundle IDs from earlier internal builds are not migrated:
    // the open-source release has no install base that would carry them
    // forward. Unknown bundleIds fall through to DEFAULT_BUNDLE_ID by
    // the VALID_BUNDLE_IDS gate below.
    const rawBundleId = typeof obj.bundleId === "string" ? obj.bundleId : "";
    const bundleId =
      VALID_BUNDLE_IDS.includes(rawBundleId)
        ? rawBundleId
        : DEFAULT_BUNDLE_ID;
    const followSystem = typeof obj.followSystem === "boolean" ? obj.followSystem : undefined;
    const result: AppearanceSettings = {
      schemaVersion: 2,
      bundleId,
      // Coerce any stored/legacy value to a supported locale; missing →
      // English default for the global build.
      language: normalizeLocale(obj.language),
    };
    if (followSystem !== undefined) result.followSystem = followSystem;
    const font = normalizeAppearanceFont(obj.font);
    if (font) result.font = font;
    return result;
  }

  // v1 path — has legacy keys.
  if (typeof obj.theme === "string" || typeof obj.chatTheme === "string" || typeof obj.codeTheme === "string") {
    const legacy: AppearanceSettingsV1 = {
      theme: (typeof obj.theme === "string" && (VALID_THEMES_V1 as readonly string[]).includes(obj.theme)
        ? obj.theme : "system") as ThemePreference,
      chatTheme: (typeof obj.chatTheme === "string" && (VALID_CHAT_THEMES_V1 as readonly string[]).includes(obj.chatTheme)
        ? obj.chatTheme : "default") as ChatThemePreference,
      codeTheme: (typeof obj.codeTheme === "string" ? obj.codeTheme : "auto") as CodeThemePreference,
    };
    // Preserve any stored language across the v1→v2 migration; default English.
    return { ...migrateAppearanceV1ToV2(legacy), language: normalizeLocale(obj.language) };
  }

  return { ...DEFAULT_SETTINGS.appearance };
}

function normalizeAppearanceFont(input: unknown): AppearanceFontSettings | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const o = input as Record<string, unknown>;
  const out: AppearanceFontSettings = {};
  if (typeof o.family === "string") {
    if (o.family === "system") {
      out.family = "system";
    } else if (isValidFontFamilyOverride(o.family)) {
      out.family = o.family;
    }
  }
  if (typeof o.sizeScale === "number"
    && (FONT_SIZE_SCALE_VALUES as readonly number[]).includes(o.sizeScale)) {
    out.sizeScale = o.sizeScale as FontSizeScale;
  }
  // Empty object → treat as undefined so defaults serialize cleanly.
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * §B1 / Critic F4 mitigation — coerce on-disk `webView` block back to
 * the WebViewSettings shape.
 *
 * If the field is missing entirely (existing installs), apply the default
 * `"in-app"`. If a *partial-but-invalid* value is on disk (e.g. user hand-
 * edited to `"yes"`, `null`, `42`), only that field is replaced with the
 * default — the rest of settings.json is preserved by the normal per-section
 * spread pattern in loadSettings(). A warn log emits once per load so a
 * silent corruption is still observable.
 */
const VALID_WEBVIEW_FLOWS: readonly WebViewPreferredFlow[] = ["in-app", "system-browser"];

export function normalizeWebView(input: unknown): WebViewSettings {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ...DEFAULT_SETTINGS.webView };
  }
  const obj = input as { preferredFlow?: unknown };
  const raw = obj.preferredFlow;
  if (typeof raw === "string" && (VALID_WEBVIEW_FLOWS as readonly string[]).includes(raw)) {
    return { preferredFlow: raw as WebViewPreferredFlow };
  }
  if (raw !== undefined) {
    log.warn(
      `webView.preferredFlow invalid (received ${JSON.stringify(raw)}), using default %s`,
      DEFAULT_SETTINGS.webView.preferredFlow,
    );
  }
  return { ...DEFAULT_SETTINGS.webView };
}

export const VALID_CLOSE_BEHAVIORS: readonly SystemCloseBehavior[] = ["hide-to-tray", "quit"];

const MAX_PINNED_PROJECT_ROOTS = 200;

/**
 * De-duplicates, trims, and caps a pinned-project-roots list on both the
 * patch and normalize paths. De-dup keys on `projectRootKey` (the same
 * case/slash-insensitive root-identity SoT the sidebar's pin lookup uses via
 * `projectRootEquals`) rather than raw string equality, so e.g.
 * "C:\\ws\\alpha" and "c:/ws/alpha/" are recognized as the same pinned root
 * instead of accumulating as separate list entries.
 */
export function normalizePinnedProjectRoots(raw: unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    const key = projectRootKey(trimmed) ?? trimmed;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= MAX_PINNED_PROJECT_ROOTS) break;
  }
  return out;
}

/**
 * The per-tab-kind vertical-split percent keys, iterated identically in the
 * update-patch and normalize paths so a new split-bearing tab kind is added in
 * exactly one place. `satisfies` pins each entry to a real `SystemSettings`
 * field, so a typo can never silently no-op.
 */
export const SIDE_PANEL_SPLIT_KEYS = [
  "sidePanelSplitFilePercent",
  "sidePanelSplitPreviewPercent",
  "sidePanelSplitSubagentPercent",
] as const satisfies readonly (keyof SystemSettings)[];

export function normalizeSystem(input: unknown): SystemSettings {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ...DEFAULT_SETTINGS.system };
  }
  const obj = input as {
    closeBehavior?: unknown;
    appMode?: unknown;
    localApiServer?: unknown;
    launchAtStartup?: unknown;
    launchMinimized?: unknown;
    sidePanelWidth?: unknown;
    sidebarWidth?: unknown;
    sidebarActiveTab?: unknown;
    pinnedProjectRoots?: unknown;
  } & Record<(typeof SIDE_PANEL_SPLIT_KEYS)[number], unknown>;
  // Each field is normalized independently: a missing/invalid field falls
  // back to its default while a valid sibling is preserved (mirrors the
  // per-field patch path in `update`).
  const result: SystemSettings = { ...DEFAULT_SETTINGS.system };
  const rawBehavior = obj.closeBehavior;
  if (
    typeof rawBehavior === "string" &&
    (VALID_CLOSE_BEHAVIORS as readonly string[]).includes(rawBehavior)
  ) {
    result.closeBehavior = rawBehavior as SystemCloseBehavior;
  } else if (rawBehavior !== undefined) {
    log.warn(
      `system.closeBehavior invalid (received ${JSON.stringify(rawBehavior)}), using default %s`,
      DEFAULT_SETTINGS.system.closeBehavior,
    );
  }
  const rawAppMode = obj.appMode;
  const normalizedAppMode = normalizeAppMode(rawAppMode);
  if (normalizedAppMode !== null) {
    result.appMode = normalizedAppMode;
  } else if (rawAppMode !== undefined) {
    log.warn(
      `system.appMode invalid (received ${JSON.stringify(rawAppMode)}), using default %s`,
      DEFAULT_SETTINGS.system.appMode,
    );
  }
  const rawLocalApi = obj.localApiServer;
  if (typeof rawLocalApi === "boolean") {
    result.localApiServer = rawLocalApi;
  } else if (rawLocalApi !== undefined) {
    log.warn(
      `system.localApiServer invalid (received ${JSON.stringify(rawLocalApi)}), using default %s`,
      DEFAULT_SETTINGS.system.localApiServer,
    );
  }
  const rawLaunchAtStartup = obj.launchAtStartup;
  if (typeof rawLaunchAtStartup === "boolean") {
    result.launchAtStartup = rawLaunchAtStartup;
  } else if (rawLaunchAtStartup !== undefined) {
    log.warn(
      `system.launchAtStartup invalid (received ${JSON.stringify(rawLaunchAtStartup)}), using default %s`,
      DEFAULT_SETTINGS.system.launchAtStartup,
    );
  }
  const rawLaunchMinimized = obj.launchMinimized;
  if (typeof rawLaunchMinimized === "boolean") {
    result.launchMinimized = rawLaunchMinimized;
  } else if (rawLaunchMinimized !== undefined) {
    log.warn(
      `system.launchMinimized invalid (received ${JSON.stringify(rawLaunchMinimized)}), using default %s`,
      DEFAULT_SETTINGS.system.launchMinimized,
    );
  }
  const rawSidePanelWidth = obj.sidePanelWidth;
  if (typeof rawSidePanelWidth === "number" && Number.isFinite(rawSidePanelWidth)) {
    result.sidePanelWidth = Math.max(SIDE_PANEL_MIN_WIDTH, Math.round(rawSidePanelWidth));
  } else if (rawSidePanelWidth !== undefined) {
    log.warn(
      `system.sidePanelWidth invalid (received ${JSON.stringify(rawSidePanelWidth)}), using default %s`,
      SIDE_PANEL_DEFAULT_WIDTH,
    );
  }
  const rawSidebarWidth = obj.sidebarWidth;
  if (typeof rawSidebarWidth === "number" && Number.isFinite(rawSidebarWidth)) {
    result.sidebarWidth = clampSidebarWidth(rawSidebarWidth);
  } else if (rawSidebarWidth !== undefined) {
    log.warn(
      `system.sidebarWidth invalid (received ${JSON.stringify(rawSidebarWidth)}), using default %s`,
      SIDEBAR_DEFAULT_WIDTH,
    );
  }
  for (const key of SIDE_PANEL_SPLIT_KEYS) {
    const raw = obj[key];
    if (typeof raw === "number" && Number.isFinite(raw)) {
      result[key] = clampSidePanelSplitPercent(raw);
    } else if (raw !== undefined) {
      log.warn(
        `system.${key} invalid (received ${JSON.stringify(raw)}), using default %s`,
        SIDE_PANEL_SPLIT_DEFAULT_PERCENT,
      );
    }
  }
  const rawSidebarActiveTab = obj.sidebarActiveTab;
  if (isSidebarTab(rawSidebarActiveTab)) {
    result.sidebarActiveTab = rawSidebarActiveTab;
  } else if (rawSidebarActiveTab !== undefined) {
    log.warn(
      `system.sidebarActiveTab invalid (received ${JSON.stringify(rawSidebarActiveTab)}), using default %s`,
      DEFAULT_SETTINGS.system.sidebarActiveTab,
    );
  }
  const rawPinnedProjectRoots = obj.pinnedProjectRoots;
  if (Array.isArray(rawPinnedProjectRoots)) {
    result.pinnedProjectRoots = normalizePinnedProjectRoots(rawPinnedProjectRoots);
  } else if (rawPinnedProjectRoots !== undefined) {
    log.warn(
      `system.pinnedProjectRoots invalid (received ${JSON.stringify(rawPinnedProjectRoots)}), using default %s`,
      DEFAULT_SETTINGS.system.pinnedProjectRoots,
    );
  }
  return result;
}

/**
 * Coerce on-disk `features` block to FeatureFlags shape.
 * Missing or invalid fields are silently dropped, so each flag falls back to
 * its value in DEFAULT_SETTINGS.features.
 */
/**
 * Coerce on-disk / patch `diagnostics` block to DiagnosticsSettings.
 * Invalid fields fall back to DEFAULT_SETTINGS.diagnostics; logRetentionDays is
 * clamped to [LOG_RETENTION_MIN_DAYS, LOG_RETENTION_MAX_DAYS] via the shared SOT
 * (a non-integer or out-of-range value can never persist).
 */
export function normalizeDiagnostics(input: unknown): DiagnosticsSettings {
  const base = DEFAULT_SETTINGS.diagnostics;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ...base };
  }
  const obj = input as Record<string, unknown>;
  const result: DiagnosticsSettings = { ...base };
  if (typeof obj.includeCrashDumps === "boolean") {
    result.includeCrashDumps = obj.includeCrashDumps;
  }
  if (typeof obj.logRetentionDays === "number" && Number.isInteger(obj.logRetentionDays)) {
    result.logRetentionDays = clampLogRetentionDays(obj.logRetentionDays);
  }
  return result;
}

export function normalizeA2ARemote(input: unknown): A2ARemoteSettings {
  const result = structuredClone(DEFAULT_SETTINGS.a2aRemote);
  if (!input || typeof input !== "object" || Array.isArray(input)) return result;
  const value = input as Record<string, unknown>;
  if (typeof value.routeControlBaseUrl === "string") {
    try {
      const url = new URL(value.routeControlBaseUrl);
      // Route-control snapshots bind canonical URL bytes. Require serializer
      // identity (including the root slash) instead of silently rewriting a
      // near-canonical value that would later compare unequal on the wire.
      if (url.protocol === "https:" && !url.port && !url.username && !url.password && !url.search && !url.hash && !value.routeControlBaseUrl.includes("?") && !value.routeControlBaseUrl.includes("#") && isIP(url.hostname) === 0 && url.hostname !== "localhost" && !url.hostname.endsWith(".localhost")
        && (url.pathname === "/" || url.pathname === "") && url.toString() === value.routeControlBaseUrl) result.routeControlBaseUrl = value.routeControlBaseUrl;
    } catch { /* invalid remains fail-closed empty */ }
  }
  if (isCanonicalA2APublicHttpsOrigin(value.receiverPublicOrigin)) {
    result.receiverPublicOrigin = value.receiverPublicOrigin;
  }
  for (const field of ["outboundCallerGenerationId", "receiverCallerGenerationId"] as const) {
    if (typeof value[field] === "string" && /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,255}$/.test(value[field])) result[field] = value[field];
  }
  if (typeof value.extensionSpecDigestSha256 === "string" && /^[a-f0-9]{64}$/.test(value.extensionSpecDigestSha256)) result.extensionSpecDigestSha256 = value.extensionSpecDigestSha256;
  if (Number.isSafeInteger(value.receiverMaxKeysPerGeneration) && (value.receiverMaxKeysPerGeneration as number) >= 1 && (value.receiverMaxKeysPerGeneration as number) <= 10_000) result.receiverMaxKeysPerGeneration = value.receiverMaxKeysPerGeneration as number;
  if (Array.isArray(value.targets) && value.targets.length <= 64) {
    const unique = new Set<string>();
    result.targets = value.targets.flatMap((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const candidate = entry as Record<string, unknown>;
      if (!Number.isSafeInteger(candidate.targetAgentId) || (candidate.targetAgentId as number) <= 0
        || typeof candidate.label !== "string" || candidate.label.trim() !== candidate.label || candidate.label.length < 1 || candidate.label.length > 80
        || typeof candidate.interfaceUrl !== "string"
        || typeof candidate.agentCardDigestSha256 !== "string" || !/^[a-f0-9]{64}$/.test(candidate.agentCardDigestSha256)
        || !Number.isSafeInteger(candidate.trustKeyId) || (candidate.trustKeyId as number) <= 0
        || !Number.isSafeInteger(candidate.credentialBindingId) || (candidate.credentialBindingId as number) <= 0
        || !Number.isSafeInteger(candidate.routePolicyVersion) || (candidate.routePolicyVersion as number) <= 0
        || typeof candidate.routePolicyDigestSha256 !== "string" || !/^[a-f0-9]{64}$/.test(candidate.routePolicyDigestSha256)
        || !Number.isSafeInteger(candidate.intendedCredentialRevisionId) || (candidate.intendedCredentialRevisionId as number) <= 0) return [];
      const replayCredentialRevisionIds = candidate.replayCredentialRevisionIds === undefined
        ? []
        : Array.isArray(candidate.replayCredentialRevisionIds)
          && candidate.replayCredentialRevisionIds.length <= 16
          && candidate.replayCredentialRevisionIds.every((revision) => Number.isSafeInteger(revision) && (revision as number) > 0)
          && new Set(candidate.replayCredentialRevisionIds).size === candidate.replayCredentialRevisionIds.length
          && !candidate.replayCredentialRevisionIds.includes(candidate.intendedCredentialRevisionId)
          ? candidate.replayCredentialRevisionIds as number[]
          : null;
      if (!replayCredentialRevisionIds) return [];
      try {
        const url = new URL(candidate.interfaceUrl);
        if (url.protocol !== "https:" || url.port || url.username || url.password || url.hash || isIP(url.hostname) !== 0 || url.hostname === "localhost" || url.hostname.endsWith(".localhost") || url.toString() !== candidate.interfaceUrl) return [];
      } catch { return []; }
      const key = String(candidate.targetAgentId);
      if (unique.has(key)) return [];
      unique.add(key);
      return [{
        targetAgentId: candidate.targetAgentId as number,
        label: candidate.label,
        interfaceUrl: candidate.interfaceUrl,
        agentCardDigestSha256: candidate.agentCardDigestSha256,
        trustKeyId: candidate.trustKeyId as number,
        credentialBindingId: candidate.credentialBindingId as number,
        routePolicyVersion: candidate.routePolicyVersion as number,
        routePolicyDigestSha256: candidate.routePolicyDigestSha256,
        intendedCredentialRevisionId: candidate.intendedCredentialRevisionId as number,
        replayCredentialRevisionIds: [...replayCredentialRevisionIds],
      }];
    });
  }
  return result;
}

export function normalizeFeatureFlags(input: unknown): FeatureFlags {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }
  const obj = input as Record<string, unknown>;
  const result: FeatureFlags = {};
  if (typeof obj.idlePreferenceRefresh === "boolean") {
    result.idlePreferenceRefresh = obj.idlePreferenceRefresh;
  }
  if (typeof obj.subAgentAutonomousWake === "boolean") {
    result.subAgentAutonomousWake = obj.subAgentAutonomousWake;
  }
  if (typeof obj.a2aLoopbackServer === "boolean") {
    result.a2aLoopbackServer = obj.a2aLoopbackServer;
  }
  if (typeof obj.a2aRemoteRouting === "boolean") result.a2aRemoteRouting = obj.a2aRemoteRouting;
  if (typeof obj.a2aRemoteReceiver === "boolean") result.a2aRemoteReceiver = obj.a2aRemoteReceiver;
  if (typeof obj.onboardingCompleted === "boolean") {
    result.onboardingCompleted = obj.onboardingCompleted;
  }
  if (typeof obj.hostClassifiesRisk === "boolean") {
    result.hostClassifiesRisk = obj.hostClassifiesRisk;
  }
  if (typeof obj.osToolSandbox === "boolean") {
    result.osToolSandbox = obj.osToolSandbox;
  }
  return result;
}

export function sanitizeStoredPluginConfigs(input: unknown): Record<string, PluginConfigRecord> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }
  const out: Record<string, PluginConfigRecord> = {};
  for (const [pluginId, config] of Object.entries(input)) {
    try {
      const safePluginId = sanitizePluginConfigPluginId(pluginId);
      out[safePluginId] = sanitizePluginConfig(config);
    } catch (err) {
      log.warn(
        "dropping invalid stored plugin config: %s",
        (err as Error).message,
      );
    }
  }
  return out;
}
