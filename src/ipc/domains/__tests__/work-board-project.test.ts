import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORK_BOARD } from "../../../shared/ipc-channels.js";
import { registerWorkBoardHandlers } from "../work-board.js";
import type { IpcDeps } from "../../types.js";
import type { WorkItemResolved } from "../../../main/work-board-store.js";

const ipc = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    handlers,
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  };
});

vi.mock("electron", () => {
  const electron = {
    ipcMain: {
      handle: ipc.handle,
    },
  };
  return { ...electron, default: electron };
});

vi.mock("../../gated.js", () => ({
  validateSender: () => true,
  UNAUTHORIZED_FRAME: { ok: false, error: "unauthorized-frame" },
  auditUnauthorized: vi.fn(),
}));

let oldHome: string | undefined;
let oldCwd: string;
let root: string;

function registeredHandler<T extends (...args: unknown[]) => unknown>(channel: string): T {
  const handler = ipc.handlers.get(channel);
  if (!handler) throw new Error(`missing handler for ${channel}`);
  return handler as T;
}

function deniedItem(projectRoot: string): WorkItemResolved {
  return {
    id: 7,
    title: "secret",
    status: "planned",
    status_resolved: "planned",
    priority: "medium",
    projectRoot,
    projectName: "secret",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

beforeEach(() => {
  oldHome = process.env.LVIS_HOME;
  oldCwd = process.cwd();
  root = mkdtempSync(join(tmpdir(), "lvis-work-board-project-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  process.env.LVIS_HOME = root;
  process.chdir(workspace);
  ipc.handlers.clear();
  ipc.handle.mockClear();
});

afterEach(() => {
  process.chdir(oldCwd);
  if (oldHome === undefined) delete process.env.LVIS_HOME;
  else process.env.LVIS_HOME = oldHome;
  rmSync(root, { recursive: true, force: true });
});

describe("work-board project authorization", () => {
  it("does not expose or mutate items from unauthorized stored project roots", async () => {
    const item = deniedItem(join(root, "denied-project"));
    const store = {
      get: vi.fn(async () => ({ status: "found", itemId: item.id, item })),
      update: vi.fn(async () => ({ status: "updated", itemId: item.id, item })),
      remove: vi.fn(async () => ({ status: "deleted", itemId: item.id })),
    };
    const engine = {
      runItem: vi.fn(async () => ({ status: "completed", output: "done" })),
    };
    registerWorkBoardHandlers({
      workBoardStore: store,
      workBoardEngine: engine,
      auditLogger: { log: vi.fn() },
      getMainWindow: () => null,
      getAppWindows: () => [],
    } as unknown as IpcDeps);

    await expect(registeredHandler(WORK_BOARD.get)({}, item.id)).resolves.toEqual({
      status: "not_found",
      itemId: item.id,
    });
    await expect(registeredHandler(WORK_BOARD.update)({}, item.id, { title: "changed" })).resolves.toEqual({
      status: "not_found",
      itemId: item.id,
    });
    await expect(registeredHandler(WORK_BOARD.remove)({}, item.id)).resolves.toEqual({
      status: "not_found",
      itemId: item.id,
    });
    await expect(registeredHandler(WORK_BOARD.run)({}, item.id)).resolves.toEqual({
      status: "not_found",
    });
    await expect(registeredHandler(WORK_BOARD.runTranscript)({}, item.id, "run-1")).resolves.toEqual({
      events: [],
    });
    expect(store.update).not.toHaveBeenCalled();
    expect(store.remove).not.toHaveBeenCalled();
    expect(engine.runItem).not.toHaveBeenCalled();
  });

  it("rejects creating an item for an unauthorized explicit project root", async () => {
    const store = {
      create: vi.fn(async () => ({ status: "created", itemId: 1 })),
    };
    registerWorkBoardHandlers({
      workBoardStore: store,
      auditLogger: { log: vi.fn() },
      getMainWindow: () => null,
      getAppWindows: () => [],
    } as unknown as IpcDeps);

    await expect(registeredHandler(WORK_BOARD.add)({}, {
      title: "secret",
      projectRoot: join(root, "denied-project"),
      projectName: "secret",
    })).resolves.toEqual({
      status: "invalid",
      reason: "project root is not authorized",
    });
    expect(store.create).not.toHaveBeenCalled();
  });
});
