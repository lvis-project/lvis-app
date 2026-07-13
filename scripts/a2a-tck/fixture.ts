import { createHash } from "node:crypto";
import {
  A2AHandlerError,
  type A2ARequestHandler,
} from "../../src/api/a2a-router.js";
import {
  A2AJsonRpcErrorDefinition,
  A2AJsonRpcMethod,
  StandardJsonRpcErrorDefinition,
  type A2ADirectJsonRpcMethod,
  type A2ADirectJsonRpcResult,
  type A2AJsonObject,
} from "../../src/shared/a2a-wire.js";
import {
  A2ARole,
  A2ATaskState,
  isA2ATerminalTaskState,
  type A2AArtifact,
  type A2ADataPart,
  type A2AMessage,
  type A2APart,
  type A2ATask,
} from "../../src/shared/a2a.js";

const TEXT_MODE = "text/plain";
const DATA_MODE = "application/json";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hashId(prefix: string, value: string): string {
  return prefix + "-" + createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return undefined;
  return [...value];
}

function jsonData(value: unknown): A2ADataPart["data"] | undefined {
  try {
    return JSON.parse(JSON.stringify(value)) as A2ADataPart["data"];
  } catch {
    return undefined;
  }
}

function canonicalPart(value: unknown): A2APart | undefined {
  if (!isRecord(value)) return undefined;
  const base = {
    ...(optionalString(value.filename) ? { filename: value.filename as string } : {}),
    ...(optionalString(value.mediaType) ? { mediaType: value.mediaType as string } : {}),
  };
  if (typeof value.text === "string") return { ...base, text: value.text };
  if (typeof value.raw === "string") return { ...base, raw: value.raw };
  if (typeof value.url === "string") return { ...base, url: value.url };
  if ("data" in value) {
    const data = jsonData(value.data);
    if (data !== undefined) return { ...base, data };
  }
  return undefined;
}

function canonicalMessage(value: unknown): A2AMessage {
  if (!isRecord(value) || typeof value.messageId !== "string" || value.messageId.length === 0) {
    throw new A2AHandlerError(StandardJsonRpcErrorDefinition.INVALID_PARAMS);
  }
  if (value.role !== A2ARole.USER) {
    throw new A2AHandlerError(StandardJsonRpcErrorDefinition.INVALID_PARAMS);
  }
  if (!Array.isArray(value.parts)) {
    throw new A2AHandlerError(StandardJsonRpcErrorDefinition.INVALID_PARAMS);
  }
  const parts = value.parts.map(canonicalPart).filter((part): part is A2APart => part !== undefined);
  if (parts.length === 0 || parts.length !== value.parts.length) {
    throw new A2AHandlerError(StandardJsonRpcErrorDefinition.INVALID_PARAMS);
  }
  return {
    messageId: value.messageId,
    role: A2ARole.USER,
    parts: parts as [A2APart, ...A2APart[]],
    ...(optionalString(value.taskId) ? { taskId: value.taskId as string } : {}),
    ...(optionalString(value.contextId) ? { contextId: value.contextId as string } : {}),
    ...(stringList(value.extensions) ? { extensions: stringList(value.extensions) } : {}),
    ...(stringList(value.referenceTaskIds)
      ? { referenceTaskIds: stringList(value.referenceTaskIds) }
      : {}),
  };
}

function agentMessage(taskId: string | undefined, contextId: string, text: string): A2AMessage {
  return {
    messageId: hashId("agent", contextId + ":" + text),
    role: A2ARole.AGENT,
    parts: [{ text }],
    contextId,
    ...(taskId ? { taskId } : {}),
  };
}

function artifactFor(messageId: string): A2AArtifact[] | undefined {
  const artifactId = hashId("artifact", messageId);
  if (messageId.startsWith("tck-artifact-text-")) {
    return [{ artifactId, name: "text", parts: [{ text: "Generated text content" }] }];
  }
  if (messageId.startsWith("tck-artifact-file-url-")) {
    return [
      {
        artifactId,
        name: "file-url",
        parts: [
          {
            url: "https://example.invalid/a2a-tck.txt",
            filename: "output.txt",
            mediaType: TEXT_MODE,
          },
        ],
      },
    ];
  }
  if (messageId.startsWith("tck-artifact-file-")) {
    return [
      {
        artifactId,
        name: "file",
        parts: [
          {
            raw: Buffer.from("A2A TCK file artifact", "utf8").toString("base64"),
            filename: "output.txt",
            mediaType: TEXT_MODE,
          },
        ],
      },
    ];
  }
  if (messageId.startsWith("tck-artifact-data-")) {
    return [
      {
        artifactId,
        name: "data",
        parts: [{ data: { key: "value", count: 42 }, mediaType: DATA_MODE }],
      },
    ];
  }
  return undefined;
}

