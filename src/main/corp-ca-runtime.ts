/**
 * Corporate Root CA caching and process-wide TLS injection.
 *
 * Acquisition (cache read -> platform extraction -> 0o600 cache write) and
 * injection (undici global dispatcher + `https.globalAgent`) are one pipeline
 * with one caller, so they live in one module. Which certificate counts as a
 * match, and how each operating system is asked for it, is NOT here: that is
 * `corp-ca-extract.ts`, and this module deliberately knows nothing about
 * platforms or PEM parsing beyond counting what it was handed.
 */
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { open } from "node:fs/promises";
import * as https from "node:https";
import { join } from "node:path";
import * as tls from "node:tls";
import { Agent, setGlobalDispatcher } from "undici";
import { createLogger } from "../lib/logger.js";
import { lvisHome } from "../shared/lvis-home.js";
import { countCertificates, extractCorporateCa } from "./corp-ca-extract.js";
import { resolveCorpCaConfig, type CorpCaConfig } from "../shared/corp-ca-config.js";
import { errorMessage } from "../shared/error-message.js";
import { sha256Hex } from "../lib/hex-digest-equal.js";
const caLog = createLogger("corp-ca");

// ─── Public types ─────────────────────────────────────────────────────────────

export interface CorporateCaResult {

  pem: string | null;

  path: string;

  source: "cache" | "extracted" | "none";

  certCount: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const CACHE_DIR = join(lvisHome(), "certs");

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The cache belongs to the common name it was extracted for.
 *
 * Keying the file by the CN is what makes the setting mean something on a
 * machine that already has a cache: change the name in Settings and the next
 * launch extracts for the new one, instead of being shadowed by up to seven
 * days of certificates found under the old name. Switching back reuses the
 * earlier file rather than re-extracting.
 */
function cachePathFor(commonName: string): string {
  const digest = sha256Hex(commonName).slice(0, 16);
  return join(CACHE_DIR, `corp-ca-${digest}.pem`);
}

function readCacheIfFresh(cachePath: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(cachePath, "r");
    const st = fstatSync(fd);
    const ageMs = Date.now() - st.mtimeMs;
    if (ageMs < CACHE_TTL_MS) {
      const content = readFileSync(fd, "utf-8");
      // Counted, not string-matched: a cache truncated by a power cut has the
      // opening marker and nothing that parses, and re-extracting beats
      // injecting it.
      if (countCertificates(content) > 0) {
        return content;
      }
    }
  } catch {
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
  return null;
}

// ─── Cache write ─────────────────────────────────────────────────────────────

async function writeCacheSecure(pem: string, cachePath: string): Promise<void> {
  mkdirSync(CACHE_DIR, { recursive: true });
  // §S4 discipline: 0o600 — owner read/write only
  const fd = await open(cachePath, "w", 0o600);
  try {
    await fd.writeFile(pem, "utf-8");
  } finally {
    await fd.close();
  }
}

// ─── CA acquisition ───────────────────────────────────────────────────────────

/**
 * Returns the configured corporate Root CA PEM.
 *
 * 1. Return the fresh cache (~/.lvis/certs/corp-ca-<name digest>.pem) when
 *    available.
 * 2. Extract from the OS trust store when the cache is stale or missing, then
 *    write a 0o600 cache.
 * 3. Return { pem: null, source: "none" } when there is nothing to find.
 *
 * This does not throw on extraction failure; callers decide how to proceed.
 */
export async function ensureCorporateCa(
  config: CorpCaConfig = resolveCorpCaConfig(),
): Promise<CorporateCaResult> {
  const cachePath = cachePathFor(config.commonName);

  // 0. turned off — no acquisition, and no cache read either. Reading the
  // cache here would have made the switch a no-op on every machine that had
  // ever extracted a certificate, which is the failure the setting exists to
  // remove rather than one to reproduce.
  if (!config.enabled) {
    if (config.debugLog) {
      caLog.info("corporate CA acquisition is turned off in settings");
    }
    return { pem: null, path: cachePath, source: "none", certCount: 0 };
  }

  // 1. cache hit
  const cached = readCacheIfFresh(cachePath);
  if (cached) {
    caLog.info(`cache hit: ${cachePath} (${countCertificates(cached)} cert(s))`);
    return { pem: cached, path: cachePath, source: "cache", certCount: countCertificates(cached) };
  }

  // 2. extraction
  const pem = await extractCorporateCa(config);
  if (!pem) {
    return { pem: null, path: cachePath, source: "none", certCount: 0 };
  }

  // 3. write cache (async, non-blocking for caller flow)
  try {
    await writeCacheSecure(pem, cachePath);
    caLog.info(`extracted + cached: ${cachePath} (${countCertificates(pem)} cert(s))`);
  } catch (writeErr) {
    caLog.warn("cache write failed (non-fatal): %s", (writeErr as Error).message);
  }

  return { pem, path: cachePath, source: "extracted", certCount: countCertificates(pem) };
}

// ─── Process-wide TLS injection ───────────────────────────────────────────────

const log = createLogger("lvis");

async function injectCorporateCa(config: CorpCaConfig) {
  try {
    const result = await ensureCorporateCa(config);
    if (!result.pem) {
      // The one line for "nothing was injected", whatever the reason — the
      // setting is off, the platform has no reader, or no certificate in the
      // trust store carries the configured name.
      log.warn(
        "corporate CA not found — keeping default TLS verification. "
        + "If model calls fail with a certificate error on this network, set the "
        + "certificate name in Settings to the CN of your organization's root CA.",
      );
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
/**
 * Inject once per process. The config is resolved by the caller, which is the
 * only place that knows where this profile's settings file lives; the default
 * covers callers with no profile to read (tests, and any future host that
 * wants the environment-only behaviour).
 */
export function ensureCorporateCaInjected(
  config: CorpCaConfig = resolveCorpCaConfig(),
): Promise<void> {
  corporateCaReady ??= injectCorporateCa(config);
  return corporateCaReady;
}
