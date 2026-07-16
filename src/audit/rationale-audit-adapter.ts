import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { platform } from "node:process";
import lockfile from "proper-lockfile";
import { computeLineHmac, GENESIS_MARKER, type SecretStore } from "./hmac-chain.js";
import { assertRationaleCanonicalJson } from "../tools/pipeline/rationale-control.js";
import {
  validateInvocationAuditRecord,
  type InvocationAuditRecord,
} from "../tools/pipeline/rationale-ticket-lifecycle.js";
import {
  validateRationaleUiAuditProjection,
  type RationaleUiAuditProjection,
} from "../tools/pipeline/rationale-resume-contract.js";
import type { RationaleTicketStoreAuditEvent } from "../tools/pipeline/rationale-ticket-store.js";

export const RATIONALE_AUDIT_SCHEMA_VERSION = 1 as const;
export const RATIONALE_AUDIT_MAX_DAILY_BYTES = 64 * 1024 * 1024;
export const RATIONALE_AUDIT_MAX_DAILY_LINES = 100_000;
const RATIONALE_AUDIT_MAX_LINE_BYTES = 64 * 1024;
const KEY_DOMAIN = "lvis:rationale-audit:v1";
const CHECKPOINT_KEY_DOMAIN = "lvis:rationale-audit:checkpoint:v2";
const CHECKPOINT_KIND = "rationale-audit-checkpoint";
const CHECKPOINT_SCHEMA_VERSION = 2 as const;
const CHECKPOINT_NAME_PREFIX = "rationale-audit-checkpoint-v2-";
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_DELAY_MS = 25;
const DEFAULT_LOCK_RETRIES = 5;
const SAFE_SESSION_ID_RE = /^[^\u0000-\u001f\u007f-\u009f]{1,256}$/u;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;
const HMAC_RE = /^[a-f0-9]{64}$/u;
const LOCK_SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));

export interface RationaleTicketAuditEntry {
  readonly schemaVersion: typeof RATIONALE_AUDIT_SCHEMA_VERSION;
  readonly auditId: string;
  readonly kind: "rationale-ticket-lifecycle";
  readonly sessionId: string;
  readonly at: number;
  readonly event: RationaleTicketStoreAuditEvent;
  readonly prevHash: string;
  readonly sequence: number;
  readonly rowMac: string;
}

export interface RationaleInvocationAuditEntry {
  readonly schemaVersion: typeof RATIONALE_AUDIT_SCHEMA_VERSION;
  readonly auditId: string;
  readonly kind: "rationale-invocation-lifecycle";
  readonly sessionId: string;
  readonly at: number;
  readonly record: InvocationAuditRecord;
  readonly prevHash: string;
  readonly sequence: number;
  readonly rowMac: string;
}

export interface RationaleProjectionAuditEntry {
  readonly schemaVersion: typeof RATIONALE_AUDIT_SCHEMA_VERSION;
  readonly auditId: string;
  readonly kind: "rationale-ui-projection";
  readonly sessionId: string;
  readonly at: number;
  readonly projection: RationaleUiAuditProjection;
  readonly prevHash: string;
  readonly sequence: number;
  readonly rowMac: string;
}

export type RationaleAuditEntry =
  | RationaleTicketAuditEntry
  | RationaleInvocationAuditEntry
  | RationaleProjectionAuditEntry;
type RationaleAuditEntryInput =
  | Omit<RationaleTicketAuditEntry, "prevHash" | "sequence" | "rowMac">
  | Omit<RationaleInvocationAuditEntry, "prevHash" | "sequence" | "rowMac">
  | Omit<RationaleProjectionAuditEntry, "prevHash" | "sequence" | "rowMac">;

export interface RationaleAuditSink {
  assertWritable(at?: number): void;
  appendTicket(event: RationaleTicketStoreAuditEvent): RationaleTicketAuditEntry;
  appendInvocation(sessionId: string, record: InvocationAuditRecord): RationaleInvocationAuditEntry;
  appendProjection(
    sessionId: string,
    projection: RationaleUiAuditProjection,
    at: number,
  ): RationaleProjectionAuditEntry;
}

export interface DurableRationaleAuditAdapterOptions {
  readonly auditDir: string;
  readonly auditSecret: string;
  readonly sealStore: SecretStore;
  readonly now?: () => number;
  readonly maxBytesPerDay?: number;
  readonly maxLinesPerDay?: number;
  readonly lockRetries?: number;
}

