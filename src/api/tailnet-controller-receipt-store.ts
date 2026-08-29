import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { writeUtf8FileAtomicSync } from "../lib/atomic-file.js";
import { lvisHome } from "../shared/lvis-home.js";
import { UUID_PATTERN } from "../shared/uuid.js";
import { hasExactKeys } from "../shared/is-record.js";
import { isNonNegativeSafeInteger } from "../shared/safe-integer.js";

const STORE_VERSION = 1;
const DEFAULT_FILE_NAME = "command-receipts.json";
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_RECEIPTS = 4_096;
const SHA256_HEX = /^[a-f0-9]{64}$/;

type ReceiptState = "reserved" | "terminal";

interface ReceiptRecord {
  keyDigest: string;
  intentDigest: string;
  conversationDigest: string;
  /** Start of the current replay-protection window. */
  acceptedAt: number;
  expiresAt: number;
  state: ReceiptState;
  ownerId?: string;
}

interface ReceiptStateFile {
  version: typeof STORE_VERSION;
  receipts: ReceiptRecord[];
}

export interface TailnetControllerReceiptReservation {
  /** SHA-256 of the caller-scoped idempotency key; never the raw command ID. */
  keyDigest: string;
  /** SHA-256 of the canonical command intent; never the raw command input. */
  intentDigest: string;
  /** SHA-256 of the private conversation ID; never the raw conversation ID. */
  conversationDigest: string;
  /** Fresh UUID for the currently-running controller broker process. */
  ownerId: string;
}

export type TailnetControllerReceiptReserveResult =
  | { kind: "reserved" }
  | { kind: "duplicate" }
  | { kind: "outcome-unknown" }
  | { kind: "conflict" }
  | { kind: "capacity-exhausted" };

export interface CreateTailnetControllerReceiptStoreOptions {
  /** Overrides the user-data default; intended for integration and tests. */
  filePath?: string;
  /** Returns an epoch timestamp in milliseconds. */
  now?: () => number;
  /** How long a completed receipt blocks a replay after it settles. */
  ttlMs?: number;
  /** Maximum retained receipts. Unresolved reservations are never expired. */
  maxReceipts?: number;
}

function initialState(): ReceiptStateFile {
  return { version: STORE_VERSION, receipts: [] };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validRecord(value: unknown, ttlMs: number): value is ReceiptRecord {
  if (!isPlainRecord(value) || (value.state !== "reserved" && value.state !== "terminal")) return false;
  const expectedKeys = value.state === "reserved"
    ? ["keyDigest", "intentDigest", "conversationDigest", "acceptedAt", "expiresAt", "state", "ownerId"]
    : ["keyDigest", "intentDigest", "conversationDigest", "acceptedAt", "expiresAt", "state"];
  if (!hasExactKeys(value, expectedKeys)) return false;
  if (![value.keyDigest, value.intentDigest, value.conversationDigest].every((entry) => typeof entry === "string" && SHA256_HEX.test(entry))) return false;
  if (!isNonNegativeSafeInteger(value.acceptedAt) || !isNonNegativeSafeInteger(value.expiresAt) || value.expiresAt <= value.acceptedAt || value.expiresAt - value.acceptedAt !== ttlMs) return false;
  return value.state !== "reserved" || (typeof value.ownerId === "string" && UUID_PATTERN.test(value.ownerId));
}

function validState(value: unknown, ttlMs: number, maxReceipts: number): value is ReceiptStateFile {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["version", "receipts"]) || value.version !== STORE_VERSION || !Array.isArray(value.receipts) || value.receipts.length > maxReceipts || !value.receipts.every((record) => validRecord(record, ttlMs))) return false;
  const keys = new Set<string>();
  for (const record of value.receipts) {
    if (keys.has(record.keyDigest)) return false;
    keys.add(record.keyDigest);
  }
  return true;
}

function invalidStoreError(): Error {
  return new Error("tailnet-controller-receipt-store-invalid");
}

function unavailableReceiptError(): Error {
  return new Error("tailnet-controller-receipt-store-reservation-invalid");
}

/**
 * Durable, plaintext-free idempotency receipts for native Tailnet controller
 * submissions. A receipt is persisted before command submission. A record left
 * in `reserved` is deliberately never expired: it represents an outcome that
 * cannot be safely reconstructed after a crash or an arbitrarily long local
 * approval/model turn. It is treated as unknown rather than replayed.
 */
export class TailnetControllerReceiptStore {
  private readonly filePath: string;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxReceipts: number;

