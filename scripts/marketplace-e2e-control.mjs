#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyPluginBundleE2EInputs } from "./plugin-bundle-e2e-inputs.mjs";

const FULL_SHA = /^[0-9a-f]{40}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const NONCE = /^[0-9a-f]{64}$/u;
const MAX_JSON_BYTES = 1024 * 1024;
const SOURCE_NAMES = ["host", "marketplace", "sdk", "ep"];
const OUTPUT_KINDS = new Set(["marketplace-image", "ep-bundle"]);
const USTAR_BLOCK = 512;
const ZIP_LOCAL_HEADER = 0x04034b50;
const ZIP_CENTRAL_HEADER = 0x02014b50;
const ZIP_END = 0x06054b50;

function fail(message) {
  throw new Error(`[marketplace-e2e-control] ${message}`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function requirePattern(label, value, pattern) {
  if (!pattern.test(value ?? "")) fail(`${label} is invalid`);
  return value;
}

function requireFullSha(label, value) {
  return requirePattern(label, value, FULL_SHA);
}

function requireNonce(value) {
  return requirePattern("nonce", value, NONCE);
}

function requireDigest(label, value) {
  return requirePattern(label, value, DIGEST);
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function ensurePlainFile(path, label, maxBytes = Number.MAX_SAFE_INTEGER) {
  const stat = lstatSync(path);
  if (!stat.isFile()) fail(`${label} must be a regular file`);
  if (stat.isSymbolicLink()) fail(`${label} must not be a symlink`);
  if (stat.nlink !== 1) fail(`${label} must not be hard-linked`);
  if (stat.size <= 0 || stat.size > maxBytes) {
    fail(`${label} size ${stat.size} is outside the accepted range`);
  }
  return stat;
}

function readJsonFile(path, label) {
  ensurePlainFile(path, label, MAX_JSON_BYTES);
  let value;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(
      `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must contain a JSON object`);
  }
  return value;
}

function writePrivateJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, stableJson(value), { mode: 0o600, flag: "wx" });
  chmodSync(path, 0o600);
}

function safeRelativePath(root, path) {
  const rel = relative(root, path).split(sep).join("/");
  if (
    !rel ||
    rel === "." ||
    rel.startsWith("/") ||
    rel.includes("\\") ||
    rel
      .split("/")
      .some(
        (part) =>
          part === "" || part === "." || part === ".." || part === ".git",
      )
  ) {
    fail(`unsafe archive path ${JSON.stringify(rel)}`);
  }
  return rel;
}

export function walkSafeTree(rootPath, { excludeGit = true } = {}) {
  const root = resolve(rootPath);
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    fail(`source root ${root} must be a real directory`);
  }
  const canonicalRoot = realpathSync(root);
  const entries = [];

  function visit(directory) {
    for (const dirent of readdirSync(directory, { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name, "en"),
    )) {
      if (dirent.name === ".git") {
        if (excludeGit) continue;
        fail(
          `${safeRelativePath(root, join(directory, dirent.name))} is forbidden in this tree`,
        );
      }
      const absolute = join(directory, dirent.name);
      const stat = lstatSync(absolute);
      const rel = safeRelativePath(root, absolute);
      const canonicalParent = realpathSync(dirname(absolute));
      if (
        canonicalParent !== canonicalRoot &&
        !canonicalParent.startsWith(`${canonicalRoot}${sep}`)
      ) {
        fail(`${rel} escapes its source root`);
      }
      if (stat.isSymbolicLink()) fail(`${rel} is a forbidden symlink`);
      if (stat.isDirectory()) {
        entries.push({
          absolute,
          path: rel,
          type: "directory",
          mode: 0o755,
          size: 0,
        });
        visit(absolute);
        continue;
      }
      if (!stat.isFile()) fail(`${rel} is a forbidden special file`);
      if (stat.nlink !== 1) fail(`${rel} is a forbidden hard link`);
      entries.push({
        absolute,
        path: rel,
        type: "file",
        mode: stat.mode & 0o111 ? 0o755 : 0o644,
        size: stat.size,
        identity: {
          dev: stat.dev,
          ino: stat.ino,
          mtimeMs: stat.mtimeMs,
        },
      });
    }
  }

  visit(root);
  if (entries.length === 0) fail(`source root ${root} is empty`);
  return entries;
}

function writeUtf8Field(block, offset, length, value, label) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > length) fail(`${label} is too long for ustar`);
  bytes.copy(block, offset);
}

