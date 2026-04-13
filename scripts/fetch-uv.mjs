/**
 * fetch-uv.mjs — uv standalone binary 다운로드 스크립트
 *
 * GitHub releases (astral-sh/uv) 에서 5개 플랫폼 바이너리를 다운로드한다.
 * 이미 존재하면 skip (idempotent).
 *
 * 사용:
 *   node scripts/fetch-uv.mjs
 *   node scripts/fetch-uv.mjs --version 0.11.6
 *
 * postinstall 훅으로 자동 실행됨 (package.json scripts.postinstall).
 */

import { createWriteStream, existsSync } from "node:fs";
import { mkdir, chmod, rename, unlink } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { extract as tarExtract } from "node:tar"; // Node.js 22+ 내장 없음 → tar 모듈 필요
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { createWriteStream as _cws } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");

// ─── 버전 결정 ────────────────────────────────────────────

const DEFAULT_VERSION = "0.7.3"; // uv 안정 버전 (2026-04-13 기준)

function parseArgs() {
  const args = process.argv.slice(2);
  const vIdx = args.indexOf("--version");
  if (vIdx !== -1 && args[vIdx + 1]) return args[vIdx + 1];
  return DEFAULT_VERSION;
}

const UV_VERSION = parseArgs();

// ─── 플랫폼 매핑 ─────────────────────────────────────────

const TARGETS = [
  {
    dir: "darwin-arm64",
    bin: "uv",
    archive: `uv-aarch64-apple-darwin.tar.gz`,
    type: "tar.gz",
  },
  {
    dir: "darwin-x64",
    bin: "uv",
    archive: `uv-x86_64-apple-darwin.tar.gz`,
    type: "tar.gz",
  },
  {
    dir: "win32-x64",
    bin: "uv.exe",
    archive: `uv-x86_64-pc-windows-msvc.zip`,
    type: "zip",
  },
  {
    dir: "linux-x64",
    bin: "uv",
    archive: `uv-x86_64-unknown-linux-gnu.tar.gz`,
    type: "tar.gz",
  },
  {
    dir: "linux-arm64",
    bin: "uv",
    archive: `uv-aarch64-unknown-linux-gnu.tar.gz`,
    type: "tar.gz",
  },
];

// ─── 유틸 ─────────────────────────────────────────────────

function log(msg) {
  process.stdout.write(`[fetch-uv] ${msg}\n`);
}

function fail(msg) {
  process.stderr.write(`[fetch-uv] ERROR: ${msg}\n`);
  process.exit(1);
}

/**
 * HTTP(S) GET → Response (리다이렉트 자동 추적)
 * Node.js 18+ 내장 fetch 사용
 */
