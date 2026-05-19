/**
 * fetch-uv.mjs — uv standalone binary 다운로드 스크립트
 *
 * 우선순위:
 *   1) vendored fast-path: resources/uv-archives/<archive> (repo-committed)
 *   2) GitHub releases (astral-sh/uv) HTTP 다운로드 fallback
 *
 * 이미 존재하면 skip (idempotent).
 *
 * 사용:
 *   node scripts/fetch-uv.mjs                  # current platform only
 *   node scripts/fetch-uv.mjs --target linux-x64
 *   node scripts/fetch-uv.mjs --all
 *
 * postinstall 훅으로 자동 실행됨. 개발 환경에서는 현재 플랫폼 바이너리만 받는다.
 */

import { existsSync } from "node:fs";
import { mkdir, chmod, rename, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { UV_TARGETS, getUvTargetByDir, resolveUvTarget } from "./uv-targets.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");

// ─── 버전/대상 결정 ───────────────────────────────────────

const DEFAULT_VERSION = "0.7.3"; // uv 안정 버전 (2026-04-13 기준)
const METADATA_FILE = "uv.meta.json";
const VENDORED_ARCHIVES_DIR = "resources/uv-archives";

function usage() {
  return [
    "Usage: node scripts/fetch-uv.mjs [options]",
    "",
    "Options:",
    "  --current          Download only the current OS/arch uv binary (default)",
    "  --target <dir>     Download one target dir. Repeatable. Example: linux-x64",
    "  --all              Download every known target",
    "  --list-targets     Print known target dirs",
  ].join("\n");
}

function parseArgs() {
  const args = process.argv.slice(2);
  let mode = "current";
  const targets = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    if (arg === "--list-targets") {
      process.stdout.write(`${UV_TARGETS.map((target) => target.dir).join("\n")}\n`);
      process.exit(0);
    }
    if (arg === "--current") {
      mode = "current";
      continue;
    }
    if (arg === "--all") {
      mode = "all";
      continue;
    }
    if (arg === "--target") {
      const value = args[i + 1];
      if (!value || value.startsWith("--")) fail("--target requires a value");
      mode = "target";
      targets.push(...value.split(",").map((item) => item.trim()).filter(Boolean));
      i += 1;
      continue;
    }
    if (arg.startsWith("--target=")) {
      mode = "target";
      targets.push(...arg.slice("--target=".length).split(",").map((item) => item.trim()).filter(Boolean));
      continue;
    }
    fail(`Unknown argument: ${arg}\n\n${usage()}`);
  }

  return { mode, targets };
}

const CLI_ARGS = parseArgs();
const UV_VERSION = DEFAULT_VERSION;

// ─── 유틸 ─────────────────────────────────────────────────

function log(msg) {
  process.stdout.write(`[fetch-uv] ${msg}\n`);
}

function fail(msg) {
  process.stderr.write(`[fetch-uv] ERROR: ${msg}\n`);
  process.exit(1);
}

function currentTarget() {
  return resolveUvTarget(process.platform, process.arch);
}

function selectedTargets() {
  if (CLI_ARGS.mode === "all") return UV_TARGETS;
  if (CLI_ARGS.mode === "current") return [currentTarget()];

  const selected = [];
  for (const dir of CLI_ARGS.targets) {
    selected.push(getUvTargetByDir(dir));
  }
  if (selected.length === 0) {
    throw new Error("--target mode requires at least one target");
  }
  return [...new Map(selected.map((target) => [target.dir, target])).values()];
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

async function sha256File(filePath) {
  return sha256Hex(await readFile(filePath));
}

async function readMetadata(metadataPath) {
  try {
    return JSON.parse(await readFile(metadataPath, "utf8"));
  } catch {
    return null;
  }
}

async function writeMetadata(metadataPath, metadata) {
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
}

async function validateCachedTarget(target, destDir, destBin) {
  if (!existsSync(destBin)) return { valid: false, reason: "binary missing" };

  const metadataPath = path.join(destDir, METADATA_FILE);
  const metadata = await readMetadata(metadataPath);
  if (!metadata || typeof metadata !== "object") {
    return { valid: false, reason: "metadata missing or invalid" };
  }

  const expectedArchiveSha256 = target.archiveSha256.toLowerCase();
  const checks = [
    ["version", UV_VERSION],
    ["target", target.dir],
    ["archive", target.archive],
    ["binary", target.bin],
  ];
  for (const [key, expected] of checks) {
    if (metadata[key] !== expected) {
      return { valid: false, reason: `metadata ${key} mismatch` };
    }
  }
  if (metadata.archiveSha256 !== expectedArchiveSha256) {
    return { valid: false, reason: "metadata archiveSha256 mismatch" };
  }
  if (metadata.archiveSha256Source !== "uv-targets") {
    return { valid: false, reason: "metadata archiveSha256Source mismatch" };
  }
  if (typeof metadata.binarySha256 !== "string" || !/^[0-9a-f]{64}$/.test(metadata.binarySha256)) {
    return { valid: false, reason: "metadata binarySha256 missing or invalid" };
  }

  const actualBinarySha256 = await sha256File(destBin);
  if (actualBinarySha256 !== metadata.binarySha256) {
    return { valid: false, reason: "binarySha256 mismatch" };
  }

  return { valid: true, reason: "ok" };
}

/**
 * Verify downloaded archive SHA256.
 *
 * UV_TARGETS가 지원 플랫폼, 아카이브 이름, known-good SHA256의 단일 기준이다.
 * 새 uv 버전으로 올릴 때는 DEFAULT_VERSION과 UV_TARGETS archiveSha256을 같이 갱신한다.
 */
async function verifyArchiveSha256(target, archiveBuffer) {
  const archiveName = target.archive;
  const actual = sha256Hex(archiveBuffer);
  const expected = target.archiveSha256.toLowerCase();
  if (actual !== expected) {
    throw new Error(
      `SHA256 불일치 — 다운로드 무결성 검증 실패.\n` +
      `  archive:  ${archiveName}\n` +
      `  expected: ${expected}\n` +
      `  actual:   ${actual}\n`,
    );
  }
  log(`  SHA256 verified (UV_TARGETS known-good): ${actual.slice(0, 16)}…`);
  return { archiveName, archiveSha256: actual, source: "uv-targets" };
}

/**
 * Try to load archive from repo-vendored resources/uv-archives/<archive>.
 * Returns Buffer if present (caller still SHA256-verifies), null otherwise.
 *
 * Rationale: archives are committed via Git LFS / direct blobs so postinstall
 * works offline and in CI without network. SHA256 verification still runs against
 * the same UV_TARGETS known-good values, so a tampered vendored file is detected.
 */
async function loadVendoredArchive(target) {
  const vendoredPath = path.join(PROJECT_ROOT, VENDORED_ARCHIVES_DIR, target.archive);
  if (!existsSync(vendoredPath)) return null;
  try {
    const buf = await readFile(vendoredPath);
    return { buffer: buf, vendoredPath };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`  vendored archive read failed (${msg}) — falling back to HTTP`);
    return null;
  }
}