function writeOctalField(block, offset, length, value, label) {
  const rendered = value.toString(8);
  if (rendered.length > length - 1) fail(`${label} does not fit in ustar`);
  block.write(
    `${rendered.padStart(length - 1, "0")}\0`,
    offset,
    length,
    "ascii",
  );
}

function splitUstarPath(path) {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: "" };
  for (
    let index = path.lastIndexOf("/");
    index > 0;
    index = path.lastIndexOf("/", index - 1)
  ) {
    const prefix = path.slice(0, index);
    const name = path.slice(index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
      return { name, prefix };
    }
  }
  fail(`archive path is too long for ustar: ${path}`);
}

function ustarHeader(entry) {
  const block = Buffer.alloc(USTAR_BLOCK);
  const storedPath = entry.type === "directory" ? `${entry.path}/` : entry.path;
  const { name, prefix } = splitUstarPath(storedPath);
  writeUtf8Field(block, 0, 100, name, "ustar name");
  writeOctalField(block, 100, 8, entry.mode, "mode");
  writeOctalField(block, 108, 8, 0, "uid");
  writeOctalField(block, 116, 8, 0, "gid");
  writeOctalField(block, 124, 12, entry.size, "size");
  writeOctalField(block, 136, 12, 0, "mtime");
  block.fill(0x20, 148, 156);
  block[156] = entry.type === "directory" ? 0x35 : 0x30;
  writeUtf8Field(block, 257, 6, "ustar\0", "ustar magic");
  writeUtf8Field(block, 263, 2, "00", "ustar version");
  writeUtf8Field(block, 345, 155, prefix, "ustar prefix");
  const checksum = block.reduce((sum, byte) => sum + byte, 0);
  block.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return block;
}

export function createSafeSourceArchive(sourceRoot, archivePath) {
  const entries = walkSafeTree(sourceRoot);
  const chunks = [];
  for (const entry of entries) {
    chunks.push(ustarHeader(entry));
    if (entry.type === "file") {
      let descriptor;
      let bytes;
      try {
        descriptor = openSync(
          entry.absolute,
          constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
        );
        const before = fstatSync(descriptor);
        for (const [label, actual] of [
          ["device", before.dev],
          ["inode", before.ino],
          ["size", before.size],
          ["mtime", before.mtimeMs],
        ]) {
          const expected =
            label === "device"
              ? entry.identity.dev
              : label === "inode"
                ? entry.identity.ino
                : label === "size"
                  ? entry.size
                  : entry.identity.mtimeMs;
          if (actual !== expected)
            fail(`${entry.path} changed before it was archived (${label})`);
        }
        if (!before.isFile() || before.nlink !== 1) {
          fail(`${entry.path} changed type before it was archived`);
        }
        bytes = readFileSync(descriptor);
        const after = fstatSync(descriptor);
        for (const [label, actual] of [
          ["device", after.dev],
          ["inode", after.ino],
          ["size", after.size],
          ["mtime", after.mtimeMs],
        ]) {
          const expected =
            label === "device"
              ? before.dev
              : label === "inode"
                ? before.ino
                : label === "size"
                  ? before.size
                  : before.mtimeMs;
          if (actual !== expected)
            fail(`${entry.path} changed while it was archived (${label})`);
        }
        if (!after.isFile() || after.nlink !== 1) {
          fail(`${entry.path} changed type while it was archived`);
        }
      } finally {
        if (descriptor !== undefined) closeSync(descriptor);
      }
      chunks.push(bytes);
      const padding =
        (USTAR_BLOCK - (bytes.length % USTAR_BLOCK)) % USTAR_BLOCK;
      if (padding) chunks.push(Buffer.alloc(padding));
    }
  }
  chunks.push(Buffer.alloc(USTAR_BLOCK * 2));
  mkdirSync(dirname(archivePath), { recursive: true, mode: 0o700 });
  writeFileSync(archivePath, Buffer.concat(chunks), {
    mode: 0o600,
    flag: "wx",
  });
  return validateSafeSourceArchive(archivePath);
}

function readTarString(block, offset, length) {
  const end = block.indexOf(0, offset);
  return block
    .subarray(
      offset,
      end >= offset && end < offset + length ? end : offset + length,
    )
    .toString("utf8");
}