async function fetchWithRedirect(url) {
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} ${resp.statusText} — ${url}`);
  }
  return resp;
}

/**
 * tar.gz 스트림에서 <name>.tar.gz/uv (또는 uv.exe) 단일 파일을 추출한다.
 * Node.js 내장 zlib + tar 없이 처리: gunzip 후 tar 헤더를 직접 파싱.
 *
 * 경량 구현: 외부 의존성 0.
 */
async function extractTarGz(buffer, targetBin) {
  // gunzip
  const { gunzipSync } = await import("node:zlib");
  const tarBuf = gunzipSync(buffer);

  // tar 파싱 (POSIX ustar, 512-byte 블록)
  let offset = 0;
  while (offset + 512 <= tarBuf.length) {
    const header = tarBuf.subarray(offset, offset + 512);
    // null 블록 = EOF
    if (header.every((b) => b === 0)) break;

    const name = readCString(header, 0, 100);
    const sizeOctal = readCString(header, 124, 12);
    const size = parseInt(sizeOctal, 8) || 0;
    const typeflag = String.fromCharCode(header[156]);

    offset += 512;

    if (typeflag === "0" || typeflag === "\0") {
      // 파일 항목
      const basename = name.split("/").pop() ?? name;
      if (basename === targetBin || basename === "uv" || basename === "uv.exe") {
        const fileData = tarBuf.subarray(offset, offset + size);
        offset += Math.ceil(size / 512) * 512;
        return fileData;
      }
    }

    offset += Math.ceil(size / 512) * 512;
  }

  throw new Error(`아카이브에서 '${targetBin}' 바이너리를 찾을 수 없습니다.`);
}

function readCString(buf, start, maxLen) {
  let end = start;
  while (end < start + maxLen && buf[end] !== 0) end++;
  return buf.subarray(start, end).toString("utf8");
}

/**
 * ZIP에서 uv.exe 추출 (PKZIP 로컬 파일 헤더 파싱).
 */
async function extractZip(buffer, targetBin) {
  // End of Central Directory record 탐색 (오프셋 -22부터)
  const EOCD_SIG = 0x06054b50;
  let eocdOffset = buffer.length - 22;
  while (eocdOffset >= 0) {
    if (buffer.readUInt32LE(eocdOffset) === EOCD_SIG) break;
    eocdOffset--;
  }
  if (eocdOffset < 0) throw new Error("ZIP EOCD를 찾을 수 없습니다.");

  const cdOffset = buffer.readUInt32LE(eocdOffset + 16);
  const cdEntries = buffer.readUInt16LE(eocdOffset + 10);

  const CD_SIG = 0x02014b50;
  let cdPos = cdOffset;

  for (let i = 0; i < cdEntries; i++) {
    if (buffer.readUInt32LE(cdPos) !== CD_SIG) break;
    const filenameLen = buffer.readUInt16LE(cdPos + 28);
    const extraLen = buffer.readUInt16LE(cdPos + 30);
    const commentLen = buffer.readUInt16LE(cdPos + 32);
    const localHeaderOffset = buffer.readUInt32LE(cdPos + 42);
    const filename = buffer.subarray(cdPos + 46, cdPos + 46 + filenameLen).toString("utf8");
    cdPos += 46 + filenameLen + extraLen + commentLen;

    const basename = filename.split("/").pop() ?? filename;
    if (basename === targetBin || basename === "uv.exe" || basename === "uv") {
      // 로컬 파일 헤더
      const LFH_SIG = 0x04034b50;
      if (buffer.readUInt32LE(localHeaderOffset) !== LFH_SIG) {
        throw new Error("ZIP 로컬 파일 헤더 손상");
      }
      const lfhFilenameLen = buffer.readUInt16LE(localHeaderOffset + 26);
      const lfhExtraLen = buffer.readUInt16LE(localHeaderOffset + 28);
      const dataOffset = localHeaderOffset + 30 + lfhFilenameLen + lfhExtraLen;
      const compressedSize = buffer.readUInt32LE(localHeaderOffset + 18);
      const compressionMethod = buffer.readUInt16LE(localHeaderOffset + 8);

      const compressedData = buffer.subarray(dataOffset, dataOffset + compressedSize);

      if (compressionMethod === 0) {
        // STORED
        return compressedData;
      } else if (compressionMethod === 8) {
        // DEFLATE
        const { inflateRawSync } = await import("node:zlib");
        return inflateRawSync(compressedData);
      } else {
        throw new Error(`지원하지 않는 ZIP 압축 방식: ${compressionMethod}`);
      }
    }
  }

  throw new Error(`ZIP에서 '${targetBin}' 바이너리를 찾을 수 없습니다.`);
}

// ─── 다운로드 + 추출 ──────────────────────────────────────

/**
 * SHA256 hex digest of a buffer.
 */
function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * Download `<asset>.sha256` side-car from GitHub and verify.
 * Returns true if verified, false if side-car unavailable (warn only).
 * Throws if side-car exists but digest mismatches — fail-closed.
 */
async function verifyArchiveSha256(url, archiveBuffer) {
  const sha256Url = `${url}.sha256`;
  let expected;
  try {
    const resp = await fetch(sha256Url);
    if (!resp.ok) {
      log(`  WARN: .sha256 side-car not available (${resp.status}) — skipping verification`);
      return false;
    }
    const text = (await resp.text()).trim();
    // GitHub format: "<hex>  <filename>" or just "<hex>"
    const match = text.match(/^([0-9a-fA-F]{64})/);
    if (!match) {
      log(`  WARN: .sha256 side-car format unrecognised — skipping verification`);
      return false;
    }
    expected = match[1].toLowerCase();
  } catch (err) {
    log(`  WARN: .sha256 fetch error (${err instanceof Error ? err.message : String(err)}) — skipping verification`);
    return false;
  }

  const actual = sha256Hex(archiveBuffer);
  if (actual !== expected) {
    throw new Error(
      `SHA256 불일치 — 다운로드 무결성 검증 실패.\n` +
      `  expected: ${expected}\n` +
      `  actual:   ${actual}\n` +
      `  url:      ${url}`,
    );
  }
  log(`  SHA256 verified: ${actual.slice(0, 16)}…`);
  return true;
}

async function downloadTarget(target) {
  const destDir = path.join(PROJECT_ROOT, "resources", "uv", target.dir);
  const destBin = path.join(destDir, target.bin);

  // idempotent: 이미 존재하면 skip
  if (existsSync(destBin)) {
    log(`SKIP (already exists): ${path.relative(PROJECT_ROOT, destBin)}`);
    return;
  }

  await mkdir(destDir, { recursive: true });

  const url = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${target.archive}`;
  log(`Downloading: ${url}`);

  const resp = await fetchWithRedirect(url);
  const arrayBuffer = await resp.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  log(`  Downloaded ${(buffer.length / 1024 / 1024).toFixed(1)} MB — extracting ${target.bin}...`);

  // cycle 1 LOW: SHA256 무결성 검증 — .sha256 side-car 사용.
  // side-car 부재 시 경고만, 존재 시 불일치이면 fail-closed.
  await verifyArchiveSha256(url, buffer);

  let fileData;
  if (target.type === "tar.gz") {
    fileData = await extractTarGz(buffer, target.bin);
  } else if (target.type === "zip") {
    fileData = await extractZip(buffer, target.bin);
  } else {
    fail(`알 수 없는 아카이브 타입: ${target.type}`);
  }

  // 임시 파일에 쓰고 rename (원자적 쓰기)
  const tmpBin = destBin + ".tmp";
  await import("node:fs/promises").then(({ writeFile }) => writeFile(tmpBin, fileData));
  await rename(tmpBin, destBin);

  // Unix: chmod +x
  if (process.platform !== "win32" && target.bin !== "uv.exe") {
    await chmod(destBin, 0o755);
  }

  log(`  OK: ${path.relative(PROJECT_ROOT, destBin)} (${(fileData.length / 1024).toFixed(0)} KB)`);
}

