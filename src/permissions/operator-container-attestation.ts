import {
  createHash,
  createPublicKey,
  randomUUID,
  verify as verifySignature,
  type KeyObject,
} from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open, readFile, readlink, realpath, statfs } from "node:fs/promises";
import { isAbsolute, posix } from "node:path";
import { canonicalStringify } from "../shared/canonical-json.js";
import { parseStrictJson } from "../shared/strict-json.js";
import { timingSafeEqualHexDigest } from "../lib/hex-digest-equal.js";

export const OPERATOR_ATTESTATION_VERSION =
  "lvis-operator-container-attestation/v1" as const;
export const OPERATOR_ATTESTATION_AUDIENCE = "lvis-headless-exec" as const;
const OPERATOR_TRUST_ROOT = "/etc/lvis/operator-trust.d" as const;

const CAPABILITY_VERSION = "operator-container-capability/v1" as const;
const EVIDENCE_VERSION = "operator-container-attestation-evidence/v1" as const;
const MAX_ATTESTATION_BYTES = 64 * 1_024;
const MAX_PUBLIC_KEY_BYTES = 16 * 1_024;
const MAX_ATTESTATION_LIFETIME_SECONDS = 5 * 60;
const MAX_ISSUED_AT_FUTURE_SECONDS = 30;
const SAFE_KEY_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const CAP_HEX = /^[a-f0-9]{16}$/;
const PROC_SUPER_MAGIC = 0x9fa0n;
const CGROUP2_SUPER_MAGIC = 0x63677270n;

const NAMESPACE_NAMES = ["mnt", "pid", "net", "ipc", "uts", "cgroup", "user"] as const;
type NamespaceName = typeof NAMESPACE_NAMES[number];

const DANGEROUS_CAPABILITIES = Object.freeze({
  CHOWN: 0,
  DAC_OVERRIDE: 1,
  FOWNER: 3,
  SETGID: 6,
  SETUID: 7,
  NET_ADMIN: 12,
  SYS_MODULE: 16,
  SYS_RAWIO: 17,
  SYS_PTRACE: 19,
  SYS_ADMIN: 21,
  PERFMON: 38,
  BPF: 39,
  CHECKPOINT_RESTORE: 40,
} as const);

interface OperatorAttestationStat {
  readonly uid: number;
  readonly mode: number;
  readonly size: number;
  isFile(): boolean;
  isDirectory(): boolean;
}

interface OperatorAttestationOpenFile {
  readonly fd: number;
  readonly readFile: () => Promise<Uint8Array>;
  readonly readUpTo: (maxBytes: number) => Promise<Uint8Array>;
  readonly stat: () => Promise<OperatorAttestationStat>;
  readonly close: () => Promise<void>;
}

export interface OperatorAttestationIo {
  readonly openReadOnly: (
    path: string,
    options?: Readonly<{ directory?: boolean }>,
  ) => Promise<OperatorAttestationOpenFile>;
  readonly readFile: (path: string) => Promise<Uint8Array>;
  readonly readlink: (path: string) => Promise<string>;
  readonly realpath: (path: string) => Promise<string>;
  readonly statfsType: (path: string) => Promise<bigint>;
}

interface OperatorAttestationCrypto {
  readonly parsePublicKey: (bytes: Uint8Array) => KeyObject;
  readonly verify: (
    payload: Uint8Array,
    key: KeyObject,
    signature: Uint8Array,
  ) => boolean;
  readonly publicKeyFingerprint: (key: KeyObject) => string;
  readonly randomUUID: () => string;
  readonly sha256: (bytes: string | Uint8Array) => string;
}

export interface OperatorAttestationDependencies {
  readonly platform?: NodeJS.Platform;
  readonly trustRoot?: string;
  readonly procRoot?: string;
  readonly now?: () => number;
  readonly io?: OperatorAttestationIo;
  readonly crypto?: OperatorAttestationCrypto;
}

interface OperatorContainerCapabilityFingerprints {
  readonly attestation: string;
  readonly process: string;
  readonly key: string;
}

/** Host-issued evidence only. A route or execution grant must still consume it explicitly. */
export interface OperatorContainerCapability {
  readonly version: typeof CAPABILITY_VERSION;
  readonly id: string;
  readonly generation: string;
  readonly expiresAt: number;
  readonly fingerprints: Readonly<OperatorContainerCapabilityFingerprints>;
}

export interface OperatorContainerCapabilityAuditProjection {
  readonly version: typeof CAPABILITY_VERSION;
  readonly id: string;
  readonly generation: string;
  readonly expiresAt: number;
  readonly fingerprints: Readonly<OperatorContainerCapabilityFingerprints>;
  readonly isolation: Readonly<{
    disposable: true;
    noHostMounts: true;
    noHostNamespaces: true;
    noInheritedSecrets: true;
  }>;
  readonly limits: Readonly<{
    memoryMaxBytes: string;
    pidsMax: string;
    cpuQuotaMicros: string;
    cpuPeriodMicros: string;
  }>;
}

/** Verified data only. Possessing this object never grants host authority. */
export interface OperatorContainerAttestationEvidence {
  readonly version: typeof EVIDENCE_VERSION;
  readonly expiresAt: number;
  readonly fingerprints: Readonly<OperatorContainerCapabilityFingerprints>;
  readonly isolation: OperatorContainerCapabilityAuditProjection["isolation"];
  readonly limits: OperatorContainerCapabilityAuditProjection["limits"];
}

class OperatorContainerAttestationError extends Error {
  constructor(readonly code: string) {
    super(`operator-container-attestation:${code}`);
    this.name = "OperatorContainerAttestationError";
  }
}

interface MountTuple {
  readonly majorMinor: string;
  readonly root: string;
  readonly mountPoint: string;
  readonly mountOptions: readonly string[];
  readonly fsType: string;
  readonly mountSource: string;
  readonly superOptions: readonly string[];
}

interface ParsedMount extends MountTuple {
  readonly mountId: string;
  readonly parentId: string;
  readonly optionalFields: readonly string[];
}

interface ResourceLimits {
  readonly memoryMaxBytes: string;
  readonly pidsMax: string;
  readonly cpuQuotaMicros: string;
  readonly cpuPeriodMicros: string;
}

interface AttestedClaims {
  readonly isolation: Readonly<{
    disposable: true;
    noHostMounts: true;
    noHostNamespaces: true;
    noInheritedSecrets: true;
  }>;
  readonly namespaces: Readonly<Record<NamespaceName, string>>;
  readonly cgroup: Readonly<{
    version: 2;
    path: string;
    limits: Readonly<ResourceLimits>;
  }>;
  readonly mountInfo: Readonly<{
    sha256: string;
    rootMount: Readonly<MountTuple>;
  }>;
  readonly process: Readonly<{
    bootId: string;
    pid: string;
    startTimeTicks: string;
    uidMap: string;
    gidMap: string;
    uids: readonly [string, string, string, string];
    noNewPrivs: true;
    seccomp: 2;
    capInh: string;
    capPrm: string;
    capEff: string;
    capBnd: string;
    capAmb: string;
  }>;
}