function readTarOctal(block, offset, length, label) {
  const raw = block
    .subarray(offset, offset + length)
    .toString("ascii")
    .replace(/\0.*$/u, "")
    .trim();
  if (!/^[0-7]+$/u.test(raw)) fail(`${label} has an invalid octal field`);
  return Number.parseInt(raw, 8);
}

function validateMemberPath(path) {
  const normalized = path.endsWith("/") ? path.slice(0, -1) : path;
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.includes("\\") ||
    normalized
      .split("/")
      .some((part) => part === "" || part === "." || part === "..")
  ) {
    fail(`archive contains unsafe member path ${JSON.stringify(path)}`);
  }
  return normalized;
}

export function inspectSafeUstar(bytes) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length < USTAR_BLOCK * 2 ||
    bytes.length % USTAR_BLOCK !== 0
  ) {
    fail("source archive is not block-aligned ustar");
  }
  const members = [];
  const seen = new Set();
  let offset = 0;
  let zeroBlocks = 0;
  while (offset < bytes.length) {
    const block = bytes.subarray(offset, offset + USTAR_BLOCK);
    if (block.every((byte) => byte === 0)) {
      zeroBlocks += 1;
      offset += USTAR_BLOCK;
      if (zeroBlocks === 2) {
        if (!bytes.subarray(offset).every((byte) => byte === 0)) {
          fail("source archive contains bytes after its end marker");
        }
        break;
      }
      continue;
    }
    if (zeroBlocks !== 0) fail("source archive has a partial end marker");
    if (readTarString(block, 257, 6) !== "ustar")
      fail("source archive is not ustar");
    const expectedChecksum = readTarOctal(block, 148, 8, "ustar checksum");
    const checksumBlock = Buffer.from(block);
    checksumBlock.fill(0x20, 148, 156);
    const actualChecksum = checksumBlock.reduce((sum, byte) => sum + byte, 0);
    if (actualChecksum !== expectedChecksum)
      fail("source archive header checksum mismatch");
    const name = readTarString(block, 0, 100);
    const prefix = readTarString(block, 345, 155);
    const path = validateMemberPath(prefix ? `${prefix}/${name}` : name);
    if (seen.has(path))
      fail(`source archive contains duplicate member ${path}`);
    seen.add(path);
    const typeFlag = String.fromCharCode(block[156] || 0x30);
    if (typeFlag !== "0" && typeFlag !== "5") {
      const labels = {
        1: "hard link",
        2: "symlink",
        3: "character device",
        4: "block device",
        6: "fifo",
      };
      fail(
        `source archive contains forbidden ${labels[typeFlag] ?? `type ${typeFlag}`} at ${path}`,
      );
    }
    const size = readTarOctal(block, 124, 12, "ustar size");
    if (typeFlag === "5" && size !== 0)
      fail(`directory ${path} has a non-zero size`);
    if (readTarString(block, 157, 100))
      fail(`source archive member ${path} has a link target`);
    members.push({ path, type: typeFlag === "5" ? "directory" : "file", size });
    offset += USTAR_BLOCK + Math.ceil(size / USTAR_BLOCK) * USTAR_BLOCK;
    if (offset > bytes.length)
      fail(`source archive member ${path} exceeds the archive`);
  }
  if (zeroBlocks < 2) fail("source archive has no complete end marker");
  if (members.length === 0) fail("source archive has no members");
  return members;
}

export function validateSafeSourceArchive(archivePath) {
  const stat = ensurePlainFile(archivePath, "source archive");
  const bytes = readFileSync(archivePath);
  const members = inspectSafeUstar(bytes);
  return { file: archivePath, sha256: sha256(bytes), size: stat.size, members };
}

