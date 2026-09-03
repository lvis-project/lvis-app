import { afterEach, describe, expect, it, vi } from "vitest";
import {
  A2ARole,
  A2ATaskState,
  type A2AJsonObject,
  type A2AMessage,
  type A2ATask,
} from "../../shared/a2a.js";
import {
  A2AJsonRpcMethod,
  type A2AAgentCardTemplate,
  type A2AListTasksResult,
} from "../../shared/a2a-wire.js";
import type {
  A2AWireHostBinding,
  SubAgentSpawnResult,
} from "../../engine/subagent-runner.js";
import { GUIDE_MAX_CHARS } from "../../engine/turn/guidance-limits.js";
import { maskSensitiveData } from "../../shared/dlp.js";
import { createInMemoryFeatureNamespace } from "../../__tests__/test-helpers.js";
import {
  A2A_INPUT_REQUIRED_EXPIRY_RETRY_MS,
  A2A_INPUT_REQUIRED_TTL_MS,
  A2ASubAgentHandler,
  createA2AContextId,
  type A2ASubAgentLifecycleRunner,
  type A2AWireAuthorizationDescriptor,
  type A2AWireAuthorizer,
} from "../a2a-subagent-handler.js";
import { A2ATaskStore } from "../a2a-task-store.js";
import { UUID_PATTERN } from "../../shared/uuid.js";
import { monotonicIsoClock as clock } from "./a2a-test-helpers.js";

const HANDLER_ID = "profile-a";
const TASK_ID = "sub-7bc35644-8737bb97-eb8b-4e75-85c9-1e9b9abd3671";

function completedResult(
  childSessionId = TASK_ID,
  summary = "completed output",
): SubAgentSpawnResult {
  return {
    summary,
    toolCallCount: 1,
    turnCount: 1,
    childSessionId,
    entries: [],
    ok: true,
    stopReason: "end_turn",
  };
}

function waitingResult(childSessionId = TASK_ID): SubAgentSpawnResult {
  return {
    summary: "partial",
    toolCallCount: 1,
    turnCount: 1,
    childSessionId,
    entries: [],
    ok: true,
    stopReason: "round-cap",
    suspension: {
      reason: "budget",
      prompt: "Send any message to continue.",
      resumeId: childSessionId,
    },
    incomplete: true,
  };
}

function binding(handlerId = HANDLER_ID): A2AWireHostBinding {
  return {
    handlerId,
    profile: {
      name: "wire profile",
      body: "Follow the profile.",
      sourceTools: [],
    },
    project: {
      root: "C:\\safe-project",
      name: "Safe Project",
    },
  };
}

function card(): A2AAgentCardTemplate {
  return {
    name: "Wire profile",
    description: "A test profile",
    version: "1.0.0",
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extendedAgentCard: false,
    },
    skills: [{
      id: "work",
      name: "Work",
      description: "Performs work",
      tags: ["test"],
    }],
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
  };
}

/** `A2AMessage` is an interface, so widening is needed to satisfy `A2AJsonObject`. */
function sendParams(message: A2AMessage): A2AJsonObject {
  return { message } as unknown as A2AJsonObject;
}

function userMessage(
  messageId: string,
  overrides: Partial<A2AMessage> = {},
): A2AMessage {
  return {
    messageId,
    role: A2ARole.USER,
    parts: [{ text: "hello" }],
    ...overrides,
  };
}

function makeHarness(
  handlerId = HANDLER_ID,
  options: {
    authorizeOperation?: A2AWireAuthorizer;
    omitAuthorizeOperation?: boolean;
    maxTasks?: number;
    maxHistoryMessages?: number;
    now?: () => string;
  } = {},
) {
  const store = new A2ATaskStore({
    namespace: createInMemoryFeatureNamespace().handle,
    maxTasks: options.maxTasks ?? 10,
    maxHistoryMessages: options.maxHistoryMessages ?? 16,
    now: options.now ?? clock(),
  });
  const audit = vi.fn();
  const runner = {
    spawnFromA2AWire: vi.fn(async (_request, _binding, callbacks) => {
      await callbacks.onDurablyLinked({ childSessionId: TASK_ID });
      return completedResult();
    }),
    resumeFromA2AWire: vi.fn(async () => completedResult()),
    getA2AWireRunSnapshot: vi.fn(() => null),
    cancelA2AWireRun: vi.fn(async (childSessionId: string) => ({
      ok: true as const,
      run: {
        childSessionId,
        title: "wire profile",
        taskState: A2ATaskState.CANCELED,
      },
    })),
  };
  const authorizeOperation = vi.fn<A2AWireAuthorizer>(
    options.authorizeOperation ?? (async () => true),
  );
  let id = 0;
  const handlerOptions = {
    id: handlerId,
    card: card(),
    binding: binding(handlerId),
    runner: runner as unknown as A2ASubAgentLifecycleRunner,
    store,
    authorizeOperation,
    makeId: () => "server-id-" + String(++id),
    audit,
  };
  if (options.omitAuthorizeOperation) {
    delete (handlerOptions as { authorizeOperation?: A2AWireAuthorizer }).authorizeOperation;
  }
  const handler = new A2ASubAgentHandler(handlerOptions);
  return { store, runner, audit, authorizeOperation, handler };
}

afterEach(() => {
  vi.useRealTimers();
});

