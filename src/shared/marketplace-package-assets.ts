import {
  isMarketplaceEligibleLocale,
  type MarketplaceEligibleLocale,
} from "../i18n/locale.js";
import {
  type MarketplacePackageType,
} from "./assistant-context.js";
import {
  isMarketplaceAssetPackageType,
} from "./marketplace-package-sections.js";
import {
  isMarketplaceEligibleLLMVendor,
  isLLMVendor,
} from "./llm-vendor-defaults.js";
import {
  isMarketplaceEligibleThemeBundleId,
  type MarketplaceEligibleThemeBundleId,
} from "./theme-bundles.js";

export interface MarketplaceProviderPackageAsset {
  type: "provider";
  providerId: string;
  label?: string;
  baseUrl?: string;
  apiKeyPlaceholder?: string;
  defaultModel?: string;
  modelOptions?: string[];
  requiresApiKey?: boolean;
  modelDiscoveryPolicy?: MarketplaceProviderModelDiscoveryPolicy;
  capabilities?: MarketplaceProviderPackageCapabilities;
  trust?: MarketplaceProviderPackageTrustMetadata;
}

export interface MarketplaceInstalledProviderPreset {
  providerId: string;
  label: string;
  baseUrl: string;
  apiKeyPlaceholder?: string;
  defaultModel: string;
  modelOptions: string[];
  requiresApiKey: boolean;
  modelDiscoveryPolicy?: MarketplaceProviderModelDiscoveryPolicy;
  capabilities?: MarketplaceProviderPackageCapabilities;
  trust?: MarketplaceProviderPackageTrustMetadata;
}

export const MARKETPLACE_PROVIDER_MODEL_DISCOVERY_POLICIES = [
  "static",
  "models-api",
  "openrouter-models-api",
  "manual",
] as const;

export type MarketplaceProviderModelDiscoveryPolicy =
  (typeof MARKETPLACE_PROVIDER_MODEL_DISCOVERY_POLICIES)[number];

export interface MarketplaceProviderPackageCapabilities {
  streaming?: boolean;
  toolCalls?: boolean;
  vision?: boolean;
  reasoning?: boolean;
  localOnly?: boolean;
  reviewerAdapter?: boolean;
}

export interface MarketplaceProviderPackageTrustMetadata {
  credentialUse?: "none" | "optional" | "required";
  networkAccess?: "none" | "local" | "provider-api" | "router-api";
  dataPolicy?: "local-only" | "provider-policy" | "router-policy";
}

export type MarketplaceThemeShellMode = "light" | "dark" | "system";

export interface MarketplaceThemePackageAsset {
  type: "theme";
  bundleId: MarketplaceEligibleThemeBundleId;
  displayName?: string;
  description?: string;
  shellMode?: MarketplaceThemeShellMode;
  compatibilityVersion?: string;
  tokens?: Record<string, string>;
}

export interface MarketplaceLanguagePackPackageAsset {
  type: "language-pack";
  locale: MarketplaceEligibleLocale;
  displayName?: string;
  nativeName?: string;
  englishName?: string;
  catalogVersion?: string;
  messages?: Record<string, string>;
}

export type MarketplacePackageAsset =
  | MarketplaceProviderPackageAsset
  | MarketplaceThemePackageAsset
  | MarketplaceLanguagePackPackageAsset;

export type MarketplacePackageAssetType = MarketplacePackageAsset["type"];

const MARKETPLACE_PROVIDER_PRESET_SECRET_ID_PREFIX = "marketplace-provider:";
const MARKETPLACE_PROVIDER_PRESET_SECRET_KEY_PREFIX = "llm.marketplaceProvider.";
export const MARKETPLACE_PROVIDER_PRESET_ID_MAX_LENGTH = 80;
export const MARKETPLACE_PROVIDER_PRESET_ID_PATTERN_SOURCE = "[A-Za-z0-9][A-Za-z0-9._-]*";
const MAX_PROVIDER_LABEL_LENGTH = 80;
const MAX_PROVIDER_URL_LENGTH = 512;
const MAX_PROVIDER_MODEL_LENGTH = 256;
const MAX_PROVIDER_MODEL_OPTIONS = 100;
const MAX_PACKAGE_METADATA_LENGTH = 256;
const MAX_PACKAGE_METADATA_VALUE_LENGTH = 4_000;
const MAX_THEME_TOKENS = 500;
const MAX_LANGUAGE_MESSAGES = 10_000;
const MARKETPLACE_PROVIDER_PRESET_ID_PATTERN =
  new RegExp(`^${MARKETPLACE_PROVIDER_PRESET_ID_PATTERN_SOURCE}$`);