export function inspectSafeZip(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 22)
    fail("EP bundle is not a ZIP archive");
  const searchStart = Math.max(0, bytes.length - 65_557);
  let endOffset = -1;
  for (let offset = bytes.length - 22; offset >= searchStart; offset -= 1) {
    if (bytes.readUInt32LE(offset) === ZIP_END) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) fail("EP bundle has no ZIP end record");
  const disk = bytes.readUInt16LE(endOffset + 4);
  const centralDisk = bytes.readUInt16LE(endOffset + 6);
  const entriesOnDisk = bytes.readUInt16LE(endOffset + 8);
  const entryCount = bytes.readUInt16LE(endOffset + 10);
  const centralSize = bytes.readUInt32LE(endOffset + 12);
  const centralOffset = bytes.readUInt32LE(endOffset + 16);
  const commentLength = bytes.readUInt16LE(endOffset + 20);
  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    entriesOnDisk !== entryCount ||
    entryCount === 0 ||
    entryCount === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff ||
    endOffset + 22 + commentLength !== bytes.length ||
    centralOffset + centralSize !== endOffset
  ) {
    fail(
      "EP bundle uses an unsupported split, ZIP64, empty, or trailing ZIP layout",
    );
  }
  const seen = new Set();
  const entries = [];
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (
      offset + 46 > endOffset ||
      bytes.readUInt32LE(offset) !== ZIP_CENTRAL_HEADER
    ) {
      fail("EP bundle central directory is malformed");
    }
    const versionMadeBy = bytes.readUInt16LE(offset + 4);
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const uncompressedSize = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const entryCommentLength = bytes.readUInt16LE(offset + 32);
    const diskStart = bytes.readUInt16LE(offset + 34);
    const externalAttributes = bytes.readUInt32LE(offset + 38);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const entryEnd =
      offset + 46 + nameLength + extraLength + entryCommentLength;
    if (
      entryEnd > endOffset ||
      diskStart !== 0 ||
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localOffset === 0xffffffff ||
      localOffset + 30 > centralOffset ||
      bytes.readUInt32LE(localOffset) !== ZIP_LOCAL_HEADER
    ) {
      fail("EP bundle entry has an unsupported ZIP layout");
    }
    if ((flags & 0x1) !== 0 || ![0, 8].includes(method)) {
      fail("EP bundle contains encrypted or unsupported compression");
    }
    const rawName = bytes
      .subarray(offset + 46, offset + 46 + nameLength)
      .toString("utf8");
    const path = validateMemberPath(rawName);
    if (seen.has(path)) fail(`EP bundle contains duplicate member ${path}`);
    seen.add(path);
    const hostSystem = versionMadeBy >>> 8;
    if (hostSystem !== 3)
      fail(`EP bundle member ${path} lacks Unix file type metadata`);
    const mode = (externalAttributes >>> 16) & 0xffff;
    const fileType = mode & 0o170000;
    const directory = rawName.endsWith("/");
    if (
      (directory && fileType !== 0o040000) ||
      (!directory && fileType !== 0o100000)
    ) {
      const labels = new Map([
        [0o120000, "symlink"],
        [0o010000, "fifo"],
        [0o020000, "character device"],
        [0o060000, "block device"],
      ]);
      fail(
        `EP bundle contains forbidden ${labels.get(fileType) ?? "special file"} at ${path}`,
      );
    }
    entries.push({ path, type: directory ? "directory" : "file" });
    offset = entryEnd;
  }
  if (offset !== endOffset)
    fail("EP bundle central directory size is inconsistent");
  return entries;
}

export function validateSafeZip(path) {
  ensurePlainFile(path, "EP bundle");
  const bytes = readFileSync(path);
  return { sha256: sha256(bytes), entries: inspectSafeZip(bytes) };
}

