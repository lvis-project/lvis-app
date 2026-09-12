import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsService } from "../../../data/settings-store.js";
import { unavailableSecretEncryption } from "../../../__tests__/support/host-runtime.js";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";
import { CHANNELS } from "../../../contract/app-contract.js";
import { SETTINGS } from "../../../shared/ipc-channels.js";
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

describe("thinking budget settings IPC", () => {
  it.each([[32_000, 16_000], [16_000, 8_000], [32_001, 32_000], [2_000, 1_999]])(
    "normalizes an oversized update with output %i before persistence and broadcast", async (outputTokenLimit, expected) => {
      userDataPath = mkdtempSync(join(tmpdir(), "thinking-settings-ipc-"));
      const settingsService = new SettingsService({ userDataPath, encryption: unavailableSecretEncryption });
      const send = vi.fn();
      const { registerSettingsHandlers } = await import("../settings.js");
      registerSettingsHandlers({
        settingsService,
        conversationLoop: { refreshProvider: vi.fn() },
        auditLogger: { log: vi.fn() },
        getAppWindows: () => [{ isDestroyed: () => false, webContents: { isDestroyed: () => false, send } }],
        singleHopNetworkFetch: vi.fn(),
      } as never);

      await invoke(CHANNELS.settings.update, {
        llm: { vendors: { openai: { outputTokenLimit, thinkingBudgetTokens: 32_000 } } },
      });
      expect(settingsService.get("llm").vendors.openai).toMatchObject({ outputTokenLimit, thinkingBudgetTokens: expected });
      expect(send).toHaveBeenCalledWith(SETTINGS.updated, expect.objectContaining({
        llm: expect.objectContaining({ vendors: expect.objectContaining({
          openai: expect.objectContaining({ outputTokenLimit, thinkingBudgetTokens: expected }),
        }) }),
      }));
      const reloaded = new SettingsService({ userDataPath, encryption: unavailableSecretEncryption });
      expect(reloaded.get("llm").vendors.openai).toEqual(settingsService.get("llm").vendors.openai);
    },
  );
});
