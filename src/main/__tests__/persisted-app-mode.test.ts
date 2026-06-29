/**
 * Boot-time sync appMode reader tests.
 *
 * Guards the writer/reader path agreement: `SettingsService` (writer) persists
 * `system.appMode` to `<userData>/lvis-settings.json`, and
 * `readPersistedAppModeSync` (reader, called before the async bootstrap assigns
 * `services`) must read from the same file so a mode saved via the UI is the
 * one restored on the next launch. Same regression class as the
 * manual-host-resolver reader/writer-path bug.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mockedElectron = vi.hoisted(() => ({
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
}));

vi.mock("electron", () => ({
  safeStorage: mockedElectron.safeStorage,
}));

import { readPersistedAppModeSync } from "../persisted-app-mode.js";
import { SettingsService } from "../../data/settings-store.js";

describe("readPersistedAppModeSync", () => {
  let userDataPath: string;

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), "persisted-app-mode-"));
    mockedElectron.safeStorage.isEncryptionAvailable.mockReturnValue(false);
  });

  afterEach(() => {
    vi.clearAllMocks();
    rmSync(userDataPath, { recursive: true, force: true });
  });

  it("defaults to 'work' when no settings file exists", () => {
    expect(readPersistedAppModeSync(userDataPath)).toBe("work");
  });

  it("reads back a 'chat' mode the SettingsService persisted (writer/reader agree on path)", async () => {
    const service = new SettingsService({ userDataPath });
    await service.patch({ system: { appMode: "chat" } });
    expect(readPersistedAppModeSync(userDataPath)).toBe("chat");
  });

  it("reads back a 'work' mode the SettingsService persisted", async () => {
    const service = new SettingsService({ userDataPath });
    await service.patch({ system: { appMode: "chat" } });
    await service.patch({ system: { appMode: "work" } });
    expect(readPersistedAppModeSync(userDataPath)).toBe("work");
  });

  it("normalizes legacy 'action' on disk to 'work'", () => {
    writeFileSync(
      join(userDataPath, "lvis-settings.json"),
      JSON.stringify({ system: { appMode: "action" } }),
      "utf-8",
    );
    expect(readPersistedAppModeSync(userDataPath)).toBe("work");
  });

  it("defaults to 'work' on a malformed appMode value", () => {
    writeFileSync(
      join(userDataPath, "lvis-settings.json"),
      JSON.stringify({ system: { appMode: "not-a-mode" } }),
      "utf-8",
    );
    expect(readPersistedAppModeSync(userDataPath)).toBe("work");
  });

  it("defaults to 'work' on a corrupt (non-JSON) settings file", () => {
    writeFileSync(join(userDataPath, "lvis-settings.json"), "{ not json", "utf-8");
    expect(readPersistedAppModeSync(userDataPath)).toBe("work");
  });

  it("defaults to 'work' when system block is absent (legacy settings.json)", () => {
    writeFileSync(
      join(userDataPath, "lvis-settings.json"),
      JSON.stringify({ marketplace: { backend: "real-cloud" } }),
      "utf-8",
    );
    expect(readPersistedAppModeSync(userDataPath)).toBe("work");
  });
});
