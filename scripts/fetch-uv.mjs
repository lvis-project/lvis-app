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

import { existsSync } from "node:fs";
import { mkdir, chmod, rename, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

// ─── Phase 1.5 Security A2: Hardcoded known-good SHA256 ─────────
//
// 다운로드 무결성을 compile-time 상수로 검증한다. 해당 버전의 해시가 존재하면
// fail-closed로 비교하고, 부재 시(새 버전으로 bump) GitHub .sha256 side-car로
// 폴백한다. side-car도 부재하면 역시 fail-closed.
//
// 업데이트 방법: uv 버전 bump 시, curl -sL <archive>.sha256 으로 각 플랫폼의
// 아카이브 해시를 받아 아래 맵에 추가한다.
const KNOWN_GOOD_SHA256 = {
  "0.7.3": {
    "uv-aarch64-apple-darwin.tar.gz":
      "162b328fc63e0075d4267688201de91356e1c1b81db50419fa4466cfe2dfdebc",
    "uv-x86_64-apple-darwin.tar.gz":
      "d676940b51bdd5606b218bc2965fed67731f94ad07926045716acbf78626e09b",
    "uv-x86_64-pc-windows-msvc.zip":
      "20d3a420abbf2af9699cd9a02225d9325344046af8deb15563cc451e3c4fd059",
    "uv-x86_64-unknown-linux-gnu.tar.gz":
      "17fc118ba4d7e9303f84fcabdc0a593fc3480ba76eb6980668fdbbb96fe88562",
    "uv-aarch64-unknown-linux-gnu.tar.gz":
      "2c2be8bbb83e9bc722f2013de8bb7506cfe6521d0e30b4ad046849d036b3eea6",
  },
};

// F-round §L1: 정의 시점 포맷 검증 — 오타/대문자 혼입을 fail-fast.
for (const [version, archives] of Object.entries(KNOWN_GOOD_SHA256)) {
  for (const [archive, digest] of Object.entries(archives)) {
    if (!/^[0-9a-f]{64}$/.test(digest)) {
      throw new Error(
        `KNOWN_GOOD_SHA256 malformed: ${version}/${archive} is not lowercase 64-char hex`,
      );
    }
  }
}

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
 * Verify downloaded archive SHA256.
 *
 * Phase 1.5 hardening:
 *   1. 하드코딩된 KNOWN_GOOD_SHA256 맵 우선 (fail-closed).
 *   2. 맵에 없으면 GitHub `.sha256` side-car 폴백 (forward compat for version bump).
 *   3. side-car도 없거나 불일치면 throw (fail-closed — no silent skip).
 */
async function verifyArchiveSha256(url, archiveBuffer) {
  const archiveName = path.basename(url);
  const actual = sha256Hex(archiveBuffer);

  const hardcoded = KNOWN_GOOD_SHA256[UV_VERSION]?.[archiveName];
  if (hardcoded) {
    if (actual !== hardcoded.toLowerCase()) {
      throw new Error(
        `SHA256 불일치 (hardcoded known-good) — 다운로드 무결성 검증 실패.\n` +
        `  archive:  ${archiveName}\n` +
        `  expected: ${hardcoded}\n` +
        `  actual:   ${actual}\n`,
      );
    }
    log(`  SHA256 verified (hardcoded known-good): ${actual.slice(0, 16)}…`);
    return true;
  }

  log(`  INFO: no hardcoded SHA256 for ${archiveName} @ ${UV_VERSION} — falling back to .sha256 side-car`);
  const sha256Url = `${url}.sha256`;
  let expected;
  try {
    const resp = await fetch(sha256Url);
    if (!resp.ok) {
      throw new Error(`side-car HTTP ${resp.status}`);
    }
    const text = (await resp.text()).trim();
    const match = text.match(/^([0-9a-fA-F]{64})/);
    if (!match) {
      throw new Error("side-car format unrecognised");
    }
    expected = match[1].toLowerCase();
  } catch (err) {
    throw new Error(
      `SHA256 검증 실패 — hardcoded 맵에도 없고 .sha256 side-car도 얻을 수 없음.\n` +
      `  archive: ${archiveName}\n` +
      `  reason:  ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (actual !== expected) {
    throw new Error(
      `SHA256 불일치 (side-car) — 다운로드 무결성 검증 실패.\n` +
      `  archive:  ${archiveName}\n` +
      `  expected: ${expected}\n` +
      `  actual:   ${actual}\n`,
    );
  }
  log(`  SHA256 verified (side-car fallback): ${actual.slice(0, 16)}…`);
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
