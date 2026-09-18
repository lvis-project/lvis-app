import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  type BigIntStats,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { createNodeSecretEncryption } from "../data/node-secret-encryption.js";
import { AuditLogger } from "./audit-logger.js";
import { createHostSecretStore } from "./host-secret-store.js";
import { iterateJsonlLinesFromFd } from "./jsonl-reader.js";
import {
  GENESIS_MARKER,
  ensureAuditSecret,
  readExistingAuditSecret,
  SafeStorageSecretStore,
  sealKeyName,
  verifyChainLine,
  verifyLineHmac,
} from "./hmac-chain.js";

export const PERMISSION_AUDIT_PROOF_SCHEMA = "lvis-permission-audit-proof/v1";
const PROOF_FLAG = "--verify-permission-audit";
const PROOF_VALUE_FLAG = `${PROOF_FLAG}=`;
const SELF_TEST_FLAG = "--create-permission-audit-self-test";
const SELF_TEST_VALUE_FLAG = `${SELF_TEST_FLAG}=`;
const USER_DATA_FLAG = "--user-data-dir=";
const CHALLENGE = /^[a-f0-9]{64}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const CANONICAL_AUDIT_NAME = /^(\d{4}-\d{2}-\d{2})\.permission-audit\.jsonl$/;
const MAX_PERMISSION_AUDIT_LINE_BYTES = 1024 * 1024;

interface PermissionAuditProofFile {
  readonly name: string;
  readonly date: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly entries: number;
}

export interface PermissionAuditProofReceipt {
  readonly schema: typeof PERMISSION_AUDIT_PROOF_SCHEMA;
  readonly challenge: string;
  readonly verifiedAt: string;
  readonly intact: true;
  readonly files: readonly PermissionAuditProofFile[];
}

export interface PermissionAuditProofCommand {
  readonly challenge: string;
}

export const PERMISSION_AUDIT_SELF_TEST_SCHEMA = "lvis-permission-audit-self-test/v1";

export interface PermissionAuditSelfTestReceipt {
  readonly schema: typeof PERMISSION_AUDIT_SELF_TEST_SCHEMA;
  readonly challenge: string;
  readonly createdAt: string;
  readonly file: PermissionAuditProofFile;
}

/** Parse the proof command before the ordinary host boot path runs. */
export function parsePermissionAuditProofCommand(
  argv: readonly string[],
): PermissionAuditProofCommand | null {
  const proofArgs = argv.filter((arg) => arg.startsWith(PROOF_FLAG));
  if (proofArgs.length === 0) return null;
  const permitted = argv.every((arg) => arg.startsWith(PROOF_FLAG) || arg.startsWith(USER_DATA_FLAG));
  const userDataArgs = argv.filter((arg) => arg.startsWith(USER_DATA_FLAG));
  if (!permitted || proofArgs.length !== 1 || !proofArgs[0]!.startsWith(PROOF_VALUE_FLAG) ||
      userDataArgs.length > 1 || userDataArgs.some((arg) => arg.length === USER_DATA_FLAG.length)) {
    throw new Error("--verify-permission-audit must be used alone except for one non-empty --user-data-dir");
  }
  const challenge = proofArgs[0]!.slice(PROOF_VALUE_FLAG.length);
  if (!CHALLENGE.test(challenge)) {
    throw new Error("permission audit proof challenge must be 64 lowercase hexadecimal characters");
  }
  return { challenge };
}

export function parsePermissionAuditSelfTestCommand(
  argv: readonly string[],
): PermissionAuditProofCommand | null {
  const selfTestArgs = argv.filter((arg) => arg.startsWith(SELF_TEST_FLAG));
  if (selfTestArgs.length === 0) return null;
  const permitted = argv.every((arg) => arg.startsWith(SELF_TEST_FLAG) || arg.startsWith(USER_DATA_FLAG));
  const userDataArgs = argv.filter((arg) => arg.startsWith(USER_DATA_FLAG));
  if (!permitted || selfTestArgs.length !== 1 || !selfTestArgs[0]!.startsWith(SELF_TEST_VALUE_FLAG) ||
      userDataArgs.length > 1 || userDataArgs.some((arg) => arg.length === USER_DATA_FLAG.length)) {
    throw new Error("--create-permission-audit-self-test must be used alone except for one non-empty --user-data-dir");
  }
  const challenge = selfTestArgs[0]!.slice(SELF_TEST_VALUE_FLAG.length);
  if (!CHALLENGE.test(challenge)) {
    throw new Error("permission audit self-test challenge must be 64 lowercase hexadecimal characters");
  }
  return { challenge };
}

