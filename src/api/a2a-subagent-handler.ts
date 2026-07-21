import { isDeepStrictEqual } from "node:util";
import {
  A2ARole,
  A2ATaskState,
  canTransitionA2ATaskState,
  isA2AProjectedTaskState,
  isA2ATerminalTaskState,
  projectSubAgentResultState,
  type A2AJsonObject,
  type A2AMessage,
  type A2AProjectedTaskState,
  type A2ATask,
} from "../shared/a2a.js";
import {
  A2AHostJsonRpcErrorDefinition,
  A2AJsonRpcErrorDefinition,
  A2AJsonRpcMethod,
  StandardJsonRpcErrorDefinition,
  type A2AAgentCardTemplate,
  type A2ADirectJsonRpcMethod,
  type A2ADirectJsonRpcResult,
} from "../shared/a2a-wire.js";
import {
  canonicalizeInboundA2ASubAgentMessage,
  isSafeA2AMessageId,
} from "../engine/a2a-subagent-message-codec.js";
import {
  type A2AWireCancelResult,
  type A2AWireHostBinding,
  type A2AWireResumeBinding,
  type A2AWireRunSnapshot,
  type A2AWireSpawnCallbacks,
  type SubAgentSpawnCallbacks,
  type SubAgentSpawnResult,
} from "../engine/subagent-runner.js";
import { GUIDE_MAX_CHARS } from "../engine/turn/guidance-limits.js";
import { maskSensitiveData } from "../shared/dlp.js";
import { createDlpSafeUuid } from "../shared/dlp-safe-id.js";
import { A2AHandlerError, type A2ARequestHandler } from "./a2a-router.js";
import {
  A2ATaskStore,
  isA2ARfc3339Timestamp,
  type A2ATaskCreateResult,
  type A2ATaskContinuationResult,
  type A2ATaskRecord,
} from "./a2a-task-store.js";

const TEXT_MODE = "text/plain";
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/;
const CHILD_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;
const SEND_KEYS = new Set(["tenant", "message", "configuration", "metadata"]);
const SEND_CONFIGURATION_KEYS = new Set([
  "acceptedOutputModes",
  "taskPushNotificationConfig",
  "task_push_notification_config",
  "historyLength",
  "returnImmediately",
]);
const GET_KEYS = new Set(["tenant", "id", "historyLength"]);
const LIST_KEYS = new Set([
  "tenant",
  "contextId",
  "status",
  "pageSize",
  "pageToken",
  "historyLength",
  "statusTimestampAfter",
  "includeArtifacts",
]);
const CANCEL_KEYS = new Set(["tenant", "id", "metadata"]);
const PROTO_INT32_MAX = 2_147_483_647;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export const A2A_INPUT_REQUIRED_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
export const A2A_INPUT_REQUIRED_EXPIRY_RETRY_MS = 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => keys.has(key));
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function hasValidTenant(params: Record<string, unknown>): boolean {
  return !hasOwn(params, "tenant") || params.tenant === "";
}

function isSafeStructuralId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 256
    && !CONTROL_CHAR.test(value)
    && maskSensitiveData(value).detections.length === 0;
}

function isSafeChildSessionId(value: unknown): value is string {
  return typeof value === "string"
    && CHILD_SESSION_ID_PATTERN.test(value)
    && maskSensitiveData(value).detections.length === 0;
}

/** UUID-compatible context ID whose complete value passes the DLP scanner. */
export function createA2AContextId(): string {
  return createDlpSafeUuid();
}

function isValidHistoryLength(value: unknown): value is number {
  return Number.isInteger(value)
    && (value as number) >= 0
    && (value as number) <= PROTO_INT32_MAX;
}

function isBoundedMetadata(value: unknown): boolean {
  if (!isRecord(value)) return false;
  try {
    return JSON.stringify(value).length <= GUIDE_MAX_CHARS;
  } catch {
    return false;
  }
}

function invalidParams(): never {
  throw new A2AHandlerError(StandardJsonRpcErrorDefinition.INVALID_PARAMS);
}

interface ParsedSend {
  message: A2AMessage;
  prompt: string;
  detectionCount: number;
  historyLength?: number;
  returnImmediately: boolean;
}

function parseSend(params: A2AJsonObject): ParsedSend {
  if (!hasOnlyKeys(params, SEND_KEYS) || !hasValidTenant(params)) invalidParams();
  if (hasOwn(params, "metadata") && !isBoundedMetadata(params.metadata)) invalidParams();
  const configuration = params.configuration;
  if (configuration !== undefined && !isRecord(configuration)) invalidParams();
  if (configuration && !hasOnlyKeys(configuration, SEND_CONFIGURATION_KEYS)) invalidParams();
  if (
    configuration
    && (
      hasOwn(configuration, "taskPushNotificationConfig")
      || hasOwn(configuration, "task_push_notification_config")
    )
  ) {
    throw new A2AHandlerError(A2AJsonRpcErrorDefinition.PUSH_NOTIFICATION_NOT_SUPPORTED);
  }
  const acceptedOutputModes = configuration?.acceptedOutputModes;
  if (
    acceptedOutputModes !== undefined
    && (
      !Array.isArray(acceptedOutputModes)
      || !acceptedOutputModes.every((mode) => typeof mode === "string")
      || !acceptedOutputModes.includes(TEXT_MODE)
    )
  ) {
    throw new A2AHandlerError(A2AJsonRpcErrorDefinition.CONTENT_TYPE_NOT_SUPPORTED);
  }
  const historyLength = configuration?.historyLength;
  if (historyLength !== undefined && !isValidHistoryLength(historyLength)) invalidParams();
  const returnImmediately = configuration?.returnImmediately;
  if (returnImmediately !== undefined && typeof returnImmediately !== "boolean") invalidParams();

  const canonical = canonicalizeInboundA2ASubAgentMessage(params.message);
  if (!canonical.ok) {
    if (canonical.reason === "unsupported-part") {
      throw new A2AHandlerError(A2AJsonRpcErrorDefinition.CONTENT_TYPE_NOT_SUPPORTED);
    }
    invalidParams();
  }
  return {
    message: canonical.message,
    prompt: canonical.prompt,
    detectionCount: canonical.detectionCount,
    ...(historyLength !== undefined ? { historyLength } : {}),
    returnImmediately: returnImmediately === true,
  };
}

