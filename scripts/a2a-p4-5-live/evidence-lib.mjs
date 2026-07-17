import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { parseStrictJson } from "./strict-json.mjs";

export const SHA256_RE = /^[0-9a-f]{64}$/u;
export const HEAD_SHA_RE = /^[0-9a-f]{40}$/u;
export const PLACEHOLDER_RE = /(?:^|[\s._:/-])(?:change[-_ ]?me|example|placeholder|todo|tbd|unknown|dummy|fake|n\/?a)(?:$|[\s._:/-])/iu;

export function fail(message) {
  throw new Error(`[a2a-p4-5-evidence] ${message}`);
}

export function assertRecord(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label}: expected object`);
  }
  return value;
}

export function assertExactKeys(value, expected, label) {
  assertRecord(value, label);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  const missing = wanted.filter((key) => !actual.includes(key));
  const unknown = actual.filter((key) => !wanted.includes(key));
  if (missing.length || unknown.length) {
    fail(`${label}: schema mismatch (missing=${missing.join(",") || "none"}; unknown=${unknown.join(",") || "none"})`);
  }
}

export function assertArray(value, label, { min = 0, max = 10_000 } = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    fail(`${label}: expected array length ${min}..${max}`);
  }
  return value;
}

export function assertSafeString(value, label, { min = 1, max = 2048, pattern } = {}) {
  if (typeof value !== "string" || value.length < min || value.length > max || value.trim() !== value) {
    fail(`${label}: expected trimmed string length ${min}..${max}`);
  }
  if (value.includes("\0") || PLACEHOLDER_RE.test(value)) fail(`${label}: placeholder or NUL is forbidden`);
  if (pattern && !pattern.test(value)) fail(`${label}: invalid format`);
  return value;
}

export function assertSha256(value, label) {
  return assertSafeString(value, label, { min: 64, max: 64, pattern: SHA256_RE });
}

export function assertHeadSha(value, label) {
  return assertSafeString(value, label, { min: 40, max: 40, pattern: HEAD_SHA_RE });
}

export function sha256Buffer(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

const STREAM_CHUNK_BYTES = 1024 * 1024;

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size;
}

export function assertNoFollowFallbackPath(path, label, ...noFollowOverride) {
  const noFollowFlag = noFollowOverride.length > 0 ? noFollowOverride[0] : constants.O_NOFOLLOW;
  if (noFollowFlag !== undefined) return;
  if (resolve(path) !== realpathSync(path)) {
    fail(`${label}: symlink path components are forbidden when O_NOFOLLOW is unavailable`);
  }
}

function normalizeNeedles(needles, label) {
  assertArray(needles, `${label} streaming needles`, { max: 512 });
  return needles.map((needle, index) => {
    assertSafeString(needle, `${label} streaming needles[${index}]`, { max: 4096 });
    return { text: needle, bytes: Buffer.from(needle, "utf8") };
  });
}

function updateNeedleMatches(chunk, carry, needles, matches) {
  if (needles.length === 0) return Buffer.alloc(0);
  const searchable = carry.length === 0 ? chunk : Buffer.concat([carry, chunk]);
  for (const needle of needles) {
    if (!matches[needle.text] && searchable.includes(needle.bytes)) matches[needle.text] = true;
  }
  const maxNeedleBytes = Math.max(...needles.map((needle) => needle.bytes.length));
  return searchable.subarray(Math.max(0, searchable.length - Math.max(0, maxNeedleBytes - 1)));
}

export function readRegularFile(path, label, {
  maxBytes = 128 * 1024 * 1024,
  allowAbsolute = true,
  loadBytes = true,
  needles = [],
} = {}) {
  if (!allowAbsolute && isAbsolute(path)) fail(`${label}: absolute path is forbidden`);
  let descriptor;
  let canonicalDescriptor;
  let bytes;
  let opened;
  let canonicalPath;
  try {
    // Platforms without O_NOFOLLOW must prove the lexical path is already its
    // canonical path. Repeat after opening so a link swap cannot make the
    // fallback silently follow a symlink between validation and open.
    assertNoFollowFallbackPath(path, label);
    // Open first with O_NOFOLLOW. There is intentionally no path-based lstat
    // check before this operation: the descriptor is the authority for type,
    // size, hashing, and identity, avoiding the check/use race CodeQL flags.
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    opened = fstatSync(descriptor);
    if (!opened.isFile()) fail(`${label}: must be a regular non-symlink file`);
    if (opened.size <= 0 || opened.size > maxBytes) fail(`${label}: invalid file size ${opened.size}`);

    canonicalPath = realpathSync(path);
    if (canonicalPath !== resolve(path)) {
      fail(`${label}: symlink path components or non-canonical aliases are forbidden`);
    }
    assertNoFollowFallbackPath(path, label);
    canonicalDescriptor = openSync(canonicalPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const canonicalOpened = fstatSync(canonicalDescriptor);
    if (!canonicalOpened.isFile() || !sameFileIdentity(opened, canonicalOpened)) {
      fail(`${label}: canonical path does not identify the opened file`);
    }

    const hash = createHash("sha256");
    const chunks = loadBytes ? [] : null;
    const normalizedNeedles = normalizeNeedles(needles, label);
    const needleMatches = Object.fromEntries(normalizedNeedles.map((needle) => [needle.text, false]));
    let carry = Buffer.alloc(0);
    let offset = 0;
    while (offset < opened.size) {
      const chunk = Buffer.allocUnsafe(Math.min(STREAM_CHUNK_BYTES, opened.size - offset));
      const count = readSync(descriptor, chunk, 0, chunk.length, offset);
      if (count <= 0) fail(`${label}: file ended before its descriptor size`);
      const data = count === chunk.length ? chunk : chunk.subarray(0, count);
      hash.update(data);
      if (chunks) chunks.push(data);
      carry = updateNeedleMatches(data, carry, normalizedNeedles, needleMatches);
      offset += count;
    }
    const afterRead = fstatSync(descriptor);
    if (!sameFileIdentity(opened, afterRead)) fail(`${label}: descriptor identity changed while reading`);
    bytes = chunks ? Buffer.concat(chunks, opened.size) : undefined;
    return {
      path: canonicalPath,
      bytes,
      size: opened.size,
      sha256: hash.digest("hex"),
      device: opened.dev,
      inode: opened.ino,
      needleMatches,
    };
  } catch (error) {
    if (String(error.message).startsWith("[a2a-p4-5-evidence]")) throw error;
    fail(`${label}: cannot read canonical regular file (${error.message})`);
  } finally {
    if (canonicalDescriptor !== undefined) closeSync(canonicalDescriptor);
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function assertArtifactStable(artifact, label, { maxBytes = artifact.size } = {}) {
  const current = readRegularFile(artifact.path, `${label} stability check`, { maxBytes, loadBytes: false });
  if (current.sha256 !== artifact.sha256 || current.size !== artifact.size
    || current.device !== artifact.device || current.inode !== artifact.inode) {
    fail(`${label}: artifact identity or digest changed after verification`);
  }
  return artifact;
}

export function resolveEvidencePath(manifestPath, candidate, label) {
  assertSafeString(candidate, label, { max: 1024 });
  if (isAbsolute(candidate) || candidate.split(/[\\/]/u).includes("..")) {
    fail(`${label}: must be a confined relative path`);
  }
  const base = realpathSync(dirname(manifestPath));
  const target = resolve(base, candidate);
  const rel = relative(base, target);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    fail(`${label}: path escapes or aliases the evidence root`);
  }
  let canonicalTarget;
  try {
    canonicalTarget = realpathSync(target);
  } catch (error) {
    fail(`${label}: missing path component (${error.message})`);
  }
  if (canonicalTarget !== target) fail(`${label}: symlink path components or non-canonical aliases are forbidden`);
  const canonicalRelative = relative(base, canonicalTarget);
  if (!canonicalRelative || canonicalRelative === ".." || canonicalRelative.startsWith(`..${sep}`) || isAbsolute(canonicalRelative)) {
    fail(`${label}: canonical artifact escapes the evidence root`);
  }
  return target;
}

export function validateDescriptor(value, label) {
  assertExactKeys(value, ["path", "sha256"], label);
  assertSafeString(value.path, `${label}.path`, { max: 1024 });
  assertSha256(value.sha256, `${label}.sha256`);
  return value;
}

export function readEvidenceDescriptor(manifestPath, descriptor, label, options = {}) {
  validateDescriptor(descriptor, label);
  const target = resolveEvidencePath(manifestPath, descriptor.path, `${label}.path`);
  const artifact = readRegularFile(target, label, { ...options, allowAbsolute: true });
  const base = realpathSync(dirname(manifestPath));
  const actualRelative = relative(base, artifact.path);
  if (!actualRelative || actualRelative === ".." || actualRelative.startsWith(`..${sep}`) || isAbsolute(actualRelative)) {
    fail(`${label}: resolved artifact escapes the evidence root`);
  }
  if (artifact.sha256 !== descriptor.sha256) {
    fail(`${label}: digest mismatch (expected ${descriptor.sha256}, got ${artifact.sha256})`);
  }
  return artifact;
}

function keyFingerprint(key) {
  const der = key.export({ format: "der", type: "spki" });
  return sha256Buffer(der);
}

export function verifySignedManifest(manifestPath, {
  signaturePath = `${manifestPath}.sig`,
  publicKeyPath = process.env.LVIS_A2A_EVIDENCE_PUBLIC_KEY_FILE,
  expectedSignerSha256 = process.env.LVIS_A2A_EVIDENCE_SIGNER_SHA256,
} = {}) {
  const manifestArtifact = readRegularFile(manifestPath, "manifest", { maxBytes: 4 * 1024 * 1024 });
  if (!publicKeyPath) fail("LVIS_A2A_EVIDENCE_PUBLIC_KEY_FILE is required");
  assertSha256(expectedSignerSha256, "LVIS_A2A_EVIDENCE_SIGNER_SHA256");
  const keyArtifact = readRegularFile(publicKeyPath, "manifest trust anchor", { maxBytes: 64 * 1024 });
  const signatureArtifact = readRegularFile(signaturePath, "manifest signature", { maxBytes: 64 * 1024 });
  const signature = parseStrictJson(signatureArtifact.bytes.toString("utf8"), "manifest signature");
  assertExactKeys(signature, ["algorithm", "signatureBase64", "signerKeySha256"], "manifest signature");
  if (signature.algorithm !== "ed25519") fail("manifest signature: algorithm must be ed25519");
  assertSha256(signature.signerKeySha256, "manifest signature.signerKeySha256");
  assertSafeString(signature.signatureBase64, "manifest signature.signatureBase64", {
    min: 80,
    max: 128,
    pattern: /^[A-Za-z0-9+/]+={0,2}$/u,
  });
  let key;
  try {
    key = createPublicKey(keyArtifact.bytes);
  } catch (error) {
    fail(`manifest trust anchor: invalid public key (${error.message})`);
  }
  if (key.asymmetricKeyType !== "ed25519") fail("manifest trust anchor: expected Ed25519 key");
  const fingerprint = keyFingerprint(key);
  if (fingerprint !== expectedSignerSha256 || signature.signerKeySha256 !== expectedSignerSha256) {
    fail("manifest signer fingerprint does not match the pinned trust anchor");
  }
  const signatureBytes = Buffer.from(signature.signatureBase64, "base64");
  if (signatureBytes.length !== 64 || signatureBytes.toString("base64") !== signature.signatureBase64
    || !verifySignature(null, manifestArtifact.bytes, key, signatureBytes)) {
    fail("manifest signature verification failed");
  }
  return {
    artifact: manifestArtifact,
    manifest: parseStrictJson(manifestArtifact.bytes.toString("utf8"), "signed manifest"),
    signerKeySha256: fingerprint,
    signatureSha256: signatureArtifact.sha256,
  };
}

export function assertUnique(values, label) {
  const unique = new Set(values);
  if (unique.size !== values.length) fail(`${label}: duplicate values are forbidden`);
}