interface ParsedAttestation {
  readonly version: typeof OPERATOR_ATTESTATION_VERSION;
  readonly audience: typeof OPERATOR_ATTESTATION_AUDIENCE;
  readonly keyId: string;
  readonly issuedAt: number;
  readonly notBefore: number;
  readonly expiresAt: number;
  readonly claims: AttestedClaims;
  readonly signature: Uint8Array;
  readonly signedPayload: Readonly<Record<string, unknown>>;
}

type ProcessStatusClaims = Omit<AttestedClaims["process"], "uidMap" | "gidMap">;

interface CurrentFacts {
  readonly claims: AttestedClaims;
  readonly mounts: readonly ParsedMount[];
  readonly procIdentity: string;
  readonly processFingerprint: string;
}

interface CapabilityState {
  readonly procIdentity: string;
  readonly processFingerprint: string;
  readonly deps: Required<Pick<
    OperatorAttestationDependencies,
    "platform" | "trustRoot" | "procRoot" | "now" | "io" | "crypto"
  >>;
  readonly audit: OperatorContainerCapabilityAuditProjection;
}

interface EvidenceState {
  readonly procIdentity: string;
  readonly processFingerprint: string;
  readonly deps: CapabilityState["deps"];
}

const issuedCapabilities = new WeakSet<OperatorContainerCapability>();
const capabilityStates = new WeakMap<OperatorContainerCapability, CapabilityState>();
const verifiedEvidenceStates = new WeakMap<OperatorContainerAttestationEvidence, EvidenceState>();
let publishedCapability: OperatorContainerCapability | undefined;

const defaultIo: OperatorAttestationIo = {
  async openReadOnly(path, options) {
    const flags = fsConstants.O_RDONLY |
      fsConstants.O_NOFOLLOW |
      (options?.directory ? fsConstants.O_DIRECTORY : 0);
    const handle = await open(path, flags);
    return {
      fd: handle.fd,
      readFile: () => handle.readFile(),
      async readUpTo(maxBytes) {
        const bytes = Buffer.allocUnsafe(maxBytes);
        let offset = 0;
        while (offset < maxBytes) {
          const result = await handle.read(bytes, offset, maxBytes - offset, null);
          if (result.bytesRead === 0) break;
          offset += result.bytesRead;
        }
        return bytes.subarray(0, offset);
      },
      stat: async () => handle.stat(),
      close: () => handle.close(),
    };
  },
  readFile: (path) => readFile(path),
  readlink,
  realpath,
  statfsType: async (path) => (await statfs(path, { bigint: true })).type,
};

const defaultCrypto: OperatorAttestationCrypto = {
  parsePublicKey(bytes) {
    const pem = Buffer.from(bytes).toString("utf8").trim();
    if (!pem.startsWith("-----BEGIN PUBLIC KEY-----") ||
        !pem.endsWith("-----END PUBLIC KEY-----") ||
        pem.includes("PRIVATE KEY")) {
      throw new Error("public-key-format-invalid");
    }
    const key = createPublicKey(pem);
    if (key.asymmetricKeyType !== "ed25519") throw new Error("public-key-type-invalid");
    return key;
  },
  verify: (payload, key, signature) =>
    verifySignature(null, Buffer.from(payload), key, Buffer.from(signature)),
  publicKeyFingerprint(key) {
    return createHash("sha256")
      .update(key.export({ format: "der", type: "spki" }))
      .digest("hex");
  },
  randomUUID,
  sha256: (bytes) => createHash("sha256").update(bytes).digest("hex"),
};

function fail(code: string): never {
  throw new OperatorContainerAttestationError(code);
}

function depsWithDefaults(
  input: OperatorAttestationDependencies,
): CapabilityState["deps"] {
  return {
    platform: input.platform ?? process.platform,
    trustRoot: input.trustRoot ?? OPERATOR_TRUST_ROOT,
    procRoot: input.procRoot ?? "/proc/self",
    now: input.now ?? (() => Math.floor(Date.now() / 1_000)),
    io: input.io ?? defaultIo,
    crypto: input.crypto ?? defaultCrypto,
  };
}

function asRecord(value: unknown, code: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(code);
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  code: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(code);
  }
}

function requiredString(
  record: Record<string, unknown>,
  key: string,
  code: string,
): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) fail(code);
  return value;
}

function requiredInteger(
  record: Record<string, unknown>,
  key: string,
  code: string,
): number {
  const value = record[key];
  if (!Number.isSafeInteger(value)) fail(code);
  return value as number;
}

function requiredTrue(
  record: Record<string, unknown>,
  key: string,
  code: string,
): true {
  if (record[key] !== true) fail(code);
  return true;
}

function canonicalDecimal(value: string, code: string, allowZero = false): string {
  if (!DECIMAL.test(value) || (!allowZero && value === "0")) fail(code);
  return value;
}

function parseUidTuple(value: unknown, code: string): readonly [string, string, string, string] {
  if (!Array.isArray(value) || value.length !== 4) fail(code);
  const parsed = value.map((entry) => {
    if (typeof entry !== "string") fail(code);
    return canonicalDecimal(entry, code, true);
  });
  return Object.freeze(parsed) as unknown as readonly [string, string, string, string];
}

function sortedUniqueStrings(value: unknown, code: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    fail(code);
  }
  const sorted = [...value].sort() as string[];
  if (new Set(sorted).size !== sorted.length) fail(code);
  return Object.freeze(sorted);
}

function parseMountTuple(value: unknown, code: string): MountTuple {
  const record = asRecord(value, code);
  assertExactKeys(record, [
    "majorMinor",
    "root",
    "mountPoint",
    "mountOptions",
    "fsType",
    "mountSource",
    "superOptions",
  ], code);
  const majorMinor = requiredString(record, "majorMinor", code);
  if (!/^[0-9]+:[0-9]+$/.test(majorMinor)) fail(code);
  const root = requiredString(record, "root", code);
  const mountPoint = requiredString(record, "mountPoint", code);
  if (!posix.isAbsolute(root) || !posix.isAbsolute(mountPoint)) fail(code);
  return Object.freeze({
    majorMinor,
    root,
    mountPoint,
    mountOptions: sortedUniqueStrings(record.mountOptions, code),
    fsType: requiredString(record, "fsType", code),
    mountSource: requiredString(record, "mountSource", code),
    superOptions: sortedUniqueStrings(record.superOptions, code),
  });
}