function parseGet(params: A2AJsonObject): { id: string; historyLength?: number } {
  if (!hasOnlyKeys(params, GET_KEYS) || !hasValidTenant(params)) invalidParams();
  if (!isSafeChildSessionId(params.id)) {
    invalidParams();
  }
  const historyLength = params.historyLength;
  if (historyLength !== undefined && !isValidHistoryLength(historyLength)) invalidParams();
  return {
    id: params.id,
    ...(historyLength !== undefined ? { historyLength } : {}),
  };
}

interface ParsedList {
  contextId?: string;
  state?: A2AProjectedTaskState;
  pageSize: number;
  pageToken?: string;
  historyLength?: number;
  statusTimestampAfter?: string;
  includeArtifacts: boolean;
}

function parseList(params: A2AJsonObject): ParsedList {
  if (!hasOnlyKeys(params, LIST_KEYS) || !hasValidTenant(params)) invalidParams();
  if (params.contextId !== undefined && !isSafeStructuralId(params.contextId)) invalidParams();
  let state: A2AProjectedTaskState | undefined;
  if (params.status !== undefined && params.status !== A2ATaskState.UNSPECIFIED) {
    if (!isA2AProjectedTaskState(params.status)) invalidParams();
    state = params.status;
  }
  const pageSize = params.pageSize ?? 50;
  if (!Number.isInteger(pageSize) || (pageSize as number) < 1 || (pageSize as number) > 100) {
    invalidParams();
  }
  if (
    params.pageToken !== undefined
    && (typeof params.pageToken !== "string" || params.pageToken.length > 2_048)
  ) {
    invalidParams();
  }
  if (params.historyLength !== undefined && !isValidHistoryLength(params.historyLength)) {
    invalidParams();
  }
  if (
    params.statusTimestampAfter !== undefined
    && (
      typeof params.statusTimestampAfter !== "string"
      || !isA2ARfc3339Timestamp(params.statusTimestampAfter)
    )
  ) {
    invalidParams();
  }
  if (params.includeArtifacts !== undefined && typeof params.includeArtifacts !== "boolean") {
    invalidParams();
  }
  return {
    ...(params.contextId ? { contextId: params.contextId } : {}),
    ...(state ? { state } : {}),
    pageSize: pageSize as number,
    ...(params.pageToken ? { pageToken: params.pageToken } : {}),
    ...(params.historyLength !== undefined
      ? { historyLength: params.historyLength as number }
      : {}),
    ...(params.statusTimestampAfter
      ? { statusTimestampAfter: params.statusTimestampAfter }
      : {}),
    includeArtifacts: params.includeArtifacts === true,
  };
}

function parseCancel(params: A2AJsonObject): string {
  if (!hasOnlyKeys(params, CANCEL_KEYS) || !hasValidTenant(params)) invalidParams();
  if (hasOwn(params, "metadata") && !isBoundedMetadata(params.metadata)) invalidParams();
  if (!isSafeChildSessionId(params.id)) {
    invalidParams();
  }
  return params.id;
}

function projectTask(
  task: A2ATask,
  historyLength: number | undefined,
  includeArtifacts = true,
): A2ATask {
  const projected = structuredClone(task);
  if (historyLength !== undefined) {
    projected.history = historyLength === 0
      ? []
      : (projected.history ?? []).slice(-historyLength);
  }
  if (!includeArtifacts) delete projected.artifacts;
  return projected;
}

function isExactTaskMessageReplay(task: A2ATask, message: A2AMessage): boolean {
  const assigned = {
    ...structuredClone(message),
    contextId: task.contextId,
    taskId: task.id,
  };
  const candidates = message.taskId
    ? [
        ...(task.history ?? []),
        ...(task.status.message ? [task.status.message] : []),
      ]
    : (task.history ?? []).slice(0, 1);
  return candidates.some((candidate) =>
    candidate.messageId === assigned.messageId
    && isDeepStrictEqual(candidate, assigned));
}

interface Cursor {
  version: 1;
  handlerId: string;
  updatedAt: string;
  taskId: string;
}

function encodeCursor(record: A2ATaskRecord): string {
  const cursor: Cursor = {
    version: 1,
    handlerId: record.handlerId,
    updatedAt: record.updatedAt,
    taskId: record.task.id,
  };
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string, handlerId: string): Cursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (
      !isRecord(parsed)
      || parsed.version !== 1
      || parsed.handlerId !== handlerId
      || !Number.isFinite(Date.parse(parsed.updatedAt as string))
      || !isSafeChildSessionId(parsed.taskId)
    ) {
      return null;
    }
    return parsed as unknown as Cursor;
  } catch {
    return null;
  }
}

function afterCursor(record: A2ATaskRecord, cursor: Cursor): boolean {
  return record.updatedAt < cursor.updatedAt
    || (record.updatedAt === cursor.updatedAt && record.task.id > cursor.taskId);
}

export interface A2ASubAgentLifecycleRunner {
  spawnFromA2AWire(
    request: { messageText: unknown },
    binding: A2AWireHostBinding,
    callbacks: A2AWireSpawnCallbacks,
  ): Promise<SubAgentSpawnResult>;
  resumeFromA2AWire(
    request: { resumeId: unknown; messageText: unknown },
    binding: A2AWireResumeBinding,
    callbacks?: SubAgentSpawnCallbacks,
  ): Promise<SubAgentSpawnResult>;
  getA2AWireRunSnapshot(
    childSessionId: string,
    binding: A2AWireResumeBinding,
  ): A2AWireRunSnapshot | null;
  cancelA2AWireRun(
    childSessionId: string,
    binding: A2AWireResumeBinding,
  ): Promise<A2AWireCancelResult>;
}

export interface A2ATaskLifecycleAuditEvent {
  type: "a2a-task-lifecycle";
  outcome: "masked" | "dropped" | "canceled";
  reason:
    | "dlp-masked"
    | "consent-denied"
    | "cross-origin"
    | "invalid-message"
    | "unknown-task"
    | "task-not-resumable"
    | "task-not-cancelable"
    | "task-budget-exceeded"
    | "task-expired"
    | "storage-failed"
    | "runner-failed";
  handlerId: string;
  taskId?: string;
  messageId?: string;
  detectionCount?: number;
  operation?: A2AMutationOperation;
}

