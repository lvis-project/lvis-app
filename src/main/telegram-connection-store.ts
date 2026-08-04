/**
 * Durable owner-side state for the Telegram private-DM bridge.
 *
 * Telegram is an external cloud recipient, so this file is deliberately poor in
 * identity. It persists opaque digests and opaque ids only: the bot token, the
 * webhook secret, the bot handle, raw Telegram user/chat ids, message text, and
 * the raw pairing code are never written here.
 *
 * The one plaintext exception is the host's own conversation id, which is local
 * and never leaves this desktop. It is stored so the share survives a restart —
 * the whole point of the feature is that the owner walked away — but it is a
 * routing hint, never an authorization key. Every read re-derives its digest and
 * discards the record unless the two agree, so editing the file by hand yields
 * no approval rather than a re-pointed one.
 *
 * Pairing identifies one Telegram account and grants nothing on its own.
 * Sharing the open conversation is a separate, explicitly gestured owner action
 * recorded as an approval bound to the pairing epoch it was minted under, so a
 * revoke or a re-pair makes every earlier approval unresolvable.
 *
 * Structurally this mirrors `tailnet-pairing-share-store.ts` (validate on read
 * and on persist, lazy prune before every mutation, monotonic epochs, atomic
 * write through the feature namespace) but stays a separate owner: the Tailnet
 * store's actor grammar is `tailnet:<hex>` and its persist re-validates, so a
 * Telegram actor stored there would reject the whole Tailnet document.
 */
import { randomUUID as nodeRandomUuid, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  TELEGRAM_PAIRING_CODE_TTL_MS,
  isTelegramConnectionErrorCode,
  isTelegramConnectionId,
  isTelegramConversationId,
  type TelegramConnectionErrorCode,
} from "../shared/telegram-connection.js";
import {
  openFeatureNamespace,
  type FeatureNamespaceHandle,
} from "./storage/feature-namespace.js";

const STORE_VERSION = 1;
/** Same namespace the bridge already uses for `command-receipts.json`. */
const TELEGRAM_BRIDGE_FEATURE = "telegram-bridge";
const DEFAULT_FILE_NAME = "connection.json";
const DEFAULT_PENDING_CODE_ATTEMPTS = 5;
const MAX_PENDING_CODE_ATTEMPTS = 16;
const MAX_PENDING_CODE_TTL_MS = 60 * 60 * 1_000;
const DEFAULT_APPROVAL_TTL_MS = 8 * 60 * 60 * 1_000;
const MAX_APPROVAL_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_APPROVALS = 32;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const FILE_NAME = /^[a-z0-9][a-z0-9._-]{0,127}\.json$/i;
const ACCOUNT_FINGERPRINT_CHARS = 12;

export type TelegramDesiredState = "disconnected" | "connected" | "paused";

/** A minted-but-unredeemed pairing code, described without its secret. */
interface TelegramPendingCodeRecord {
  readonly id: string;
  readonly expiresAt: number;
  readonly attemptsRemaining: number;
}

interface TelegramPairingRecord {
  readonly id: string;
  readonly actorDigest: string;
  readonly epoch: number;
  readonly createdAt: number;
}

/**
 * What an egress fence needs to decide that one inbound actor may act on one
 * conversation right now. `scope` names this exact approval generation.
 */
interface TelegramApprovalAuthority {
  readonly approvalId: string;
  readonly approvalEpoch: number;
  readonly pairingId: string;
  readonly pairingEpoch: number;
  readonly actorDigest: string;
  readonly conversationDigest: string;
  readonly scope: string;
  readonly expiresAt: number;
}

interface TelegramOwnerPairingSummary {
  readonly id: string;
  /** Shortened local digest. Never a Telegram user id or a bot handle. */
  readonly accountFingerprint: string;
}

export interface TelegramOwnerApprovalSummary {
  readonly id: string;
  readonly expiresAt: number;
  /**
   * Main-process-only. The renderer contract carries a boolean
   * `matchesCurrentConversation` instead; never forward this field to a
   * renderer snapshot.
   */
  readonly conversationDigest: string;
}

/**
 * Durable projection the owner surface builds its renderer snapshot from. It
 * reports only what survived the lazy prune, so an expired approval or code is
 * never visible here.
 */
