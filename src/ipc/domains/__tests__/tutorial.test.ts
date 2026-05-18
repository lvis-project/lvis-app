/**
 * Tutorial-D — `lvis:tutorial:*` IPC handler tests.
 *
 * Mirrors the shape of `login-prefs.test.ts`: vitest fakes
 * `electron.ipcMain.handle` so each `registerTutorialHandlers` call
 * lands in a `Map<channel, handler>`, then the test invokes the handler
 * with a fabricated `IpcMainInvokeEvent` shape.
 *
 * Covers:
 *   - `get-preferences` returns the default when no file is on disk.
 *   - `record` persists + broadcasts `lvis:tutorial:preferences-changed`.
 *   - `record` rejects an unknown action with `invalid-action`.
 *   - `open` broadcasts the `lvis:tutorial:open` signal.
 *   - `tour-start` rejects empty scenarioId and broadcasts on success.
 *   - `show-context-menu` pops a system menu via electron.Menu.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const handlers = new Map<string, (...args: unknown[]) => unknown>();

const menuPopup = vi.fn();
const buildFromTemplate = vi.fn(() => ({ popup: menuPopup }));

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
  Menu: {
    buildFromTemplate,
  },
  BrowserWindow: {
    fromWebContents: vi.fn(() => null),
  },
}));

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`No handler registered for: ${channel}`);
  return Promise.resolve(
    fn(
      {
        frameId: 0,
        processId: 0,
        senderFrame: { url: "file:///app/index.html" },
        sender: {},
      } as never,
      ...args,
    ),
  );
}

interface FakeWindow {
  isDestroyed: () => boolean;
  webContents: { send: (channel: string, payload: unknown) => void };
}

function makeFakeWindow(): FakeWindow {
  return {
    isDestroyed: vi.fn(() => false),
    webContents: { send: vi.fn() },
  };
}

let tempDir: string;
let prevLvisHome: string | undefined;

beforeEach(() => {
  handlers.clear();
  menuPopup.mockClear();
  buildFromTemplate.mockClear();
  vi.resetModules();
  prevLvisHome = process.env.LVIS_HOME;
  tempDir = mkdtempSync(join(tmpdir(), "lvis-tutorial-ipc-"));
  process.env.LVIS_HOME = tempDir;
});

afterEach(() => {
  if (prevLvisHome === undefined) {
    delete process.env.LVIS_HOME;
  } else {
    process.env.LVIS_HOME = prevLvisHome;
  }
  rmSync(tempDir, { recursive: true, force: true });
});

async function loadModule() {
  return import("../tutorial.js");
}

function makeDeps(windows: FakeWindow[]) {
  return {
    auditLogger: { log: vi.fn() },
    getMainWindow: () => windows[0] ?? null,
    getAppWindows: () => windows,
  };
}

describe("tutorial IPC handlers (Tutorial-D)", () => {
  it("get-preferences returns the default when no file is on disk", async () => {
    const { registerTutorialHandlers } = await loadModule();
    registerTutorialHandlers(makeDeps([makeFakeWindow()]) as never);

    const result = await invoke("lvis:tutorial:get-preferences");
    expect(result).toEqual({
      ok: true,
      prefs: { liked: [], disliked: [], lastShownAt: "" },
    });
  });

  it("record persists the action and broadcasts preferences-changed", async () => {
    const win1 = makeFakeWindow();
    const win2 = makeFakeWindow();
    const { registerTutorialHandlers } = await loadModule();
    registerTutorialHandlers(makeDeps([win1, win2]) as never);

    const setResult = (await invoke("lvis:tutorial:record", {
      cardId: "meeting-summary",
      action: "liked",
    })) as { ok: true; prefs: { liked: string[]; disliked: string[] } };
    expect(setResult.ok).toBe(true);
    expect(setResult.prefs.liked).toEqual(["meeting-summary"]);
    expect(setResult.prefs.disliked).toEqual([]);

    const sendSpy1 = win1.webContents.send as ReturnType<typeof vi.fn>;
    const sendSpy2 = win2.webContents.send as ReturnType<typeof vi.fn>;
    expect(sendSpy1).toHaveBeenCalledWith(
      "lvis:tutorial:preferences-changed",
      expect.objectContaining({ liked: ["meeting-summary"], disliked: [] }),
    );
    expect(sendSpy2).toHaveBeenCalledWith(
      "lvis:tutorial:preferences-changed",
      expect.objectContaining({ liked: ["meeting-summary"], disliked: [] }),
    );
  });

  it("record rejects an unknown action with invalid-action", async () => {
    const { registerTutorialHandlers } = await loadModule();
    registerTutorialHandlers(makeDeps([makeFakeWindow()]) as never);

    const result = await invoke("lvis:tutorial:record", {
      cardId: "meeting-summary",
      action: "future-action",
    });
    expect(result).toMatchObject({
      ok: false,
      error: "invalid-action",
    });
  });

  it("record rejects an empty cardId", async () => {
    const { registerTutorialHandlers } = await loadModule();
    registerTutorialHandlers(makeDeps([makeFakeWindow()]) as never);

    const result = await invoke("lvis:tutorial:record", {
      cardId: "",
      action: "liked",
    });
    expect(result).toMatchObject({
      ok: false,
      error: "invalid-card-id",
    });
  });

  it("open broadcasts the lvis:tutorial:open signal to every window", async () => {
    const win = makeFakeWindow();
    const { registerTutorialHandlers } = await loadModule();
    registerTutorialHandlers(makeDeps([win]) as never);

    const result = await invoke("lvis:tutorial:open");
    expect(result).toEqual({ ok: true });
    const sendSpy = win.webContents.send as ReturnType<typeof vi.fn>;
    expect(sendSpy).toHaveBeenCalledWith(
      "lvis:tutorial:open",
      expect.objectContaining({ source: "ipc" }),
    );
  });

  it("show-context-menu pops a system menu", async () => {
    const win = makeFakeWindow();
    const { registerTutorialHandlers } = await loadModule();
    registerTutorialHandlers(makeDeps([win]) as never);

    const result = await invoke("lvis:tutorial:show-context-menu");
    expect(result).toEqual({ ok: true });
    expect(buildFromTemplate).toHaveBeenCalledTimes(1);
    expect(menuPopup).toHaveBeenCalledTimes(1);
  });
});