export class RationaleAuditUnavailableError extends Error {
  readonly code = "RATIONALE_AUDIT_UNAVAILABLE";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RationaleAuditUnavailableError";
  }
}

class RationaleAuditLockBusyError extends Error {
  constructor(cause: unknown) {
    super("rationale audit day lock is busy", { cause });
    this.name = "RationaleAuditLockBusyError";
  }
}

type CheckpointSlot = "a" | "b";

interface FileFingerprint {
  readonly dev: string;
  readonly ino: string;
  readonly size: number;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
}

interface AuditCheckpointUnsigned {
  readonly schemaVersion: typeof CHECKPOINT_SCHEMA_VERSION;
  readonly kind: typeof CHECKPOINT_KIND;
  readonly day: string;
  readonly slot: CheckpointSlot;
  readonly generation: number;
  readonly sequence: number;
  readonly byteLength: number;
  readonly lastRowMac: string;
  readonly fingerprint: FileFingerprint | null;
}

type AuditCheckpoint = AuditCheckpointUnsigned & { readonly seal: string };

interface VerifiedFileState {
  readonly day: string;
  readonly checkpointGeneration: number;
  readonly sequence: number;
  readonly byteLength: number;
  readonly lastRowMac: string;
  readonly fingerprint: FileFingerprint | null;
}

function assertTime(at: number): void {
  if (!Number.isFinite(at) || at < 0) {
    throw new TypeError("rationale audit time must be finite and non-negative");
  }
}

function assertSessionId(sessionId: string): void {
  if (sessionId.trim() !== sessionId || !SAFE_SESSION_ID_RE.test(sessionId)) {
    throw new TypeError("invalid rationale audit session id");
  }
}

