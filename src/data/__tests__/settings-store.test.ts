import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

describe("SettingsService removes plugin-specific legacy host settings", () => {
  let userDataPath: string;

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), "settings-store-legacy-plugin-"));
    mockedElectron.safeStorage.isEncryptionAvailable.mockReturnValue(false);
  });

  afterEach(() => {
    vi.clearAllMocks();
    rmSync(userDataPath, { recursive: true, force: true });
  });

  it("drops legacy msGraph blocks from loaded and saved settings", async () => {
    const settingsPath = join(userDataPath, "lvis-settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify({
        msGraph: { enabled: true, tenantId: "legacy" },
        chat: { systemPrompt: "preserved", autoCompact: false },
      }),
      "utf-8",
    );

    const service = new SettingsService({ userDataPath });
    expect(service.getAll()).not.toHaveProperty("msGraph");

    await service.patch({ msGraph: { enabled: true } } as never);
    expect(service.getAll()).not.toHaveProperty("msGraph");
    expect(JSON.parse(readFileSync(settingsPath, "utf-8"))).not.toHaveProperty("msGraph");
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

// ─── Appearance v2 schema ────────────────────────────────────────────────────

describe("SettingsService appearance v2 — fresh install defaults", () => {
  let userDataPath: string;

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), "settings-appearance-v2-fresh-"));
    mockedElectron.safeStorage.isEncryptionAvailable.mockReturnValue(false);
  });

  afterEach(() => {
    vi.clearAllMocks();
    rmSync(userDataPath, { recursive: true, force: true });
  });

  it("fresh install returns schemaVersion:2 with bundleId=tokyo-night", () => {
    const service = new SettingsService({ userDataPath });
    expect(service.get("appearance")).toEqual({ schemaVersion: 2, bundleId: "tokyo-night" });
  });

  it("v2 appearance round-trips across restart", async () => {
    const service = new SettingsService({ userDataPath });
    await service.patch({ appearance: { schemaVersion: 2, bundleId: "midnight" } });
    const reloaded = new SettingsService({ userDataPath });
    expect(reloaded.get("appearance")).toEqual({ schemaVersion: 2, bundleId: "midnight" });
  });

  it("v2 with followSystem=true round-trips", async () => {
    const service = new SettingsService({ userDataPath });
    await service.patch({ appearance: { schemaVersion: 2, bundleId: "lge-light", followSystem: true } });
    const reloaded = new SettingsService({ userDataPath });
    expect(reloaded.get("appearance")).toEqual({ schemaVersion: 2, bundleId: "lge-light", followSystem: true });
  });

  it("unknown bundleId coerces to tokyo-night", () => {
    writeFileSync(
      join(userDataPath, "lvis-settings.json"),
      JSON.stringify({ appearance: { schemaVersion: 2, bundleId: "nonexistent-bundle" } }),
      "utf-8",
    );
    const service = new SettingsService({ userDataPath });
    expect(service.get("appearance")).toEqual({ schemaVersion: 2, bundleId: "tokyo-night" });
  });

  it("appearance block absent (pre-theme system install) → default tokyo-night", () => {
    writeFileSync(
      join(userDataPath, "lvis-settings.json"),
      JSON.stringify({ chat: { systemPrompt: "preserved", autoCompact: false } }),
      "utf-8",
    );
    const service = new SettingsService({ userDataPath });
    expect(service.get("appearance")).toEqual({ schemaVersion: 2, bundleId: "tokyo-night" });
    // Unrelated section preserved
    expect(service.get("chat").systemPrompt).toBe("preserved");
  });
});

// ─── Appearance v1 → v2 migration matrix ────────────────────────────────────

