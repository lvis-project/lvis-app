/**
 * Tutorial-A — `lvis:login-prefs:{get,set}` IPC handler tests.
 *
 * Mirrors the shape of `auth-login-mockup.test.ts`: vitest fakes
 * `electron.ipcMain.handle` so each `registerLoginPrefsHandlers` call
 * lands in a `Map<channel, handler>`, then the test invokes the handler
 * with a fabricated `IpcMainInvokeEvent` shape.
 *
 * Covers:
 *   - `get` returns the default when no file is on disk.
 *   - `set` persists the variant + broadcasts `lvis:login-prefs:changed`
 *     to every BrowserWindow returned by `getAppWindows`.
 *   - `set` rejects an unknown variant with `invalid-login-variant`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
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
  vi.resetModules();
  prevLvisHome = process.env.LVIS_HOME;
  tempDir = mkdtempSync(join(tmpdir(), "lvis-login-prefs-ipc-"));
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
  return import("../login-prefs.js");
}

function makeDeps(windows: FakeWindow[]) {
  return {
    auditLogger: { log: vi.fn() },
    getMainWindow: () => windows[0] ?? null,
    getAppWindows: () => windows,
  };
}

describe("login-prefs IPC handlers (Tutorial-A)", () => {
  it("get returns the default when no file is on disk", async () => {
    const { registerLoginPrefsHandlers } = await loadModule();
    registerLoginPrefsHandlers(makeDeps([makeFakeWindow()]) as never);

    const result = await invoke("lvis:login-prefs:get");
    expect(result).toEqual({
      ok: true,
      prefs: { loginVariant: "conversational" },
    });
  });

  it("set persists the variant and broadcasts to every window", async () => {
    const win1 = makeFakeWindow();
    const win2 = makeFakeWindow();
    const { registerLoginPrefsHandlers } = await loadModule();
    registerLoginPrefsHandlers(makeDeps([win1, win2]) as never);

    const setResult = await invoke("lvis:login-prefs:set", {
      loginVariant: "cli-agent",
    });
    expect(setResult).toEqual({
      ok: true,
      prefs: { loginVariant: "cli-agent" },
    });

    const sendSpy1 = win1.webContents.send as ReturnType<typeof vi.fn>;
    const sendSpy2 = win2.webContents.send as ReturnType<typeof vi.fn>;
    expect(sendSpy1).toHaveBeenCalledWith("lvis:login-prefs:changed", {
      loginVariant: "cli-agent",
    });
    expect(sendSpy2).toHaveBeenCalledWith("lvis:login-prefs:changed", {
      loginVariant: "cli-agent",
    });

    // A follow-up `get` returns the persisted value.
    const getResult = await invoke("lvis:login-prefs:get");
    expect(getResult).toEqual({
      ok: true,
      prefs: { loginVariant: "cli-agent" },
    });
  });

  it("set rejects an unknown variant with invalid-login-variant", async () => {
    const { registerLoginPrefsHandlers } = await loadModule();
    registerLoginPrefsHandlers(makeDeps([makeFakeWindow()]) as never);

    const result = await invoke("lvis:login-prefs:set", {
      loginVariant: "future-variant",
    });
    expect(result).toEqual({
      ok: false,
      error: "invalid-login-variant",
      message: "loginVariant must be one of: conversational, cli-agent",
    });
  });

  it("set with a missing loginVariant rejects (no-op write)", async () => {
    const { registerLoginPrefsHandlers } = await loadModule();
    registerLoginPrefsHandlers(makeDeps([makeFakeWindow()]) as never);

    const result = await invoke("lvis:login-prefs:set", {});
    expect(result).toMatchObject({ ok: false, error: "invalid-login-variant" });
  });
});