// ─── 메인 ─────────────────────────────────────────────────

async function main() {
  log(`uv version: ${UV_VERSION}`);
  log(`대상 디렉토리: ${path.join(PROJECT_ROOT, "resources", "uv")}`);
  log(`플랫폼 수: ${TARGETS.length}`);
  log("");

  const errors = [];

  for (const target of TARGETS) {
    try {
      await downloadTarget(target);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${target.dir}: ${msg}`);
      process.stderr.write(`[fetch-uv] WARN: ${target.dir} 다운로드 실패 — ${msg}\n`);
    }
  }

  log("");
  if (errors.length > 0) {
    process.stderr.write(`[fetch-uv] ${errors.length}개 플랫폼 다운로드 실패:\n`);
    for (const e of errors) process.stderr.write(`  - ${e}\n`);
    process.stderr.write(`[fetch-uv] 네트워크 연결을 확인하거나 수동으로 다운로드하세요.\n`);
    // postinstall에서 한 플랫폼 실패가 전체를 막지 않도록 exit 0
    // (현재 OS가 아닌 플랫폼 바이너리는 다운로드 실패해도 무방)
    if (errors.length === TARGETS.length) {
      // 전부 실패 시에는 오류 코드 반환
      process.exit(1);
    }
  } else {
    log("모든 플랫폼 uv binary 다운로드 완료.");
  }
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
