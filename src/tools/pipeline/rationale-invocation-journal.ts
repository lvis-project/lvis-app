import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute } from "node:path";
import { platform } from "node:process";
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

interface PendingAudit {
  invocationDigest: string;
  sessionId: string;
  version: AuditVersion;
  record: InvocationAuditRecord;
  canonicalRecord: string;
}

export interface DurableHostInvocationStartCasStoreOptions {
  filePath: string;
  now?: () => number;
  maxEntries?: number;
  /** Testable lower ceiling; production remains hard-capped at 16 MiB. */
  maxBytes?: number;
}

export interface InvocationCrashRecoveryResult {
  recovered: number;
  delivered: number;
}

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
  const contentBytes = Buffer.byteLength(canonicalStringify(snapshot) + "\n", "utf8");
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
  #tail: Promise<void> = Promise.resolve();

  constructor(options: DurableHostInvocationStartCasStoreOptions) {
    if (!isRecord(options) || typeof options.filePath !== "string" ||
        !isAbsolute(options.filePath) ||
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
      const snapshot = this.#readSnapshot();
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
      this.#writeSnapshot(makeRoomForInvocation({
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
      const snapshot = this.#readSnapshot();
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
      this.#writeSnapshot(nextRevision(snapshot, {
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
      const snapshot = this.#readSnapshot();
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
      if (count > 0) this.#writeSnapshot(nextRevision(snapshot, entries));
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
      const snapshot = this.#readSnapshot();
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
      const snapshot = this.#readSnapshot();
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
      this.#writeSnapshot(nextRevision(snapshot, {
        ...snapshot.entries,
        [pending.invocationDigest]: updated,
      }));
    });
  }

  #readSnapshot(): InvocationJournalSnapshot {
    let size: number;
    try {
      size = statSync(this.#filePath).size;
    } catch (error) {
      if (isMissingPathError(error)) return emptySnapshot();
      throw error;
    }
    if (size <= 0 || size > this.#maxBytes) {
      throw new Error("invocation journal size is invalid");
    }
    const text = readFileSync(this.#filePath, "utf8");
    if (Buffer.byteLength(text, "utf8") > this.#maxBytes) {
      throw new Error("invocation journal size limit exceeded");
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(text);
    } catch (error) {
      throw new Error("invocation journal JSON is corrupt", { cause: error });
    }
    validateSnapshot(decoded);
    return decoded;
  }

  #writeSnapshot(snapshot: InvocationJournalSnapshot): void {
    validateSnapshot(snapshot);
    const content = canonicalStringify(snapshot) + "\n";
    if (!snapshotFitsByteLimit(snapshot, this.#maxBytes)) {
      throw new Error("invocation journal size limit exceeded");
    }
    try {
      writeUtf8FileAtomicSync(this.#filePath, content, 0o600);
    } catch (error) {
      if (isRecord(error) && error.committed === true) {
        const persisted = this.#readSnapshot();
        if (equal(persisted, snapshot)) return;
      }
      throw error;
    }
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
