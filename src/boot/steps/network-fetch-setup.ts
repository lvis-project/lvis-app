/**
 * Boot step — network fetch surface (§4.2, extracted from boot.ts C18).
 *
 * Builds the Electron-backed fetch implementations the rest of boot threads
 * around: the plain network-stack fetch, the proxy-bypassing direct fetch for
 * manually mapped corporate Azure private endpoints, the plugin egress chooser, and the
 * SSRF-guarded LLM fetch. Captures the manual host-resolver fingerprint so both
 * the plugin egress chooser and the LLM fetch agree on which URLs are mapped
 * private-endpoint hosts.
 */
import { net, session } from "electron";
import { createPluginNetworkFetch } from "../../main/plugin-network-fetch.js";
import { isAppliedManualHostResolverUrl } from "../../main/manual-host-resolver.js";
import { createSafeLlmFetch } from "../../main/safe-llm-fetch.js";
import type { BootContext } from "../context.js";

export async function setupNetworkFetch(ctx: BootContext): Promise<void> {
  const electronNetFetch = net.fetch.bind(net);
  const privateEndpointSession = session.fromPartition("lvis-private-endpoint-fetch");
  await privateEndpointSession.setProxy({ mode: "direct" });
  const electronDirectFetch = privateEndpointSession.fetch.bind(privateEndpointSession);
  const isManualPrivateEndpointUrl = (url: URL) => isAppliedManualHostResolverUrl(url.toString());
  const createElectronFetch = (fetchImpl: typeof electronNetFetch): typeof fetch =>
    (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const normalizedInput = input instanceof URL ? input.toString() : input;
      return fetchImpl(normalizedInput as string | Request, {
        ...(init ?? {}),
        bypassCustomProtocolHandlers: true,
      });
    }) as typeof fetch;
  const networkFetch = createElectronFetch(electronNetFetch);
  const privateNetworkFetch = createElectronFetch(electronDirectFetch);
  // Tier A host-mediated plugin egress: hostApi.hostFetch is backed by this
  // chooser so manually mapped corporate Azure private-endpoint URLs egress through the
  // proxy-bypassing direct session (host-resolver-rules → intranet IP), exactly
  // like the chat LLM path. Plugins (e.g. meeting STT) that send to a mapped
  // Azure host therefore stop being hijacked by the corporate forward proxy to
  // the public endpoint (the 403 "public access disabled" regression).
  const pluginNetworkFetch = createPluginNetworkFetch(
    networkFetch,
    privateNetworkFetch,
    isManualPrivateEndpointUrl,
  );
  const llmFetch = createSafeLlmFetch(electronNetFetch, {
    privateEndpoint: {
      fetch: electronDirectFetch,
      isMappedUrl: isManualPrivateEndpointUrl,
    },
  });

  ctx.networkFetch = networkFetch;
  ctx.privateNetworkFetch = privateNetworkFetch;
  ctx.pluginNetworkFetch = pluginNetworkFetch;
  ctx.llmFetch = llmFetch;
}
