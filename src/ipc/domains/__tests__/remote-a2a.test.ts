import { beforeEach, describe, expect, it, vi } from "vitest";
import { CHANNELS } from "../../../contract/app-contract.js";
import { invokeFileIpcHandler } from "./test-helpers.js";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const USER_INTENT = { inputOrigin: "user-keyboard", userActivation: true };

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  },
}));

function rejectingController({ rejectReads = false } = {}) {
  const reject = vi.fn(async () => {
    throw new Error("secret-provider-detail-must-not-cross-ipc");
  });
  return {
    listTargets: vi.fn(() => {
      if (rejectReads) throw new Error("secret-target-detail-must-not-cross-ipc");
      return [];
    }),
    status: vi.fn(() => {
      if (rejectReads) throw new Error("secret-status-detail-must-not-cross-ipc");
      return { state: "idle", updatedAt: "2026-07-16T00:00:00.000Z" };
    }),
    send: reject,
    get: reject,
    resume: reject,
    cancel: reject,
    replay: reject,
  };
}

async function setup(options: { rejectReads?: boolean } = {}) {
  handlers.clear();
  vi.clearAllMocks();
  const controller = rejectingController(options);
  const { registerRemoteA2AHandlers } = await import("../remote-a2a.js");
  registerRemoteA2AHandlers({
    auditLogger: { log: vi.fn() },
    remoteA2AActionController: controller,
  } as never);
  return controller;
}

beforeEach(() => {
  handlers.clear();
});

describe("remote A2A IPC rejection boundary", () => {
  it.each([CHANNELS.remoteA2a.targets, CHANNELS.remoteA2a.status])(
    "returns the stable code when read channel %s throws",
    async (channel) => {
      await setup({ rejectReads: true });

      await expect(invokeFileIpcHandler(handlers, channel)).resolves.toEqual({
        ok: false,
        error: "a2a-remote-operation-rejected",
      });
    },
  );

  it("returns a stable code when send throws without leaking the internal error", async () => {
    await setup();

    const result = await invokeFileIpcHandler(handlers, CHANNELS.remoteA2a.send, {
      intentToken: USER_INTENT,
      targetAgentId: 7,
      userIntent: "send this task",
    });

    expect(result).toEqual({ ok: false, error: "a2a-remote-operation-rejected" });
    expect(JSON.stringify(result)).not.toContain("secret-provider-detail");
  });

  it("returns the same stable code when task lookup throws", async () => {
    await setup();

    await expect(invokeFileIpcHandler(handlers, CHANNELS.remoteA2a.task, {
      taskHandle: "task_handle_123456",
    })).resolves.toEqual({ ok: false, error: "a2a-remote-operation-rejected" });
  });

  it.each([
    ["resume", { userIntent: "continue" }],
    ["cancel", {}],
    ["replay", {}],
  ] as const)("returns the same stable code when %s throws", async (action, extra) => {
    await setup();

    await expect(invokeFileIpcHandler(handlers, CHANNELS.remoteA2a.action, {
      intentToken: USER_INTENT,
      action,
      taskHandle: "task_handle_123456",
      ...extra,
    })).resolves.toEqual({ ok: false, error: "a2a-remote-operation-rejected" });
  });
});