function taskFrom(result: unknown): A2ATask {
  return (result as { task: A2ATask }).task;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function seedWorkingTask(
  store: A2ATaskStore,
  handlerId: string,
  taskId: string,
  contextId: string,
  messageId: string,
): Promise<void> {
  await store.create({
    handlerId,
    childSessionId: taskId,
    contextId,
    message: userMessage(messageId),
  });
  await store.transition({
    handlerId,
    taskId,
    state: A2ATaskState.WORKING,
  });
}

async function seedInputRequiredTask(
  store: A2ATaskStore,
  taskId: string,
  contextId: string,
  messageId: string,
): Promise<void> {
  await seedWorkingTask(
    store,
    HANDLER_ID,
    taskId,
    contextId,
    messageId + "-start",
  );
  await store.transition({
    handlerId: HANDLER_ID,
    taskId,
    state: A2ATaskState.INPUT_REQUIRED,
    message: userMessage(messageId + "-waiting", {
      role: A2ARole.AGENT,
      parts: [{ text: "continue" }],
    }),
  });
}

describe("A2ASubAgentHandler", () => {
  it("generates unique DLP-safe UUID-compatible default context and status ids", async () => {
    const ids = Array.from({ length: 64 }, () => createA2AContextId());
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(UUID_PATTERN);
      expect(maskSensitiveData(id).detections).toEqual([]);
    }

    const { store, runner, audit, authorizeOperation } = makeHarness();
    const handler = new A2ASubAgentHandler({
      id: HANDLER_ID,
      card: card(),
      binding: binding(HANDLER_ID),
      runner: runner as unknown as A2ASubAgentLifecycleRunner,
      store,
      authorizeOperation,
      audit,
    });
    const task = taskFrom(await handler.handle(A2AJsonRpcMethod.SEND_MESSAGE, {
      message: userMessage("default-generated-status"),
    }));
    expect(task.status.message?.messageId).toMatch(UUID_PATTERN);
    expect(maskSensitiveData(task.status.message?.messageId ?? "").detections).toEqual([]);
  });

  it("fails closed before the initial runner/store mutation when consent is denied", async () => {
    const authorizeOperation = vi.fn(async () => false);
    const { handler, runner, store, audit } = makeHarness(HANDLER_ID, {
      authorizeOperation,
    });

    await expect(handler.handle(A2AJsonRpcMethod.SEND_MESSAGE, {
      message: userMessage("wire-consent-denied", {
        parts: [{ text: "inspect sk-abcdefgh12345678" }],
      }),
    })).rejects.toMatchObject({
      definition: {
        code: -32010,
        reason: "OPERATION_REJECTED",
      },
    });

    expect(authorizeOperation).toHaveBeenCalledWith({
      operation: "send-message",
      handlerId: HANDLER_ID,
      messageId: "wire-consent-denied",
    });
    expect(runner.spawnFromA2AWire).not.toHaveBeenCalled();
    await expect(store.list(HANDLER_ID)).resolves.toEqual([]);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      type: "a2a-task-lifecycle",
      outcome: "dropped",
      reason: "consent-denied",
      operation: "send-message",
      messageId: "wire-consent-denied",
    }));
    expect(JSON.stringify(authorizeOperation.mock.calls)).not.toContain("sk-abcdefgh12345678");
    expect(JSON.stringify(audit.mock.calls)).not.toContain("sk-abcdefgh12345678");
  });

  it.each(["missing", "throw"] as const)(
    "fails closed with OPERATION_REJECTED when the authorizer is %s",
    async (mode) => {
      const authorizeOperation = vi.fn(async () => {
        throw new Error("private approval detail");
      });
      const { handler, runner, store, audit } = makeHarness(HANDLER_ID, {
        ...(mode === "throw" ? { authorizeOperation } : {}),
        omitAuthorizeOperation: mode === "missing",
      });

      await expect(handler.handle(A2AJsonRpcMethod.SEND_MESSAGE, {
        message: userMessage("wire-consent-" + mode),
      })).rejects.toMatchObject({ definition: { code: -32010 } });
      expect(runner.spawnFromA2AWire).not.toHaveBeenCalled();
      await expect(store.list(HANDLER_ID)).resolves.toEqual([]);
      expect(audit).toHaveBeenCalledWith(expect.objectContaining({
        reason: "consent-denied",
      }));
      expect(JSON.stringify(audit.mock.calls)).not.toContain("private approval detail");
    },
  );

  it("releases an initial admission after denial so later work can be approved", async () => {
    const authorizeOperation = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const { handler, runner } = makeHarness(HANDLER_ID, { authorizeOperation });

    await expect(handler.handle(A2AJsonRpcMethod.SEND_MESSAGE, {
      message: userMessage("wire-admission-denied"),
    })).rejects.toMatchObject({ definition: { code: -32010 } });
    const approved = taskFrom(await handler.handle(A2AJsonRpcMethod.SEND_MESSAGE, {
      message: userMessage("wire-admission-after-denial"),
    }));

    expect(approved.id).toBe(TASK_ID);
    expect(authorizeOperation).toHaveBeenCalledTimes(2);
    expect(runner.spawnFromA2AWire).toHaveBeenCalledOnce();
  });

  it("keeps the fixed rejection when the audit sink throws", async () => {
    const authorizeOperation = vi.fn(async () => false);
    const { handler, runner, store, audit } = makeHarness(HANDLER_ID, {
      authorizeOperation,
    });
    audit.mockImplementation(() => {
      throw new Error("audit sink failed");
    });

    await expect(handler.handle(A2AJsonRpcMethod.SEND_MESSAGE, {
      message: userMessage("wire-consent-audit-failure"),
    })).rejects.toMatchObject({ definition: { code: -32010 } });

    expect(authorizeOperation).toHaveBeenCalledOnce();
    expect(runner.spawnFromA2AWire).not.toHaveBeenCalled();
    await expect(store.list(HANDLER_ID)).resolves.toEqual([]);
  });

  it("rejects invalid send input before requesting consent", async () => {
    const { handler, runner, store, authorizeOperation } = makeHarness();

    await expect(handler.handle(A2AJsonRpcMethod.SEND_MESSAGE, {
      message: userMessage("wire-invalid-raw", {
        parts: [{ raw: "c2VjcmV0", mediaType: "application/octet-stream" }],
      }),
    })).rejects.toMatchObject({ definition: { code: -32005 } });

    expect(authorizeOperation).not.toHaveBeenCalled();
    expect(runner.spawnFromA2AWire).not.toHaveBeenCalled();
    await expect(store.list(HANDLER_ID)).resolves.toEqual([]);
  });

  it("commits a DLP-clean WORKING task before provider work and then completes it", async () => {
    const { handler, runner, store, audit } = makeHarness();
    let stateAtProviderStart: string | undefined;
    runner.spawnFromA2AWire.mockImplementation(async (_request, _binding, callbacks) => {
      await callbacks.onDurablyLinked({ childSessionId: TASK_ID });
      stateAtProviderStart = (await store.get(HANDLER_ID, TASK_ID))?.task.status.state;
      return completedResult(TASK_ID, "safe result");
    });

    const result = await handler.handle(A2AJsonRpcMethod.SEND_MESSAGE, {
      message: userMessage("wire-message-1", {
        parts: [{ text: "inspect sk-abcdefgh12345678" }],
      }),
    });
    const task = taskFrom(result);

    expect(stateAtProviderStart).toBe(A2ATaskState.WORKING);
    expect(task).toMatchObject({
      id: TASK_ID,
      status: { state: A2ATaskState.COMPLETED },
    });
    expect(task.history?.map((message) => message.role)).toEqual([
      A2ARole.USER,
      A2ARole.AGENT,
    ]);
    expect(JSON.stringify(task)).not.toContain("sk-abcdefgh12345678");
    expect(JSON.stringify(audit.mock.calls)).not.toContain("sk-abcdefgh12345678");
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      type: "a2a-task-lifecycle",
      outcome: "masked",
      reason: "dlp-masked",
      messageId: "wire-message-1",
    }));
  });

  it("round-trips INPUT_REQUIRED suspension metadata and resumes the same task", async () => {
    const { handler, runner } = makeHarness();
    runner.spawnFromA2AWire.mockImplementation(async (_request, _binding, callbacks) => {
      await callbacks.onDurablyLinked({ childSessionId: TASK_ID });
      return waitingResult();
    });
    runner.resumeFromA2AWire.mockResolvedValue(completedResult());

    const first = taskFrom(await handler.handle(A2AJsonRpcMethod.SEND_MESSAGE, {
      message: userMessage("wire-question-1"),
    }));
    expect(first.status).toMatchObject({
      state: A2ATaskState.INPUT_REQUIRED,
      message: {
        metadata: {
          taskState: A2ATaskState.INPUT_REQUIRED,
          suspension: {
            reason: "budget",
            resumeId: TASK_ID,
          },
        },
      },
    });

    const second = taskFrom(await handler.handle(A2AJsonRpcMethod.SEND_MESSAGE, {
      message: userMessage("wire-answer-1", {
        taskId: TASK_ID,
        contextId: first.contextId,
        parts: [{ text: "continue" }],
      }),
    }));
    expect(second.status.state).toBe(A2ATaskState.COMPLETED);
    expect(second.history?.map((message) => message.role)).toEqual([
      A2ARole.USER,
      A2ARole.AGENT,
      A2ARole.USER,
      A2ARole.AGENT,
    ]);
    expect(runner.resumeFromA2AWire).toHaveBeenCalledWith(
      { resumeId: TASK_ID, messageText: "continue" },
      { handlerId: HANDLER_ID },
    );
  });

  it("masks and bounds a suspension prompt without copying it into metadata", async () => {
    const { handler, runner } = makeHarness();
    const rawToken = "sk-abcdefgh12345678";
    const rawPrompt = `Continue ${rawToken} ${"\u0000".repeat(GUIDE_MAX_CHARS)}`;
    runner.spawnFromA2AWire.mockImplementation(async (_request, _binding, callbacks) => {
      await callbacks.onDurablyLinked({ childSessionId: TASK_ID });
      const result = waitingResult();
      result.suspension = { ...result.suspension!, prompt: rawPrompt };
      return result;
    });

    const first = taskFrom(await handler.handle(A2AJsonRpcMethod.SEND_MESSAGE, {
      message: userMessage("wire-sensitive-suspension"),
    }));
    const statusMessage = first.status.message!;
    const text = (statusMessage.parts[0] as { text: string }).text;
    const suspension = (statusMessage.metadata as {
      suspension: { reason: string; resumeId: string; prompt?: string };
    }).suspension;

    expect(text).not.toContain(rawToken);
    expect(text).toContain("[REDACTED:TOKEN]");
    expect(JSON.stringify(statusMessage).length).toBeLessThanOrEqual(GUIDE_MAX_CHARS);
    expect(suspension).toEqual({ reason: "budget", resumeId: TASK_ID });
    expect(JSON.stringify(first)).not.toContain(rawToken);

    const replay = await handler.handle(
      A2AJsonRpcMethod.GET_TASK,
      { id: TASK_ID },
    ) as A2ATask;
    expect(replay.status.message).toEqual(statusMessage);
    expect(JSON.stringify(replay)).not.toContain(rawToken);
  });

  it("reconciles detached cancellation before accepting a continuation", async () => {
    const { handler, runner, store, audit, authorizeOperation } = makeHarness();
    await seedInputRequiredTask(
      store,
      TASK_ID,
      "context-detached-continuation",
      "message-detached-continuation",
    );
    runner.getA2AWireRunSnapshot.mockReturnValue({
      childSessionId: TASK_ID,
      title: "wire profile",
      taskState: A2ATaskState.CANCELED,
    });

    await expect(handler.handle(A2AJsonRpcMethod.SEND_MESSAGE, {
      message: userMessage("message-detached-answer", {
        taskId: TASK_ID,
        contextId: "context-detached-continuation",
        parts: [{ text: "continue" }],
      }),
    })).rejects.toMatchObject({ definition: { code: -32602 } });

    expect(authorizeOperation).not.toHaveBeenCalled();
    expect(runner.resumeFromA2AWire).not.toHaveBeenCalled();
    await expect(store.get(HANDLER_ID, TASK_ID)).resolves.toMatchObject({
      task: {
        status: { state: A2ATaskState.CANCELED },
        history: expect.not.arrayContaining([
          expect.objectContaining({ messageId: "message-detached-answer" }),
        ]),
      },
    });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      reason: "task-not-resumable",
      taskId: TASK_ID,
    }));
  });

  it("reconciles detached cancellation while continuation consent is pending", async () => {
    const approval = deferred<boolean>();
    const authorizeOperation = vi.fn(async () => await approval.promise);
    const { handler, runner, store } = makeHarness(HANDLER_ID, { authorizeOperation });
    await seedInputRequiredTask(
      store,
      TASK_ID,
      "context-detached-consent",
      "message-detached-consent",
    );

    const pending = handler.handle(A2AJsonRpcMethod.SEND_MESSAGE, {
      message: userMessage("message-detached-consent-answer", {
        taskId: TASK_ID,
        contextId: "context-detached-consent",
        parts: [{ text: "continue" }],
      }),
    });
    const rejection = expect(pending).rejects.toMatchObject({
      definition: { code: -32602 },
    });
    await vi.waitFor(() => expect(authorizeOperation).toHaveBeenCalledOnce());
    runner.getA2AWireRunSnapshot.mockReturnValue({
      childSessionId: TASK_ID,
      title: "wire profile",
      taskState: A2ATaskState.CANCELED,
    });
    approval.resolve(true);

    await rejection;
    expect(runner.resumeFromA2AWire).not.toHaveBeenCalled();
    await expect(store.get(HANDLER_ID, TASK_ID)).resolves.toMatchObject({
      task: { status: { state: A2ATaskState.CANCELED } },
    });
  });

  it("preflights a continuation before consent and leaves it waiting when denied", async () => {
    const authorizeOperation = vi.fn(async () => false);
    const { handler, runner, store, audit } = makeHarness(HANDLER_ID, {
      authorizeOperation,
    });
    await seedWorkingTask(
      store,
      HANDLER_ID,
      TASK_ID,
      "context-consent-resume",
      "message-consent-resume-start",
    );
    await store.transition({
      handlerId: HANDLER_ID,
      taskId: TASK_ID,
      state: A2ATaskState.INPUT_REQUIRED,
      message: userMessage("status-consent-resume-waiting", {
        role: A2ARole.AGENT,
        parts: [{ text: "continue" }],
      }),
    });

    await expect(handler.handle(A2AJsonRpcMethod.SEND_MESSAGE, {
      message: userMessage("message-consent-resume-answer", {
        taskId: TASK_ID,
        contextId: "context-consent-resume",
        parts: [{ text: "continue" }],
      }),
    })).rejects.toMatchObject({ definition: { code: -32010 } });

    expect(authorizeOperation).toHaveBeenCalledWith({
      operation: "send-message",
      handlerId: HANDLER_ID,
      taskId: TASK_ID,
      messageId: "message-consent-resume-answer",
    });
    expect(runner.resumeFromA2AWire).not.toHaveBeenCalled();
    await expect(store.get(HANDLER_ID, TASK_ID)).resolves.toMatchObject({
      task: {
        status: { state: A2ATaskState.INPUT_REQUIRED },
        history: expect.not.arrayContaining([
          expect.objectContaining({ messageId: "message-consent-resume-answer" }),
        ]),
      },
    });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      reason: "consent-denied",
      operation: "send-message",
      taskId: TASK_ID,
    }));
  });

  it("coalesces identical concurrent continuation denial without another prompt", async () => {
    const approval = deferred<boolean>();
    const authorizeOperation = vi.fn(async () => await approval.promise);
    const { handler, runner, store } = makeHarness(HANDLER_ID, { authorizeOperation });
    await seedWorkingTask(
      store,
      HANDLER_ID,
      TASK_ID,
      "context-shared-denial",
      "message-shared-denial-start",
    );
    await store.transition({
      handlerId: HANDLER_ID,
      taskId: TASK_ID,
      state: A2ATaskState.INPUT_REQUIRED,
    });
    const request = {
      message: userMessage("message-shared-denial-answer", {
        taskId: TASK_ID,
        contextId: "context-shared-denial",
        parts: [{ text: "continue" }],
      }),
    };

    const first = handler.handle(A2AJsonRpcMethod.SEND_MESSAGE, request);
    const second = handler.handle(A2AJsonRpcMethod.SEND_MESSAGE, request);
    await vi.waitFor(() => expect(authorizeOperation).toHaveBeenCalledOnce());
    approval.resolve(false);

    await Promise.all([
      expect(first).rejects.toMatchObject({ definition: { code: -32010 } }),
      expect(second).rejects.toMatchObject({ definition: { code: -32010 } }),
    ]);
    expect(runner.resumeFromA2AWire).not.toHaveBeenCalled();
    await expect(store.get(HANDLER_ID, TASK_ID)).resolves.toMatchObject({
      task: {
        status: { state: A2ATaskState.INPUT_REQUIRED },
        history: expect.not.arrayContaining([
          expect.objectContaining({ messageId: "message-shared-denial-answer" }),
        ]),
      },
    });
  });

  it("starts one resume for identical concurrent approved continuations", async () => {
    const approval = deferred<boolean>();
    const resume = deferred<SubAgentSpawnResult>();
    const authorizeOperation = vi.fn(async () => await approval.promise);
    const { handler, runner, store } = makeHarness(HANDLER_ID, { authorizeOperation });
    runner.resumeFromA2AWire.mockImplementation(async () => await resume.promise);
    await seedWorkingTask(
      store,
      HANDLER_ID,
      TASK_ID,
      "context-shared-allow",
      "message-shared-allow-start",
    );
    await store.transition({
      handlerId: HANDLER_ID,
      taskId: TASK_ID,
      state: A2ATaskState.INPUT_REQUIRED,
    });
    const request = {
      message: userMessage("message-shared-allow-answer", {
        taskId: TASK_ID,
        contextId: "context-shared-allow",
        parts: [{ text: "continue" }],
      }),
      configuration: { returnImmediately: true },
    };

    const first = handler.handle(A2AJsonRpcMethod.SEND_MESSAGE, request);
    const second = handler.handle(A2AJsonRpcMethod.SEND_MESSAGE, request);
    await vi.waitFor(() => expect(authorizeOperation).toHaveBeenCalledOnce());
    approval.resolve(true);
    const tasks = (await Promise.all([first, second])).map(taskFrom);

    expect(tasks.map((task) => task.status.state)).toEqual([
      A2ATaskState.WORKING,
      A2ATaskState.WORKING,
    ]);
    expect(runner.resumeFromA2AWire).toHaveBeenCalledOnce();
    resume.resolve(completedResult());
    await vi.waitFor(async () => {
      expect((await store.get(HANDLER_ID, TASK_ID))?.task.status.state)
        .toBe(A2ATaskState.COMPLETED);
    });
  });

  it("rejects a distinct concurrent continuation before the task FIFO or authorizer", async () => {
    const approval = deferred<boolean>();
    // Reads carry their own consent step; only the mutation is held pending so
    // the assertion still isolates the task FIFO from the read path.
    const authorizeOperation = vi.fn(async (descriptor: A2AWireAuthorizationDescriptor) =>
      descriptor.operation === "send-message" ? await approval.promise : true);
    const { handler, runner, store } = makeHarness(HANDLER_ID, { authorizeOperation });
    await seedWorkingTask(
      store,
      HANDLER_ID,
      TASK_ID,
      "context-distinct",
      "message-distinct-start",
    );
    await store.transition({
      handlerId: HANDLER_ID,
      taskId: TASK_ID,
      state: A2ATaskState.INPUT_REQUIRED,
    });

    const first = handler.handle(A2AJsonRpcMethod.SEND_MESSAGE, {
      message: userMessage("message-distinct-answer-a", {
        taskId: TASK_ID,
        contextId: "context-distinct",
      }),
    });
    const firstRejection = expect(first).rejects.toMatchObject({
      definition: { code: -32010 },
    });
    await vi.waitFor(() => expect(authorizeOperation).toHaveBeenCalledOnce());

    await expect(handler.handle(A2AJsonRpcMethod.GET_TASK, { id: TASK_ID }))
      .resolves.toMatchObject({ status: { state: A2ATaskState.INPUT_REQUIRED } });
    await expect(handler.handle(A2AJsonRpcMethod.LIST_TASKS, {})).resolves.toMatchObject({
      tasks: expect.any(Array),
    });
    await expect(handler.handle(A2AJsonRpcMethod.SEND_MESSAGE, {
      message: userMessage("message-distinct-answer-b", {
        taskId: TASK_ID,
        contextId: "context-distinct",
      }),
    })).rejects.toMatchObject({ definition: { code: -32010 } });
    expect(authorizeOperation.mock.calls
      .filter(([descriptor]) => descriptor.operation === "send-message")).toHaveLength(1);

    approval.resolve(false);
    await firstRejection;
    expect(runner.resumeFromA2AWire).not.toHaveBeenCalled();
  });

  it("revalidates a continuation after approval before history or runner mutation", async () => {
    const approval = deferred<boolean>();
    const authorizeOperation = vi.fn(async () => await approval.promise);
    const { handler, runner, store } = makeHarness(HANDLER_ID, { authorizeOperation });
    await seedWorkingTask(
      store,
      HANDLER_ID,
      TASK_ID,
      "context-revalidate-resume",
      "message-revalidate-resume-start",
    );
    await store.transition({
      handlerId: HANDLER_ID,
      taskId: TASK_ID,
      state: A2ATaskState.INPUT_REQUIRED,
    });
    const pending = handler.handle(A2AJsonRpcMethod.SEND_MESSAGE, {
      message: userMessage("message-revalidate-resume-answer", {
        taskId: TASK_ID,
        contextId: "context-revalidate-resume",
      }),
    });
    const rejection = expect(pending).rejects.toMatchObject({
      definition: { code: -32602 },
    });
    await vi.waitFor(() => expect(authorizeOperation).toHaveBeenCalledOnce());
    await store.transition({
      handlerId: HANDLER_ID,
      taskId: TASK_ID,
      state: A2ATaskState.CANCELED,
    });
    approval.resolve(true);

    await rejection;
    expect(runner.resumeFromA2AWire).not.toHaveBeenCalled();
    await expect(store.get(HANDLER_ID, TASK_ID)).resolves.toMatchObject({
      task: {
        status: { state: A2ATaskState.CANCELED },
        history: expect.not.arrayContaining([
          expect.objectContaining({ messageId: "message-revalidate-resume-answer" }),
        ]),
      },
    });
  });

  it("rejects invalid continuation context before requesting consent", async () => {
    const { handler, runner, store, authorizeOperation } = makeHarness();
    await seedWorkingTask(
      store,
      HANDLER_ID,
      TASK_ID,
      "context-valid",
      "message-context-start",
    );
    await store.transition({
      handlerId: HANDLER_ID,
      taskId: TASK_ID,
      state: A2ATaskState.INPUT_REQUIRED,
      message: userMessage("status-context-waiting", {
        role: A2ARole.AGENT,
        parts: [{ text: "continue" }],
      }),
    });

    await expect(handler.handle(A2AJsonRpcMethod.SEND_MESSAGE, {
      message: userMessage("message-context-invalid", {
        taskId: TASK_ID,
        contextId: "context-wrong",
      }),
    })).rejects.toMatchObject({ definition: { code: -32602 } });
    expect(authorizeOperation).not.toHaveBeenCalled();
    expect(runner.resumeFromA2AWire).not.toHaveBeenCalled();
  });

  it("rejects unknown, terminal, and history-full mutations before consent", async () => {
    const unknown = makeHarness();
    await expect(unknown.handler.handle(A2AJsonRpcMethod.SEND_MESSAGE, {
      message: userMessage("message-unknown-preflight", {
        taskId: "sub-a3164e34-4366c618-04f5-4164-8dbd-1f7d593061f0",
        contextId: "context-unknown-preflight",
      }),
    })).rejects.toMatchObject({ definition: { code: -32001 } });
    await expect(unknown.handler.handle(A2AJsonRpcMethod.CANCEL_TASK, {
      id: "sub-a3164e34-4366c618-04f5-4164-8dbd-1f7d593061f0",
    })).rejects.toMatchObject({ definition: { code: -32001 } });
    expect(unknown.authorizeOperation).not.toHaveBeenCalled();

    const terminal = makeHarness();
    await seedWorkingTask(
      terminal.store,
      HANDLER_ID,
      TASK_ID,
      "context-terminal-preflight",
      "message-terminal-preflight-start",
    );
    await terminal.store.transition({
      handlerId: HANDLER_ID,
      taskId: TASK_ID,
      state: A2ATaskState.COMPLETED,
    });
    await expect(terminal.handler.handle(A2AJsonRpcMethod.SEND_MESSAGE, {
      message: userMessage("message-terminal-preflight-answer", {
        taskId: TASK_ID,
        contextId: "context-terminal-preflight",
      }),
    })).rejects.toMatchObject({ definition: { code: -32602 } });
    await expect(terminal.handler.handle(A2AJsonRpcMethod.CANCEL_TASK, {
      id: TASK_ID,
    })).rejects.toMatchObject({ definition: { code: -32002 } });
    expect(terminal.authorizeOperation).not.toHaveBeenCalled();

    const historyFull = makeHarness(HANDLER_ID, { maxHistoryMessages: 1 });
    await seedWorkingTask(
      historyFull.store,
      HANDLER_ID,
      TASK_ID,
      "context-history-full",
      "message-history-full-start",
    );
    await historyFull.store.transition({
      handlerId: HANDLER_ID,
      taskId: TASK_ID,
      state: A2ATaskState.INPUT_REQUIRED,
    });
    await expect(historyFull.handler.handle(A2AJsonRpcMethod.SEND_MESSAGE, {
      message: userMessage("message-history-full-answer", {
        taskId: TASK_ID,
        contextId: "context-history-full",
      }),
    })).rejects.toMatchObject({ definition: { code: -32602 } });
    expect(historyFull.authorizeOperation).not.toHaveBeenCalled();
    expect(historyFull.runner.resumeFromA2AWire).not.toHaveBeenCalled();
  });

  it("returns WORKING immediately while the detached lifecycle finalizes durably", async () => {
    const { handler, runner, store } = makeHarness();
    let finish!: (result: SubAgentSpawnResult) => void;
    const gate = new Promise<SubAgentSpawnResult>((resolve) => {
      finish = resolve;
    });
    runner.spawnFromA2AWire.mockImplementation(async (_request, _binding, callbacks) => {
      await callbacks.onDurablyLinked({ childSessionId: TASK_ID });
      return await gate;
    });

    const immediate = taskFrom(await handler.handle(A2AJsonRpcMethod.SEND_MESSAGE, {
      message: userMessage("wire-background-1"),
      configuration: { returnImmediately: true },
    }));
    expect(immediate.status.state).toBe(A2ATaskState.WORKING);

    finish(completedResult());
    await vi.waitFor(async () => {
      expect((await store.get(HANDLER_ID, TASK_ID))?.task.status.state)
        .toBe(A2ATaskState.COMPLETED);
    });
  });

  it("coalesces a semantic initial retry but projects each caller configuration", async () => {
    const { handler, runner, authorizeOperation } = makeHarness();
    let releaseLink!: () => void;
    const linkGate = new Promise<void>((resolve) => {
      releaseLink = resolve;
    });
    let finish!: (result: SubAgentSpawnResult) => void;
    const resultGate = new Promise<SubAgentSpawnResult>((resolve) => {
      finish = resolve;
    });
    runner.spawnFromA2AWire.mockImplementation(async (_request, _binding, callbacks) => {
      await linkGate;
      await callbacks.onDurablyLinked({ childSessionId: TASK_ID });
      return await resultGate;
    });
    const first = handler.handle(A2AJsonRpcMethod.SEND_MESSAGE, {
      message: userMessage("wire-retry-1", {
        metadata: { alpha: "one", beta: "two" },
      }),
      configuration: { returnImmediately: true, historyLength: 0 },
    });
    const second = handler.handle(A2AJsonRpcMethod.SEND_MESSAGE, {
      message: userMessage("wire-retry-1", {
        metadata: { beta: "two", alpha: "one" },
      }),
      configuration: { returnImmediately: false, historyLength: 1 },
    });
    releaseLink();
    const firstTask = taskFrom(await first);

    expect(firstTask.id).toBe(TASK_ID);
    expect(firstTask.status.state).toBe(A2ATaskState.WORKING);
    expect(firstTask.history).toEqual([]);
    expect(runner.spawnFromA2AWire).toHaveBeenCalledOnce();
    expect(authorizeOperation).toHaveBeenCalledOnce();

    let secondSettled = false;
    void second.then(() => {
      secondSettled = true;
    });
    await Promise.resolve();
    expect(secondSettled).toBe(false);
    finish(completedResult());
    const secondTask = taskFrom(await second);
    expect(secondTask.id).toBe(TASK_ID);
    expect(secondTask.status.state).toBe(A2ATaskState.COMPLETED);
    expect(secondTask.history).toHaveLength(1);
  });

  it("rejects a distinct initial mutation while the admission is linking", async () => {
    const { handler, runner, authorizeOperation } = makeHarness();
    const linkGate = deferred<void>();
    const resultGate = deferred<SubAgentSpawnResult>();
    runner.spawnFromA2AWire.mockImplementation(async (_request, _binding, callbacks) => {
      await linkGate.promise;
      await callbacks.onDurablyLinked({ childSessionId: TASK_ID });
      return await resultGate.promise;
    });

    const first = handler.handle(A2AJsonRpcMethod.SEND_MESSAGE, {
      message: userMessage("wire-admission-first"),
      configuration: { returnImmediately: true },
    });
    await vi.waitFor(() => expect(runner.spawnFromA2AWire).toHaveBeenCalledOnce());

    await expect(handler.handle(A2AJsonRpcMethod.SEND_MESSAGE, {
      message: userMessage("wire-admission-distinct"),
    })).rejects.toMatchObject({ definition: { code: -32010 } });
    expect(authorizeOperation).toHaveBeenCalledOnce();
    expect(runner.spawnFromA2AWire).toHaveBeenCalledOnce();

    linkGate.resolve();
    await first;
    resultGate.resolve(completedResult());
  });

  it("blocks a continuation from committing an initial admission message id", async () => {
    const initialTaskId = "sub-c3b96ceb-30983f4c-46c8-4d84-819d-3483406e3ea2";
    const { handler, runner, store, authorizeOperation } = makeHarness();
    await seedWorkingTask(
      store,
      HANDLER_ID,
      TASK_ID,
      "context-initial-admission-race",
      "message-initial-admission-existing",
    );
    await store.transition({
      handlerId: HANDLER_ID,
      taskId: TASK_ID,
      state: A2ATaskState.INPUT_REQUIRED,
    });
    const linkGate = deferred<void>();
    const resultGate = deferred<SubAgentSpawnResult>();
    runner.spawnFromA2AWire.mockImplementation(async (_request, _binding, callbacks) => {
      await linkGate.promise;
      await callbacks.onDurablyLinked({ childSessionId: initialTaskId });
      return await resultGate.promise;
    });

    const initial = handler.handle(A2AJsonRpcMethod.SEND_MESSAGE, {
      message: userMessage("message-initial-admission-race"),
      configuration: { returnImmediately: true },
    });
    await vi.waitFor(() => expect(runner.spawnFromA2AWire).toHaveBeenCalledOnce());

    await expect(handler.handle(A2AJsonRpcMethod.SEND_MESSAGE, {
      message: userMessage("message-initial-admission-race", {
        taskId: TASK_ID,
        contextId: "context-initial-admission-race",
        parts: [{ text: "continuation collision" }],
      }),
    })).rejects.toMatchObject({ definition: { code: -32602 } });
    expect(authorizeOperation).toHaveBeenCalledOnce();
    expect(runner.resumeFromA2AWire).not.toHaveBeenCalled();

    linkGate.resolve();
    await initial;
    resultGate.resolve(completedResult(initialTaskId));
  });

  it("rejects conflicting concurrent initial bodies with the same message id", async () => {
    const approval = deferred<boolean>();
    const authorizeOperation = vi.fn(async () => await approval.promise);
    const { handler, runner, store } = makeHarness(HANDLER_ID, { authorizeOperation });

    const first = handler.handle(A2AJsonRpcMethod.SEND_MESSAGE, {
      message: userMessage("wire-conflicting-initial", {
        parts: [{ text: "first body" }],
      }),
    });
    const firstRejection = expect(first).rejects.toMatchObject({
      definition: { code: -32010 },
    });
    await vi.waitFor(() => expect(authorizeOperation).toHaveBeenCalledOnce());

    await expect(handler.handle(A2AJsonRpcMethod.SEND_MESSAGE, {
      message: userMessage("wire-conflicting-initial", {
        parts: [{ text: "different body" }],
      }),
    })).rejects.toMatchObject({ definition: { code: -32010 } });
    expect(authorizeOperation).toHaveBeenCalledOnce();
    expect(runner.spawnFromA2AWire).not.toHaveBeenCalled();

    approval.resolve(false);
    await firstRejection;
    await expect(store.list(HANDLER_ID)).resolves.toEqual([]);
  });

  it("replays an already durable duplicate without requesting consent again", async () => {
    const { handler, runner, authorizeOperation } = makeHarness();
    const request = { message: userMessage("wire-durable-replay") };

    const first = taskFrom(await handler.handle(A2AJsonRpcMethod.SEND_MESSAGE, request));
    const replay = taskFrom(await handler.handle(A2AJsonRpcMethod.SEND_MESSAGE, request));

    expect(replay.id).toBe(first.id);
    expect(authorizeOperation).toHaveBeenCalledOnce();
    expect(runner.spawnFromA2AWire).toHaveBeenCalledOnce();
  });

  it("rejects a conflicting body for an already durable initial message id", async () => {
    const { handler, runner, authorizeOperation } = makeHarness();
    await handler.handle(A2AJsonRpcMethod.SEND_MESSAGE, {
      message: userMessage("wire-durable-initial-conflict", {
        parts: [{ text: "first body" }],
      }),
    });

    await expect(handler.handle(A2AJsonRpcMethod.SEND_MESSAGE, {
      message: userMessage("wire-durable-initial-conflict", {
        parts: [{ text: "different body" }],
      }),
    })).rejects.toMatchObject({ definition: { code: -32602 } });

    expect(authorizeOperation).toHaveBeenCalledOnce();
    expect(runner.spawnFromA2AWire).toHaveBeenCalledOnce();
  });

  it("rejects a conflicting body for an already durable continuation message id", async () => {
    const { handler, runner, store, authorizeOperation } = makeHarness();
    await seedWorkingTask(
      store,
      HANDLER_ID,
      TASK_ID,
      "context-durable-continuation-conflict",
      "message-durable-continuation-start",
    );
    await store.transition({
      handlerId: HANDLER_ID,
      taskId: TASK_ID,
      state: A2ATaskState.INPUT_REQUIRED,
    });
    await handler.handle(A2AJsonRpcMethod.SEND_MESSAGE, {
      message: userMessage("message-durable-continuation-answer", {
        taskId: TASK_ID,
        contextId: "context-durable-continuation-conflict",
        parts: [{ text: "first answer" }],
      }),
    });

    await expect(handler.handle(A2AJsonRpcMethod.SEND_MESSAGE, {
      message: userMessage("message-durable-continuation-answer", {
        parts: [{ text: "first answer" }],
      }),
    })).rejects.toMatchObject({ definition: { code: -32602 } });
    await expect(handler.handle(A2AJsonRpcMethod.SEND_MESSAGE, {
      message: userMessage("message-durable-continuation-answer", {
        taskId: TASK_ID,
        contextId: "context-durable-continuation-conflict",
        parts: [{ text: "different answer" }],
      }),
    })).rejects.toMatchObject({ definition: { code: -32602 } });

    expect(authorizeOperation).toHaveBeenCalledOnce();
    expect(runner.resumeFromA2AWire).toHaveBeenCalledOnce();
  });

  it("requires consent before disclosing a task the caller was never granted", async () => {
    const { handler, store, authorizeOperation } = makeHarness();
    await seedWorkingTask(
      store,
      HANDLER_ID,
      TASK_ID,
      "context-read",
      "message-read",
    );

    await handler.handle(A2AJsonRpcMethod.GET_TASK, { id: TASK_ID });
    await handler.handle(A2AJsonRpcMethod.LIST_TASKS, {});
    expect(authorizeOperation.mock.calls.map(([descriptor]) => descriptor)).toEqual([
      { operation: "get-task", handlerId: HANDLER_ID, taskId: TASK_ID },
      { operation: "list-tasks", handlerId: HANDLER_ID },
    ]);
  });

  it("denies refused task reads and discloses nothing", async () => {
    const authorizeOperation = vi.fn(async () => false);
    const { handler, store, audit } = makeHarness(HANDLER_ID, { authorizeOperation });
    await seedWorkingTask(
      store,
      HANDLER_ID,
      TASK_ID,
      "context-read-denied",
      "message-read-denied",
    );

    await expect(handler.handle(A2AJsonRpcMethod.GET_TASK, { id: TASK_ID }))
      .rejects.toMatchObject({ definition: { code: -32010 } });
    await expect(handler.handle(A2AJsonRpcMethod.LIST_TASKS, {}))
      .rejects.toMatchObject({ definition: { code: -32010 } });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "dropped",
      reason: "consent-denied",
      operation: "get-task",
      taskId: TASK_ID,
    }));
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "dropped",
      reason: "consent-denied",
      operation: "list-tasks",
    }));
  });

  it("fails task reads closed when no authorizer is wired", async () => {
    const { handler, store } = makeHarness(HANDLER_ID, { omitAuthorizeOperation: true });
    await seedWorkingTask(
      store,
      HANDLER_ID,
      TASK_ID,
      "context-read-unwired",
      "message-read-unwired",
    );

    await expect(handler.handle(A2AJsonRpcMethod.GET_TASK, { id: TASK_ID }))
      .rejects.toMatchObject({ definition: { code: -32010 } });
    await expect(handler.handle(A2AJsonRpcMethod.LIST_TASKS, {}))
      .rejects.toMatchObject({ definition: { code: -32010 } });
  });

  it("lets a caller poll the task its own send created without re-prompting", async () => {
    const { handler, authorizeOperation } = makeHarness();

    const sent = taskFrom(await handler.handle(
      A2AJsonRpcMethod.SEND_MESSAGE,
      sendParams(userMessage("message-poll-own")),
    ));
    authorizeOperation.mockClear();

    await expect(handler.handle(A2AJsonRpcMethod.GET_TASK, { id: sent.id }))
      .resolves.toMatchObject({ id: sent.id });
    await expect(handler.handle(A2AJsonRpcMethod.GET_TASK, { id: sent.id }))
      .resolves.toMatchObject({ id: sent.id });
    expect(authorizeOperation).not.toHaveBeenCalled();

    // Enumeration is never covered by a per-task grant.
    await handler.handle(A2AJsonRpcMethod.LIST_TASKS, {});
    expect(authorizeOperation.mock.calls.map(([descriptor]) => descriptor.operation))
      .toEqual(["list-tasks"]);
  });

  it("keeps disclosure grants scoped to the handler that earned them", async () => {
    const owner = makeHarness(HANDLER_ID);
    const other = makeHarness("profile-b");
    const sent = taskFrom(await owner.handler.handle(
      A2AJsonRpcMethod.SEND_MESSAGE,
      sendParams(userMessage("message-cross-origin-grant")),
    ));
    await seedWorkingTask(
      other.store,
      "profile-b",
      sent.id,
      "context-other-origin",
      "message-other-origin",
    );
    other.authorizeOperation.mockClear();

    await expect(other.handler.handle(A2AJsonRpcMethod.GET_TASK, { id: sent.id }))
      .resolves.toMatchObject({ id: sent.id });
    expect(other.authorizeOperation).toHaveBeenCalledWith({
      operation: "get-task",
      handlerId: "profile-b",
      taskId: sent.id,
    });
  });

  it("does not prompt for tasks owned by another origin or absent entirely", async () => {
    const owner = makeHarness(HANDLER_ID);
    const foreign = new A2ASubAgentHandler({
      id: "profile-b",
      card: card(),
      binding: binding("profile-b"),
      runner: owner.runner as unknown as A2ASubAgentLifecycleRunner,
      store: owner.store,
      authorizeOperation: owner.authorizeOperation,
      audit: owner.audit,
    });
    await seedWorkingTask(
      owner.store,
      HANDLER_ID,
      TASK_ID,
      "context-foreign",
      "message-foreign",
    );

    await expect(foreign.handle(A2AJsonRpcMethod.GET_TASK, { id: TASK_ID }))
      .rejects.toMatchObject({ definition: { code: -32001 } });
    await expect(foreign.handle(A2AJsonRpcMethod.GET_TASK, { id: "f646f69a-6fa0-4e36-80f8-7ba2ed853ddf" }))
      .rejects.toMatchObject({ definition: { code: -32001 } });
    expect(owner.authorizeOperation).not.toHaveBeenCalled();
    expect(owner.audit).toHaveBeenCalledWith(expect.objectContaining({
      reason: "cross-origin",
      taskId: TASK_ID,
    }));
  });

  it("rejects a full active task store before consent or runner start", async () => {
    const { handler, runner, store, authorizeOperation, audit } = makeHarness(
      HANDLER_ID,
      { maxTasks: 1 },
    );
    await seedWorkingTask(
      store,
      HANDLER_ID,
      TASK_ID,
      "context-capacity-full",
      "message-capacity-existing",
    );

    await expect(handler.handle(A2AJsonRpcMethod.SEND_MESSAGE, {
      message: userMessage("message-capacity-rejected"),
    })).rejects.toMatchObject({ definition: { code: -32010 } });

    expect(authorizeOperation).not.toHaveBeenCalled();
    expect(runner.spawnFromA2AWire).not.toHaveBeenCalled();
    await expect(store.list(HANDLER_ID)).resolves.toHaveLength(1);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      reason: "task-budget-exceeded",
      outcome: "dropped",
      messageId: "message-capacity-rejected",
    }));
  });

  it("cancels a live task idempotently through the handler-bound runner seam", async () => {
    const { handler, runner, store, authorizeOperation } = makeHarness();
    await seedWorkingTask(
      store,
      HANDLER_ID,
      TASK_ID,
      "context-cancel",
      "message-cancel",
    );

    const first = await handler.handle(A2AJsonRpcMethod.CANCEL_TASK, { id: TASK_ID });
    const second = await handler.handle(A2AJsonRpcMethod.CANCEL_TASK, { id: TASK_ID });

    expect((first as A2ATask).status.state).toBe(A2ATaskState.CANCELED);
    expect((second as A2ATask).status.state).toBe(A2ATaskState.CANCELED);
    expect(runner.cancelA2AWireRun).toHaveBeenCalledOnce();
    expect(authorizeOperation).toHaveBeenCalledOnce();
  });

  it("preflights cancel before consent and preserves a live task when denied", async () => {
    const authorizeOperation = vi.fn(async () => false);
    const { handler, runner, store, audit } = makeHarness(HANDLER_ID, {
      authorizeOperation,
    });
    await seedWorkingTask(
      store,
      HANDLER_ID,
      TASK_ID,
      "context-cancel-denied",
      "message-cancel-denied",
    );

    await expect(handler.handle(A2AJsonRpcMethod.CANCEL_TASK, { id: TASK_ID }))
      .rejects.toMatchObject({ definition: { code: -32010 } });

    expect(authorizeOperation).toHaveBeenCalledWith({
      operation: "cancel-task",
      handlerId: HANDLER_ID,
      taskId: TASK_ID,
    });
    expect(runner.cancelA2AWireRun).not.toHaveBeenCalled();
    await expect(store.get(HANDLER_ID, TASK_ID)).resolves.toMatchObject({
      task: { status: { state: A2ATaskState.WORKING } },
    });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      reason: "consent-denied",
      operation: "cancel-task",
      taskId: TASK_ID,
    }));
  });

  it("coalesces identical concurrent cancel denial", async () => {
    const approval = deferred<boolean>();
    const authorizeOperation = vi.fn(async () => await approval.promise);
    const { handler, runner, store } = makeHarness(HANDLER_ID, { authorizeOperation });
    await seedWorkingTask(
      store,
      HANDLER_ID,
      TASK_ID,
      "context-cancel-shared-denial",
      "message-cancel-shared-denial",
    );

    const first = handler.handle(A2AJsonRpcMethod.CANCEL_TASK, { id: TASK_ID });
    const second = handler.handle(A2AJsonRpcMethod.CANCEL_TASK, { id: TASK_ID });
    await vi.waitFor(() => expect(authorizeOperation).toHaveBeenCalledOnce());
    approval.resolve(false);

    await Promise.all([
      expect(first).rejects.toMatchObject({ definition: { code: -32010 } }),
      expect(second).rejects.toMatchObject({ definition: { code: -32010 } }),
    ]);
    expect(runner.cancelA2AWireRun).not.toHaveBeenCalled();
    await expect(store.get(HANDLER_ID, TASK_ID)).resolves.toMatchObject({
      task: { status: { state: A2ATaskState.WORKING } },
    });
  });

  it("runs one cancel mutation for identical concurrent approval", async () => {
    const approval = deferred<boolean>();
    const authorizeOperation = vi.fn(async () => await approval.promise);
    const { handler, runner, store } = makeHarness(HANDLER_ID, { authorizeOperation });
    await seedWorkingTask(
      store,
      HANDLER_ID,
      TASK_ID,
      "context-cancel-shared-allow",
      "message-cancel-shared-allow",
    );

    const first = handler.handle(A2AJsonRpcMethod.CANCEL_TASK, { id: TASK_ID });
    const second = handler.handle(A2AJsonRpcMethod.CANCEL_TASK, { id: TASK_ID });
    await vi.waitFor(() => expect(authorizeOperation).toHaveBeenCalledOnce());
    approval.resolve(true);
    const tasks = await Promise.all([first, second]) as A2ATask[];

    expect(tasks.map((task) => task.status.state)).toEqual([
      A2ATaskState.CANCELED,
      A2ATaskState.CANCELED,
    ]);
    expect(runner.cancelA2AWireRun).toHaveBeenCalledOnce();
  });

  it("cancels a full-history wait through the message-less terminal fallback", async () => {
    const taskId = "sub-0c79046a-e86618f5-4817-4b2b-89f9-d6b8e0a18c87";
    const { handler, runner, store } = makeHarness(HANDLER_ID, {
      maxHistoryMessages: 2,
    });
    await seedInputRequiredTask(
      store,
      taskId,
      "context-full-history-cancel",
      "message-full-history-cancel",
    );

    const canceled = await handler.handle(A2AJsonRpcMethod.CANCEL_TASK, {
      id: taskId,
    }) as A2ATask;
    expect(canceled.status.state).toBe(A2ATaskState.CANCELED);
    expect(canceled.history).toHaveLength(2);
    expect(runner.cancelA2AWireRun).toHaveBeenCalledOnce();
  });

  it("revalidates cancel after approval before the runner mutation", async () => {
    const approval = deferred<boolean>();
    const authorizeOperation = vi.fn(async () => await approval.promise);
    const { handler, runner, store } = makeHarness(HANDLER_ID, { authorizeOperation });
    await seedWorkingTask(
      store,
      HANDLER_ID,
      TASK_ID,
      "context-cancel-revalidate",
      "message-cancel-revalidate",
    );

    const pending = handler.handle(A2AJsonRpcMethod.CANCEL_TASK, { id: TASK_ID });
    const rejection = expect(pending).rejects.toMatchObject({
      definition: { code: -32002 },
    });
    await vi.waitFor(() => expect(authorizeOperation).toHaveBeenCalledOnce());
    await store.transition({
      handlerId: HANDLER_ID,
      taskId: TASK_ID,
      state: A2ATaskState.COMPLETED,
    });
    approval.resolve(true);

    await rejection;
    expect(runner.cancelA2AWireRun).not.toHaveBeenCalled();
    await expect(store.get(HANDLER_ID, TASK_ID)).resolves.toMatchObject({
      task: { status: { state: A2ATaskState.COMPLETED } },
    });
  });

  it("rejects cancel immediately while a distinct continuation consent is pending", async () => {
    const approval = deferred<boolean>();
    const authorizeOperation = vi.fn(async () => await approval.promise);
    const { handler, runner, store } = makeHarness(HANDLER_ID, { authorizeOperation });
    await seedWorkingTask(
      store,
      HANDLER_ID,
      TASK_ID,
      "context-resume-cancel-reservation",
      "message-resume-cancel-start",
    );
    await store.transition({
      handlerId: HANDLER_ID,
      taskId: TASK_ID,
      state: A2ATaskState.INPUT_REQUIRED,
    });
    const continuation = handler.handle(A2AJsonRpcMethod.SEND_MESSAGE, {
      message: userMessage("message-resume-cancel-answer", {
        taskId: TASK_ID,
        contextId: "context-resume-cancel-reservation",
      }),
    });
    const continuationRejection = expect(continuation).rejects.toMatchObject({
      definition: { code: -32010 },
    });
    await vi.waitFor(() => expect(authorizeOperation).toHaveBeenCalledOnce());

    await expect(handler.handle(A2AJsonRpcMethod.CANCEL_TASK, { id: TASK_ID }))
      .rejects.toMatchObject({ definition: { code: -32010 } });
    expect(authorizeOperation).toHaveBeenCalledOnce();
    expect(runner.cancelA2AWireRun).not.toHaveBeenCalled();

    approval.resolve(false);
    await continuationRejection;
    expect(runner.resumeFromA2AWire).not.toHaveBeenCalled();
  });

  it("returns authoritative detached cancellation without canceling the runner again", async () => {
    const { handler, runner, store, authorizeOperation } = makeHarness();
    await seedInputRequiredTask(
      store,
      TASK_ID,
      "context-detached-cancel",
      "message-detached-cancel",
    );
    runner.getA2AWireRunSnapshot.mockReturnValue({
      childSessionId: TASK_ID,
      title: "wire profile",
      taskState: A2ATaskState.CANCELED,
    });

    const canceled = await handler.handle(
      A2AJsonRpcMethod.CANCEL_TASK,
      { id: TASK_ID },
    ) as A2ATask;

    expect(canceled.status.state).toBe(A2ATaskState.CANCELED);
    // No cancel consent: the runner already stopped. The task body still leaves
    // the host, so the idempotent return costs a disclosure approval instead.
    expect(authorizeOperation.mock.calls.map(([descriptor]) => descriptor.operation))
      .toEqual(["get-task"]);
    expect(runner.cancelA2AWireRun).not.toHaveBeenCalled();
    await expect(store.get(HANDLER_ID, TASK_ID)).resolves.toMatchObject({
      task: { status: { state: A2ATaskState.CANCELED } },
    });
  });

  it("reconciles detached cancellation while cancel consent is pending", async () => {
    const approval = deferred<boolean>();
    const authorizeOperation = vi.fn(async () => await approval.promise);
    const { handler, runner, store } = makeHarness(HANDLER_ID, { authorizeOperation });
    await seedInputRequiredTask(
      store,
      TASK_ID,
      "context-detached-cancel-consent",
      "message-detached-cancel-consent",
    );

    const pending = handler.handle(A2AJsonRpcMethod.CANCEL_TASK, { id: TASK_ID });
    await vi.waitFor(() => expect(authorizeOperation).toHaveBeenCalledOnce());
    runner.getA2AWireRunSnapshot.mockReturnValue({
      childSessionId: TASK_ID,
      title: "wire profile",
      taskState: A2ATaskState.CANCELED,
    });
    approval.resolve(true);

    await expect(pending).resolves.toMatchObject({ status: { state: A2ATaskState.CANCELED } });
    expect(runner.cancelA2AWireRun).not.toHaveBeenCalled();
    await expect(store.get(HANDLER_ID, TASK_ID)).resolves.toMatchObject({
      task: { status: { state: A2ATaskState.CANCELED } },
    });
  });

  it("keeps CANCELED terminal when a continuation finishes after cancellation", async () => {
    const { handler, runner, store } = makeHarness();
    await seedWorkingTask(
      store,
      HANDLER_ID,
      TASK_ID,
      "context-cancel-race",
      "message-cancel-race-start",
    );
    await store.transition({
      handlerId: HANDLER_ID,
      taskId: TASK_ID,
      state: A2ATaskState.INPUT_REQUIRED,
      message: userMessage("status-cancel-race-waiting", {
        role: A2ARole.AGENT,
        parts: [{ text: "continue" }],
      }),
    });
    let finishResume!: (result: SubAgentSpawnResult) => void;
    runner.resumeFromA2AWire.mockImplementation(async () => await new Promise(
      (resolve) => {
        finishResume = resolve;
      },
    ));

    const immediate = taskFrom(await handler.handle(A2AJsonRpcMethod.SEND_MESSAGE, {
      message: userMessage("message-cancel-race-answer", {
        taskId: TASK_ID,
        contextId: "context-cancel-race",
        parts: [{ text: "continue" }],
      }),
      configuration: { returnImmediately: true },
    }));
    expect(immediate.status.state).toBe(A2ATaskState.WORKING);

    const canceled = await handler.handle(A2AJsonRpcMethod.CANCEL_TASK, { id: TASK_ID }) as A2ATask;
    expect(canceled.status.state).toBe(A2ATaskState.CANCELED);
    finishResume(completedResult());

    await vi.waitFor(async () => {
      expect((await store.get(HANDLER_ID, TASK_ID))?.task.status.state)
        .toBe(A2ATaskState.CANCELED);
    });
  });

  it("reconciles the terminal winner when cancellation loses the commit race", async () => {
    const { handler, runner, store } = makeHarness();
    await seedWorkingTask(
      store,
      HANDLER_ID,
      TASK_ID,
      "context-terminal-race",
      "message-terminal-race-start",
    );
    await store.transition({
      handlerId: HANDLER_ID,
      taskId: TASK_ID,
      state: A2ATaskState.INPUT_REQUIRED,
      message: userMessage("status-terminal-race-waiting", {
        role: A2ARole.AGENT,
        parts: [{ text: "continue" }],
      }),
    });
    let finishResume!: (result: SubAgentSpawnResult) => void;
    runner.resumeFromA2AWire.mockImplementation(async () => await new Promise(
      (resolve) => {
        finishResume = resolve;
      },
    ));
    runner.cancelA2AWireRun.mockResolvedValue({
      ok: false,
      reason: "task-not-cancelable",
      run: {
        childSessionId: TASK_ID,
        title: "wire profile",
        taskState: A2ATaskState.COMPLETED,
        summary: "completed output",
      },
    } as never);

    const immediate = taskFrom(await handler.handle(A2AJsonRpcMethod.SEND_MESSAGE, {
      message: userMessage("message-terminal-race-answer", {
        taskId: TASK_ID,
        contextId: "context-terminal-race",
        parts: [{ text: "continue" }],
      }),
      configuration: { returnImmediately: true },
    }));
    expect(immediate.status.state).toBe(A2ATaskState.WORKING);

    await expect(handler.handle(A2AJsonRpcMethod.CANCEL_TASK, { id: TASK_ID }))
      .rejects.toMatchObject({ definition: { code: -32002 } });
    await expect(store.get(HANDLER_ID, TASK_ID)).resolves.toMatchObject({
      task: { status: { state: A2ATaskState.COMPLETED } },
    });
    finishResume(completedResult());

    await vi.waitFor(async () => {
      expect((await store.get(HANDLER_ID, TASK_ID))?.task.status.state)
        .toBe(A2ATaskState.COMPLETED);
    });
  });

  it("hides cross-handler task existence before runner lookup", async () => {
    const first = makeHarness(HANDLER_ID);
    await seedWorkingTask(
      first.store,
      HANDLER_ID,
      TASK_ID,
      "context-private",
      "message-private",
    );
    const audit = vi.fn();
    const runner = {
      spawnFromA2AWire: vi.fn(),
      resumeFromA2AWire: vi.fn(),
      getA2AWireRunSnapshot: vi.fn(),
      cancelA2AWireRun: vi.fn(),
    };
    const authorizeOperation = vi.fn(async () => true);
    const other = new A2ASubAgentHandler({
      id: "profile-b",
      card: card(),
      binding: binding("profile-b"),
      runner: runner as unknown as A2ASubAgentLifecycleRunner,
      store: first.store,
      authorizeOperation,
      audit,
    });

    await expect(other.handle(A2AJsonRpcMethod.GET_TASK, { id: TASK_ID }))
      .rejects.toMatchObject({ definition: { code: -32001 } });
    await expect(other.handle(A2AJsonRpcMethod.SEND_MESSAGE, {
      message: userMessage("message-cross-origin-answer", {
        taskId: TASK_ID,
        contextId: "context-private",
      }),
    })).rejects.toMatchObject({ definition: { code: -32001 } });
    await expect(other.handle(A2AJsonRpcMethod.CANCEL_TASK, { id: TASK_ID }))
      .rejects.toMatchObject({ definition: { code: -32001 } });
    expect(runner.getA2AWireRunSnapshot).not.toHaveBeenCalled();
    expect(runner.resumeFromA2AWire).not.toHaveBeenCalled();
    expect(runner.cancelA2AWireRun).not.toHaveBeenCalled();
    expect(authorizeOperation).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledTimes(3);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      reason: "cross-origin",
      taskId: TASK_ID,
    }));
  });

  it.each(["linked", "fallback"] as const)(
    "drops and audits a live child identity claimed by another handler (%s)",
    async (linkMode) => {
      const first = makeHarness(HANDLER_ID);
      await seedWorkingTask(
        first.store,
        HANDLER_ID,
        TASK_ID,
        "context-owner",
        "message-owner",
      );
      const audit = vi.fn();
      const runner = {
        spawnFromA2AWire: vi.fn(async (_request, _binding, callbacks) => {
          if (linkMode === "linked") {
            await callbacks.onDurablyLinked({ childSessionId: TASK_ID });
          }
          return completedResult();
        }),
        resumeFromA2AWire: vi.fn(),
        getA2AWireRunSnapshot: vi.fn(),
        cancelA2AWireRun: vi.fn(),
      };
      const other = new A2ASubAgentHandler({
        id: "profile-b",
        card: card(),
        binding: binding("profile-b"),
        runner: runner as unknown as A2ASubAgentLifecycleRunner,
        store: first.store,
        authorizeOperation: vi.fn(async () => true),
        audit,
      });

      await expect(other.handle(A2AJsonRpcMethod.SEND_MESSAGE, {
        message: userMessage("message-intruder"),
      })).rejects.toThrow();
      await expect(first.store.get(HANDLER_ID, TASK_ID)).resolves.not.toBeNull();
      await expect(first.store.get("profile-b", TASK_ID)).resolves.toBeNull();
      expect(audit).toHaveBeenCalledWith(expect.objectContaining({
        reason: "cross-origin",
        outcome: "dropped",
        taskId: TASK_ID,
        messageId: "message-intruder",
      }));
    },
  );

  it("terminalizes an unexpected resume throw without exposing its detail", async () => {
    const { handler, runner, store } = makeHarness();
    runner.spawnFromA2AWire.mockImplementation(async (_request, _binding, callbacks) => {
      await callbacks.onDurablyLinked({ childSessionId: TASK_ID });
      return waitingResult();
    });
    runner.resumeFromA2AWire.mockRejectedValue(
      new Error("provider detail sk-abcdefgh12345678"),
    );
    const waiting = taskFrom(await handler.handle(A2AJsonRpcMethod.SEND_MESSAGE, {
      message: userMessage("wire-failure-start"),
    }));

    const failed = taskFrom(await handler.handle(A2AJsonRpcMethod.SEND_MESSAGE, {
      message: userMessage("wire-failure-resume", {
        taskId: TASK_ID,
        contextId: waiting.contextId,
        parts: [{ text: "continue" }],
      }),
    }));

    expect(failed.status).toMatchObject({
      state: A2ATaskState.FAILED,
      message: { parts: [{ text: "Task failed." }] },
    });
    expect(JSON.stringify(failed)).not.toContain("provider detail");
    await expect(store.get(HANDLER_ID, TASK_ID)).resolves.toMatchObject({
      task: { status: { state: A2ATaskState.FAILED } },
    });
  });

  it("rejects a duplicate message id retargeted to another task or context", async () => {
    const { handler, runner, store, audit } = makeHarness();
    await seedWorkingTask(
      store,
      HANDLER_ID,
      TASK_ID,
      "context-original",
      "message-retarget",
    );

    await expect(handler.handle(A2AJsonRpcMethod.SEND_MESSAGE, {
      message: userMessage("message-retarget", {
        taskId: "sub-9309a050-25767e9a-fc68-4d2d-8fbc-0db619adcc76",
        contextId: "context-other",
      }),
    })).rejects.toMatchObject({ definition: { code: -32602 } });
    expect(runner.resumeFromA2AWire).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      reason: "invalid-message",
      messageId: "message-retarget",
    }));
  });

  it("rejects secret-shaped unknown task ids before they reach audit", async () => {
    const { handler, audit } = makeHarness();
    await expect(handler.handle(A2AJsonRpcMethod.GET_TASK, {
      id: "sk-abcdefgh12345678",
    })).rejects.toMatchObject({ definition: { code: -32602 } });
    expect(JSON.stringify(audit.mock.calls)).not.toContain("sk-abcdefgh12345678");
  });

  it("lists tasks with stable cursors and history projection", async () => {
    const { handler, store } = makeHarness();
    await seedWorkingTask(
      store,
      HANDLER_ID,
      "sub-2fa270d9-89dd0aa8-f055-43ab-8b4b-65fc8b62caf5",
      "context-list",
      "message-list-1",
    );
    await seedWorkingTask(
      store,
      HANDLER_ID,
      "sub-271e6ece-df551ed9-eb46-4f78-894c-a578d89e3e29",
      "context-list",
      "message-list-2",
    );

    const first = await handler.handle(A2AJsonRpcMethod.LIST_TASKS, {
      contextId: "context-list",
      pageSize: 1,
      historyLength: 0,
    }) as A2AListTasksResult;
    expect(first.tasks).toHaveLength(1);
    expect(first.tasks[0]?.history).toEqual([]);
    expect(first.nextPageToken).not.toBe("");
    expect(first.totalSize).toBe(2);

    const second = await handler.handle(A2AJsonRpcMethod.LIST_TASKS, {
      contextId: "context-list",
      pageSize: 1,
      pageToken: first.nextPageToken,
    }) as A2AListTasksResult;
    expect(second.tasks).toHaveLength(1);
    expect(second.tasks[0]?.id).not.toBe(first.tasks[0]?.id);
    expect(second.nextPageToken).toBe("");
  });

  it("includes runner-canceled detached tasks in a CANCELED filtered list", async () => {
    const { handler, runner, store } = makeHarness();
    await seedInputRequiredTask(
      store,
      TASK_ID,
      "context-detached-list",
      "message-detached-list",
    );
    runner.getA2AWireRunSnapshot.mockReturnValue({
      childSessionId: TASK_ID,
      title: "wire profile",
      taskState: A2ATaskState.CANCELED,
    });

    const listed = await handler.handle(A2AJsonRpcMethod.LIST_TASKS, {
      contextId: "context-detached-list",
      status: A2ATaskState.CANCELED,
    }) as A2AListTasksResult;

    expect(listed.tasks).toHaveLength(1);
    expect(listed.tasks[0]).toMatchObject({
      id: TASK_ID,
      status: { state: A2ATaskState.CANCELED },
    });
    expect(listed.totalSize).toBe(1);
    await expect(store.get(HANDLER_ID, TASK_ID)).resolves.toMatchObject({
      task: { status: { state: A2ATaskState.CANCELED } },
    });
  });

  it("enforces protobuf int32 history lengths and RFC 3339 timestamps", async () => {
    const { handler } = makeHarness();
    await expect(handler.handle(A2AJsonRpcMethod.GET_TASK, {
      id: TASK_ID,
      historyLength: 2_147_483_648,
    })).rejects.toMatchObject({ definition: { code: -32602 } });
    await expect(handler.handle(A2AJsonRpcMethod.LIST_TASKS, {
      statusTimestampAfter: "2026-02-30T00:00:00Z",
    })).rejects.toMatchObject({ definition: { code: -32602 } });
    await expect(handler.handle(A2AJsonRpcMethod.LIST_TASKS, {
      statusTimestampAfter: "2026-07-14 00:00:00Z",
    })).rejects.toMatchObject({ definition: { code: -32602 } });
  });

  it("monotonically reconciles a durable task from the runner snapshot", async () => {
    const { handler, runner, store } = makeHarness();
    await seedWorkingTask(
      store,
      HANDLER_ID,
      TASK_ID,
      "context-reconcile",
      "message-reconcile",
    );
    runner.getA2AWireRunSnapshot.mockReturnValue({
      childSessionId: TASK_ID,
      title: "wire profile",
      taskState: A2ATaskState.COMPLETED,
      summary: "recovered result",
    });

    const task = await handler.handle(A2AJsonRpcMethod.GET_TASK, { id: TASK_ID }) as A2ATask;
    expect(task.status).toMatchObject({
      state: A2ATaskState.COMPLETED,
      message: { parts: [{ text: "recovered result" }] },
    });
    await expect(store.get(HANDLER_ID, TASK_ID)).resolves.toMatchObject({
      task: { status: { state: A2ATaskState.COMPLETED } },
    });
  });

  it.each(["budget", "question"] as const)(
    "expires a full-history %s suspension at exactly seven days",
    async (reason) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-07-15T00:00:00.000Z"));
      const taskId = `sub-expiry${reason.replace(/[^a-z0-9]/g, "")}-00000000-0000-4000-8000-000000000000`;
      const { handler, runner, store, audit } = makeHarness(HANDLER_ID, {
        maxHistoryMessages: 2,
        now: () => new Date(Date.now()).toISOString(),
      });
      await seedWorkingTask(
        store,
        HANDLER_ID,
        taskId,
        `context-expiry-${reason}`,
        `message-expiry-${reason}-start`,
      );
      await store.transition({
        handlerId: HANDLER_ID,
        taskId,
        state: A2ATaskState.INPUT_REQUIRED,
        message: userMessage(`message-expiry-${reason}-waiting`, {
          role: A2ARole.AGENT,
          parts: [{ text: "continue" }],
          metadata: {
            taskState: A2ATaskState.INPUT_REQUIRED,
            suspension: { reason, resumeId: taskId },
          },
        }),
      });

      await handler.startInputRequiredExpiry();
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(A2A_INPUT_REQUIRED_TTL_MS - 1);
      expect(runner.cancelA2AWireRun).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(runner.cancelA2AWireRun).toHaveBeenCalledTimes(1);
      await expect(store.get(HANDLER_ID, taskId)).resolves.toMatchObject({
        task: {
          status: { state: A2ATaskState.CANCELED },
          history: [{}, {}],
        },
      });
      expect(audit).toHaveBeenCalledWith({
        type: "a2a-task-lifecycle",
        outcome: "canceled",
        reason: "task-expired",
        handlerId: HANDLER_ID,
        taskId,
      });
      await handler.dispose();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("resets expiry only after a new authoritative INPUT_REQUIRED episode", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T00:00:00.000Z"));
    const taskId = "sub-e8991570-4ca34f95-5032-4b24-84b2-d8ada3f5a891";
    const contextId = "context-expiry-reset";
    const { handler, runner, store } = makeHarness(HANDLER_ID, {
      now: () => new Date(Date.now()).toISOString(),
    });
    await seedInputRequiredTask(
      store,
      taskId,
      contextId,
      "message-expiry-reset",
    );
    await handler.startInputRequiredExpiry();

    await vi.advanceTimersByTimeAsync(6 * 24 * 60 * 60 * 1_000);
    runner.resumeFromA2AWire.mockResolvedValueOnce(waitingResult(taskId));
    const resumed = taskFrom(await handler.handle(A2AJsonRpcMethod.SEND_MESSAGE, {
      message: userMessage("message-expiry-reset-resume", {
        taskId,
        contextId,
      }),
    }));
    expect(resumed.status.state).toBe(A2ATaskState.INPUT_REQUIRED);
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1_000);
    expect(runner.cancelA2AWireRun).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(6 * 24 * 60 * 60 * 1_000);
    expect(runner.cancelA2AWireRun).toHaveBeenCalledTimes(1);
    await expect(store.get(HANDLER_ID, taskId)).resolves.toMatchObject({
      task: { status: { state: A2ATaskState.CANCELED } },
    });
    await handler.dispose();
  });

  it("reconciles nonterminal restart records before applying expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-07T00:00:00.000Z"));
    const taskId = "sub-ff9df4bc-6158373f-7216-4afe-8859-72e67db86ab3";
    const { handler, runner, store } = makeHarness(HANDLER_ID, {
      now: () => new Date(Date.now()).toISOString(),
    });
    await seedInputRequiredTask(
      store,
      taskId,
      "context-expiry-restart",
      "message-expiry-restart",
    );
    vi.setSystemTime(new Date("2026-07-15T00:00:00.000Z"));
    runner.getA2AWireRunSnapshot.mockReturnValue({
      childSessionId: taskId,
      title: "wire profile",
      taskState: A2ATaskState.COMPLETED,
      summary: "restart winner",
    });

    await handler.startInputRequiredExpiry();
    await expect(store.get(HANDLER_ID, taskId)).resolves.toMatchObject({
      task: { status: { state: A2ATaskState.COMPLETED } },
    });
    expect(runner.cancelA2AWireRun).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await handler.dispose();
  });

  it("preserves an expired wait and retries after a runner cancellation failure", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T00:00:00.000Z"));
    const taskId = "sub-09577191-87d3057a-f089-4686-8cfe-c9ea71324647";
    const { handler, runner, store, audit } = makeHarness(HANDLER_ID, {
      now: () => new Date(Date.now()).toISOString(),
    });
    await seedInputRequiredTask(
      store,
      taskId,
      "context-expiry-retry",
      "message-expiry-retry",
    );
    runner.cancelA2AWireRun
      .mockResolvedValueOnce({ ok: false, reason: "storage-failed" })
      .mockResolvedValueOnce({
        ok: true,
        run: {
          childSessionId: taskId,
          title: "wire profile",
          taskState: A2ATaskState.CANCELED,
        },
      });
    await handler.startInputRequiredExpiry();

    await vi.advanceTimersByTimeAsync(A2A_INPUT_REQUIRED_TTL_MS);
    expect(runner.cancelA2AWireRun).toHaveBeenCalledTimes(1);
    await expect(store.get(HANDLER_ID, taskId)).resolves.toMatchObject({
      task: { status: { state: A2ATaskState.INPUT_REQUIRED } },
    });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "dropped",
      reason: "storage-failed",
      taskId,
    }));

    await vi.advanceTimersByTimeAsync(1_000);
    await handler.handle(A2AJsonRpcMethod.SEND_MESSAGE, {
      message: userMessage("message-expiry-unrelated-transition"),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(runner.cancelA2AWireRun).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(A2A_INPUT_REQUIRED_EXPIRY_RETRY_MS - 1_001);
    expect(runner.cancelA2AWireRun).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(runner.cancelA2AWireRun).toHaveBeenCalledTimes(2);
    await expect(store.get(HANDLER_ID, taskId)).resolves.toMatchObject({
      task: { status: { state: A2ATaskState.CANCELED } },
    });
    await handler.dispose();
  });

  it("keeps one nearest-deadline timer and clears it on dispose", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T00:00:00.000Z"));
    const { handler, runner, store } = makeHarness(HANDLER_ID, {
      now: () => new Date(Date.now()).toISOString(),
    });
    await seedInputRequiredTask(
      store,
      "sub-85e70efc-6c3136cd-d627-49c8-8047-2e9d382c7c39",
      "context-expiry-nearest-a",
      "message-expiry-nearest-a",
    );
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1_000);
    await seedInputRequiredTask(
      store,
      "sub-1a5b9379-cf43af38-8ae2-47a4-8870-c39bf5404f71",
      "context-expiry-nearest-b",
      "message-expiry-nearest-b",
    );

    await handler.startInputRequiredExpiry();
    expect(vi.getTimerCount()).toBe(1);
    await handler.dispose();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(A2A_INPUT_REQUIRED_TTL_MS);
    expect(runner.cancelA2AWireRun).not.toHaveBeenCalled();
  });

  it("makes concurrent disposal callers await an in-flight expiry sweep", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T00:00:00.000Z"));
    const taskId = "sub-b08bf3be-4a724840-cd90-4245-8916-8d0c8e581005";
    const { handler, runner, store } = makeHarness(HANDLER_ID, {
      now: () => new Date(Date.now()).toISOString(),
    });
    await seedInputRequiredTask(
      store,
      taskId,
      "context-expiry-dispose",
      "message-expiry-dispose",
    );
    const cancellation = deferred<{
      ok: true;
      run: {
        childSessionId: string;
        title: string;
        taskState: A2ATaskState.CANCELED;
      };
    }>();
    let signalCancellationStarted!: () => void;
    const cancellationStarted = new Promise<void>((resolve) => {
      signalCancellationStarted = resolve;
    });
    runner.cancelA2AWireRun.mockImplementationOnce(async () => {
      signalCancellationStarted();
      return await cancellation.promise;
    });
    await handler.startInputRequiredExpiry();

    vi.advanceTimersByTime(A2A_INPUT_REQUIRED_TTL_MS);
    await cancellationStarted;
    expect(runner.cancelA2AWireRun).toHaveBeenCalledOnce();

    let secondSettled = false;
    const first = handler.dispose();
    const second = handler.dispose().then(() => {
      secondSettled = true;
    });
    await Promise.resolve();
    expect(secondSettled).toBe(false);
    cancellation.resolve({
      ok: true,
      run: {
        childSessionId: taskId,
        title: "wire profile",
        taskState: A2ATaskState.CANCELED,
      },
    });
    await Promise.all([first, second]);
    expect(secondSettled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
