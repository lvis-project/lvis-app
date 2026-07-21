/**
 * Boot step — network fetch surface (§4.2, extracted from boot.ts C18).
 *
 * Builds the Electron-backed fetch implementations the rest of boot threads
 * around: the plain network-stack fetch and the SSRF-guarded LLM fetch.
 */
import { net } from "electron";
import { createSafeLlmFetch } from "../../main/safe-llm-fetch.js";
import type { BootContext } from "../context.js";

export async function setupNetworkFetch(ctx: BootContext): Promise<void> {
  const electronNetFetch = net.fetch.bind(net);
  const createElectronFetch = (fetchImpl: typeof electronNetFetch): typeof fetch =>
    (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const normalizedInput = input instanceof URL ? input.toString() : input;
      return fetchImpl(normalizedInput as string | Request, {
        ...(init ?? {}),
        bypassCustomProtocolHandlers: true,
      });
    }) as typeof fetch;
  const networkFetch = createElectronFetch(electronNetFetch);
  const llmFetch = createSafeLlmFetch(electronNetFetch);

  ctx.networkFetch = networkFetch;
  ctx.pluginNetworkFetch = networkFetch;
  ctx.llmFetch = llmFetch;
}
