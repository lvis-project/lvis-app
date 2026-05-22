const AZURE_FOUNDRY_HOST_SUFFIXES = [
  ".openai.azure.com",
  ".services.ai.azure.com",
] as const;

export type ElectronNetFetch = (
  input: string | Request,
  init?: RequestInit & { bypassCustomProtocolHandlers?: boolean },
) => Promise<Response>;

type PrivateEndpointFetch = {
  fetch: ElectronNetFetch;
  isMappedUrl: (url: URL) => boolean;
};

export type SafeLlmFetchOptions = {
  privateEndpoint?: PrivateEndpointFetch;
};

function requestUrl(input: Parameters<typeof fetch>[0]): URL {
  if (typeof input === "string" || input instanceof URL) {
    return new URL(input.toString());
  }
  return new URL(input.url);
}

function isValidDnsSubdomain(value: string): boolean {
  return /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/.test(
    value,
  );
}

export function isAllowedLlmFetchUrl(url: URL): boolean {
  if (url.protocol !== "https:") return false;

  const host = url.hostname.toLowerCase();
  const suffix = AZURE_FOUNDRY_HOST_SUFFIXES.find((candidate) =>
    host.endsWith(candidate),
  );
  if (!suffix) return false;

  const subdomain = host.slice(0, host.length - suffix.length);
  return subdomain.length > 0 && isValidDnsSubdomain(subdomain);
}

/**
 * Electron's network stack is required for demo/private-endpoint Azure Foundry
 * calls because Chromium owns the host-resolver rules. Keep that power scoped
 * to the only current LLM path that needs it.
 */
export function createSafeLlmFetch(
  netFetch: ElectronNetFetch,
  options: SafeLlmFetchOptions = {},
): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = requestUrl(input);
    if (!isAllowedLlmFetchUrl(url)) {
      throw new Error(
        `safe-llm-fetch: blocked non-Azure-Foundry LLM request: ${url.origin}`,
      );
    }

    const normalizedInput = input instanceof URL ? input.toString() : input;
    const privateEndpoint = options.privateEndpoint;
    const usePrivateEndpoint = privateEndpoint?.isMappedUrl(url) === true;
    const fetchImpl = usePrivateEndpoint ? privateEndpoint.fetch : netFetch;
    return fetchImpl(normalizedInput as string | Request, {
      ...(init ?? {}),
      redirect: "error",
      bypassCustomProtocolHandlers: true,
    });
  }) as typeof fetch;
}
