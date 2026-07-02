/**
 * §17 C1: Corporate CA 런타임 주입 — corp-ca-loader 사용 (정식 대응 완료).
 * Dev-only TLS bypass 완전 제거. Chromium은 OS keystore 자동 신뢰.
 *
 * corp-ca-loader.ts extracts the PEM; this module performs the runtime
 * injection into Node's undici / https / tls stacks. Kept separate so the pure
 * loader stays free of the global-dispatcher side effects.
 */
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
      log.warn("corporate CA not found — 해외망 사용 중이거나 MDM 미배포. TLS 검증 기본값 유지.");
      return;
    }
    const ca = [...tls.rootCertificates, result.pem];
    // 1) undici (Node fetch / global dispatcher)
    setGlobalDispatcher(new Agent({ connect: { ca } }));
    // 2) https.globalAgent (legacy https.get / https.request)
    (https.globalAgent.options as Record<string, unknown>).ca = ca;
    // 3) tls.setDefaultCACertificates — Node 24 기준 미존재, 향후 확장 포인트
    log.info(`corporate CA injected: source=${result.source} certs=${result.certCount} path=${result.path}`);
  } catch (e) {
    // 주입 실패해도 앱은 계속 실행 (해외망에서는 기본 CA로 충분)
    log.error("corporate CA 주입 실패 (non-fatal): %s", errorMessage(e));
  }
}

let corporateCaReady: Promise<void> | null = null;
export function ensureCorporateCaInjected(): Promise<void> {
  corporateCaReady ??= injectCorporateCa();
  return corporateCaReady;
}
