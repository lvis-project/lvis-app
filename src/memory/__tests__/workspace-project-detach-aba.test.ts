import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const lockControl = vi.hoisted(() => {
  let releaseFirstLock = () => {};
  let signalFirstLockBlocked = () => {};
  let firstLockGate: Promise<void>;
  let firstLockBlocked: Promise<void>;

  const control = {
    calls: 0,
    events: [] as string[],
    targets: [] as string[],
    reset(): void {
      control.calls = 0;
      control.events.length = 0;
      control.targets.length = 0;
      firstLockGate = new Promise<void>((resolve) => {
        releaseFirstLock = resolve;
      });
      firstLockBlocked = new Promise<void>((resolve) => {
        signalFirstLockBlocked = resolve;
      });
    },
    get firstLockGate(): Promise<void> {
      return firstLockGate;
    },
    get firstLockBlocked(): Promise<void> {
      return firstLockBlocked;
    },
    releaseFirstLock(): void {
      releaseFirstLock();
    },
    signalFirstLockBlocked(): void {
      signalFirstLockBlocked();
    },
  };

  control.reset();
  return control;
});

vi.mock("../../lib/with-file-lock.js", () => ({
  withFileLock: vi.fn(async <T>(targetPath: string, callback: () => Promise<T>): Promise<T> => {
    const callNumber = ++lockControl.calls;
    lockControl.targets.push(targetPath);
    if (callNumber === 1) {
      lockControl.events.push("stale-save-lock-requested");
      lockControl.signalFirstLockBlocked();
      await lockControl.firstLockGate;
      lockControl.events.push("stale-save-lock-callback-start");
    }

    const result = await callback();
    if (callNumber === 1) {
      lockControl.events.push("stale-save-lock-callback-complete");
    }
    return result;
  }),
}));

import { MemoryManager } from "../memory-manager.js";

const SESSION_ID = "workspace-detach-aba-wire";
const ROOT = "C:\\Work\\Alpha";
const ORIGIN_SESSION_ID = "wire-aba-origin";

let dir: string;
let memory: MemoryManager;

beforeEach(() => {
  lockControl.reset();
  dir = mkdtempSync(join(tmpdir(), "lvis-workspace-detach-aba-"));
  memory = new MemoryManager({ lvisDir: dir });
});

afterEach(() => {
  memory.closeSearchIndex();
  rmSync(dir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("MemoryManager workspace project detach ABA ordering", () => {
  it("serializes deletion against a detach that already snapshotted metadata", async () => {
    const sessionsDir = join(dir, "sessions");
    const metadataPath = join(sessionsDir, SESSION_ID + ".meta.json");
    const jsonlPath = join(sessionsDir, SESSION_ID + ".jsonl");
    writeFileSync(jsonlPath, JSON.stringify({ role: "user", content: "delete race" }) + "\n");
    writeFileSync(metadataPath, JSON.stringify({
      sessionKind: "main",
      projectRoot: ROOT,
      projectName: "Alpha",
    }));

    const detaching = memory.detachSessionsFromProject(ROOT);
    await lockControl.firstLockBlocked;
    const deleting = memory.deleteSession(SESSION_ID);
    await deleting;

    expect(lockControl.targets).toHaveLength(2);
    expect(lockControl.targets[0]).toBe(lockControl.targets[1]);
    expect(lockControl.targets[0]).toContain(".metadata-locks");
    expect(existsSync(metadataPath)).toBe(false);
    expect(existsSync(jsonlPath)).toBe(false);

    lockControl.releaseFirstLock();
    await expect(detaching).resolves.toBe(0);
    expect(existsSync(metadataPath)).toBe(false);
    expect(existsSync(jsonlPath)).toBe(false);
  });

  it("cancels a wire save whose captured generation predates detach and allow", async () => {
    const metadataPath = join(dir, "sessions", SESSION_ID + ".meta.json");
    const wireMetadata = {
      sessionKind: "subagent" as const,
      projectRoot: ROOT,
      projectName: "Alpha",
      sourceTools: ["noop"],
      originSessionId: ORIGIN_SESSION_ID,
      a2aWireHandlerId: "wire-aba-handler",
      a2aWireInternalOrigin: ORIGIN_SESSION_ID,
      subAgentTitle: "wire ABA",
    };

    lockControl.events.push("stale-save-invoked");
    const staleSave = memory.saveSessionMetadata(SESSION_ID, {
      ...wireMetadata,
      subAgentTaskState: "TASK_STATE_SUBMITTED",
    });

    // Reaching the mocked lock proves saveSessionMetadata already captured the
    // root generation, while the callback (and therefore file creation) has not run.
    await lockControl.firstLockBlocked;
    expect(lockControl.events).toEqual(["stale-save-invoked", "stale-save-lock-requested"]);
    expect(existsSync(metadataPath)).toBe(false);

    lockControl.events.push("detach-start");
    await expect(memory.detachSessionsFromProject(ROOT)).resolves.toBe(0);
    lockControl.events.push("detach-complete");
    expect(existsSync(metadataPath)).toBe(false);

    memory.allowProjectRoot(ROOT);
    lockControl.events.push("allow-complete");
    expect(existsSync(metadataPath)).toBe(false);

    lockControl.releaseFirstLock();
    await staleSave;
    lockControl.events.push("stale-save-complete");

    expect(lockControl.events).toEqual([
      "stale-save-invoked",
      "stale-save-lock-requested",
      "detach-start",
      "detach-complete",
      "allow-complete",
      "stale-save-lock-callback-start",
      "stale-save-lock-callback-complete",
      "stale-save-complete",
    ]);
    expect(memory.loadSessionMetadata(SESSION_ID)).toMatchObject({
      projectRoot: undefined,
      projectName: undefined,
      a2aWireHandlerId: "wire-aba-handler",
      a2aWireInternalOrigin: ORIGIN_SESSION_ID,
      subAgentTaskState: "TASK_STATE_CANCELED",
    });

    await memory.saveSessionMetadata(SESSION_ID, {
      ...wireMetadata,
      subAgentTaskState: "TASK_STATE_COMPLETED",
    });
    expect(memory.loadSessionMetadata(SESSION_ID)).toMatchObject({
      projectRoot: undefined,
      projectName: undefined,
      subAgentTaskState: "TASK_STATE_CANCELED",
    });
  });
});
