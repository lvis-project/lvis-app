import { LOCALE_INFO, MARKETPLACE_ELIGIBLE_LOCALES } from "../../i18n/index.js";
import type { MarketplacePackageType } from "../../shared/assistant-context.js";
import { assetFromMarketplacePackageSpec } from "../../shared/marketplace-package-assets.js";
import { MARKETPLACE_PROVIDER_VENDORS } from "./constants.js";
import type { MarketplaceItem } from "./types.js";
import { MARKETPLACE_THEME_BUNDLES } from "./theme/bundles/index.js";

function candidateKey(item: Pick<MarketplaceItem, "id" | "packageSpec" | "pluginType">): string {
  return `${item.pluginType ?? "plugin"}:${item.packageSpec || item.id}`;
}

function makeCandidate(
  pluginType: Exclude<MarketplacePackageType, "plugin" | "mcp" | "agent" | "skill">,
  id: string,
  name: string,
  description: string,
  packageSpec: string,
): MarketplaceItem {
  return {
    id,
    name,
    description,
    packageSpec,
    installed: false,
    enabled: false,
    pluginType,
    packageAsset: assetFromMarketplacePackageSpec(pluginType, packageSpec),
  };
}

function withCandidatePackageAsset(item: MarketplaceItem): MarketplaceItem {
  if (item.packageAsset) return item;
  const pluginType = item.pluginType;
  if (
    pluginType !== "provider" &&
    pluginType !== "theme" &&
    pluginType !== "language-pack"
  ) {
    return item;
  }
  const packageAsset = assetFromMarketplacePackageSpec(pluginType, item.packageSpec);
  return packageAsset ? { ...item, packageAsset } : item;
}

export const LOCAL_MARKETPLACE_CANDIDATES: readonly MarketplaceItem[] = Object.freeze([
  ...MARKETPLACE_PROVIDER_VENDORS.map((vendor) =>
    makeCandidate(
      "provider",
      `provider-${vendor.id}`,
      `${vendor.label} Provider`,
      "Provider moved out of the default picker and reserved for marketplace delivery.",
      `provider:${vendor.id}`,
    ),
  ),
  ...MARKETPLACE_THEME_BUNDLES.map((bundle) =>
    makeCandidate(
      "theme",
      `theme-${bundle.id}`,
      `${bundle.name} Theme`,
      "Theme moved out of the default appearance picker and reserved for marketplace delivery.",
      `theme:${bundle.id}`,
    ),
  ),
  ...MARKETPLACE_ELIGIBLE_LOCALES.map((locale) =>
    makeCandidate(
      "language-pack",
      `language-${locale}`,
      `${LOCALE_INFO[locale].nativeName} Language Pack`,
      `${LOCALE_INFO[locale].englishName} UI translations reserved for marketplace delivery.`,
      `language-pack:${locale}`,
    ),
  ),
]);

export function mergeMarketplaceCandidates(
  remoteItems: readonly MarketplaceItem[],
): MarketplaceItem[] {
  const remoteItemsWithAssets = remoteItems.map(withCandidatePackageAsset);
  const remoteKeys = new Set(remoteItemsWithAssets.map(candidateKey));
  const remoteIds = new Set(remoteItemsWithAssets.map((item) => item.id));
  const localOnly = LOCAL_MARKETPLACE_CANDIDATES.filter(
    (item) => !remoteIds.has(item.id) && !remoteKeys.has(candidateKey(item)),
  );
  return [...remoteItemsWithAssets, ...localOnly];
}
