import { isLocale, type Locale } from "../i18n/locale.js";
import {
  isMarketplacePackageType,
  type MarketplacePackageType,
} from "./assistant-context.js";
import { isLLMVendor, type LLMVendor } from "./llm-vendor-defaults.js";
import { BUNDLE_IDS, type BundleId } from "./theme-bundles.js";

export type MarketplacePackageAsset =
  | { type: "provider"; providerId: LLMVendor }
  | { type: "theme"; bundleId: BundleId }
  | { type: "language-pack"; locale: Locale };

export type MarketplacePackageAssetType = MarketplacePackageAsset["type"];

const BUNDLE_ID_SET = new Set<string>(BUNDLE_IDS);

export function isThemeBundleId(value: unknown): value is BundleId {
  return typeof value === "string" && BUNDLE_ID_SET.has(value);
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

function providerAsset(providerId: unknown): MarketplacePackageAsset | undefined {
  return isLLMVendor(providerId)
    ? { type: "provider", providerId }
    : undefined;
}

function themeAsset(bundleId: unknown): MarketplacePackageAsset | undefined {
  return isThemeBundleId(bundleId)
    ? { type: "theme", bundleId }
    : undefined;
}

function languagePackAsset(locale: unknown): MarketplacePackageAsset | undefined {
  return isLocale(locale)
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
    ) ?? (packageSpec
      ? assetFromMarketplacePackageSpec(type, packageSpec)
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

  return assetFromMarketplacePackageSpec(pluginType, packageSpec);
}
