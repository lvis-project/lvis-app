import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import type { FeatureNamespaceHandle } from "../main/storage/feature-namespace.js";
import {
  canTransitionA2ATaskState,
  isA2ATerminalTaskState,
  type A2ATask,
  type A2ATaskState,
} from "../shared/a2a.js";
import {
  A2A_EXACT_SEND_REPLAY_URI,
  A2A_EXACT_SEND_REPLAY_RETENTION_MS,
  A2A_REMOTE_MAX_REQUEST_BYTES,
  type A2ARemoteLineage,
  type A2ARemoteDeliveryState,
  type A2ARemotePreparedAttempt,
  type A2ARemoteResolvedFields,
} from "./a2a-remote-contracts.js";

const STORE_VERSION = 2;
const DEFAULT_FILE = "client-state.json";
const DEFAULT_QUARANTINE_FILE = "client-state.quarantine.json";
const DIGEST = /^[a-f0-9]{64}$/;
const SAFE_TOKEN = /^[A-Za-z0-9._:~-]{1,256}$/;
const ATTEMPT_STAGES = new Set<A2ARemoteDeliveryState>(["prepared", "resolved", "in-flight", "outcome-unknown", "reconciling", "settled", "NOT_SENT", "RETENTION_EXPIRED"]);

export interface A2AOsEncryption {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

interface EncryptedPayloadRecord {
  id: string;
  operationId: string;
  state: "staged" | "bound";
  ciphertext: string;
  iv: string;
  authTag: string;
  aadSha256: string;
  ciphertextSha256: string;
  bodySha256: string;
  size: number;
  createdAt: string;
  orphanDeadline: string;
  expiresAt: string;
}

interface EncryptedRemoteTaskRecord {
  handle: string;
  ownerDigestSha256: string;
  operationId: string;
  targetAgentId: number;
  targetLabel: string;
  lineage: A2ARemoteLineage;
  credentialRevisionId: number;
  taskState: A2ATaskState;
  ciphertext: string;
  iv: string;
  authTag: string;
  aadSha256: string;
  ciphertextSha256: string;
  createdAt: string;
  updatedAt: string;
}

export interface A2ARemoteTaskProjection {
  handle: string;
  targetAgentId: number;
  targetLabel: string;
  state: A2ATaskState;
  updatedAt: string;
  terminal: boolean;
}

export interface A2ARemoteTaskRoute {
  handle: string;
  operationId: string;
  targetAgentId: number;
  targetLabel: string;
  lineage: A2ARemoteLineage;
  credentialRevisionId: number;
  remoteTaskId: string;
  remoteContextId?: string;
  messageId?: string;
  state: A2ATaskState;
}

export interface A2ARemoteOperationRecoveryRoute {
  handle: string;
  operationId: string;
  targetAgentId: number;
  targetLabel: string;
  lineage: A2ARemoteLineage;
  messageId: string;
  credentialRevisionId: number;
  retryNotBefore?: string;
}

export type A2ARemoteTaskActionDisposition =
  | { kind: "none" }
  | { kind: "success"; projection: A2ARemoteTaskProjection }
  | { kind: "blocked"; outcome: string };

export interface A2ARemoteAttemptRecord {
  prepared: A2ARemotePreparedAttempt;
  stage: A2ARemoteDeliveryState;
  resolved?: A2ARemoteResolvedFields;
  outcomeCode?: string;
  /** Durable lower bound for a user-triggered retry after -32092. */
  retryNotBefore?: string;
  updatedAt: string;
}

interface StoreState {
  version: typeof STORE_VERSION;
  encryptedDataKey?: string;
  attempts: A2ARemoteAttemptRecord[];
  payloads: EncryptedPayloadRecord[];
  tasks: EncryptedRemoteTaskRecord[];
}

interface QuarantineEntry {
  kind: "attempt" | "payload" | "task" | "state";
  reason: string;
  digestSha256: string;
  quarantinedAt: string;
}

export interface CreateA2ARemoteStoreOptions {
  namespace: Pick<FeatureNamespaceHandle, "readJson" | "writeJson">;
  encryption: A2AOsEncryption;
  fileName?: string;
  now?: () => Date;
  random?: (size: number) => Buffer;
  makeId?: () => string;
  orphanTtlMs?: number;
  recoveryTtlMs?: number;
  maxAttempts?: number;
  maxPayloads?: number;
  maxTasks?: number;
  maxQuarantine?: number;
  audit?: (event: Readonly<{ reason: string; count: number }>) => void;
}

export type PrepareAttemptResult =
  | { ok: true; duplicate: boolean; record: A2ARemoteAttemptRecord }
  | { ok: false; reason: "attempt-conflict" | "intended-revision-conflict" };

export const INTENDED_CREDENTIAL_REVISION_CONFLICT = "INTENDED_CREDENTIAL_REVISION_CONFLICT" as const;

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function decodeCanonicalBase64(value: string): Buffer | null {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null;
  const decoded = Buffer.from(value, "base64");
  return decoded.toString("base64") === value ? decoded : null;
}

function payloadAadFromOwnerDigest(input: Readonly<{
  ownerDigestSha256: string;
  operationId: string;
  messageId: string;
  bodySha256: string;
  lineage: A2ARemoteLineage;
}>): string {
  const lineage = Object.fromEntries(Object.entries(input.lineage).sort(([a], [b]) => compareCodePoints(a, b)));
  return JSON.stringify({
    version: 1,
    ownerDigestSha256: input.ownerDigestSha256,
    operationId: input.operationId,
    messageId: input.messageId,
    bodySha256: input.bodySha256,
    lineage,
  });
}

function cloneRecord(value: A2ARemoteAttemptRecord): A2ARemoteAttemptRecord {
  return structuredClone(value);
}

function initialState(): StoreState {
  return { version: STORE_VERSION, attempts: [], payloads: [], tasks: [] };
}

function isStoreState(value: unknown): value is StoreState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<StoreState>;
  return Object.keys(candidate).every((key) => ["version", "encryptedDataKey", "attempts", "payloads", "tasks"].includes(key))
    && candidate.version === STORE_VERSION
    && Array.isArray(candidate.attempts)
    && Array.isArray(candidate.payloads)
    && Array.isArray(candidate.tasks)
    && (candidate.encryptedDataKey === undefined || typeof candidate.encryptedDataKey === "string");
}

/**
 * One host-owned atomic state file binds client journal records to encrypted
 * initial-Send payload records. Plain request bytes never enter this state.
 */