  constructor(options: CreateTailnetControllerReceiptStoreOptions = {}) {
    this.filePath = resolve(options.filePath ?? join(lvisHome(), "tailnet-controller", DEFAULT_FILE_NAME));
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxReceipts = options.maxReceipts ?? DEFAULT_MAX_RECEIPTS;
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs <= 0) throw new Error("tailnet-controller-receipt-store-ttl-invalid");
    if (!Number.isSafeInteger(this.maxReceipts) || this.maxReceipts < 1) throw new Error("tailnet-controller-receipt-store-capacity-invalid");
  }

  /**
   * Reserve a receipt before calling the command port. Every input is already a
   * digest or locally-generated owner UUID, so request plaintext never enters
   * the durable state file.
   */
  reserve(input: Readonly<TailnetControllerReceiptReservation>): TailnetControllerReceiptReserveResult {
    this.assertReservation(input);
    const state = this.loadAndPrune();
    const existing = state.receipts.find((record) => record.keyDigest === input.keyDigest);
    if (existing) {
      if (existing.intentDigest !== input.intentDigest || existing.conversationDigest !== input.conversationDigest) return { kind: "conflict" };
      if (existing.state === "terminal" || existing.ownerId === input.ownerId) return { kind: "duplicate" };
      return { kind: "outcome-unknown" };
    }
    if (state.receipts.length >= this.maxReceipts) return { kind: "capacity-exhausted" };

    const receiptWindow = this.nextReceiptWindow();
    const next: ReceiptStateFile = {
      version: STORE_VERSION,
      receipts: [
        ...state.receipts,
        {
          keyDigest: input.keyDigest,
          intentDigest: input.intentDigest,
          conversationDigest: input.conversationDigest,
          ...receiptWindow,
          state: "reserved",
          ownerId: input.ownerId,
        },
      ],
    };
    this.persist(next);
    return { kind: "reserved" };
  }

  /** Remove a reservation when no command was accepted by the runtime. */
  releaseReserved(input: Readonly<Pick<TailnetControllerReceiptReservation, "keyDigest" | "ownerId">>): void {
    this.assertKeyAndOwner(input);
    const state = this.loadAndPrune();
    const index = state.receipts.findIndex((record) => record.keyDigest === input.keyDigest);
    const record = state.receipts[index];
    if (!record || record.state !== "reserved" || record.ownerId !== input.ownerId) throw unavailableReceiptError();
    this.persist({
      version: STORE_VERSION,
      receipts: state.receipts.filter((_, candidateIndex) => candidateIndex !== index),
    });
  }

  /** Mark a submitted command's outcome known without persisting its result. */
  settle(input: Readonly<Pick<TailnetControllerReceiptReservation, "keyDigest" | "ownerId">>): void {
    this.assertKeyAndOwner(input);
    const state = this.loadAndPrune();
    const index = state.receipts.findIndex((record) => record.keyDigest === input.keyDigest);
    const record = state.receipts[index];
    if (!record || record.state !== "reserved" || record.ownerId !== input.ownerId) throw unavailableReceiptError();
    const receiptWindow = this.nextReceiptWindow();
    const receipts = [...state.receipts];
    receipts[index] = {
      keyDigest: record.keyDigest,
      intentDigest: record.intentDigest,
      conversationDigest: record.conversationDigest,
      ...receiptWindow,
      state: "terminal",
    };
    this.persist({ version: STORE_VERSION, receipts });
  }

  private assertReservation(input: Readonly<TailnetControllerReceiptReservation>): void {
    if (!SHA256_HEX.test(input.keyDigest) || !SHA256_HEX.test(input.intentDigest) || !SHA256_HEX.test(input.conversationDigest) || !UUID_PATTERN.test(input.ownerId)) throw invalidStoreError();
  }

  private assertKeyAndOwner(input: Readonly<Pick<TailnetControllerReceiptReservation, "keyDigest" | "ownerId">>): void {
    if (!SHA256_HEX.test(input.keyDigest) || !UUID_PATTERN.test(input.ownerId)) throw invalidStoreError();
  }

  private loadAndPrune(): ReceiptStateFile {
    const state = this.load();
    const now = this.now();
    if (!isNonNegativeSafeInteger(now)) throw invalidStoreError();
    // A reserved record means this process may be waiting indefinitely for a
    // local-only decision or an in-flight model/tool turn. Pruning it would
    // turn an idempotent retry into a second remote submission. Only a known
    // terminal outcome can age out of the durable idempotency fence.
    const receipts = state.receipts.filter(
      (record) => record.state === "reserved" || record.expiresAt > now,
    );
    if (receipts.length === state.receipts.length) return state;
    const pruned = { version: STORE_VERSION, receipts } satisfies ReceiptStateFile;
    this.persist(pruned);
    return pruned;
  }

  private load(): ReceiptStateFile {
    if (!existsSync(this.filePath)) return initialState();
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as unknown;
    } catch {
      throw invalidStoreError();
    }
    if (!validState(parsed, this.ttlMs, this.maxReceipts)) throw invalidStoreError();
    return parsed;
  }

  private nextReceiptWindow(): Pick<ReceiptRecord, "acceptedAt" | "expiresAt"> {
    const acceptedAt = this.now();
    if (!isNonNegativeSafeInteger(acceptedAt) || acceptedAt > Number.MAX_SAFE_INTEGER - this.ttlMs) {
      throw invalidStoreError();
    }
    return { acceptedAt, expiresAt: acceptedAt + this.ttlMs };
  }

  private persist(state: ReceiptStateFile): void {
    if (!validState(state, this.ttlMs, this.maxReceipts)) throw invalidStoreError();
    writeUtf8FileAtomicSync(this.filePath, `${JSON.stringify(state)}\n`, 0o600);
  }
}

export function createTailnetControllerReceiptStore(
  options: CreateTailnetControllerReceiptStoreOptions = {},
): TailnetControllerReceiptStore {
  return new TailnetControllerReceiptStore(options);
}
