import { LOCALE_INFO, MARKETPLACE_ELIGIBLE_LOCALES } from "../../i18n/index.js";
import {
  marketplacePackageSpecForAsset,
  marketplacePackageTypeForAsset,
  type MarketplacePackageAsset,
  type MarketplacePackageAssetType,
} from "../../shared/marketplace-package-assets.js";
import { MARKETPLACE_PROVIDER_VENDORS } from "./constants.js";
import { MARKETPLACE_THEME_BUNDLES } from "./theme/bundles/index.js";

export interface LocalMarketplaceAssetEntry {
  id: string;
  name: string;
  description: string;
  packageSpec: string;
  packageType: MarketplacePackageAssetType;
  asset: MarketplacePackageAsset;
}

function makeAssetEntry(
  asset: MarketplacePackageAsset,
  id: string,
  name: string,
  description: string,
): LocalMarketplaceAssetEntry {
  return {
    id,
    name,
    description,
    packageSpec: marketplacePackageSpecForAsset(asset),
    packageType: marketplacePackageTypeForAsset(asset),
    asset,
  };
}

const PROVIDER_ASSET_ENTRIES = MARKETPLACE_PROVIDER_VENDORS.map((vendor) =>
  makeAssetEntry(
    { type: "provider", providerId: vendor.id },
    `provider-${vendor.id}`,
    `${vendor.label} Provider`,
    "Provider moved out of the default picker and reserved for marketplace delivery.",
  ),
);

const THEME_ASSET_ENTRIES = MARKETPLACE_THEME_BUNDLES.map((bundle) =>
  makeAssetEntry(
    { type: "theme", bundleId: bundle.id },
    `theme-${bundle.id}`,
    `${bundle.name} Theme`,
    "Theme moved out of the default appearance picker and reserved for marketplace delivery.",
  ),
);

const LANGUAGE_PACK_ASSET_ENTRIES = MARKETPLACE_ELIGIBLE_LOCALES.map((locale) =>
  makeAssetEntry(
    { type: "language-pack", locale },
    `language-${locale}`,
    `${LOCALE_INFO[locale].nativeName} Language Pack`,
    `${LOCALE_INFO[locale].englishName} UI translations reserved for marketplace delivery.`,
  ),
);

export const LOCAL_MARKETPLACE_ASSET_ENTRIES: readonly LocalMarketplaceAssetEntry[] =
  Object.freeze([
    ...PROVIDER_ASSET_ENTRIES,
    ...THEME_ASSET_ENTRIES,
    ...LANGUAGE_PACK_ASSET_ENTRIES,
  ]);
