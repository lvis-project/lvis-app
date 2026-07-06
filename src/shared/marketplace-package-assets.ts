import {
  isMarketplaceEligibleLocale,
  type MarketplaceEligibleLocale,
} from "../i18n/locale.js";
import {
  isMarketplacePackageType,
  type MarketplacePackageType,
} from "./assistant-context.js";
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
}

export interface MarketplaceInstalledProviderPreset {
  providerId: string;
  label: string;
  baseUrl: string;
  apiKeyPlaceholder?: string;
  defaultModel: string;
  modelOptions: string[];
  requiresApiKey: boolean;
}

export type MarketplacePackageAsset =
  | MarketplaceProviderPackageAsset
  | { type: "theme"; bundleId: MarketplaceEligibleThemeBundleId }
  | { type: "language-pack"; locale: MarketplaceEligibleLocale };

export type MarketplacePackageAssetType = MarketplacePackageAsset["type"];

const MARKETPLACE_PROVIDER_PRESET_SECRET_ID_PREFIX = "marketplace-provider:";
const MARKETPLACE_PROVIDER_PRESET_SECRET_KEY_PREFIX = "llm.marketplaceProvider.";
const MAX_PROVIDER_ID_LENGTH = 80;
const MAX_PROVIDER_LABEL_LENGTH = 80;
const MAX_PROVIDER_URL_LENGTH = 512;
const MAX_PROVIDER_MODEL_LENGTH = 256;
const MAX_PROVIDER_MODEL_OPTIONS = 100;

export function isMarketplaceProviderPresetId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_PROVIDER_ID_LENGTH &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
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
  if (!baseUrl || !defaultModel) return undefined;
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
  const normalizedOptions = modelOptions.includes(defaultModel)
    ? modelOptions
    : [defaultModel, ...modelOptions];
  return {
    label,
    baseUrl,
    ...(apiKeyPlaceholder ? { apiKeyPlaceholder } : {}),
    defaultModel,
    modelOptions: normalizedOptions,
    requiresApiKey,
  };
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
  if (value === "language") return "language-pack";
  if (
    isMarketplacePackageType(value) &&
    (value === "provider" || value === "theme" || value === "language-pack")
  ) {
    return value;
  }
  return undefined;
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
  const fields = providerPresetFieldsFromRecord(id, metadata);
  return fields ? { type: "provider", providerId: id, ...fields } : undefined;
}

function themeAsset(bundleId: unknown): MarketplacePackageAsset | undefined {
  return isMarketplaceEligibleThemeBundleId(bundleId)
    ? { type: "theme", bundleId }
    : undefined;
}

function languagePackAsset(locale: unknown): MarketplacePackageAsset | undefined {
  return isMarketplaceEligibleLocale(locale)
    ? { type: "language-pack", locale }
    : undefined;
}

export function assetFromMarketplacePackageSpec(
  pluginType: MarketplacePackageType | undefined,
  packageSpec: string,
): MarketplacePackageAsset | undefined {
  const separatorIndex = packageSpec.indexOf(":");
  if (separatorIndex <= 0) return undefined;

  const prefix = packageSpec.slice(0, separatorIndex);
  const value = packageSpec.slice(separatorIndex + 1);
  const type = pluginType === undefined
    ? normalizeAssetType(prefix)
    : normalizeAssetType(pluginType);

  if (!type || prefix !== type) return undefined;
  if (type === "provider") return providerAsset(value);
  if (type === "theme") return themeAsset(value);
  return languagePackAsset(value);
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
    ) ?? (packageSpec
      ? assetFromMarketplacePackageSpec(type, packageSpec)
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
  ) ?? (packageSpec
    ? assetFromMarketplacePackageSpec(type, packageSpec)
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

  return assetFromMarketplacePackageSpec(pluginType, packageSpec);
}
