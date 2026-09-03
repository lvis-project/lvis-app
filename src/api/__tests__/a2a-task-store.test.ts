import { describe, expect, it, vi } from "vitest";
import {
  A2ARole,
  A2ATaskState,
  type A2AMessage,
} from "../../shared/a2a.js";
import { A2ATaskStore } from "../a2a-task-store.js";
import { monotonicIsoClock as clock } from "./a2a-test-helpers.js";

function memoryNamespace(seed?: unknown) {
  let value = seed === undefined ? undefined : structuredClone(seed);
  let nextWriteError: Error | undefined;
  return {
    namespace: {
      readJson: async <T>(_name: string, fallback: T): Promise<T> =>
        (value === undefined ? structuredClone(fallback) : structuredClone(value)) as T,
      writeJson: async <T>(_name: string, next: T): Promise<void> => {
        if (nextWriteError) {
          const error = nextWriteError;
          nextWriteError = undefined;
          throw error;
        }
        value = structuredClone(next);
      },
    },
    snapshot: (): unknown => structuredClone(value),
    replace: (next: unknown): void => {
      value = structuredClone(next);
    },
    failNextWrite: (error = new Error("write failed")): void => {
      nextWriteError = error;
    },
  };
}

function userMessage(messageId: string, text = "hello"): A2AMessage {
  return {
    messageId,
    role: A2ARole.USER,
    parts: [{ text }],
  };
}

function agentMessage(messageId: string, text: string): A2AMessage {
  return {
    messageId,
    role: A2ARole.AGENT,
    parts: [{ text }],
  };
}

function makeStore(
  storage: ReturnType<typeof memoryNamespace>,
  options: { maxTasks?: number; maxHistoryMessages?: number } = {},
): A2ATaskStore {
  return new A2ATaskStore({
    namespace: storage.namespace,
    maxTasks: options.maxTasks ?? 4,
    maxHistoryMessages: options.maxHistoryMessages ?? 8,
    now: clock(),
  });
}

