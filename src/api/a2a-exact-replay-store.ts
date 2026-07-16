import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type { FeatureNamespaceHandle } from "../main/storage/feature-namespace.js";
import type { A2ASendMessageResult } from "../shared/a2a-wire.js";
import { A2A_EXACT_SEND_REPLAY_RETENTION_MS } from "./a2a-remote-contracts.js";
import type { A2AOsEncryption } from "./a2a-remote-store.js";

const STORE_VERSION = 2;
const DEFAULT_FILE = "exact-send-replay.json";
const DIGEST = /^[a-f0-9]{64}$/;

type ReplayState = "in-progress" | "completed" | "outcome-unknown" | "RETENTION_EXPIRED";

interface ReplayRecord {
  keyToken: string;
  callerToken: string;
  messageToken: string;
  bodySha256: string;
  intentSha256: string;
  firstAcceptedAt: string;
  expiresAt: string;
  state: ReplayState;
  ownerTokenHmac?: string;
  resultCiphertext?: string;
  resultIv?: string;
  resultAuthTag?: string;
  resultCiphertextSha256?: string;
}

interface ReplayStateFile {
  version: typeof STORE_VERSION;
  encryptedDataKey?: string;
  records: ReplayRecord[];
}

export interface CreateA2AExactReplayStoreOptions {
  namespace: Pick<FeatureNamespaceHandle, "readJson" | "writeJson">;
  encryption: A2AOsEncryption;
  fileName?: string;
  maxKeysPerGeneration: number;
  now?: () => Date;
  makeOwnerToken?: () => string;
  random?: (size: number) => Buffer;
  retentionMs?: number;
}

export type A2AReplayBeginResult =
  | { kind: "owner"; ownerToken: string }
  | { kind: "completed"; result: A2ASendMessageResult }
  | { kind: "in-progress" }
  | { kind: "conflict" }
  | { kind: "retention-expired" }
  | { kind: "outcome-unknown" }
  | { kind: "capacity-exhausted" };

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key: Buffer, domain: string, value: string): string {
  return createHmac("sha256", key).update(domain).update("\0").update(value).digest("hex");
}

function initialState(): ReplayStateFile {
  return { version: STORE_VERSION, records: [] };
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validRecord(value: unknown): value is ReplayRecord {
  if (!isRecord(value) || !["in-progress", "completed", "outcome-unknown", "RETENTION_EXPIRED"].includes(String(value.state))) return false;
  const common = ["keyToken", "callerToken", "messageToken", "bodySha256", "intentSha256", "firstAcceptedAt", "expiresAt", "state"];
  const stateKeys = value.state === "in-progress" ? ["ownerTokenHmac"]
    : value.state === "completed" ? ["resultCiphertext", "resultIv", "resultAuthTag", "resultCiphertextSha256"] : [];
  if (!exactKeys(value, [...common, ...stateKeys])) return false;
  if (![value.keyToken, value.callerToken, value.messageToken, value.bodySha256, value.intentSha256].every((entry) => typeof entry === "string" && DIGEST.test(entry))) return false;
  if (typeof value.firstAcceptedAt !== "string" || !Number.isFinite(Date.parse(value.firstAcceptedAt)) || typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt))) return false;
  if (value.state === "in-progress" && (typeof value.ownerTokenHmac !== "string" || !DIGEST.test(value.ownerTokenHmac))) return false;
  if (value.state === "completed" && (typeof value.resultCiphertext !== "string" || typeof value.resultIv !== "string" || typeof value.resultAuthTag !== "string" || typeof value.resultCiphertextSha256 !== "string" || !DIGEST.test(value.resultCiphertextSha256))) return false;
  return true;
}

function validState(value: unknown): value is ReplayStateFile {
  if (!isRecord(value)) return false;
  const keys = value.encryptedDataKey === undefined ? ["version", "records"] : ["version", "encryptedDataKey", "records"];
  return exactKeys(value, keys) && value.version === STORE_VERSION
    && (value.encryptedDataKey === undefined || typeof value.encryptedDataKey === "string")
    && Array.isArray(value.records) && value.records.every(validRecord);
}

