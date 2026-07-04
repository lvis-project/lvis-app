



import { execFile } from "node:child_process";
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { createLogger } from "../lib/logger.js";
import { lvisHome } from "../shared/lvis-home.js";
const log = createLogger("corp-ca");
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
const CACHE_PATH = join(CACHE_DIR, "corp-ca.pem");

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;




const CORP_ROOT_CA_CN = process.env.LVIS_CORP_CA_CN ?? "Corporate Root CA";



function readCacheIfFresh(): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(CACHE_PATH, "r");
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

async function extractMacos(): Promise<string | null> {
  try {
    const output = await execFileAsync(
      "security",
      ["find-certificate", "-a", "-c", CORP_ROOT_CA_CN, "-p", "/Library/Keychains/System.keychain"],
      { encoding: "utf8", timeout: 10_000, maxBuffer: 2 * 1024 * 1024 },
    ) as unknown;
    const stdout =
      typeof output === "object" && output !== null && "stdout" in output
        ? (output as { stdout?: string | Buffer }).stdout
        : output;
    const pem = Buffer.isBuffer(stdout) ? stdout.toString("utf8") : String(stdout ?? "");
    if (!pem.includes("-----BEGIN CERTIFICATE-----")) {
      log.warn("macOS: corporate root CA not found in System.keychain (set LVIS_CORP_CA_CN to match your CA's CN)");
      return null;
    }
    return pem;
  } catch (err) {
    log.warn("macOS extraction failed: %s", (err as Error).message);
    return null;
  }
}

async function extractWindows(): Promise<string | null> {
  // Windows runtime extraction is pending (win-ca pkg or certutil pfx export).
  // Until then, the OS still presents installed CAs to Chromium via the system
  // trust store, so TLS usually works without injection; skip silently unless
  // the user wants diagnostics (LVIS_CORP_CA_DEBUG=1).
  if (process.env.LVIS_CORP_CA_DEBUG === "1") {
    log.info("Windows runtime extraction skipped (pending)");
  }
  return null;
}

async function extractLinux(): Promise<string | null> {
  // Linux runtime extraction is pending (scan /etc/ssl/certs or
  // update-ca-trust). Silent by default — OS trust store still applies.
  if (process.env.LVIS_CORP_CA_DEBUG === "1") {
    log.info("Linux runtime extraction skipped (pending)");
  }
  return null;
}

async function extractByPlatform(): Promise<string | null> {
  if (process.env.LVIS_SKIP_CORP_CA === "1") {
    return null;
  }
  switch (process.platform) {
    case "darwin":
      return await extractMacos();
    case "win32":
      return await extractWindows();
    case "linux":
      return await extractLinux();
    default:
      log.warn(`Unsupported platform: ${process.platform} — skipping CA extraction`);
      return null;
  }
}

// ─── Cache write ─────────────────────────────────────────────────────────────

async function writeCacheSecure(pem: string): Promise<void> {
  mkdirSync(CACHE_DIR, { recursive: true });
  // §S4 discipline: 0o600 — owner read/write only
  const fd = await open(CACHE_PATH, "w", 0o600);
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

// ─── Public API ───────────────────────────────────────────────────────────────

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
export async function ensureCorporateCa(): Promise<CorporateCaResult> {
  const cachePath = CACHE_PATH;

  // 1. cache hit
  const cached = readCacheIfFresh();
  if (cached) {
    log.info(`cache hit: ${cachePath} (${countCerts(cached)} cert(s))`);
    return { pem: cached, path: cachePath, source: "cache", certCount: countCerts(cached) };
  }

  // 2. extraction
  const pem = await extractByPlatform();
  if (!pem) {
    return { pem: null, path: cachePath, source: "none", certCount: 0 };
  }

  // 3. write cache (async, non-blocking for caller flow)
  try {
    await writeCacheSecure(pem);
    log.info(`extracted + cached: ${cachePath} (${countCerts(pem)} cert(s))`);
  } catch (writeErr) {
    log.warn("cache write failed (non-fatal): %s", (writeErr as Error).message);
  }

  return { pem, path: cachePath, source: "extracted", certCount: countCerts(pem) };
}