function parseClaims(value: unknown): AttestedClaims {
  const record = asRecord(value, "claims-invalid");
  assertExactKeys(record, ["isolation", "namespaces", "cgroup", "mountInfo", "process"], "claims-fields-invalid");

  const isolationRecord = asRecord(record.isolation, "isolation-invalid");
  assertExactKeys(isolationRecord, [
    "disposable",
    "noHostMounts",
    "noHostNamespaces",
    "noInheritedSecrets",
  ], "isolation-fields-invalid");
  const isolation = Object.freeze({
    disposable: requiredTrue(isolationRecord, "disposable", "isolation-disposable-required"),
    noHostMounts: requiredTrue(isolationRecord, "noHostMounts", "isolation-host-mounts-required"),
    noHostNamespaces: requiredTrue(isolationRecord, "noHostNamespaces", "isolation-host-namespaces-required"),
    noInheritedSecrets: requiredTrue(isolationRecord, "noInheritedSecrets", "isolation-inherited-secrets-required"),
  });

  const namespaceRecord = asRecord(record.namespaces, "namespaces-invalid");
  assertExactKeys(namespaceRecord, NAMESPACE_NAMES, "namespace-fields-invalid");
  const namespaces = Object.fromEntries(NAMESPACE_NAMES.map((name) => {
    const link = requiredString(namespaceRecord, name, `namespace-${name}-invalid`);
    if (!new RegExp(`^${name}:\\[[1-9][0-9]*\\]$`).test(link)) {
      fail(`namespace-${name}-invalid`);
    }
    return [name, link];
  })) as Record<NamespaceName, string>;

  const cgroupRecord = asRecord(record.cgroup, "cgroup-invalid");
  assertExactKeys(cgroupRecord, ["version", "path", "limits"], "cgroup-fields-invalid");
  if (cgroupRecord.version !== 2) fail("cgroup-version-invalid");
  const cgroupPath = requiredString(cgroupRecord, "path", "cgroup-path-invalid");
  if (!posix.isAbsolute(cgroupPath) || posix.normalize(cgroupPath) !== cgroupPath) {
    fail("cgroup-path-invalid");
  }
  const limitsRecord = asRecord(cgroupRecord.limits, "cgroup-limits-invalid");
  assertExactKeys(limitsRecord, [
    "memoryMaxBytes",
    "pidsMax",
    "cpuQuotaMicros",
    "cpuPeriodMicros",
  ], "cgroup-limit-fields-invalid");
  const limits = Object.freeze({
    memoryMaxBytes: canonicalDecimal(
      requiredString(limitsRecord, "memoryMaxBytes", "memory-limit-invalid"),
      "memory-limit-invalid",
    ),
    pidsMax: canonicalDecimal(
      requiredString(limitsRecord, "pidsMax", "pids-limit-invalid"),
      "pids-limit-invalid",
    ),
    cpuQuotaMicros: canonicalDecimal(
      requiredString(limitsRecord, "cpuQuotaMicros", "cpu-quota-invalid"),
      "cpu-quota-invalid",
    ),
    cpuPeriodMicros: canonicalDecimal(
      requiredString(limitsRecord, "cpuPeriodMicros", "cpu-period-invalid"),
      "cpu-period-invalid",
    ),
  });

  const mountInfoRecord = asRecord(record.mountInfo, "mount-info-invalid");
  assertExactKeys(mountInfoRecord, ["sha256", "rootMount"], "mount-info-fields-invalid");
  const mountDigest = requiredString(mountInfoRecord, "sha256", "mount-info-digest-invalid");
  if (!SHA256_HEX.test(mountDigest)) fail("mount-info-digest-invalid");

  const processRecord = asRecord(record.process, "process-facts-invalid");
  assertExactKeys(processRecord, [
    "bootId",
    "pid",
    "startTimeTicks",
    "uidMap",
    "gidMap",
    "uids",
    "noNewPrivs",
    "seccomp",
    "capInh",
    "capPrm",
    "capEff",
    "capBnd",
    "capAmb",
  ], "process-fact-fields-invalid");
  const bootId = requiredString(processRecord, "bootId", "process-boot-id-invalid");
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(bootId)) {
    fail("process-boot-id-invalid");
  }
  const pid = canonicalDecimal(
    requiredString(processRecord, "pid", "process-pid-invalid"),
    "process-pid-invalid",
  );
  const startTimeTicks = canonicalDecimal(
    requiredString(processRecord, "startTimeTicks", "process-start-time-invalid"),
    "process-start-time-invalid",
  );
  if (processRecord.seccomp !== 2) fail("process-seccomp-required");
  const capabilities = {
    capInh: requiredString(processRecord, "capInh", "process-cap-inh-invalid"),
    capPrm: requiredString(processRecord, "capPrm", "process-cap-prm-invalid"),
    capEff: requiredString(processRecord, "capEff", "process-cap-eff-invalid"),
    capBnd: requiredString(processRecord, "capBnd", "process-cap-bnd-invalid"),
    capAmb: requiredString(processRecord, "capAmb", "process-cap-amb-invalid"),
  };
  if (Object.values(capabilities).some((capability) => !CAP_HEX.test(capability))) {
    fail("process-capabilities-invalid");
  }

  return Object.freeze({
    isolation,
    namespaces: Object.freeze(namespaces),
    cgroup: Object.freeze({ version: 2, path: cgroupPath, limits }),
    mountInfo: Object.freeze({
      sha256: mountDigest,
      rootMount: parseMountTuple(mountInfoRecord.rootMount, "root-mount-invalid"),
    }),
    process: Object.freeze({
      bootId,
      pid,
      startTimeTicks,
      uidMap: parseIdentityMap(
        requiredString(processRecord, "uidMap", "process-uid-map-invalid"),
        "process-uid-map-invalid",
      ),
      gidMap: parseIdentityMap(
        requiredString(processRecord, "gidMap", "process-gid-map-invalid"),
        "process-gid-map-invalid",
      ),
      uids: parseUidTuple(processRecord.uids, "process-uids-invalid"),
      noNewPrivs: requiredTrue(processRecord, "noNewPrivs", "process-no-new-privileges-required"),
      seccomp: 2,
      ...capabilities,
    }),
  });
}

function decodeSignature(value: unknown): Uint8Array {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(value)) {
    fail("signature-encoding-invalid");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length !== 64 || bytes.toString("base64") !== value) {
    fail("signature-encoding-invalid");
  }
  return bytes;
}