/** Create one challenge-bound row using only the packaged audit implementation. */
export async function createPermissionAuditSelfTest(
  challenge: string,
  now: () => Date = () => new Date(),
): Promise<PermissionAuditSelfTestReceipt> {
  if (!CHALLENGE.test(challenge)) throw new Error("permission audit self-test challenge is invalid");
  const home = exactAbsoluteEnvironmentPath("LVIS_HOME");
  const keyFile = exactAbsoluteEnvironmentPath("LVIS_SECRET_KEY_FILE");
  const homeBefore = directoryAuthorityIdentity(home);
  const keyBefore = protectedKeyIdentity(keyFile);
  if (readdirSync(home).length !== 0) throw new Error("permission audit self-test requires a fresh LVIS_HOME");
  const timestamp = now();
  const seals = createHostSecretStore(createNodeSecretEncryption(keyFile), join(home, "secrets"));
  const logger = new AuditLogger(join(home, "audit"), { now: () => timestamp });
  try {
    await logger.setupPermissionAuditChain(ensureAuditSecret(seals), seals);
    await logger.appendPermissionAuditEntry({
      decision: "allow", auditId: `self-test-${challenge}`, ts: timestamp.toISOString(),
      trustOrigin: "user-keyboard", toolUseId: `self-test-${challenge}`,
      workloadBrokerCorrelation: {
        version: "lvis-workload-correlation/v1", kind: "tool-invocation",
        toolUseId: `self-test-${challenge}`, toolName: "read_file", operation: "file.read",
        grant: { identity: challenge, effectDigest: challenge, action: "builtin-tool", planIdentity: null },
      },
      tool: "read_file", source: "builtin", category: "read",
      directory: "/packaged-self-test", directoryAllowed: true, layer: 6,
    });
  } finally {
    await logger.close();
  }
  const proof = await createPermissionAuditProof(challenge, () => timestamp);
  if (proof.files.length !== 1 || proof.files[0]!.entries !== 1) {
    throw new Error("permission audit self-test did not create exactly one row");
  }
  const homeAfter = directoryAuthorityIdentity(home);
  if (homeBefore.dev !== homeAfter.dev || homeBefore.ino !== homeAfter.ino ||
      !sameIdentity(keyBefore, protectedKeyIdentity(keyFile))) {
    throw new Error("permission audit self-test authority changed");
  }
  return { schema: PERMISSION_AUDIT_SELF_TEST_SCHEMA, challenge,
    createdAt: timestamp.toISOString(), file: proof.files[0]! };
}

function directoryAuthorityIdentity(path: string): Pick<PrivateIdentity, "dev" | "ino"> {
  const identity = assertPrivateIdentity(lstatSync(path, { bigint: true }), "LVIS_HOME", "directory");
  return { dev: identity.dev, ino: identity.ino };
}

function exactAbsoluteEnvironmentPath(name: "LVIS_HOME" | "LVIS_SECRET_KEY_FILE"): string {
  const value = process.env[name];
  if (!value || value.includes("\0") || !isAbsolute(value) || resolve(value) !== value) {
    throw new Error(`${name} must be an exact absolute path`);
  }
  return value;
}

interface PrivateIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

function assertPrivateIdentity(
  stats: BigIntStats,
  label: string,
  type: "file" | "directory",
): PrivateIdentity {
  if (process.platform === "win32" || typeof process.geteuid !== "function") {
    throw new Error("permission audit proof requires POSIX owner verification");
  }
  const validType = type === "file" ? stats.isFile() : stats.isDirectory();
  const expectedMode = type === "file" ? 0o600 : 0o700;
  if (!validType || stats.isSymbolicLink() || stats.uid !== BigInt(process.geteuid()) ||
      (type === "file" && stats.nlink !== 1n) || Number(stats.mode & 0o7777n) !== expectedMode) {
    throw new Error(`${label} must be an owner-only ${type}`);
  }
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
  };
}

function sameIdentity(left: PrivateIdentity, right: PrivateIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function protectedKeyIdentity(path: string): PrivateIdentity {
  const stats = lstatSync(path, { bigint: true });
  if (process.platform === "win32" || typeof process.geteuid !== "function" ||
      !stats.isFile() || stats.isSymbolicLink() || stats.uid !== BigInt(process.geteuid()) ||
      stats.nlink !== 1n || stats.size !== 32n ||
      ![0o400, 0o600].includes(Number(stats.mode & 0o7777n))) {
    throw new Error("LVIS_SECRET_KEY_FILE must remain a protected owner key");
  }
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
  };
}

function canonicalDate(name: string): string {
  const match = CANONICAL_AUDIT_NAME.exec(name);
  if (!match) throw new Error("unexpected permission audit file name");
  const date = match[1]!;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new Error("permission audit file name contains an invalid date");
  }
  return date;
}

