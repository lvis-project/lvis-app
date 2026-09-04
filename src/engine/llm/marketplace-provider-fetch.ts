import { fetchPublicHttpResponse } from "../../core/network-guard.js";
import type { MarketplaceInstalledProviderPreset } from "../../shared/marketplace-package-assets.js";
import {
  isSelfHostedTrustedNetworkVendor,
  type LLMVendor,
} from "../../shared/llm-vendor-defaults.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";

/**
 * The three NetworkGuard axes a provider fetch may open, each already narrowed
 * to the configured origin (or closed outright).
 */
export type ModelProviderNetworkAccess = {
  allowPrivateNetworks: false | ((url: URL) => boolean);
  allowLoopback: false | ((url: URL) => boolean);
  allowCarrierGradeNat: false | ((url: URL) => boolean);
};

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
 * unlike a URL supplied by tool/model content. Keep private/loopback/tailnet
 * access constrained to that exact origin so an SDK request cannot pivot to
 * another host or follow a redirect into the local network.
 *
 * The CGNAT axis is here for the same reason the RFC1918 one is: a self-hosted
 * endpoint the user typed in reaches its host over whatever network that host
 * lives on, and an authenticated overlay (tailnet) hands its peers 100.64/10
 * addresses. Nothing but this saved-endpoint decision opens that range.
 */
export function configuredModelProviderNetworkAccess(baseUrl: string): ModelProviderNetworkAccess {
  const sameOrigin = sameOriginScopeFor(baseUrl);
  return {
    allowPrivateNetworks: sameOrigin,
    allowLoopback: sameOrigin,
    allowCarrierGradeNat: sameOrigin,
  };
}

/** Loopback-only access for an explicitly keyless marketplace preset. */
export function configuredModelProviderLoopbackAccess(baseUrl: string): ModelProviderNetworkAccess {
  return {
    allowPrivateNetworks: false,
    allowLoopback: sameOriginScopeFor(baseUrl),
    allowCarrierGradeNat: false,
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
  fetchImpl: typeof fetch,
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
  networkAccess: ModelProviderNetworkAccess,
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
      // Not the web-fetch tool budget: a model answers on its own clock.
      timeoutMs: TOOL_TIMEOUT_POLICY.modelStreamIdleCeilingMs,
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
 * keyless presets may reach loopback, and no preset may reach private networks
 * or tailnet peers.
 * Every request is nevertheless origin-locked before it reaches NetworkGuard.
 */
export function createGuardedMarketplaceProviderFetch(
  baseUrl: string,
  preset: MarketplaceInstalledProviderPreset,
  fetchImpl: typeof fetch,
): typeof fetch {
  return createOriginLockedProviderFetch(
    baseUrl,
    preset.requiresApiKey === false
      ? configuredModelProviderLoopbackAccess(baseUrl)
      : { allowPrivateNetworks: false, allowLoopback: false, allowCarrierGradeNat: false },
    false,
    fetchImpl,
  );
}

/**
 * Single selection ladder for the runtime `fetch` a provider config is built
 * with. Hoisted out of `createLoopProvider` (engine/turn/provider.ts) and
 * `reviewerStreamProviderFor` (boot/steps/reviewer-permission-wiring.ts), which
 * carried byte-identical copies of this 4-way ladder.
 *
 * Precedence:
 *   1. A marketplace preset with a baseUrl → origin-locked marketplace fetch
 *      (its own keyless-loopback / no-private policy).
 *   2. A saved self-hosted trusted-network vendor (no preset, non-empty baseUrl)
 *      → origin-locked model-provider fetch (private/loopback + insecure
 *      credentialed HTTP for that exact origin).
 *   3. azure-foundry → the Electron main-process `llmFetch` (may be undefined).
 *   4. Otherwise → undefined (SDK default fetch).
 *
 * The azure branch returns `llmFetch` directly rather than
 * `llmFetch ? llmFetch : undefined`: `fetch` is always truthy, so the only
 * falsy value `llmFetch` can hold is `undefined`, which the ternary would also
 * yield — the two forms are equivalent.
 */
export function selectProviderRuntimeFetch(args: {
  vendor: LLMVendor;
  baseUrl: string | undefined;
  providerMetadata: MarketplaceInstalledProviderPreset | undefined;
  /**
   * The Azure Foundry private-endpoint transport. Scoped: it REFUSES every
   * host that is not Azure Foundry (`safe-llm-fetch.ts`), so it is the
   * transport for that one vendor and cannot stand in for the others.
   */
  llmFetch: typeof fetch | undefined;
  /**
   * The host's general outbound transport — Chromium's stack, which follows
   * the machine's proxy configuration and reads its trust store. The guarded
   * branches below run on it. Required: with an ambient default here, a
   * self-hosted endpoint would silently go direct on a machine configured
   * otherwise, which is the defect this whole seam exists to prevent.
   */
  networkFetch: typeof fetch;
}): typeof fetch | undefined {
  const { vendor, baseUrl, providerMetadata, llmFetch, networkFetch } = args;
  const isSelfHostedDirect =
    isSelfHostedTrustedNetworkVendor(vendor) && !providerMetadata && Boolean(baseUrl?.trim());
  return providerMetadata && baseUrl
    ? createGuardedMarketplaceProviderFetch(baseUrl, providerMetadata, networkFetch)
    : isSelfHostedDirect && baseUrl
      ? createGuardedModelProviderFetch(baseUrl, networkFetch)
      : vendor === "azure-foundry"
        ? llmFetch
        : undefined;
}