function parseAttestation(bytes: Uint8Array, now: number): ParsedAttestation {
  let parsed: unknown;
  try {
    parsed = parseStrictJson(bytes, {
      maxBytes: MAX_ATTESTATION_BYTES,
      maxDepth: 12,
      maxNodes: 256,
      maxObjectMembers: 32,
      maxArrayItems: 64,
    });
  } catch {
    fail("json-invalid");
  }
  const record = asRecord(parsed, "document-invalid");
  assertExactKeys(record, [
    "version",
    "audience",
    "keyId",
    "issuedAt",
    "notBefore",
    "expiresAt",
    "claims",
    "signature",
  ], "document-fields-invalid");
  if (record.version !== OPERATOR_ATTESTATION_VERSION) fail("version-invalid");
  if (record.audience !== OPERATOR_ATTESTATION_AUDIENCE) fail("audience-invalid");
  const keyId = requiredString(record, "keyId", "key-id-invalid");
  if (!SAFE_KEY_ID.test(keyId)) fail("key-id-invalid");
  const issuedAt = requiredInteger(record, "issuedAt", "issued-at-invalid");
  const notBefore = requiredInteger(record, "notBefore", "not-before-invalid");
  const expiresAt = requiredInteger(record, "expiresAt", "expires-at-invalid");
  if (notBefore > issuedAt || issuedAt > expiresAt ||
      expiresAt - notBefore > MAX_ATTESTATION_LIFETIME_SECONDS) {
    fail("time-window-invalid");
  }
  if (issuedAt > now + MAX_ISSUED_AT_FUTURE_SECONDS || now < notBefore || now >= expiresAt) {
    fail("attestation-not-current");
  }
  const claims = parseClaims(record.claims);
  const signedPayload = Object.freeze({
    version: record.version,
    audience: record.audience,
    keyId,
    issuedAt,
    notBefore,
    expiresAt,
    claims: record.claims,
  });
  return Object.freeze({
    version: OPERATOR_ATTESTATION_VERSION,
    audience: OPERATOR_ATTESTATION_AUDIENCE,
    keyId,
    issuedAt,
    notBefore,
    expiresAt,
    claims,
    signature: decodeSignature(record.signature),
    signedPayload,
  });
}

function decodeMountField(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_match, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)));
}

function splitOptions(value: string): readonly string[] {
  return Object.freeze(value.split(",").filter(Boolean).sort());
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseMountInfo(raw: string): readonly ParsedMount[] {
  const mounts: ParsedMount[] = [];
  for (const line of raw.trim().split("\n")) {
    if (!line) continue;
    const fields = line.trim().split(/\s+/);
    const separator = fields.indexOf("-");
    if (separator < 6 || fields.length !== separator + 4) fail("mount-info-invalid");
    if (!/^[1-9][0-9]*$/.test(fields[0]) || !/^[1-9][0-9]*$/.test(fields[1])) {
      fail("mount-info-invalid");
    }
    const root = decodeMountField(fields[3]);
    const mountPoint = decodeMountField(fields[4]);
    if (!posix.isAbsolute(root) || !posix.isAbsolute(mountPoint)) fail("mount-info-invalid");
    mounts.push(Object.freeze({
      mountId: fields[0],
      parentId: fields[1],
      majorMinor: fields[2],
      root,
      mountPoint,
      mountOptions: splitOptions(fields[5]),
      optionalFields: Object.freeze(fields.slice(6, separator).sort()),
      fsType: fields[separator + 1],
      mountSource: decodeMountField(fields[separator + 2]),
      superOptions: splitOptions(fields[separator + 3]),
    }));
  }
  if (mounts.length === 0) fail("mount-info-empty");
  if (new Set(mounts.map((mount) => mount.mountId)).size !== mounts.length) {
    fail("mount-info-invalid");
  }
  return Object.freeze(mounts.sort((left, right) =>
    compareText(left.mountPoint, right.mountPoint) || compareText(left.mountId, right.mountId)));
}

function mountTuple(mount: ParsedMount): MountTuple {
  return Object.freeze({
    majorMinor: mount.majorMinor,
    root: mount.root,
    mountPoint: mount.mountPoint,
    mountOptions: Object.freeze([...mount.mountOptions]),
    fsType: mount.fsType,
    mountSource: mount.mountSource,
    superOptions: Object.freeze([...mount.superOptions]),
  });
}

function pathWithin(root: string, candidate: string): boolean {
  const relative = posix.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !posix.isAbsolute(relative));
}

function mountById(mounts: readonly ParsedMount[], mountId: string): ParsedMount {
  const matches = mounts.filter((mount) => mount.mountId === mountId);
  if (matches.length !== 1) fail("mount-identity-ambiguous");
  return matches[0];
}

function effectiveMountForPath(
  mounts: readonly ParsedMount[],
  path: string,
  code: string,
): ParsedMount {
  const candidates = mounts.filter((mount) => pathWithin(mount.mountPoint, path));
  const longest = Math.max(...candidates.map((mount) => mount.mountPoint.length));
  const matches = candidates.filter((mount) => mount.mountPoint.length === longest);
  if (matches.length !== 1) fail(code);
  return matches[0];
}

function parseProcessIdentity(
  statRaw: string,
  procIdentity: string,
): Readonly<{ pid: string; startTimeTicks: string }> {
  const close = statRaw.lastIndexOf(")");
  const open = statRaw.indexOf("(");
  if (open < 1 || close <= open || statRaw[close + 1] !== " ") {
    return fail("process-stat-invalid");
  }
  const pid = canonicalDecimal(statRaw.slice(0, open).trim(), "process-stat-invalid");
  if (pid !== posix.basename(procIdentity)) fail("process-identity-mismatch");
  const tail = statRaw.slice(close + 2).trim().split(/\s+/);
  if (tail.length < 20) fail("process-stat-invalid");
  return Object.freeze({
    pid,
    startTimeTicks: canonicalDecimal(tail[19], "process-start-time-invalid"),
  });
}