export type A2AMutationOperation = "send-message" | "cancel-task";

/** Host-owned, redacted description of a requested wire mutation. */
export interface A2AMutationAuthorizationDescriptor {
  operation: A2AMutationOperation;
  handlerId: string;
  taskId?: string;
  messageId?: string;
}

export type A2AMutationAuthorizer = (
  descriptor: Readonly<A2AMutationAuthorizationDescriptor>,
) => boolean | Promise<boolean>;

export interface CreateA2ASubAgentHandlerOptions {
  id: string;
  card: A2AAgentCardTemplate;
  binding: A2AWireHostBinding;
  runner: A2ASubAgentLifecycleRunner;
  store: A2ATaskStore;
  authorizeMutation: A2AMutationAuthorizer;
  makeId?: () => string;
  audit?: (event: A2ATaskLifecycleAuditEvent) => void;
}

interface PendingTaskMutation {
  fingerprint: "cancel-task" | A2AMessage;
  promise: Promise<unknown>;
}

interface PendingInitialMutation {
  fingerprint: A2AMessage;
  promise: Promise<A2AInitialAdmissionStart>;
}

interface ExpiryRetryState {
  statusTimestamp: string;
  retryNotBefore: number;
}

interface A2AInitialStart {
  execution: Promise<A2ATaskRecord>;
  linked: Promise<void>;
  getLinkedTaskId: () => string | undefined;
  observeDetachedFailure: () => void;
}

type A2AInitialAdmissionStart =
  | { duplicate: true; record: A2ATaskRecord }
  | { duplicate: false; started: A2AInitialStart };

type A2AContinuationStart =
  | { duplicate: true; record: A2ATaskRecord }
  | {
      duplicate: false;
      record: A2ATaskRecord;
      execution: Promise<A2ATaskRecord>;
    };

export class A2ASubAgentHandler implements A2ARequestHandler {
  readonly id: string;
  readonly card: A2AAgentCardTemplate;
  private readonly makeId: () => string;
  private readonly initialInFlight = new Map<string, PendingInitialMutation>();
  private readonly pendingTaskMutations = new Map<string, PendingTaskMutation>();
  private readonly taskQueues = new Map<string, Promise<void>>();
  private readonly expiryRetries = new Map<string, ExpiryRetryState>();
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  private expiryQueue: Promise<void> = Promise.resolve();
  private expirySweepQueued = false;
  private expiryStarted = false;
  private expiryDisposed = false;
  private expiryBootReconciled = false;
  private expiryDisposePromise: Promise<void> | undefined;

  constructor(private readonly options: CreateA2ASubAgentHandlerOptions) {
    if (options.id !== options.binding.handlerId) {
      throw new Error("A2A handler binding id mismatch");
    }
    this.id = options.id;
    this.card = options.card;
    this.makeId = options.makeId ?? createA2AContextId;
  }

