import type { LvisHostMarketplaceApi } from "./types.js";

let claimedMarketplaceApi: LvisHostMarketplaceApi | null | undefined;

function claimMarketplaceApi(): LvisHostMarketplaceApi | null {
  if (claimedMarketplaceApi !== undefined) {
    return claimedMarketplaceApi;
  }
  claimedMarketplaceApi = window.lvisHost?.takePluginMarketplaceApi() ?? null;
  return claimedMarketplaceApi;
}

export function primeHostMarketplaceApi(): void {
  claimMarketplaceApi();
}

export function getHostMarketplaceApi(): LvisHostMarketplaceApi {
  const api = claimMarketplaceApi();
  if (!api) {
    throw new Error("Host marketplace API unavailable");
  }
  return api;
}
