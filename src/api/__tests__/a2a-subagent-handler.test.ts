import { describe, expect, it, vi } from "vitest";
import {
  A2ARole,
  A2ATaskState,
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
import { createInMemoryFeatureNamespace } from "../../__tests__/test-helpers.js";
import {
  A2ASubAgentHandler,
  type A2AMutationAuthorizer,
  type A2ASubAgentLifecycleRunner,
} from "../a2a-subagent-handler.js";
import { A2ATaskStore } from "../a2a-task-store.js";

const HANDLER_ID = "profile-a";
const TASK_ID = "sub-wire-task-1";

function clock() {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 6, 14, 1, 0, tick++)).toISOString();
}

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
    authorizeMutation?: A2AMutationAuthorizer;
    omitAuthorizeMutation?: boolean;
    maxTasks?: number;
    maxHistoryMessages?: number;
  } = {},
) {
  const store = new A2ATaskStore({
    namespace: createInMemoryFeatureNamespace().handle,
    maxTasks: options.maxTasks ?? 10,
    maxHistoryMessages: options.maxHistoryMessages ?? 16,
    now: clock(),
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
  const authorizeMutation = options.authorizeMutation ?? vi.fn(async () => true);
  let id = 0;
  const handlerOptions = {
    id: handlerId,
    card: card(),
    binding: binding(handlerId),
    runner: runner as unknown as A2ASubAgentLifecycleRunner,
    store,
    authorizeMutation,
    makeId: () => "server-id-" + String(++id),
    audit,
  };
  if (options.omitAuthorizeMutation) {
    delete (handlerOptions as { authorizeMutation?: A2AMutationAuthorizer }).authorizeMutation;
  }
  const handler = new A2ASubAgentHandler(handlerOptions);
  return { store, runner, audit, authorizeMutation, handler };
}

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
  it("fails closed before the initial runner/store mutation when consent is denied", async () => {
    const authorizeMutation = vi.fn(async () => false);
    const { handler, runner, store, audit } = makeHarness(HANDLER_ID, {
      authorizeMutation,
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

    expect(authorizeMutation).toHaveBeenCalledWith({
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
    expect(JSON.stringify(authorizeMutation.mock.calls)).not.toContain("sk-abcdefgh12345678");
    expect(JSON.stringify(audit.mock.calls)).not.toContain("sk-abcdefgh12345678");
  });

  it.each(["missing", "throw"] as const)(
    "fails closed with OPERATION_REJECTED when the authorizer is %s",
    async (mode) => {
      const authorizeMutation = vi.fn(async () => {
        throw new Error("private approval detail");
      });
      const { handler, runner, store, audit } = makeHarness(HANDLER_ID, {
        ...(mode === "throw" ? { authorizeMutation } : {}),
        omitAuthorizeMutation: mode === "missing",
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
    const authorizeMutation = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const { handler, runner } = makeHarness(HANDLER_ID, { authorizeMutation });

    await expect(handler.handle(A2AJsonRpcMethod.SEND_MESSAGE, {
      message: userMessage("wire-admission-denied"),
    })).rejects.toMatchObject({ definition: { code: -32010 } });
    const approved = taskFrom(await handler.handle(A2AJsonRpcMethod.SEND_MESSAGE, {
      message: userMessage("wire-admission-after-denial"),
    }));

    expect(approved.id).toBe(TASK_ID);
    expect(authorizeMutation).toHaveBeenCalledTimes(2);
    expect(runner.spawnFromA2AWire).toHaveBeenCalledOnce();
  });

  it("keeps the fixed rejection when the audit sink throws", async () => {
    const authorizeMutation = vi.fn(async () => false);
    const { handler, runner, store, audit } = makeHarness(HANDLER_ID, {
      authorizeMutation,
    });
    audit.mockImplementation(() => {
      throw new Error("audit sink failed");
    });

    await expect(handler.handle(A2AJsonRpcMethod.SEND_MESSAGE, {
      message: userMessage("wire-consent-audit-failure"),
    })).rejects.toMatchObject({ definition: { code: -32010 } });

    expect(authorizeMutation).toHaveBeenCalledOnce();
    expect(runner.spawnFromA2AWire).not.toHaveBeenCalled();
    await expect(store.list(HANDLER_ID)).resolves.toEqual([]);
  });

  it("rejects invalid send input before requesting consent", async () => {
    const { handler, runner, store, authorizeMutation } = makeHarness();

    await expect(handler.handle(A2AJsonRpcMethod.SEND_MESSAGE, {
      message: userMessage("wire-invalid-raw", {
        parts: [{ raw: "c2VjcmV0", mediaType: "application/octet-stream" }],
      }),
    })).rejects.toMatchObject({ definition: { code: -32005 } });

    expect(authorizeMutation).not.toHaveBeenCalled();
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
    const { handler, runner, store, audit, authorizeMutation } = makeHarness();
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

    expect(authorizeMutation).not.toHaveBeenCalled();
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
    const authorizeMutation = vi.fn(async () => await approval.promise);
    const { handler, runner, store } = makeHarness(HANDLER_ID, { authorizeMutation });
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
    await vi.waitFor(() => expect(authorizeMutation).toHaveBeenCalledOnce());
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
    const authorizeMutation = vi.fn(async () => false);
    const { handler, runner, store, audit } = makeHarness(HANDLER_ID, {
      authorizeMutation,
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

    expect(authorizeMutation).toHaveBeenCalledWith({
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
    const authorizeMutation = vi.fn(async () => await approval.promise);
    const { handler, runner, store } = makeHarness(HANDLER_ID, { authorizeMutation });
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
    await vi.waitFor(() => expect(authorizeMutation).toHaveBeenCalledOnce());
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
    const authorizeMutation = vi.fn(async () => await approval.promise);
    const { handler, runner, store } = makeHarness(HANDLER_ID, { authorizeMutation });
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
    await vi.waitFor(() => expect(authorizeMutation).toHaveBeenCalledOnce());
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
    const authorizeMutation = vi.fn(async () => await approval.promise);
    const { handler, runner, store } = makeHarness(HANDLER_ID, { authorizeMutation });
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
    await vi.waitFor(() => expect(authorizeMutation).toHaveBeenCalledOnce());

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
    expect(authorizeMutation).toHaveBeenCalledOnce();

    approval.resolve(false);
    await firstRejection;
    expect(runner.resumeFromA2AWire).not.toHaveBeenCalled();
  });

  it("revalidates a continuation after approval before history or runner mutation", async () => {
    const approval = deferred<boolean>();
    const authorizeMutation = vi.fn(async () => await approval.promise);
    const { handler, runner, store } = makeHarness(HANDLER_ID, { authorizeMutation });
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
    await vi.waitFor(() => expect(authorizeMutation).toHaveBeenCalledOnce());
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
    const { handler, runner, store, authorizeMutation } = makeHarness();
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
    expect(authorizeMutation).not.toHaveBeenCalled();
    expect(runner.resumeFromA2AWire).not.toHaveBeenCalled();
  });

  it("rejects unknown, terminal, and history-full mutations before consent", async () => {
    const unknown = makeHarness();
    await expect(unknown.handler.handle(A2AJsonRpcMethod.SEND_MESSAGE, {
      message: userMessage("message-unknown-preflight", {
        taskId: "sub-unknown-preflight",
        contextId: "context-unknown-preflight",
      }),
    })).rejects.toMatchObject({ definition: { code: -32001 } });
    await expect(unknown.handler.handle(A2AJsonRpcMethod.CANCEL_TASK, {
      id: "sub-unknown-preflight",
    })).rejects.toMatchObject({ definition: { code: -32001 } });
    expect(unknown.authorizeMutation).not.toHaveBeenCalled();

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
    expect(terminal.authorizeMutation).not.toHaveBeenCalled();

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
    expect(historyFull.authorizeMutation).not.toHaveBeenCalled();
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
    const { handler, runner, authorizeMutation } = makeHarness();
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
    expect(authorizeMutation).toHaveBeenCalledOnce();

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
    const { handler, runner, authorizeMutation } = makeHarness();
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
    expect(authorizeMutation).toHaveBeenCalledOnce();
    expect(runner.spawnFromA2AWire).toHaveBeenCalledOnce();

    linkGate.resolve();
    await first;
    resultGate.resolve(completedResult());
  });

  it("blocks a continuation from committing an initial admission message id", async () => {
    const initialTaskId = "sub-initial-admission-race";
    const { handler, runner, store, authorizeMutation } = makeHarness();
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
    expect(authorizeMutation).toHaveBeenCalledOnce();
    expect(runner.resumeFromA2AWire).not.toHaveBeenCalled();

    linkGate.resolve();
    await initial;
    resultGate.resolve(completedResult(initialTaskId));
  });

  it("rejects conflicting concurrent initial bodies with the same message id", async () => {
    const approval = deferred<boolean>();
    const authorizeMutation = vi.fn(async () => await approval.promise);
    const { handler, runner, store } = makeHarness(HANDLER_ID, { authorizeMutation });

    const first = handler.handle(A2AJsonRpcMethod.SEND_MESSAGE, {
      message: userMessage("wire-conflicting-initial", {
        parts: [{ text: "first body" }],
      }),
    });
    const firstRejection = expect(first).rejects.toMatchObject({
      definition: { code: -32010 },
    });
    await vi.waitFor(() => expect(authorizeMutation).toHaveBeenCalledOnce());

    await expect(handler.handle(A2AJsonRpcMethod.SEND_MESSAGE, {
      message: userMessage("wire-conflicting-initial", {
        parts: [{ text: "different body" }],
      }),
    })).rejects.toMatchObject({ definition: { code: -32010 } });
    expect(authorizeMutation).toHaveBeenCalledOnce();
    expect(runner.spawnFromA2AWire).not.toHaveBeenCalled();

    approval.resolve(false);
    await firstRejection;
    await expect(store.list(HANDLER_ID)).resolves.toEqual([]);
  });

  it("replays an already durable duplicate without requesting consent again", async () => {
    const { handler, runner, authorizeMutation } = makeHarness();
    const request = { message: userMessage("wire-durable-replay") };

    const first = taskFrom(await handler.handle(A2AJsonRpcMethod.SEND_MESSAGE, request));
    const replay = taskFrom(await handler.handle(A2AJsonRpcMethod.SEND_MESSAGE, request));

    expect(replay.id).toBe(first.id);
    expect(authorizeMutation).toHaveBeenCalledOnce();
    expect(runner.spawnFromA2AWire).toHaveBeenCalledOnce();
  });

  it("rejects a conflicting body for an already durable initial message id", async () => {
    const { handler, runner, authorizeMutation } = makeHarness();
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

    expect(authorizeMutation).toHaveBeenCalledOnce();
    expect(runner.spawnFromA2AWire).toHaveBeenCalledOnce();
  });

  it("rejects a conflicting body for an already durable continuation message id", async () => {
    const { handler, runner, store, authorizeMutation } = makeHarness();
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

    expect(authorizeMutation).toHaveBeenCalledOnce();
    expect(runner.resumeFromA2AWire).toHaveBeenCalledOnce();
  });

  it("does not request mutation consent for task reads", async () => {
    const { handler, store, authorizeMutation } = makeHarness();
    await seedWorkingTask(
      store,
      HANDLER_ID,
      TASK_ID,
      "context-read",
      "message-read",
    );

    await handler.handle(A2AJsonRpcMethod.GET_TASK, { id: TASK_ID });
    await handler.handle(A2AJsonRpcMethod.LIST_TASKS, {});
    expect(authorizeMutation).not.toHaveBeenCalled();
  });

  it("rejects a full active task store before consent or runner start", async () => {
    const { handler, runner, store, authorizeMutation, audit } = makeHarness(
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

    expect(authorizeMutation).not.toHaveBeenCalled();
    expect(runner.spawnFromA2AWire).not.toHaveBeenCalled();
    await expect(store.list(HANDLER_ID)).resolves.toHaveLength(1);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      reason: "task-budget-exceeded",
      outcome: "dropped",
      messageId: "message-capacity-rejected",
    }));
  });

  it("cancels a live task idempotently through the handler-bound runner seam", async () => {
    const { handler, runner, store, authorizeMutation } = makeHarness();
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
    expect(authorizeMutation).toHaveBeenCalledOnce();
  });

  it("preflights cancel before consent and preserves a live task when denied", async () => {
    const authorizeMutation = vi.fn(async () => false);
    const { handler, runner, store, audit } = makeHarness(HANDLER_ID, {
      authorizeMutation,
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

    expect(authorizeMutation).toHaveBeenCalledWith({
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
    const authorizeMutation = vi.fn(async () => await approval.promise);
    const { handler, runner, store } = makeHarness(HANDLER_ID, { authorizeMutation });
    await seedWorkingTask(
      store,
      HANDLER_ID,
      TASK_ID,
      "context-cancel-shared-denial",
      "message-cancel-shared-denial",
    );

    const first = handler.handle(A2AJsonRpcMethod.CANCEL_TASK, { id: TASK_ID });
    const second = handler.handle(A2AJsonRpcMethod.CANCEL_TASK, { id: TASK_ID });
    await vi.waitFor(() => expect(authorizeMutation).toHaveBeenCalledOnce());
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
    const authorizeMutation = vi.fn(async () => await approval.promise);
    const { handler, runner, store } = makeHarness(HANDLER_ID, { authorizeMutation });
    await seedWorkingTask(
      store,
      HANDLER_ID,
      TASK_ID,
      "context-cancel-shared-allow",
      "message-cancel-shared-allow",
    );

    const first = handler.handle(A2AJsonRpcMethod.CANCEL_TASK, { id: TASK_ID });
    const second = handler.handle(A2AJsonRpcMethod.CANCEL_TASK, { id: TASK_ID });
    await vi.waitFor(() => expect(authorizeMutation).toHaveBeenCalledOnce());
    approval.resolve(true);
    const tasks = await Promise.all([first, second]) as A2ATask[];

    expect(tasks.map((task) => task.status.state)).toEqual([
      A2ATaskState.CANCELED,
      A2ATaskState.CANCELED,
    ]);
    expect(runner.cancelA2AWireRun).toHaveBeenCalledOnce();
  });

  it("revalidates cancel after approval before the runner mutation", async () => {
    const approval = deferred<boolean>();
    const authorizeMutation = vi.fn(async () => await approval.promise);
    const { handler, runner, store } = makeHarness(HANDLER_ID, { authorizeMutation });
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
    await vi.waitFor(() => expect(authorizeMutation).toHaveBeenCalledOnce());
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
    const authorizeMutation = vi.fn(async () => await approval.promise);
    const { handler, runner, store } = makeHarness(HANDLER_ID, { authorizeMutation });
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
    await vi.waitFor(() => expect(authorizeMutation).toHaveBeenCalledOnce());

    await expect(handler.handle(A2AJsonRpcMethod.CANCEL_TASK, { id: TASK_ID }))
      .rejects.toMatchObject({ definition: { code: -32010 } });
    expect(authorizeMutation).toHaveBeenCalledOnce();
    expect(runner.cancelA2AWireRun).not.toHaveBeenCalled();

    approval.resolve(false);
    await continuationRejection;
    expect(runner.resumeFromA2AWire).not.toHaveBeenCalled();
  });

  it("returns authoritative detached cancellation without canceling the runner again", async () => {
    const { handler, runner, store, authorizeMutation } = makeHarness();
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
    expect(authorizeMutation).not.toHaveBeenCalled();
    expect(runner.cancelA2AWireRun).not.toHaveBeenCalled();
    await expect(store.get(HANDLER_ID, TASK_ID)).resolves.toMatchObject({
      task: { status: { state: A2ATaskState.CANCELED } },
    });
  });

  it("reconciles detached cancellation while cancel consent is pending", async () => {
    const approval = deferred<boolean>();
    const authorizeMutation = vi.fn(async () => await approval.promise);
    const { handler, runner, store } = makeHarness(HANDLER_ID, { authorizeMutation });
    await seedInputRequiredTask(
      store,
      TASK_ID,
      "context-detached-cancel-consent",
      "message-detached-cancel-consent",
    );

    const pending = handler.handle(A2AJsonRpcMethod.CANCEL_TASK, { id: TASK_ID });
    await vi.waitFor(() => expect(authorizeMutation).toHaveBeenCalledOnce());
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
    const authorizeMutation = vi.fn(async () => true);
    const other = new A2ASubAgentHandler({
      id: "profile-b",
      card: card(),
      binding: binding("profile-b"),
      runner: runner as unknown as A2ASubAgentLifecycleRunner,
      store: first.store,
      authorizeMutation,
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
    expect(authorizeMutation).not.toHaveBeenCalled();
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
        authorizeMutation: vi.fn(async () => true),
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
        taskId: "sub-other-task",
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
      "sub-list-1",
      "context-list",
      "message-list-1",
    );
    await seedWorkingTask(
      store,
      HANDLER_ID,
      "sub-list-2",
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
});