async function downloadTarget(target) {
  const destDir = path.join(PROJECT_ROOT, "resources", "uv", target.dir);
  const destBin = path.join(destDir, target.bin);
  const metadataPath = path.join(destDir, METADATA_FILE);

  if (existsSync(destBin)) {
    const cached = await validateCachedTarget(target, destDir, destBin);
    if (cached.valid) {
      log(`SKIP (verified cache): ${path.relative(PROJECT_ROOT, destBin)}`);
      return;
    }
    log(`CACHE STALE (${cached.reason}): ${path.relative(PROJECT_ROOT, destBin)} — refetching`);
  }

  await mkdir(destDir, { recursive: true });

  let buffer;
  let source;
  const vendored = await loadVendoredArchive(target);
  if (vendored) {
    buffer = vendored.buffer;
    source = `vendored (${path.relative(PROJECT_ROOT, vendored.vendoredPath)})`;
    log(`Using vendored archive: ${source} (${(buffer.length / 1024 / 1024).toFixed(1)} MB)`);
  } else {
    const url = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${target.archive}`;
    log(`Downloading: ${url}`);
    const resp = await fetchWithRedirect(url);
    const arrayBuffer = await resp.arrayBuffer();
    buffer = Buffer.from(arrayBuffer);
    source = "http";
    log(`  Downloaded ${(buffer.length / 1024 / 1024).toFixed(1)} MB`);
  }

  log(`  Extracting ${target.bin}... (source: ${source})`);

  const verification = await verifyArchiveSha256(target, buffer);

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
  await writeFile(tmpBin, fileData);
  await rename(tmpBin, destBin);

  // Unix: chmod +x
  if (process.platform !== "win32" && target.bin !== "uv.exe") {
    await chmod(destBin, 0o755);
  }

  await writeMetadata(metadataPath, {
    schema: 1,
    version: UV_VERSION,
    target: target.dir,
    archive: target.archive,
    archiveSha256: verification.archiveSha256,
    archiveSha256Source: verification.source,
    binary: target.bin,
    binarySha256: sha256Hex(fileData),
  });

  log(`  OK: ${path.relative(PROJECT_ROOT, destBin)} (${(fileData.length / 1024).toFixed(0)} KB)`);
}

// ─── 메인 ─────────────────────────────────────────────────

async function main() {
  const targets = selectedTargets();
  log(`uv version: ${UV_VERSION}`);
  log(`대상 디렉토리: ${path.join(PROJECT_ROOT, "resources", "uv")}`);
  log(`선택 플랫폼: ${targets.map((target) => target.dir).join(", ")}`);
  log("");

  const errors = [];

  for (const target of targets) {
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
    process.stderr.write(`[fetch-uv] ${errors.length}개 선택 플랫폼 다운로드 실패:\n`);
    for (const e of errors) process.stderr.write(`  - ${e}\n`);
    process.stderr.write(`[fetch-uv] 네트워크 연결을 확인하거나 수동으로 다운로드하세요.\n`);
    process.exit(1);
  } else {
    log("선택 플랫폼 uv binary 다운로드 완료.");
  }
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
