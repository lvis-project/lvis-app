/**
 * Boot-time hardware-acceleration reader + resolver tests.
 *
 * Two things have to hold for the Settings toggle to mean anything:
 *   1. The reader looks at the same file `SettingsService` writes, so a choice
 *      made in the UI is the one the next launch sees.
 *   2. "Not chosen" stays distinct from "chosen off". Collapsing them would
 *      turn the GPU on for every first-run Windows user — the exact machines
 *      the platform default exists to protect.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
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

import {
  readPersistedHardwareAccelerationSync,
  resolveHardwareAcceleration,
} from "../persisted-hardware-acceleration.js";
import { SettingsService } from "../../data/settings-store.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

describe("readPersistedHardwareAccelerationSync", () => {
  let userDataPath: string;

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), "persisted-hw-accel-"));
  });

  afterEach(async () => {
    await cleanupTmpDir(userDataPath);
  });

  it("reads back what SettingsService wrote", async () => {
    const service = new SettingsService({ userDataPath });
    // Spread the live block rather than patching the one field: `patch` types
    // `system` as the whole `SystemSettings`, and writing the full block is
    // also what SettingsService itself persists.
    await service.patch({ system: { ...service.get("system"), hardwareAcceleration: false } });

    expect(readPersistedHardwareAccelerationSync(userDataPath)).toBe(false);

    await service.patch({ system: { ...service.get("system"), hardwareAcceleration: true } });

    expect(readPersistedHardwareAccelerationSync(userDataPath)).toBe(true);
  });

  it("reports absence — not off — when there is no settings file", () => {
    expect(readPersistedHardwareAccelerationSync(userDataPath)).toBeUndefined();
  });

  it("reports absence when the field is missing from an existing file", () => {
    writeFileSync(
      join(userDataPath, "lvis-settings.json"),
      JSON.stringify({ system: { appMode: "work" } }),
      "utf-8",
    );

    expect(readPersistedHardwareAccelerationSync(userDataPath)).toBeUndefined();
  });

  it("reports absence for a non-boolean value rather than coercing it", () => {
    writeFileSync(
      join(userDataPath, "lvis-settings.json"),
      JSON.stringify({ system: { hardwareAcceleration: "false" } }),
      "utf-8",
    );

    // The string "false" is truthy — a coercing reader would turn the GPU ON
    // for a profile that says the opposite.
    expect(readPersistedHardwareAccelerationSync(userDataPath)).toBeUndefined();
  });

  it("reports absence for a corrupt settings file instead of throwing", () => {
    writeFileSync(join(userDataPath, "lvis-settings.json"), "{ not json", "utf-8");

    expect(readPersistedHardwareAccelerationSync(userDataPath)).toBeUndefined();
  });
});

describe("resolveHardwareAcceleration", () => {
  it("defaults OFF on Windows and Linux, ON elsewhere", () => {
    const forPlatform = (platform: NodeJS.Platform) =>
      resolveHardwareAcceleration({ setting: undefined, env: {}, platform });

    expect(forPlatform("win32")).toBe(false);
    expect(forPlatform("linux")).toBe(false);
    expect(forPlatform("darwin")).toBe(true);
  });

  it("lets the saved setting override the platform default in both directions", () => {
    expect(
      resolveHardwareAcceleration({ setting: true, env: {}, platform: "win32" }),
    ).toBe(true);
    expect(
      resolveHardwareAcceleration({ setting: false, env: {}, platform: "darwin" }),
    ).toBe(false);
  });

  it("lets LVIS_KEEP_GPU=1 win over a saved off", () => {
    expect(
      resolveHardwareAcceleration({ setting: false, env: { LVIS_KEEP_GPU: "1" }, platform: "win32" }),
    ).toBe(true);
  });

  it("treats any other LVIS_KEEP_GPU value as unset, not as off", () => {
    // "0" must not read as "force off": the variable's only documented job is
    // forcing the GPU on, and a user who saved ON would otherwise find it
    // silently disabled by a stale shell export.
    expect(
      resolveHardwareAcceleration({ setting: true, env: { LVIS_KEEP_GPU: "0" }, platform: "win32" }),
    ).toBe(true);
    expect(
      resolveHardwareAcceleration({ setting: undefined, env: { LVIS_KEEP_GPU: "true" }, platform: "darwin" }),
    ).toBe(true);
  });
});