export function isMarketplaceProviderPresetId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MARKETPLACE_PROVIDER_PRESET_ID_MAX_LENGTH &&
    MARKETPLACE_PROVIDER_PRESET_ID_PATTERN.test(value)
  );
}

function normalizeProviderId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return isMarketplaceProviderPresetId(trimmed) ? trimmed : undefined;
}

function cleanString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) return undefined;
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return undefined;
  return trimmed;
}

function cleanUrl(value: unknown): string | undefined {
  const trimmed = cleanString(value, MAX_PROVIDER_URL_LENGTH);
  if (!trimmed) return undefined;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (url.username || url.password) return undefined;
    return trimmed;
  } catch {
    return undefined;
  }
}

function usesHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function usesLoopbackHttpUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:") return false;

  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  if (hostname === "::1" || hostname === "[::1]") return true;

  const octets = hostname.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every((part) => {
      if (!/^\d+$/.test(part)) return false;
      const value = Number(part);
      return value >= 0 && value <= 255;
    })
  );
}

function isAllowedProviderBaseUrl(value: string, requiresApiKey: boolean): boolean {
  return usesHttpsUrl(value) || (!requiresApiKey && usesLoopbackHttpUrl(value));
}

function cleanModelOptions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const options: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const model = cleanString(raw, MAX_PROVIDER_MODEL_LENGTH);
    if (!model || seen.has(model)) continue;
    seen.add(model);
    options.push(model);
    if (options.length >= MAX_PROVIDER_MODEL_OPTIONS) break;
  }
  return options;
}

function cleanEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return (allowed as readonly string[]).includes(trimmed) ? trimmed as T : undefined;
}

function cleanStringRecord(
  value: unknown,
  maxEntries: number,
  maxValueLength = MAX_PACKAGE_METADATA_LENGTH,
): Record<string, string> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const result: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(record)) {
    const key = cleanString(rawKey, MAX_PACKAGE_METADATA_LENGTH);
    const entryValue = cleanString(rawValue, maxValueLength);
    if (!key || entryValue === undefined) continue;
    result[key] = entryValue;
    if (Object.keys(result).length >= maxEntries) break;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function cleanCapabilities(
  value: unknown,
): MarketplaceProviderPackageCapabilities | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const capabilities: MarketplaceProviderPackageCapabilities = {};
  for (const [field, target] of [
    ["streaming", "streaming"],
    ["toolCalls", "toolCalls"],
    ["tool_calls", "toolCalls"],
    ["vision", "vision"],
    ["reasoning", "reasoning"],
    ["localOnly", "localOnly"],
    ["local_only", "localOnly"],
    ["reviewerAdapter", "reviewerAdapter"],
    ["reviewer_adapter", "reviewerAdapter"],
    ["reviewer", "reviewerAdapter"],
  ] as const) {
    if (typeof record[field] === "boolean") {
      capabilities[target] = record[field];
    }
  }
  return Object.keys(capabilities).length > 0 ? capabilities : undefined;
}

function cleanTrustMetadata(
  value: unknown,
): MarketplaceProviderPackageTrustMetadata | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const credentialUse = cleanEnum(record.credentialUse ?? record.credential_use, [
    "none",
    "optional",
    "required",
  ] as const);
  const networkAccess = cleanEnum(record.networkAccess ?? record.network_access, [
    "none",
    "local",
    "provider-api",
    "router-api",
  ] as const);
  const dataPolicy = cleanEnum(record.dataPolicy ?? record.data_policy, [
    "local-only",
    "provider-policy",
    "router-policy",
  ] as const);
  const trust: MarketplaceProviderPackageTrustMetadata = {};
  if (credentialUse) trust.credentialUse = credentialUse;
  if (networkAccess) trust.networkAccess = networkAccess;
  if (dataPolicy) trust.dataPolicy = dataPolicy;
  return Object.keys(trust).length > 0 ? trust : undefined;
}

function humanizeProviderId(providerId: string): string {
  return providerId
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ") || providerId;
}