  private async withTaskLock<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.taskQueues.get(taskId) ?? Promise.resolve();
    const run = previous.then(operation, operation);
    const tail = run.then(() => undefined, () => undefined);
    this.taskQueues.set(taskId, tail);
    try {
      return await run;
    } finally {
      if (this.taskQueues.get(taskId) === tail) this.taskQueues.delete(taskId);
    }
  }

  private clearExpiryTimer(): void {
    if (!this.expiryTimer) return;
    clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
  }

  private scheduleExpirySweep(delayMs: number): void {
    this.clearExpiryTimer();
    if (!this.expiryStarted || this.expiryDisposed) return;
    const timer = setTimeout(() => {
      if (this.expiryTimer === timer) this.expiryTimer = undefined;
      void this.requestExpirySweep();
    }, Math.min(MAX_TIMER_DELAY_MS, Math.max(0, delayMs)));
    timer.unref();
    this.expiryTimer = timer;
  }

  private requestExpirySweep(): Promise<void> {
    if (!this.expiryStarted || this.expiryDisposed) return Promise.resolve();
    if (this.expirySweepQueued) return this.expiryQueue;
    this.expirySweepQueued = true;
    const scheduled = this.expiryQueue.then(async () => {
      this.expirySweepQueued = false;
      if (!this.expiryDisposed) await this.runExpirySweep();
    });
    this.expiryQueue = scheduled.catch(() => undefined);
    return scheduled;
  }

  private async reconcileExpiryBootRecords(): Promise<boolean> {
    let retryNeeded = false;
    const records = await this.options.store.list(this.id);
    for (const record of records) {
      if (isA2ATerminalTaskState(record.task.status.state)) continue;
      try {
        await this.withTaskLock(record.task.id, async () => {
          const current = await this.options.store.lookupTask(this.id, record.task.id);
          if (current.ok && !isA2ATerminalTaskState(current.record.task.status.state)) {
            await this.reconcile(current.record);
          }
        });
      } catch {
        retryNeeded = true;
        this.audit("storage-failed", "dropped", { taskId: record.task.id });
      }
    }
    return !retryNeeded;
  }

  private expiryDeadline(record: A2ATaskRecord): number | null {
    if (record.task.status.state !== A2ATaskState.INPUT_REQUIRED) return null;
    const enteredAt = Date.parse(record.task.status.timestamp ?? "");
    return Number.isFinite(enteredAt) ? enteredAt + A2A_INPUT_REQUIRED_TTL_MS : null;
  }

  private async expireInputRequiredTask(
    taskId: string,
    listedStatusTimestamp: string,
  ): Promise<void> {
    try {
      await this.withTaskLock(taskId, async () => {
        const lookup = await this.options.store.lookupTask(this.id, taskId);
        if (!lookup.ok) {
          this.expiryRetries.delete(taskId);
          return;
        }
        await this.reconcile(lookup.record);

        const revalidated = await this.options.store.lookupTask(this.id, taskId);
        if (!revalidated.ok) {
          this.expiryRetries.delete(taskId);
          return;
        }
        const record = revalidated.record;
        if (record.task.status.state !== A2ATaskState.INPUT_REQUIRED) {
          this.expiryRetries.delete(taskId);
          return;
        }
        const statusTimestamp = record.task.status.timestamp ?? "";
        const existingRetry = this.expiryRetries.get(taskId);
        if (existingRetry && existingRetry.statusTimestamp !== statusTimestamp) {
          this.expiryRetries.delete(taskId);
        } else if (existingRetry && existingRetry.retryNotBefore > Date.now()) {
          return;
        }
        const deadline = this.expiryDeadline(record);
        if (deadline === null) {
          this.expiryRetries.set(taskId, {
            statusTimestamp,
            retryNotBefore: Date.now() + A2A_INPUT_REQUIRED_EXPIRY_RETRY_MS,
          });
          this.audit("storage-failed", "dropped", { taskId });
          return;
        }
        if (deadline > Date.now()) return;

        const canceled = await this.options.runner.cancelA2AWireRun(
          record.childSessionId,
          { handlerId: this.id },
        );
        if (!canceled.ok) {
          const projected = canceled.run
            ? await this.transitionFromSnapshot(record, canceled.run)
            : record;
          if (!isA2ATerminalTaskState(projected.task.status.state)) {
            this.expiryRetries.set(taskId, {
              statusTimestamp,
              retryNotBefore: Date.now() + A2A_INPUT_REQUIRED_EXPIRY_RETRY_MS,
            });
            this.audit(
              canceled.reason === "task-not-found"
                ? "unknown-task"
                : canceled.reason === "storage-failed"
                  ? "storage-failed"
                  : "task-not-cancelable",
              "dropped",
              { taskId },
            );
            return;
          }
          this.expiryRetries.delete(taskId);
          return;
        }

        const transitioned = await this.options.store.transition({
          handlerId: this.id,
          taskId,
          state: A2ATaskState.CANCELED,
        });
        if (!transitioned.ok) {
          this.expiryRetries.set(taskId, {
            statusTimestamp,
            retryNotBefore: Date.now() + A2A_INPUT_REQUIRED_EXPIRY_RETRY_MS,
          });
          this.audit("storage-failed", "dropped", { taskId });
          return;
        }
        if (transitioned.record.task.status.state === A2ATaskState.CANCELED) {
          this.expiryRetries.delete(taskId);
          this.audit("task-expired", "canceled", { taskId });
          return;
        }
        if (isA2ATerminalTaskState(transitioned.record.task.status.state)) {
          this.expiryRetries.delete(taskId);
          return;
        }
        this.expiryRetries.set(taskId, {
          statusTimestamp,
          retryNotBefore: Date.now() + A2A_INPUT_REQUIRED_EXPIRY_RETRY_MS,
        });
        this.audit("task-not-cancelable", "dropped", { taskId });
      });
    } catch {
      this.expiryRetries.set(taskId, {
        statusTimestamp: listedStatusTimestamp,
        retryNotBefore: Date.now() + A2A_INPUT_REQUIRED_EXPIRY_RETRY_MS,
      });
      this.audit("storage-failed", "dropped", { taskId });
    }
  }

  private async runExpirySweep(): Promise<void> {
    this.clearExpiryTimer();
    let bootRetryNeeded = false;
    try {
      if (!this.expiryBootReconciled) {
        this.expiryBootReconciled = await this.reconcileExpiryBootRecords();
        bootRetryNeeded = !this.expiryBootReconciled;
      }

      const waiting = await this.options.store.list(this.id, {
        state: A2ATaskState.INPUT_REQUIRED,
      });
      for (const record of waiting) {
        if (this.expiryDisposed) return;
        await this.expireInputRequiredTask(
          record.task.id,
          record.task.status.timestamp ?? "",
        );
      }

      const remaining = await this.options.store.list(this.id, {
        state: A2ATaskState.INPUT_REQUIRED,
      });
      const scheduleAt = Date.now();
      let nextDelay = bootRetryNeeded ? A2A_INPUT_REQUIRED_EXPIRY_RETRY_MS : Infinity;
      const remainingIds = new Set(remaining.map((record) => record.task.id));
      for (const taskId of this.expiryRetries.keys()) {
        if (!remainingIds.has(taskId)) this.expiryRetries.delete(taskId);
      }
      for (const record of remaining) {
        const deadline = this.expiryDeadline(record);
        if (deadline === null) {
          nextDelay = Math.min(nextDelay, A2A_INPUT_REQUIRED_EXPIRY_RETRY_MS);
          this.audit("storage-failed", "dropped", { taskId: record.task.id });
          continue;
        }
        const retry = this.expiryRetries.get(record.task.id);
        if (retry && retry.statusTimestamp !== (record.task.status.timestamp ?? "")) {
          this.expiryRetries.delete(record.task.id);
        }
        const retryNotBefore = this.expiryRetries.get(record.task.id)?.retryNotBefore ?? 0;
        const eligibleAt = Math.max(deadline, retryNotBefore);
        nextDelay = Math.min(
          nextDelay,
          Math.max(0, eligibleAt - scheduleAt),
        );
      }
      if (Number.isFinite(nextDelay)) this.scheduleExpirySweep(nextDelay);
    } catch {
      this.audit("storage-failed", "dropped");
      this.scheduleExpirySweep(A2A_INPUT_REQUIRED_EXPIRY_RETRY_MS);
    }
  }

  /** Start the handler-owned, restart-safe INPUT_REQUIRED age-out lifecycle. */
  async startInputRequiredExpiry(): Promise<void> {
    if (this.expiryDisposed || this.expiryStarted) return;
    this.expiryStarted = true;
    await this.requestExpirySweep();
  }

  async dispose(): Promise<void> {
    if (!this.expiryDisposePromise) {
      this.expiryDisposed = true;
      this.clearExpiryTimer();
      this.expiryDisposePromise = this.expiryQueue.then(() => undefined);
    }
    await this.expiryDisposePromise;
  }

  private reserveTaskMutation<T>(
    taskId: string,
    fingerprint: PendingTaskMutation["fingerprint"],
    descriptor: Omit<A2AMutationAuthorizationDescriptor, "handlerId">,
    operation: () => Promise<T>,
  ): Promise<T> {
    const existing = this.pendingTaskMutations.get(taskId);
    if (existing) {
      if (isDeepStrictEqual(existing.fingerprint, fingerprint)) {
        return existing.promise as Promise<T>;
      }
      this.rejectConcurrentMutation(descriptor);
    }

    // Defer the operation by one microtask so the reservation is visible before
    // preflight or the per-task FIFO can yield to another request.
    const promise = Promise.resolve().then(operation);
    const reservation: PendingTaskMutation = { fingerprint, promise };
    this.pendingTaskMutations.set(taskId, reservation);
    const clear = (): void => {
      if (this.pendingTaskMutations.get(taskId) === reservation) {
        this.pendingTaskMutations.delete(taskId);
      }
    };
    void promise.then(clear, clear);
    return promise;
  }

  private audit(
    reason: A2ATaskLifecycleAuditEvent["reason"],
    outcome: A2ATaskLifecycleAuditEvent["outcome"],
    identifiers: {
      taskId?: string;
      messageId?: string;
      detectionCount?: number;
      operation?: A2AMutationOperation;
    } = {},
  ): void {
    try {
      this.options.audit?.({
        type: "a2a-task-lifecycle",
        outcome,
        reason,
        handlerId: this.id,
        ...identifiers,
      });
    } catch {
      // Audit sink failures must not change the fail-closed wire decision.
    }
  }

  private rejectConcurrentMutation(
    descriptor: Omit<A2AMutationAuthorizationDescriptor, "handlerId">,
  ): never {
    this.audit("consent-denied", "dropped", {
      operation: descriptor.operation,
      ...(descriptor.taskId ? { taskId: descriptor.taskId } : {}),
      ...(descriptor.messageId ? { messageId: descriptor.messageId } : {}),
    });
    throw new A2AHandlerError(A2AHostJsonRpcErrorDefinition.OPERATION_REJECTED);
  }

  private async authorizeMutation(
    descriptor: Omit<A2AMutationAuthorizationDescriptor, "handlerId">,
  ): Promise<void> {
    const request = Object.freeze({
      operation: descriptor.operation,
      handlerId: this.id,
      ...(descriptor.taskId ? { taskId: descriptor.taskId } : {}),
      ...(descriptor.messageId ? { messageId: descriptor.messageId } : {}),
    });
    const authorize = this.options.authorizeMutation as A2AMutationAuthorizer | undefined;
    let allowed = false;
    try {
      allowed = typeof authorize === "function" && (await authorize(request)) === true;
    } catch {
      allowed = false;
    }
    if (allowed) return;
    this.audit("consent-denied", "dropped", {
      operation: request.operation,
      ...(request.taskId ? { taskId: request.taskId } : {}),
      ...(request.messageId ? { messageId: request.messageId } : {}),
    });
    throw new A2AHandlerError(A2AHostJsonRpcErrorDefinition.OPERATION_REJECTED);
  }

  private auditUnavailableTask(
    reason: "cross-origin" | "unknown-task",
    taskId: string,
    messageId?: string,
  ): void {
    this.audit(reason, "dropped", {
      taskId,
      ...(messageId ? { messageId } : {}),
    });
  }

  private async rejectContinuation(
    failure: Extract<A2ATaskContinuationResult, { ok: false }>,
    taskId: string,
    messageId: string,
  ): Promise<never> {
    if (failure.reason === "task-not-found") {
      this.auditUnavailableTask(failure.availability, taskId, messageId);
      throw new A2AHandlerError(A2AJsonRpcErrorDefinition.TASK_NOT_FOUND);
    }
    this.audit(
      failure.reason === "history-capacity-exceeded"
        ? "task-budget-exceeded"
        : failure.reason === "duplicate-message"
          ? "invalid-message"
          : "task-not-resumable",
      "dropped",
      { taskId, messageId },
    );
    throw new A2AHandlerError(StandardJsonRpcErrorDefinition.INVALID_PARAMS);
  }

  private auditCreateFailure(
    reason: Extract<A2ATaskCreateResult, { ok: false }>["reason"],
    childSessionId: string,
    messageId: string,
  ): void {
    this.audit(
      reason === "capacity-exceeded"
        ? "task-budget-exceeded"
        : reason === "child-session-conflict"
          ? "cross-origin"
          : "storage-failed",
      "dropped",
      {
        ...(isSafeChildSessionId(childSessionId) ? { taskId: childSessionId } : {}),
        messageId,
      },
    );
  }

  private newId(): string {
    const id = this.makeId();
    if (!isSafeStructuralId(id)) throw new Error("A2A id generator returned an invalid id");
    return id;
  }

  private makeStatusMessage(
    record: A2ATaskRecord,
    state: A2AProjectedTaskState,
    input: {
      summary?: string;
      suspension?: A2AWireRunSnapshot["suspension"];
    } = {},
  ): A2AMessage | undefined {
    if (state === A2ATaskState.WORKING || state === A2ATaskState.SUBMITTED) {
      return undefined;
    }
    const fallback = state === A2ATaskState.COMPLETED
      ? "Task completed."
      : state === A2ATaskState.INPUT_REQUIRED
        ? input.suspension?.reason === "question"
          ? "Answer the sub-agent question to continue."
          : "Send any message to continue, or treat the partial result as done."
        : state === A2ATaskState.CANCELED
          ? "Task canceled."
          : state === A2ATaskState.REJECTED
            ? "Task rejected."
            : "Task failed.";
    const rawText = state === A2ATaskState.COMPLETED
      ? input.summary?.trim() || fallback
      : state === A2ATaskState.INPUT_REQUIRED
        ? input.suspension?.prompt?.trim() || fallback
        : fallback;
    const maskedText = maskSensitiveData(rawText).masked;
    const messageId = this.newId();
    if (!isSafeA2AMessageId(messageId)) {
      throw new Error("A2A id generator returned an invalid message id");
    }
    const buildMessage = (text: string): A2AMessage => ({
      messageId,
      contextId: record.task.contextId,
      taskId: record.task.id,
      role: A2ARole.AGENT,
      parts: [{ text }],
      metadata: {
        taskState: state,
        ...(state === A2ATaskState.INPUT_REQUIRED && input.suspension
          ? {
              suspension: {
                reason: input.suspension.reason,
                resumeId: input.suspension.resumeId,
              },
            }
          : {}),
      },
    });
    const envelopeLength = JSON.stringify(buildMessage("")).length;
    let remaining = Math.max(0, GUIDE_MAX_CHARS - envelopeLength);
    const textParts: string[] = [];
    for (const character of maskedText) {
      const serializedLength = JSON.stringify(character).length - 2;
      if (serializedLength > remaining) break;
      textParts.push(character);
      remaining -= serializedLength;
    }
    return buildMessage(textParts.join(""));
  }

  private async transitionRecord(
    record: A2ATaskRecord,
    state: A2AProjectedTaskState,
    input: {
      summary?: string;
      suspension?: A2AWireRunSnapshot["suspension"];
    } = {},
  ) {
    const message = this.makeStatusMessage(record, state, input);
    const transitioned = await this.options.store.transition({
      handlerId: this.id,
      taskId: record.task.id,
      state,
      message,
    });
    if (
      !transitioned.ok
      && transitioned.reason === "history-capacity-exceeded"
      && message
      && isA2ATerminalTaskState(state)
    ) {
      const fallback = await this.options.store.transition({
        handlerId: this.id,
        taskId: record.task.id,
        state,
      });
      if (fallback.ok) void this.requestExpirySweep();
      return fallback;
    }
    if (transitioned.ok) void this.requestExpirySweep();
    return transitioned;
  }

  private async transitionFromSnapshot(
    record: A2ATaskRecord,
    snapshot: A2AWireRunSnapshot,
  ): Promise<A2ATaskRecord> {
    if (
      snapshot.childSessionId !== record.childSessionId
      || snapshot.taskState === record.task.status.state
      || !canTransitionA2ATaskState(record.task.status.state, snapshot.taskState)
    ) {
      return record;
    }
    const transitioned = await this.transitionRecord(record, snapshot.taskState, {
      summary: snapshot.summary,
      suspension: snapshot.suspension,
    });
    return transitioned.ok ? transitioned.record : record;
  }

  private async reconcile(record: A2ATaskRecord): Promise<A2ATaskRecord> {
    const snapshot = this.options.runner.getA2AWireRunSnapshot(
      record.childSessionId,
      { handlerId: this.id },
    );
    return snapshot ? await this.transitionFromSnapshot(record, snapshot) : record;
  }

  private async finalize(
    taskId: string,
    result: SubAgentSpawnResult,
  ): Promise<A2ATaskRecord> {
    const record = await this.options.store.get(this.id, taskId);
    if (!record || result.childSessionId !== taskId) {
      this.audit("runner-failed", "dropped", { taskId });
      throw new Error("A2A runner returned an invalid task binding");
    }
    const state = projectSubAgentResultState(result);
    const transitioned = await this.transitionRecord(record, state, {
      summary: result.summary,
      suspension: result.suspension,
    });
    if (!transitioned.ok) {
      this.audit(
        transitioned.reason === "history-capacity-exceeded"
          ? "task-budget-exceeded"
          : "storage-failed",
        "dropped",
        { taskId },
      );
      throw new Error("A2A task finalization failed");
    }
    return transitioned.record;
  }

  private async markRunnerFailure(taskId: string): Promise<A2ATaskRecord> {
    const current = await this.options.store.get(this.id, taskId);
    if (!current) throw new Error("A2A failed task is unavailable");
    const failed = await this.transitionRecord(current, A2ATaskState.FAILED);
    if (!failed.ok) throw new Error("A2A failed task could not be finalized");
    this.audit("runner-failed", "dropped", { taskId });
    return failed.record;
  }

  private startInitialTask(parsed: ParsedSend, admissionId: string): A2AInitialStart {
    const contextId = parsed.message.contextId ?? this.newId();
    let linkedTaskId: string | undefined;
    let resolveLinked!: () => void;
    const linked = new Promise<void>((resolve) => {
      resolveLinked = resolve;
    });
    const execution = (async (): Promise<A2ATaskRecord> => {
      try {
        const result = await this.options.runner.spawnFromA2AWire(
          { messageText: parsed.prompt },
          this.options.binding,
          {
            onDurablyLinked: async ({ childSessionId }) => {
              if (linkedTaskId && linkedTaskId !== childSessionId) {
                throw new Error("A2A runner changed the durable task binding");
              }
              linkedTaskId = childSessionId;
              const created = await this.options.store.create({
                handlerId: this.id,
                childSessionId,
                contextId,
                message: parsed.message,
                admissionId,
              });
              if (!created.ok) {
                this.auditCreateFailure(
                  created.reason,
                  childSessionId,
                  parsed.message.messageId,
                );
                throw new Error("A2A durable task link failed");
              }
              const working = await this.options.store.transition({
                handlerId: this.id,
                taskId: childSessionId,
                state: A2ATaskState.WORKING,
              });
              if (!working.ok) throw new Error("A2A durable task activation failed");
              resolveLinked();
            },
          },
        );
        if (!linkedTaskId) {
          linkedTaskId = result.childSessionId;
          const created = await this.options.store.create({
            handlerId: this.id,
            childSessionId: linkedTaskId,
            contextId,
            message: parsed.message,
            admissionId,
          });
          if (!created.ok) {
            this.auditCreateFailure(
              created.reason,
              linkedTaskId,
              parsed.message.messageId,
            );
            throw new Error("A2A failed task could not be persisted");
          }
        }
        const taskId = linkedTaskId;
        return await this.withTaskLock(
          taskId,
          () => this.finalize(taskId, result),
        );
      } catch (error) {
        if (!linkedTaskId) throw error;
        const taskId = linkedTaskId;
        try {
          return await this.withTaskLock(
            taskId,
            () => this.markRunnerFailure(taskId),
          );
        } catch {
          throw error;
        }
      }
    })().finally(async () => {
      await this.options.store.releaseInitialTaskAdmission(admissionId);
    });

    let detachedFailureObserved = false;
    return {
      execution,
      linked,
      getLinkedTaskId: () => linkedTaskId,
      observeDetachedFailure: () => {
        if (detachedFailureObserved) return;
        detachedFailureObserved = true;
        void execution.catch(() => {
          this.audit("storage-failed", "dropped", { taskId: linkedTaskId });
        });
      },
    };
  }

  private async projectInitialTask(
    admission: A2AInitialAdmissionStart,
    parsed: ParsedSend,
  ): Promise<A2ATask> {
    if (admission.duplicate) {
      return projectTask((await this.reconcile(admission.record)).task, parsed.historyLength);
    }
    const started = admission.started;
    if (!parsed.returnImmediately) {
      return projectTask((await started.execution).task, parsed.historyLength);
    }
    const winner = await Promise.race([
      started.linked.then(() => "linked" as const),
      started.execution.then(() => "finished" as const),
    ]);
    if (winner === "finished") {
      return projectTask((await started.execution).task, parsed.historyLength);
    }
    started.observeDetachedFailure();
    const linkedTaskId = started.getLinkedTaskId();
    const record = linkedTaskId
      ? await this.options.store.get(this.id, linkedTaskId)
      : null;
    if (!record) throw new Error("A2A linked task is unavailable");
    return projectTask(record.task, parsed.historyLength);
  }

  private async sendMessage(params: A2AJsonObject): Promise<A2ATask> {
    const parsed = parseSend(params);
    if (parsed.detectionCount > 0) {
      this.audit("dlp-masked", "masked", {
        messageId: parsed.message.messageId,
        detectionCount: parsed.detectionCount,
      });
    }
    const duplicate = await this.options.store.findByMessageId(
      this.id,
      parsed.message.messageId,
    );
    if (duplicate) {
      if (
        (parsed.message.taskId && parsed.message.taskId !== duplicate.task.id)
        || (
          parsed.message.contextId
          && parsed.message.contextId !== duplicate.task.contextId
        )
        || !isExactTaskMessageReplay(duplicate.task, parsed.message)
      ) {
        this.audit("invalid-message", "dropped", {
          messageId: parsed.message.messageId,
        });
        invalidParams();
      }
      return projectTask((await this.reconcile(duplicate)).task, parsed.historyLength);
    }

    if (!parsed.message.taskId) {
      const key = this.id + "\u0000" + parsed.message.messageId;
      const fingerprint = structuredClone(parsed.message);
      const existing = this.initialInFlight.get(key);
      if (existing) {
        if (!isDeepStrictEqual(existing.fingerprint, fingerprint)) {
          this.rejectConcurrentMutation({
            operation: "send-message",
            messageId: parsed.message.messageId,
          });
        }
        return await this.projectInitialTask(await existing.promise, parsed);
      }
      const pending = (async () => {
        const descriptor = {
          operation: "send-message" as const,
          messageId: parsed.message.messageId,
        };
        const admission = await this.options.store.reserveInitialTaskAdmission({
          handlerId: this.id,
          message: parsed.message,
        });
        if (!admission.ok) {
          if (admission.reason === "admission-busy") {
            this.rejectConcurrentMutation(descriptor);
          }
          if (admission.reason === "invalid-message") invalidParams();
          if (admission.reason === "duplicate-message") {
            this.audit("invalid-message", "dropped", {
              messageId: parsed.message.messageId,
            });
            invalidParams();
          }
          this.audit("task-budget-exceeded", "dropped", {
            messageId: parsed.message.messageId,
          });
          throw new A2AHandlerError(A2AHostJsonRpcErrorDefinition.OPERATION_REJECTED);
        }
        if (!admission.reserved) {
          return { duplicate: true as const, record: admission.record };
        }
        try {
          await this.authorizeMutation(descriptor);
          return {
            duplicate: false as const,
            started: this.startInitialTask(parsed, admission.admissionId),
          };
        } catch (error) {
          await this.options.store.releaseInitialTaskAdmission(admission.admissionId);
          throw error;
        }
      })();
      const reservation: PendingInitialMutation = { fingerprint, promise: pending };
      this.initialInFlight.set(key, reservation);
      const clear = (): void => {
        if (this.initialInFlight.get(key) === reservation) this.initialInFlight.delete(key);
      };
      void pending.then(
        (admitted) => {
          if (admitted.duplicate) {
            clear();
            return;
          }
          const started = admitted.started;
          void Promise.race([
            started.linked,
            started.execution.then(() => undefined, () => undefined),
          ]).then(clear, clear);
        },
        clear,
      );
      return await this.projectInitialTask(await pending, parsed);
    }

    const taskId = parsed.message.taskId;
    const descriptor = {
      operation: "send-message" as const,
      taskId,
      messageId: parsed.message.messageId,
    };
    const started = await this.reserveTaskMutation<A2AContinuationStart>(
      taskId,
      parsed.message,
      descriptor,
      () => this.withTaskLock(taskId, async () => {
        const input = {
          handlerId: this.id,
          taskId,
          contextId: parsed.message.contextId,
          message: parsed.message,
        };
        const current = await this.options.store.lookupTask(this.id, taskId);
        if (current.ok) await this.reconcile(current.record);
        const preflight = await this.options.store.preflightContinuation(input);
        if (!preflight.ok) return await this.rejectContinuation(
          preflight,
          taskId,
          parsed.message.messageId,
        );
        if (preflight.duplicate) return { duplicate: true, record: preflight.record };
        await this.authorizeMutation(descriptor);
        const revalidated = await this.options.store.lookupTask(this.id, taskId);
        if (revalidated.ok) await this.reconcile(revalidated.record);
        const committed = await this.options.store.beginContinuation(input);
        if (!committed.ok) return await this.rejectContinuation(
          committed,
          taskId,
          parsed.message.messageId,
        );
        if (committed.duplicate) return { duplicate: true, record: committed.record };
        void this.requestExpirySweep();

        // Invoke resume before releasing the task lock. Provider completion is
        // deliberately not awaited here, so cancel can run after resume starts.
        const execution = (async (): Promise<A2ATaskRecord> => {
          try {
            const result = await this.options.runner.resumeFromA2AWire(
              { resumeId: committed.record.childSessionId, messageText: parsed.prompt },
              { handlerId: this.id },
            );
            return await this.withTaskLock(
              committed.record.childSessionId,
              () => this.finalize(committed.record.childSessionId, result),
            );
          } catch (error) {
            try {
              return await this.withTaskLock(
                committed.record.childSessionId,
                () => this.markRunnerFailure(committed.record.childSessionId),
              );
            } catch {
              throw error;
            }
          }
        })();
        void execution.catch(() => {
          this.audit("runner-failed", "dropped", { taskId: committed.record.task.id });
        });
        return { duplicate: false, record: committed.record, execution };
      }),
    );
    if (started.duplicate) return projectTask(started.record.task, parsed.historyLength);
    if (parsed.returnImmediately) {
      return projectTask(started.record.task, parsed.historyLength);
    }
    return projectTask((await started.execution).task, parsed.historyLength);
  }

  private async getTask(params: A2AJsonObject): Promise<A2ATask> {
    const parsed = parseGet(params);
    const lookup = await this.options.store.lookupTask(this.id, parsed.id);
    if (!lookup.ok) {
      this.auditUnavailableTask(lookup.reason, parsed.id);
      throw new A2AHandlerError(A2AJsonRpcErrorDefinition.TASK_NOT_FOUND);
    }
    return projectTask((await this.reconcile(lookup.record)).task, parsed.historyLength);
  }

  private async listTasks(params: A2AJsonObject): Promise<A2ADirectJsonRpcResult> {
    const parsed = parseList(params);
    const records = await this.options.store.list(this.id, {
      ...(parsed.contextId ? { contextId: parsed.contextId } : {}),
      ...(parsed.statusTimestampAfter
        ? { statusTimestampAfter: parsed.statusTimestampAfter }
        : {}),
    });
    const reconciled: A2ATaskRecord[] = [];
    for (const record of records) reconciled.push(await this.reconcile(record));
    reconciled.sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt) || a.task.id.localeCompare(b.task.id));
    const filtered = parsed.state
      ? reconciled.filter((record) => record.task.status.state === parsed.state)
      : reconciled;
    const cursor = parsed.pageToken ? decodeCursor(parsed.pageToken, this.id) : undefined;
    if (parsed.pageToken && !cursor) invalidParams();
    const remaining = cursor ? filtered.filter((record) => afterCursor(record, cursor)) : filtered;
    const page = remaining.slice(0, parsed.pageSize);
    const hasNext = remaining.length > page.length;
    return {
      tasks: page.map((record) =>
        projectTask(record.task, parsed.historyLength, parsed.includeArtifacts)),
      nextPageToken: hasNext && page.length > 0 ? encodeCursor(page[page.length - 1]!) : "",
      pageSize: parsed.pageSize,
      totalSize: filtered.length,
    };
  }

  private async cancelTask(params: A2AJsonObject): Promise<A2ATask> {
    const taskId = parseCancel(params);
    return await this.reserveTaskMutation(
      taskId,
      "cancel-task",
      { operation: "cancel-task", taskId },
      () => this.withTaskLock(taskId, () => this.cancelTaskLocked(taskId)),
    );
  }

  private async cancelTaskLocked(taskId: string): Promise<A2ATask> {
    const lookup = await this.options.store.lookupTask(this.id, taskId);
    if (!lookup.ok) {
      this.auditUnavailableTask(lookup.reason, taskId);
      throw new A2AHandlerError(A2AJsonRpcErrorDefinition.TASK_NOT_FOUND);
    }
    let record = await this.reconcile(lookup.record);
    let state = record.task.status.state;
    if (state === A2ATaskState.CANCELED) return record.task;
    if (isA2ATerminalTaskState(state)) {
      this.audit("task-not-cancelable", "dropped", { taskId });
      throw new A2AHandlerError(A2AJsonRpcErrorDefinition.TASK_NOT_CANCELABLE);
    }
    await this.authorizeMutation({ operation: "cancel-task", taskId });

    const revalidated = await this.options.store.lookupTask(this.id, taskId);
    if (!revalidated.ok) {
      this.auditUnavailableTask(revalidated.reason, taskId);
      throw new A2AHandlerError(A2AJsonRpcErrorDefinition.TASK_NOT_FOUND);
    }
    record = await this.reconcile(revalidated.record);
    state = record.task.status.state;
    if (state === A2ATaskState.CANCELED) return record.task;
    if (isA2ATerminalTaskState(state)) {
      this.audit("task-not-cancelable", "dropped", { taskId });
      throw new A2AHandlerError(A2AJsonRpcErrorDefinition.TASK_NOT_CANCELABLE);
    }
    const canceled = await this.options.runner.cancelA2AWireRun(
      record.childSessionId,
      { handlerId: this.id },
    );
    if (!canceled.ok) {
      if (canceled.run) await this.transitionFromSnapshot(record, canceled.run);
      this.audit(
        canceled.reason === "task-not-found"
          ? "unknown-task"
          : canceled.reason === "storage-failed"
            ? "storage-failed"
            : "task-not-cancelable",
        "dropped",
        { taskId },
      );
      throw new A2AHandlerError(
        canceled.reason === "task-not-found"
          ? A2AJsonRpcErrorDefinition.TASK_NOT_FOUND
          : canceled.reason === "task-not-cancelable"
            ? A2AJsonRpcErrorDefinition.TASK_NOT_CANCELABLE
            : StandardJsonRpcErrorDefinition.INTERNAL_ERROR,
      );
    }
    const transitioned = await this.transitionRecord(record, A2ATaskState.CANCELED);
    if (!transitioned.ok) throw new A2AHandlerError(StandardJsonRpcErrorDefinition.INTERNAL_ERROR);
    if (transitioned.record.task.status.state !== A2ATaskState.CANCELED) {
      throw new A2AHandlerError(A2AJsonRpcErrorDefinition.TASK_NOT_CANCELABLE);
    }
    return transitioned.record.task;
  }

  async handle(
    method: A2ADirectJsonRpcMethod,
    params: A2AJsonObject,
  ): Promise<A2ADirectJsonRpcResult> {
    switch (method) {
      case A2AJsonRpcMethod.SEND_MESSAGE:
        return { task: await this.sendMessage(params) };
      case A2AJsonRpcMethod.GET_TASK:
        return await this.getTask(params);
      case A2AJsonRpcMethod.LIST_TASKS:
        return await this.listTasks(params);
      case A2AJsonRpcMethod.CANCEL_TASK:
        return await this.cancelTask(params);
      default:
        throw new A2AHandlerError(StandardJsonRpcErrorDefinition.METHOD_NOT_FOUND);
    }
  }
}
