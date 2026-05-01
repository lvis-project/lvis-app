/**
 * Corporate CA Loader — §17 정식 대응 (C1)
 *
 * LG 사내망 proxy가 TLS 인터셉트를 수행하므로, Electron 번들 Node가
 * LGERootCA를 신뢰하지 않으면 api.openai.com 등 모든 외부 HTTPS 호출이
 * SELF_SIGNED_CERT_IN_CHAIN으로 실패한다. OS keychain에 이미 MDM으로
 * 설치된 CA를 런타임에 추출하여 Node의 undici / https / tls에 주입한다.
 *
 * 재사용 cache: ~/.lvis/certs/corp-ca.pem (다음 부팅 skip, 7일마다 refresh)
 *
 * PoC 검증 결과 (2026-04-15):
 *   [3] CN=LGERootCA issuer=LGERootCA (self-signed, 2005-2045)
 *   SHA1: CD:E9:73:D6:39:37:6E:C4:CD:42:AB:70:6C:14:15:8C:A0:CA:52:3B
 *
 * TODO Phase 3: Windows (win-ca / certutil) + Linux (/etc/ssl/certs) 구현.
 *   - Windows: `certutil -exportPFX -p "" Root "LGERootCA" tmp.pfx` or win-ca npm pkg
 *   - Linux:   /etc/ssl/certs/LGERootCA*.pem or `update-ca-certificates` hook
 */
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../lib/logger.js";
const log = createLogger("corp-ca");

// ─── Public types ─────────────────────────────────────────────────────────────

export interface CorporateCaResult {
  /** PEM 문자열. null이면 추출 실패 (해외망 또는 MDM 미배포). */
  pem: string | null;
  /** cache 파일 경로 */
  path: string;
  /** 데이터 출처 */
  source: "cache" | "extracted" | "none";
  /** PEM 블록별 BEGIN 인덱스 (파싱 확인용) */
  certCount: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const CACHE_DIR = join(homedir(), ".lvis", "certs");
const CACHE_PATH = join(CACHE_DIR, "corp-ca.pem");
/** 7일 (ms). 이 시간이 지나면 재추출. */
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * macOS System.keychain에서 검색할 CN 이름.
 * MDM이 LGERootCA를 배포하므로 root CA 하나만 추출하면 chain이 해결된다.
 */
const LGE_ROOT_CA_CN = "LGERootCA";

// ─── Cache read (sync — startup 경로에서 호출됨) ──────────────────────────────

function readCacheIfFresh(): string | null {
  try {
    const st = statSync(CACHE_PATH);
    const ageMs = Date.now() - st.mtimeMs;
    if (ageMs < CACHE_TTL_MS) {
      const content = readFileSync(CACHE_PATH, "utf-8");
      if (content.includes("-----BEGIN CERTIFICATE-----")) {
        return content;
      }
    }
  } catch {
    // ENOENT 또는 stale — fall through to extraction
  }
  return null;
}

// ─── Platform-specific extraction ────────────────────────────────────────────

function extractMacos(): string | null {
  try {
    const pem = execSync(
      `security find-certificate -a -c '${LGE_ROOT_CA_CN}' -p /Library/Keychains/System.keychain`,
      { encoding: "utf8", timeout: 10_000 },
    );
    if (!pem.includes("-----BEGIN CERTIFICATE-----")) {
      log.warn("macOS: LGERootCA not found in System.keychain");
      return null;
    }
    return pem;
  } catch (err) {
    log.warn("macOS extraction failed: %s", (err as Error).message);
    return null;
  }
}

function extractWindows(): string | null {
  // Windows runtime extraction is Phase 3 (win-ca pkg or certutil pfx export).
  // Until then, the OS still presents installed CAs to Chromium via the system
  // trust store, so TLS usually works without injection; skip silently unless
  // the user wants diagnostics (LVIS_CORP_CA_DEBUG=1).
  if (process.env.LVIS_CORP_CA_DEBUG === "1") {
    log.info("Windows runtime extraction skipped (Phase 3 pending)");
  }
  return null;
}

function extractLinux(): string | null {
  // Linux runtime extraction is Phase 3 (scan /etc/ssl/certs or
  // update-ca-trust). Silent by default — OS trust store still applies.
  if (process.env.LVIS_CORP_CA_DEBUG === "1") {
    log.info("Linux runtime extraction skipped (Phase 3 pending)");
  }
  return null;
}

function extractByPlatform(): string | null {
  if (process.env.LVIS_SKIP_CORP_CA === "1") {
    return null;
  }
  switch (process.platform) {
    case "darwin":
      return extractMacos();
    case "win32":
      return extractWindows();
    case "linux":
      return extractLinux();
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
 * 사내망 Root CA PEM을 반환한다.
 *
 * 1. cache (~/.lvis/certs/corp-ca.pem) 가 fresh하면 그대로 반환
 * 2. stale 또는 미존재 → 플랫폼별 추출 후 0o600으로 cache 저장
 * 3. 추출 실패 (해외망, MDM 미배포) → { pem: null, source: "none" }
 *
 * 실패 시 throw하지 않는다. caller가 결정.
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
  const pem = extractByPlatform();
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
