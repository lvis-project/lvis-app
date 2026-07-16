import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
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

export function readRegularFile(path, label, { maxBytes = 128 * 1024 * 1024, allowAbsolute = true } = {}) {
  if (!allowAbsolute && isAbsolute(path)) fail(`${label}: absolute path is forbidden`);
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    fail(`${label}: cannot stat (${error.message})`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) fail(`${label}: must be a regular non-symlink file`);
  if (stat.size <= 0 || stat.size > maxBytes) fail(`${label}: invalid file size ${stat.size}`);
  let descriptor;
  let bytes;
  let opened;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    opened = fstatSync(descriptor);
    const current = lstatSync(path);
    if (!opened.isFile() || current.isSymbolicLink() || !current.isFile()
      || opened.dev !== current.dev || opened.ino !== current.ino || opened.size !== current.size) {
      fail(`${label}: file identity changed while opening`);
    }
    bytes = readFileSync(descriptor);
  } catch (error) {
    if (String(error.message).startsWith("[a2a-p4-5-evidence]")) throw error;
    fail(`${label}: cannot open without following links (${error.message})`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  if (bytes.length !== opened.size) fail(`${label}: file size changed while reading`);
  const resolvedPath = realpathSync(path);
  return { path: resolvedPath, bytes, size: opened.size, sha256: sha256Buffer(bytes) };
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
  let cursor = base;
  const components = rel.split(sep);
  for (const [index, component] of components.entries()) {
    cursor = resolve(cursor, component);
    let componentStat;
    try {
      componentStat = lstatSync(cursor);
    } catch (error) {
      fail(`${label}: missing path component (${error.message})`);
    }
    if (componentStat.isSymbolicLink()) fail(`${label}: symlink path components are forbidden`);
    if (index < components.length - 1 && !componentStat.isDirectory()) fail(`${label}: non-directory path component`);
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