describe("SettingsService appearance v1 → v2 migration", () => {
  let userDataPath: string;

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), "settings-appearance-migration-"));
    mockedElectron.safeStorage.isEncryptionAvailable.mockReturnValue(false);
  });

  afterEach(() => {
    vi.clearAllMocks();
    rmSync(userDataPath, { recursive: true, force: true });
  });

  function writeV1(appearance: Record<string, unknown>): void {
    writeFileSync(
      join(userDataPath, "lvis-settings.json"),
      JSON.stringify({ appearance }),
      "utf-8",
    );
  }

  it("dark + default → tokyo-night", () => {
    writeV1({ theme: "dark", chatTheme: "default", codeTheme: "auto" });
    const s = new SettingsService({ userDataPath });
    expect(s.get("appearance")).toEqual({ schemaVersion: 2, bundleId: "tokyo-night" });
  });

  it("dark + lg → lge-dark", () => {
    writeV1({ theme: "dark", chatTheme: "lg", codeTheme: "auto" });
    const s = new SettingsService({ userDataPath });
    expect(s.get("appearance")).toEqual({ schemaVersion: 2, bundleId: "lge-dark" });
  });

  it("light + default → forest", () => {
    writeV1({ theme: "light", chatTheme: "default", codeTheme: "auto" });
    const s = new SettingsService({ userDataPath });
    expect(s.get("appearance")).toEqual({ schemaVersion: 2, bundleId: "forest" });
  });

  it("light + lg → lge-light", () => {
    writeV1({ theme: "light", chatTheme: "lg", codeTheme: "auto" });
    const s = new SettingsService({ userDataPath });
    expect(s.get("appearance")).toEqual({ schemaVersion: 2, bundleId: "lge-light" });
  });

  it("dark + lg + dark (code override) → lge-dark (code override ignored)", () => {
    writeV1({ theme: "dark", chatTheme: "lg", codeTheme: "dark" });
    const s = new SettingsService({ userDataPath });
    expect(s.get("appearance")).toEqual({ schemaVersion: 2, bundleId: "lge-dark" });
  });

  it("light + default + dark (code override) → forest (code override ignored)", () => {
    writeV1({ theme: "light", chatTheme: "default", codeTheme: "dark" });
    const s = new SettingsService({ userDataPath });
    expect(s.get("appearance")).toEqual({ schemaVersion: 2, bundleId: "forest" });
  });

  it("* + purple → midnight (closest accent coercion)", () => {
    writeV1({ theme: "dark", chatTheme: "purple", codeTheme: "auto" });
    const s = new SettingsService({ userDataPath });
    expect(s.get("appearance")).toEqual({ schemaVersion: 2, bundleId: "midnight" });
  });

  it("* + orange → midnight", () => {
    writeV1({ theme: "light", chatTheme: "orange", codeTheme: "auto" });
    const s = new SettingsService({ userDataPath });
    expect(s.get("appearance")).toEqual({ schemaVersion: 2, bundleId: "midnight" });
  });

  it("* + blue → midnight", () => {
    writeV1({ theme: "dark", chatTheme: "blue", codeTheme: "dark" });
    const s = new SettingsService({ userDataPath });
    expect(s.get("appearance")).toEqual({ schemaVersion: 2, bundleId: "midnight" });
  });

  it("high-contrast + * → high-contrast (HC always wins)", () => {
    writeV1({ theme: "high-contrast", chatTheme: "purple", codeTheme: "dark" });
    const s = new SettingsService({ userDataPath });
    expect(s.get("appearance")).toEqual({ schemaVersion: 2, bundleId: "high-contrast" });
  });

  it("invalid theme string → tokyo-night (DEFAULT_BUNDLE_ID)", () => {
    writeV1({ theme: "sepia", chatTheme: "default", codeTheme: "auto" });
    const s = new SettingsService({ userDataPath });
    expect(s.get("appearance")).toEqual({ schemaVersion: 2, bundleId: "tokyo-night" });
  });

  it("v1 write-back: migrated appearance is written to disk as v2", async () => {
    writeV1({ theme: "dark", chatTheme: "lg", codeTheme: "auto" });
    const service = new SettingsService({ userDataPath });
    // The constructor triggers async write-back — poll until disk reflects v2
    let onDisk: Record<string, unknown> = {};
    for (let i = 0; i < 20; i++) {
      await new Promise<void>((res) => setTimeout(res, 50));
      onDisk = JSON.parse(readFileSync(join(userDataPath, "lvis-settings.json"), "utf-8")) as Record<string, unknown>;
      if ((onDisk.appearance as Record<string, unknown>).schemaVersion === 2) break;
    }
    expect(onDisk.appearance).toEqual({ schemaVersion: 2, bundleId: "lge-dark" });
    // No legacy keys remain after write-back
    expect(onDisk.appearance.theme).toBeUndefined();
    expect(onDisk.appearance.chatTheme).toBeUndefined();
    expect(service.get("appearance")).toEqual({ schemaVersion: 2, bundleId: "lge-dark" });
  });

  it("v2 file loads without re-migration", () => {
    writeFileSync(
      join(userDataPath, "lvis-settings.json"),
      JSON.stringify({ appearance: { schemaVersion: 2, bundleId: "forest" } }),
      "utf-8",
    );
    const s = new SettingsService({ userDataPath });
    expect(s.get("appearance")).toEqual({ schemaVersion: 2, bundleId: "forest" });
  });

  // Main process has no window.matchMedia — system theme must not crash and must
  // produce a deterministic DEFAULT_BUNDLE_ID result (no silent OS-scheme access).
  it("system + default → tokyo-night (main process: no matchMedia needed)", () => {
    writeV1({ theme: "system", chatTheme: "default", codeTheme: "auto" });
    const s = new SettingsService({ userDataPath });
    expect(s.get("appearance")).toEqual({ schemaVersion: 2, bundleId: "tokyo-night" });
  });

  it("system + lg → lge-dark + followSystem:true (main process: renderer will track OS)", () => {
    writeV1({ theme: "system", chatTheme: "lg", codeTheme: "auto" });
    const s = new SettingsService({ userDataPath });
    expect(s.get("appearance")).toEqual({ schemaVersion: 2, bundleId: "lge-dark", followSystem: true });
  });

  it("codeTheme-only v1 triggers write-back (needsV2WriteBack includes codeTheme)", async () => {
    writeV1({ codeTheme: "light" });
    const service = new SettingsService({ userDataPath });
    let onDisk: Record<string, unknown> = {};
    for (let i = 0; i < 20; i++) {
      await new Promise<void>((res) => setTimeout(res, 50));
      onDisk = JSON.parse(readFileSync(join(userDataPath, "lvis-settings.json"), "utf-8")) as Record<string, unknown>;
      if ((onDisk.appearance as Record<string, unknown>).schemaVersion === 2) break;
    }
    expect((onDisk.appearance as Record<string, unknown>).codeTheme).toBeUndefined();
    expect(service.get("appearance")).toMatchObject({ schemaVersion: 2 });
  });
});