export interface TelegramOwnerConnectionSnapshot {
  readonly desiredState: TelegramDesiredState;
  readonly activationEpoch: number;
  readonly botFingerprint: string | null;
  readonly pairing: TelegramOwnerPairingSummary | null;
  /** The one shared conversation, or null when nothing is shared. */
  readonly approval: TelegramOwnerApprovalSummary | null;
  readonly pendingCode: TelegramPendingCodeRecord | null;
  readonly lastErrorCode: TelegramConnectionErrorCode | null;
}

export interface CreateTelegramConnectionStoreOptions {
  readonly namespace?: FeatureNamespaceHandle;
  readonly fileName?: string;
  readonly now?: () => number;
  readonly randomUuid?: () => string;
  /**
   * Re-derive the digest a conversation's approval must be stored under.
   *
   * Required, and injected rather than imported: this store must not depend on
   * the platform runtime's hashing, and a default would be a fallback path that
   * silently decides authorization. Verifying the stored plaintext needs the
   * derivation at READ time, which a store-and-compare-on-write design cannot
   * do — nothing to compare a hand-edited file against — so the function itself
   * has to be here.
   *
   * It takes the bot fingerprint rather than closing over one because an
   * approval is bot-scoped and the store already holds the current fingerprint:
   * a captured one would have to be rebuilt on every reconnect.
   */
  readonly conversationDigestFor: (botFingerprint: string, conversationId: string) => string;
}

interface CreateTelegramPendingCodeInput {
  /** Digest of the raw code. The raw code never reaches this store. */
  readonly codeDigest: string;
  readonly ttlMs?: number;
  readonly maxAttempts?: number;
}

interface CompleteTelegramPairingInput {
  readonly codeDigest: string;
  readonly actorDigest: string;
}

interface CreateTelegramApprovalInput {
  /** Local, never provider-visible. Persisted so the share survives a restart. */
  readonly conversationId: string;
  /**
   * The caller's own derivation of the same conversation. Supplying both lets
   * this store reject a grant whose two derivations disagree, which would
   * otherwise be written once and be unresolvable forever after.
   */
  readonly conversationDigest: string;
  readonly ttlMs?: number;
}

export interface TelegramConnectionStore {
  /** Load durable state. A corrupt file fails closed to a disconnected store. */
  open(): Promise<void>;
  subscribe(listener: () => void): () => void;

  ownerSnapshot(): TelegramOwnerConnectionSnapshot;
  receiptOwnerId(): string;
  activationEpoch(): number;
  desiredState(): TelegramDesiredState;
  botFingerprint(): string | null;
  /**
   * Full opaque digest of the paired account, for the egress authority only.
   * `ownerSnapshot()` deliberately carries the shortened fingerprint instead,
   * because that one is projected to a renderer.
   */
  activePairingActorDigest(): string | null;
  pollOffset(): number | null;

  setConnected(botFingerprint: string): Promise<void>;
  /** No-op returning false unless the bridge is currently connected. */
  setPaused(): Promise<boolean>;
  setDisconnected(): Promise<void>;
  recordPollOffset(offset: number): Promise<void>;
  setLastError(code: TelegramConnectionErrorCode | null): Promise<void>;

  createPendingCode(input: CreateTelegramPendingCodeInput): Promise<TelegramPendingCodeRecord>;
  /** Charge one attempt for a candidate rejected before digest comparison. */
  consumePendingCodeAttempt(): Promise<TelegramPendingCodeRecord | null>;
  completePairing(input: CompleteTelegramPairingInput): Promise<TelegramPairingRecord | null>;
  revokePairing(id: string): Promise<boolean>;

  createApproval(input: CreateTelegramApprovalInput): Promise<TelegramApprovalAuthority | null>;
  revokeApproval(id: string): Promise<boolean>;
  /**
   * Synchronous in-memory egress fence. It never awaits, never persists, and
   * never throws: an unusable store answers "no authority".
   */
  resolveActiveApproval(
    actorDigest: string,
    conversationDigest: string,
  ): TelegramApprovalAuthority | null;
  /**
   * The conversation this actor's live share is bound to, in plaintext, or null.
   *
   * This is the durable binding: it answers the same after a restart, which is
   * what stops the surface from following whichever conversation the owner
   * happens to have open. It grants nothing — the caller still has to clear
   * {@link TelegramConnectionStore.resolveActiveApproval} on the digest, which
   * remains the sole authorization key.
   */
  resolveBoundConversation(actorDigest: string): string | null;
}

interface StoredPendingCode {
  readonly id: string;
  readonly codeDigest: string;
  readonly expiresAt: number;
  readonly attemptsRemaining: number;
}

