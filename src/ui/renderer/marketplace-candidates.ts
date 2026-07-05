import { assetFromMarketplacePackageSpec } from "../../shared/marketplace-package-assets.js";
import { LOCAL_MARKETPLACE_ASSET_ENTRIES } from "./marketplace-asset-registry.js";
import type { MarketplaceItem } from "./types.js";

function candidateKey(item: Pick<MarketplaceItem, "id" | "packageSpec" | "pluginType">): string {
  return `${item.pluginType ?? "plugin"}:${item.packageSpec || item.id}`;
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
  ...LOCAL_MARKETPLACE_ASSET_ENTRIES.map((entry) => ({
    id: entry.id,
    name: entry.name,
    description: entry.description,
    packageSpec: entry.packageSpec,
    installed: false,
    enabled: false,
    pluginType: entry.packageType,
    packageAsset: entry.asset,
  })),
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
