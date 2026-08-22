/**
 * Corporate Root CA acquisition and process-wide TLS injection.
 *
 * Acquisition (cache read -> platform extraction -> 0o600 cache write) and
 * injection (undici global dispatcher + `https.globalAgent`) are one pipeline
 * with one caller, so they live in one module.
 */
import { execFile } from "node:child_process";
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { open } from "node:fs/promises";
import * as https from "node:https";
import { join } from "node:path";
import * as tls from "node:tls";
import { promisify } from "node:util";
import { Agent, setGlobalDispatcher } from "undici";
import { createHash } from "node:crypto";
import { createLogger } from "../lib/logger.js";
import { lvisHome } from "../shared/lvis-home.js";
import {
  extractLinuxCorporateCa,
  extractWindowsCorporateCa,
} from "./corp-ca-extract.js";
import { resolveCorpCaConfig, type CorpCaConfig } from "../shared/corp-ca-config.js";
const caLog = createLogger("corp-ca");
const execFileAsync = promisify(execFile);

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
  const digest = createHash("sha256").update(commonName).digest("hex").slice(0, 16);
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
      if (content.includes("-----BEGIN CERTIFICATE-----")) {
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

// ─── Platform-specific extraction ────────────────────────────────────────────

async function extractMacos(commonName: string): Promise<string | null> {
  try {
    const output = await execFileAsync(
      "security",
      ["find-certificate", "-a", "-c", commonName, "-p", "/Library/Keychains/System.keychain"],
      { encoding: "utf8", timeout: 10_000, maxBuffer: 2 * 1024 * 1024 },
    ) as unknown;
    const stdout =
      typeof output === "object" && output !== null && "stdout" in output
        ? (output as { stdout?: string | Buffer }).stdout
        : output;
    const pem = Buffer.isBuffer(stdout) ? stdout.toString("utf8") : String(stdout ?? "");
    if (!pem.includes("-----BEGIN CERTIFICATE-----")) {
      caLog.warn(
        "macOS: corporate root CA not found in System.keychain "
        + "(set the certificate name in Settings to match the CN of your CA)",
      );
      return null;
    }
    return pem;
  } catch (err) {
    caLog.warn("macOS extraction failed: %s", (err as Error).message);
    return null;
  }
}

async function extractByPlatform(config: CorpCaConfig): Promise<string | null> {
  switch (process.platform) {
    case "darwin":
      return await extractMacos(config.commonName);
    case "win32":
      return await extractWindowsCorporateCa(config.commonName, config.debugLog);
    case "linux":
      return await extractLinuxCorporateCa(config.commonName, config.debugLog);
    default:
      caLog.warn(`Unsupported platform: ${process.platform} — skipping CA extraction`);
      return null;
  }
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

// ─── PEM cert count ───────────────────────────────────────────────────────────

function countCerts(pem: string): number {
  return (pem.match(/-----BEGIN CERTIFICATE-----/g) ?? []).length;
}

// ─── CA acquisition ───────────────────────────────────────────────────────────

/**
 * Returns the configured corporate Root CA PEM.
 *
 * 1. Return the fresh cache (~/.lvis/certs/corp-ca.pem) when available.
 * 2. Extract by platform when the cache is stale or missing, then write a
 *    0o600 cache.
 * 3. Return { pem: null, source: "none" } when extraction is unavailable.
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
    caLog.info(`cache hit: ${cachePath} (${countCerts(cached)} cert(s))`);
    return { pem: cached, path: cachePath, source: "cache", certCount: countCerts(cached) };
  }

  // 2. extraction
  const pem = await extractByPlatform(config);
  if (!pem) {
    return { pem: null, path: cachePath, source: "none", certCount: 0 };
  }

  // 3. write cache (async, non-blocking for caller flow)
  try {
    await writeCacheSecure(pem, cachePath);
    caLog.info(`extracted + cached: ${cachePath} (${countCerts(pem)} cert(s))`);
  } catch (writeErr) {
    caLog.warn("cache write failed (non-fatal): %s", (writeErr as Error).message);
  }

  return { pem, path: cachePath, source: "extracted", certCount: countCerts(pem) };
}

// ─── Process-wide TLS injection ───────────────────────────────────────────────

const log = createLogger("lvis");

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function injectCorporateCa(config: CorpCaConfig) {
  try {
    const result = await ensureCorporateCa(config);
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
