import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
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

import { SettingsService } from "../settings-store.js";

describe("SettingsService marketplace defaults", () => {
  let userDataPath: string;

  beforeEach(() => {
    mkdirSync(join(homedir(), ".lvis", "test-tmp"), { recursive: true });
    userDataPath = mkdtempSync(join(homedir(), ".lvis", "test-tmp", "settings-store-"));
    mockedElectron.safeStorage.isEncryptionAvailable.mockReturnValue(false);
  });

  afterEach(() => {
    vi.clearAllMocks();
    rmSync(userDataPath, { recursive: true, force: true });
  });

  it("defaults to real-cloud against the local marketplace server", () => {
    // Phase 2-final: marketplace server is the single source. Default
    // points at the dev localhost server; production deployments override
    // via settings UI / installer config.
    const service = new SettingsService({ userDataPath });

    expect(service.get("marketplace")).toEqual({
      backend: "real-cloud",
      realCloudBaseUrl: "http://localhost:8000",
      realCloudAllowPrivateNetwork: true,
    });
  });

  it("coerces legacy 'mock' backend to real-cloud", () => {
    writeFileSync(
      join(userDataPath, "lvis-settings.json"),
      JSON.stringify({
        marketplace: {
          backend: "mock",
        },
      }),
      "utf-8",
    );

    const service = new SettingsService({ userDataPath });
    expect(service.get("marketplace").backend).toBe("real-cloud");
  });

  it("preserves an explicitly configured real-cloud endpoint", () => {
    writeFileSync(
      join(userDataPath, "lvis-settings.json"),
      JSON.stringify({
        marketplace: {
          backend: "real-cloud",
          realCloudBaseUrl: "https://marketplace.lvis.local",
          realCloudAllowPrivateNetwork: false,
        },
      }),
      "utf-8",
    );

    const service = new SettingsService({ userDataPath });

    expect(service.get("marketplace")).toEqual({
      backend: "real-cloud",
      realCloudBaseUrl: "https://marketplace.lvis.local",
      realCloudAllowPrivateNetwork: false,
    });
  });
});

describe("SettingsService msGraph patching", () => {
  let userDataPath: string;

  beforeEach(() => {
    mkdirSync(join(homedir(), ".lvis", "test-tmp"), { recursive: true });
    userDataPath = mkdtempSync(join(homedir(), ".lvis", "test-tmp", "settings-store-msgraph-"));
    mockedElectron.safeStorage.isEncryptionAvailable.mockReturnValue(false);
  });

  afterEach(() => {
    vi.clearAllMocks();
    rmSync(userDataPath, { recursive: true, force: true });
  });

  it("patch() persists msGraph environment changes across restart", async () => {
    const service = new SettingsService({ userDataPath });

    await service.patch({ msGraph: { environment: "corporate" } });
    expect(service.get("msGraph")).toEqual({ environment: "corporate" });

    const reloaded = new SettingsService({ userDataPath });
    expect(reloaded.get("msGraph")).toEqual({ environment: "corporate" });
  });
});