async function verifyAuditFile(
  auditDir: string,
  name: string,
  secret: string,
  seals: SafeStorageSecretStore,
): Promise<PermissionAuditProofFile> {
  const date = canonicalDate(name);
  const path = join(auditDir, name);
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  let fd: number | undefined;
  try {
    fd = openSync(path, flags);
    const opened = fstatSync(fd, { bigint: true });
    const initial = assertPrivateIdentity(opened, "permission audit file", "file");
    const pathAtOpen = assertPrivateIdentity(lstatSync(path, { bigint: true }), "permission audit file", "file");
    if (!sameIdentity(initial, pathAtOpen)) throw new Error("permission audit file identity changed before verification");
    const bytes = Number(opened.size);
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("permission audit file size is invalid");

    const digest = createHash("sha256");
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    let lastByte: number | undefined;
    while (offset < bytes) {
      const count = readSync(fd, chunk, 0, Math.min(chunk.length, bytes - offset), offset);
      if (count === 0) throw new Error("permission audit file ended during hashing");
      digest.update(chunk.subarray(0, count));
      lastByte = chunk[count - 1];
      offset += count;
    }
    if (bytes > 0 && lastByte !== 0x0a) throw new Error("permission audit file has an unterminated row");

    let previous = GENESIS_MARKER;
    let authenticatedRowsStarted = false;
    let entries = 0;
    for await (const line of iterateJsonlLinesFromFd(fd, bytes, MAX_PERMISSION_AUDIT_LINE_BYTES)) {
      if (line.length === 0) throw new Error("permission audit file contains an empty row");
      const result = verifyChainLine(secret, line, previous, authenticatedRowsStarted);
      if (!result.ok) throw new Error(`permission audit chain verification failed: ${result.reason}`);
      authenticatedRowsStarted ||= result.selfAuthenticated;
      previous = line;
      entries += 1;
    }
    const storedSeal = seals.read(sealKeyName(date), 4 * 1024);
    if (entries === 0) {
      if (storedSeal !== null) throw new Error("permission audit seal exists for an empty file");
    } else if (!storedSeal || !SHA256.test(storedSeal) || !verifyLineHmac(secret, previous, storedSeal)) {
      throw new Error("permission audit daily seal is missing or invalid");
    }

    const after = assertPrivateIdentity(fstatSync(fd, { bigint: true }), "permission audit file", "file");
    const pathAfter = assertPrivateIdentity(lstatSync(path, { bigint: true }), "permission audit file", "file");
    if (!sameIdentity(initial, after) || !sameIdentity(after, pathAfter)) {
      throw new Error("permission audit file changed during verification");
    }
    return { name, date, sha256: digest.digest("hex"), bytes, entries };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Verify frozen permission audit evidence without starting the host runtime. */
export async function createPermissionAuditProof(
  challenge: string,
  now: () => Date = () => new Date(),
): Promise<PermissionAuditProofReceipt> {
  if (!CHALLENGE.test(challenge)) throw new Error("permission audit proof challenge is invalid");
  const home = exactAbsoluteEnvironmentPath("LVIS_HOME");
  const keyFile = exactAbsoluteEnvironmentPath("LVIS_SECRET_KEY_FILE");
  const auditDir = join(home, "audit");
  const secretsDir = join(home, "secrets");
  const homeDirectoryBefore = assertPrivateIdentity(lstatSync(home, { bigint: true }), "LVIS_HOME", "directory");
  const keyBefore = protectedKeyIdentity(keyFile);
  const auditDirectoryBefore = assertPrivateIdentity(lstatSync(auditDir, { bigint: true }), "permission audit directory", "directory");
  const secretDirectoryBefore = assertPrivateIdentity(lstatSync(secretsDir, { bigint: true }), "permission audit secret directory", "directory");

  const namesBefore = readdirSync(auditDir).sort();
  const permissionNames = namesBefore.filter((name) => name.includes("permission-audit"));
  for (const name of permissionNames) canonicalDate(name);
  const encryption = createNodeSecretEncryption(keyFile);
  const seals = new SafeStorageSecretStore(encryption, secretsDir, "reject", "existing-read-only");
  const secret = readExistingAuditSecret(seals);
  const files: PermissionAuditProofFile[] = [];
  for (const name of permissionNames) files.push(await verifyAuditFile(auditDir, name, secret, seals));

  const namesAfter = readdirSync(auditDir).sort();
  const auditDirectoryAfter = assertPrivateIdentity(lstatSync(auditDir, { bigint: true }), "permission audit directory", "directory");
  const secretDirectoryAfter = assertPrivateIdentity(lstatSync(secretsDir, { bigint: true }), "permission audit secret directory", "directory");
  const homeDirectoryAfter = assertPrivateIdentity(lstatSync(home, { bigint: true }), "LVIS_HOME", "directory");
  const keyAfter = protectedKeyIdentity(keyFile);
  if (JSON.stringify(namesBefore) !== JSON.stringify(namesAfter) ||
      !sameIdentity(homeDirectoryBefore, homeDirectoryAfter) ||
      !sameIdentity(keyBefore, keyAfter) ||
      !sameIdentity(auditDirectoryBefore, auditDirectoryAfter) ||
      !sameIdentity(secretDirectoryBefore, secretDirectoryAfter)) {
    throw new Error("permission audit authority directories changed during verification");
  }
  return {
    schema: PERMISSION_AUDIT_PROOF_SCHEMA,
    challenge,
    verifiedAt: now().toISOString(),
    intact: true,
    files,
  };
}
