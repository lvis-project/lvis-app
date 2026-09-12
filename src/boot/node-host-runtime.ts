import https from "node:https";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { createNodeSecretEncryption } from "../data/node-secret-encryption.js";
import { createSafeLlmFetch } from "../main/safe-llm-fetch.js";
import { ensureCorporateCaInjected } from "../main/corp-ca-runtime.js";
import { readPersistedCorpCaConfigSync } from "../main/persisted-corp-ca.js";
import { getRuntimeSensitiveKeyPaths } from "../permissions/sensitive-paths.js";
import type { BootHost } from "./host-runtime.js";

export interface NodeBootHostOptions {
  userDataPath: string;
  resourcePath: string;
  keyFilePath?: string;
  isPackaged: boolean;
}

/** Owns server egress and credentials for the lifetime of one host process. */
export async function createNodeBootHost(options: NodeBootHostOptions): Promise<BootHost> {
  const encryption = createNodeSecretEncryption(options.keyFilePath);
  getRuntimeSensitiveKeyPaths();
  await ensureCorporateCaInjected(readPersistedCorpCaConfigSync(options.userDataPath));
  const ca = https.globalAgent.options.ca;
  const dispatcher = new EnvHttpProxyAgent({
    ...(ca ? { connect: { ca }, requestTls: { ca }, proxyTls: { ca } } : {}),
  });
  // Providers and host fetches share the configured server route. A failed
  // proxy connection remains a failure; there is no direct retry path.
  setGlobalDispatcher(dispatcher);
  const networkFetch: typeof fetch = (input, init) => fetch(input, init);
  const singleHopNetworkFetch: typeof fetch = (input, init) =>
    fetch(input, { ...init, redirect: "manual" });
  return {
    userDataPath: options.userDataPath,
    resourcePath: options.resourcePath,
    isPackaged: options.isPackaged,
    systemLocale: Intl.DateTimeFormat().resolvedOptions().locale,
    encryption,
    networkFetch,
    singleHopNetworkFetch,
    llmFetch: createSafeLlmFetch(networkFetch),
    exit: (code) => process.exit(code),
    close: () => dispatcher.destroy(),
  };
}
