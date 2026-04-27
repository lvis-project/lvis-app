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

describe("SettingsService LLM per-vendor patching", () => {
  let userDataPath: string;

  beforeEach(() => {
    mkdirSync(join(homedir(), ".lvis", "test-tmp"), { recursive: true });
    userDataPath = mkdtempSync(join(homedir(), ".lvis", "test-tmp", "settings-store-llm-"));
    mockedElectron.safeStorage.isEncryptionAvailable.mockReturnValue(false);
  });

  afterEach(() => {
    vi.clearAllMocks();
    rmSync(userDataPath, { recursive: true, force: true });
  });

  // Regression for the bug shipped + reverted between #279 and the per-vendor
  // refactor: switching the active provider used to carry the previous
  // vendor's `maxOutputTokens` into the new vendor's persisted block. With
  // per-vendor blocks, a patch touching only `azure-foundry` MUST leave
  // every other vendor's settings intact.
  it("vendor switch + save does not leak maxOutputTokens across vendors", async () => {
    const service = new SettingsService({ userDataPath });

    // Establish a non-default OpenAI maxOutputTokens (simulating a user who
    // raised it for OpenAI's wider output cap).
    await service.patch({
      llm: {
        provider: "openai",
        vendors: { openai: { maxOutputTokens: 16384 } },
      },
    });

    // User switches to azure-foundry and saves with the FRESH Foundry block
    // (4096 default) — this is what the renderer's hydrateVendorBlock +
    // save() path produces.
    await service.patch({
      llm: {
        provider: "azure-foundry",
        vendors: { "azure-foundry": { maxOutputTokens: 4096 } },
      },
    });

    const llm = service.get("llm");
    expect(llm.provider).toBe("azure-foundry");
    expect(llm.vendors["azure-foundry"].maxOutputTokens).toBe(4096);
    // The OpenAI block must still hold the user-tuned value, not be
    // overwritten by the Foundry save.
    expect(llm.vendors.openai.maxOutputTokens).toBe(16384);
  });

  it("coerces a stale unknown provider on disk to the default", () => {
    // Simulate an old install where the user had a since-removed vendor
    // selected. Without coercion, `llm.vendors[llm.provider]` would be
    // undefined and crash refreshProvider at first turn.
    writeFileSync(
      join(userDataPath, "lvis-settings.json"),
      JSON.stringify({ llm: { provider: "lgenie" } }),
      "utf-8",
    );

    const service = new SettingsService({ userDataPath });
    const llm = service.get("llm");

    expect(llm.provider).toBe("claude");
    expect(llm.vendors[llm.provider]).toBeDefined();
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