function timestamp(): string {
  return new Date().toISOString();
}

function historyLength(params: A2AJsonObject): number | undefined {
  const raw = params.historyLength ?? params.history_length;
  if (raw === undefined) return undefined;
  const value = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : raw;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new A2AHandlerError(StandardJsonRpcErrorDefinition.INVALID_PARAMS);
  }
  return value;
}

function pageSize(params: A2AJsonObject): number {
  const raw = params.pageSize ?? params.page_size;
  if (raw === undefined || raw === 0 || raw === "0") return 50;
  const value = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : raw;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 100) {
    throw new A2AHandlerError(StandardJsonRpcErrorDefinition.INVALID_PARAMS);
  }
  return value;
}

function sendHistoryLength(params: A2AJsonObject): number | undefined {
  const configuration = params.configuration;
  if (configuration === undefined) return undefined;
  if (!isRecord(configuration)) {
    throw new A2AHandlerError(StandardJsonRpcErrorDefinition.INVALID_PARAMS);
  }
  return historyLength(configuration as A2AJsonObject);
}

function taskView(  source: A2ATask,
  options: { historyLength?: number; includeArtifacts?: boolean } = {},
): A2ATask {
  const task = structuredClone(source);
  if (options.historyLength !== undefined && task.history) {
    task.history =
      options.historyLength === 0 ? [] : task.history.slice(-options.historyLength);
  }
  if (options.includeArtifacts === false) delete task.artifacts;
  return task;
}

function taskStateFor(messageId: string): A2ATaskState {
  if (messageId.startsWith("tck-input-required-")) return A2ATaskState.INPUT_REQUIRED;
  if (messageId.startsWith("tck-reject-task-")) return A2ATaskState.REJECTED;
  return A2ATaskState.COMPLETED;
}

