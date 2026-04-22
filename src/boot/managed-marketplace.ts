import type { MarketplaceSettings } from "../data/settings-store.js";

export function resolveManagedPluginBootstrap(input: {
  marketplace: Pick<MarketplaceSettings, "backend" | "realCloudBaseUrl">;
  isPackaged: boolean;
}): { enabled: boolean; reason?: string } {
  const { marketplace, isPackaged } = input;
  if (marketplace.backend === "real-cloud") {
    const baseUrl = marketplace.realCloudBaseUrl?.trim();
    if (baseUrl) {
      return { enabled: true };
    }
    return {
      enabled: false,
      reason: "real-cloud backend has no configured base URL",
    };
  }
  if (isPackaged) {
    return {
      enabled: false,
      reason: "packaged apps skip managed bootstrap when using the mock marketplace backend",
    };
  }
  return { enabled: true };
}
