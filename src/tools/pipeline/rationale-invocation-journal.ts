import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
} from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
import { dirname, isAbsolute } from "node:path";
import { platform } from "node:process";
import { computeLineHmac, type SecretStore } from "../../audit/hmac-chain.js";
import { writeUtf8FileAtomicSync } from "../../lib/atomic-file.js";
import { withFileLock } from "../../lib/with-file-lock.js";
import { canonicalStringify } from "../../shared/canonical-json.js";
import {
  createHostInvocationStartLease,
  createInvocationAuditEvent,
  createInvocationStartedAudit,
  transitionInvocationAudit,
  validateHostInvocationStartLease,
  validateInvocationAuditRecord,
  validateInvocationTerminalForLease,
  validateHostInvocationStartAuthorization,
  type HostInvocationStartCas,
  type HostInvocationStartCommit,
  type HostInvocationStartLease,
  type InvocationAuditRecord,
  type InvocationAuditSink,
} from "./rationale-ticket-lifecycle.js";
import type { RationaleRequiredControl } from "./rationale-control.js";

const JOURNAL_SCHEMA_VERSION = 1 as const;
const MAX_JOURNAL_BYTES = 16 * 1024 * 1024;
const TERMINAL_TRANSITION_HEADROOM_BYTES = 2 * 1024;
const MAX_JOURNAL_ENTRIES = 4_096;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const JOURNAL_ENVELOPE_SCHEMA_VERSION = 1 as const;
const JOURNAL_ENVELOPE_KIND = "rationale-invocation-journal" as const;
const JOURNAL_KEY_DOMAIN = "lvis:rationale-invocation-journal:v1";
const JOURNAL_GENESIS_DOMAIN = "lvis:rationale-invocation-journal:genesis:v1";
const CHECKPOINT_SCHEMA_VERSION = 1 as const;
const CHECKPOINT_KIND = "rationale-invocation-journal-checkpoint" as const;
const CHECKPOINT_KEY_DOMAIN = "lvis:rationale-invocation-journal:checkpoint:v1";
const CHECKPOINT_NAME_PREFIX = "rationale-invocation-journal-checkpoint-v1-";
const HEAD_SCHEMA_VERSION = 1 as const;
const HEAD_KIND = "rationale-invocation-journal-head" as const;
const HEAD_KEY_DOMAIN = "lvis:rationale-invocation-journal:head:v1";
const HEAD_NAME = "rationale-invocation-journal-head-v1";
const MAX_CHECKPOINT_BYTES = 4 * 1024;


type AuditVersion = 0 | 1 | 2;

interface InvocationJournalEntry {
  authorized: InvocationAuditRecord;
  authorizationExpiresAt: number;
  controlDigest: string;
  sessionId: string;
  lease: HostInvocationStartLease;
  started: InvocationAuditRecord;
  terminal: InvocationAuditRecord | null;
  pendingAuditVersions: AuditVersion[];
  updatedAt: number;
}

interface InvocationJournalSnapshot {
  schemaVersion: typeof JOURNAL_SCHEMA_VERSION;
  revision: number;
  entries: Record<string, InvocationJournalEntry>;
}

interface InvocationJournalEnvelopeUnsigned {
  readonly schemaVersion: typeof JOURNAL_ENVELOPE_SCHEMA_VERSION;
  readonly kind: typeof JOURNAL_ENVELOPE_KIND;
  readonly previousMac: string;
  readonly snapshot: InvocationJournalSnapshot;
}

type InvocationJournalEnvelope = InvocationJournalEnvelopeUnsigned & {
  readonly mac: string;
};

type InvocationJournalCheckpointSlot = "a" | "b";

interface InvocationJournalCheckpointUnsigned {
  readonly schemaVersion: typeof CHECKPOINT_SCHEMA_VERSION;
  readonly kind: typeof CHECKPOINT_KIND;
  readonly slot: InvocationJournalCheckpointSlot;
  readonly generation: number;
  readonly journalRevision: number;
  readonly journalMac: string;
}

type InvocationJournalCheckpoint = InvocationJournalCheckpointUnsigned & {
  readonly seal: string;
};

interface InvocationJournalHeadUnsigned {
  readonly schemaVersion: typeof HEAD_SCHEMA_VERSION;
  readonly kind: typeof HEAD_KIND;
  readonly generation: number;
  readonly journalRevision: number;
  readonly journalMac: string;
}

type InvocationJournalHead = InvocationJournalHeadUnsigned & {
  readonly seal: string;
};

interface LoadedJournalState {
  readonly envelope: InvocationJournalEnvelope;
  readonly checkpoint: InvocationJournalCheckpoint;
  readonly head: InvocationJournalHead;
}

interface PendingAudit {
  invocationDigest: string;
  sessionId: string;
  version: AuditVersion;
  record: InvocationAuditRecord;
  canonicalRecord: string;
}

export interface DurableHostInvocationStartCasStoreOptions {
  filePath: string;
  auditSecret: string;
  sealStore: SecretStore;
  /** Fault-injection seam; production uses the repository atomic writer. */
  writeFileAtomic?: typeof writeUtf8FileAtomicSync;
  now?: () => number;
  maxEntries?: number;
  /** Testable lower ceiling; production remains hard-capped at 16 MiB. */
  maxBytes?: number;
}

