import { randomUUID } from "node:crypto";
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
import { A2AHandlerError, type A2ARequestHandler } from "./a2a-router.js";
import {
  A2ATaskStore,
  isA2ARfc3339Timestamp,
  type A2ATaskContinuationResult,
  type A2ATaskCreateResult,
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
  outcome: "masked" | "dropped";
  reason:
    | "dlp-masked"
    | "cross-origin"
    | "invalid-message"
    | "unknown-task"
    | "task-not-resumable"
    | "task-not-cancelable"
    | "task-budget-exceeded"
    | "storage-failed"
    | "runner-failed";
  handlerId: string;
  taskId?: string;
  messageId?: string;
  detectionCount?: number;
}

export interface CreateA2ASubAgentHandlerOptions {
  id: string;
  card: A2AAgentCardTemplate;
  binding: A2AWireHostBinding;
  runner: A2ASubAgentLifecycleRunner;
  store: A2ATaskStore;
  makeId?: () => string;
  audit?: (event: A2ATaskLifecycleAuditEvent) => void;
}

export class A2ASubAgentHandler implements A2ARequestHandler {
  readonly id: string;
  readonly card: A2AAgentCardTemplate;
  private readonly makeId: () => string;
  private readonly initialInFlight = new Map<string, Promise<A2ATask>>();
  private readonly taskQueues = new Map<string, Promise<void>>();

  constructor(private readonly options: CreateA2ASubAgentHandlerOptions) {
    if (options.id !== options.binding.handlerId) {
      throw new Error("A2A handler binding id mismatch");
    }
    this.id = options.id;
    this.card = options.card;
    this.makeId = options.makeId ?? randomUUID;
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

  private audit(
    reason: A2ATaskLifecycleAuditEvent["reason"],
    outcome: A2ATaskLifecycleAuditEvent["outcome"],
    identifiers: {
      taskId?: string;
      messageId?: string;
      detectionCount?: number;
    } = {},
  ): void {
    this.options.audit?.({
      type: "a2a-task-lifecycle",
      outcome,
      reason,
      handlerId: this.id,
      ...identifiers,
    });
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
    const text = maskSensitiveData(rawText).masked.slice(0, GUIDE_MAX_CHARS);
    const messageId = this.newId();
    if (!isSafeA2AMessageId(messageId)) {
      throw new Error("A2A id generator returned an invalid message id");
    }
    return {
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
                ...(input.suspension.prompt ? { prompt: input.suspension.prompt } : {}),
                resumeId: input.suspension.resumeId,
              },
            }
          : {}),
      },
    };
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
    const transitioned = await this.options.store.transition({
      handlerId: this.id,
      taskId: record.task.id,
      state: snapshot.taskState,
      message: this.makeStatusMessage(record, snapshot.taskState, {
        summary: snapshot.summary,
        suspension: snapshot.suspension,
      }),
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
    const transitioned = await this.options.store.transition({
      handlerId: this.id,
      taskId,
      state,
      message: this.makeStatusMessage(record, state, {
        summary: result.summary,
        suspension: result.suspension,
      }),
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
    const failed = await this.options.store.transition({
      handlerId: this.id,
      taskId,
      state: A2ATaskState.FAILED,
      message: this.makeStatusMessage(current, A2ATaskState.FAILED),
    });
    if (!failed.ok) throw new Error("A2A failed task could not be finalized");
    this.audit("runner-failed", "dropped", { taskId });
    return failed.record;
  }

  private async createInitialTask(parsed: ParsedSend): Promise<A2ATask> {
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
    })();

    if (!parsed.returnImmediately) {
      return projectTask((await execution).task, parsed.historyLength);
    }
    const winner = await Promise.race([
      linked.then(() => "linked" as const),
      execution.then(() => "finished" as const),
    ]);
    if (winner === "finished") {
      return projectTask((await execution).task, parsed.historyLength);
    }
    void execution.catch(() => {
      this.audit("storage-failed", "dropped", { taskId: linkedTaskId });
    });
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
      const existing = this.initialInFlight.get(key);
      if (existing) return await existing;
      const pending = this.createInitialTask(parsed);
      this.initialInFlight.set(key, pending);
      try {
        return await pending;
      } finally {
        this.initialInFlight.delete(key);
      }
    }

    const begun = await this.withTaskLock(
      parsed.message.taskId,
      async (): Promise<A2ATaskContinuationResult> => {
        const current = await this.options.store.get(this.id, parsed.message.taskId!);
        if (!current) return { ok: false, reason: "task-not-found" };
        await this.reconcile(current);
        return await this.options.store.beginContinuation({
          handlerId: this.id,
          taskId: parsed.message.taskId!,
          contextId: parsed.message.contextId,
          message: parsed.message,
        });
      },
    );
    if (!begun.ok) {
      const reason = begun.reason === "task-not-found"
        ? "unknown-task"
        : begun.reason === "history-capacity-exceeded"
          ? "task-budget-exceeded"
          : "task-not-resumable";
      this.audit(reason, "dropped", {
        taskId: parsed.message.taskId,
        messageId: parsed.message.messageId,
      });
      throw new A2AHandlerError(
        begun.reason === "task-not-found"
          ? A2AJsonRpcErrorDefinition.TASK_NOT_FOUND
          : StandardJsonRpcErrorDefinition.INVALID_PARAMS,
      );
    }
    if (begun.duplicate) return projectTask(begun.record.task, parsed.historyLength);

    const execution = (async () => {
      try {
        const result = await this.options.runner.resumeFromA2AWire(
          { resumeId: begun.record.childSessionId, messageText: parsed.prompt },
          { handlerId: this.id },
        );
        return await this.withTaskLock(
          begun.record.childSessionId,
          () => this.finalize(begun.record.childSessionId, result),
        );
      } catch (error) {
        try {
          return await this.withTaskLock(
            begun.record.childSessionId,
            () => this.markRunnerFailure(begun.record.childSessionId),
          );
        } catch {
          throw error;
        }
      }
    })();
    if (parsed.returnImmediately) {
      void execution.catch(() => {
        this.audit("runner-failed", "dropped", { taskId: begun.record.task.id });
      });
      return projectTask(begun.record.task, parsed.historyLength);
    }
    return projectTask((await execution).task, parsed.historyLength);
  }

  private async getTask(params: A2AJsonObject): Promise<A2ATask> {
    const parsed = parseGet(params);
    const record = await this.options.store.get(this.id, parsed.id);
    if (!record) {
      this.audit("unknown-task", "dropped", { taskId: parsed.id });
      throw new A2AHandlerError(A2AJsonRpcErrorDefinition.TASK_NOT_FOUND);
    }
    return projectTask((await this.reconcile(record)).task, parsed.historyLength);
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
    return await this.withTaskLock(taskId, () => this.cancelTaskLocked(taskId));
  }

  private async cancelTaskLocked(taskId: string): Promise<A2ATask> {
    const stored = await this.options.store.get(this.id, taskId);
    if (!stored) {
      this.audit("unknown-task", "dropped", { taskId });
      throw new A2AHandlerError(A2AJsonRpcErrorDefinition.TASK_NOT_FOUND);
    }
    const record = await this.reconcile(stored);
    const state = record.task.status.state;
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
    const transitioned = await this.options.store.transition({
      handlerId: this.id,
      taskId,
      state: A2ATaskState.CANCELED,
      message: this.makeStatusMessage(record, A2ATaskState.CANCELED),
    });
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
