import { fetchPublicHttpResponse } from "../../core/network-guard.js";
import type { MarketplaceInstalledProviderPreset } from "../../shared/marketplace-package-assets.js";

type GuardedProviderFetchPolicy = {
  origin: string;
  allowInsecureCredentialedHttp: boolean;
};

const guardedProviderFetchPolicies = new WeakMap<Function, GuardedProviderFetchPolicy>();

function sameOriginScopeFor(value: string): false | ((url: URL) => boolean) {
  try {
    const origin = new URL(value).origin;
    return (candidate) => candidate.origin === origin;
  } catch {
    return false;
  }
}

function originFor(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * A configured model-provider base URL is an explicit user trust decision,
 * unlike a URL supplied by tool/model content. Keep private/loopback access
 * constrained to that exact origin so an SDK request cannot pivot to another
 * host or follow a redirect into the local network.
 */
export function configuredModelProviderNetworkAccess(baseUrl: string): {
  allowPrivateNetworks: false | ((url: URL) => boolean);
  allowLoopback: false | ((url: URL) => boolean);
} {
  const sameOrigin = sameOriginScopeFor(baseUrl);
  return {
    allowPrivateNetworks: sameOrigin,
    allowLoopback: sameOrigin,
  };
}

/** Loopback-only access for an explicitly keyless marketplace preset. */
export function configuredModelProviderLoopbackAccess(baseUrl: string): {
  allowPrivateNetworks: false;
  allowLoopback: false | ((url: URL) => boolean);
} {
  return {
    allowPrivateNetworks: false,
    allowLoopback: sameOriginScopeFor(baseUrl),
  };
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

export function createGuardedModelProviderFetch(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): typeof fetch {
  return createOriginLockedProviderFetch(
    baseUrl,
    configuredModelProviderNetworkAccess(baseUrl),
    true,
    fetchImpl,
  );
}

function createOriginLockedProviderFetch(
  baseUrl: string,
  networkAccess: {
    allowPrivateNetworks: false | ((url: URL) => boolean);
    allowLoopback: false | ((url: URL) => boolean);
  },
  allowInsecureCredentialedHttp: boolean,
  fetchImpl: typeof fetch,
): typeof fetch {
  const configuredOrigin = originFor(baseUrl);

  const guardedFetch: typeof fetch = (input, init) => {
    const requestUrl = fetchInputUrl(input);
    let requestOrigin: string | null;
    try {
      requestOrigin = new URL(requestUrl).origin;
    } catch {
      requestOrigin = null;
    }
    if (!configuredOrigin || requestOrigin !== configuredOrigin) {
      return Promise.reject(
        new Error("Configured model provider requests must target the configured origin."),
      );
    }
    return fetchPublicHttpResponse(requestUrl, {
      ...requestInitFromFetchInput(input, init),
      ...networkAccess,
      fetchImpl,
      maxRedirects: 0,
    });
  };
  if (configuredOrigin) {
    guardedProviderFetchPolicies.set(guardedFetch, {
      origin: configuredOrigin,
      allowInsecureCredentialedHttp,
    });
  }
  return guardedFetch;
}

/**
 * Returns true only for a fetch created for this exact origin by the trusted
 * self-hosted provider factory. A caller cannot enable credentialed HTTP with
 * an arbitrary fetch function or a standalone boolean.
 */
export function isGuardedInsecureCredentialedModelProviderFetch(
  baseUrl: string | undefined,
  fetchImpl: typeof fetch | undefined,
): boolean {
  if (!baseUrl || !fetchImpl) return false;
  const policy = guardedProviderFetchPolicies.get(fetchImpl);
  return policy?.allowInsecureCredentialedHttp === true && policy.origin === originFor(baseUrl);
}

/**
 * Marketplace presets retain their original network policy: only explicit
 * keyless presets may reach loopback, and no preset may reach private networks.
 * Every request is nevertheless origin-locked before it reaches NetworkGuard.
 */
export function createGuardedMarketplaceProviderFetch(
  baseUrl: string,
  preset: MarketplaceInstalledProviderPreset,
  fetchImpl: typeof fetch = fetch,
): typeof fetch {
  return createOriginLockedProviderFetch(
    baseUrl,
    preset.requiresApiKey === false
      ? configuredModelProviderLoopbackAccess(baseUrl)
      : { allowPrivateNetworks: false, allowLoopback: false },
    false,
    fetchImpl,
  );
}
