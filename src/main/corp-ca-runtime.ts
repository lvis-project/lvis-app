



import * as https from "node:https";
import * as tls from "node:tls";
import { Agent, setGlobalDispatcher } from "undici";
import { ensureCorporateCa } from "./corp-ca-loader.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("lvis");

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function injectCorporateCa() {
  try {
    const result = await ensureCorporateCa();
    if (!result.pem) {
    log.warn("corporate CA not found — external network or MDM not deployed. Keeping default TLS verification.");
      return;
    }
    const ca = [...tls.rootCertificates, result.pem];
    // 1) undici (Node fetch / global dispatcher)
    setGlobalDispatcher(new Agent({ connect: { ca } }));
    // 2) https.globalAgent (legacy https.get / https.request)
    (https.globalAgent.options as Record<string, unknown>).ca = ca;

    log.info(`corporate CA injected: source=${result.source} certs=${result.certCount} path=${result.path}`);
  } catch (e) {
    // 주입 실패해도 앱은 계속 실행 (해외망에서는 기본 CA로 충분)
    log.error("corporate CA injection failed (non-fatal): %s", errorMessage(e));
  }
}

let corporateCaReady: Promise<void> | null = null;
export function ensureCorporateCaInjected(): Promise<void> {
  corporateCaReady ??= injectCorporateCa();
  return corporateCaReady;
}