function parseStatus(
  raw: string,
  bootId: string,
  identity: Readonly<{ pid: string; startTimeTicks: string }>,
): ProcessStatusClaims {
  const fields = new Map<string, string>();
  for (const line of raw.split("\n")) {
    const separator = line.indexOf(":");
    if (separator > 0) fields.set(line.slice(0, separator), line.slice(separator + 1).trim());
  }
  const noNewPrivs = fields.get("NoNewPrivs");
  const seccomp = fields.get("Seccomp");
  const uidFields = fields.get("Uid")?.split(/\s+/);
  const capabilityFields = Object.fromEntries([
    ["capInh", fields.get("CapInh")?.toLowerCase()],
    ["capPrm", fields.get("CapPrm")?.toLowerCase()],
    ["capEff", fields.get("CapEff")?.toLowerCase()],
    ["capBnd", fields.get("CapBnd")?.toLowerCase()],
    ["capAmb", fields.get("CapAmb")?.toLowerCase()],
  ]) as Record<"capInh" | "capPrm" | "capEff" | "capBnd" | "capAmb", string | undefined>;
  if (noNewPrivs !== "1") fail("process-no-new-privileges-required");
  if (seccomp !== "2") fail("process-seccomp-required");
  if (!uidFields || uidFields.length !== 4 ||
      Object.values(capabilityFields).some((value) => !value || !CAP_HEX.test(value))) {
    fail("process-capabilities-invalid");
  }
  const uids = parseUidTuple(uidFields, "process-uids-invalid");
  // A zero real or saved UID can restore an effective UID of zero without
  // CAP_SETUID. Requiring only the current effective/filesystem identities to
  // be non-root would therefore make the verified state temporary.
  if (uids.includes("0")) fail("process-root-uid-not-allowed");
  const dangerousMask = Object.values(DANGEROUS_CAPABILITIES)
    .reduce((mask, bit) => mask | (1n << BigInt(bit)), 0n);
  const combined = Object.values(capabilityFields)
    .reduce((mask, value) => mask | BigInt(`0x${value!}`), 0n);
  if ((combined & dangerousMask) !== 0n) {
    fail("dangerous-process-capability-present");
  }
  return Object.freeze({
    bootId,
    ...identity,
    uids,
    noNewPrivs: true,
    seccomp: 2,
    capInh: capabilityFields.capInh!,
    capPrm: capabilityFields.capPrm!,
    capEff: capabilityFields.capEff!,
    capBnd: capabilityFields.capBnd!,
    capAmb: capabilityFields.capAmb!,
  });
}

function parseCgroupPath(raw: string): string {
  const matches = raw.trim().split("\n").filter((line) => line.startsWith("0::"));
  if (matches.length !== 1) fail("cgroup-v2-membership-invalid");
  const path = matches[0].slice(3);
  if (!posix.isAbsolute(path) || posix.normalize(path) !== path) {
    fail("cgroup-v2-membership-invalid");
  }
  return path;
}

function parseIdentityMap(raw: string, code: string): string {
  const lines = raw.trim().split("\n").map((line) => line.trim().replace(/\s+/g, " "));
  if (lines.length !== 1 || lines[0] !== "0 0 4294967295") fail(code);
  return lines[0];
}

async function readUtf8(
  io: OperatorAttestationIo,
  path: string,
  code: string,
): Promise<string> {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(await io.readFile(path));
  } catch {
    return fail(code);
  }
}

async function assertFilesystemMagic(
  io: OperatorAttestationIo,
  path: string,
  expected: bigint,
  code: string,
): Promise<void> {
  const actual = await io.statfsType(path).catch(() => fail(code));
  if (actual !== expected) fail(code);
}

async function mountIdForOpenFile(
  openFile: OperatorAttestationOpenFile,
  deps: CapabilityState["deps"],
  mounts: readonly ParsedMount[],
): Promise<string> {
  const fdInfoPath = posix.join(deps.procRoot, "fdinfo", String(openFile.fd));
  await assertFilesystemMagic(
    deps.io,
    fdInfoPath,
    PROC_SUPER_MAGIC,
    "fdinfo-filesystem-invalid",
  );
  const procMount = effectiveMountForPath(mounts, deps.procRoot, "proc-mount-ambiguous");
  const fdInfoMount = effectiveMountForPath(mounts, fdInfoPath, "fdinfo-mount-ambiguous");
  if (procMount.fsType !== "proc" || fdInfoMount.mountId !== procMount.mountId) {
    fail("fdinfo-mount-invalid");
  }
  const fdInfo = await readUtf8(
    deps.io,
    fdInfoPath,
    "file-mount-identity-read-failed",
  );
  const values = fdInfo.split("\n")
    .filter((line) => line.startsWith("mnt_id:"))
    .map((line) => line.slice("mnt_id:".length).trim());
  if (values.length !== 1 || !/^[1-9][0-9]*$/.test(values[0])) {
    fail("file-mount-identity-invalid");
  }
  return values[0];
}

async function assertOpenFileMount(
  openFile: OperatorAttestationOpenFile,
  expectedMountId: string,
  mounts: readonly ParsedMount[],
  deps: CapabilityState["deps"],
  code: string,
): Promise<void> {
  if (await mountIdForOpenFile(openFile, deps, mounts) !== expectedMountId) fail(code);
}

async function readFileOnMount(
  path: string,
  expectedMountId: string,
  mounts: readonly ParsedMount[],
  expectedFilesystemMagic: bigint,
  deps: CapabilityState["deps"],
  code: string,
): Promise<string> {
  let file: OperatorAttestationOpenFile | undefined;
  try {
    await assertFilesystemMagic(
      deps.io,
      path,
      expectedFilesystemMagic,
      `${code}-filesystem-invalid`,
    );
    file = await deps.io.openReadOnly(path).catch(() => fail(code));
    await assertOpenFileMount(file, expectedMountId, mounts, deps, `${code}-mount-invalid`);
    const fileStat = await file.stat().catch(() => fail(code));
    if (!fileStat.isFile()) fail(code);
    const bytes = await file.readFile().catch(() => fail(code));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    if (error instanceof OperatorContainerAttestationError) throw error;
    return fail(code);
  } finally {
    await file?.close().catch(() => undefined);
  }
}

async function readFileOnFilesystemType(
  path: string,
  fsType: string,
  mounts: readonly ParsedMount[],
  deps: CapabilityState["deps"],
  code: string,
): Promise<string> {
  let file: OperatorAttestationOpenFile | undefined;
  try {
    await assertFilesystemMagic(
      deps.io,
      path,
      fsType === "proc" ? PROC_SUPER_MAGIC : CGROUP2_SUPER_MAGIC,
      `${code}-filesystem-invalid`,
    );
    file = await deps.io.openReadOnly(path).catch(() => fail(code));
    const mount = mountById(mounts, await mountIdForOpenFile(file, deps, mounts));
    if (mount.fsType !== fsType) fail(`${code}-filesystem-invalid`);
    const fileStat = await file.stat().catch(() => fail(code));
    if (!fileStat.isFile()) fail(code);
    const bytes = await file.readFile().catch(() => fail(code));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    if (error instanceof OperatorContainerAttestationError) throw error;
    return fail(code);
  } finally {
    await file?.close().catch(() => undefined);
  }
}

async function assertDirectoryOnMount(
  path: string,
  expectedMountId: string,
  mounts: readonly ParsedMount[],
  expectedFilesystemMagic: bigint,
  deps: CapabilityState["deps"],
  code: string,
): Promise<void> {
  let directory: OperatorAttestationOpenFile | undefined;
  try {
    await assertFilesystemMagic(
      deps.io,
      path,
      expectedFilesystemMagic,
      `${code}-filesystem-invalid`,
    );
    directory = await deps.io.openReadOnly(path, { directory: true }).catch(() => fail(code));
    await assertOpenFileMount(
      directory,
      expectedMountId,
      mounts,
      deps,
      `${code}-mount-invalid`,
    );
    const directoryStat = await directory.stat().catch(() => fail(code));
    if (!directoryStat.isDirectory()) fail(code);
  } finally {
    await directory?.close().catch(() => undefined);
  }
}

