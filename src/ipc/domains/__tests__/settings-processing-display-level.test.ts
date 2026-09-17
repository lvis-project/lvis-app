import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsService } from "../../../data/settings-store.js";
import { unavailableSecretEncryption } from "../../../__tests__/support/host-runtime.js";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";
import { CHANNELS } from "../../../contract/app-contract.js";
import { makeAppIpcInvoker } from "./test-helpers.js";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler)) },
}));

const invoke = makeAppIpcInvoker(handlers);
let userDataPath: string;

afterEach(async () => {
  handlers.clear();
  await cleanupTmpDir(userDataPath);
});

describe("processing display level settings IPC", () => {
  it("rejects an invalid live patch without replacing the persisted display preference", async () => {
    userDataPath = mkdtempSync(join(tmpdir(), "processing-display-settings-ipc-"));
    const settingsService = new SettingsService({
      userDataPath,
      encryption: unavailableSecretEncryption,
    });
    await settingsService.patch({ chat: { processingDisplayLevel: "tools" } });
    const send = vi.fn();
    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers({
      settingsService,
      conversationLoop: { refreshProvider: vi.fn() },
      auditLogger: { log: vi.fn() },
      getAppWindows: () => [{ isDestroyed: () => false, webContents: { isDestroyed: () => false, send } }],
      singleHopNetworkFetch: vi.fn(),
    } as never);

    const result = await invoke(CHANNELS.settings.update, {
      chat: { processingDisplayLevel: "everything" },
    });

    expect(result).toEqual({
      ok: false,
      error: "invalid-processing-display-level",
      message: "chat.processingDisplayLevel must be one of: tools, reasoning, full.",
    });
    expect(settingsService.get("chat").processingDisplayLevel).toBe("tools");
    expect(send).not.toHaveBeenCalled();
    expect(new SettingsService({ userDataPath, encryption: unavailableSecretEncryption })
      .get("chat").processingDisplayLevel).toBe("tools");
  });
});
