import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

import { SettingsService } from "../settings-store.js";

describe("SettingsService marketplace defaults", () => {
  let userDataPath: string;

  beforeEach(() => {

    userDataPath = mkdtempSync(join(tmpdir(), "settings-store-"));
    mockedElectron.safeStorage.isEncryptionAvailable.mockReturnValue(false);
  });

  afterEach(() => {
    vi.clearAllMocks();
    rmSync(userDataPath, { recursive: true, force: true });
  });

  it("defaults to real-cloud against the local marketplace server", () => {
    // Phase 2-final: marketplace server is the single source. Default
    // now points at the production tunnel so a fresh install lands on the
    // live catalog with no extra setup. Local-marketplace operators
    // override via Settings → 마켓플레이스 tab.
    const service = new SettingsService({ userDataPath });

    expect(service.get("marketplace")).toEqual({
      backend: "real-cloud",
      realCloudBaseUrl: "https://marketplace.lvisai.xyz",
      realCloudAllowPrivateNetwork: false,
    });
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
    userDataPath = mkdtempSync(join(tmpdir(), "settings-store-llm-"));
    mockedElectron.safeStorage.isEncryptionAvailable.mockReturnValue(false);
  });

  afterEach(() => {
    vi.clearAllMocks();
    rmSync(userDataPath, { recursive: true, force: true });
  });

  // Regression for the bug shipped + reverted between #279 and the per-vendor
  // refactor: switching the active provider used to carry the previous
  // vendor's model into the new vendor's persisted block. With per-vendor
  // blocks, a patch touching only `azure-foundry` MUST leave every other
  // vendor's settings intact.
  //
  // CTRL simplification: test rewritten to use `model` instead of the
  // removed `maxOutputTokens` field.
  it("vendor switch + save does not leak model across vendors", async () => {
    const service = new SettingsService({ userDataPath });

    // Establish a non-default OpenAI model (simulating a user who switched to
    // a specific model for OpenAI).
    await service.patch({
      llm: {
        provider: "openai",
        vendors: { openai: { model: "gpt-5-turbo" } },
      },
    });

    // User switches to azure-foundry and saves with the FRESH Foundry block
    // (default model) — this is what the renderer's hydrateVendorBlock +
    // save() path produces.
    await service.patch({
      llm: {
        provider: "azure-foundry",
        vendors: { "azure-foundry": { model: "gpt-4o" } },
      },
    });

    const llm = service.get("llm");
    expect(llm.provider).toBe("azure-foundry");
    expect(llm.vendors["azure-foundry"].model).toBe("gpt-4o");
    // The OpenAI block must still hold the user-tuned value, not be
    // overwritten by the Foundry save.
    expect(llm.vendors.openai.model).toBe("gpt-5-turbo");
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

describe("SettingsService webView (B1 — external URL viewer policy)", () => {
  let userDataPath: string;

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), "settings-store-webview-"));
    mockedElectron.safeStorage.isEncryptionAvailable.mockReturnValue(false);
  });

  afterEach(() => {
    vi.clearAllMocks();
    rmSync(userDataPath, { recursive: true, force: true });
  });

  it("defaults preferredFlow to 'in-app' on a fresh install", () => {
    const service = new SettingsService({ userDataPath });
    expect(service.get("webView")).toEqual({ preferredFlow: "in-app" });
  });

  it("applies default 'in-app' when webView field is absent on disk (legacy settings.json)", () => {
    writeFileSync(
      join(userDataPath, "lvis-settings.json"),
      JSON.stringify({ marketplace: { backend: "real-cloud" } }),
      "utf-8",
    );
    const service = new SettingsService({ userDataPath });
    expect(service.get("webView")).toEqual({ preferredFlow: "in-app" });
  });

  it("round-trips a system-browser preference across restart", async () => {
    const service = new SettingsService({ userDataPath });
    await service.patch({ webView: { preferredFlow: "system-browser" } });
    expect(service.get("webView")).toEqual({ preferredFlow: "system-browser" });

    const reloaded = new SettingsService({ userDataPath });
    expect(reloaded.get("webView")).toEqual({ preferredFlow: "system-browser" });
  });

  // Critic F4 mitigation: schema-invalid value falls back to default for THIS
  // field only — other settings sections must remain intact.
  it.each([
    ["string-not-in-enum", "yes"],
    ["null", null],
    ["number", 42],
    ["array", ["in-app"]],
  ])("falls back to default when preferredFlow is invalid (%s) without resetting unrelated settings", (_label, badValue) => {
    writeFileSync(
      join(userDataPath, "lvis-settings.json"),
      JSON.stringify({
        webView: { preferredFlow: badValue },
        chat: { systemPrompt: "preserved-prompt", autoCompact: false },
        marketplace: { backend: "real-cloud", realCloudBaseUrl: "https://preserved.example" },
      }),
      "utf-8",
    );
    const service = new SettingsService({ userDataPath });
    expect(service.get("webView")).toEqual({ preferredFlow: "in-app" });
    // Unrelated sections must be preserved (no full default reset).
    expect(service.get("chat").systemPrompt).toBe("preserved-prompt");
    expect(service.get("chat").autoCompact).toBe(false);
    expect(service.get("marketplace").realCloudBaseUrl).toBe("https://preserved.example");
  });

  it("falls back to default when webView block is not an object", () => {
    writeFileSync(
      join(userDataPath, "lvis-settings.json"),
      JSON.stringify({ webView: "garbage" }),
      "utf-8",
    );
    const service = new SettingsService({ userDataPath });
    expect(service.get("webView")).toEqual({ preferredFlow: "in-app" });
  });
});

describe("SettingsService msGraph patching", () => {
  let userDataPath: string;

  beforeEach(() => {

    userDataPath = mkdtempSync(join(tmpdir(), "settings-store-msgraph-"));
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