async function collectCurrentFacts(deps: CapabilityState["deps"]): Promise<CurrentFacts> {
  const { io, procRoot, crypto } = deps;
  await assertFilesystemMagic(io, procRoot, PROC_SUPER_MAGIC, "proc-filesystem-required");
  const procIdentity = await io.realpath(procRoot)
    .catch(() => fail("process-identity-read-failed"));
  if (!/^\/proc\/[1-9][0-9]*$/.test(procIdentity)) fail("process-identity-invalid");
  const observationDeps: CapabilityState["deps"] = { ...deps, procRoot: procIdentity };
  const procSystemRoot = posix.resolve(procIdentity, "..", "sys");
  const mountInfoPath = posix.join(procIdentity, "mountinfo");
  await assertFilesystemMagic(
    io,
    mountInfoPath,
    PROC_SUPER_MAGIC,
    "mount-info-filesystem-invalid",
  );
  const initialMountInfo = await readUtf8(
    io,
    mountInfoPath,
    "mount-info-read-failed",
  );
  const mounts = parseMountInfo(initialMountInfo);
  const procMount = effectiveMountForPath(mounts, procIdentity, "proc-mount-ambiguous");
  if (procMount.fsType !== "proc") fail("proc-filesystem-required");
  const [
    mountInfoRaw,
    cgroupRaw,
    statusRaw,
    statRaw,
    uidMapRaw,
    gidMapRaw,
    bootIdRaw,
    ...namespaceLinks
  ] = await Promise.all([
    readFileOnMount(
      mountInfoPath,
      procMount.mountId,
      mounts,
      PROC_SUPER_MAGIC,
      observationDeps,
      "mount-info-read-failed",
    ),
    readFileOnMount(
      posix.join(procIdentity, "cgroup"),
      procMount.mountId,
      mounts,
      PROC_SUPER_MAGIC,
      observationDeps,
      "cgroup-membership-read-failed",
    ),
    readFileOnMount(
      posix.join(procIdentity, "status"),
      procMount.mountId,
      mounts,
      PROC_SUPER_MAGIC,
      observationDeps,
      "process-status-read-failed",
    ),
    readFileOnMount(
      posix.join(procIdentity, "stat"),
      procMount.mountId,
      mounts,
      PROC_SUPER_MAGIC,
      observationDeps,
      "process-stat-read-failed",
    ),
    readFileOnMount(
      posix.join(procIdentity, "uid_map"),
      procMount.mountId,
      mounts,
      PROC_SUPER_MAGIC,
      observationDeps,
      "process-uid-map-read-failed",
    ),
    readFileOnMount(
      posix.join(procIdentity, "gid_map"),
      procMount.mountId,
      mounts,
      PROC_SUPER_MAGIC,
      observationDeps,
      "process-gid-map-read-failed",
    ),
    readFileOnFilesystemType(
      posix.join(procSystemRoot, "kernel/random/boot_id"),
      "proc",
      mounts,
      observationDeps,
      "boot-id-read-failed",
    ),
    ...NAMESPACE_NAMES.map((name) =>
      io.readlink(posix.join(procIdentity, "ns", name))
        .catch(() => fail(`namespace-${name}-read-failed`))),
  ]);
  if (mountInfoRaw !== initialMountInfo) fail("mount-info-changed-during-read");
  const bootId = bootIdRaw.trim().toLowerCase();
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(bootId)) {
    fail("process-boot-id-invalid");
  }
  const processIdentity = parseProcessIdentity(statRaw, procIdentity);
  const uidMap = parseIdentityMap(uidMapRaw, "process-uid-map-not-host-identity");
  const gidMap = parseIdentityMap(gidMapRaw, "process-gid-map-not-host-identity");
  await assertFilesystemMagic(
    io,
    posix.join(procIdentity, "ns"),
    PROC_SUPER_MAGIC,
    "namespace-directory-filesystem-invalid",
  );
  for (const name of NAMESPACE_NAMES) {
    const namespaceMount = effectiveMountForPath(
      mounts,
      posix.join(procIdentity, "ns", name),
      `namespace-${name}-mount-ambiguous`,
    );
    if (namespaceMount.mountId !== procMount.mountId) {
      fail(`namespace-${name}-mount-invalid`);
    }
  }
  const rootMounts = mounts.filter((mount) => mount.mountPoint === "/");
  if (rootMounts.length !== 1) fail("root-mount-ambiguous");
  const rootMount = rootMounts[0];
  const cgroupPath = parseCgroupPath(cgroupRaw);
  const cgroupMounts = mounts.filter((mount) => mount.fsType === "cgroup2");
  if (cgroupMounts.length !== 1) fail("cgroup-v2-mount-ambiguous");
  const cgroupMount = cgroupMounts[0];
  if (!cgroupMount.mountOptions.includes("ro")) fail("cgroup-v2-mount-not-read-only");
  // Membership is relative to the cgroup namespace root. mountinfo's root can
  // retain a host-relative prefix and therefore is not comparable to it.
  const localCgroupPath = cgroupPath === "/"
    ? cgroupMount.mountPoint
    : posix.join(cgroupMount.mountPoint, cgroupPath);
  await assertDirectoryOnMount(
    localCgroupPath,
    cgroupMount.mountId,
    mounts,
    CGROUP2_SUPER_MAGIC,
    deps,
    "cgroup-directory-invalid",
  );
  const [memoryMaxRaw, pidsMaxRaw, cpuMaxRaw] = await Promise.all([
    readFileOnMount(
      posix.join(localCgroupPath, "memory.max"),
      cgroupMount.mountId,
      mounts,
      CGROUP2_SUPER_MAGIC,
      deps,
      "memory-limit-read-failed",
    ),
    readFileOnMount(
      posix.join(localCgroupPath, "pids.max"),
      cgroupMount.mountId,
      mounts,
      CGROUP2_SUPER_MAGIC,
      deps,
      "pids-limit-read-failed",
    ),
    readFileOnMount(
      posix.join(localCgroupPath, "cpu.max"),
      cgroupMount.mountId,
      mounts,
      CGROUP2_SUPER_MAGIC,
      deps,
      "cpu-limit-read-failed",
    ),
  ]);
  const memoryMaxBytes = canonicalDecimal(memoryMaxRaw.trim(), "memory-limit-unbounded");
  const pidsMax = canonicalDecimal(pidsMaxRaw.trim(), "pids-limit-unbounded");
  const cpuFields = cpuMaxRaw.trim().split(/\s+/);
  if (cpuFields.length !== 2 || cpuFields[0] === "max") fail("cpu-limit-unbounded");
  const cpuQuotaMicros = canonicalDecimal(cpuFields[0], "cpu-quota-invalid");
  const cpuPeriodMicros = canonicalDecimal(cpuFields[1], "cpu-period-invalid");
  const namespaces = Object.fromEntries(NAMESPACE_NAMES.map((name, index) => {
    const link = namespaceLinks[index];
    if (!new RegExp(`^${name}:\\[[1-9][0-9]*\\]$`).test(link)) {
      fail(`namespace-${name}-invalid`);
    }
    return [name, link];
  })) as Record<NamespaceName, string>;
  const normalizedMounts = mounts.map((mount) => ({
    mountId: mount.mountId,
    parentId: mount.parentId,
    ...mountTuple(mount),
    optionalFields: mount.optionalFields,
  }));
  const claims: AttestedClaims = Object.freeze({
    isolation: Object.freeze({
      disposable: true,
      noHostMounts: true,
      noHostNamespaces: true,
      noInheritedSecrets: true,
    }),
    namespaces: Object.freeze(namespaces),
    cgroup: Object.freeze({
      version: 2,
      path: cgroupPath,
      limits: Object.freeze({ memoryMaxBytes, pidsMax, cpuQuotaMicros, cpuPeriodMicros }),
    }),
    mountInfo: Object.freeze({
      sha256: crypto.sha256(canonicalStringify(normalizedMounts)),
      rootMount: mountTuple(rootMount),
    }),
    process: Object.freeze({
      ...parseStatus(statusRaw, bootId, processIdentity),
      uidMap,
      gidMap,
    }),
  });
  const processFingerprint = crypto.sha256(canonicalStringify({ claims, procIdentity }));
  return Object.freeze({ claims, mounts, procIdentity, processFingerprint });
}