function dateFor(at: number): string {
  assertTime(at);
  return new Date(at).toISOString().slice(0, 10);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function safeEqualHex(left: string, right: string): boolean {
  if (!HMAC_RE.test(left) || !HMAC_RE.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function parseFingerprint(value: unknown): FileFingerprint | null {
  if (value === null) return null;
  if (!isPlainRecord(value) || !hasExactKeys(value, ["dev", "ino", "size", "mtimeNs", "ctimeNs"]) ||
      typeof value.dev !== "string" || typeof value.ino !== "string" ||
      !Number.isSafeInteger(value.size) || (value.size as number) < 0 ||
      typeof value.mtimeNs !== "string" || typeof value.ctimeNs !== "string") {
    throw new Error("invalid rationale audit checkpoint fingerprint");
  }
  return { dev: value.dev, ino: value.ino, size: value.size as number,
    mtimeNs: value.mtimeNs, ctimeNs: value.ctimeNs };
}

function checkpointName(day: string, slot: CheckpointSlot): string {
  if (!DATE_RE.test(day)) throw new Error("invalid rationale audit checkpoint day");
  return `${CHECKPOINT_NAME_PREFIX}${day}-${slot}`;
}

function sealCheckpoint(secret: string, value: AuditCheckpointUnsigned): AuditCheckpoint {
  return { ...value, seal: computeLineHmac(secret, JSON.stringify(value)) };
}

function parseCheckpoint(raw: string, day: string, slot: CheckpointSlot, secret: string): AuditCheckpoint {
  let value: unknown;
  try { value = JSON.parse(raw); } catch (cause) {
    throw new Error("invalid rationale audit checkpoint encoding", { cause });
  }
  if (!isPlainRecord(value) || !hasExactKeys(value, ["schemaVersion", "kind", "day", "slot",
    "generation", "sequence", "byteLength", "lastRowMac", "fingerprint", "seal"]) ||
      value.schemaVersion !== CHECKPOINT_SCHEMA_VERSION || value.kind !== CHECKPOINT_KIND ||
      value.day !== day || value.slot !== slot || !Number.isSafeInteger(value.generation) ||
      (value.generation as number) < 0 || !Number.isSafeInteger(value.sequence) ||
      (value.sequence as number) < 0 || !Number.isSafeInteger(value.byteLength) ||
      (value.byteLength as number) < 0 || typeof value.lastRowMac !== "string" ||
      !HMAC_RE.test(value.lastRowMac) || typeof value.seal !== "string" || !HMAC_RE.test(value.seal)) {
    throw new Error("invalid rationale audit checkpoint");
  }
  const unsigned: AuditCheckpointUnsigned = {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    kind: CHECKPOINT_KIND,
    day,
    slot,
    generation: value.generation as number,
    sequence: value.sequence as number,
    byteLength: value.byteLength as number,
    lastRowMac: value.lastRowMac,
    fingerprint: parseFingerprint(value.fingerprint),
  };
  if (!safeEqualHex(value.seal, computeLineHmac(secret, JSON.stringify(unsigned)))) {
    throw new Error("rationale audit checkpoint seal mismatch");
  }
  return { ...unsigned, seal: value.seal };
}

function fingerprintAuditFile(filePath: string): FileFingerprint | null {
  if (!existsSync(filePath)) return null;
  let stats = statSync(filePath, { bigint: true });
  if (!stats.isFile()) throw new Error("rationale audit path is not a regular file");
  if (platform !== "win32") {
    chmodSync(filePath, 0o600);
    stats = statSync(filePath, { bigint: true });
  }
  const size = Number(stats.size);
  if (!Number.isSafeInteger(size)) throw new Error("rationale audit file is too large");
  return { dev: stats.dev.toString(), ino: stats.ino.toString(), size,
    mtimeNs: stats.mtimeNs.toString(), ctimeNs: stats.ctimeNs.toString() };
}

function sameFingerprint(left: FileFingerprint | null, right: FileFingerprint | null): boolean {
  if (left === null || right === null) return left === right;
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function sameFileIdentity(left: FileFingerprint | null, right: FileFingerprint | null): boolean {
  return left !== null && right !== null && left.dev === right.dev && left.ino === right.ino;
}

function rowUnsigned(entry: RationaleAuditEntry): Record<string, unknown> {
  const { rowMac: _rowMac, ...unsigned } = entry;
  return unsigned;
}

function validateRow(line: string, day: string, sequence: number, previousMac: string,
  secret: string): RationaleAuditEntry {
  if (line.length === 0 || line.endsWith("\r") ||
      Buffer.byteLength(line, "utf8") + 1 > RATIONALE_AUDIT_MAX_LINE_BYTES) {
    throw new Error("invalid rationale audit row framing");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(line); } catch (cause) {
    throw new Error("invalid rationale audit row encoding", { cause });
  }
  if (!isPlainRecord(parsed) || JSON.stringify(parsed) !== line ||
      parsed.schemaVersion !== RATIONALE_AUDIT_SCHEMA_VERSION ||
      (parsed.kind !== "rationale-ticket-lifecycle" &&
        parsed.kind !== "rationale-invocation-lifecycle" &&
        parsed.kind !== "rationale-ui-projection") ||
      !hasExactKeys(parsed, ["schemaVersion", "auditId", "kind", "sessionId", "at",
        parsed.kind === "rationale-ticket-lifecycle"
          ? "event"
          : parsed.kind === "rationale-invocation-lifecycle"
            ? "record"
            : "projection",
        "prevHash", "sequence", "rowMac"]) ||
      typeof parsed.auditId !== "string" || typeof parsed.sessionId !== "string" ||
      typeof parsed.at !== "number" || parsed.sequence !== sequence ||
      typeof parsed.prevHash !== "string" || !safeEqualHex(parsed.prevHash, previousMac) ||
      typeof parsed.rowMac !== "string" || !HMAC_RE.test(parsed.rowMac)) {
    throw new Error("invalid rationale audit row envelope");
  }
  assertSessionId(parsed.sessionId);
  assertTime(parsed.at);
  if (dateFor(parsed.at) !== day) throw new Error("rationale audit row is under the wrong UTC day");
  if (parsed.kind === "rationale-ticket-lifecycle") {
    assertRationaleCanonicalJson(parsed.event, "RationaleTicketStoreAuditEvent");
    const event = parsed.event as Partial<RationaleTicketStoreAuditEvent>;
    if (event.kind !== "host-rationale-ticket-store-audit" ||
        event.sessionId !== parsed.sessionId || event.at !== parsed.at) {
      throw new Error("invalid rationale ticket audit payload");
    }
  } else if (parsed.kind === "rationale-invocation-lifecycle") {
    validateInvocationAuditRecord(parsed.record as InvocationAuditRecord);
  } else if (!validateRationaleUiAuditProjection(parsed.projection)) {
    throw new Error("invalid rationale UI projection audit payload");
  }
  const entry = parsed as unknown as RationaleAuditEntry;
  const expectedMac = computeLineHmac(secret, JSON.stringify(rowUnsigned(entry)));
  if (!safeEqualHex(entry.rowMac, expectedMac)) throw new Error("rationale audit row MAC mismatch");
  return entry;
}

function closeFd(fd: number, priorError: unknown): void {
  try {
    closeSync(fd);
  } catch (closeError) {
    if (priorError !== undefined) {
      throw new AggregateError(
        [priorError, closeError],
        "rationale audit operation and descriptor close both failed",
      );
    }
    throw closeError;
  }
}

function syncDirectory(auditDir: string): void {
  if (platform === "win32") return;
  let fd: number | undefined;
  let error: unknown;
  try {
    fd = openSync(auditDir, "r");
    fsyncSync(fd);
  } catch (cause) {
    error = cause;
    throw cause;
  } finally {
    if (fd !== undefined) closeFd(fd, error);
  }
}

function ensurePrivateDirectory(auditDir: string): void {
  mkdirSync(auditDir, { recursive: true, mode: 0o700 });
  if (platform !== "win32") chmodSync(auditDir, 0o700);
}

function withAppendFd(filePath: string, action: (fd: number) => void): void {
  let fd: number | undefined;
  let error: unknown;
  try {
    fd = openSync(filePath, "a", 0o600);
    if (platform !== "win32") chmodSync(filePath, 0o600);
    action(fd);
  } catch (cause) {
    error = cause;
    throw cause;
  } finally {
    if (fd !== undefined) closeFd(fd, error);
  }
}

function ensureAppendTarget(filePath: string, auditDir: string): void {
  ensurePrivateDirectory(auditDir);
  const existed = existsSync(filePath);
  withAppendFd(filePath, (fd) => fsyncSync(fd));
  if (!existed) syncDirectory(auditDir);
}

function appendDurably(filePath: string, auditDir: string, line: string): void {
  ensurePrivateDirectory(auditDir);
  const existed = existsSync(filePath);
  withAppendFd(filePath, (fd) => {
    writeFileSync(fd, line + "\n", { encoding: "utf8" });
    fsyncSync(fd);
  });
  if (!existed) syncDirectory(auditDir);
}

function readRange(filePath: string, offset: number, length: number): Buffer {
  const buffer = Buffer.allocUnsafe(length);
  let fd: number | undefined;
  let error: unknown;
  try {
    fd = openSync(filePath, "r");
    let completed = 0;
    while (completed < length) {
      const count = readSync(fd, buffer, completed, length - completed, offset + completed);
      if (count === 0) throw new Error("rationale audit file changed while read");
      completed += count;
    }
    return buffer;
  } catch (cause) {
    error = cause;
    throw cause;
  } finally {
    if (fd !== undefined) closeFd(fd, error);
  }
}

function isLockContention(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && "code" in cause &&
    (cause as { code?: unknown }).code === "ELOCKED";
}

function withDayLock<T>(filePath: string, auditDir: string, retries: number, action: () => T): T {
  const target = `${filePath}.lock-target`;
  ensurePrivateDirectory(auditDir);
  const existed = existsSync(target);
  withAppendFd(target, (fd) => fsyncSync(fd));
  if (!existed) syncDirectory(auditDir);

  let release: (() => void) | undefined;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      release = lockfile.lockSync(target, {
        realpath: false,
        stale: LOCK_STALE_MS,
        update: LOCK_STALE_MS / 3,
      });
      break;
    } catch (cause) {
      lastError = cause;
      if (!isLockContention(cause) || attempt === retries) break;
      Atomics.wait(LOCK_SLEEP_CELL, 0, 0, LOCK_RETRY_DELAY_MS);
    }
  }
  if (release === undefined) {
    if (isLockContention(lastError)) throw new RationaleAuditLockBusyError(lastError);
    throw lastError;
  }
  let operationError: unknown;
  try {
    if (platform !== "win32") chmodSync(`${target}.lock`, 0o700);
    return action();
  } catch (cause) {
    operationError = cause;
    throw cause;
  } finally {
    try {
      release();
    } catch (releaseError) {
      if (operationError !== undefined) {
        throw new AggregateError([operationError, releaseError],
          "rationale audit operation and lock release both failed");
      }
      throw releaseError;
    }
  }
}

/**
 * Sync+fsync rationale authority log with per-row MACs and alternating sealed
 * per-day checkpoints. A checkpoint may lag after a crash; a complete,
 * contiguous authenticated suffix is recovered under the same day lock.
 * Partial/invalid suffixes and rollback fail closed. Daily files never
 * auto-delete; hard byte/row ceilings bound active-file growth.
 */
export class DurableRationaleAuditAdapter implements RationaleAuditSink {
  readonly #auditDir: string;
  readonly #secret: string;
  readonly #checkpointSecret: string;
  readonly #sealStore: SecretStore;
  readonly #now: () => number;
  readonly #maxBytesPerDay: number;
  readonly #maxLinesPerDay: number;
  readonly #lockRetries: number;
  readonly #verifiedByDay = new Map<string, VerifiedFileState>();
  #lastDay: string | null = null;
  #poisoned: unknown | null = null;

  constructor(options: DurableRationaleAuditAdapterOptions) {
    if (!isAbsolute(options.auditDir)) {
      throw new TypeError("rationale audit directory must be absolute");
    }
    if (typeof options.auditSecret !== "string" || options.auditSecret.length < 32) {
      throw new TypeError("rationale audit secret is unavailable or too short");
    }
    if (!options.sealStore || typeof options.sealStore.read !== "function" ||
        typeof options.sealStore.write !== "function") {
      throw new TypeError("rationale audit seal store is unavailable");
    }
    const maxBytes = options.maxBytesPerDay ?? RATIONALE_AUDIT_MAX_DAILY_BYTES;
    const maxLines = options.maxLinesPerDay ?? RATIONALE_AUDIT_MAX_DAILY_LINES;
    const lockRetries = options.lockRetries ?? DEFAULT_LOCK_RETRIES;
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 ||
        !Number.isSafeInteger(maxLines) || maxLines <= 0 ||
        !Number.isSafeInteger(lockRetries) || lockRetries < 0 || lockRetries > 10) {
      throw new TypeError("invalid rationale audit durability limits");
    }
    this.#auditDir = options.auditDir;
    this.#secret = computeLineHmac(options.auditSecret, KEY_DOMAIN);
    this.#checkpointSecret = computeLineHmac(options.auditSecret, CHECKPOINT_KEY_DOMAIN);
    this.#sealStore = options.sealStore;
    this.#now = options.now ?? Date.now;
    this.#maxBytesPerDay = maxBytes;
    this.#maxLinesPerDay = maxLines;
    this.#lockRetries = lockRetries;
  }

  getLogFile(at = this.#now()): string {
    return join(this.#auditDir, dateFor(at) + ".rationale-audit.ndjson");
  }

  assertWritable(at = this.#now()): void {
    this.#assertHealthy();
    const day = dateFor(at);
    const filePath = this.getLogFile(at);
    this.#runStorageOperation("rationale audit preflight failed", () =>
      withDayLock(filePath, this.#auditDir, this.#lockRetries, () => {
        let state = this.#loadState(day, filePath);
        if (state.fingerprint === null) {
          ensureAppendTarget(filePath, this.#auditDir);
          state = { ...state, fingerprint: fingerprintAuditFile(filePath) };
          this.#verifiedByDay.set(day, state);
        }
        if (state.sequence >= this.#maxLinesPerDay || state.byteLength >= this.#maxBytesPerDay) {
          throw new Error("rationale audit daily retention ceiling reached");
        }
      }),
    );
  }

  appendTicket(event: RationaleTicketStoreAuditEvent): RationaleTicketAuditEntry {
    assertRationaleCanonicalJson(event, "RationaleTicketStoreAuditEvent");
    if (event.kind !== "host-rationale-ticket-store-audit") {
      throw new TypeError("invalid rationale ticket audit event kind");
    }
    assertSessionId(event.sessionId);
    assertTime(event.at);
    return this.#append({
      schemaVersion: RATIONALE_AUDIT_SCHEMA_VERSION,
      auditId: randomUUID(),
      kind: "rationale-ticket-lifecycle",
      sessionId: event.sessionId,
      at: event.at,
      event,
    }) as RationaleTicketAuditEntry;
  }

  appendInvocation(
    sessionId: string,
    record: InvocationAuditRecord,
  ): RationaleInvocationAuditEntry {
    assertSessionId(sessionId);
    validateInvocationAuditRecord(record);
    const at = this.#now();
    assertTime(at);
    return this.#append({
      schemaVersion: RATIONALE_AUDIT_SCHEMA_VERSION,
      auditId: randomUUID(),
      kind: "rationale-invocation-lifecycle",
      sessionId,
      at,
      record,
    }) as RationaleInvocationAuditEntry;
  }

  appendProjection(
    sessionId: string,
    projection: RationaleUiAuditProjection,
    at: number,
  ): RationaleProjectionAuditEntry {
    assertSessionId(sessionId);
    if (!validateRationaleUiAuditProjection(projection)) {
      throw new TypeError("invalid rationale UI projection");
    }
    assertTime(at);
    return this.#append({
      schemaVersion: RATIONALE_AUDIT_SCHEMA_VERSION,
      auditId: randomUUID(),
      kind: "rationale-ui-projection",
      sessionId,
      at,
      projection,
    }) as RationaleProjectionAuditEntry;
  }

  #append(input: RationaleAuditEntryInput): RationaleAuditEntry {
    this.#assertHealthy();
    const day = dateFor(input.at);
    const filePath = this.getLogFile(input.at);
    return this.#runStorageOperation("rationale audit durable append failed", () =>
      withDayLock(filePath, this.#auditDir, this.#lockRetries, () => {
        let previous = this.#loadState(day, filePath);
        if (previous.fingerprint === null) {
          ensureAppendTarget(filePath, this.#auditDir);
          previous = { ...previous, fingerprint: fingerprintAuditFile(filePath) };
          this.#verifiedByDay.set(day, previous);
        }
        const sequence = previous.sequence + 1;
        const unsigned = { ...input, prevHash: previous.lastRowMac, sequence };
        const rowMac = computeLineHmac(this.#secret, JSON.stringify(unsigned));
        const entry = { ...unsigned, rowMac } as RationaleAuditEntry;
        const serialized = JSON.stringify(entry);
        const lineBytes = Buffer.byteLength(serialized, "utf8") + 1;
        const nextBytes = previous.byteLength + lineBytes;
        if (lineBytes > RATIONALE_AUDIT_MAX_LINE_BYTES ||
            sequence > this.#maxLinesPerDay || nextBytes > this.#maxBytesPerDay) {
          throw new Error("rationale audit daily retention ceiling reached");
        }

        appendDurably(filePath, this.#auditDir, serialized);
        const fingerprint = fingerprintAuditFile(filePath);
        if (fingerprint === null || fingerprint.size !== nextBytes ||
            !sameFileIdentity(previous.fingerprint, fingerprint) ||
            !readRange(filePath, previous.byteLength, lineBytes).equals(
              Buffer.from(`${serialized}\n`, "utf8"))) {
          throw new Error("rationale audit append did not produce the expected durable row");
        }
        let next: VerifiedFileState = {
          day,
          checkpointGeneration: previous.checkpointGeneration,
          sequence,
          byteLength: nextBytes,
          lastRowMac: rowMac,
          fingerprint,
        };
        next = this.#advanceCheckpoint(next);
        this.#verifiedByDay.set(day, next);
        return Object.freeze(entry);
      }),
    );
  }

  #readCheckpoint(day: string, filePath: string): AuditCheckpoint {
    const candidates: AuditCheckpoint[] = [];
    let storedSlots = 0;
    for (const slot of ["a", "b"] as const) {
      const raw = this.#sealStore.read(checkpointName(day, slot));
      if (raw === null) continue;
      storedSlots += 1;
      // SecretStore replacement is atomic. A present-but-invalid slot is
      // therefore evidence of corruption/tamper, not a recoverable torn write.
      candidates.push(parseCheckpoint(raw, day, slot, this.#checkpointSecret));
    }
    if (candidates.length === 0) {
      if (storedSlots !== 0 || existsSync(filePath)) {
        throw new Error("rationale audit checkpoint is absent for an existing day");
      }
      const checkpoint = sealCheckpoint(this.#checkpointSecret, {
        schemaVersion: CHECKPOINT_SCHEMA_VERSION,
        kind: CHECKPOINT_KIND,
        day,
        slot: "a",
        generation: 0,
        sequence: 0,
        byteLength: 0,
        lastRowMac: computeLineHmac(this.#secret, GENESIS_MARKER),
        fingerprint: null,
      });
      this.#sealStore.write(checkpointName(day, "a"), JSON.stringify(checkpoint));
      return checkpoint;
    }
    candidates.sort((left, right) => right.generation - left.generation);
    if (candidates.length > 1 && candidates[0]!.generation === candidates[1]!.generation) {
      throw new Error("rationale audit checkpoint generations conflict");
    }
    const checkpoint = candidates[0]!;
    if (checkpoint.slot !== (checkpoint.generation % 2 === 0 ? "a" : "b") ||
        checkpoint.sequence > this.#maxLinesPerDay ||
        checkpoint.byteLength > this.#maxBytesPerDay ||
        (checkpoint.fingerprint !== null && checkpoint.fingerprint.size !== checkpoint.byteLength)) {
      throw new Error("rationale audit checkpoint is outside durability bounds");
    }
    const genesisMac = computeLineHmac(this.#secret, GENESIS_MARKER);
    if (checkpoint.sequence === 0) {
      if (checkpoint.byteLength !== 0 || !safeEqualHex(checkpoint.lastRowMac, genesisMac)) {
        throw new Error("invalid rationale audit genesis checkpoint");
      }
    } else if (checkpoint.byteLength === 0 || checkpoint.fingerprint === null) {
      throw new Error("invalid rationale audit non-genesis checkpoint");
    }
    return checkpoint;
  }

  #loadState(day: string, filePath: string): VerifiedFileState {
    if (this.#lastDay !== day) {
      this.#verifiedByDay.delete(day);
      this.#lastDay = day;
    }
    const checkpoint = this.#readCheckpoint(day, filePath);
    const fingerprint = fingerprintAuditFile(filePath);
    if (fingerprint === null) {
      if (checkpoint.sequence !== 0 || checkpoint.byteLength !== 0 ||
          checkpoint.fingerprint !== null) {
        throw new Error("rationale audit file is missing behind its checkpoint");
      }
      const state: VerifiedFileState = {
        day,
        checkpointGeneration: checkpoint.generation,
        sequence: 0,
        byteLength: 0,
        lastRowMac: checkpoint.lastRowMac,
        fingerprint: null,
      };
      this.#verifiedByDay.set(day, state);
      return state;
    }
    if (fingerprint.size < checkpoint.byteLength) {
      throw new Error("rationale audit complete-line rollback detected");
    }
    if (fingerprint.size > this.#maxBytesPerDay) {
      throw new Error("rationale audit daily byte ceiling exceeded");
    }

    const cached = this.#verifiedByDay.get(day);
    if (cached !== undefined && cached.checkpointGeneration === checkpoint.generation &&
        cached.sequence === checkpoint.sequence && cached.byteLength === checkpoint.byteLength &&
        safeEqualHex(cached.lastRowMac, checkpoint.lastRowMac) &&
        sameFingerprint(cached.fingerprint, fingerprint) &&
        sameFingerprint(checkpoint.fingerprint, fingerprint)) {
      return cached;
    }

    let verified: VerifiedFileState;
    if (cached !== undefined && checkpoint.generation > cached.checkpointGeneration &&
        checkpoint.sequence >= cached.sequence && checkpoint.byteLength >= cached.byteLength &&
        fingerprint.size === checkpoint.byteLength &&
        sameFileIdentity(cached.fingerprint, fingerprint) &&
        sameFingerprint(checkpoint.fingerprint, fingerprint)) {
      verified = this.#verifyFrom(filePath, checkpoint, cached, fingerprint);
    } else {
      verified = this.#verifyFrom(filePath, checkpoint, {
        day,
        checkpointGeneration: checkpoint.generation,
        sequence: 0,
        byteLength: 0,
        lastRowMac: computeLineHmac(this.#secret, GENESIS_MARKER),
        fingerprint,
      }, fingerprint);
    }

    if (verified.sequence !== checkpoint.sequence ||
        verified.byteLength !== checkpoint.byteLength ||
        !safeEqualHex(verified.lastRowMac, checkpoint.lastRowMac) ||
        !sameFingerprint(verified.fingerprint, checkpoint.fingerprint)) {
      verified = this.#advanceCheckpoint(verified);
    }
    this.#verifiedByDay.set(day, verified);
    return verified;
  }

  #verifyFrom(filePath: string, checkpoint: AuditCheckpoint, base: VerifiedFileState,
    fingerprint: FileFingerprint): VerifiedFileState {
    if (fingerprint.size < base.byteLength) {
      throw new Error("rationale audit file is shorter than its verified prefix");
    }
    let sequence = base.sequence;
    let byteLength = base.byteLength;
    let lastRowMac = base.lastRowMac;
    let checkpointMatched = sequence === checkpoint.sequence &&
      byteLength === checkpoint.byteLength && safeEqualHex(lastRowMac, checkpoint.lastRowMac);
    const suffixLength = fingerprint.size - base.byteLength;
    if (suffixLength > 0) {
      const suffix = readRange(filePath, base.byteLength, suffixLength);
      if (suffix.at(-1) !== 0x0a) throw new Error("rationale audit file has an unterminated tail");
      const text = suffix.toString("utf8");
      if (!Buffer.from(text, "utf8").equals(suffix)) {
        throw new Error("rationale audit file is not valid UTF-8");
      }
      const lines = text.slice(0, -1).split("\n");
      if (sequence + lines.length > this.#maxLinesPerDay) {
        throw new Error("rationale audit daily row ceiling exceeded");
      }
      for (const line of lines) {
        const row = validateRow(line, checkpoint.day, sequence + 1, lastRowMac, this.#secret);
        sequence += 1;
        byteLength += Buffer.byteLength(line, "utf8") + 1;
        lastRowMac = row.rowMac;
        if (sequence === checkpoint.sequence) {
          if (byteLength !== checkpoint.byteLength ||
              !safeEqualHex(lastRowMac, checkpoint.lastRowMac)) {
            throw new Error("rationale audit checkpoint does not anchor its file prefix");
          }
          checkpointMatched = true;
        } else if (!checkpointMatched && sequence > checkpoint.sequence) {
          throw new Error("rationale audit checkpoint boundary was skipped");
        }
      }
    }
    if (!checkpointMatched || byteLength !== fingerprint.size) {
      throw new Error("rationale audit checkpoint/file boundary mismatch");
    }
    return {
      day: checkpoint.day,
      checkpointGeneration: checkpoint.generation,
      sequence,
      byteLength,
      lastRowMac,
      fingerprint,
    };
  }

  #advanceCheckpoint(state: VerifiedFileState): VerifiedFileState {
    const generation = state.checkpointGeneration + 1;
    if (!Number.isSafeInteger(generation)) {
      throw new Error("rationale audit checkpoint generation exhausted");
    }
    const slot: CheckpointSlot = generation % 2 === 0 ? "a" : "b";
    const checkpoint = sealCheckpoint(this.#checkpointSecret, {
      schemaVersion: CHECKPOINT_SCHEMA_VERSION,
      kind: CHECKPOINT_KIND,
      day: state.day,
      slot,
      generation,
      sequence: state.sequence,
      byteLength: state.byteLength,
      lastRowMac: state.lastRowMac,
      fingerprint: state.fingerprint,
    });
    this.#sealStore.write(checkpointName(state.day, slot), JSON.stringify(checkpoint));
    return { ...state, checkpointGeneration: generation };
  }

  #runStorageOperation<T>(message: string, action: () => T): T {
    try {
      return action();
    } catch (cause) {
      if (cause instanceof RationaleAuditLockBusyError) {
        throw new RationaleAuditUnavailableError(
          "rationale audit is temporarily unavailable while another process commits",
          { cause },
        );
      }
      this.#poison(cause, message);
    }
  }

  #assertHealthy(): void {
    if (this.#poisoned !== null) {
      throw new RationaleAuditUnavailableError(
        "rationale audit adapter is poisoned after an earlier storage failure",
        { cause: this.#poisoned },
      );
    }
  }

  #poison(cause: unknown, message: string): never {
    this.#poisoned = cause;
    throw new RationaleAuditUnavailableError(message, { cause });
  }
}
