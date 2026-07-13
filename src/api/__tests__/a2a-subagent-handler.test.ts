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
import {
  A2ASubAgentHandler,
  type A2ASubAgentLifecycleRunner,
} from "../a2a-subagent-handler.js";
import { A2ATaskStore } from "../a2a-task-store.js";

const HANDLER_ID = "profile-a";
const TASK_ID = "sub-wire-task-1";

function memoryNamespace() {
  let value: unknown;
  return {
    readJson: async <T>(_name: string, fallback: T): Promise<T> =>
      (value === undefined ? structuredClone(fallback) : structuredClone(value)) as T,
    writeJson: async <T>(_name: string, next: T): Promise<void> => {
      value = structuredClone(next);
    },
  };
}

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

function makeHarness(handlerId = HANDLER_ID) {
  const store = new A2ATaskStore({
    namespace: memoryNamespace(),
    maxTasks: 10,
    maxHistoryMessages: 16,
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
  let id = 0;
  const handler = new A2ASubAgentHandler({
    id: handlerId,
    card: card(),
    binding: binding(handlerId),
    runner: runner as unknown as A2ASubAgentLifecycleRunner,
    store,
    makeId: () => "server-id-" + String(++id),
    audit,
  });
  return { store, runner, audit, handler };
}

function taskFrom(result: unknown): A2ATask {
  return (result as { task: A2ATask }).task;
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

describe("A2ASubAgentHandler", () => {
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

  it("coalesces concurrent retries of the same initial message id", async () => {
    const { handler, runner } = makeHarness();
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
    const request = {
      message: userMessage("wire-retry-1"),
      configuration: { returnImmediately: true },
    };

    const first = handler.handle(A2AJsonRpcMethod.SEND_MESSAGE, request);
    const second = handler.handle(A2AJsonRpcMethod.SEND_MESSAGE, request);
    releaseLink();
    const [firstTask, secondTask] = (await Promise.all([first, second])).map(taskFrom);

    expect(firstTask.id).toBe(TASK_ID);
    expect(secondTask.id).toBe(TASK_ID);
    expect(runner.spawnFromA2AWire).toHaveBeenCalledOnce();
    finish(completedResult());
  });

  it("cancels a live task idempotently through the handler-bound runner seam", async () => {
    const { handler, runner, store } = makeHarness();
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
    const other = new A2ASubAgentHandler({
      id: "profile-b",
      card: card(),
      binding: binding("profile-b"),
      runner: runner as unknown as A2ASubAgentLifecycleRunner,
      store: first.store,
      audit,
    });

    await expect(other.handle(A2AJsonRpcMethod.GET_TASK, { id: TASK_ID }))
      .rejects.toMatchObject({ definition: { code: -32001 } });
    expect(runner.getA2AWireRunSnapshot).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      reason: "unknown-task",
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