export class A2ATckFixtureHandler implements A2ARequestHandler {
  readonly id = "tck";
  readonly card: A2ARequestHandler["card"] = {
    name: "LVIS A2A TCK fixture",
    description: "Deterministic A2A v1 JSON-RPC conformance fixture",
    version: "1.0.0",
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extendedAgentCard: false,
    },
    skills: [
      {
        id: "deterministic-conformance",
        name: "Deterministic conformance",
        description: "Produces deterministic task, message, and artifact outcomes",
        tags: ["a2a", "conformance"],
        examples: ["Complete a task", "Request input", "Return an artifact"],
      },
    ],
    defaultInputModes: [TEXT_MODE, DATA_MODE],
    defaultOutputModes: [TEXT_MODE, DATA_MODE],
    securitySchemes: {
      bearerAuth: {
        httpAuthSecurityScheme: {
          scheme: "Bearer",
          description: "Per-boot loopback capability token",
        },
      },
    },
    securityRequirements: [{ schemes: { bearerAuth: { list: [] } } }],
  };

  private readonly tasks = new Map<string, A2ATask>();

  async handle(
    method: A2ADirectJsonRpcMethod,
    params: A2AJsonObject,
  ): Promise<A2ADirectJsonRpcResult> {
    switch (method) {
      case A2AJsonRpcMethod.SEND_MESSAGE:
        return this.sendMessage(params);
      case A2AJsonRpcMethod.GET_TASK:
        return this.getTask(params);
      case A2AJsonRpcMethod.LIST_TASKS:
        return this.listTasks(params);
      case A2AJsonRpcMethod.CANCEL_TASK:
        return this.cancelTask(params);
    }
  }

  private sendMessage(params: A2AJsonObject): A2ADirectJsonRpcResult {
    const message = canonicalMessage(params.message);
    if (message.messageId.startsWith("tck-message-response-")) {
      const contextId = message.contextId ?? hashId("context", message.messageId);
      return {
        message: agentMessage(undefined, contextId, "Direct message response"),
      };
    }

    const maxHistory = sendHistoryLength(params);
    if (message.taskId) return this.continueTask(message, maxHistory);

    const taskId = hashId("task", message.messageId);
    const contextId = message.contextId ?? hashId("context", message.messageId);
    const state = taskStateFor(message.messageId);
    const statusMessage =
      state === A2ATaskState.INPUT_REQUIRED
        ? agentMessage(taskId, contextId, "Additional input is required")
        : undefined;
    const task: A2ATask = {
      id: taskId,
      contextId,
      status: {
        state,
        timestamp: timestamp(),
        ...(statusMessage ? { message: statusMessage } : {}),
      },
      history: [message],
      ...(artifactFor(message.messageId)
        ? { artifacts: artifactFor(message.messageId) }
        : {}),
    };
    this.tasks.set(taskId, task);
    return { task: taskView(task, { historyLength: maxHistory }) };
  }

  private continueTask(
    message: A2AMessage,
    maxHistory?: number,
  ): A2ADirectJsonRpcResult {
    const task = this.tasks.get(message.taskId!);
    if (!task) {
      throw new A2AHandlerError(A2AJsonRpcErrorDefinition.TASK_NOT_FOUND);
    }
    if (message.contextId && message.contextId !== task.contextId) {
      throw new A2AHandlerError(StandardJsonRpcErrorDefinition.INVALID_PARAMS);
    }
    if (isA2ATerminalTaskState(task.status.state)) {
      throw new A2AHandlerError(A2AJsonRpcErrorDefinition.UNSUPPORTED_OPERATION);
    }

    message.contextId = task.contextId;
    task.history ??= [];
    task.history.push(message);
    const completes = message.messageId.startsWith("tck-complete-task-");
    task.status = {
      state: completes ? A2ATaskState.COMPLETED : A2ATaskState.INPUT_REQUIRED,
      timestamp: timestamp(),
      ...(completes
        ? {}
        : {
            message: agentMessage(
              task.id,
              task.contextId!,
              "Additional input is still required",
            ),
          }),
    };
    return { task: taskView(task, { historyLength: maxHistory }) };
  }

  private getTask(params: A2AJsonObject): A2ATask {
    const id = optionalString(params.id);
    if (!id) throw new A2AHandlerError(StandardJsonRpcErrorDefinition.INVALID_PARAMS);
    const task = this.tasks.get(id);
    if (!task) throw new A2AHandlerError(A2AJsonRpcErrorDefinition.TASK_NOT_FOUND);
    return taskView(task, { historyLength: historyLength(params) });
  }

  private listTasks(params: A2AJsonObject): A2ADirectJsonRpcResult {
    const contextId = optionalString(params.contextId ?? params.context_id);
    const status = optionalString(params.status);
    const after = optionalString(params.statusTimestampAfter ?? params.status_timestamp_after);
    const before = optionalString(
      params.statusTimestampBefore ?? params.status_timestamp_before,
    );
    const requestedPageSize = pageSize(params);
    const token = params.pageToken ?? params.page_token ?? "0";
    const offset =
      typeof token === "string" && /^\d+$/.test(token) ? Number(token) : Number.NaN;
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new A2AHandlerError(StandardJsonRpcErrorDefinition.INVALID_PARAMS);
    }

    const filtered = [...this.tasks.values()].filter((task) => {
      if (contextId && task.contextId !== contextId) return false;
      if (status && task.status.state !== status) return false;
      const statusTime = task.status.timestamp ?? "";
      if (after && statusTime < after) return false;
      if (before && statusTime > before) return false;
      return true;
    });
    const page = filtered.slice(offset, offset + requestedPageSize);
    const nextOffset = offset + page.length;
    const includeArtifacts =
      (params.includeArtifacts ?? params.include_artifacts) === true;
    const maxHistory = historyLength(params);

    return {
      tasks: page.map((task) =>
        taskView(task, { historyLength: maxHistory, includeArtifacts }),
      ),
      nextPageToken: nextOffset < filtered.length ? String(nextOffset) : "",
      pageSize: page.length,
      totalSize: filtered.length,
    };
  }

  private cancelTask(params: A2AJsonObject): A2ATask {
    const id = optionalString(params.id);
    if (!id) throw new A2AHandlerError(StandardJsonRpcErrorDefinition.INVALID_PARAMS);
    const task = this.tasks.get(id);
    if (!task) throw new A2AHandlerError(A2AJsonRpcErrorDefinition.TASK_NOT_FOUND);
    if (isA2ATerminalTaskState(task.status.state)) {
      throw new A2AHandlerError(A2AJsonRpcErrorDefinition.TASK_NOT_CANCELABLE);
    }
    task.status = {
      state: A2ATaskState.CANCELED,
      timestamp: timestamp(),
    };
    return taskView(task);
  }
}