export function extractSafeSourceArchive(archivePath, destination) {
  const archive = validateSafeSourceArchive(archivePath);
  const root = resolve(destination);
  mkdirSync(root, { recursive: false, mode: 0o700 });
  const result = spawnSync(
    "tar",
    [
      "-xf",
      resolve(archivePath),
      "--no-same-owner",
      "--no-same-permissions",
      "-C",
      root,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.status !== 0)
    fail(`trusted tar extraction failed: ${result.stderr.trim()}`);
  walkSafeTree(root);
  return archive;
}

function fileDescriptor(path, label) {
  const stat = ensurePlainFile(path, label);
  const bytes = readFileSync(path);
  return {
    file: path.split(sep).at(-1),
    sha256: sha256(bytes),
    size: stat.size,
  };
}

function assertRefs(actual, expected) {
  for (const name of SOURCE_NAMES) {
    const expectedName = name === "ep" ? "epApi" : name;
    const expectedSha = requireFullSha(
      `${expectedName} ref`,
      expected[expectedName],
    );
    if (actual?.[expectedName] !== expectedSha) {
      fail(
        `${expectedName} ref ${String(actual?.[expectedName])} does not match ${expectedSha}`,
      );
    }
  }
}

export function validateInputManifest(manifestPath, expected) {
  const manifest = readJsonFile(manifestPath, "input manifest");
  if (
    manifest.schemaVersion !== 1 ||
    manifest.kind !== "marketplace-e2e-inputs"
  ) {
    fail("input manifest contract is unsupported");
  }
  requireNonce(manifest.nonce);
  if (
    manifest.workflowSha !==
    requireFullSha("workflow SHA", expected.workflowSha)
  ) {
    fail("input manifest workflow SHA mismatch");
  }
  assertRefs(manifest.refs, expected.refs);
  requireDigest("schema digest", manifest.schemaSha256);
  for (const name of SOURCE_NAMES) {
    const descriptor = manifest.sources?.[name];
    requireDigest(`${name} source digest`, descriptor?.sha256);
    if (
      descriptor?.file !== `${name}-source.tar` ||
      !Number.isSafeInteger(descriptor?.size) ||
      descriptor.size <= 0
    ) {
      fail(`${name} source descriptor is invalid`);
    }
  }
  return manifest;
}

export function verifyBoundSource({
  manifestPath,
  expected,
  sourceName,
  archivePath,
}) {
  if (!SOURCE_NAMES.includes(sourceName)) fail(`unknown source ${sourceName}`);
  const manifest = validateInputManifest(manifestPath, expected);
  const archive = validateSafeSourceArchive(archivePath);
  const descriptor = manifest.sources[sourceName];
  if (
    archive.sha256 !== descriptor.sha256 ||
    archive.size !== descriptor.size
  ) {
    fail(`${sourceName} source archive is not bound to the input manifest`);
  }
  return { manifest, archive };
}

export function createOutputManifest({
  kind,
  inputManifestPath,
  expected,
  artifactPath,
  outputPath,
}) {
  if (!OUTPUT_KINDS.has(kind)) fail(`unsupported output kind ${kind}`);
  const input = validateInputManifest(inputManifestPath, expected);
  if (kind === "ep-bundle") validateSafeZip(artifactPath);
  const manifest = {
    schemaVersion: 1,
    kind,
    nonce: input.nonce,
    workflowSha: input.workflowSha,
    refs: input.refs,
    inputManifestSha256: sha256(readFileSync(inputManifestPath)),
    artifact: fileDescriptor(artifactPath, `${kind} artifact`),
  };
  writePrivateJson(outputPath, manifest);
  return manifest;
}

export function validateOutputManifest({
  kind,
  inputManifestPath,
  outputManifestPath,
  artifactPath,
  expected,
}) {
  const input = validateInputManifest(inputManifestPath, expected);
  if (kind === "ep-bundle") validateSafeZip(artifactPath);
  const output = readJsonFile(outputManifestPath, `${kind} manifest`);
  if (
    output.schemaVersion !== 1 ||
    output.kind !== kind ||
    output.nonce !== input.nonce ||
    output.workflowSha !== input.workflowSha
  ) {
    fail(`${kind} manifest binding is invalid`);
  }
  assertRefs(output.refs, input.refs);
  if (output.inputManifestSha256 !== sha256(readFileSync(inputManifestPath))) {
    fail(`${kind} manifest input digest mismatch`);
  }
  const actual = fileDescriptor(artifactPath, `${kind} artifact`);
  if (
    output.artifact?.file !== actual.file ||
    output.artifact?.sha256 !== actual.sha256 ||
    output.artifact?.size !== actual.size
  ) {
    fail(`${kind} artifact digest mismatch`);
  }
  return { input, output, actual };
}

function requireTrue(label, value) {
  if (value !== true) fail(`${label} was not proved`);
}

function requireFalse(label, value) {
  if (value !== false) fail(`${label} must be false`);
}

function requireEvidenceRefs(label, value, refs) {
  for (const [name, expected] of Object.entries(refs)) {
    if (value?.[`${name}Sha`] !== expected) {
      fail(`${label}.${name}Sha does not match the exact input ref`);
    }
  }
}

export function validateLifecycleEvidence(value, refs) {
  const live = value?.liveLifecycle;
  const attendance = value?.actualEpAttendance;
  const containment = value?.containmentRehearsal;
  if (!live || !attendance || !containment)
    fail("candidate lifecycle evidence is incomplete");
  requireEvidenceRefs("liveLifecycle", live, refs);
  requireEvidenceRefs("actualEpAttendance", attendance, refs);
  requireTrue("liveLifecycle.zeroOrphans", live.zeroOrphans);
  requireTrue(
    "attendance exact source archive",
    attendance.artifact?.exactSourceArchive,
  );
  requireFalse(
    "attendance marketplace production write",
    attendance.marketplace?.productionWriteExecuted,
  );
  requireFalse(
    "attendance provider production credentials",
    attendance.provider?.productionCredentialsUsed,
  );
  if (
    !(attendance.provider?.calendarReads >= 2) ||
    !(attendance.provider?.calendarWrites >= 1)
  ) {
    fail("attendance read-write-readback provider calls are incomplete");
  }
  requireTrue(
    "attendance missing grant rejection",
    attendance.attendance?.missingGrantRejected,
  );
  requireTrue(
    "attendance forged grant rejection",
    attendance.attendance?.forgedGrantRejected,
  );
  requireTrue(
    "attendance explicit confirmation",
    attendance.attendance?.explicitConfirmation,
  );
  requireTrue(
    "attendance provider verification",
    attendance.attendance?.providerVerified,
  );
  if (
    !attendance.attendance?.writeStatus ||
    attendance.attendance?.readback == null
  ) {
    fail("attendance write or readback evidence is missing");
  }
  requireTrue(
    "attendance disabled skill retirement",
    attendance.retirement?.disabled?.skillRetired,
  );
  requireTrue(
    "attendance disabled tool retirement",
    attendance.retirement?.disabled?.toolsRetired,
  );
  requireTrue(
    "attendance disabled runtime retirement",
    attendance.retirement?.disabled?.runtimeRetired,
  );
  requireTrue(
    "attendance uninstalled skill retirement",
    attendance.retirement?.uninstalled?.skillRetired,
  );
  requireTrue(
    "attendance uninstalled tool retirement",
    attendance.retirement?.uninstalled?.toolsRetired,
  );
  requireTrue("attendance zero orphans", attendance.retirement?.zeroOrphans);
  requireTrue(
    "attendance exact hook and MCP absence",
    attendance.retirement?.hookAndMcpAbsenceMatchesExactManifest,
  );
  requireFalse(
    "containment production write",
    containment.productionWriteExecuted,
  );
  if (
    JSON.stringify(containment.orderedActions) !==
    JSON.stringify([
      "version-yank",
      "plugin-yank",
      "corrective-sdk",
      "host-decision",
    ])
  ) {
    fail("containment action ordering is invalid");
  }
  requireTrue(
    "containment rollback block before containment",
    containment.hostRollbackBlockedBeforeContainment,
  );
  requireTrue(
    "containment rollback allow after containment",
    containment.hostRollbackAllowed,
  );
  return { live, attendance, containment };
}

export function validateEvidenceTree(rootPath) {
  const entries = walkSafeTree(rootPath, { excludeGit: false });
  if (!entries.some((entry) => entry.type === "file"))
    fail("evidence tree has no files");
  return entries;
}

export function createFinalEvidence({
  inputManifestPath,
  marketplaceManifestPath,
  marketplaceArtifactPath,
  epManifestPath,
  epArtifactPath,
  candidateEvidenceRoot,
  candidateEvidencePath,
  outputPath,
  expected,
}) {
  const marketplace = validateOutputManifest({
    kind: "marketplace-image",
    inputManifestPath,
    outputManifestPath: marketplaceManifestPath,
    artifactPath: marketplaceArtifactPath,
    expected,
  });
  const ep = validateOutputManifest({
    kind: "ep-bundle",
    inputManifestPath,
    outputManifestPath: epManifestPath,
    artifactPath: epArtifactPath,
    expected,
  });
  validateEvidenceTree(candidateEvidenceRoot);
  const canonicalEvidenceRoot = realpathSync(candidateEvidenceRoot);
  const canonicalEvidence = realpathSync(candidateEvidencePath);
  if (
    canonicalEvidence !== canonicalEvidenceRoot &&
    !canonicalEvidence.startsWith(`${canonicalEvidenceRoot}${sep}`)
  ) {
    fail("candidate lifecycle evidence escapes its evidence root");
  }
  const evidence = readJsonFile(
    candidateEvidencePath,
    "candidate lifecycle evidence",
  );
  validateLifecycleEvidence(evidence, marketplace.input.refs);
  const envelope = {
    schemaVersion: 1,
    kind: "marketplace-e2e-final-evidence",
    nonce: marketplace.input.nonce,
    workflowSha: marketplace.input.workflowSha,
    refs: marketplace.input.refs,
    inputManifestSha256: sha256(readFileSync(inputManifestPath)),
    artifacts: {
      marketplaceImageSha256: marketplace.actual.sha256,
      epBundleSha256: ep.actual.sha256,
    },
    candidateEvidenceSha256: sha256(readFileSync(candidateEvidencePath)),
    proofs: {
      liveLifecycle: true,
      attendanceReadWriteReadback: true,
      disableUninstallZeroOrphans: true,
      reverseContainment: true,
      productionWriteExecuted: false,
    },
  };
  writePrivateJson(outputPath, envelope);
  return envelope;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined)
      fail(`invalid CLI argument ${String(key)}`);
    args[key.slice(2)] = value;
  }
  return args;
}