interface StoredPairing {
  readonly id: string;
  readonly actorDigest: string;
  readonly state: "active" | "revoked";
  readonly epoch: number;
  readonly createdAt: number;
}

interface StoredApproval {
  readonly id: string;
  readonly pairingId: string;
  readonly pairingEpoch: number;
  /** Tamper-evident routing hint; worthless unless it re-hashes to the digest. */
  readonly conversationId: string;
  readonly conversationDigest: string;
  readonly scope: string;
  readonly state: "active" | "revoked" | "expired";
  readonly epoch: number;
  readonly createdAt: number;
  readonly expiresAt: number;
}

interface StoreDocument {
  readonly version: typeof STORE_VERSION;
  readonly receiptOwnerId: string;
  readonly activationEpoch: number;
  readonly desiredState: TelegramDesiredState;
  readonly botFingerprint: string | null;
  readonly pollOffset: number | null;
  readonly pendingCode: StoredPendingCode | null;
  readonly pairing: StoredPairing | null;
  readonly approvals: readonly StoredApproval[];
  readonly lastErrorCode: TelegramConnectionErrorCode | null;
}

type ChangeListener = () => void;

function invalid(): Error {
  return new Error("telegram-connection-store-invalid");
}

function inputInvalid(): Error {
  return new Error("telegram-connection-store-input-invalid");
}

function notOpen(): Error {
  return new Error("telegram-connection-store-not-open");
}

