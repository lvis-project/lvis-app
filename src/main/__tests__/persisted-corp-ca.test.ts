/**
 * The boot-time corporate-CA read, and the shared synchronous settings parse
 * underneath it.
 *
 * The whole point of these settings is that a packaged app has no environment
 * to set, so the one thing that must hold is the round trip: what the Settings
 * UI writes through `SettingsService` is what the next launch reads back here,
 * before `bootstrap()` exists to ask.
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

import { readPersistedCorpCaConfigSync } from "../persisted-corp-ca.js";
import {
  readPersistedSystemBooleanSync,
  readPersistedSystemSectionSync,
  readPersistedSystemStringSync,
} from "../persisted-settings-sync.js";
import { DEFAULT_CORP_CA_COMMON_NAME } from "../../shared/corp-ca-common-name.js";
import { SettingsService } from "../../data/settings-store.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

describe("readPersistedCorpCaConfigSync", () => {
  let userDataPath: string;

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), "persisted-corp-ca-"));
  });

  afterEach(async () => {
    await cleanupTmpDir(userDataPath);
  });

  it("reads back what the Settings UI wrote", async () => {
    const service = new SettingsService({ userDataPath });
    await service.patch({
      system: {
        ...service.get("system"),
        corpCaEnabled: false,
        corpCaCommonName: "Acme Root CA",
        corpCaDebugLog: true,
      },
    });

    expect(readPersistedCorpCaConfigSync(userDataPath, {})).toEqual({
      enabled: false,
      commonName: "Acme Root CA",
      debugLog: true,
    });
  });

  it("uses the defaults on a first launch, before any settings file exists", () => {
    expect(readPersistedCorpCaConfigSync(userDataPath, {})).toEqual({
      enabled: true,
      commonName: DEFAULT_CORP_CA_COMMON_NAME,
      debugLog: false,
    });
  });

  it("still lets a deployment launcher pin the values through the environment", () => {
    // A managed deployment sets these before the app starts; the profile must
    // not quietly win over them.
    writeFileSync(
      join(userDataPath, "lvis-settings.json"),
      JSON.stringify({ system: { corpCaEnabled: true, corpCaCommonName: "Acme Root CA" } }),
      "utf-8",
    );

    expect(
      readPersistedCorpCaConfigSync(userDataPath, {
        LVIS_SKIP_CORP_CA: "1",
        LVIS_CORP_CA_CN: "Managed Root CA",
      }),
    ).toEqual({ enabled: false, commonName: "Managed Root CA", debugLog: false });
  });
});

describe("persisted settings sync readers", () => {
  let userDataPath: string;

  const write = (json: string): void => {
    writeFileSync(join(userDataPath, "lvis-settings.json"), json, "utf-8");
  };

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), "persisted-sync-"));
  });

  afterEach(async () => {
    await cleanupTmpDir(userDataPath);
  });

  it("returns undefined rather than a value when the file cannot be used", () => {
    // No file at all — the first launch.
    expect(readPersistedSystemSectionSync(userDataPath)).toBeUndefined();
    // Truncated by a power cut mid-write; the async path reports this later.
    write('{"system": {"corpCa');
    expect(readPersistedSystemSectionSync(userDataPath)).toBeUndefined();
    // Valid JSON, but nothing this reader can use.
    write('{"system": "corrupted"}');
    expect(readPersistedSystemSectionSync(userDataPath)).toBeUndefined();
    write("{}");
    expect(readPersistedSystemSectionSync(userDataPath)).toBeUndefined();
  });

  it("keeps 'not chosen' distinct from 'chosen off'", () => {
    // Collapsing these is what turns a boot default into a silent override of
    // the user's choice, in whichever direction the default happens to point.
    write('{"system": {"corpCaEnabled": false}}');
    expect(readPersistedSystemBooleanSync(userDataPath, "corpCaEnabled")).toBe(false);
    expect(readPersistedSystemBooleanSync(userDataPath, "corpCaDebugLog")).toBeUndefined();
  });

  it("ignores a value of the wrong type", () => {
    write('{"system": {"corpCaEnabled": "false", "corpCaCommonName": 42}}');
    expect(readPersistedSystemBooleanSync(userDataPath, "corpCaEnabled")).toBeUndefined();
    expect(readPersistedSystemStringSync(userDataPath, "corpCaCommonName")).toBeUndefined();
  });

  it("treats a blank string as a field left to the default", () => {
    write('{"system": {"corpCaCommonName": "   "}}');
    expect(readPersistedSystemStringSync(userDataPath, "corpCaCommonName")).toBeUndefined();
    write('{"system": {"corpCaCommonName": "  Acme Root CA  "}}');
    expect(readPersistedSystemStringSync(userDataPath, "corpCaCommonName")).toBe("Acme Root CA");
  });
});