function expectedFromArgs(args) {
  return {
    workflowSha: args["workflow-sha"],
    refs: {
      host: args["host-sha"],
      marketplace: args["marketplace-sha"],
      sdk: args["sdk-sha"],
      epApi: args["ep-api-sha"],
    },
  };
}

function stage(args) {
  const expected = expectedFromArgs(args);
  const evidence = verifyPluginBundleE2EInputs({
    hostRoot: resolve(args["host-root"]),
    marketplaceRoot: resolve(args["marketplace-root"]),
    sdkRoot: resolve(args["sdk-root"]),
    epApiRoot: resolve(args["ep-root"]),
    hostSha: expected.refs.host,
    marketplaceSha: expected.refs.marketplace,
    sdkSha: expected.refs.sdk,
    epApiSha: expected.refs.epApi,
  });
  const outputDir = resolve(args["output-dir"]);
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const roots = {
    host: resolve(args["host-root"]),
    marketplace: resolve(args["marketplace-root"]),
    sdk: resolve(args["sdk-root"]),
    ep: resolve(args["ep-root"]),
  };
  const sources = {};
  for (const name of SOURCE_NAMES) {
    const path = join(outputDir, `${name}-source.tar`);
    const archive = createSafeSourceArchive(roots[name], path);
    sources[name] = {
      file: `${name}-source.tar`,
      sha256: archive.sha256,
      size: archive.size,
    };
  }
  const manifest = {
    schemaVersion: 1,
    kind: "marketplace-e2e-inputs",
    nonce: randomBytes(32).toString("hex"),
    workflowSha: requireFullSha("workflow SHA", expected.workflowSha),
    refs: evidence.refs,
    sdkDependency: evidence.sdkDependency,
    sdkLockPrefix: evidence.sdkLockPrefix,
    schemaSha256: evidence.schemaSha256,
    sources,
  };
  writePrivateJson(join(outputDir, "input-manifest.json"), manifest);
  process.stdout.write(
    stableJson({
      nonce: manifest.nonce,
      manifestSha256: sha256(
        readFileSync(join(outputDir, "input-manifest.json")),
      ),
    }),
  );
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command) return;
  const args = parseArgs(rest);
  const expected = expectedFromArgs(args);
  if (command === "stage") {
    stage(args);
  } else if (command === "verify-source") {
    verifyBoundSource({
      manifestPath: args.manifest,
      expected,
      sourceName: args.source,
      archivePath: args.archive,
    });
  } else if (command === "extract-source") {
    verifyBoundSource({
      manifestPath: args.manifest,
      expected,
      sourceName: args.source,
      archivePath: args.archive,
    });
    extractSafeSourceArchive(args.archive, args.destination);
  } else if (command === "bind-output") {
    createOutputManifest({
      kind: args.kind,
      inputManifestPath: args.manifest,
      expected,
      artifactPath: args.artifact,
      outputPath: args.output,
    });
  } else if (command === "verify-output") {
    validateOutputManifest({
      kind: args.kind,
      inputManifestPath: args.manifest,
      outputManifestPath: args["output-manifest"],
      artifactPath: args.artifact,
      expected,
    });
  } else if (command === "finalize-evidence") {
    createFinalEvidence({
      inputManifestPath: args.manifest,
      marketplaceManifestPath: args["marketplace-manifest"],
      marketplaceArtifactPath: args["marketplace-artifact"],
      epManifestPath: args["ep-manifest"],
      epArtifactPath: args["ep-artifact"],
      candidateEvidenceRoot: args["candidate-evidence-root"],
      candidateEvidencePath: args["candidate-evidence"],
      outputPath: args.output,
      expected,
    });
  } else {
    fail(`unknown command ${command}`);
  }
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) main();