function capacity(): Error {
  return new Error("telegram-connection-store-capacity-reached");
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function timestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function counter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function epochValue(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function digest(value: unknown): value is string {
  return typeof value === "string" && SHA256_HEX.test(value);
}

function desiredState(value: unknown): value is TelegramDesiredState {
  return value === "disconnected" || value === "connected" || value === "paused";
}

/**
 * Compare two 32-byte digests without an early return on the first differing
 * byte. Shape rejection happens before the comparison and leaks nothing about
 * the stored digest: a value that is not 64 hex characters cannot be any
 * digest this store holds, so answering "no" from its length is not a secret-
 * dependent branch. Every accepted value decodes to exactly 32 bytes, so
 * `timingSafeEqual` never sees a length mismatch.
 */
function sameDigest(left: unknown, right: unknown): boolean {
  if (!digest(left) || !digest(right)) return false;
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

function validDuration(value: unknown, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function addDuration(now: number, duration: number): number {
  if (now > Number.MAX_SAFE_INTEGER - duration) throw invalid();
  return now + duration;
}

function nextEpoch(value: number): number {
  if (!epochValue(value) || value === Number.MAX_SAFE_INTEGER) throw invalid();
  return value + 1;
}

function validPendingCode(value: unknown): value is StoredPendingCode {
  return record(value)
    && exactKeys(value, ["id", "codeDigest", "expiresAt", "attemptsRemaining"])
    && isTelegramConnectionId(value.id)
    && digest(value.codeDigest)
    && timestamp(value.expiresAt)
    && typeof value.attemptsRemaining === "number"
    && Number.isSafeInteger(value.attemptsRemaining)
    // A budget of zero destroys the code, so a persisted zero is a bug, not a
    // state: validating it here makes the destroy-at-zero rule unskippable.
    && value.attemptsRemaining >= 1
    && value.attemptsRemaining <= MAX_PENDING_CODE_ATTEMPTS;
}

function validPairing(value: unknown): value is StoredPairing {
  return record(value)
    && exactKeys(value, ["id", "actorDigest", "state", "epoch", "createdAt"])
    && isTelegramConnectionId(value.id)
    && digest(value.actorDigest)
    && (value.state === "active" || value.state === "revoked")
    && epochValue(value.epoch)
    && timestamp(value.createdAt);
}

function validApproval(value: unknown): value is StoredApproval {
  return record(value)
    && exactKeys(value, [
      "id", "pairingId", "pairingEpoch", "conversationId", "conversationDigest", "scope",
      "state", "epoch", "createdAt", "expiresAt",
    ])
    && isTelegramConnectionId(value.id)
    && isTelegramConnectionId(value.pairingId)
    && epochValue(value.pairingEpoch)
    // Shape only. Whether this plaintext is the conversation the digest was
    // granted for is decided per read, against the current bot identity.
    && isTelegramConversationId(value.conversationId)
    && digest(value.conversationDigest)
    && isTelegramConnectionId(value.scope)
    && (value.state === "active" || value.state === "revoked" || value.state === "expired")
    && epochValue(value.epoch)
    && timestamp(value.createdAt)
    && timestamp(value.expiresAt)
    && value.expiresAt > value.createdAt;
}

/**
 * Shape and referential integrity only. Liveness (expiry, revocation, a
 * superseded pairing epoch) is owned by {@link prune} alone, so a document that
 * merely became stale is neutralized entry by entry instead of discarding the
 * whole connection.
 */
function validDocument(value: unknown): value is StoreDocument {
  if (
    !record(value)
    || !exactKeys(value, [
      "version", "receiptOwnerId", "activationEpoch", "desiredState", "botFingerprint",
      "pollOffset", "pendingCode", "pairing", "approvals", "lastErrorCode",
    ])
    || value.version !== STORE_VERSION
    || !isTelegramConnectionId(value.receiptOwnerId)
    || !epochValue(value.activationEpoch)
    || !desiredState(value.desiredState)
    || !(value.botFingerprint === null || digest(value.botFingerprint))
    || !(value.pollOffset === null || counter(value.pollOffset))
    || !(value.pendingCode === null || validPendingCode(value.pendingCode))
    || !(value.pairing === null || validPairing(value.pairing))
    || !Array.isArray(value.approvals)
    || value.approvals.length > MAX_APPROVALS
    || !value.approvals.every(validApproval)
    || !(value.lastErrorCode === null || isTelegramConnectionErrorCode(value.lastErrorCode))
    // Connected without a verified bot would let a snapshot claim an identity
    // the runtime cannot derive actor digests for.
    || (value.desiredState === "connected" && value.botFingerprint === null)
  ) {
    return false;
  }
  const pairingId = value.pairing === null ? null : (value.pairing as StoredPairing).id;
  const ids = new Set<string>();
  for (const approval of value.approvals as readonly StoredApproval[]) {
    if (ids.has(approval.id) || approval.pairingId !== pairingId) return false;
    ids.add(approval.id);
  }
  return true;
}

function initialDocument(receiptOwnerId: string): StoreDocument {
  return {
    version: STORE_VERSION,
    receiptOwnerId,
    activationEpoch: 1,
    desiredState: "disconnected",
    botFingerprint: null,
    pollOffset: null,
    pendingCode: null,
    pairing: null,
    approvals: [],
    lastErrorCode: null,
  };
}

/**
 * Sole authority on what is still live. Every read and every mutation goes
 * through it first, so nothing expired, revoked, orphaned, or minted under a
 * superseded pairing epoch is ever observable as active.
 */
function prune(
  document: StoreDocument,
  now: number,
): { readonly document: StoreDocument; readonly changed: boolean } {
  let changed = false;
  const pendingCode = document.pendingCode !== null
    && document.pendingCode.expiresAt > now
    && document.pendingCode.attemptsRemaining >= 1
    ? document.pendingCode
    : null;
  if (pendingCode !== document.pendingCode) changed = true;

  const pairing = document.pairing;
  const approvals: StoredApproval[] = [];
  for (const approval of document.approvals) {
    if (pairing === null || approval.pairingId !== pairing.id) {
      changed = true;
      continue;
    }
    const stale = approval.expiresAt <= now
      || pairing.state !== "active"
      || pairing.epoch !== approval.pairingEpoch;
    const entry: StoredApproval = approval.state === "active" && stale
      ? { ...approval, state: "expired", epoch: nextEpoch(approval.epoch) }
      : approval;
    if (entry !== approval) changed = true;
    // Terminal entries stay as tombstones until their original expiry so the
    // owner surface can still explain a just-revoked approval, then vanish.
    if (entry.state !== "active" && entry.expiresAt <= now) {
      changed = true;
      continue;
    }
    approvals.push(entry);
  }
  return {
    document: changed ? { ...document, pendingCode, approvals } : document,
    changed,
  };
}

/**
 * Which live grant is THE shared conversation, when a document somehow holds
 * more than one. `createApproval` retires every other live grant, so state this
 * store writes never produces a tie; a file written before that rule, or by
 * hand, still has to resolve deterministically. The newest wins, and both the
 * owner surface and `resolveBoundConversation` read it from here, so the screen
 * and the phone can never name different conversations.
 */
function newestApproval(approvals: readonly StoredApproval[]): StoredApproval | null {
  let newest: StoredApproval | null = null;
  for (const approval of approvals) {
    if (newest === null || approval.createdAt >= newest.createdAt) newest = approval;
  }
  return newest;
}

function authority(pairing: StoredPairing, approval: StoredApproval): TelegramApprovalAuthority {
  return Object.freeze({
    approvalId: approval.id,
    approvalEpoch: approval.epoch,
    pairingId: approval.pairingId,
    pairingEpoch: approval.pairingEpoch,
    actorDigest: pairing.actorDigest,
    conversationDigest: approval.conversationDigest,
    scope: approval.scope,
    expiresAt: approval.expiresAt,
  });
}

function pendingCodeRecord(value: StoredPendingCode): TelegramPendingCodeRecord {
  return Object.freeze({
    id: value.id,
    expiresAt: value.expiresAt,
    attemptsRemaining: value.attemptsRemaining,
  });
}

function pairingRecord(value: StoredPairing): TelegramPairingRecord {
  return Object.freeze({
    id: value.id,
    actorDigest: value.actorDigest,
    epoch: value.epoch,
    createdAt: value.createdAt,
  });
}

/**
 * Serialize mutations so a read-modify-write pair can never interleave with
 * another one and drop a persisted epoch bump.
 */
function createMutex(): <T>(work: () => Promise<T>) => Promise<T> {
  let tail: Promise<void> = Promise.resolve();
  return async <T>(work: () => Promise<T>): Promise<T> => {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  };
}

/**
 * Call `open()` before any read. State is held in memory so the egress fence
 * can resolve an approval synchronously.
 */
export function createTelegramConnectionStore(
  options: CreateTelegramConnectionStoreOptions,
): TelegramConnectionStore {
  const namespace = options.namespace ?? openFeatureNamespace(TELEGRAM_BRIDGE_FEATURE);
  const fileName = options.fileName ?? DEFAULT_FILE_NAME;
  const clock = options.now ?? Date.now;
  const randomUuid = options.randomUuid ?? nodeRandomUuid;
  const deriveConversationDigest = options.conversationDigestFor;
  const listeners = new Set<ChangeListener>();
  const runExclusive = createMutex();
  let document: StoreDocument | undefined;

  if (!FILE_NAME.test(fileName)) throw invalid();
  if (typeof deriveConversationDigest !== "function") throw invalid();

  const checkedNow = (): number => {
    const value = clock();
    if (!timestamp(value)) throw invalid();
    return value;
  };

  const nextUuid = (): string => {
    const value = randomUuid();
    if (!isTelegramConnectionId(value)) throw invalid();
    return value;
  };

  const requireDocument = (): StoreDocument => {
    if (document === undefined) throw notOpen();
    return document;
  };

  /** Pruned view for reads. Reads never persist; the next mutation converges. */
  const currentView = (): StoreDocument => prune(requireDocument(), checkedNow()).document;

  /** Null rather than a throw, so one bad derivation cannot break a read path. */
  const conversationDigestOf = (
    botFingerprint: string | null,
    conversationId: string,
  ): string | null => {
    if (botFingerprint === null || !isTelegramConversationId(conversationId)) return null;
    try {
      const derived = deriveConversationDigest(botFingerprint, conversationId);
      return digest(derived) ? derived : null;
    } catch {
      return null;
    }
  };

  /**
   * Active AND self-consistent. Sole reader of `state === "active"`, so a record
   * whose plaintext conversation id does not re-hash to its stored digest is not
   * an approval anywhere: not to the egress fence, not to the owner surface, and
   * not to the durable binding. Fail-closed on purpose — the digest is the
   * authorization key, and a plaintext that disagrees with it is evidence the
   * file was edited, not a hint worth following.
   *
   * The inconsistent record is left on disk untouched. Rewriting it here would
   * turn a read into a write and destroy the only evidence of the edit.
   */
  const liveApprovals = (value: StoreDocument): readonly StoredApproval[] =>
    value.approvals.filter((approval) => approval.state === "active"
      && sameDigest(
        conversationDigestOf(value.botFingerprint, approval.conversationId),
        approval.conversationDigest,
      ));

  const persist = async (value: StoreDocument): Promise<void> => {
    if (!validDocument(value)) throw invalid();
    try {
      await namespace.writeJson(fileName, value);
    } catch {
      throw invalid();
    }
  };

  const emitChange = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // A subscriber failure must not roll back already-persisted state.
      }
    }
  };

  const mutate = async <T>(
    operation: (current: StoreDocument, now: number) => {
      readonly document: StoreDocument;
      readonly value: T;
      readonly changed: boolean;
    },
  ): Promise<T> => await runExclusive(async () => {
    const now = checkedNow();
    const pruned = prune(requireDocument(), now);
    const outcome = operation(pruned.document, now);
    if (pruned.changed || outcome.changed) {
      await persist(outcome.document);
      document = outcome.document;
      emitChange();
    }
    return outcome.value;
  });

  const open = async (): Promise<void> => await runExclusive(async () => {
    if (document !== undefined) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(join(namespace.dir, fileName), "utf8")) as unknown;
    } catch {
      // Missing, unreadable, or non-JSON: the only safe reading of an
      // unreadable Telegram connection is that there is no connection. The
      // fresh document is not written until the first real mutation, so a
      // machine that never uses Telegram never gains a file.
      document = initialDocument(nextUuid());
      return;
    }
    if (!validDocument(parsed)) {
      document = initialDocument(nextUuid());
      return;
    }
    const pruned = prune(parsed, checkedNow());
    document = pruned.document;
    if (pruned.changed) await persist(pruned.document);
  });

  const setConnected = async (fingerprint: string): Promise<void> => {
    if (!digest(fingerprint)) throw inputInvalid();
    await mutate((current) => {
      // Actor digests are derived from the bot identity, so a different bot
      // makes every stored digest meaningless rather than merely stale.
      const sameBot = current.botFingerprint !== null
        && sameDigest(current.botFingerprint, fingerprint);
      return {
        document: {
          ...current,
          activationEpoch: nextEpoch(current.activationEpoch),
          desiredState: "connected",
          botFingerprint: fingerprint,
          pollOffset: sameBot ? current.pollOffset : null,
          pendingCode: sameBot ? current.pendingCode : null,
          pairing: sameBot ? current.pairing : null,
          approvals: sameBot ? current.approvals : [],
          lastErrorCode: null,
        },
        value: undefined,
        changed: true,
      };
    });
  };

  const setPaused = async (): Promise<boolean> => await mutate((current) => {
    if (current.desiredState === "paused") return { document: current, value: true, changed: false };
    if (current.desiredState !== "connected") {
      return { document: current, value: false, changed: false };
    }
    return {
      document: { ...current, desiredState: "paused" },
      value: true,
      changed: true,
    };
  });

  const setDisconnected = async (): Promise<void> => await mutate((current) => ({
    document: {
      ...current,
      activationEpoch: nextEpoch(current.activationEpoch),
      desiredState: "disconnected",
      pollOffset: null,
      pendingCode: null,
      pairing: null,
      approvals: [],
    },
    value: undefined,
    changed: true,
  }));

  const recordPollOffset = async (offset: number): Promise<void> => {
    if (!counter(offset)) throw inputInvalid();
    await mutate((current) => (
      current.pollOffset !== null && offset <= current.pollOffset
        ? { document: current, value: undefined, changed: false }
        : { document: { ...current, pollOffset: offset }, value: undefined, changed: true }
    ));
  };

  const setLastError = async (code: TelegramConnectionErrorCode | null): Promise<void> => {
    if (code !== null && !isTelegramConnectionErrorCode(code)) throw inputInvalid();
    await mutate((current) => (
      current.lastErrorCode === code
        ? { document: current, value: undefined, changed: false }
        : { document: { ...current, lastErrorCode: code }, value: undefined, changed: true }
    ));
  };

  const createPendingCode = async (
    input: CreateTelegramPendingCodeInput,
  ): Promise<TelegramPendingCodeRecord> => {
    if (!record(input) || !digest(input.codeDigest)) throw inputInvalid();
    const ttlMs = input.ttlMs ?? TELEGRAM_PAIRING_CODE_TTL_MS;
    const maxAttempts = input.maxAttempts ?? DEFAULT_PENDING_CODE_ATTEMPTS;
    if (
      !validDuration(ttlMs, MAX_PENDING_CODE_TTL_MS)
      || !validDuration(maxAttempts, MAX_PENDING_CODE_ATTEMPTS)
    ) {
      throw inputInvalid();
    }
    return await mutate((current, now) => {
      const pendingCode: StoredPendingCode = {
        id: nextUuid(),
        codeDigest: input.codeDigest,
        expiresAt: addDuration(now, ttlMs),
        attemptsRemaining: maxAttempts,
      };
      return {
        document: { ...current, pendingCode },
        value: pendingCodeRecord(pendingCode),
        changed: true,
      };
    });
  };

  const chargeAttempt = (
    current: StoreDocument,
  ): { readonly document: StoreDocument; readonly value: TelegramPendingCodeRecord | null } => {
    if (current.pendingCode === null) return { document: current, value: null };
    const attemptsRemaining = current.pendingCode.attemptsRemaining - 1;
    if (attemptsRemaining < 1) {
      return { document: { ...current, pendingCode: null }, value: null };
    }
    const pendingCode: StoredPendingCode = { ...current.pendingCode, attemptsRemaining };
    return {
      document: { ...current, pendingCode },
      value: pendingCodeRecord(pendingCode),
    };
  };

  const consumePendingCodeAttempt = async (): Promise<TelegramPendingCodeRecord | null> =>
    await mutate((current) => {
      if (current.pendingCode === null) {
        return { document: current, value: null, changed: false };
      }
      const charged = chargeAttempt(current);
      return { document: charged.document, value: charged.value, changed: true };
    });

  const completePairing = async (
    input: CompleteTelegramPairingInput,
  ): Promise<TelegramPairingRecord | null> => {
    if (!record(input) || !digest(input.codeDigest) || !digest(input.actorDigest)) {
      throw inputInvalid();
    }
    return await mutate((current, now) => {
      if (current.pendingCode === null) {
        return { document: current, value: null, changed: false };
      }
      if (!sameDigest(current.pendingCode.codeDigest, input.codeDigest)) {
        const charged = chargeAttempt(current);
        return { document: charged.document, value: null, changed: true };
      }
      const previous = current.pairing;
      const pairing: StoredPairing = {
        // A fresh id, so a stale owner surface cannot revoke the pairing that
        // replaced the one it is still displaying.
        id: nextUuid(),
        actorDigest: input.actorDigest,
        state: "active",
        epoch: previous === null ? 1 : nextEpoch(previous.epoch),
        createdAt: now,
      };
      return {
        document: { ...current, pendingCode: null, pairing, approvals: [] },
        value: pairingRecord(pairing),
        changed: true,
      };
    });
  };

  const revokePairing = async (id: string): Promise<boolean> => {
    if (!isTelegramConnectionId(id)) return false;
    return await mutate((current, now) => {
      const pairing = current.pairing;
      if (pairing === null || pairing.id !== id || pairing.state !== "active") {
        return { document: current, value: false, changed: false };
      }
      const revoked: StoredPairing = {
        ...pairing,
        state: "revoked",
        epoch: nextEpoch(pairing.epoch),
      };
      // prune() turns the now-superseded approvals terminal on the same pass.
      return {
        document: prune({ ...current, pairing: revoked }, now).document,
        value: true,
        changed: true,
      };
    });
  };

  const createApproval = async (
    input: CreateTelegramApprovalInput,
  ): Promise<TelegramApprovalAuthority | null> => {
    if (!record(input)
      || !isTelegramConversationId(input.conversationId)
      || !digest(input.conversationDigest)) {
      throw inputInvalid();
    }
    const ttlMs = input.ttlMs ?? DEFAULT_APPROVAL_TTL_MS;
    if (!validDuration(ttlMs, MAX_APPROVAL_TTL_MS)) throw inputInvalid();
    return await mutate((current, now) => {
      const pairing = current.pairing;
      if (pairing === null || pairing.state !== "active") {
        return { document: current, value: null, changed: false };
      }
      // The seam check. The caller derived the digest from its own injection; if
      // that disagrees with this store's, the grant would be written and then be
      // unresolvable forever, which is far harder to diagnose than a refusal.
      if (!sameDigest(
        conversationDigestOf(current.botFingerprint, input.conversationId),
        input.conversationDigest,
      )) {
        throw inputInvalid();
      }
      // Exactly one live share at a time. The owner surface can express only one
      // shared conversation, so a second live grant would be one the owner can
      // neither see nor revoke — and "the phone talks to the conversation you
      // shared" needs that conversation to be singular.
      const approvals = current.approvals.map((approval): StoredApproval => (
        approval.state === "active"
          ? { ...approval, state: "revoked", epoch: nextEpoch(approval.epoch) }
          : approval
      ));
      if (approvals.length >= MAX_APPROVALS) throw capacity();
      const approval: StoredApproval = {
        id: nextUuid(),
        pairingId: pairing.id,
        pairingEpoch: pairing.epoch,
        conversationId: input.conversationId,
        conversationDigest: input.conversationDigest,
        scope: nextUuid(),
        state: "active",
        epoch: 1,
        createdAt: now,
        expiresAt: addDuration(now, ttlMs),
      };
      return {
        document: { ...current, approvals: [...approvals, approval] },
        value: authority(pairing, approval),
        changed: true,
      };
    });
  };

  const revokeApproval = async (id: string): Promise<boolean> => {
    if (!isTelegramConnectionId(id)) return false;
    return await mutate((current) => {
      const index = current.approvals.findIndex((approval) => approval.id === id);
      const approval = current.approvals[index];
      if (approval === undefined || approval.state !== "active") {
        return { document: current, value: false, changed: false };
      }
      const approvals = [...current.approvals];
      approvals[index] = { ...approval, state: "revoked", epoch: nextEpoch(approval.epoch) };
      return { document: { ...current, approvals }, value: true, changed: true };
    });
  };

  /**
   * The one gate on "is this actor allowed to be asking at all". Both the egress
   * fence and the durable binding read it, so a paused or re-paired connection
   * cannot answer one of them while denying the other.
   */
  const livePairingFor = (actorDigest: string, current: StoreDocument): StoredPairing | null => {
    const pairing = current.pairing;
    return current.desiredState !== "connected"
      || pairing === null
      || pairing.state !== "active"
      || !sameDigest(pairing.actorDigest, actorDigest)
      ? null
      : pairing;
  };

  const resolveActiveApproval = (
    actorDigest: string,
    conversationDigest: string,
  ): TelegramApprovalAuthority | null => {
    try {
      if (!digest(actorDigest) || !digest(conversationDigest)) return null;
      const current = currentView();
      const pairing = livePairingFor(actorDigest, current);
      if (pairing === null) return null;
      // Only the conversation is matched here: prune() is the single authority
      // on liveness, so an approval that is still "active" in this view is
      // already known to be unexpired and bound to this pairing at this epoch.
      const approval = liveApprovals(current).find((entry) => (
        sameDigest(entry.conversationDigest, conversationDigest)
      ));
      return approval === undefined ? null : authority(pairing, approval);
    } catch {
      // An egress fence answers "no authority" rather than throwing into the
      // delivery path.
      return null;
    }
  };

  const resolveBoundConversation = (actorDigest: string): string | null => {
    try {
      if (!digest(actorDigest)) return null;
      const current = currentView();
      if (livePairingFor(actorDigest, current) === null) return null;
      // liveApprovals() already rejected any record whose plaintext does not
      // re-hash to its digest, so nothing hand-edited can be returned here.
      return newestApproval(liveApprovals(current))?.conversationId ?? null;
    } catch {
      return null;
    }
  };

  const ownerSnapshot = (): TelegramOwnerConnectionSnapshot => {
    const current = currentView();
    const pairing = current.pairing;
    const approval = newestApproval(liveApprovals(current));
    return Object.freeze({
      desiredState: current.desiredState,
      activationEpoch: current.activationEpoch,
      botFingerprint: current.botFingerprint,
      pairing: pairing === null || pairing.state !== "active"
        ? null
        : Object.freeze({
            id: pairing.id,
            accountFingerprint: pairing.actorDigest.slice(0, ACCOUNT_FINGERPRINT_CHARS),
          }),
      approval: approval === null ? null : Object.freeze({
        id: approval.id,
        expiresAt: approval.expiresAt,
        conversationDigest: approval.conversationDigest,
      }),
      pendingCode: current.pendingCode === null ? null : pendingCodeRecord(current.pendingCode),
      lastErrorCode: current.lastErrorCode,
    });
  };

  return Object.freeze({
    open,
    subscribe: (listener: ChangeListener): (() => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    ownerSnapshot,
    receiptOwnerId: () => requireDocument().receiptOwnerId,
    activationEpoch: () => requireDocument().activationEpoch,
    desiredState: () => requireDocument().desiredState,
    botFingerprint: () => requireDocument().botFingerprint,
    activePairingActorDigest: () => {
      const pairing = requireDocument().pairing;
      return pairing !== null && pairing.state === "active" ? pairing.actorDigest : null;
    },
    pollOffset: () => requireDocument().pollOffset,
    setConnected,
    setPaused,
    setDisconnected,
    recordPollOffset,
    setLastError,
    createPendingCode,
    consumePendingCodeAttempt,
    completePairing,
    revokePairing,
    createApproval,
    revokeApproval,
    resolveActiveApproval,
    resolveBoundConversation,
  });
}
