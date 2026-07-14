import { describe, expect, it, vi } from "vitest";
import {
  A2ARole,
  A2ATaskState,
  type A2AMessage,
} from "../../shared/a2a.js";
import { A2ATaskStore } from "../a2a-task-store.js";

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

function clock() {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 6, 14, 0, 0, tick++)).toISOString();
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
      childSessionId: "sub-child-1",
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
    const untouched = await store.get("profile-a", "sub-child-1");
    expect(untouched?.task.history?.[0]?.parts[0]).not.toEqual({ text: "mutated" });

    const reloaded = makeStore(storage);
    await expect(reloaded.get("profile-a", "sub-child-1")).resolves.toMatchObject({
      task: {
        id: "sub-child-1",
        status: { state: A2ATaskState.SUBMITTED },
      },
    });
  });

  it("quarantines every record that shares a child identity across handlers", async () => {
    const storage = memoryNamespace();
    const first = makeStore(storage);
    await first.create({
      handlerId: "profile-a",
      childSessionId: "sub-duplicate",
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

    await expect(reloaded.get("profile-a", "sub-duplicate")).resolves.toBeNull();
    await expect(reloaded.get("profile-b", "sub-duplicate")).resolves.toBeNull();
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
      childSessionId: "sub-live-owner",
      contextId: "context-owner",
      message: userMessage("message-owner"),
    })).resolves.toMatchObject({ ok: true, created: true });

    await expect(store.create({
      handlerId: "profile-b",
      childSessionId: "sub-live-owner",
      contextId: "context-intruder",
      message: userMessage("message-intruder"),
    })).resolves.toEqual({ ok: false, reason: "child-session-conflict" });

    await expect(store.get("profile-a", "sub-live-owner")).resolves.not.toBeNull();
    await expect(store.get("profile-b", "sub-live-owner")).resolves.toBeNull();
    await expect(store.lookupTask("profile-a", "sub-live-owner")).resolves.toMatchObject({
      ok: true,
      record: { handlerId: "profile-a" },
    });
    await expect(store.lookupTask("profile-b", "sub-live-owner")).resolves.toEqual({
      ok: false,
      reason: "cross-origin",
    });
    await expect(store.lookupTask("profile-b", "sub-unknown")).resolves.toEqual({
      ok: false,
      reason: "unknown-task",
    });
    await expect(store.preflightContinuation({
      handlerId: "profile-b",
      taskId: "sub-live-owner",
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
      childSessionId: "sub-active",
      contextId: "context-a",
      message: userMessage("message-active"),
    });
    await store.transition({
      handlerId: "profile-a",
      taskId: "sub-active",
      state: A2ATaskState.WORKING,
    });
    await store.create({
      handlerId: "profile-a",
      childSessionId: "sub-waiting",
      contextId: "context-b",
      message: userMessage("message-waiting"),
    });
    await store.transition({
      handlerId: "profile-a",
      taskId: "sub-waiting",
      state: A2ATaskState.INPUT_REQUIRED,
      message: agentMessage("status-waiting", "continue"),
    });

    await expect(store.create({
      handlerId: "profile-a",
      childSessionId: "sub-overflow",
      contextId: "context-c",
      message: userMessage("message-overflow"),
    })).resolves.toEqual({ ok: false, reason: "capacity-exceeded" });

    await store.transition({
      handlerId: "profile-a",
      taskId: "sub-active",
      state: A2ATaskState.COMPLETED,
      message: agentMessage("status-completed", "done"),
    });
    await expect(store.create({
      handlerId: "profile-a",
      childSessionId: "sub-replacement",
      contextId: "context-d",
      message: userMessage("message-replacement"),
    })).resolves.toMatchObject({ ok: true, created: true });
    await expect(store.get("profile-a", "sub-active")).resolves.toBeNull();
    await expect(store.get("profile-a", "sub-waiting")).resolves.not.toBeNull();
  });

  it("never evicts another handler's tasks when the global capacity is full", async () => {
    const storage = memoryNamespace();
    const store = makeStore(storage, { maxTasks: 2 });
    await store.create({
      handlerId: "profile-a",
      childSessionId: "sub-profile-a-old",
      contextId: "context-a-old",
      message: userMessage("message-profile-a-old"),
    });
    await store.transition({
      handlerId: "profile-a",
      taskId: "sub-profile-a-old",
      state: A2ATaskState.COMPLETED,
    });
    await store.create({
      handlerId: "profile-b",
      childSessionId: "sub-profile-b-active",
      contextId: "context-b",
      message: userMessage("message-profile-b"),
    });

    await expect(store.create({
      handlerId: "profile-c",
      childSessionId: "sub-profile-c-new",
      contextId: "context-c-new",
      message: userMessage("message-profile-c-new"),
    })).resolves.toEqual({ ok: false, reason: "capacity-exceeded" });
    await expect(store.get("profile-a", "sub-profile-a-old")).resolves.not.toBeNull();

    await expect(store.create({
      handlerId: "profile-a",
      childSessionId: "sub-profile-a-new",
      contextId: "context-a-new",
      message: userMessage("message-profile-a-new"),
    })).resolves.toMatchObject({ ok: true, created: true });
    await expect(store.get("profile-a", "sub-profile-a-old")).resolves.toBeNull();
    await expect(store.get("profile-b", "sub-profile-b-active")).resolves.not.toBeNull();
  });

  it("reserves initial admission before consent and releases the single slot", async () => {
    const storage = memoryNamespace();
    const store = makeStore(storage, { maxTasks: 1 });
    await store.create({
      handlerId: "profile-a",
      childSessionId: "sub-admission-existing",
      contextId: "context-admission-existing",
      message: userMessage("message-admission-existing"),
    });
    await store.transition({
      handlerId: "profile-a",
      taskId: "sub-admission-existing",
      state: A2ATaskState.WORKING,
    });

    await expect(store.reserveInitialTaskAdmission({
      handlerId: "profile-a",
      message: userMessage("message-admission-full"),
    })).resolves.toEqual({ ok: false, reason: "capacity-exceeded" });

    await store.transition({
      handlerId: "profile-a",
      taskId: "sub-admission-existing",
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
      childSessionId: "sub-preflight",
      contextId: "context-preflight",
      message: userMessage("message-preflight-start"),
    });
    await store.transition({
      handlerId: "profile-a",
      taskId: "sub-preflight",
      state: A2ATaskState.INPUT_REQUIRED,
      message: agentMessage("status-preflight-waiting", "continue"),
    });
    const input = {
      handlerId: "profile-a",
      taskId: "sub-preflight",
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
    await expect(store.get("profile-a", "sub-preflight")).resolves.toMatchObject({
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
      childSessionId: "sub-retry",
      contextId: "context-retry",
      message: userMessage("message-retry-start"),
    });
    await store.transition({
      handlerId: "profile-a",
      taskId: "sub-retry",
      state: A2ATaskState.INPUT_REQUIRED,
      message: agentMessage("status-retry-waiting", "continue"),
    });

    storage.failNextWrite();
    await expect(store.beginContinuation({
      handlerId: "profile-a",
      taskId: "sub-retry",
      contextId: "context-retry",
      message: userMessage("message-retry-answer"),
    })).rejects.toThrow("write failed");

    await expect(store.get("profile-a", "sub-retry")).resolves.toMatchObject({
      task: {
        status: { state: A2ATaskState.INPUT_REQUIRED },
        history: expect.not.arrayContaining([
          expect.objectContaining({ messageId: "message-retry-answer" }),
        ]),
      },
    });
    const reloaded = makeStore(storage);
    await expect(reloaded.get("profile-a", "sub-retry")).resolves.toMatchObject({
      task: { status: { state: A2ATaskState.INPUT_REQUIRED } },
    });
    await expect(store.beginContinuation({
      handlerId: "profile-a",
      taskId: "sub-retry",
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
      childSessionId: "sub-race",
      contextId: "context-race",
      message: userMessage("message-race"),
    });
    await store.transition({
      handlerId: "profile-a",
      taskId: "sub-race",
      state: A2ATaskState.WORKING,
    });

    const completed = store.transition({
      handlerId: "profile-a",
      taskId: "sub-race",
      state: A2ATaskState.COMPLETED,
      message: agentMessage("status-race-complete", "done"),
    });
    const canceled = store.transition({
      handlerId: "profile-a",
      taskId: "sub-race",
      state: A2ATaskState.CANCELED,
      message: agentMessage("status-race-cancel", "canceled"),
    });
    const [, cancelResult] = await Promise.all([completed, canceled]);

    expect(cancelResult).toMatchObject({ ok: true, changed: false });
    await expect(store.get("profile-a", "sub-race")).resolves.toMatchObject({
      task: { status: { state: A2ATaskState.COMPLETED } },
    });
  });
});