async function readTrustedKey(
  keyId: string,
  facts: CurrentFacts,
  deps: CapabilityState["deps"],
): Promise<{ key: KeyObject; fingerprint: string }> {
  const { io, trustRoot, crypto } = deps;
  const observationDeps: CapabilityState["deps"] = {
    ...deps,
    procRoot: facts.procIdentity,
  };
  if (!posix.isAbsolute(trustRoot) || posix.normalize(trustRoot) !== trustRoot) {
    fail("trust-root-invalid");
  }
  let rootFile: OperatorAttestationOpenFile | undefined;
  let keyFile: OperatorAttestationOpenFile | undefined;
  try {
    rootFile = await io.openReadOnly(trustRoot, { directory: true })
      .catch(() => fail("trust-root-unavailable"));
    const canonicalRoot = await io.realpath(
      posix.join(facts.procIdentity, "fd", String(rootFile.fd)),
    )
      .catch(() => fail("trust-root-unavailable"));
    if (canonicalRoot !== trustRoot) fail("trust-root-not-canonical");
    const rootStat = await rootFile.stat().catch(() => fail("trust-root-unavailable"));
    if (!rootStat.isDirectory() || rootStat.uid !== 0 || (rootStat.mode & 0o022) !== 0) {
      fail("trust-root-ownership-invalid");
    }
    const rootMount = mountById(
      facts.mounts,
      await mountIdForOpenFile(rootFile, observationDeps, facts.mounts),
    );
    if (!rootMount.mountOptions.includes("ro")) {
      fail("trust-root-mount-not-read-only");
    }

    keyFile = await io.openReadOnly(posix.join(canonicalRoot, `${keyId}.pub`))
      .catch(() => fail("trusted-key-unavailable"));
    const canonicalKey = await io.realpath(
      posix.join(facts.procIdentity, "fd", String(keyFile.fd)),
    )
      .catch(() => fail("trusted-key-unavailable"));
    if (!pathWithin(canonicalRoot, canonicalKey)) fail("trusted-key-outside-root");
    const keyMount = mountById(
      facts.mounts,
      await mountIdForOpenFile(keyFile, observationDeps, facts.mounts),
    );
    if (keyMount.mountId !== rootMount.mountId || !keyMount.mountOptions.includes("ro")) {
      fail("trusted-key-mount-invalid");
    }
    const keyStat = await keyFile.stat().catch(() => fail("trusted-key-unavailable"));
    if (!keyStat.isFile() || keyStat.uid !== 0 || (keyStat.mode & 0o222) !== 0 ||
        keyStat.size < 1 || keyStat.size > MAX_PUBLIC_KEY_BYTES) {
      fail("trusted-key-metadata-invalid");
    }
    const keyBytes = await keyFile.readUpTo(MAX_PUBLIC_KEY_BYTES + 1)
      .catch(() => fail("trusted-key-read-failed"));
    if (keyBytes.byteLength < 1 || keyBytes.byteLength > MAX_PUBLIC_KEY_BYTES) {
      fail("trusted-key-size-invalid");
    }
    let key: KeyObject;
    try {
      key = crypto.parsePublicKey(keyBytes);
    } catch {
      return fail("trusted-key-format-invalid");
    }
    return { key, fingerprint: crypto.publicKeyFingerprint(key) };
  } finally {
    await keyFile?.close().catch(() => undefined);
    await rootFile?.close().catch(() => undefined);
  }
}

function claimsMatch(
  expected: AttestedClaims,
  actual: AttestedClaims,
  crypto: OperatorAttestationCrypto,
): boolean {
  const expectedDigest = crypto.sha256(canonicalStringify(expected));
  const actualDigest = crypto.sha256(canonicalStringify(actual));
  return timingSafeEqualHexDigest(expectedDigest, actualDigest);
}