export class A2ARemoteDurableStore {
  private readonly fileName: string;
  private readonly now: () => Date;
  private readonly random: (size: number) => Buffer;
  private readonly makeId: () => string;
  private readonly orphanTtlMs: number;
  private readonly recoveryTtlMs: number;
  private readonly maxAttempts: number;
  private readonly maxPayloads: number;
  private readonly maxTasks: number;
  private readonly maxQuarantine: number;
  private state: StoreState | undefined;
  private recoveryBlocked = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly options: CreateA2ARemoteStoreOptions) {
    this.fileName = options.fileName ?? DEFAULT_FILE;
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? randomBytes;
    this.makeId = options.makeId ?? randomUUID;
    this.orphanTtlMs = options.orphanTtlMs ?? 60_000;
    this.recoveryTtlMs = options.recoveryTtlMs ?? A2A_EXACT_SEND_REPLAY_RETENTION_MS;
    this.maxAttempts = options.maxAttempts ?? 4_096;
    this.maxPayloads = options.maxPayloads ?? 512;
    this.maxTasks = options.maxTasks ?? 512;
    this.maxQuarantine = options.maxQuarantine ?? 512;
    for (const value of [this.maxAttempts, this.maxPayloads, this.maxTasks, this.maxQuarantine]) {
      if (!Number.isSafeInteger(value) || value < 1 || value > 100_000) throw new Error("a2a-remote-capacity-invalid");
    }
  }

  private async withLock<T>(operation: (state: StoreState) => Promise<T> | T): Promise<T> {
    const run = this.queue.then(async () => {
      const state = await this.load();
      return await operation(state);
    });
    this.queue = run.then(() => undefined, () => undefined);
    return await run;
  }

  private async load(): Promise<StoreState> {
    if (this.state) return this.state;
    const raw = await this.options.namespace.readJson<unknown>(this.fileName, initialState());
    if (!isStoreState(raw)) {
      this.audit("state-schema-invalid", 1);
      throw new Error("a2a-remote-store-invalid");
    }
    const recovered = await this.validateAndRecover(structuredClone(raw));
    this.state = recovered;
    return this.state;
  }

  private audit(reason: string, count: number): void {
    try { this.options.audit?.({ reason, count }); } catch { /* diagnostics cannot change the fence */ }
  }

  private quarantine(kind: QuarantineEntry["kind"], reason: string, value: unknown): QuarantineEntry {
    let serialized: string;
    try { serialized = JSON.stringify(value); } catch { serialized = "[unserializable]"; }
    return { kind, reason, digestSha256: sha256(serialized), quarantinedAt: this.now().toISOString() };
  }

  private validLineage(value: unknown): value is A2ARemoteLineage {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const item = value as Record<string, unknown>;
    const keys = ["targetAgentId", "interfaceUrl", "agentCardDigestSha256", "trustKeyId", "credentialBindingId", "callerGenerationId", "routePolicyVersion", "routePolicyDigestSha256", "extensionSpecDigestSha256"];
    return Object.keys(item).sort().join(",") === keys.sort().join(",")
      && Number.isSafeInteger(item.targetAgentId) && (item.targetAgentId as number) > 0
      && typeof item.interfaceUrl === "string" && item.interfaceUrl.length <= 2_048
      && [item.agentCardDigestSha256, item.routePolicyDigestSha256, item.extensionSpecDigestSha256].every((entry) => typeof entry === "string" && DIGEST.test(entry))
      && [item.trustKeyId, item.credentialBindingId, item.routePolicyVersion].every((entry) => Number.isSafeInteger(entry) && (entry as number) > 0)
      && typeof item.callerGenerationId === "string" && SAFE_TOKEN.test(item.callerGenerationId);
  }

  private validPrepared(value: unknown): value is A2ARemotePreparedAttempt {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const item = value as Record<string, unknown>;
    const allowed = new Set(["operationId", "attemptId", "ownerToken", "ownerDigestSha256", "projectRootDigestSha256", "profileDigestSha256", "originDigestSha256", "operation", "method", "lineage", "depth", "semanticRequestHash", "messageId", "taskHandle", "targetLabel", "taskToken", "contextToken", "approvalDecisionId", "approvalDecidedAt", "createdAt", "attemptDeadline", "intendedCredentialRevisionId", "predecessorCredentialRevisionId", "payloadRecordId", "payloadCiphertextSha256", "payloadBodySha256", "payloadSize", "payloadExpiresAt"]);
    if (!Object.keys(item).every((key) => allowed.has(key))) return false;
    if (![item.operationId, item.attemptId, item.ownerToken].every((entry) => typeof entry === "string" && SAFE_TOKEN.test(entry))) return false;
    if (![item.ownerDigestSha256, item.projectRootDigestSha256, item.profileDigestSha256, item.originDigestSha256, item.semanticRequestHash].every((entry) => typeof entry === "string" && DIGEST.test(entry))) return false;
    if (!this.validLineage(item.lineage) || item.depth !== 0) return false;
    if (!["initial-send", "continue", "get", "cancel", "replay"].includes(String(item.operation))) return false;
    if (!["SendMessage", "GetTask", "CancelTask"].includes(String(item.method))) return false;
    if (typeof item.createdAt !== "string" || typeof item.attemptDeadline !== "string"
      || !Number.isFinite(Date.parse(item.createdAt)) || !Number.isFinite(Date.parse(item.attemptDeadline))
      || Date.parse(item.attemptDeadline) <= Date.parse(item.createdAt)) return false;
    if (!Number.isSafeInteger(item.intendedCredentialRevisionId) || (item.intendedCredentialRevisionId as number) < 1) return false;
    for (const key of ["taskToken", "contextToken", "payloadCiphertextSha256", "payloadBodySha256"] as const) {
      if (item[key] !== undefined && (typeof item[key] !== "string" || !DIGEST.test(item[key] as string))) return false;
    }
    if ((item.operation === "initial-send" || item.operation === "replay") && (typeof item.messageId !== "string" || !SAFE_TOKEN.test(item.messageId))) return false;
    if (item.operation === "replay" && !item.predecessorCredentialRevisionId) return false;
    return true;
  }

  private validAttempt(value: unknown): value is A2ARemoteAttemptRecord {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const item = value as Record<string, unknown>;
    if (!Object.keys(item).every((key) => ["prepared", "stage", "resolved", "outcomeCode", "retryNotBefore", "updatedAt"].includes(key))) return false;
    if (!this.validPrepared(item.prepared) || typeof item.stage !== "string" || !ATTEMPT_STAGES.has(item.stage as A2ARemoteDeliveryState)) return false;
    if (typeof item.updatedAt !== "string" || !Number.isFinite(Date.parse(item.updatedAt))) return false;
    const stage = item.stage as A2ARemoteDeliveryState;
    const prepared = item.prepared as A2ARemotePreparedAttempt;
    if (stage !== "NOT_SENT" && (prepared.operation === "initial-send" || prepared.operation === "continue" || prepared.operation === "cancel" || prepared.operation === "replay")
      && (typeof prepared.approvalDecisionId !== "string" || typeof prepared.approvalDecidedAt !== "string")) return false;
    if (["resolved", "in-flight", "outcome-unknown", "reconciling", "settled"].includes(stage) && item.resolved === undefined) return false;
    if (["prepared", "NOT_SENT"].includes(stage) && item.resolved !== undefined) return false;
    if (item.resolved !== undefined && !this.validResolved(item.resolved, prepared)) return false;
    if (["outcome-unknown", "reconciling", "settled", "NOT_SENT", "RETENTION_EXPIRED"].includes(stage) && typeof item.outcomeCode !== "string") return false;
    if (stage === "reconciling" && (typeof item.retryNotBefore !== "string" || !Number.isFinite(Date.parse(item.retryNotBefore)))) return false;
    return true;
  }

  private validResolved(value: unknown, prepared: A2ARemotePreparedAttempt): value is A2ARemoteResolvedFields {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const item = value as Record<string, unknown>;
    const allowed = new Set(["snapshotId", "credentialRevisionId", "resolvedAt", "snapshotIssuedAt", "snapshotExpiresAt", "operation", "method", "extensionUri", "lineage", "semanticRequestHash", "ownerDigestSha256", "projectRootDigestSha256", "profileDigestSha256", "originDigestSha256", "approvalDecisionId", "approvalDecidedAt", "taskHandle", "taskToken", "contextToken", "payloadRecordId", "payloadCiphertextSha256", "payloadBodySha256", "payloadSize"]);
    if (!Object.keys(item).every((key) => allowed.has(key))) return false;
    if (typeof item.snapshotId !== "string" || !SAFE_TOKEN.test(item.snapshotId)
      || item.credentialRevisionId !== prepared.intendedCredentialRevisionId
      || item.operation !== prepared.operation || item.method !== prepared.method
      || item.extensionUri !== A2A_EXACT_SEND_REPLAY_URI
      || !this.validLineage(item.lineage)) return false;
    if (![item.resolvedAt, item.snapshotIssuedAt, item.snapshotExpiresAt].every((entry) => typeof entry === "string" && Number.isFinite(Date.parse(entry)))) return false;
    const binding = (key: keyof A2ARemotePreparedAttempt) => item[key] === prepared[key];
    for (const key of ["semanticRequestHash", "ownerDigestSha256", "projectRootDigestSha256", "profileDigestSha256", "originDigestSha256", "approvalDecisionId", "approvalDecidedAt", "taskHandle", "taskToken", "contextToken", "payloadRecordId", "payloadCiphertextSha256", "payloadBodySha256", "payloadSize"] as const) {
      if (!binding(key)) return false;
    }
    return JSON.stringify(item.lineage) === JSON.stringify(prepared.lineage);
  }

  private validPayload(value: unknown): value is EncryptedPayloadRecord {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const item = value as Record<string, unknown>;
    const keys = ["id", "operationId", "state", "ciphertext", "iv", "authTag", "aadSha256", "ciphertextSha256", "bodySha256", "size", "createdAt", "orphanDeadline", "expiresAt"];
    if (Object.keys(item).sort().join(",") !== keys.sort().join(",")) return false;
    if (![item.id, item.operationId].every((entry) => typeof entry === "string" && SAFE_TOKEN.test(entry)) || (item.state !== "staged" && item.state !== "bound")) return false;
    if (![item.aadSha256, item.ciphertextSha256, item.bodySha256].every((entry) => typeof entry === "string" && DIGEST.test(entry))) return false;
    if (![item.ciphertext, item.iv, item.authTag].every((entry) => typeof entry === "string" && entry.length > 0 && entry.length <= 2_000_000)) return false;
    if (!Number.isSafeInteger(item.size) || (item.size as number) < 1 || (item.size as number) > A2A_REMOTE_MAX_REQUEST_BYTES) return false;
    const ciphertext = decodeCanonicalBase64(item.ciphertext as string);
    const iv = decodeCanonicalBase64(item.iv as string);
    const authTag = decodeCanonicalBase64(item.authTag as string);
    const validEncoding = ciphertext?.byteLength === item.size
      && iv?.byteLength === 12
      && authTag?.byteLength === 16;
    ciphertext?.fill(0); iv?.fill(0); authTag?.fill(0);
    if (!validEncoding) return false;
    return [item.createdAt, item.orphanDeadline, item.expiresAt].every((entry) => typeof entry === "string" && Number.isFinite(Date.parse(entry)));
  }

  private async validateAndRecover(state: StoreState): Promise<StoreState> {
    const quarantine: QuarantineEntry[] = [];
    let routineRecoveryChanged = false;
    const abortedPayloadIds = new Set<string>();
    if (state.encryptedDataKey !== undefined) {
      try { const key = this.dataKey(state); key.fill(0); } catch { quarantine.push(this.quarantine("state", "encrypted-data-key-invalid", state.encryptedDataKey)); }
    }
    const uniqueAttempts = new Set<string>();
    const uniqueOwners = new Set<string>();
    const operationOwners = new Map<string, string>();
    const materialOperations = new Set<string>();
    state.attempts = state.attempts.filter((item) => {
      if (!this.validAttempt(item)) { quarantine.push(this.quarantine("attempt", "attempt-schema-invalid", item)); return false; }
      if (uniqueAttempts.has(item.prepared.attemptId) || uniqueOwners.has(item.prepared.ownerToken)) { quarantine.push(this.quarantine("attempt", "attempt-identity-duplicate", item)); return false; }
      const existingOwner = operationOwners.get(item.prepared.operationId);
      if (existingOwner && existingOwner !== item.prepared.ownerDigestSha256) { quarantine.push(this.quarantine("attempt", "operation-owner-conflict", item)); return false; }
      operationOwners.set(item.prepared.operationId, item.prepared.ownerDigestSha256!);
      const material = !(item.stage === "NOT_SENT" && item.outcomeCode === INTENDED_CREDENTIAL_REVISION_CONFLICT);
      if (material && item.prepared.operation !== "replay" && materialOperations.has(item.prepared.operationId)) { quarantine.push(this.quarantine("attempt", "operation-attempt-conflict", item)); return false; }
      if (material && item.prepared.operation !== "replay") materialOperations.add(item.prepared.operationId);
      if (item.stage === "prepared" || item.stage === "resolved") {
        if (item.prepared.payloadRecordId) abortedPayloadIds.add(item.prepared.payloadRecordId);
        this.scrubPayloadBinding(item);
        item.stage = "NOT_SENT";
        item.outcomeCode = "restart-before-socket-aborted";
        delete item.resolved;
        item.updatedAt = this.now().toISOString();
        routineRecoveryChanged = true;
      } else if (item.stage === "in-flight") {
        item.stage = "outcome-unknown";
        item.outcomeCode = "restart-in-flight-ambiguous";
        item.updatedAt = this.now().toISOString();
        routineRecoveryChanged = true;
      }
      uniqueAttempts.add(item.prepared.attemptId); uniqueOwners.add(item.prepared.ownerToken); return true;
    });
    const expiredBoundIds = new Set<string>();
    const payloadIds = new Set<string>();
    state.payloads = state.payloads.filter((item) => {
      if (!this.validPayload(item) || payloadIds.has(item.id)) { quarantine.push(this.quarantine("payload", "payload-schema-or-identity-invalid", item)); return false; }
      if (abortedPayloadIds.has(item.id)) { routineRecoveryChanged = true; return false; }
      payloadIds.add(item.id);
      const expired = Date.parse(item.expiresAt) <= this.now().getTime();
      const orphaned = item.state === "staged"
        && Date.parse(item.orphanDeadline) <= this.now().getTime();
      if (orphaned) { routineRecoveryChanged = true; return false; }
      if (expired && item.state === "bound") expiredBoundIds.add(item.id);
      const stagedCiphertext = item.state === "staged"
        ? decodeCanonicalBase64(item.ciphertext)
        : null;
      const cryptographyValid = item.state === "bound"
        ? this.payloadCryptographyValid(state, item)
        : stagedCiphertext !== null && sha256(stagedCiphertext) === item.ciphertextSha256;
      stagedCiphertext?.fill(0);
      if (!expired && !cryptographyValid) {
        quarantine.push(this.quarantine("payload", "payload-cryptography-invalid", item));
        return false;
      }
      return true;
    });
    const payloadReferences = new Map<string, number>();
    for (const attempt of state.attempts) if (attempt.prepared.payloadRecordId) payloadReferences.set(attempt.prepared.payloadRecordId, (payloadReferences.get(attempt.prepared.payloadRecordId) ?? 0) + 1);
    state.payloads = state.payloads.filter((payload) => {
      if (payload.state === "staged") return true;
      const references = payloadReferences.get(payload.id) ?? 0;
      const bound = state.attempts.find((attempt) => attempt.prepared.payloadRecordId === payload.id);
      const valid = payload.state === "bound" && references === 1 && bound?.prepared.operationId === payload.operationId
        && bound.prepared.payloadCiphertextSha256 === payload.ciphertextSha256
        && bound.prepared.payloadBodySha256 === payload.bodySha256 && bound.prepared.payloadSize === payload.size;
      if (!valid) quarantine.push(this.quarantine("payload", "payload-binding-invalid", payload));
      return valid;
    });
    for (const payloadId of expiredBoundIds) {
      const source = state.attempts.find((attempt) =>
        attempt.prepared.payloadRecordId === payloadId);
      if (source) {
        this.terminalizePayloadOperation(state, source);
        routineRecoveryChanged = true;
      }
    }
    const retainedPayloadIds = new Set(state.payloads.map((item) => item.id));
    const missingSources = state.attempts.filter((attempt) =>
      attempt.prepared.operation === "initial-send"
      && attempt.prepared.payloadRecordId
      && !retainedPayloadIds.has(attempt.prepared.payloadRecordId)
      && ["prepared", "resolved", "in-flight", "outcome-unknown", "reconciling"].includes(attempt.stage));
    for (const source of missingSources) {
      this.terminalizePayloadOperation(state, source);
      routineRecoveryChanged = true;
    }
    const taskHandles = new Set<string>();
    state.tasks = state.tasks.filter((task) => {
      const valid = typeof task.handle === "string" && SAFE_TOKEN.test(task.handle)
        && !taskHandles.has(task.handle)
        && DIGEST.test(task.ownerDigestSha256) && this.validLineage(task.lineage)
        && Number.isSafeInteger(task.credentialRevisionId) && task.credentialRevisionId > 0
        && this.decryptTask(state, task)?.status.state === task.taskState;
      if (!valid) quarantine.push(this.quarantine("task", "task-record-invalid", task));
      if (valid) taskHandles.add(task.handle);
      return valid;
    });
    if (state.attempts.length > this.maxAttempts || state.payloads.length > this.maxPayloads || state.tasks.length > this.maxTasks) {
      quarantine.push(this.quarantine("state", "store-capacity-exceeded", { attempts: state.attempts.length, payloads: state.payloads.length, tasks: state.tasks.length }));
    }
    if (quarantine.length > 0) {
      this.recoveryBlocked = true;
      this.audit("startup-quarantine", quarantine.length);
      await this.options.namespace.writeJson(DEFAULT_QUARANTINE_FILE, { version: 1, entries: quarantine.slice(0, this.maxQuarantine) });
      await this.persist(state);
    } else if (routineRecoveryChanged) {
      await this.persist(state);
    }
    return state;
  }

  private async persist(state: StoreState): Promise<void> {
    await this.options.namespace.writeJson(this.fileName, state);
  }

  private async withAttemptCapacity(state: StoreState): Promise<StoreState> {
    if (state.attempts.length < this.maxAttempts) return state;
    const evictable = state.attempts
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => item.stage === "settled" || item.stage === "NOT_SENT" || item.stage === "RETENTION_EXPIRED")
      .sort((a, b) => Date.parse(a.item.updatedAt) - Date.parse(b.item.updatedAt))[0];
    if (!evictable) throw new Error("a2a-remote-attempt-capacity-exhausted");
    const compacted = structuredClone(state);
    compacted.attempts.splice(evictable.index, 1);
    await this.persist(compacted);
    this.state = compacted;
    return compacted;
  }

  private scrubPayloadBinding(record: A2ARemoteAttemptRecord): void {
    for (const key of [
      "payloadRecordId",
      "payloadCiphertextSha256",
      "payloadBodySha256",
      "payloadSize",
      "payloadExpiresAt",
    ] as const) delete record.prepared[key];
    if (record.resolved) {
      for (const key of [
        "payloadRecordId",
        "payloadCiphertextSha256",
        "payloadBodySha256",
        "payloadSize",
      ] as const) delete record.resolved[key];
    }
  }

  private terminalizePayloadOperation(
    state: StoreState,
    source: A2ARemoteAttemptRecord,
  ): A2ARemoteAttemptRecord {
    const payloadRecordId = source.prepared.payloadRecordId;
    if (payloadRecordId) {
      state.payloads = state.payloads.filter((item) => item.id !== payloadRecordId);
      this.scrubPayloadBinding(source);
    }
    const now = this.now().toISOString();
    let latest = source;
    for (const attempt of state.attempts) {
      if (attempt.prepared.operationId !== source.prepared.operationId) continue;
      if (["prepared", "resolved", "in-flight", "outcome-unknown", "reconciling"].includes(attempt.stage)) {
        attempt.stage = "RETENTION_EXPIRED";
        attempt.outcomeCode = "unknown-manual-reconciliation-required";
        delete attempt.retryNotBefore;
        attempt.updatedAt = now;
      }
      latest = attempt;
    }
    return latest;
  }

  private dataKey(state: StoreState): Buffer {
    if (!this.options.encryption.isEncryptionAvailable()) {
      throw new Error("a2a-remote-encryption-unavailable");
    }
    if (!state.encryptedDataKey) {
      const key = this.random(32);
      if (key.length !== 32) throw new Error("a2a-remote-key-invalid");
      state.encryptedDataKey = this.options.encryption
        .encryptString(key.toString("base64"))
        .toString("base64");
      return key;
    }
    const decoded = this.options.encryption.decryptString(
      Buffer.from(state.encryptedDataKey, "base64"),
    );
    const key = Buffer.from(decoded, "base64");
    if (key.length !== 32) throw new Error("a2a-remote-key-invalid");
    return key;
  }

  private payloadCryptographyValid(
    state: StoreState,
    payload: EncryptedPayloadRecord,
  ): boolean {
    const source = state.attempts.find((attempt) =>
      attempt.prepared.payloadRecordId === payload.id
      && attempt.prepared.operationId === payload.operationId
      && attempt.prepared.operation === "initial-send");
    if (!source?.prepared.ownerDigestSha256 || !source.prepared.messageId) return false;
    const aad = payloadAadFromOwnerDigest({
      ownerDigestSha256: source.prepared.ownerDigestSha256,
      operationId: source.prepared.operationId,
      messageId: source.prepared.messageId,
      bodySha256: payload.bodySha256,
      lineage: source.prepared.lineage,
    });
    if (payload.aadSha256 !== sha256(aad)) return false;
    const key = this.dataKey(state);
    let plaintext: Buffer | undefined;
    try {
      const ciphertext = decodeCanonicalBase64(payload.ciphertext);
      const iv = decodeCanonicalBase64(payload.iv);
      const authTag = decodeCanonicalBase64(payload.authTag);
      if (!ciphertext || !iv || !authTag
        || ciphertext.byteLength !== payload.size
        || sha256(ciphertext) !== payload.ciphertextSha256) return false;
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAAD(Buffer.from(aad, "utf8"));
      decipher.setAuthTag(authTag);
      plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return plaintext.byteLength === payload.size
        && sha256(plaintext) === payload.bodySha256;
    } catch {
      return false;
    } finally {
      plaintext?.fill(0);
      key.fill(0);
    }
  }

  private encryptPayload(
    state: StoreState,
    operationId: string,
    body: Uint8Array,
    aad: string,
  ): EncryptedPayloadRecord {
    if (body.byteLength === 0 || body.byteLength > A2A_REMOTE_MAX_REQUEST_BYTES) {
      throw new Error("a2a-remote-payload-size-invalid");
    }
    const key = this.dataKey(state);
    const iv = this.random(12);
    if (iv.length !== 12) throw new Error("a2a-remote-iv-invalid");
    try {
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(aad, "utf8"));
      const encrypted = Buffer.concat([cipher.update(body), cipher.final()]);
      const now = this.now().getTime();
      return {
        id: this.makeId(),
        operationId,
        state: "staged",
        ciphertext: encrypted.toString("base64"),
        iv: iv.toString("base64"),
        authTag: cipher.getAuthTag().toString("base64"),
        aadSha256: sha256(aad),
        ciphertextSha256: sha256(encrypted),
        bodySha256: sha256(body),
        size: body.byteLength,
        createdAt: new Date(now).toISOString(),
        orphanDeadline: new Date(now + this.orphanTtlMs).toISOString(),
        expiresAt: new Date(now + this.recoveryTtlMs).toISOString(),
      };
    } finally {
      key.fill(0);
    }
  }

  private taskAad(input: Readonly<{
    handle: string;
    ownerDigestSha256: string;
    operationId: string;
    targetAgentId: number;
    lineage: A2ARemoteLineage;
  }>): string {
    return JSON.stringify({
      version: 1,
      kind: "remote-task",
      handle: input.handle,
      ownerDigestSha256: input.ownerDigestSha256,
      operationId: input.operationId,
      targetAgentId: input.targetAgentId,
      lineageDigestSha256: sha256(JSON.stringify(Object.fromEntries(
        Object.entries(input.lineage).sort(([a], [b]) => compareCodePoints(a, b)),
      ))),
    });
  }

  private encryptTask(
    state: StoreState,
    input: Readonly<{
      handle: string;
      ownerId: string;
      operationId: string;
      targetAgentId: number;
      targetLabel: string;
      lineage: A2ARemoteLineage;
      credentialRevisionId: number;
      task: A2ATask;
      createdAt?: string;
    }>,
  ): EncryptedRemoteTaskRecord {
    if (!/^[A-Za-z0-9_-]{16,256}$/.test(input.handle) || input.targetLabel.length < 1 || input.targetLabel.length > 80) {
      throw new Error("a2a-remote-task-route-invalid");
    }
    const ownerDigestSha256 = sha256(input.ownerId);
    const aad = this.taskAad({ ...input, ownerDigestSha256 });
    const plaintext = Buffer.from(JSON.stringify(input.task), "utf8");
    if (plaintext.byteLength === 0 || plaintext.byteLength > A2A_REMOTE_MAX_REQUEST_BYTES) {
      plaintext.fill(0);
      throw new Error("a2a-remote-task-size-invalid");
    }
    const key = this.dataKey(state);
    const iv = this.random(12);
    if (iv.length !== 12) {
      key.fill(0);
      plaintext.fill(0);
      throw new Error("a2a-remote-iv-invalid");
    }
    try {
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(aad, "utf8"));
      const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const timestamp = this.now().toISOString();
      return {
        handle: input.handle,
        ownerDigestSha256,
        operationId: input.operationId,
        targetAgentId: input.targetAgentId,
        targetLabel: input.targetLabel,
        lineage: structuredClone(input.lineage),
        credentialRevisionId: input.credentialRevisionId,
        taskState: input.task.status.state,
        ciphertext: encrypted.toString("base64"),
        iv: iv.toString("base64"),
        authTag: cipher.getAuthTag().toString("base64"),
        aadSha256: sha256(aad),
        ciphertextSha256: sha256(encrypted),
        createdAt: input.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
    } finally {
      key.fill(0);
      plaintext.fill(0);
    }
  }

  private decryptTask(state: StoreState, record: EncryptedRemoteTaskRecord): A2ATask | null {
    const aad = this.taskAad(record);
    if (record.aadSha256 !== sha256(aad)) return null;
    const key = this.dataKey(state);
    try {
      const ciphertext = Buffer.from(record.ciphertext, "base64");
      if (sha256(ciphertext) !== record.ciphertextSha256) return null;
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(record.iv, "base64"));
      decipher.setAAD(Buffer.from(aad, "utf8"));
      decipher.setAuthTag(Buffer.from(record.authTag, "base64"));
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      try {
        return JSON.parse(plaintext.toString("utf8")) as A2ATask;
      } finally {
        plaintext.fill(0);
      }
    } catch {
      return null;
    } finally {
      key.fill(0);
    }
  }

  async prepare(
    prepared: A2ARemotePreparedAttempt,
    initialPayload?: Readonly<{ body: Uint8Array; aad: string }>,
  ): Promise<PrepareAttemptResult> {
    return await this.withLock(async (state) => {
      if (this.recoveryBlocked) throw new Error("a2a-remote-recovery-quarantined");
      if (Date.parse(prepared.attemptDeadline) <= this.now().getTime()) throw new Error("a2a-remote-attempt-deadline-expired");
      const sameAttempt = state.attempts.find((item) =>
        item.prepared.attemptId === prepared.attemptId);
      if (sameAttempt) {
        return JSON.stringify(sameAttempt.prepared) === JSON.stringify(prepared)
          ? { ok: true, duplicate: true, record: cloneRecord(sameAttempt) }
          : { ok: false, reason: "attempt-conflict" };
      }
      state = await this.withAttemptCapacity(state);
      const priorAttempts = state.attempts.filter((item) => item.prepared.operationId === prepared.operationId);
      const live = state.attempts.find((item) =>
        item.prepared.operationId === prepared.operationId
        && ["prepared", "resolved", "in-flight"].includes(item.stage));
      if (
        live
        && live.prepared.intendedCredentialRevisionId !== prepared.intendedCredentialRevisionId
      ) return { ok: false, reason: "intended-revision-conflict" };
      const materialPriorAttempts = priorAttempts.filter((item) =>
        !(item.stage === "NOT_SENT" && item.outcomeCode === INTENDED_CREDENTIAL_REVISION_CONFLICT));
      if (materialPriorAttempts.length > 0 && prepared.operation !== "replay") {
        return { ok: false, reason: "attempt-conflict" };
      }
      if (prepared.operation === "replay") {
        const source = priorAttempts.find((item) => item.prepared.operation === "initial-send" && item.prepared.payloadRecordId);
        const sourcePayload = source?.prepared.payloadRecordId
          ? state.payloads.find((payload) => payload.id === source.prepared.payloadRecordId)
          : undefined;
        if (!source || !sourcePayload || Date.parse(sourcePayload.expiresAt) <= this.now().getTime()) {
          return { ok: false, reason: "attempt-conflict" };
        }
        const replayAttempts = priorAttempts.filter((item) => item.prepared.operation === "replay");
        if (replayAttempts.some((item) => item.stage === "settled" || item.stage === "RETENTION_EXPIRED")) {
          return { ok: false, reason: "attempt-conflict" };
        }
        const now = this.now().getTime();
        const retryWindowOpen = priorAttempts.some((item) => {
          if (item.stage !== "reconciling") return false;
          const retryAt = item.retryNotBefore ? Date.parse(item.retryNotBefore) : Number.NaN;
          return !Number.isFinite(retryAt) || retryAt > now;
        });
        if (retryWindowOpen) return { ok: false, reason: "attempt-conflict" };
        const liveReplay = replayAttempts.find((item) =>
          ["prepared", "resolved", "in-flight"].includes(item.stage)
        );
        if (liveReplay) return { ok: false, reason: "attempt-conflict" };
      }
      let payload: EncryptedPayloadRecord | undefined;
      if (initialPayload) {
        if (state.payloads.length >= this.maxPayloads) throw new Error("a2a-remote-payload-capacity-exhausted");
        payload = this.encryptPayload(state, prepared.operationId, initialPayload.body, initialPayload.aad);
        const stagedState = structuredClone(state);
        stagedState.payloads.push(structuredClone(payload));
        await this.persist(stagedState);
        this.state = stagedState;
        state = stagedState;
      }

      const boundPrepared = structuredClone(prepared);
      if (payload) {
        boundPrepared.payloadRecordId = payload.id;
        boundPrepared.payloadCiphertextSha256 = payload.ciphertextSha256;
        boundPrepared.payloadBodySha256 = payload.bodySha256;
        boundPrepared.payloadSize = payload.size;
        boundPrepared.payloadExpiresAt = payload.expiresAt;
        payload = { ...payload, state: "bound" };
      }
      const record: A2ARemoteAttemptRecord = {
        prepared: boundPrepared,
        stage: "prepared",
        updatedAt: this.now().toISOString(),
      };
      const next = structuredClone(state);
      if (payload) {
        const index = next.payloads.findIndex((item) => item.id === payload!.id);
        if (index < 0) throw new Error("a2a-remote-staged-payload-lost");
        next.payloads[index] = payload;
      }
      next.attempts.push(record);
      try {
        await this.persist(next);
        this.state = next;
      } catch (error) {
        if (payload) {
          const rollback = structuredClone(state);
          rollback.payloads = rollback.payloads.filter((item) => item.id !== payload!.id);
          try {
            await this.persist(rollback);
            this.state = rollback;
          } catch {
            // Restart orphan cleanup owns an undeletable staged ciphertext.
          }
        }
        throw error;
      }
      return { ok: true, duplicate: false, record: cloneRecord(record) };
    });
  }

  /** Persist a deterministic pre-secret/pre-payload loser without widening send authority. */
  async recordNotSent(
    prepared: A2ARemotePreparedAttempt,
    outcomeCode: typeof INTENDED_CREDENTIAL_REVISION_CONFLICT,
  ): Promise<A2ARemoteAttemptRecord> {
    return await this.withLock(async (state) => {
      const sameAttempt = state.attempts.find((item) => item.prepared.attemptId === prepared.attemptId);
      if (sameAttempt) {
        if (sameAttempt.stage !== "NOT_SENT" || sameAttempt.outcomeCode !== outcomeCode
          || JSON.stringify(sameAttempt.prepared) !== JSON.stringify(prepared)) {
          throw new Error("a2a-remote-attempt-conflict");
        }
        return cloneRecord(sameAttempt);
      }
      state = await this.withAttemptCapacity(state);
      const record: A2ARemoteAttemptRecord = {
        prepared: structuredClone(prepared),
        stage: "NOT_SENT",
        outcomeCode,
        updatedAt: this.now().toISOString(),
      };
      const next = structuredClone(state);
      next.attempts.push(record);
      await this.persist(next);
      this.state = next;
      return cloneRecord(record);
    });
  }

  async resolveCas(
    attemptId: string,
    fields: A2ARemoteResolvedFields,
  ): Promise<A2ARemoteAttemptRecord | null> {
    return await this.withLock(async (state) => {
      const index = state.attempts.findIndex((item) => item.prepared.attemptId === attemptId);
      if (index < 0 || state.attempts[index]!.stage !== "prepared") return null;
      const current = state.attempts[index]!;
      if (fields.credentialRevisionId !== current.prepared.intendedCredentialRevisionId) return null;
      const expectedBinding = {
        operation: current.prepared.operation,
        method: current.prepared.method,
        lineage: current.prepared.lineage,
        semanticRequestHash: current.prepared.semanticRequestHash,
        ownerDigestSha256: current.prepared.ownerDigestSha256,
        projectRootDigestSha256: current.prepared.projectRootDigestSha256,
        profileDigestSha256: current.prepared.profileDigestSha256,
        originDigestSha256: current.prepared.originDigestSha256,
        approvalDecisionId: current.prepared.approvalDecisionId,
        approvalDecidedAt: current.prepared.approvalDecidedAt,
        taskHandle: current.prepared.taskHandle,
        taskToken: current.prepared.taskToken,
        contextToken: current.prepared.contextToken,
        payloadRecordId: current.prepared.payloadRecordId,
        payloadCiphertextSha256: current.prepared.payloadCiphertextSha256,
        payloadBodySha256: current.prepared.payloadBodySha256,
        payloadSize: current.prepared.payloadSize,
      };
      const providedBinding = {
        operation: fields.operation,
        method: fields.method,
        lineage: fields.lineage,
        semanticRequestHash: fields.semanticRequestHash,
        ownerDigestSha256: fields.ownerDigestSha256,
        projectRootDigestSha256: fields.projectRootDigestSha256,
        profileDigestSha256: fields.profileDigestSha256,
        originDigestSha256: fields.originDigestSha256,
        approvalDecisionId: fields.approvalDecisionId,
        approvalDecidedAt: fields.approvalDecidedAt,
        taskHandle: fields.taskHandle,
        taskToken: fields.taskToken,
        contextToken: fields.contextToken,
        payloadRecordId: fields.payloadRecordId,
        payloadCiphertextSha256: fields.payloadCiphertextSha256,
        payloadBodySha256: fields.payloadBodySha256,
        payloadSize: fields.payloadSize,
      };
      if (fields.extensionUri !== A2A_EXACT_SEND_REPLAY_URI
        || JSON.stringify(providedBinding) !== JSON.stringify(expectedBinding)) return null;
      if (current.prepared.predecessorCredentialRevisionId) {
        const predecessor = [...state.attempts].reverse().find((item) =>
          (item.prepared.operationId === current.prepared.operationId
            || (current.prepared.taskHandle !== undefined
              && item.prepared.taskHandle === current.prepared.taskHandle))
          && item.prepared.attemptId !== attemptId
          && item.resolved !== undefined);
        if (
          !predecessor?.resolved
          || predecessor.resolved.credentialRevisionId
            !== current.prepared.predecessorCredentialRevisionId
        ) return null;
      }
      const next = structuredClone(state);
      const record = next.attempts[index]!;
      record.stage = "resolved";
      record.resolved = structuredClone(fields);
      record.updatedAt = this.now().toISOString();
      await this.persist(next);
      this.state = next;
      return cloneRecord(record);
    });
  }

  async transition(
    attemptId: string,
    expected: readonly A2ARemoteDeliveryState[],
    stage: A2ARemoteDeliveryState,
    update: Readonly<{
      outcomeCode?: string;
      deletePayload?: boolean;
      retryAfterSeconds?: number;
      taskProjection?: Readonly<{
        handle: string;
        ownerId: string;
        targetAgentId: number;
        targetLabel: string;
        lineage: A2ARemoteLineage;
        credentialRevisionId: number;
        task: A2ATask;
      }>;
    }> = {},
  ): Promise<A2ARemoteAttemptRecord | null> {
    return await this.withLock(async (state) => {
      const index = state.attempts.findIndex((item) => item.prepared.attemptId === attemptId);
      if (index < 0 || !expected.includes(state.attempts[index]!.stage)) return null;
      const next = structuredClone(state);
      const record = next.attempts[index]!;
      record.stage = stage;
      if (stage === "reconciling") {
        if (update.retryAfterSeconds !== 1) throw new Error("a2a-remote-retry-after-invalid");
        record.retryNotBefore = new Date(this.now().getTime() + 1_000).toISOString();
      }
      if (update.outcomeCode !== undefined) record.outcomeCode = update.outcomeCode;
      record.updatedAt = this.now().toISOString();
      if (update.deletePayload) {
        let source = record;
        if (record.prepared.operation === "replay") {
          // A pre-socket replay failure is not a terminal observation and must
          // leave the original bytes available for a later approved replay.
          if (stage === "settled") {
            const candidates = next.attempts.filter((item) =>
              item.prepared.operationId === record.prepared.operationId
              && item.prepared.operation === "initial-send"
              && item.prepared.payloadRecordId !== undefined);
            if (candidates.length !== 1) {
              throw new Error("a2a-remote-replay-source-binding-invalid");
            }
            source = candidates[0]!;
            const stableBindingMatches =
              source.prepared.ownerDigestSha256 === record.prepared.ownerDigestSha256
              && source.prepared.projectRootDigestSha256 === record.prepared.projectRootDigestSha256
              && source.prepared.profileDigestSha256 === record.prepared.profileDigestSha256
              && source.prepared.originDigestSha256 === record.prepared.originDigestSha256
              && source.prepared.depth === record.prepared.depth
              && source.prepared.semanticRequestHash === record.prepared.semanticRequestHash
              && source.prepared.messageId === record.prepared.messageId
              && source.prepared.approvalDecisionId === record.prepared.approvalDecisionId
              && source.prepared.approvalDecidedAt === record.prepared.approvalDecidedAt
              && source.prepared.createdAt === record.prepared.createdAt
              && source.prepared.attemptDeadline === record.prepared.attemptDeadline
              && JSON.stringify(source.prepared.lineage) === JSON.stringify(record.prepared.lineage);
            const payload = next.payloads.find((item) =>
              item.id === source.prepared.payloadRecordId);
            const payloadBindingMatches = payload?.state === "bound"
              && payload.operationId === source.prepared.operationId
              && payload.ciphertextSha256 === source.prepared.payloadCiphertextSha256
              && payload.bodySha256 === source.prepared.payloadBodySha256
              && payload.size === source.prepared.payloadSize
              && payload.expiresAt === source.prepared.payloadExpiresAt
              && next.attempts.filter((item) =>
                item.prepared.payloadRecordId === payload.id).length === 1;
            if (!stableBindingMatches || !payloadBindingMatches) {
              throw new Error("a2a-remote-replay-source-binding-invalid");
            }
          }
        }
        if (source.prepared.payloadRecordId) {
          const payloadRecordId = source.prepared.payloadRecordId;
          next.payloads = next.payloads.filter((item) => item.id !== payloadRecordId);
          // Scrub stale pointers in the same durable write. This lets restart
          // validation distinguish an intentional terminal deletion from a
          // missing/corrupt active payload while retaining all semantic proof.
          this.scrubPayloadBinding(source);
        }
      }
      if (update.taskProjection) {
        const taskInput = update.taskProjection;
        if (taskInput.lineage.targetAgentId !== taskInput.targetAgentId
          || record.prepared.operationId !== state.attempts[index]!.prepared.operationId
          || record.resolved?.credentialRevisionId !== taskInput.credentialRevisionId) {
          throw new Error("a2a-remote-task-route-mismatch");
        }
        const existingIndex = next.tasks.findIndex((item) => item.handle === taskInput.handle);
        const existing = existingIndex >= 0 ? next.tasks[existingIndex]! : undefined;
        if (existing) {
          const current = this.decryptTask(state, existing);
          if (!current || current.id !== taskInput.task.id || current.contextId !== taskInput.task.contextId
            || !canTransitionA2ATaskState(current.status.state, taskInput.task.status.state)) {
            throw new Error("a2a-remote-task-transition-invalid");
          }
        }
        const encrypted = this.encryptTask(next, {
          ...taskInput,
          operationId: record.prepared.operationId,
          task: structuredClone(taskInput.task),
          ...(existing ? { createdAt: existing.createdAt } : {}),
        });
        if (existingIndex >= 0) next.tasks[existingIndex] = encrypted;
        else {
          if (next.tasks.length >= this.maxTasks) {
            const evictable = next.tasks
              .map((item, index) => ({ item, index }))
              .filter(({ item }) => isA2ATerminalTaskState(item.taskState))
              .sort((a, b) => Date.parse(a.item.updatedAt) - Date.parse(b.item.updatedAt))[0];
            if (!evictable) throw new Error("a2a-remote-task-capacity-exhausted");
            next.tasks.splice(evictable.index, 1);
          }
          next.tasks.push(encrypted);
        }
        if (record.prepared.operation === "get") {
          for (const prior of next.attempts) {
            if (prior.prepared.taskHandle !== taskInput.handle
              || (prior.prepared.operation !== "continue" && prior.prepared.operation !== "cancel")
              || (prior.stage !== "outcome-unknown" && prior.stage !== "reconciling")) continue;
            const reconciled = prior.prepared.operation === "cancel"
              ? taskInput.task.status.state === "TASK_STATE_CANCELED"
              : taskInput.task.status.state !== "TASK_STATE_INPUT_REQUIRED";
            if (!reconciled) continue;
            prior.stage = "settled";
            prior.outcomeCode = "success";
            delete prior.retryNotBefore;
            prior.updatedAt = this.now().toISOString();
          }
        }
      }
      await this.persist(next);
      this.state = next;
      return cloneRecord(record);
    });
  }

  async readPayload(attemptId: string, aad: string): Promise<Uint8Array | null> {
    return await this.withLock((state) => {
      const attempt = state.attempts.find((item) => item.prepared.attemptId === attemptId);
      const payload = attempt?.prepared.payloadRecordId
        ? state.payloads.find((item) => item.id === attempt.prepared.payloadRecordId)
        : undefined;
      if (!attempt || !payload || payload.state !== "bound") return null;
      if (Date.parse(payload.expiresAt) <= this.now().getTime() || payload.aadSha256 !== sha256(aad)) {
        return null;
      }
      const key = this.dataKey(state);
      try {
        const ciphertext = Buffer.from(payload.ciphertext, "base64");
        if (sha256(ciphertext) !== payload.ciphertextSha256) return null;
        const decipher = createDecipheriv(
          "aes-256-gcm",
          key,
          Buffer.from(payload.iv, "base64"),
        );
        decipher.setAAD(Buffer.from(aad, "utf8"));
        decipher.setAuthTag(Buffer.from(payload.authTag, "base64"));
        const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        if (plaintext.byteLength !== payload.size) return null;
        return Uint8Array.from(plaintext);
      } catch {
        return null;
      } finally {
        key.fill(0);
      }
    });
  }

  async terminalizeUnrecoverableReplay(input: Readonly<{
    sourceAttemptId: string;
    operationId: string;
    ownerDigestSha256: string;
    projectRootDigestSha256: string;
    profileDigestSha256: string;
    originDigestSha256: string;
    lineage: A2ARemoteLineage;
    messageId: string;
    semanticRequestHash: string;
  }>): Promise<A2ARemoteAttemptRecord> {
    return await this.withLock(async (state) => {
      const sourceIndex = state.attempts.findIndex((item) =>
        item.prepared.attemptId === input.sourceAttemptId
        && item.prepared.operationId === input.operationId
        && item.prepared.operation === "initial-send");
      if (sourceIndex < 0) throw new Error("a2a-remote-replay-source-binding-invalid");
      const source = state.attempts[sourceIndex]!;
      if (source.prepared.ownerDigestSha256 !== input.ownerDigestSha256
        || source.prepared.projectRootDigestSha256 !== input.projectRootDigestSha256
        || source.prepared.profileDigestSha256 !== input.profileDigestSha256
        || source.prepared.originDigestSha256 !== input.originDigestSha256
        || source.prepared.messageId !== input.messageId
        || source.prepared.semanticRequestHash !== input.semanticRequestHash
        || JSON.stringify(source.prepared.lineage) !== JSON.stringify(input.lineage)) {
        throw new Error("a2a-remote-replay-source-binding-invalid");
      }
      const next = structuredClone(state);
      const latest = this.terminalizePayloadOperation(next, next.attempts[sourceIndex]!);
      await this.persist(next);
      this.state = next;
      return cloneRecord(latest);
    });
  }

  async getAttempt(attemptId: string): Promise<A2ARemoteAttemptRecord | null> {
    return await this.withLock((state) => {
      const value = state.attempts.find((item) => item.prepared.attemptId === attemptId);
      return value ? cloneRecord(value) : null;
    });
  }

  async latestOperation(operationId: string): Promise<A2ARemoteAttemptRecord | null> {
    return await this.withLock((state) => {
      const value = [...state.attempts]
        .reverse()
        .find((item) => item.prepared.operationId === operationId
          && !(item.stage === "NOT_SENT"
            && item.outcomeCode === INTENDED_CREDENTIAL_REVISION_CONFLICT));
      return value ? cloneRecord(value) : null;
    });
  }

  async findReplaySource(operationId: string): Promise<A2ARemoteAttemptRecord | null> {
    return await this.withLock((state) => {
      const value = [...state.attempts].reverse().find((item) =>
        item.prepared.operationId === operationId
        && item.prepared.operation === "initial-send"
        && item.prepared.payloadRecordId !== undefined
        && item.prepared.payloadBodySha256 !== undefined);
      return value ? cloneRecord(value) : null;
    });
  }

  async latestResolvedAttempt(operationId: string): Promise<A2ARemoteAttemptRecord | null> {
    return await this.withLock((state) => {
      const value = [...state.attempts].reverse().find((item) =>
        item.prepared.operationId === operationId && item.resolved !== undefined);
      return value ? cloneRecord(value) : null;
    });
  }

  async getTaskProjection(handle: string, ownerId: string): Promise<A2ARemoteTaskProjection | null> {
    return await this.withLock((state) => {
      const value = state.tasks.find((item) => item.handle === handle && item.ownerDigestSha256 === sha256(ownerId));
      return value ? structuredClone({
        handle: value.handle,
        targetAgentId: value.targetAgentId,
        targetLabel: value.targetLabel,
        state: value.taskState,
        updatedAt: value.updatedAt,
        terminal: isA2ATerminalTaskState(value.taskState),
      }) : null;
    });
  }

  async getTaskRoute(handle: string, ownerId: string): Promise<A2ARemoteTaskRoute | null> {
    return await this.withLock((state) => {
      const value = state.tasks.find((item) => item.handle === handle && item.ownerDigestSha256 === sha256(ownerId));
      if (!value) return null;
      const task = this.decryptTask(state, value);
      if (!task || task.status.state !== value.taskState) throw new Error("a2a-remote-task-record-corrupt");
      const initial = state.attempts.find((item) =>
        item.prepared.operationId === value.operationId && item.prepared.operation === "initial-send");
      return structuredClone({
        handle: value.handle,
        operationId: value.operationId,
        targetAgentId: value.targetAgentId,
        targetLabel: value.targetLabel,
        lineage: value.lineage,
        credentialRevisionId: value.credentialRevisionId,
        remoteTaskId: task.id,
        ...(task.contextId ? { remoteContextId: task.contextId } : {}),
        ...(initial?.prepared.messageId ? { messageId: initial.prepared.messageId } : {}),
        state: task.status.state,
      });
    });
  }

  async hasTaskAction(handle: string, operation: A2ARemotePreparedAttempt["operation"]): Promise<boolean> {
    return await this.withLock((state) => state.attempts.some((item) =>
      item.prepared.taskHandle === handle && item.prepared.operation === operation));
  }

  async taskActionDisposition(
    handle: string,
    operation: A2ARemotePreparedAttempt["operation"],
    ownerId: string,
  ): Promise<A2ARemoteTaskActionDisposition> {
    return await this.withLock((state) => {
      const latest = [...state.attempts].reverse().find((item) =>
        item.prepared.taskHandle === handle && item.prepared.operation === operation);
      if (!latest) return { kind: "none" };
      if (latest.prepared.ownerDigestSha256 !== sha256(ownerId)) return { kind: "blocked", outcome: "task-owner-mismatch" };
      if (latest.stage === "settled" && latest.outcomeCode === "success") {
        const task = state.tasks.find((item) => item.handle === handle && item.ownerDigestSha256 === sha256(ownerId));
        if (task
          && (operation !== "cancel" || task.taskState === "TASK_STATE_CANCELED")
          && Date.parse(task.updatedAt) >= Date.parse(latest.updatedAt)) {
          return { kind: "success", projection: {
            handle: task.handle,
            targetAgentId: task.targetAgentId,
            targetLabel: task.targetLabel,
            state: task.taskState,
            updatedAt: task.updatedAt,
            terminal: isA2ATerminalTaskState(task.taskState),
          } };
        }
      }
      return { kind: "blocked", outcome: latest.outcomeCode ?? latest.stage };
    });
  }

  async getOperationRecoveryRoute(
    handle: string,
    ownerId: string,
  ): Promise<A2ARemoteOperationRecoveryRoute | null> {
    return await this.withLock((state) => {
      const attempts = state.attempts.filter((item) =>
        item.prepared.taskHandle === handle
        && !(item.stage === "NOT_SENT"
          && item.outcomeCode === INTENDED_CREDENTIAL_REVISION_CONFLICT));
      const initial = attempts.find((item) =>
        item.prepared.operation === "initial-send"
        && item.prepared.payloadRecordId !== undefined);
      const operationAttempts = initial
        ? attempts.filter((item) => item.prepared.operationId === initial.prepared.operationId)
        : [];
      const latest = operationAttempts.at(-1);
      const latestResolved = [...operationAttempts].reverse().find((item) => item.resolved)?.resolved;
      const sourcePayload = initial?.prepared.payloadRecordId
        ? state.payloads.find((payload) =>
            payload.id === initial.prepared.payloadRecordId
            && payload.operationId === initial.prepared.operationId
            && payload.state === "bound")
        : undefined;
      if (!initial?.prepared.messageId || !initial.prepared.targetLabel
        || initial.prepared.ownerDigestSha256 !== sha256(ownerId)
        || !sourcePayload
        || !latestResolved
        || !latest
        || (latest.prepared.operation !== "initial-send" && latest.prepared.operation !== "replay")
        || (latest.stage !== "outcome-unknown" && latest.stage !== "reconciling")) return null;
      return structuredClone({
        handle,
        operationId: initial.prepared.operationId,
        targetAgentId: initial.prepared.lineage.targetAgentId,
        targetLabel: initial.prepared.targetLabel,
        lineage: initial.prepared.lineage,
        messageId: initial.prepared.messageId,
        credentialRevisionId: latestResolved.credentialRevisionId,
        ...(latest.retryNotBefore ? { retryNotBefore: latest.retryNotBefore } : {}),
      });
    });
  }

  async cleanup(): Promise<{ orphaned: number; expired: number }> {
    return await this.withLock(async (state) => {
      const now = this.now().getTime();
      const expiredIds = new Set(state.payloads
        .filter((item) => Date.parse(item.expiresAt) <= now)
        .map((item) => item.id));
      const orphanIds = new Set(state.payloads
        .filter((item) => item.state === "staged" && Date.parse(item.orphanDeadline) <= now)
        .map((item) => item.id));
      if (expiredIds.size === 0 && orphanIds.size === 0) return { orphaned: 0, expired: 0 };
      const next = structuredClone(state);
      for (const payloadId of expiredIds) {
        const source = next.attempts.find((attempt) =>
          attempt.prepared.payloadRecordId === payloadId);
        if (source) this.terminalizePayloadOperation(next, source);
        else next.payloads = next.payloads.filter((item) => item.id !== payloadId);
      }
      next.payloads = next.payloads.filter((item) => !orphanIds.has(item.id));
      await this.persist(next);
      this.state = next;
      return { orphaned: orphanIds.size, expired: expiredIds.size };
    });
  }
}

export function createA2APayloadAad(input: Readonly<{
  ownerId: string;
  operationId: string;
  messageId: string;
  bodySha256: string;
  lineage: A2ARemoteLineage;
}>): string {
  return payloadAadFromOwnerDigest({
    ownerDigestSha256: sha256(input.ownerId),
    operationId: input.operationId,
    messageId: input.messageId,
    bodySha256: input.bodySha256,
    lineage: input.lineage,
  });
}