describe("A2ATaskStore", () => {
  it("persists only DLP-canonical messages and returns isolated snapshots", async () => {
    const storage = memoryNamespace();
    const store = makeStore(storage);
    const created = await store.create({
      handlerId: "profile-a",
      childSessionId: "sub-b4c877df-aabd0315-0c46-4268-8bd9-11cf01fdb049",
      contextId: "context-1",
      message: userMessage("message-1", "use sk-abcdefgh12345678"),
    });

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(JSON.stringify(storage.snapshot())).not.toContain("sk-abcdefgh12345678");
    expect(created.record.task.history?.[0]?.parts[0]).toMatchObject({
      text: expect.stringContaining("[REDACTED:TOKEN]"),
    });

    created.record.task.history![0]!.parts[0] = { text: "mutated" };
    const untouched = await store.get("profile-a", "sub-b4c877df-aabd0315-0c46-4268-8bd9-11cf01fdb049");
    expect(untouched?.task.history?.[0]?.parts[0]).not.toEqual({ text: "mutated" });

    const reloaded = makeStore(storage);
    await expect(reloaded.get("profile-a", "sub-b4c877df-aabd0315-0c46-4268-8bd9-11cf01fdb049")).resolves.toMatchObject({
      task: {
        id: "sub-b4c877df-aabd0315-0c46-4268-8bd9-11cf01fdb049",
        status: { state: A2ATaskState.SUBMITTED },
      },
    });
  });

  it("quarantines every record that shares a child identity across handlers", async () => {
    const storage = memoryNamespace();
    const first = makeStore(storage);
    await first.create({
      handlerId: "profile-a",
      childSessionId: "sub-05b0773c-683f3b84-14b5-4637-8e0c-62f6a08a8de3",
      contextId: "context-duplicate",
      message: userMessage("message-duplicate"),
    });
    const raw = storage.snapshot() as {
      version: number;
      records: Array<Record<string, unknown>>;
    };
    raw.records.push({
      ...structuredClone(raw.records[0]!),
      handlerId: "profile-b",
    });
    storage.replace(raw);
    const audit = vi.fn();
    const reloaded = new A2ATaskStore({
      namespace: storage.namespace,
      maxTasks: 4,
      maxHistoryMessages: 8,
      now: clock(),
      audit,
    });

    await expect(reloaded.get("profile-a", "sub-05b0773c-683f3b84-14b5-4637-8e0c-62f6a08a8de3")).resolves.toBeNull();
    await expect(reloaded.get("profile-b", "sub-05b0773c-683f3b84-14b5-4637-8e0c-62f6a08a8de3")).resolves.toBeNull();
    expect(audit).toHaveBeenCalledWith({
      type: "a2a-task-store-drop",
      reason: "duplicate-record",
      count: 2,
    });
  });

  it("rejects a live child identity reused by another handler", async () => {
    const storage = memoryNamespace();
    const store = makeStore(storage);
    await expect(store.create({
      handlerId: "profile-a",
      childSessionId: "sub-1fb45a08-3d091b5d-a48f-4a25-8d6c-d9af7aa6f45f",
      contextId: "context-owner",
      message: userMessage("message-owner"),
    })).resolves.toMatchObject({ ok: true, created: true });

    await expect(store.create({
      handlerId: "profile-b",
      childSessionId: "sub-1fb45a08-3d091b5d-a48f-4a25-8d6c-d9af7aa6f45f",
      contextId: "context-intruder",
      message: userMessage("message-intruder"),
    })).resolves.toEqual({ ok: false, reason: "child-session-conflict" });

    await expect(store.get("profile-a", "sub-1fb45a08-3d091b5d-a48f-4a25-8d6c-d9af7aa6f45f")).resolves.not.toBeNull();
    await expect(store.get("profile-b", "sub-1fb45a08-3d091b5d-a48f-4a25-8d6c-d9af7aa6f45f")).resolves.toBeNull();
    await expect(store.lookupTask("profile-a", "sub-1fb45a08-3d091b5d-a48f-4a25-8d6c-d9af7aa6f45f")).resolves.toMatchObject({
      ok: true,
      record: { handlerId: "profile-a" },
    });
    await expect(store.lookupTask("profile-b", "sub-1fb45a08-3d091b5d-a48f-4a25-8d6c-d9af7aa6f45f")).resolves.toEqual({
      ok: false,
      reason: "cross-origin",
    });
    await expect(store.lookupTask("profile-b", "sub-unknown")).resolves.toEqual({
      ok: false,
      reason: "unknown-task",
    });
    await expect(store.preflightContinuation({
      handlerId: "profile-b",
      taskId: "sub-1fb45a08-3d091b5d-a48f-4a25-8d6c-d9af7aa6f45f",
      contextId: "context-owner",
      message: userMessage("message-cross-origin-answer"),
    })).resolves.toEqual({
      ok: false,
      reason: "task-not-found",
      availability: "cross-origin",
    });
    await expect(store.preflightContinuation({
      handlerId: "profile-b",
      taskId: "sub-unknown",
      message: userMessage("message-unknown-answer"),
    })).resolves.toEqual({
      ok: false,
      reason: "task-not-found",
      availability: "unknown-task",
    });
    expect((storage.snapshot() as { records: unknown[] }).records).toHaveLength(1);
  });

  it("never evicts active or INPUT_REQUIRED tasks to admit new work", async () => {
    const storage = memoryNamespace();
    const store = makeStore(storage, { maxTasks: 2 });
    await store.create({
      handlerId: "profile-a",
      childSessionId: "sub-83602e93-18b4280f-c56f-4d97-8d78-91e866be7c93",
      contextId: "context-a",
      message: userMessage("message-active"),
    });
    await store.transition({
      handlerId: "profile-a",
      taskId: "sub-83602e93-18b4280f-c56f-4d97-8d78-91e866be7c93",
      state: A2ATaskState.WORKING,
    });
    await store.create({
      handlerId: "profile-a",
      childSessionId: "sub-2c9f04ba-08a583ad-7a55-4b52-8e64-95c2b69f3c49",
      contextId: "context-b",
      message: userMessage("message-waiting"),
    });
    await store.transition({
      handlerId: "profile-a",
      taskId: "sub-2c9f04ba-08a583ad-7a55-4b52-8e64-95c2b69f3c49",
      state: A2ATaskState.INPUT_REQUIRED,
      message: agentMessage("status-waiting", "continue"),
    });

    await expect(store.create({
      handlerId: "profile-a",
      childSessionId: "sub-aa5ebb95-c743922a-4fc2-4170-8325-b6cdfe0adf5e",
      contextId: "context-c",
      message: userMessage("message-overflow"),
    })).resolves.toEqual({ ok: false, reason: "capacity-exceeded" });

    await store.transition({
      handlerId: "profile-a",
      taskId: "sub-83602e93-18b4280f-c56f-4d97-8d78-91e866be7c93",
      state: A2ATaskState.COMPLETED,
      message: agentMessage("status-completed", "done"),
    });
    await expect(store.create({
      handlerId: "profile-a",
      childSessionId: "sub-10e4d15d-2c17017c-9d14-4462-83cb-5751d324aefd",
      contextId: "context-d",
      message: userMessage("message-replacement"),
    })).resolves.toMatchObject({ ok: true, created: true });
    await expect(store.get("profile-a", "sub-83602e93-18b4280f-c56f-4d97-8d78-91e866be7c93")).resolves.toBeNull();
    await expect(store.get("profile-a", "sub-2c9f04ba-08a583ad-7a55-4b52-8e64-95c2b69f3c49")).resolves.not.toBeNull();
  });

  it("never evicts another handler's tasks when the global capacity is full", async () => {
    const storage = memoryNamespace();
    const store = makeStore(storage, { maxTasks: 2 });
    await store.create({
      handlerId: "profile-a",
      childSessionId: "sub-2c23180b-afcee922-a8e5-4733-85ba-574d2b30df6a",
      contextId: "context-a-old",
      message: userMessage("message-profile-a-old"),
    });
    await store.transition({
      handlerId: "profile-a",
      taskId: "sub-2c23180b-afcee922-a8e5-4733-85ba-574d2b30df6a",
      state: A2ATaskState.COMPLETED,
    });
    await store.create({
      handlerId: "profile-b",
      childSessionId: "sub-11f235f4-2238ac27-8dc5-4db3-8a5e-9cb3136917a3",
      contextId: "context-b",
      message: userMessage("message-profile-b"),
    });

    await expect(store.create({
      handlerId: "profile-c",
      childSessionId: "sub-e8fa0ffe-b6e1643f-7757-42d0-8ec0-b98d472d36b8",
      contextId: "context-c-new",
      message: userMessage("message-profile-c-new"),
    })).resolves.toEqual({ ok: false, reason: "capacity-exceeded" });
    await expect(store.get("profile-a", "sub-2c23180b-afcee922-a8e5-4733-85ba-574d2b30df6a")).resolves.not.toBeNull();

    await expect(store.create({
      handlerId: "profile-a",
      childSessionId: "sub-632bafdf-eef22393-c49c-4d95-8751-28b8aeb449fd",
      contextId: "context-a-new",
      message: userMessage("message-profile-a-new"),
    })).resolves.toMatchObject({ ok: true, created: true });
    await expect(store.get("profile-a", "sub-2c23180b-afcee922-a8e5-4733-85ba-574d2b30df6a")).resolves.toBeNull();
    await expect(store.get("profile-b", "sub-11f235f4-2238ac27-8dc5-4db3-8a5e-9cb3136917a3")).resolves.not.toBeNull();
  });

  it("enforces a per-handler fair-share without blocking another handler", async () => {
    const storage = memoryNamespace();
    const store = new A2ATaskStore({
      namespace: storage.namespace,
      maxTasks: 4,
      maxTasksPerHandler: 2,
      maxHistoryMessages: 8,
      now: clock(),
    });
    for (const suffix of ["one", "two"]) {
      await store.create({
        handlerId: "profile-a",
        childSessionId: `sub-profilea${suffix}-00000000-0000-4000-8000-000000000000`,
        contextId: `context-profile-a-${suffix}`,
        message: userMessage(`message-profile-a-${suffix}`),
      });
    }

    await expect(store.create({
      handlerId: "profile-a",
      childSessionId: "sub-9d270db2-73e5ddd7-1b85-48fc-8eaa-76442c1e3cdd",
      contextId: "context-profile-a-three",
      message: userMessage("message-profile-a-three"),
    })).resolves.toEqual({ ok: false, reason: "capacity-exceeded" });
    await expect(store.reserveInitialTaskAdmission({
      handlerId: "profile-a",
      message: userMessage("message-profile-a-reserved"),
    })).resolves.toEqual({ ok: false, reason: "capacity-exceeded" });
    await expect(store.create({
      handlerId: "profile-b",
      childSessionId: "sub-9f33e3ff-9e78d567-8337-4f54-8584-04f30e8cfcc8",
      contextId: "context-profile-b-one",
      message: userMessage("message-profile-b-one"),
    })).resolves.toMatchObject({ ok: true, created: true });
  });

  it("drops persisted records outside the active handler snapshot", async () => {
    const storage = memoryNamespace();
    const seed = makeStore(storage);
    await seed.create({
      handlerId: "profile-a",
      childSessionId: "sub-200b68b2-3f5dab5c-f7ce-4f48-8c61-4d2f06a6cadd",
      contextId: "context-active-profile",
      message: userMessage("message-active-profile"),
    });
    await seed.create({
      handlerId: "profile-b",
      childSessionId: "sub-fe9f34b8-b4078c69-3c0e-476d-8973-7c640238b773",
      contextId: "context-removed-profile",
      message: userMessage("message-removed-profile"),
    });
    const audit = vi.fn();
    const reloaded = new A2ATaskStore({
      namespace: storage.namespace,
      maxTasks: 4,
      maxTasksPerHandler: 2,
      maxHistoryMessages: 8,
      activeHandlerIds: new Set(["profile-a"]),
      audit,
    });

    await expect(reloaded.get("profile-a", "sub-200b68b2-3f5dab5c-f7ce-4f48-8c61-4d2f06a6cadd")).resolves.not.toBeNull();
    await expect(reloaded.get("profile-b", "sub-fe9f34b8-b4078c69-3c0e-476d-8973-7c640238b773")).resolves.toBeNull();
    await expect(
      reloaded.lookupTask("profile-a", "sub-fe9f34b8-b4078c69-3c0e-476d-8973-7c640238b773"),
    ).resolves.toEqual({ ok: false, reason: "unknown-task" });
    expect(audit).toHaveBeenCalledWith({
      type: "a2a-task-store-drop",
      reason: "inactive-handler",
      count: 1,
    });
  });

  it("reserves initial admission before consent and releases the single slot", async () => {
    const storage = memoryNamespace();
    const store = makeStore(storage, { maxTasks: 1 });
    await store.create({
      handlerId: "profile-a",
      childSessionId: "sub-1d6d3211-6bbbe9f1-df77-4dae-8cd3-e59969cdf8cb",
      contextId: "context-admission-existing",
      message: userMessage("message-admission-existing"),
    });
    await store.transition({
      handlerId: "profile-a",
      taskId: "sub-1d6d3211-6bbbe9f1-df77-4dae-8cd3-e59969cdf8cb",
      state: A2ATaskState.WORKING,
    });

    await expect(store.reserveInitialTaskAdmission({
      handlerId: "profile-a",
      message: userMessage("message-admission-full"),
    })).resolves.toEqual({ ok: false, reason: "capacity-exceeded" });

    await store.transition({
      handlerId: "profile-a",
      taskId: "sub-1d6d3211-6bbbe9f1-df77-4dae-8cd3-e59969cdf8cb",
      state: A2ATaskState.COMPLETED,
    });
    const reserved = await store.reserveInitialTaskAdmission({
      handlerId: "profile-a",
      message: userMessage("message-admission-first"),
    });
    expect(reserved).toMatchObject({ ok: true, reserved: true });
    if (!reserved.ok || !reserved.reserved) return;
    await expect(store.reserveInitialTaskAdmission({
      handlerId: "profile-a",
      message: userMessage("message-admission-distinct"),
    })).resolves.toEqual({ ok: false, reason: "admission-busy" });

    await store.releaseInitialTaskAdmission(reserved.admissionId);
    const reacquired = await store.reserveInitialTaskAdmission({
      handlerId: "profile-a",
      message: userMessage("message-admission-distinct"),
    });
    expect(reacquired).toMatchObject({ ok: true, reserved: true });
    if (!reacquired.ok || !reacquired.reserved) return;
    expect(reacquired.admissionId).not.toBe(reserved.admissionId);

    await store.releaseInitialTaskAdmission(reserved.admissionId);
    await expect(store.reserveInitialTaskAdmission({
      handlerId: "profile-a",
      message: userMessage("message-admission-after-stale-release"),
    })).resolves.toEqual({ ok: false, reason: "admission-busy" });
  });

  it("preflights continuation validity without mutating state or history", async () => {
    const storage = memoryNamespace();
    const store = makeStore(storage);
    await store.create({
      handlerId: "profile-a",
      childSessionId: "sub-91dda12a-fc3be07c-1a75-4988-8091-1b5cd0f4e29d",
      contextId: "context-preflight",
      message: userMessage("message-preflight-start"),
    });
    await store.transition({
      handlerId: "profile-a",
      taskId: "sub-91dda12a-fc3be07c-1a75-4988-8091-1b5cd0f4e29d",
      state: A2ATaskState.INPUT_REQUIRED,
      message: agentMessage("status-preflight-waiting", "continue"),
    });
    const input = {
      handlerId: "profile-a",
      taskId: "sub-91dda12a-fc3be07c-1a75-4988-8091-1b5cd0f4e29d",
      contextId: "context-preflight",
      message: userMessage("message-preflight-answer"),
    };
    const before = storage.snapshot();

    await expect(store.preflightContinuation(input)).resolves.toMatchObject({
      ok: true,
      duplicate: false,
      record: { task: { status: { state: A2ATaskState.INPUT_REQUIRED } } },
    });
    expect(storage.snapshot()).toEqual(before);
    await expect(store.get("profile-a", "sub-91dda12a-fc3be07c-1a75-4988-8091-1b5cd0f4e29d")).resolves.toMatchObject({
      task: {
        status: { state: A2ATaskState.INPUT_REQUIRED },
        history: expect.not.arrayContaining([
          expect.objectContaining({ messageId: "message-preflight-answer" }),
        ]),
      },
    });

    await expect(store.beginContinuation(input)).resolves.toMatchObject({
      ok: true,
      duplicate: false,
      record: { task: { status: { state: A2ATaskState.WORKING } } },
    });
    const afterCommit = storage.snapshot();
    await expect(store.preflightContinuation(input)).resolves.toMatchObject({
      ok: true,
      duplicate: true,
    });
    await expect(store.preflightContinuation({
      ...input,
      message: userMessage("message-preflight-answer", "different answer"),
    })).resolves.toEqual({ ok: false, reason: "duplicate-message" });
    expect(storage.snapshot()).toEqual(afterCommit);
  });

  it("rolls back in-memory continuation state when the durable write fails", async () => {
    const storage = memoryNamespace();
    const store = makeStore(storage);
    await store.create({
      handlerId: "profile-a",
      childSessionId: "sub-0e39d008-175594c1-d446-4b24-826e-04bf24be725b",
      contextId: "context-retry",
      message: userMessage("message-retry-start"),
    });
    await store.transition({
      handlerId: "profile-a",
      taskId: "sub-0e39d008-175594c1-d446-4b24-826e-04bf24be725b",
      state: A2ATaskState.INPUT_REQUIRED,
      message: agentMessage("status-retry-waiting", "continue"),
    });

    storage.failNextWrite();
    await expect(store.beginContinuation({
      handlerId: "profile-a",
      taskId: "sub-0e39d008-175594c1-d446-4b24-826e-04bf24be725b",
      contextId: "context-retry",
      message: userMessage("message-retry-answer"),
    })).rejects.toThrow("write failed");

    await expect(store.get("profile-a", "sub-0e39d008-175594c1-d446-4b24-826e-04bf24be725b")).resolves.toMatchObject({
      task: {
        status: { state: A2ATaskState.INPUT_REQUIRED },
        history: expect.not.arrayContaining([
          expect.objectContaining({ messageId: "message-retry-answer" }),
        ]),
      },
    });
    const reloaded = makeStore(storage);
    await expect(reloaded.get("profile-a", "sub-0e39d008-175594c1-d446-4b24-826e-04bf24be725b")).resolves.toMatchObject({
      task: { status: { state: A2ATaskState.INPUT_REQUIRED } },
    });
    await expect(store.beginContinuation({
      handlerId: "profile-a",
      taskId: "sub-0e39d008-175594c1-d446-4b24-826e-04bf24be725b",
      contextId: "context-retry",
      message: userMessage("message-retry-answer"),
    })).resolves.toMatchObject({
      ok: true,
      duplicate: false,
      record: { task: { status: { state: A2ATaskState.WORKING } } },
    });
  });

  it("serializes competing terminal updates and never regresses the winner", async () => {
    const storage = memoryNamespace();
    const store = makeStore(storage);
    await store.create({
      handlerId: "profile-a",
      childSessionId: "sub-e689979b-e26cc995-732e-42bc-8af8-64325610d7df",
      contextId: "context-race",
      message: userMessage("message-race"),
    });
    await store.transition({
      handlerId: "profile-a",
      taskId: "sub-e689979b-e26cc995-732e-42bc-8af8-64325610d7df",
      state: A2ATaskState.WORKING,
    });

    const completed = store.transition({
      handlerId: "profile-a",
      taskId: "sub-e689979b-e26cc995-732e-42bc-8af8-64325610d7df",
      state: A2ATaskState.COMPLETED,
      message: agentMessage("status-race-complete", "done"),
    });
    const canceled = store.transition({
      handlerId: "profile-a",
      taskId: "sub-e689979b-e26cc995-732e-42bc-8af8-64325610d7df",
      state: A2ATaskState.CANCELED,
      message: agentMessage("status-race-cancel", "canceled"),
    });
    const [, cancelResult] = await Promise.all([completed, canceled]);

    expect(cancelResult).toMatchObject({ ok: true, changed: false });
    await expect(store.get("profile-a", "sub-e689979b-e26cc995-732e-42bc-8af8-64325610d7df")).resolves.toMatchObject({
      task: { status: { state: A2ATaskState.COMPLETED } },
    });
  });
});

describe("A2ATaskStore — child session id rule is the host's", () => {
  it("rejects a 257-character id the old 256-cap accepted, accepts a namespaced one", async () => {
    const store = makeStore(memoryNamespace());
    await expect(store.create({
      handlerId: "profile-a",
      childSessionId: "a".repeat(257),
      contextId: "context-long",
      message: userMessage("message-long"),
    })).resolves.toEqual({ ok: false, reason: "invalid-task" });
    // The old cap also let any `[A-Za-z0-9_-]{1,256}` through.
    await expect(store.create({
      handlerId: "profile-a",
      childSessionId: "sub-child-1",
      contextId: "context-free-form",
      message: userMessage("message-free-form"),
    })).resolves.toEqual({ ok: false, reason: "invalid-task" });
    await expect(store.create({
      handlerId: "profile-a",
      childSessionId: "sub-x-12434f55-fbb9-4a54-b1a7-fb9638d8eebd",
      contextId: "context-namespaced",
      message: userMessage("message-namespaced"),
    })).resolves.toMatchObject({ ok: true, created: true });
  });
});