/** Verify signed process evidence without issuing any host authority. */
export async function verifyOperatorContainerAttestationEvidence(
  attestationPath: string,
  input: OperatorAttestationDependencies = {},
): Promise<OperatorContainerAttestationEvidence> {
  const deps = depsWithDefaults(input);
  if (deps.platform !== "linux") fail("platform-unsupported");
  if (!isAbsolute(attestationPath) || posix.normalize(attestationPath) !== attestationPath) {
    fail("attestation-path-invalid");
  }
  let attestationFile: OperatorAttestationOpenFile | undefined;
  let bytes: Uint8Array;
  try {
    attestationFile = await deps.io.openReadOnly(attestationPath)
      .catch(() => fail("attestation-unavailable"));
    const attestationStat = await attestationFile.stat()
      .catch(() => fail("attestation-unavailable"));
    if (!attestationStat.isFile() || attestationStat.size < 1 ||
        attestationStat.size > MAX_ATTESTATION_BYTES) {
      fail("attestation-file-invalid");
    }
    bytes = await attestationFile.readUpTo(MAX_ATTESTATION_BYTES + 1)
      .catch(() => fail("attestation-read-failed"));
  } finally {
    await attestationFile?.close().catch(() => undefined);
  }
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_ATTESTATION_BYTES) {
    fail("attestation-size-invalid");
  }
  const now = deps.now();
  if (!Number.isSafeInteger(now) || now < 0) fail("clock-invalid");
  const parsed = parseAttestation(bytes, now);
  const facts = await collectCurrentFacts(deps);
  const trustedKey = await readTrustedKey(parsed.keyId, facts, deps);
  let signatureValid = false;
  try {
    signatureValid = deps.crypto.verify(
      Buffer.from(canonicalStringify(parsed.signedPayload), "utf8"),
      trustedKey.key,
      parsed.signature,
    );
  } catch {
    return fail("signature-invalid");
  }
  if (!signatureValid) fail("signature-invalid");
  if (!claimsMatch(parsed.claims, facts.claims, deps.crypto)) fail("process-facts-mismatch");
  const finalNow = deps.now();
  if (!Number.isSafeInteger(finalNow) || finalNow < 0 || finalNow >= parsed.expiresAt) {
    fail("attestation-expired-during-verification");
  }

  const fingerprints = Object.freeze({
    attestation: deps.crypto.sha256(bytes),
    process: facts.processFingerprint,
    key: trustedKey.fingerprint,
  });
  const evidence: OperatorContainerAttestationEvidence = Object.freeze({
    version: EVIDENCE_VERSION,
    expiresAt: parsed.expiresAt,
    fingerprints,
    isolation: Object.freeze({ ...facts.claims.isolation }),
    limits: Object.freeze({ ...facts.claims.cgroup.limits }),
  });
  verifiedEvidenceStates.set(evidence, Object.freeze({
    procIdentity: facts.procIdentity,
    processFingerprint: facts.processFingerprint,
    deps,
  }));
  return evidence;
}

function issueOperatorContainerCapability(
  evidence: OperatorContainerAttestationEvidence,
): OperatorContainerCapability {
  const evidenceState = verifiedEvidenceStates.get(evidence);
  if (!evidenceState) fail("attestation-evidence-not-verified");
  const now = evidenceState.deps.now();
  if (!Number.isSafeInteger(now) || now < 0 || now >= evidence.expiresAt) {
    fail("attestation-evidence-expired");
  }
  const id = evidenceState.deps.crypto.sha256(canonicalStringify({
    version: CAPABILITY_VERSION,
    fingerprints: evidence.fingerprints,
    expiresAt: evidence.expiresAt,
  }));
  const capability: OperatorContainerCapability = Object.freeze({
    version: CAPABILITY_VERSION,
    id,
    generation: evidenceState.deps.crypto.randomUUID(),
    expiresAt: evidence.expiresAt,
    fingerprints: evidence.fingerprints,
  });
  const audit: OperatorContainerCapabilityAuditProjection = Object.freeze({
    ...capability,
    fingerprints: evidence.fingerprints,
    isolation: evidence.isolation,
    limits: evidence.limits,
  });
  issuedCapabilities.add(capability);
  capabilityStates.set(capability, Object.freeze({
    ...evidenceState,
    audit,
  }));
  return capability;
}

/** Re-check non-authoritative evidence for tests and diagnostics. */
export async function revalidateOperatorContainerAttestationEvidence(
  evidence: OperatorContainerAttestationEvidence,
): Promise<OperatorContainerAttestationEvidence> {
  const state = verifiedEvidenceStates.get(evidence);
  if (!state) return fail("attestation-evidence-not-verified");
  const now = state.deps.now();
  if (!Number.isSafeInteger(now) || now < 0 || now >= evidence.expiresAt) {
    fail("attestation-evidence-expired");
  }
  const facts = await collectCurrentFacts(state.deps);
  if (facts.procIdentity !== state.procIdentity ||
      !timingSafeEqualHexDigest(facts.processFingerprint, state.processFingerprint)) {
    fail("attestation-evidence-process-changed");
  }
  const finalNow = state.deps.now();
  if (!Number.isSafeInteger(finalNow) || finalNow < 0 || finalNow >= evidence.expiresAt) {
    fail("attestation-evidence-expired");
  }
  return evidence;
}

export function isIssuedOperatorContainerCapability(
  value: unknown,
): value is OperatorContainerCapability {
  return typeof value === "object" && value !== null &&
    issuedCapabilities.has(value as OperatorContainerCapability);
}

export function getOperatorContainerCapabilityAuditProjection(
  capability: OperatorContainerCapability,
): OperatorContainerCapabilityAuditProjection {
  if (!issuedCapabilities.has(capability)) fail("capability-not-issued");
  const state = capabilityStates.get(capability);
  if (!state) return fail("capability-state-missing");
  return state.audit;
}

/** Re-read process identity and confinement facts before a future route consumes this evidence. */
async function revalidateOperatorContainerCapability(
  capability: OperatorContainerCapability,
): Promise<OperatorContainerCapability> {
  if (!issuedCapabilities.has(capability)) fail("capability-not-issued");
  const state = capabilityStates.get(capability);
  if (!state) return fail("capability-state-missing");
  const now = state.deps.now();
  if (!Number.isSafeInteger(now) || now < 0 || now >= capability.expiresAt) {
    fail("capability-expired");
  }
  const facts = await collectCurrentFacts(state.deps);
  if (facts.procIdentity !== state.procIdentity ||
      !timingSafeEqualHexDigest(facts.processFingerprint, state.processFingerprint)) {
    fail("capability-process-changed");
  }
  const finalNow = state.deps.now();
  if (!Number.isSafeInteger(finalNow) || finalNow < 0 || finalNow >= capability.expiresAt) {
    fail("capability-expired");
  }
  return capability;
}

function publishOperatorContainerCapability(
  capability: OperatorContainerCapability,
): void {
  if (!issuedCapabilities.has(capability)) fail("capability-not-issued");
  if (publishedCapability && publishedCapability !== capability) {
    fail("capability-already-published");
  }
  publishedCapability = capability;
}

/** The only authority-returning registry read; it always revalidates first. */
export async function acquirePublishedOperatorContainerCapability(): Promise<
  OperatorContainerCapability | null
> {
  if (!publishedCapability) return null;
  return revalidateOperatorContainerCapability(publishedCapability);
}

export async function verifyAndPublishOperatorContainerAttestation(
  attestationPath: string,
): Promise<OperatorContainerCapabilityAuditProjection> {
  // The production issuer deliberately closes over system I/O, platform,
  // clock, crypto, and the fixed trust root. Injectable verification above
  // only returns inert evidence and cannot mint a capability.
  const evidence = await verifyOperatorContainerAttestationEvidence(attestationPath);
  await revalidateOperatorContainerAttestationEvidence(evidence);
  const capability = issueOperatorContainerCapability(evidence);
  publishOperatorContainerCapability(capability);
  return getOperatorContainerCapabilityAuditProjection(capability);
}