function providerPresetFieldsFromRecord(
  providerId: string,
  record: Record<string, unknown>,
): Omit<MarketplaceInstalledProviderPreset, "providerId"> | undefined {
  const label = cleanString(
    record.label ?? record.name ?? record.displayName ?? record.display_name ?? record.providerName ?? record.provider_name,
    MAX_PROVIDER_LABEL_LENGTH,
  ) ?? humanizeProviderId(providerId);
  const baseUrl = cleanUrl(
    record.baseUrl ?? record.base_url ?? record.endpoint ?? record.apiBaseUrl ?? record.api_base_url,
  );
  const modelOptions = cleanModelOptions(
    record.modelOptions ?? record.model_options ?? record.models,
  );
  const defaultModel = cleanString(
    record.defaultModel ?? record.default_model ?? record.model,
    MAX_PROVIDER_MODEL_LENGTH,
  ) ?? modelOptions[0];
  const apiKeyPlaceholder = cleanString(
    record.apiKeyPlaceholder ?? record.api_key_placeholder ?? record.keyPlaceholder ?? record.key_placeholder,
    MAX_PROVIDER_LABEL_LENGTH,
  );
  const requiresApiKey =
    typeof record.requiresApiKey === "boolean"
      ? record.requiresApiKey
      : typeof record.requires_api_key === "boolean"
        ? record.requires_api_key
        : typeof record.apiKeyRequired === "boolean"
          ? record.apiKeyRequired
          : typeof record.api_key_required === "boolean"
            ? record.api_key_required
            : true;
  if (!baseUrl || !defaultModel) return undefined;
  if (!isAllowedProviderBaseUrl(baseUrl, requiresApiKey)) return undefined;
  const normalizedOptions = modelOptions.includes(defaultModel)
    ? modelOptions
    : [defaultModel, ...modelOptions];
  const modelDiscoveryPolicy = cleanEnum(
    record.modelDiscoveryPolicy ??
      record.model_discovery_policy ??
      record.modelDiscovery ??
      record.model_discovery,
    MARKETPLACE_PROVIDER_MODEL_DISCOVERY_POLICIES,
  );
  const capabilities = cleanCapabilities(record.capabilities);
  const trust = cleanTrustMetadata(
    record.trust ?? record.trustMetadata ?? record.trust_metadata,
  );
  return {
    label,
    baseUrl,
    ...(apiKeyPlaceholder ? { apiKeyPlaceholder } : {}),
    defaultModel,
    modelOptions: normalizedOptions,
    requiresApiKey,
    ...(modelDiscoveryPolicy ? { modelDiscoveryPolicy } : {}),
    ...(capabilities ? { capabilities } : {}),
    ...(trust ? { trust } : {}),
  };
}

function providerPackageFieldsFromRecord(
  providerId: string,
  record: Record<string, unknown>,
): Omit<MarketplaceProviderPackageAsset, "type" | "providerId"> | undefined {
  const presetFields = providerPresetFieldsFromRecord(providerId, record);
  if (!presetFields) return undefined;
  return presetFields;
}

export function normalizeMarketplaceProviderPreset(
  value: unknown,
): MarketplaceInstalledProviderPreset | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const providerId = normalizeProviderId(
    record.providerId ?? record.provider_id ?? record.id,
  );
  if (!providerId || isLLMVendor(providerId)) return undefined;
  const fields = providerPresetFieldsFromRecord(providerId, record);
  return fields ? { providerId, ...fields } : undefined;
}

export function marketplaceProviderPresetFromAsset(
  asset: MarketplacePackageAsset | undefined,
  fallbackLabel?: string,
): MarketplaceInstalledProviderPreset | undefined {
  if (!asset || asset.type !== "provider") return undefined;
  if (isLLMVendor(asset.providerId)) return undefined;
  return normalizeMarketplaceProviderPreset({
    ...asset,
    ...(fallbackLabel && !asset.label ? { label: fallbackLabel } : {}),
  });
}

export function marketplaceProviderPresetSecretId(providerId: string): string {
  return `${MARKETPLACE_PROVIDER_PRESET_SECRET_ID_PREFIX}${providerId}`;
}

export function marketplaceProviderPresetIdFromSecretId(
  value: unknown,
): string | undefined {
  if (typeof value !== "string") return undefined;
  if (!value.startsWith(MARKETPLACE_PROVIDER_PRESET_SECRET_ID_PREFIX)) {
    return undefined;
  }
  return normalizeProviderId(
    value.slice(MARKETPLACE_PROVIDER_PRESET_SECRET_ID_PREFIX.length),
  );
}

export function marketplaceProviderPresetSecretKey(providerId: string): string {
  return `${MARKETPLACE_PROVIDER_PRESET_SECRET_KEY_PREFIX}${providerId}.apiKey`;
}

