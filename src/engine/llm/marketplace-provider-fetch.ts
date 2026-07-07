import { fetchPublicHttpResponse } from "../../core/network-guard.js";
import type { MarketplaceInstalledProviderPreset } from "../../shared/marketplace-package-assets.js";

function sameOriginScopeFor(value: string): false | ((url: URL) => boolean) {
  try {
    const origin = new URL(value).origin;
    return (candidate) => candidate.origin === origin;
  } catch {
    return false;
  }
}

function fetchInputUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function requestInitFromFetchInput(
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
): RequestInit | undefined {
  if (!(typeof Request !== "undefined" && input instanceof Request)) {
    return init;
  }
  const requestInit: RequestInit = {
    method: input.method,
    headers: input.headers,
    signal: input.signal,
    ...init,
  };
  if (input.body && init?.body === undefined) {
    Object.assign(requestInit, {
      body: input.body,
      duplex: "half",
    });
  }
  return requestInit;
}

export function createGuardedMarketplaceProviderFetch(
  baseUrl: string,
  preset: MarketplaceInstalledProviderPreset,
  fetchImpl: typeof fetch = fetch,
): typeof fetch {
  const allowLoopback =
    preset.requiresApiKey === false ? sameOriginScopeFor(baseUrl) : false;

  return (input, init) =>
    fetchPublicHttpResponse(fetchInputUrl(input), {
      ...requestInitFromFetchInput(input, init),
      allowLoopback,
      fetchImpl,
      maxRedirects: 0,
    });
}