function validResult(value: unknown): value is A2ASendMessageResult {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && (keys[0] === "message" || keys[0] === "task") && isRecord(value[keys[0]!]);
}

export class A2AExactReplayStore {
  private readonly fileName: string;
  private readonly now: () => Date;
  private readonly makeOwnerToken: () => string;
  private readonly random: (size: number) => Buffer;
  private readonly retentionMs: number;
  private state: ReplayStateFile | undefined;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly options: CreateA2AExactReplayStoreOptions) {
    if (!Number.isInteger(options.maxKeysPerGeneration) || options.maxKeysPerGeneration < 1) throw new Error("a2a-replay-capacity-invalid");
    this.fileName = options.fileName ?? DEFAULT_FILE;
    this.now = options.now ?? (() => new Date());
    this.makeOwnerToken = options.makeOwnerToken ?? randomUUID;
    this.random = options.random ?? randomBytes;
    this.retentionMs = options.retentionMs ?? A2A_EXACT_SEND_REPLAY_RETENTION_MS;
  }

  private async withLock<T>(operation: (state: ReplayStateFile) => Promise<T> | T): Promise<T> {
    const run = this.queue.then(async () => operation(await this.load()));
    this.queue = run.then(() => undefined, () => undefined);
    return await run;
  }

  private dataKey(state: ReplayStateFile): Buffer {
    if (!this.options.encryption.isEncryptionAvailable()) throw new Error("a2a-replay-encryption-unavailable");
    if (!state.encryptedDataKey) {
      const key = this.random(32);
      if (key.length !== 32) throw new Error("a2a-replay-key-invalid");
      state.encryptedDataKey = this.options.encryption.encryptString(key.toString("base64")).toString("base64");
      return key;
    }
    const key = Buffer.from(this.options.encryption.decryptString(Buffer.from(state.encryptedDataKey, "base64")), "base64");
    if (key.length !== 32) throw new Error("a2a-replay-key-invalid");
    return key;
  }

  private async load(): Promise<ReplayStateFile> {
    if (this.state) return this.state;
    const raw = await this.options.namespace.readJson<unknown>(this.fileName, initialState());
    if (!validState(raw)) throw new Error("a2a-replay-store-invalid");
    const state = structuredClone(raw);
    let changed = false;
    for (const record of state.records) {
      if (record.state === "in-progress") {
        record.state = "outcome-unknown";
        delete record.ownerTokenHmac;
        changed = true;
      }
    }
    this.state = state;
    if (changed) await this.persist(state);
    return state;
  }

  private async persist(state: ReplayStateFile): Promise<void> {
    await this.options.namespace.writeJson(this.fileName, state);
  }

  private async expireUnlocked(state: ReplayStateFile): Promise<number> {
    const now = this.now().getTime();
    let changed = 0;
    for (const record of state.records) {
      if (record.state !== "RETENTION_EXPIRED" && Date.parse(record.expiresAt) <= now) {
        record.state = "RETENTION_EXPIRED";
        delete record.ownerTokenHmac;
        delete record.resultCiphertext;
        delete record.resultIv;
        delete record.resultAuthTag;
        delete record.resultCiphertextSha256;
        changed += 1;
      }
    }
    if (changed) await this.persist(state);
    return changed;
  }

  private decryptResult(state: ReplayStateFile, record: ReplayRecord): A2ASendMessageResult {
    const key = this.dataKey(state);
    try {
      const ciphertext = Buffer.from(record.resultCiphertext!, "base64");
      if (sha256(ciphertext) !== record.resultCiphertextSha256) throw new Error("a2a-replay-result-corrupt");
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(record.resultIv!, "base64"));
      decipher.setAAD(Buffer.from(`result\0${record.keyToken}\0${record.bodySha256}\0${record.intentSha256}`));
      decipher.setAuthTag(Buffer.from(record.resultAuthTag!, "base64"));
      const value = JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8")) as unknown;
      if (!validResult(value)) throw new Error("a2a-replay-result-invalid");
      return structuredClone(value);
    } finally { key.fill(0); }
  }

  async begin(input: Readonly<{ callerGenerationId: string; messageId: string; bodySha256: string; intentSha256: string }>): Promise<A2AReplayBeginResult> {
    if (!DIGEST.test(input.bodySha256) || !DIGEST.test(input.intentSha256)) throw new Error("a2a-replay-digest-invalid");
    return await this.withLock(async (state) => {
      await this.expireUnlocked(state);
      const key = this.dataKey(state);
      try {
        const callerToken = hmac(key, "caller", input.callerGenerationId);
        const messageToken = hmac(key, "message", input.messageId);
        const keyToken = hmac(key, "replay", `${callerToken}\0${messageToken}`);
        const existing = state.records.find((record) => record.keyToken === keyToken);
        if (existing) {
          if (existing.bodySha256 !== input.bodySha256 || existing.intentSha256 !== input.intentSha256) return { kind: "conflict" };
          if (existing.state === "completed") return { kind: "completed", result: this.decryptResult(state, existing) };
          if (existing.state === "in-progress") return { kind: "in-progress" };
          if (existing.state === "outcome-unknown") return { kind: "outcome-unknown" };
          return { kind: "retention-expired" };
        }
        if (state.records.filter((record) => record.callerToken === callerToken).length >= this.options.maxKeysPerGeneration) return { kind: "capacity-exhausted" };
        const ownerToken = this.makeOwnerToken();
        const accepted = this.now().getTime();
        const next = structuredClone(state);
        next.records.push({ keyToken, callerToken, messageToken, bodySha256: input.bodySha256, intentSha256: input.intentSha256, firstAcceptedAt: new Date(accepted).toISOString(), expiresAt: new Date(accepted + this.retentionMs).toISOString(), state: "in-progress", ownerTokenHmac: hmac(key, "owner", ownerToken) });
        await this.persist(next);
        this.state = next;
        return { kind: "owner", ownerToken };
      } finally { key.fill(0); }
    });
  }

  async complete(ownerToken: string, result: A2ASendMessageResult): Promise<boolean> {
    if (!validResult(result)) throw new Error("a2a-replay-result-oneof-invalid");
    return await this.withLock(async (state) => {
      await this.expireUnlocked(state);
      const key = this.dataKey(state);
      try {
        const token = Buffer.from(hmac(key, "owner", ownerToken), "hex");
        const index = state.records.findIndex((record) => record.state === "in-progress" && record.ownerTokenHmac && timingSafeEqual(Buffer.from(record.ownerTokenHmac, "hex"), token));
        if (index < 0) return false;
        const next = structuredClone(state);
        const record = next.records[index]!;
        const iv = this.random(12);
        const cipher = createCipheriv("aes-256-gcm", key, iv);
        cipher.setAAD(Buffer.from(`result\0${record.keyToken}\0${record.bodySha256}\0${record.intentSha256}`));
        const ciphertext = Buffer.concat([cipher.update(JSON.stringify(result), "utf8"), cipher.final()]);
        record.state = "completed";
        delete record.ownerTokenHmac;
        record.resultCiphertext = ciphertext.toString("base64");
        record.resultIv = iv.toString("base64");
        record.resultAuthTag = cipher.getAuthTag().toString("base64");
        record.resultCiphertextSha256 = sha256(ciphertext);
        await this.persist(next);
        this.state = next;
        return true;
      } finally { key.fill(0); }
    });
  }

  async markOutcomeUnknown(ownerToken: string): Promise<boolean> {
    return await this.withLock(async (state) => {
      await this.expireUnlocked(state);
      const key = this.dataKey(state);
      try {
        const token = Buffer.from(hmac(key, "owner", ownerToken), "hex");
        const index = state.records.findIndex((record) => record.state === "in-progress" && record.ownerTokenHmac && timingSafeEqual(Buffer.from(record.ownerTokenHmac, "hex"), token));
        if (index < 0) return false;
        const next = structuredClone(state);
        next.records[index]!.state = "outcome-unknown";
        delete next.records[index]!.ownerTokenHmac;
        await this.persist(next);
        this.state = next;
        return true;
      } finally { key.fill(0); }
    });
  }

  async expireDue(): Promise<number> { return await this.withLock((state) => this.expireUnlocked(state)); }
}