export function marketplaceProviderPresetIdFromSecretKey(
  value: unknown,
): string | undefined {
  if (typeof value !== "string") return undefined;
  if (!value.startsWith(MARKETPLACE_PROVIDER_PRESET_SECRET_KEY_PREFIX)) {
    return undefined;
  }
  if (!value.endsWith(".apiKey")) return undefined;
  return normalizeProviderId(
    value.slice(
      MARKETPLACE_PROVIDER_PRESET_SECRET_KEY_PREFIX.length,
      -".apiKey".length,
    ),
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(
  record: Record<string, unknown>,
  names: readonly string[],
): string | undefined {
  for (const name of names) {
    const value = record[name];
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
}

function normalizeAssetType(
  value: unknown,
): MarketplacePackageAssetType | undefined {
  const normalized: unknown = value === "language" ? "language-pack" : value;
  return isMarketplaceAssetPackageType(normalized) ? normalized : undefined;
}

export function marketplacePackageTypeForAsset(
  asset: MarketplacePackageAsset,
): MarketplacePackageAssetType {
  return asset.type;
}

export function marketplacePackageSpecForAsset(
  asset: MarketplacePackageAsset,
): string {
  if (asset.type === "provider") return `provider:${asset.providerId}`;
  if (asset.type === "theme") return `theme:${asset.bundleId}`;
  return `language-pack:${asset.locale}`;
}

function providerAsset(
  providerId: unknown,
  metadata?: Record<string, unknown>,
): MarketplacePackageAsset | undefined {
  const id = normalizeProviderId(providerId);
  if (!id) return undefined;
  if (isLLMVendor(id)) {
    return isMarketplaceEligibleLLMVendor(id)
      ? { type: "provider", providerId: id }
      : undefined;
  }
  if (!metadata) return undefined;
  const fields = providerPackageFieldsFromRecord(id, metadata);
  return fields ? { type: "provider", providerId: id, ...fields } : undefined;
}

function themeAsset(
  bundleId: unknown,
  metadata?: Record<string, unknown>,
): MarketplaceThemePackageAsset | undefined {
  if (!isMarketplaceEligibleThemeBundleId(bundleId)) return undefined;
  if (!metadata) return { type: "theme", bundleId };
  const displayName = cleanString(
    metadata.displayName ?? metadata.display_name ?? metadata.name,
    MAX_PROVIDER_LABEL_LENGTH,
  );
  const description = cleanString(metadata.description, MAX_PACKAGE_METADATA_LENGTH);
  const shellMode = cleanEnum(metadata.shellMode ?? metadata.shell_mode, [
    "light",
    "dark",
    "system",
  ] as const);
  const compatibilityVersion = cleanString(
    metadata.compatibilityVersion ?? metadata.compatibility_version,
    MAX_PACKAGE_METADATA_LENGTH,
  );
  const tokens = cleanStringRecord(
    metadata.tokens ?? metadata.tokenMap ?? metadata.token_map,
    MAX_THEME_TOKENS,
    MAX_PACKAGE_METADATA_LENGTH,
  );
  return {
    type: "theme",
    bundleId,
    ...(displayName ? { displayName } : {}),
    ...(description ? { description } : {}),
    ...(shellMode ? { shellMode } : {}),
    ...(compatibilityVersion ? { compatibilityVersion } : {}),
    ...(tokens ? { tokens } : {}),
  };
}

function languagePackAsset(
  locale: unknown,
  metadata?: Record<string, unknown>,
): MarketplaceLanguagePackPackageAsset | undefined {
  if (!isMarketplaceEligibleLocale(locale)) return undefined;
  if (!metadata) return { type: "language-pack", locale };
  const displayName = cleanString(
    metadata.displayName ?? metadata.display_name ?? metadata.name,
    MAX_PROVIDER_LABEL_LENGTH,
  );
  const nativeName = cleanString(
    metadata.nativeName ?? metadata.native_name,
    MAX_PROVIDER_LABEL_LENGTH,
  );
  const englishName = cleanString(
    metadata.englishName ?? metadata.english_name,
    MAX_PROVIDER_LABEL_LENGTH,
  );
  const catalogVersion = cleanString(
    metadata.catalogVersion ?? metadata.catalog_version,
    MAX_PACKAGE_METADATA_LENGTH,
  );
  const messages = cleanStringRecord(
    metadata.messages ?? metadata.catalog ?? metadata.message_catalog,
    MAX_LANGUAGE_MESSAGES,
    MAX_PACKAGE_METADATA_VALUE_LENGTH,
  );
  return {
    type: "language-pack",
    locale,
    ...(displayName ? { displayName } : {}),
    ...(nativeName ? { nativeName } : {}),
    ...(englishName ? { englishName } : {}),
    ...(catalogVersion ? { catalogVersion } : {}),
    ...(messages ? { messages } : {}),
  };
}

export function assetFromMarketplacePackageSpec(
  pluginType: MarketplacePackageType | undefined,
  packageSpec: string,
  metadata?: Record<string, unknown>,
): MarketplacePackageAsset | undefined {
  const separatorIndex = packageSpec.indexOf(":");
  if (separatorIndex <= 0) return undefined;

  const prefix = packageSpec.slice(0, separatorIndex);
  const value = packageSpec.slice(separatorIndex + 1);
  const type = pluginType === undefined
    ? normalizeAssetType(prefix)
    : normalizeAssetType(pluginType);

  if (!type || prefix !== type) return undefined;
  if (type === "provider") return providerAsset(value, metadata);
  if (type === "theme") return themeAsset(value, metadata);
  return languagePackAsset(value, metadata);
}

function providerAssetFromMarketplacePackageSpec(
  pluginType: MarketplacePackageType | undefined,
  packageSpec: string,
  metadata: Record<string, unknown>,
): MarketplacePackageAsset | undefined {
  const separatorIndex = packageSpec.indexOf(":");
  if (separatorIndex <= 0) return undefined;
  const prefix = packageSpec.slice(0, separatorIndex);
  const value = packageSpec.slice(separatorIndex + 1);
  const type = pluginType === undefined
    ? normalizeAssetType(prefix)
    : normalizeAssetType(pluginType);
  if (type !== "provider" || prefix !== type) return undefined;
  return providerAsset(value, metadata);
}

export function parseMarketplacePackageAsset(
  value: unknown,
): MarketplacePackageAsset | undefined {
  if (typeof value === "string") {
    return assetFromMarketplacePackageSpec(undefined, value);
  }

  const record = asRecord(value);
  if (!record) return undefined;

  const type = normalizeAssetType(
    record.type ??
      record.kind ??
      record.pluginType ??
      record.plugin_type ??
      record.packageType ??
      record.package_type,
  );
  if (!type) return undefined;
  const packageSpec = stringField(record, ["packageSpec", "package_spec"]);

  if (type === "provider") {
    return providerAsset(
      stringField(record, [
        "providerId",
        "provider_id",
        "vendorId",
        "vendor_id",
        "llmVendorId",
        "llm_vendor_id",
        "id",
      ]),
      record,
    ) ?? (packageSpec
      ? providerAssetFromMarketplacePackageSpec(type, packageSpec, record)
      : undefined);
  }
  if (type === "theme") {
    return themeAsset(
      stringField(record, [
        "bundleId",
        "bundle_id",
        "themeBundleId",
        "theme_bundle_id",
        "id",
      ]),
      record,
    ) ?? (packageSpec
      ? assetFromMarketplacePackageSpec(type, packageSpec, record)
      : undefined);
  }
  return languagePackAsset(
    stringField(record, [
      "locale",
      "languageCode",
      "language_code",
      "language",
      "id",
    ]),
    record,
  ) ?? (packageSpec
    ? assetFromMarketplacePackageSpec(type, packageSpec, record)
    : undefined);
}

export function assetFromMarketplaceCatalogFields(
  pluginType: MarketplacePackageType | undefined,
  packageSpec: string,
  fields?: Record<string, unknown>,
): MarketplacePackageAsset | undefined {
  const type = normalizeAssetType(pluginType);
  if (!type) return undefined;

  const explicit = fields
    ? parseMarketplacePackageAsset(
        fields.packageAsset ?? fields.package_asset ?? fields.asset,
      )
    : undefined;
  if (explicit?.type === type) return explicit;

  if (fields) {
    if (type === "provider") {
      const fromFields = providerAsset(
        stringField(fields, [
          "providerId",
          "provider_id",
          "vendorId",
          "vendor_id",
          "llmVendorId",
          "llm_vendor_id",
        ]),
        fields,
      );
      if (fromFields) return fromFields;
    } else if (type === "theme") {
      const fromFields = themeAsset(
        stringField(fields, [
          "bundleId",
          "bundle_id",
          "themeBundleId",
          "theme_bundle_id",
        ]),
        fields,
      );
      if (fromFields) return fromFields;
    } else {
      const fromFields = languagePackAsset(
        stringField(fields, [
          "locale",
          "languageCode",
          "language_code",
          "language",
        ]),
        fields,
      );
      if (fromFields) return fromFields;
    }
  }

  if (type === "provider") {
    const fromPackageSpec = providerAssetFromMarketplacePackageSpec(
      pluginType,
      packageSpec,
      fields ?? {},
    );
    if (fromPackageSpec) return fromPackageSpec;
  }

  return assetFromMarketplacePackageSpec(pluginType, packageSpec, fields);
}