export interface InvocationCrashRecoveryResult {
  recovered: number;
  delivered: number;
}

/**
 * Audit projection is intentionally at-least-once. A crash after the sink
 * commits but before this journal marks delivery may replay the same canonical
 * record. Sinks can identify it by (invocationDigest, version); this does not
 * replay or re-authorize the invocation-start CAS.
 */
export type RecoveryInvocationAuditSink = (
  sessionId: string,
  record: InvocationAuditRecord,
) => Promise<void> | void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length ||
      actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} contains unexpected or missing fields`);
  }
}

function equal(left: unknown, right: unknown): boolean {
  return canonicalStringify(left) === canonicalStringify(right);
}

function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function safeEqualHex(left: string, right: string): boolean {
  if (!DIGEST_PATTERN.test(left) || !DIGEST_PATTERN.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function sameFileIdentity(
  left: { readonly dev: bigint; readonly ino: bigint },
  right: { readonly dev: bigint; readonly ino: bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function readStableUtf8(filePath: string, maxBytes: number): string | null {
  const flags = constants.O_RDONLY |
    (platform === "win32" ? 0 : constants.O_NOFOLLOW);
  let fd: number | undefined;
  try {
    try {
      fd = openSync(filePath, flags);
    } catch (error) {
      if (isMissingPathError(error)) return null;
      throw error;
    }
    const before = fstatSync(fd, { bigint: true });
    const pathAtOpen = lstatSync(filePath, { bigint: true });
    if (!before.isFile() || pathAtOpen.isSymbolicLink() ||
        !pathAtOpen.isFile() || !sameFileIdentity(pathAtOpen, before)) {
      throw new Error("invocation journal identity changed before read");
    }
    const size = Number(before.size);
    if (!Number.isSafeInteger(size) || size <= 0 || size > maxBytes) {
      throw new Error("invocation journal size is invalid");
    }

    const buffer = Buffer.alloc(size);
    let completed = 0;
    while (completed < size) {
      const read = readSync(fd, buffer, completed, size - completed, completed);
      if (read === 0) {
        throw new Error("invocation journal was truncated during read");
      }
      completed += read;
    }

    const after = fstatSync(fd, { bigint: true });
    const pathAfter = lstatSync(filePath, { bigint: true });
    if (!after.isFile() || pathAfter.isSymbolicLink() || !pathAfter.isFile() ||
        !sameFileIdentity(before, after) || !sameFileIdentity(after, pathAfter) ||
        before.size !== after.size || before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs) {
      throw new Error("invocation journal changed during read");
    }

    const text = buffer.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(buffer)) {
      throw new Error("invocation journal is not valid UTF-8");
    }
    return text;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function emptySnapshot(): InvocationJournalSnapshot {
  return { schemaVersion: JOURNAL_SCHEMA_VERSION, revision: 0, entries: {} };
}

function auditForVersion(
  entry: InvocationJournalEntry,
  version: AuditVersion,
): InvocationAuditRecord {
  if (version === 0) return entry.authorized;
  if (version === 1) return entry.started;
  if (entry.terminal === null) {
    throw new Error("terminal audit projection is pending without a terminal record");
  }
  return entry.terminal;
}

function terminalEvent(
  terminal: InvocationAuditRecord,
): "complete" | "fail" | "crash-recovery" {
  if (terminal.state === "completed") return "complete";
  if (terminal.state === "failed") return "fail";
  if (terminal.state === "unknown-after-crash") return "crash-recovery";
  throw new Error("journal terminal record has a non-terminal state");
}

function validateEntry(
  invocationDigest: string,
  value: unknown,
): asserts value is InvocationJournalEntry {
  if (!isRecord(value)) throw new Error("invocation journal entry must be an object");
  exactKeys(value, [
    "authorized",
    "authorizationExpiresAt",
    "controlDigest",
    "sessionId",
    "lease",
    "started",
    "terminal",
    "pendingAuditVersions",
    "updatedAt",
  ], "invocation journal entry");

  const entry = value as unknown as InvocationJournalEntry;
  validateInvocationAuditRecord(entry.authorized);
  if (typeof entry.sessionId !== "string" ||
      entry.sessionId.length === 0 || entry.sessionId.length > 256 ||
      entry.authorized.state !== "authorized" || entry.authorized.version !== 0 ||
      entry.authorized.invocationDigest !== invocationDigest ||
      !DIGEST_PATTERN.test(entry.controlDigest) ||
      !Number.isFinite(entry.authorizationExpiresAt)) {
    throw new Error("journal authorization or session binding mismatch");
  }

  validateHostInvocationStartLease(
    entry.lease,
    entry.authorized,
    Number.MAX_SAFE_INTEGER,
  );
  const expectedStarted = createInvocationStartedAudit({
    authorized: entry.authorized,
    startLease: entry.lease,
    now: Number.MAX_SAFE_INTEGER,
  });
  validateInvocationAuditRecord(entry.started);
  if (!equal(expectedStarted, entry.started)) {
    throw new Error("journal started record binding mismatch");
  }

  if (entry.terminal !== null) {
    validateInvocationTerminalForLease(entry.terminal, entry.lease);
    const expectedTerminal = transitionInvocationAudit(
      entry.started,
      createInvocationAuditEvent(entry.started, terminalEvent(entry.terminal)),
    );
    if (!equal(expectedTerminal, entry.terminal)) {
      throw new Error("journal terminal record is not a monotonic transition");
    }
  }

  if (!Array.isArray(entry.pendingAuditVersions)) {
    throw new Error("journal pending audit versions must be an array");
  }
  let previous = -1;
  for (const version of entry.pendingAuditVersions as unknown[]) {
    if (version !== 0 && version !== 1 && version !== 2) {
      throw new Error("journal contains an invalid pending audit version");
    }
    if (version <= previous) {
      throw new Error("journal pending audit versions must be unique and ordered");
    }
    if (version === 2 && entry.terminal === null) {
      throw new Error("journal cannot project a missing terminal record");
    }
    previous = version;
  }

  if (!Number.isFinite(entry.updatedAt) ||
      entry.updatedAt < entry.lease.startedAt ||
      entry.authorizationExpiresAt <= entry.lease.startedAt) {
    throw new Error("journal entry has an invalid update timestamp");
  }
}

function validateSnapshot(value: unknown): asserts value is InvocationJournalSnapshot {
  if (!isRecord(value)) throw new Error("invocation journal must be an object");
  exactKeys(value, ["schemaVersion", "revision", "entries"], "invocation journal");
  if (value.schemaVersion !== JOURNAL_SCHEMA_VERSION) {
    throw new Error("unsupported invocation journal schema");
  }
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0) {
    throw new Error("invocation journal revision is invalid");
  }
  if (!isRecord(value.entries)) {
    throw new Error("invocation journal entries must be an object");
  }
  const entries = Object.entries(value.entries);
  if (entries.length > MAX_JOURNAL_ENTRIES) {
    throw new Error("invocation journal entry limit exceeded");
  }
  for (const [digest, entry] of entries) {
    if (!DIGEST_PATTERN.test(digest)) {
      throw new Error("invocation journal contains an invalid digest key");
    }
    validateEntry(digest, entry);
  }
}

function sealEnvelope(
  secret: string,
  snapshot: InvocationJournalSnapshot,
  previousMac: string,
): InvocationJournalEnvelope {
  validateSnapshot(snapshot);
  if (!DIGEST_PATTERN.test(previousMac)) {
    throw new Error("invocation journal previous MAC is invalid");
  }
  const unsigned: InvocationJournalEnvelopeUnsigned = {
    schemaVersion: JOURNAL_ENVELOPE_SCHEMA_VERSION,
    kind: JOURNAL_ENVELOPE_KIND,
    previousMac,
    snapshot,
  };
  return {
    ...unsigned,
    mac: computeLineHmac(secret, canonicalStringify(unsigned)),
  };
}

function parseEnvelope(
  text: string,
  secret: string,
): InvocationJournalEnvelope {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch (error) {
    throw new Error("invocation journal JSON is corrupt", { cause: error });
  }
  if (!isRecord(decoded)) {
    throw new Error("invocation journal envelope must be an object");
  }
  exactKeys(decoded, [
    "schemaVersion",
    "kind",
    "previousMac",
    "snapshot",
    "mac",
  ], "invocation journal envelope");
  if (decoded.schemaVersion !== JOURNAL_ENVELOPE_SCHEMA_VERSION ||
      decoded.kind !== JOURNAL_ENVELOPE_KIND ||
      typeof decoded.previousMac !== "string" ||
      !DIGEST_PATTERN.test(decoded.previousMac) ||
      typeof decoded.mac !== "string" ||
      !DIGEST_PATTERN.test(decoded.mac)) {
    throw new Error("invocation journal envelope is invalid");
  }
  validateSnapshot(decoded.snapshot);
  const unsigned: InvocationJournalEnvelopeUnsigned = {
    schemaVersion: JOURNAL_ENVELOPE_SCHEMA_VERSION,
    kind: JOURNAL_ENVELOPE_KIND,
    previousMac: decoded.previousMac,
    snapshot: decoded.snapshot,
  };
  const expectedMac = computeLineHmac(secret, canonicalStringify(unsigned));
  if (!safeEqualHex(decoded.mac, expectedMac)) {
    throw new Error("invocation journal HMAC mismatch");
  }
  const envelope: InvocationJournalEnvelope = {
    ...unsigned,
    mac: decoded.mac,
  };
  if (text !== canonicalStringify(envelope) + "\n") {
    throw new Error("invocation journal encoding is not canonical");
  }
  return envelope;
}

function checkpointName(slot: InvocationJournalCheckpointSlot): string {
  return `${CHECKPOINT_NAME_PREFIX}${slot}`;
}

function sealCheckpoint(
  secret: string,
  unsigned: InvocationJournalCheckpointUnsigned,
): InvocationJournalCheckpoint {
  return {
    ...unsigned,
    seal: computeLineHmac(secret, canonicalStringify(unsigned)),
  };
}

function parseCheckpoint(
  raw: string,
  slot: InvocationJournalCheckpointSlot,
  secret: string,
): InvocationJournalCheckpoint {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch (error) {
    throw new Error("invocation journal checkpoint encoding is corrupt", {
      cause: error,
    });
  }
  if (!isRecord(decoded)) {
    throw new Error("invocation journal checkpoint must be an object");
  }
  exactKeys(decoded, [
    "schemaVersion",
    "kind",
    "slot",
    "generation",
    "journalRevision",
    "journalMac",
    "seal",
  ], "invocation journal checkpoint");
  if (decoded.schemaVersion !== CHECKPOINT_SCHEMA_VERSION ||
      decoded.kind !== CHECKPOINT_KIND || decoded.slot !== slot ||
      !Number.isSafeInteger(decoded.generation) ||
      (decoded.generation as number) < 0 ||
      !Number.isSafeInteger(decoded.journalRevision) ||
      (decoded.journalRevision as number) < 0 ||
      decoded.generation !== decoded.journalRevision ||
      slot !== ((decoded.generation as number) % 2 === 0 ? "a" : "b") ||
      typeof decoded.journalMac !== "string" ||
      !DIGEST_PATTERN.test(decoded.journalMac) ||
      typeof decoded.seal !== "string" ||
      !DIGEST_PATTERN.test(decoded.seal)) {
    throw new Error("invocation journal checkpoint is invalid");
  }
  const unsigned: InvocationJournalCheckpointUnsigned = {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    kind: CHECKPOINT_KIND,
    slot,
    generation: decoded.generation as number,
    journalRevision: decoded.journalRevision as number,
    journalMac: decoded.journalMac,
  };
  const expectedSeal = computeLineHmac(secret, canonicalStringify(unsigned));
  if (!safeEqualHex(decoded.seal, expectedSeal)) {
    throw new Error("invocation journal checkpoint seal mismatch");
  }
  const checkpoint: InvocationJournalCheckpoint = {
    ...unsigned,
    seal: decoded.seal,
  };
  if (raw !== canonicalStringify(checkpoint)) {
    throw new Error("invocation journal checkpoint encoding is not canonical");
  }
  return checkpoint;
}

function sealHead(
  secret: string,
  unsigned: InvocationJournalHeadUnsigned,
): InvocationJournalHead {
  return {
    ...unsigned,
    seal: computeLineHmac(secret, canonicalStringify(unsigned)),
  };
}

function parseHead(raw: string, secret: string): InvocationJournalHead {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch (error) {
    throw new Error("invocation journal head encoding is corrupt", {
      cause: error,
    });
  }
  if (!isRecord(decoded)) {
    throw new Error("invocation journal head must be an object");
  }
  exactKeys(decoded, [
    "schemaVersion",
    "kind",
    "generation",
    "journalRevision",
    "journalMac",
    "seal",
  ], "invocation journal head");
  if (decoded.schemaVersion !== HEAD_SCHEMA_VERSION ||
      decoded.kind !== HEAD_KIND ||
      !Number.isSafeInteger(decoded.generation) ||
      (decoded.generation as number) < 0 ||
      !Number.isSafeInteger(decoded.journalRevision) ||
      (decoded.journalRevision as number) < 0 ||
      decoded.generation !== decoded.journalRevision ||
      typeof decoded.journalMac !== "string" ||
      !DIGEST_PATTERN.test(decoded.journalMac) ||
      typeof decoded.seal !== "string" ||
      !DIGEST_PATTERN.test(decoded.seal)) {
    throw new Error("invocation journal head is invalid");
  }
  const unsigned: InvocationJournalHeadUnsigned = {
    schemaVersion: HEAD_SCHEMA_VERSION,
    kind: HEAD_KIND,
    generation: decoded.generation as number,
    journalRevision: decoded.journalRevision as number,
    journalMac: decoded.journalMac,
  };
  const expectedSeal = computeLineHmac(secret, canonicalStringify(unsigned));
  if (!safeEqualHex(decoded.seal, expectedSeal)) {
    throw new Error("invocation journal head seal mismatch");
  }
  const head: InvocationJournalHead = {
    ...unsigned,
    seal: decoded.seal,
  };
  if (raw !== canonicalStringify(head)) {
    throw new Error("invocation journal head encoding is not canonical");
  }
  return head;
}

function envelopeByteLength(snapshot: InvocationJournalSnapshot): number {
  const placeholder: InvocationJournalEnvelope = {
    schemaVersion: JOURNAL_ENVELOPE_SCHEMA_VERSION,
    kind: JOURNAL_ENVELOPE_KIND,
    previousMac: "0".repeat(64),
    snapshot,
    mac: "0".repeat(64),
  };
  return Buffer.byteLength(canonicalStringify(placeholder) + "\n", "utf8");
}

function nextRevision(
  snapshot: InvocationJournalSnapshot,
  entries: Record<string, InvocationJournalEntry>,
): InvocationJournalSnapshot {
  if (snapshot.revision >= Number.MAX_SAFE_INTEGER) {
    throw new Error("invocation journal revision exhausted");
  }
  return {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    revision: snapshot.revision + 1,
    entries,
  };
}

function addPendingVersion(
  versions: readonly AuditVersion[],
  version: AuditVersion,
): AuditVersion[] {
  return [...new Set([...versions, version])].sort((left, right) => left - right) as
    AuditVersion[];
}

function snapshotFitsByteLimit(
  snapshot: InvocationJournalSnapshot,
  maxBytes: number,
): boolean {
  const contentBytes = envelopeByteLength(snapshot);
  const activeEntryCount = Object.values(snapshot.entries)
    .filter((entry) => entry.terminal === null)
    .length;
  return contentBytes +
    (activeEntryCount * TERMINAL_TRANSITION_HEADROOM_BYTES) <= maxBytes;
}

function makeRoomForInvocation(input: {
  snapshot: InvocationJournalSnapshot;
  invocationDigest: string;
  entry: InvocationJournalEntry;
  maxEntries: number;
  maxBytes: number;
  now: number;
}): InvocationJournalSnapshot {
  const entries = { ...input.snapshot.entries };
  const delivered = Object.entries(entries)
    .filter(([, entry]) =>
      entry.terminal !== null &&
      entry.pendingAuditVersions.length === 0 &&
      entry.authorizationExpiresAt <= input.now)
    .sort(([leftDigest, left], [rightDigest, right]) =>
      left.updatedAt - right.updatedAt || leftDigest.localeCompare(rightDigest));

  let compactableIndex = 0;
  while (true) {
    const candidate = nextRevision(input.snapshot, {
      ...entries,
      [input.invocationDigest]: input.entry,
    });
    const exceedsEntryLimit = Object.keys(candidate.entries).length > input.maxEntries;
    const exceedsByteLimit = !snapshotFitsByteLimit(candidate, input.maxBytes);
    if (!exceedsEntryLimit && !exceedsByteLimit) return candidate;

    const compactable = delivered[compactableIndex];
    if (!compactable) {
      if (exceedsEntryLimit) {
        throw new Error("invocation journal has no safely compactable terminal entry");
      }
      throw new Error("invocation journal size limit exceeded");
    }
    compactableIndex += 1;
    delete entries[compactable[0]];
  }
}

export class DurableHostInvocationStartCasStore implements HostInvocationStartCas {
  readonly #filePath: string;
  readonly #lockTargetPath: string;
  readonly #now: () => number;
  readonly #maxEntries: number;
  readonly #maxBytes: number;
  readonly #journalSecret: string;
  readonly #checkpointSecret: string;
  readonly #headSecret: string;
  readonly #genesisMac: string;
  readonly #sealStore: SecretStore;
  readonly #writeFileAtomic: typeof writeUtf8FileAtomicSync;
  #tail: Promise<void> = Promise.resolve();

  constructor(options: DurableHostInvocationStartCasStoreOptions) {
    if (!isRecord(options) || typeof options.filePath !== "string" ||
        !isAbsolute(options.filePath) ||
        typeof options.auditSecret !== "string" || options.auditSecret.length < 32 ||
        !options.sealStore || typeof options.sealStore.read !== "function" ||
        typeof options.sealStore.write !== "function" ||
        (options.writeFileAtomic !== undefined &&
          typeof options.writeFileAtomic !== "function") ||
        (options.now !== undefined && typeof options.now !== "function") ||
        (options.maxEntries !== undefined &&
          (!Number.isSafeInteger(options.maxEntries) ||
            options.maxEntries < 2 || options.maxEntries > MAX_JOURNAL_ENTRIES)) ||
        (options.maxBytes !== undefined &&
          (!Number.isSafeInteger(options.maxBytes) ||
            options.maxBytes < 1_024 || options.maxBytes > MAX_JOURNAL_BYTES))) {
      throw new TypeError("durable invocation journal options are invalid");
    }
    this.#filePath = options.filePath;
    this.#lockTargetPath = `${options.filePath}.lock-target`;
    this.#now = options.now ?? Date.now;
    this.#maxEntries = options.maxEntries ?? MAX_JOURNAL_ENTRIES;
    this.#maxBytes = options.maxBytes ?? MAX_JOURNAL_BYTES;
    this.#journalSecret = computeLineHmac(options.auditSecret, JOURNAL_KEY_DOMAIN);
    this.#checkpointSecret = computeLineHmac(
      options.auditSecret,
      CHECKPOINT_KEY_DOMAIN,
    );
    this.#headSecret = computeLineHmac(options.auditSecret, HEAD_KEY_DOMAIN);
    this.#genesisMac = computeLineHmac(
      this.#journalSecret,
      JOURNAL_GENESIS_DOMAIN,
    );
    this.#sealStore = options.sealStore;
    this.#writeFileAtomic = options.writeFileAtomic ?? writeUtf8FileAtomicSync;
  }

  async commitStart(input: {
    sessionId: string;
    control: RationaleRequiredControl;
    authorized: InvocationAuditRecord;
    expectedInvocationVersion: 0;
    persistAudit: InvocationAuditSink;
    now?: number;
  }): Promise<HostInvocationStartCommit | null> {
    const now = input.now ?? this.#now();
    validateHostInvocationStartAuthorization({ ...input, now });

    const committed = await this.#withLock(async () => {
      const state = this.#loadState();
      const snapshot = state.envelope.snapshot;
      const digest = input.authorized.invocationDigest;
      if (snapshot.entries[digest] !== undefined) return null;
      const lease = createHostInvocationStartLease({
        authorized: input.authorized,
        now,
      });
      const startedInvocationAudit = createInvocationStartedAudit({
        authorized: input.authorized,
        startLease: lease,
        now,
      });
      const entry: InvocationJournalEntry = {
        authorized: input.authorized,
        authorizationExpiresAt: input.control.anchor.expiresAt,
        controlDigest: createHash("sha256")
          .update(canonicalStringify(input.control))
          .digest("hex"),
        sessionId: input.sessionId,
        lease,
        started: startedInvocationAudit,
        terminal: null,
        pendingAuditVersions: [0, 1],
        updatedAt: now,
      };
      this.#writeSnapshot(state, makeRoomForInvocation({
        snapshot,
        invocationDigest: digest,
        entry,
        maxEntries: this.#maxEntries,
        maxBytes: this.#maxBytes,
        now,
      }));
      return { lease, startedInvocationAudit };
    });

    if (committed === null) return null;
    await this.#deliverPending(
      input.authorized.invocationDigest,
      (_sessionId, record) => input.persistAudit(record),
    );
    return committed;
  }

  async commitTerminal(input: {
    lease: HostInvocationStartLease;
    terminal: InvocationAuditRecord;
    persistAudit: InvocationAuditSink;
  }): Promise<boolean> {
    try {
      if (typeof input.persistAudit !== "function") return false;
      validateInvocationTerminalForLease(input.terminal, input.lease);
    } catch {
      return false;
    }

    const committed = await this.#withLock(async () => {
      const state = this.#loadState();
      const snapshot = state.envelope.snapshot;
      const digest = input.lease.invocationDigest;
      const entry = snapshot.entries[digest];
      if (!entry || !equal(entry.lease, input.lease)) return false;
      if (entry.terminal !== null) {
        return equal(entry.terminal, input.terminal);
      }
      const now = this.#now();
      if (!Number.isFinite(now) || now < 0) {
        throw new Error("invalid durable invocation terminal timestamp");
      }
      const updated: InvocationJournalEntry = {
        ...entry,
        terminal: input.terminal,
        pendingAuditVersions: addPendingVersion(entry.pendingAuditVersions, 2),
        updatedAt: Math.max(entry.updatedAt, entry.lease.startedAt, now),
      };
      this.#writeSnapshot(state, nextRevision(snapshot, {
        ...snapshot.entries,
        [digest]: updated,
      }));
      return true;
    });
    if (!committed) return false;

    try {
      await this.#deliverPending(
        input.lease.invocationDigest,
        (_sessionId, record) => input.persistAudit(record),
      );
      return true;
    } catch {
      return false;
    }
  }

  async recoverAfterCrash(input: {
    persistAudit: RecoveryInvocationAuditSink;
    now?: number;
  }): Promise<InvocationCrashRecoveryResult> {
    if (!isRecord(input) || typeof input.persistAudit !== "function") {
      throw new TypeError("crash recovery requires an invocation audit sink");
    }
    const now = input.now ?? this.#now();
    if (!Number.isFinite(now) || now < 0) {
      throw new Error("invalid crash recovery timestamp");
    }

    const recovered = await this.#withLock(async () => {
      const state = this.#loadState();
      const snapshot = state.envelope.snapshot;
      let count = 0;
      const entries = { ...snapshot.entries };
      for (const digest of Object.keys(entries).sort()) {
        const entry = entries[digest];
        if (entry.terminal !== null) continue;
        const terminal = transitionInvocationAudit(
          entry.started,
          createInvocationAuditEvent(entry.started, "crash-recovery"),
        );
        entries[digest] = {
          ...entry,
          terminal,
          pendingAuditVersions: addPendingVersion(entry.pendingAuditVersions, 2),
          updatedAt: Math.max(entry.updatedAt, entry.lease.startedAt, now),
        };
        count += 1;
      }
      if (count > 0) this.#writeSnapshot(state, nextRevision(snapshot, entries));
      return count;
    });

    const delivered = await this.#deliverPending(undefined, input.persistAudit);
    return { recovered, delivered };
  }

  async #deliverPending(
    invocationDigest: string | undefined,
    persistAudit: RecoveryInvocationAuditSink,
  ): Promise<number> {
    let delivered = 0;
    while (true) {
      const pending = await this.#nextPending(invocationDigest);
      if (pending === null) return delivered;
      await persistAudit(pending.sessionId, pending.record);
      delivered += 1;
      await this.#markDelivered(pending);
    }
  }

  async #nextPending(
    invocationDigest: string | undefined,
  ): Promise<PendingAudit | null> {
    return this.#withLock(async () => {
      const snapshot = this.#loadState().envelope.snapshot;
      const digests = invocationDigest === undefined
        ? Object.keys(snapshot.entries).sort()
        : [invocationDigest];
      for (const digest of digests) {
        const entry = snapshot.entries[digest];
        if (!entry || entry.pendingAuditVersions.length === 0) continue;
        const version = entry.pendingAuditVersions[0];
        const record = auditForVersion(entry, version);
        return {
          invocationDigest: digest,
          sessionId: entry.sessionId,
          version,
          record,
          canonicalRecord: canonicalStringify(record),
        };
      }
      return null;
    });
  }

  async #markDelivered(pending: PendingAudit): Promise<void> {
    await this.#withLock(async () => {
      const state = this.#loadState();
      const snapshot = state.envelope.snapshot;
      const entry = snapshot.entries[pending.invocationDigest];
      if (!entry) {
        throw new Error("invocation journal entry disappeared during audit projection");
      }
      if (!entry.pendingAuditVersions.includes(pending.version)) return;
      const currentRecord = auditForVersion(entry, pending.version);
      if (canonicalStringify(currentRecord) !== pending.canonicalRecord) {
        throw new Error("invocation audit changed during projection");
      }
      const updated: InvocationJournalEntry = {
        ...entry,
        pendingAuditVersions: entry.pendingAuditVersions.filter(
          (version) => version !== pending.version,
        ),
      };
      this.#writeSnapshot(state, nextRevision(snapshot, {
        ...snapshot.entries,
        [pending.invocationDigest]: updated,
      }));
    });
  }

  #readEnvelope(): InvocationJournalEnvelope | null {
    const text = readStableUtf8(this.#filePath, this.#maxBytes);
    return text === null ? null : parseEnvelope(text, this.#journalSecret);
  }

  #readCheckpoint(): InvocationJournalCheckpoint | null {
    const candidates: InvocationJournalCheckpoint[] = [];
    for (const slot of ["a", "b"] as const) {
      const raw = this.#sealStore.read(
        checkpointName(slot),
        MAX_CHECKPOINT_BYTES,
      );
      if (raw === null) continue;
      if (Buffer.byteLength(raw, "utf8") > MAX_CHECKPOINT_BYTES) {
        throw new Error("invocation journal checkpoint exceeds size limit");
      }
      candidates.push(parseCheckpoint(raw, slot, this.#checkpointSecret));
    }
    if (candidates.length === 0) return null;
    candidates.sort((left, right) => right.generation - left.generation);
    if (candidates.length > 1 &&
        candidates[0]!.generation === candidates[1]!.generation) {
      throw new Error("invocation journal checkpoint generations conflict");
    }
    return candidates[0]!;
  }

  #readHead(): InvocationJournalHead | null {
    const raw = this.#sealStore.read(HEAD_NAME, MAX_CHECKPOINT_BYTES);
    if (raw === null) return null;
    if (Buffer.byteLength(raw, "utf8") > MAX_CHECKPOINT_BYTES) {
      throw new Error("invocation journal head exceeds size limit");
    }
    return parseHead(raw, this.#headSecret);
  }

  #loadState(): LoadedJournalState {
    const envelope = this.#readEnvelope();
    const checkpoint = this.#readCheckpoint();
    const head = this.#readHead();
    if (envelope === null && checkpoint === null && head === null) {
      return this.#initializeGenesis();
    }
    if (envelope === null) {
      throw new Error("invocation journal is missing behind its checkpoint");
    }
    if (checkpoint === null) {
      throw new Error(
        "invocation journal checkpoint is absent for an existing journal",
      );
    }
    if (head === null) {
      throw new Error("invocation journal head is absent for an existing journal");
    }

    const revision = envelope.snapshot.revision;
    if (revision === 0 &&
        (!safeEqualHex(envelope.previousMac, this.#genesisMac) ||
          Object.keys(envelope.snapshot.entries).length !== 0)) {
      throw new Error("invocation journal genesis root mismatch");
    }

    // The sealed head makes deletion of only the newest A/B slot detectable.
    // Joint rollback of the journal, both slots, and this local head still
    // requires an external monotonic authority to prevent.
    if (checkpoint.generation < head.generation) {
      throw new Error("invocation journal head is ahead of available checkpoint");
    }
    if (checkpoint.generation > head.generation + 1) {
      throw new Error("invocation journal checkpoint is too far ahead of its head");
    }

    if (checkpoint.generation === head.generation + 1) {
      if (revision !== checkpoint.journalRevision ||
          !safeEqualHex(envelope.mac, checkpoint.journalMac) ||
          revision !== head.journalRevision + 1 ||
          !safeEqualHex(envelope.previousMac, head.journalMac)) {
        throw new Error("invocation journal checkpoint is not anchored to its head");
      }
      this.#persistEnvelope(envelope);
      const repairedHead = this.#writeHead(checkpoint);
      return { envelope, checkpoint, head: repairedHead };
    }

    if (checkpoint.journalRevision !== head.journalRevision ||
        !safeEqualHex(checkpoint.journalMac, head.journalMac)) {
      throw new Error("invocation journal checkpoint/head root mismatch");
    }
    if (revision === head.journalRevision) {
      if (!safeEqualHex(envelope.mac, head.journalMac)) {
        throw new Error("invocation journal/checkpoint root mismatch");
      }
      return { envelope, checkpoint, head };
    }
    if (revision < head.journalRevision) {
      throw new Error("invocation journal rollback detected");
    }
    if (revision === head.journalRevision + 1 &&
        safeEqualHex(envelope.previousMac, head.journalMac)) {
      this.#persistEnvelope(envelope);
      const repaired = this.#advanceCheckpoint(checkpoint, envelope);
      const repairedHead = this.#writeHead(repaired);
      return { envelope, checkpoint: repaired, head: repairedHead };
    }
    throw new Error("invocation journal is not anchored to its checkpoint");
  }

  #initializeGenesis(): LoadedJournalState {
    const snapshot = emptySnapshot();
    if (!snapshotFitsByteLimit(snapshot, this.#maxBytes)) {
      throw new Error("invocation journal size limit exceeded");
    }
    const envelope = sealEnvelope(
      this.#journalSecret,
      snapshot,
      this.#genesisMac,
    );
    this.#persistEnvelope(envelope);
    const checkpoint = this.#writeGenesisCheckpoint(envelope);
    const head = this.#writeHead(checkpoint);
    return { envelope, checkpoint, head };
  }

  #persistEnvelope(envelope: InvocationJournalEnvelope): void {
    const content = canonicalStringify(envelope) + "\n";
    if (!snapshotFitsByteLimit(envelope.snapshot, this.#maxBytes) ||
        Buffer.byteLength(content, "utf8") > this.#maxBytes) {
      throw new Error("invocation journal size limit exceeded");
    }
    try {
      this.#writeFileAtomic(this.#filePath, content, 0o600);
    } catch (error) {
      if (isRecord(error) && error.committed === true) {
        let persisted: InvocationJournalEnvelope | null;
        try {
          persisted = this.#readEnvelope();
        } catch {
          throw error;
        }
        if (persisted !== null && equal(persisted, envelope)) {
          // A second complete atomic replace is the durability barrier. Its
          // failure must escape; mere visibility after the first rename is
          // not sufficient authority to advance the checkpoint.
          this.#writeFileAtomic(this.#filePath, content, 0o600);
          return;
        }
      }
      throw error;
    }
  }

  #writeSnapshot(
    previous: LoadedJournalState,
    snapshot: InvocationJournalSnapshot,
  ): void {
    validateSnapshot(snapshot);
    if (snapshot.revision !== previous.envelope.snapshot.revision + 1 ||
        previous.checkpoint.journalRevision !==
          previous.envelope.snapshot.revision ||
        !safeEqualHex(previous.checkpoint.journalMac, previous.envelope.mac) ||
        previous.head.journalRevision !== previous.envelope.snapshot.revision ||
        !safeEqualHex(previous.head.journalMac, previous.envelope.mac)) {
      throw new Error("invocation journal mutation skipped a revision");
    }
    if (!snapshotFitsByteLimit(snapshot, this.#maxBytes)) {
      throw new Error("invocation journal size limit exceeded");
    }
    const envelope = sealEnvelope(
      this.#journalSecret,
      snapshot,
      previous.envelope.mac,
    );
    this.#persistEnvelope(envelope);
    const checkpoint = this.#advanceCheckpoint(previous.checkpoint, envelope);
    this.#writeHead(checkpoint);
  }

  #writeGenesisCheckpoint(
    envelope: InvocationJournalEnvelope,
  ): InvocationJournalCheckpoint {
    if (envelope.snapshot.revision !== 0 ||
        Object.keys(envelope.snapshot.entries).length !== 0 ||
        !safeEqualHex(envelope.previousMac, this.#genesisMac)) {
      throw new Error("invalid invocation journal genesis envelope");
    }
    const checkpoint = sealCheckpoint(this.#checkpointSecret, {
      schemaVersion: CHECKPOINT_SCHEMA_VERSION,
      kind: CHECKPOINT_KIND,
      slot: "a",
      generation: 0,
      journalRevision: 0,
      journalMac: envelope.mac,
    });
    this.#sealStore.write(checkpointName("a"), canonicalStringify(checkpoint));
    return checkpoint;
  }

  #advanceCheckpoint(
    previous: InvocationJournalCheckpoint,
    envelope: InvocationJournalEnvelope,
  ): InvocationJournalCheckpoint {
    const revision = envelope.snapshot.revision;
    const generation = previous.generation + 1;
    if (!Number.isSafeInteger(generation) ||
        revision !== previous.journalRevision + 1 ||
        generation !== revision ||
        !safeEqualHex(envelope.previousMac, previous.journalMac)) {
      throw new Error("invocation journal checkpoint advance is invalid");
    }
    const slot: InvocationJournalCheckpointSlot =
      generation % 2 === 0 ? "a" : "b";
    const checkpoint = sealCheckpoint(this.#checkpointSecret, {
      schemaVersion: CHECKPOINT_SCHEMA_VERSION,
      kind: CHECKPOINT_KIND,
      slot,
      generation,
      journalRevision: revision,
      journalMac: envelope.mac,
    });
    this.#sealStore.write(checkpointName(slot), canonicalStringify(checkpoint));
    return checkpoint;
  }

  #writeHead(
    checkpoint: InvocationJournalCheckpoint,
  ): InvocationJournalHead {
    const head = sealHead(this.#headSecret, {
      schemaVersion: HEAD_SCHEMA_VERSION,
      kind: HEAD_KIND,
      generation: checkpoint.generation,
      journalRevision: checkpoint.journalRevision,
      journalMac: checkpoint.journalMac,
    });
    this.#sealStore.write(HEAD_NAME, canonicalStringify(head));
    return head;
  }

  async #withLock<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(async () => {
      const parent = dirname(this.#filePath);
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      if (platform !== "win32") chmodSync(parent, 0o700);
      const lockFd = openSync(this.#lockTargetPath, "a", 0o600);
      closeSync(lockFd);
      if (platform !== "win32") chmodSync(this.#lockTargetPath, 0o600);
      return withFileLock(
        this.#lockTargetPath,
        operation,
        { stale: 30_000, retries: 8 },
      );
    });
    this.#tail = run.then(() => undefined, () => undefined);
    return run;
  }
}
