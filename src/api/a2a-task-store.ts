import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  A2ARole,
  A2ATaskState,
  canTransitionA2ATaskState,
  isA2AProjectedTaskState,
  isA2ATerminalTaskState,
  type A2AMessage,
  type A2APart,
  type A2AProjectedTaskState,
  type A2ATask,
} from "../shared/a2a.js";
import type { FeatureNamespaceHandle } from "../main/storage/feature-namespace.js";
import { maskSensitiveData } from "../shared/dlp.js";
import {
  canonicalizeInboundA2ASubAgentMessage,
  isSafeA2AMessageId,
  maskA2AMessage,
} from "../engine/a2a-subagent-message-codec.js";
import {
  GUIDE_MAX_CHARS,
  GUIDE_MAX_ENTRIES,
} from "../engine/turn/guidance-limits.js";

const STORE_VERSION = 1;
const DEFAULT_FILE_NAME = "tasks.json";
const HANDLER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CHILD_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/;
const MESSAGE_KEYS = new Set([
  "messageId",
  "contextId",
  "taskId",
  "role",
  "parts",
  "metadata",
  "extensions",
  "referenceTaskIds",
]);
const PART_KEYS = new Set([
  "text",
  "raw",
  "url",
  "data",
  "metadata",
  "filename",
  "mediaType",
]);
const TASK_KEYS = new Set(["id", "contextId", "status", "history"]);
const RECORD_KEYS = new Set([
  "handlerId",
  "childSessionId",
  "createdAt",
  "updatedAt",
  "task",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isSafeStructuralId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 256
    && !CONTROL_CHAR.test(value)
    && maskSensitiveData(value).detections.length === 0;
}

const RFC3339_TIMESTAMP = /^(\d{4})-(0[1-9]|1[0-2])-([0-2]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

/** Validate the RFC 3339 JSON representation used by protobuf Timestamp. */
export function isA2ARfc3339Timestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = RFC3339_TIMESTAMP.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return year >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isJsonLike(value: unknown, seen = new Set<object>(), depth = 0): boolean {
  if (depth > 20) return false;
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.every((entry) => isJsonLike(entry, seen, depth + 1))
    : Object.entries(value).every(([key, entry]) =>
        !CONTROL_CHAR.test(key) && isJsonLike(entry, seen, depth + 1));
  seen.delete(value);
  return valid;
}

function isValidPart(value: unknown): value is A2APart {
  if (!isRecord(value) || !hasOnlyKeys(value, PART_KEYS)) return false;
  const contentKeys = ["text", "raw", "url", "data"].filter((key) => hasOwn(value, key));
  if (contentKeys.length !== 1 || contentKeys[0] === "raw") return false;
  const contentKey = contentKeys[0]!;
  if ((contentKey === "text" || contentKey === "url") && typeof value[contentKey] !== "string") {
    return false;
  }
  if (contentKey === "data" && !isJsonLike(value.data)) return false;
  if (hasOwn(value, "metadata") && (!isRecord(value.metadata) || !isJsonLike(value.metadata))) {
    return false;
  }
  return (!hasOwn(value, "filename") || typeof value.filename === "string")
    && (!hasOwn(value, "mediaType") || typeof value.mediaType === "string");
}

function normalizeStoredMessage(value: unknown): A2AMessage | null {
  if (!isRecord(value) || !hasOnlyKeys(value, MESSAGE_KEYS)) return null;
  try {
    if (JSON.stringify(value).length > GUIDE_MAX_CHARS) return null;
  } catch {
    return null;
  }
  if (!isSafeA2AMessageId(value.messageId)) return null;
  if (value.role !== A2ARole.USER && value.role !== A2ARole.AGENT) return null;
  if (!isSafeStructuralId(value.contextId) || !isSafeStructuralId(value.taskId)) return null;
  if (
    !Array.isArray(value.parts)
    || value.parts.length === 0
    || value.parts.length > GUIDE_MAX_ENTRIES
    || !value.parts.every(isValidPart)
  ) {
    return null;
  }
  if (hasOwn(value, "metadata") && (!isRecord(value.metadata) || !isJsonLike(value.metadata))) {
    return null;
  }
  if (
    hasOwn(value, "extensions")
    && (
      !isStringArray(value.extensions)
      || value.extensions.length > GUIDE_MAX_ENTRIES
    )
  ) {
    return null;
  }
  if (
    hasOwn(value, "referenceTaskIds")
    && (
      !isStringArray(value.referenceTaskIds)
      || value.referenceTaskIds.length > GUIDE_MAX_ENTRIES
    )
  ) {
    return null;
  }

  if (value.role === A2ARole.USER) {
    const canonical = canonicalizeInboundA2ASubAgentMessage(value);
    return canonical.ok ? canonical.message : null;
  }
  try {
    return maskA2AMessage(value as unknown as A2AMessage).message;
  } catch {
    return null;
  }
}

function normalizeTask(
  value: unknown,
  childSessionId: string,
  maxHistoryMessages: number,
): A2ATask | null {
  if (!isRecord(value) || !hasOnlyKeys(value, TASK_KEYS)) return null;
  if (value.id !== childSessionId || !isSafeStructuralId(value.contextId)) return null;
  if (!isRecord(value.status) || !isA2AProjectedTaskState(value.status.state)) return null;
  if (!isA2ARfc3339Timestamp(value.status.timestamp)) return null;
  const statusMessage = value.status.message === undefined
    ? undefined
    : normalizeStoredMessage(value.status.message);
  if (value.status.message !== undefined && !statusMessage) return null;
  if (
    statusMessage
    && (statusMessage.taskId !== childSessionId || statusMessage.contextId !== value.contextId)
  ) {
    return null;
  }
  if (!Array.isArray(value.history) || value.history.length > maxHistoryMessages) return null;
  const history: A2AMessage[] = [];
  for (const entry of value.history) {
    const message = normalizeStoredMessage(entry);
    if (
      !message
      || message.taskId !== childSessionId
      || message.contextId !== value.contextId
    ) {
      return null;
    }
    history.push(message);
  }
  if (new Set(history.map((message) => message.messageId)).size !== history.length) {
    return null;
  }
  return {
    id: childSessionId,
    contextId: value.contextId,
    status: {
      state: value.status.state,
      timestamp: value.status.timestamp,
      ...(statusMessage ? { message: statusMessage } : {}),
    },
    history,
  };
}

export interface A2ATaskRecord {
  handlerId: string;
  childSessionId: string;
  createdAt: string;
  updatedAt: string;
  task: A2ATask;
}

function normalizeRecord(value: unknown, maxHistoryMessages: number): A2ATaskRecord | null {
  if (!isRecord(value) || !hasOnlyKeys(value, RECORD_KEYS)) return null;
  if (
    typeof value.handlerId !== "string"
    || !HANDLER_ID_PATTERN.test(value.handlerId)
    || maskSensitiveData(value.handlerId).detections.length > 0
  ) {
    return null;
  }
  if (
    typeof value.childSessionId !== "string"
    || !CHILD_SESSION_ID_PATTERN.test(value.childSessionId)
    || maskSensitiveData(value.childSessionId).detections.length > 0
  ) {
    return null;
  }
  if (
    !isA2ARfc3339Timestamp(value.createdAt)
    || !isA2ARfc3339Timestamp(value.updatedAt)
  ) {
    return null;
  }
  const task = normalizeTask(value.task, value.childSessionId, maxHistoryMessages);
  if (!task || task.status.timestamp !== value.updatedAt) return null;
  return {
    handlerId: value.handlerId,
    childSessionId: value.childSessionId,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    task,
  };
}

function cloneRecord(record: A2ATaskRecord): A2ATaskRecord {
  return structuredClone(record);
}

function taskKey(handlerId: string, taskId: string): string {
  return handlerId + "\u0000" + taskId;
}

function messageKey(handlerId: string, messageId: string): string {
  return handlerId + "\u0000" + messageId;
}

function recordMessageIds(record: A2ATaskRecord): string[] {
  const ids = record.task.history?.map((message) => message.messageId) ?? [];
  if (record.task.status.message) ids.push(record.task.status.message.messageId);
  return [...new Set(ids)];
}

function hasExactStoredMessage(record: A2ATaskRecord, message: A2AMessage): boolean {
  const candidates = [
    ...(record.task.history ?? []),
    ...(record.task.status.message ? [record.task.status.message] : []),
  ];
  return candidates.some((candidate) =>
    candidate.messageId === message.messageId
    && isDeepStrictEqual(candidate, message));
}

function hasExactInitialStoredMessage(record: A2ATaskRecord, message: A2AMessage): boolean {
  const initial = record.task.history?.[0];
  return initial?.messageId === message.messageId
    && isDeepStrictEqual(initial, message);
}

export interface A2ATaskStoreAuditEvent {
  type: "a2a-task-store-drop";
  reason: "invalid-record" | "duplicate-record" | "inactive-handler";
  count: number;
}

export interface CreateA2ATaskStoreOptions {
  namespace: Pick<FeatureNamespaceHandle, "readJson" | "writeJson">;
  maxTasks: number;
  /** Optional fair-share ceiling used when multiple handlers share one store. */
  maxTasksPerHandler?: number;
  maxHistoryMessages: number;
  /** Optional immutable boot snapshot; persisted records for removed handlers are ignored. */
  activeHandlerIds?: ReadonlySet<string>;
  fileName?: string;
  now?: () => string;
  audit?: (event: A2ATaskStoreAuditEvent) => void;
}

export type A2ATaskCreateResult =
  | { ok: true; created: boolean; record: A2ATaskRecord }
  | {
      ok: false;
      reason:
        | "capacity-exceeded"
        | "child-session-conflict"
        | "duplicate-message"
        | "invalid-task";
    };

export type A2AInitialTaskAdmissionResult =
  | { ok: true; reserved: true; admissionId: string }
  | { ok: true; reserved: false; record: A2ATaskRecord }
  | {
      ok: false;
      reason:
        | "admission-busy"
        | "capacity-exceeded"
        | "duplicate-message"
        | "invalid-message";
    };

export type A2ATaskContinuationResult =
  | { ok: true; duplicate: boolean; record: A2ATaskRecord }
  | {
      ok: false;
      reason: "task-not-found";
      availability: "cross-origin" | "unknown-task";
    }
  | {
      ok: false;
      reason:
        | "task-not-resumable"
        | "context-mismatch"
        | "duplicate-message"
        | "history-capacity-exceeded"
        | "invalid-message";
    };

export type A2ATaskLookupResult =
  | { ok: true; record: A2ATaskRecord }
  | { ok: false; reason: "cross-origin" | "unknown-task" };

type A2ATaskContinuationInspection =
  | {
      ok: true;
      duplicate: true;
      record: A2ATaskRecord;
    }
  | {
      ok: true;
      duplicate: false;
      record: A2ATaskRecord;
      message: A2AMessage;
    }
  | Extract<A2ATaskContinuationResult, { ok: false }>;

export type A2ATaskTransitionResult =
  | { ok: true; changed: boolean; record: A2ATaskRecord }
  | {
      ok: false;
      reason: "task-not-found" | "invalid-transition" | "history-capacity-exceeded" | "invalid-message";
    };

export interface A2ATaskListFilter {
  contextId?: string;
  state?: A2AProjectedTaskState;
  statusTimestampAfter?: string;
}

export class A2ATaskStore {
  private readonly fileName: string;
  private readonly now: () => string;
  private records: A2ATaskRecord[] = [];
  private loaded = false;
  private queue: Promise<void> = Promise.resolve();
  private initialAdmission:
    | { id: string; handlerId: string; message: A2AMessage }
    | undefined;

  constructor(private readonly options: CreateA2ATaskStoreOptions) {
    if (!Number.isInteger(options.maxTasks) || options.maxTasks < 1) {
      throw new Error("A2A task store maxTasks must be a positive integer");
    }
    if (
      options.maxTasksPerHandler !== undefined
      && (!Number.isInteger(options.maxTasksPerHandler) || options.maxTasksPerHandler < 1)
    ) {
      throw new Error("A2A task store maxTasksPerHandler must be a positive integer");
    }
    if (!Number.isInteger(options.maxHistoryMessages) || options.maxHistoryMessages < 1) {
      throw new Error("A2A task store maxHistoryMessages must be a positive integer");
    }
    this.fileName = options.fileName ?? DEFAULT_FILE_NAME;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  private async withLock<T>(operation: () => Promise<T> | T): Promise<T> {
    const run = this.queue.then(async () => {
      await this.loadUnlocked();
      return await operation();
    });
    this.queue = run.then(() => undefined, () => undefined);
    return await run;
  }

  private async loadUnlocked(): Promise<void> {
    if (this.loaded) return;
    const raw = await this.options.namespace.readJson<unknown>(this.fileName, {
      version: STORE_VERSION,
      records: [],
    });
    const values = isRecord(raw)
      && raw.version === STORE_VERSION
      && Array.isArray(raw.records)
      ? raw.records
      : [];
    const normalized = values
      .map((value) => normalizeRecord(value, this.options.maxHistoryMessages))
      .filter((value): value is A2ATaskRecord => value !== null);
    const invalidCount = values.length - normalized.length;
    if (invalidCount > 0) {
      this.options.audit?.({
        type: "a2a-task-store-drop",
        reason: "invalid-record",
        count: invalidCount,
      });
    }

    const candidates = this.options.activeHandlerIds
      ? normalized.filter((record) => this.options.activeHandlerIds!.has(record.handlerId))
      : normalized;
    const inactiveCount = normalized.length - candidates.length;
    if (inactiveCount > 0) {
      this.options.audit?.({
        type: "a2a-task-store-drop",
        reason: "inactive-handler",
        count: inactiveCount,
      });
    }

    const taskCounts = new Map<string, number>();
    const childCounts = new Map<string, number>();
    const messageCounts = new Map<string, number>();
    for (const record of candidates) {
      const key = taskKey(record.handlerId, record.task.id);
      taskCounts.set(key, (taskCounts.get(key) ?? 0) + 1);
      childCounts.set(
        record.childSessionId,
        (childCounts.get(record.childSessionId) ?? 0) + 1,
      );
      for (const messageId of recordMessageIds(record)) {
        const id = messageKey(record.handlerId, messageId);
        messageCounts.set(id, (messageCounts.get(id) ?? 0) + 1);
      }
    }
    this.records = candidates.filter((record) => {
      if ((taskCounts.get(taskKey(record.handlerId, record.task.id)) ?? 0) !== 1) return false;
      if ((childCounts.get(record.childSessionId) ?? 0) !== 1) return false;
      return recordMessageIds(record).every((messageId) =>
        (messageCounts.get(messageKey(record.handlerId, messageId)) ?? 0) === 1);
    });
    const duplicateCount = candidates.length - this.records.length;
    if (duplicateCount > 0) {
      this.options.audit?.({
        type: "a2a-task-store-drop",
        reason: "duplicate-record",
        count: duplicateCount,
      });
    }
    this.loaded = true;
  }

  private async persistUnlocked(): Promise<void> {
    await this.options.namespace.writeJson(this.fileName, {
      version: STORE_VERSION,
      records: this.records,
    });
  }

  private findIndex(handlerId: string, taskId: string): number {
    return this.records.findIndex((record) =>
      record.handlerId === handlerId && record.task.id === taskId);
  }

  private findMessageRecord(handlerId: string, messageId: string): A2ATaskRecord | undefined {
    return this.records.find((record) =>
      record.handlerId === handlerId && recordMessageIds(record).includes(messageId));
  }

  private removalCountForAdmission(handlerId: string): number {
    const totalOverflow = this.records.length - this.options.maxTasks + 1;
    const perHandlerLimit = this.options.maxTasksPerHandler ?? this.options.maxTasks;
    const handlerCount = this.records.filter((record) => record.handlerId === handlerId).length;
    const handlerOverflow = handlerCount - perHandlerLimit + 1;
    return Math.max(0, totalOverflow, handlerOverflow);
  }

  private inspectContinuationUnlocked(input: {
    handlerId: string;
    taskId: string;
    contextId?: string;
    message: A2AMessage;
  }): A2ATaskContinuationInspection {
    if (
      this.initialAdmission?.handlerId === input.handlerId
      && this.initialAdmission.message.messageId === input.message.messageId
    ) {
      return { ok: false, reason: "duplicate-message" };
    }
    const duplicate = this.findMessageRecord(input.handlerId, input.message.messageId);
    if (duplicate) {
      if (duplicate.task.id !== input.taskId) {
        return { ok: false, reason: "duplicate-message" };
      }
      if (input.contextId && input.contextId !== duplicate.task.contextId) {
        return { ok: false, reason: "context-mismatch" };
      }
      const assignedMessage = normalizeStoredMessage({
        ...structuredClone(input.message),
        contextId: duplicate.task.contextId,
        taskId: duplicate.task.id,
      });
      if (!assignedMessage || !hasExactStoredMessage(duplicate, assignedMessage)) {
        return { ok: false, reason: "duplicate-message" };
      }
      return { ok: true, duplicate: true, record: duplicate };
    }
    const index = this.findIndex(input.handlerId, input.taskId);
    if (index < 0) {
      return {
        ok: false,
        reason: "task-not-found",
        availability: this.records.some((record) => record.task.id === input.taskId)
          ? "cross-origin"
          : "unknown-task",
      };
    }
    const record = this.records[index]!;
    if (input.contextId && input.contextId !== record.task.contextId) {
      return { ok: false, reason: "context-mismatch" };
    }
    if (record.task.status.state !== A2ATaskState.INPUT_REQUIRED) {
      return { ok: false, reason: "task-not-resumable" };
    }
    const assignedMessage = normalizeStoredMessage({
      ...structuredClone(input.message),
      contextId: record.task.contextId,
      taskId: record.task.id,
    });
    if (!assignedMessage) return { ok: false, reason: "invalid-message" };
    if ((record.task.history?.length ?? 0) >= this.options.maxHistoryMessages) {
      return { ok: false, reason: "history-capacity-exceeded" };
    }
    return {
      ok: true,
      duplicate: false,
      record,
      message: assignedMessage,
    };
  }

  async get(handlerId: string, taskId: string): Promise<A2ATaskRecord | null> {
    return await this.withLock(() => {
      const index = this.findIndex(handlerId, taskId);
      return index < 0 ? null : cloneRecord(this.records[index]!);
    });
  }

  /** Atomically return an owned task or its redacted unavailability classification. */
  async lookupTask(handlerId: string, taskId: string): Promise<A2ATaskLookupResult> {
    return await this.withLock(() => {
      const index = this.findIndex(handlerId, taskId);
      if (index >= 0) return { ok: true, record: cloneRecord(this.records[index]!) };
      return {
        ok: false,
        reason: this.records.some((record) => record.task.id === taskId)
          ? "cross-origin"
          : "unknown-task",
      };
    });
  }

  async findByMessageId(handlerId: string, messageId: string): Promise<A2ATaskRecord | null> {
    return await this.withLock(() => {
      const record = this.findMessageRecord(handlerId, messageId);
      return record ? cloneRecord(record) : null;
    });
  }

  async list(handlerId: string, filter: A2ATaskListFilter = {}): Promise<A2ATaskRecord[]> {
    return await this.withLock(() => this.records
      .filter((record) => record.handlerId === handlerId)
      .filter((record) => !filter.contextId || record.task.contextId === filter.contextId)
      .filter((record) => !filter.state || record.task.status.state === filter.state)
      .filter((record) =>
        !filter.statusTimestampAfter
        || Date.parse(record.updatedAt) >= Date.parse(filter.statusTimestampAfter))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.task.id.localeCompare(b.task.id))
      .map(cloneRecord));
  }

  /**
   * Reserve the single in-process admission slot before prompting or starting a
   * child. The reservation is intentionally not persisted and is released when
   * the durable Task link commits or the attempted spawn fails.
   */
  async reserveInitialTaskAdmission(input: {
    handlerId: string;
    message: A2AMessage;
  }): Promise<A2AInitialTaskAdmissionResult> {
    return await this.withLock(() => {
      if (
        !HANDLER_ID_PATTERN.test(input.handlerId)
        || maskSensitiveData(input.handlerId).detections.length > 0
        || !isSafeA2AMessageId(input.message.messageId)
        || input.message.taskId !== undefined
      ) {
        return { ok: false, reason: "invalid-message" };
      }
      const duplicate = this.findMessageRecord(input.handlerId, input.message.messageId);
      if (duplicate) {
        if (
          input.message.contextId
          && input.message.contextId !== duplicate.task.contextId
        ) {
          return { ok: false, reason: "duplicate-message" };
        }
        const assignedMessage = normalizeStoredMessage({
          ...structuredClone(input.message),
          contextId: duplicate.task.contextId,
          taskId: duplicate.task.id,
        });
        return assignedMessage && hasExactInitialStoredMessage(duplicate, assignedMessage)
          ? { ok: true, reserved: false, record: cloneRecord(duplicate) }
          : { ok: false, reason: "duplicate-message" };
      }
      if (this.initialAdmission) {
        return { ok: false, reason: "admission-busy" };
      }

      const removeCount = this.removalCountForAdmission(input.handlerId);
      if (removeCount > 0) {
        const terminalCount = this.records.filter((record) =>
          record.handlerId === input.handlerId
          && isA2ATerminalTaskState(record.task.status.state)).length;
        if (terminalCount < removeCount) {
          return { ok: false, reason: "capacity-exceeded" };
        }
      }
      this.initialAdmission = {
        id: randomUUID(),
        handlerId: input.handlerId,
        message: structuredClone(input.message),
      };
      return {
        ok: true,
        reserved: true,
        admissionId: this.initialAdmission.id,
      };
    });
  }

  async releaseInitialTaskAdmission(admissionId: string): Promise<void> {
    await this.withLock(() => {
      if (this.initialAdmission?.id === admissionId) this.initialAdmission = undefined;
    });
  }

  async create(input: {
    handlerId: string;
    childSessionId: string;
    contextId: string;
    message: A2AMessage;
    admissionId?: string;
  }): Promise<A2ATaskCreateResult> {
    return await this.withLock(async () => {
      if (
        !HANDLER_ID_PATTERN.test(input.handlerId)
        || !CHILD_SESSION_ID_PATTERN.test(input.childSessionId)
        || maskSensitiveData(input.handlerId).detections.length > 0
        || maskSensitiveData(input.childSessionId).detections.length > 0
        || !isSafeStructuralId(input.contextId)
      ) {
        return { ok: false, reason: "invalid-task" };
      }
      const assignedMessage = normalizeStoredMessage({
        ...structuredClone(input.message),
        contextId: input.contextId,
        taskId: input.childSessionId,
      });
      if (!assignedMessage) return { ok: false, reason: "invalid-task" };
      const admission = input.admissionId ? this.initialAdmission : undefined;
      if (
        input.admissionId
        && (
          !admission
          || admission.id !== input.admissionId
          || admission.handlerId !== input.handlerId
          || admission.message.messageId !== assignedMessage.messageId
          || !isDeepStrictEqual(
            {
              ...structuredClone(admission.message),
              contextId: input.contextId,
              taskId: input.childSessionId,
            },
            assignedMessage,
          )
        )
      ) {
        return { ok: false, reason: "invalid-task" };
      }
      if (this.initialAdmission && admission !== this.initialAdmission) {
        return { ok: false, reason: "capacity-exceeded" };
      }
      const consumeAdmission = (): void => {
        if (admission && this.initialAdmission === admission) this.initialAdmission = undefined;
      };

      const childOwner = this.records.find(
        (record) => record.childSessionId === input.childSessionId,
      );
      if (childOwner && childOwner.handlerId !== input.handlerId) {
        return { ok: false, reason: "child-session-conflict" };
      }

      const duplicateMessage = this.findMessageRecord(input.handlerId, assignedMessage.messageId);
      if (duplicateMessage) {
        if (
          duplicateMessage.childSessionId !== input.childSessionId
          || !hasExactInitialStoredMessage(duplicateMessage, assignedMessage)
        ) {
          return { ok: false, reason: "duplicate-message" };
        }
        consumeAdmission();
        return { ok: true, created: false, record: cloneRecord(duplicateMessage) };
      }
      const existingIndex = this.findIndex(input.handlerId, input.childSessionId);
      if (existingIndex >= 0) {
        const existing = this.records[existingIndex]!;
        if (!hasExactInitialStoredMessage(existing, assignedMessage)) {
          return { ok: false, reason: "duplicate-message" };
        }
        consumeAdmission();
        return { ok: true, created: false, record: cloneRecord(existing) };
      }

      const removeCount = this.removalCountForAdmission(input.handlerId);
      let removable = new Set<string>();
      if (removeCount > 0) {
        const terminal = this.records
          .filter((record) =>
            record.handlerId === input.handlerId
            && isA2ATerminalTaskState(record.task.status.state))
          .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
        if (terminal.length < removeCount) return { ok: false, reason: "capacity-exceeded" };
        removable = new Set(
          terminal.slice(0, removeCount).map((record) => record.childSessionId),
        );
      }

      const timestamp = this.now();
      const record: A2ATaskRecord = {
        handlerId: input.handlerId,
        childSessionId: input.childSessionId,
        createdAt: timestamp,
        updatedAt: timestamp,
        task: {
          id: input.childSessionId,
          contextId: input.contextId,
          status: { state: A2ATaskState.SUBMITTED, timestamp },
          history: [assignedMessage],
        },
      };
      const previous = structuredClone(this.records);
      this.records = this.records.filter((candidate) =>
        candidate.handlerId !== input.handlerId
        || !removable.has(candidate.childSessionId));
      this.records.push(record);
      try {
        await this.persistUnlocked();
      } catch (error) {
        this.records = previous;
        throw error;
      }
      consumeAdmission();
      return { ok: true, created: true, record: cloneRecord(record) };
    });
  }

  async beginContinuation(input: {
    handlerId: string;
    taskId: string;
    contextId?: string;
    message: A2AMessage;
  }): Promise<A2ATaskContinuationResult> {
    return await this.withLock(async () => {
      const inspected = this.inspectContinuationUnlocked(input);
      if (!inspected.ok) return inspected;
      if (inspected.duplicate) {
        return { ok: true, duplicate: true, record: cloneRecord(inspected.record) };
      }
      const record = inspected.record;
      const previous = structuredClone(this.records);
      const timestamp = this.now();
      record.task.history = [...(record.task.history ?? []), inspected.message];
      record.task.status = { state: A2ATaskState.WORKING, timestamp };
      record.updatedAt = timestamp;
      try {
        await this.persistUnlocked();
      } catch (error) {
        this.records = previous;
        throw error;
      }
      return { ok: true, duplicate: false, record: cloneRecord(record) };
    });
  }

  /**
   * Validate a continuation without changing task state or durable history.
   * Callers must still use {@link beginContinuation} after authorization so
   * races are revalidated under the store lock before the mutation commits.
   */
  async preflightContinuation(input: {
    handlerId: string;
    taskId: string;
    contextId?: string;
    message: A2AMessage;
  }): Promise<A2ATaskContinuationResult> {
    return await this.withLock(() => {
      const inspected = this.inspectContinuationUnlocked(input);
      if (!inspected.ok) return inspected;
      return {
        ok: true,
        duplicate: inspected.duplicate,
        record: cloneRecord(inspected.record),
      };
    });
  }

  async transition(input: {
    handlerId: string;
    taskId: string;
    state: A2AProjectedTaskState;
    message?: A2AMessage;
  }): Promise<A2ATaskTransitionResult> {
    return await this.withLock(async () => {
      const index = this.findIndex(input.handlerId, input.taskId);
      if (index < 0) return { ok: false, reason: "task-not-found" };
      const record = this.records[index]!;
      const current = record.task.status.state;
      if (isA2ATerminalTaskState(current)) {
        return { ok: true, changed: false, record: cloneRecord(record) };
      }
      if (!canTransitionA2ATaskState(current, input.state)) {
        return { ok: false, reason: "invalid-transition" };
      }
      const previous = structuredClone(this.records);
      let message: A2AMessage | undefined;
      if (input.message) {
        message = normalizeStoredMessage({
          ...structuredClone(input.message),
          contextId: record.task.contextId,
          taskId: record.task.id,
        }) ?? undefined;
        if (!message || message.role !== A2ARole.AGENT) {
          return { ok: false, reason: "invalid-message" };
        }
        const duplicate = this.findMessageRecord(input.handlerId, message.messageId);
        if (duplicate && duplicate.task.id !== input.taskId) {
          return { ok: false, reason: "invalid-message" };
        }
        if (
          !duplicate
          && (record.task.history?.length ?? 0) >= this.options.maxHistoryMessages
        ) {
          return { ok: false, reason: "history-capacity-exceeded" };
        }
        if (!duplicate) record.task.history = [...(record.task.history ?? []), message];
      }
      const timestamp = this.now();
      record.task.status = {
        state: input.state,
        timestamp,
        ...(message ? { message } : {}),
      };
      record.updatedAt = timestamp;
      try {
        await this.persistUnlocked();
      } catch (error) {
        this.records = previous;
        throw error;
      }
      return { ok: true, changed: true, record: cloneRecord(record) };
    });
  }
}
