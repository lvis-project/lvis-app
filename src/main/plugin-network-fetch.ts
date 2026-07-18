/**
 * Plugin egress routing (Tier A — host-mediated plugin networking).
 *
 * First-party plugins reach the network ONLY through the host-mediated egress
 * capability (`hostApi.hostFetch`), which the host backs with the fetch this
 * factory produces. The routing mirrors the chat LLM path (`safe-llm-fetch`):
 *
 *   - manually mapped corporate Azure *private-endpoint* URLs must egress through the
 *     proxy-bypassing DIRECT session (Electron `host-resolver-rules` map the
 *     Azure hostname to the intranet IP). The corporate forward proxy, if used,
 *     resolves that hostname via PUBLIC DNS and hits the public endpoint, which
 *     returns 403 "public access disabled" — the meeting STT regression.
 *   - every other host goes through the default session (corporate proxy /
 *     PAC / WPAD + corporate CA).
 *
 * Pure + Electron-free so it is unit-testable; boot wires the two concrete
 * Electron fetch implementations and the manual private-endpoint predicate.
 */
export function createPluginNetworkFetch(
  defaultFetch: typeof fetch,
  privateEndpointFetch: typeof fetch,
  isPrivateEndpointUrl: (url: URL) => boolean,
): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    let usePrivateEndpoint = false;
    try {
      const url =
        input instanceof URL
          ? input
          : new URL(input instanceof Request ? input.url : String(input));
      usePrivateEndpoint = isPrivateEndpointUrl(url);
    } catch {
      // An opaque/relative input has no host to match against the private-
      // endpoint map, so the default (proxied) session is the only sensible
      // route. This is not a bug-hiding fallback: such a URL is also rejected
      // by validateHttpUrl in the hostFetch gate upstream.
      usePrivateEndpoint = false;
    }
    const impl = usePrivateEndpoint ? privateEndpointFetch : defaultFetch;
    return impl(input, init);
  }) as typeof fetch;
}
