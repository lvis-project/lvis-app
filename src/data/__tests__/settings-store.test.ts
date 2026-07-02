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
import { DEFAULT_BUNDLE_ID } from "../../shared/theme-bundles.js";
import { setProcessPlatform } from "../../testing/process-platform.js";

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
      cloudBaseUrl: "https://marketplace.lvisai.xyz",
      cloudAllowPrivateNetwork: false,
    });
  });

  it("preserves an explicitly configured real-cloud endpoint", () => {
    writeFileSync(
      join(userDataPath, "lvis-settings.json"),
      JSON.stringify({
        marketplace: {
          backend: "real-cloud",
          cloudBaseUrl: "https://marketplace.lvis.local",
          cloudAllowPrivateNetwork: false,
        },
      }),
      "utf-8",
    );

    const service = new SettingsService({ userDataPath });

    expect(service.get("marketplace")).toEqual({
      backend: "real-cloud",
      cloudBaseUrl: "https://marketplace.lvis.local",
      cloudAllowPrivateNetwork: false,
    });
  });

  it("migrates legacy realCloud* keys → cloud* (renamed when the mock backend was removed)", () => {
    writeFileSync(
      join(userDataPath, "lvis-settings.json"),
      JSON.stringify({
        marketplace: {
          backend: "real-cloud",
          realCloudBaseUrl: "https://legacy.example",
          realCloudAllowPrivateNetwork: true,
        },
      }),
      "utf-8",
    );

    const service = new SettingsService({ userDataPath });
    const mk = service.get("marketplace") as Record<string, unknown>;

    expect(mk.cloudBaseUrl).toBe("https://legacy.example");
    expect(mk.cloudAllowPrivateNetwork).toBe(true);
    // Legacy keys are not carried forward.
    expect(mk.realCloudBaseUrl).toBeUndefined();
    expect(mk.realCloudAllowPrivateNetwork).toBeUndefined();
  });

  it("drops a whitespace-only legacy realCloudBaseUrl and falls back to the default", () => {
    writeFileSync(
      join(userDataPath, "lvis-settings.json"),
      JSON.stringify({ marketplace: { backend: "real-cloud", realCloudBaseUrl: "   " } }),
      "utf-8",
    );

    const service = new SettingsService({ userDataPath });
    const mk = service.get("marketplace") as Record<string, unknown>;

    // Whitespace-only legacy value is dropped → default, not "   ".
    expect(mk.cloudBaseUrl).toBe("https://marketplace.lvisai.xyz");
    expect(mk.realCloudBaseUrl).toBeUndefined();
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

describe("SettingsService plugin uninstall cleanup", () => {
  let userDataPath: string;

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), "settings-store-plugin-cleanup-"));
    mockedElectron.safeStorage.isEncryptionAvailable.mockReturnValue(false);
  });

  afterEach(() => {
    vi.clearAllMocks();
    rmSync(userDataPath, { recursive: true, force: true });
  });

  it("deletes only the selected plugin config", async () => {
    const service = new SettingsService({ userDataPath });

    await service.setPluginConfig("meeting", { apiKey: "abc" });
    await service.setPluginConfig("calendar", { tenant: "example" });
    await service.deletePluginConfig("meeting");

    expect(service.getPluginConfig("meeting")).toEqual({});
    expect(service.getPluginConfig("calendar")).toEqual({ tenant: "example" });
  });

  it("deletes only requested secret keys for the selected plugin", async () => {
    const service = new SettingsService({ userDataPath });

    await service.setSecret("plugin.meeting.token", "abc");
    await service.setSecret("plugin.meeting.unlisted", "preserved");
    await service.setSecret("plugin.meeting_extra.token", "preserved");
    await service.setSecret("llm.apiKey.openai", "preserved");

    await expect(service.deletePluginSecrets("meeting", ["token"])).resolves.toBe(1);

    expect(service.getSecret("plugin.meeting.token")).toBeNull();
    expect(service.getSecret("plugin.meeting.unlisted")).toBe("preserved");
    expect(service.getSecret("plugin.meeting_extra.token")).toBe("preserved");
    expect(service.getSecret("llm.apiKey.openai")).toBe("preserved");
  });

  it("does not delete another dotted plugin id's secret by prefix", async () => {
    const service = new SettingsService({ userDataPath });

    await service.setSecret("plugin.com.example.token", "abc");
    await service.setSecret("plugin.com.example.mail.token", "preserved");

    await expect(service.deletePluginSecrets("com.example", ["token"])).resolves.toBe(1);

    expect(service.getSecret("plugin.com.example.token")).toBeNull();
    expect(service.getSecret("plugin.com.example.mail.token")).toBe("preserved");
  });
});

describe("SettingsService role presets", () => {
  let userDataPath: string;

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), "settings-store-roles-"));
    mockedElectron.safeStorage.isEncryptionAvailable.mockReturnValue(false);
  });

  afterEach(() => {
    vi.clearAllMocks();
    rmSync(userDataPath, { recursive: true, force: true });
  });

  it("ignores unknown on-disk sections without resetting unrelated sections", () => {
    writeFileSync(
      join(userDataPath, "lvis-settings.json"),
      JSON.stringify({
        unknownSection: { foo: "bar" },
        chat: { systemPrompt: "preserved-prompt", autoCompact: false },
      }),
      "utf-8",
    );

    const service = new SettingsService({ userDataPath });
    expect(service.get("chat").systemPrompt).toBe("preserved-prompt");
    expect(service.get("chat").autoCompact).toBe(false);
  });

  it("defaults idle preference refresh on and normalizes the flag to boolean only", async () => {
    const service = new SettingsService({ userDataPath });
    expect(service.get("features")?.idlePreferenceRefresh).toBe(true);

    await service.patch({ features: { idlePreferenceRefresh: false } });
    expect(service.get("features")?.idlePreferenceRefresh).toBe(false);

    // A non-boolean patch is rejected — the value stays at its current `false`,
    // NOT silently reset to the `true` default (which would mask the rejection).
    await service.patch({ features: { idlePreferenceRefresh: "yes" } as never });
    expect(service.get("features")?.idlePreferenceRefresh).toBe(false);

    await service.patch({ features: { idlePreferenceRefresh: true } });
    expect(service.get("features")?.idlePreferenceRefresh).toBe(true);
  });

  it("ships hostClassifiesRisk ON all-platform; osToolSandbox STAGED (macOS-first)", () => {
    // hostClassifiesRisk ships ON on EVERY platform (shadow-mode reconciliation
    // completed). It is safe to ship on non-sandbox / network-only platforms
    // because the foreground read-relaxation is coupled to the active sandbox
    // FILESYSTEM-CONTAINING the host — where it is not filesystem-contained it
    // falls back to the pre-exec ask.
    //
    // osToolSandbox is STAGED: default ON on darwin (the live-verified-active
    // platform) and OFF on linux/win32 until the C/D-series QA is green (opt-in
    // via Settings until then). The default is computed from process.platform,
    // so this assertion tracks the runner's platform deterministically.
    const service = new SettingsService({ userDataPath });
    expect(service.get("features")?.hostClassifiesRisk ?? false).toBe(true);
    expect(service.get("features")?.osToolSandbox ?? false).toBe(
      process.platform === "darwin",
    );
  });

  // Platform-staged default TRUTH-TABLE — asserts the staged default EXPLICITLY
  // per platform (true on darwin, false on linux AND win32), not by mirroring
  // the impl expression. The default is evaluated at module-load from
  // `process.platform`, so each case stubs the platform and re-imports the
  // store with `vi.resetModules()` to recompute DEFAULT_SETTINGS, then reads the
  // default through a fresh SettingsService (empty userDataPath → defaults).
  it.each([
    ["darwin", true],
    ["linux", false],
    ["win32", false],
  ] as const)(
    "osToolSandbox default on %s = %s (explicit staged truth-table)",
    async (platform, expected) => {
      const original = process.platform;
      const dir = mkdtempSync(join(tmpdir(), "settings-store-truthtable-"));
      try {
        setProcessPlatform(platform);
        vi.resetModules();
        const { SettingsService: FreshSettingsService } = await import(
          "../settings-store.js"
        );
        const service = new FreshSettingsService({ userDataPath: dir });
        expect(service.get("features")?.osToolSandbox ?? false).toBe(expected);
      } finally {
        setProcessPlatform(original);
        vi.resetModules();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
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

    // User switches to azure-foundry and saves a retired Foundry model.
    // The retired exact gpt-4o id is normalized, but the patch must still not
    // leak across vendor blocks.
    await service.patch({
      llm: {
        provider: "azure-foundry",
        vendors: { "azure-foundry": { model: "gpt-4o" } },
      },
    });

    const llm = service.get("llm");
    expect(llm.provider).toBe("azure-foundry");
    expect(llm.vendors["azure-foundry"].model).toBe("gpt-5.4-mini");
    // The OpenAI block must still hold the user-tuned value, not be
    // overwritten by the Foundry save.
    expect(llm.vendors.openai.model).toBe("gpt-5-turbo");
  });

  it("replaceLlm removes optional transport fields that merge patches would retain", async () => {
    const service = new SettingsService({ userDataPath });
    const original = service.get("llm");

    await service.patch({
      llm: {
        provider: "openai",
        vendors: {
          openai: {
            baseUrl: "https://proxy.example/v1",
            vertexProject: "should-clear",
            vertexLocation: "us-central1",
          },
        },
      },
    });
    await service.replaceLlm(original);

    const llm = service.get("llm");
    expect(llm.vendors.openai.baseUrl).toBeUndefined();
    expect(llm.vendors.openai.vertexProject).toBeUndefined();
    expect(llm.vendors.openai.vertexLocation).toBeUndefined();
  });

  it("coerces a stale unknown provider on disk to the default", () => {
    // Simulate an old install where the user had a since-removed vendor
    // selected. Without coercion, `llm.vendors[llm.provider]` would be
    // undefined and crash refreshProvider at first turn.
    writeFileSync(
      join(userDataPath, "lvis-settings.json"),
      JSON.stringify({ llm: { provider: "unknown-vendor" } }),
      "utf-8",
    );

    const service = new SettingsService({ userDataPath });
    const llm = service.get("llm");

    expect(llm.provider).toBe("azure-foundry");
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
        marketplace: { backend: "real-cloud", cloudBaseUrl: "https://preserved.example" },
      }),
      "utf-8",
    );
    const service = new SettingsService({ userDataPath });
    expect(service.get("webView")).toEqual({ preferredFlow: "in-app" });
    // Unrelated sections must be preserved (no full default reset).
    expect(service.get("chat").systemPrompt).toBe("preserved-prompt");
    expect(service.get("chat").autoCompact).toBe(false);
    expect(service.get("marketplace").cloudBaseUrl).toBe("https://preserved.example");
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

describe("SettingsService system — close behavior (PR #1032)", () => {
  let userDataPath: string;

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), "settings-store-system-"));
    mockedElectron.safeStorage.isEncryptionAvailable.mockReturnValue(false);
  });

  afterEach(() => {
    vi.clearAllMocks();
    rmSync(userDataPath, { recursive: true, force: true });
  });

  it("defaults closeBehavior to 'hide-to-tray' on a fresh install", () => {
    const service = new SettingsService({ userDataPath });
    expect(service.get("system")).toEqual({ closeBehavior: "hide-to-tray", appMode: "work", localApiServer: false });
  });

  it("applies default 'hide-to-tray' when system field is absent on disk (legacy settings.json)", () => {
    writeFileSync(
      join(userDataPath, "lvis-settings.json"),
      JSON.stringify({ marketplace: { backend: "real-cloud" } }),
      "utf-8",
    );
    const service = new SettingsService({ userDataPath });
    expect(service.get("system")).toEqual({ closeBehavior: "hide-to-tray", appMode: "work", localApiServer: false });
  });

  it("round-trips a 'quit' preference across restart", async () => {
    const service = new SettingsService({ userDataPath });
    await service.patch({ system: { closeBehavior: "quit" } });
    expect(service.get("system")).toEqual({ closeBehavior: "quit", appMode: "work", localApiServer: false });

    const reloaded = new SettingsService({ userDataPath });
    expect(reloaded.get("system")).toEqual({ closeBehavior: "quit", appMode: "work", localApiServer: false });
  });

  // Critic M1 — schema-invalid value on disk falls back to default for THIS
  // field only; other settings sections must remain intact.
  it.each([
    ["string-not-in-enum", "yes"],
    ["null", null],
    ["number", 42],
    ["array", ["quit"]],
  ])("falls back to default when closeBehavior is invalid on disk (%s) without resetting unrelated settings", (_label, badValue) => {
    writeFileSync(
      join(userDataPath, "lvis-settings.json"),
      JSON.stringify({
        system: { closeBehavior: badValue },
        chat: { systemPrompt: "preserved-prompt", autoCompact: false },
        marketplace: { backend: "real-cloud", cloudBaseUrl: "https://preserved.example" },
      }),
      "utf-8",
    );
    const service = new SettingsService({ userDataPath });
    expect(service.get("system")).toEqual({ closeBehavior: "hide-to-tray", appMode: "work", localApiServer: false });
    expect(service.get("chat").systemPrompt).toBe("preserved-prompt");
    expect(service.get("chat").autoCompact).toBe(false);
    expect(service.get("marketplace").cloudBaseUrl).toBe("https://preserved.example");
  });

  it("falls back to default when system block is not an object", () => {
    writeFileSync(
      join(userDataPath, "lvis-settings.json"),
      JSON.stringify({ system: "garbage" }),
      "utf-8",
    );
    const service = new SettingsService({ userDataPath });
    expect(service.get("system")).toEqual({ closeBehavior: "hide-to-tray", appMode: "work", localApiServer: false });
  });

  // Critic N1 — patch-merge must NOT clobber a valid prior preference when
  // an invalid value arrives via the renderer/IPC layer. Field-level guard
  // mirrors the `appearance` block's behavior.
  it("ignores invalid closeBehavior patch and preserves prior 'quit' preference", async () => {
    const service = new SettingsService({ userDataPath });
    await service.patch({ system: { closeBehavior: "quit" } });
    expect(service.get("system").closeBehavior).toBe("quit");

    // Patch with garbage — should be a no-op on the closeBehavior field.
    await service.patch({ system: { closeBehavior: "invalid-value" as never } });
    expect(service.get("system").closeBehavior).toBe("quit");
  });
});

// ─── System — workspace appMode persistence ───────────────────────────────────

describe("SettingsService system — workspace appMode", () => {
  let userDataPath: string;

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), "settings-system-appmode-"));
    mockedElectron.safeStorage.isEncryptionAvailable.mockReturnValue(false);
  });

  afterEach(() => {
    vi.clearAllMocks();
    rmSync(userDataPath, { recursive: true, force: true });
  });

  it("defaults appMode to 'work' on a fresh install", () => {
    const service = new SettingsService({ userDataPath });
    expect(service.get("system").appMode).toBe("work");
  });

  it("round-trips a 'chat' appMode across restart", async () => {
    const service = new SettingsService({ userDataPath });
    await service.patch({ system: { appMode: "chat" } });
    expect(service.get("system").appMode).toBe("chat");

    const reloaded = new SettingsService({ userDataPath });
    expect(reloaded.get("system").appMode).toBe("chat");
  });

  it("normalizes appMode and closeBehavior independently (one invalid, one valid)", () => {
    writeFileSync(
      join(userDataPath, "lvis-settings.json"),
      JSON.stringify({ system: { closeBehavior: "quit", appMode: "not-a-mode" } }),
      "utf-8",
    );
    const service = new SettingsService({ userDataPath });
    // closeBehavior preserved; appMode falls back to default — neither clobbers the other.
    expect(service.get("system")).toEqual({ closeBehavior: "quit", appMode: "work", localApiServer: false });
  });

  it("normalizes legacy 'action' appMode on disk to 'work'", () => {
    writeFileSync(
      join(userDataPath, "lvis-settings.json"),
      JSON.stringify({ system: { closeBehavior: "quit", appMode: "action" } }),
      "utf-8",
    );
    const service = new SettingsService({ userDataPath });
    expect(service.get("system")).toEqual({ closeBehavior: "quit", appMode: "work", localApiServer: false });
  });

  it("normalizes a legacy 'action' appMode patch to 'work'", async () => {
    const service = new SettingsService({ userDataPath });
    await service.patch({ system: { appMode: "action" as never } });
    expect(service.get("system").appMode).toBe("work");
  });

  it("ignores invalid appMode patch and preserves prior 'chat' preference", async () => {
    const service = new SettingsService({ userDataPath });
    await service.patch({ system: { appMode: "chat" } });
    expect(service.get("system").appMode).toBe("chat");

    await service.patch({ system: { appMode: "garbage" as never } });
    expect(service.get("system").appMode).toBe("chat");
  });

  it("patching appMode does not clobber a prior closeBehavior", async () => {
    const service = new SettingsService({ userDataPath });
    await service.patch({ system: { closeBehavior: "quit" } });
    await service.patch({ system: { appMode: "chat" } });
    expect(service.get("system")).toEqual({ closeBehavior: "quit", appMode: "chat", localApiServer: false });
  });

  it("round-trips a localApiServer=true preference across restart", async () => {
    const service = new SettingsService({ userDataPath });
    await service.patch({ system: { localApiServer: true } });
    expect(service.get("system")).toEqual({ closeBehavior: "hide-to-tray", appMode: "work", localApiServer: true });

    const reloaded = new SettingsService({ userDataPath });
    expect(reloaded.get("system").localApiServer).toBe(true);
  });

  it("ignores an invalid localApiServer patch and preserves prior value", async () => {
    const service = new SettingsService({ userDataPath });
    await service.patch({ system: { localApiServer: true } });
    await service.patch({ system: { localApiServer: "yes" as never } });
    expect(service.get("system").localApiServer).toBe(true);
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

  it("fresh install returns schemaVersion:2 with DEFAULT_BUNDLE_ID", () => {
    const service = new SettingsService({ userDataPath });
    expect(service.get("appearance")).toEqual({ schemaVersion: 2, language: "en", bundleId: DEFAULT_BUNDLE_ID });
  });

  it("v2 appearance round-trips across restart", async () => {
    const service = new SettingsService({ userDataPath });
    await service.patch({ appearance: { schemaVersion: 2, language: "en", bundleId: "midnight" } });
    const reloaded = new SettingsService({ userDataPath });
    expect(reloaded.get("appearance")).toEqual({ schemaVersion: 2, language: "en", bundleId: "midnight" });
  });

  it("v2 with followSystem=true round-trips", async () => {
    const service = new SettingsService({ userDataPath });
    await service.patch({ appearance: { schemaVersion: 2, language: "en", bundleId: "violet-light", followSystem: true } });
    const reloaded = new SettingsService({ userDataPath });
    expect(reloaded.get("appearance")).toEqual({ schemaVersion: 2, language: "en", bundleId: "violet-light", followSystem: true });
  });

  it("unknown bundleId coerces to DEFAULT_BUNDLE_ID", () => {
    writeFileSync(
      join(userDataPath, "lvis-settings.json"),
      JSON.stringify({ appearance: { schemaVersion: 2, language: "en", bundleId: "nonexistent-bundle" } }),
      "utf-8",
    );
    const service = new SettingsService({ userDataPath });
    expect(service.get("appearance")).toEqual({ schemaVersion: 2, language: "en", bundleId: DEFAULT_BUNDLE_ID });
  });

  it("appearance block absent (pre-theme system install) → DEFAULT_BUNDLE_ID", () => {
    writeFileSync(
      join(userDataPath, "lvis-settings.json"),
      JSON.stringify({ chat: { systemPrompt: "preserved", autoCompact: false } }),
      "utf-8",
    );
    const service = new SettingsService({ userDataPath });
    expect(service.get("appearance")).toEqual({ schemaVersion: 2, language: "en", bundleId: DEFAULT_BUNDLE_ID });
    // Unrelated section preserved
    expect(service.get("chat").systemPrompt).toBe("preserved");
  });
});

// ─── System locale auto-detection — fresh install ────────────────────────────

describe("SettingsService system locale detection", () => {
  let userDataPath: string;

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), "settings-locale-detect-"));
    mockedElectron.safeStorage.isEncryptionAvailable.mockReturnValue(false);
  });

  afterEach(() => {
    vi.clearAllMocks();
    rmSync(userDataPath, { recursive: true, force: true });
  });

  it("fresh install with systemLocale=ko-KR seeds language as 'ko'", () => {
    const service = new SettingsService({ userDataPath, systemLocale: "ko-KR" });
    expect(service.get("appearance").language).toBe("ko");
  });

  it("fresh install with systemLocale=en-US seeds language as 'en'", () => {
    const service = new SettingsService({ userDataPath, systemLocale: "en-US" });
    expect(service.get("appearance").language).toBe("en");
  });

  it("fresh install with unsupported systemLocale falls back to 'en'", () => {
    const service = new SettingsService({ userDataPath, systemLocale: "it-IT" });
    expect(service.get("appearance").language).toBe("en");
  });

  it("fresh install without systemLocale defaults to 'en'", () => {
    const service = new SettingsService({ userDataPath });
    expect(service.get("appearance").language).toBe("en");
  });

  it("existing settings file with explicit language is not overridden by systemLocale", () => {
    writeFileSync(
      join(userDataPath, "lvis-settings.json"),
      JSON.stringify({ appearance: { schemaVersion: 2, language: "en", bundleId: DEFAULT_BUNDLE_ID } }),
      "utf-8",
    );
    // Even if OS is Korean, the stored "en" is the user's explicit choice — respect it.
    const service = new SettingsService({ userDataPath, systemLocale: "ko-KR" });
    expect(service.get("appearance").language).toBe("en");
  });

  it("existing settings file with language='ko' is preserved regardless of systemLocale", () => {
    writeFileSync(
      join(userDataPath, "lvis-settings.json"),
      JSON.stringify({ appearance: { schemaVersion: 2, language: "ko", bundleId: DEFAULT_BUNDLE_ID } }),
      "utf-8",
    );
    const service = new SettingsService({ userDataPath, systemLocale: "en-US" });
    expect(service.get("appearance").language).toBe("ko");
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
    expect(s.get("appearance")).toEqual({ schemaVersion: 2, language: "en", bundleId: "tokyo-night" });
  });

  it("dark + lg → violet-dark", () => {
    writeV1({ theme: "dark", chatTheme: "lg", codeTheme: "auto" });
    const s = new SettingsService({ userDataPath });
    expect(s.get("appearance")).toEqual({ schemaVersion: 2, language: "en", bundleId: "violet-dark" });
  });

  it("light + default → forest", () => {
    writeV1({ theme: "light", chatTheme: "default", codeTheme: "auto" });
    const s = new SettingsService({ userDataPath });
    expect(s.get("appearance")).toEqual({ schemaVersion: 2, language: "en", bundleId: "forest" });
  });

  it("light + lg → violet-light", () => {
    writeV1({ theme: "light", chatTheme: "lg", codeTheme: "auto" });
    const s = new SettingsService({ userDataPath });
    expect(s.get("appearance")).toEqual({ schemaVersion: 2, language: "en", bundleId: "violet-light" });
  });

  it("dark + lg + dark (code override) → violet-dark (code override ignored)", () => {
    writeV1({ theme: "dark", chatTheme: "lg", codeTheme: "dark" });
    const s = new SettingsService({ userDataPath });
    expect(s.get("appearance")).toEqual({ schemaVersion: 2, language: "en", bundleId: "violet-dark" });
  });

  it("light + default + dark (code override) → forest (code override ignored)", () => {
    writeV1({ theme: "light", chatTheme: "default", codeTheme: "dark" });
    const s = new SettingsService({ userDataPath });
    expect(s.get("appearance")).toEqual({ schemaVersion: 2, language: "en", bundleId: "forest" });
  });

  it("* + purple → midnight (closest accent coercion)", () => {
    writeV1({ theme: "dark", chatTheme: "purple", codeTheme: "auto" });
    const s = new SettingsService({ userDataPath });
    expect(s.get("appearance")).toEqual({ schemaVersion: 2, language: "en", bundleId: "midnight" });
  });

  it("* + orange → midnight", () => {
    writeV1({ theme: "light", chatTheme: "orange", codeTheme: "auto" });
    const s = new SettingsService({ userDataPath });
    expect(s.get("appearance")).toEqual({ schemaVersion: 2, language: "en", bundleId: "midnight" });
  });

  it("* + blue → midnight", () => {
    writeV1({ theme: "dark", chatTheme: "blue", codeTheme: "dark" });
    const s = new SettingsService({ userDataPath });
    expect(s.get("appearance")).toEqual({ schemaVersion: 2, language: "en", bundleId: "midnight" });
  });

  it("high-contrast + * → high-contrast (HC always wins)", () => {
    writeV1({ theme: "high-contrast", chatTheme: "purple", codeTheme: "dark" });
    const s = new SettingsService({ userDataPath });
    expect(s.get("appearance")).toEqual({ schemaVersion: 2, language: "en", bundleId: "high-contrast" });
  });

  it("invalid theme string → DEFAULT_BUNDLE_ID", () => {
    writeV1({ theme: "sepia", chatTheme: "default", codeTheme: "auto" });
    const s = new SettingsService({ userDataPath });
    expect(s.get("appearance")).toEqual({ schemaVersion: 2, language: "en", bundleId: DEFAULT_BUNDLE_ID });
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
    expect(onDisk.appearance).toEqual({ schemaVersion: 2, language: "en", bundleId: "violet-dark" });
    // No legacy keys remain after write-back
    expect(onDisk.appearance.theme).toBeUndefined();
    expect(onDisk.appearance.chatTheme).toBeUndefined();
    expect(service.get("appearance")).toEqual({ schemaVersion: 2, language: "en", bundleId: "violet-dark" });
  });

  it("v2 file loads without re-migration", () => {
    writeFileSync(
      join(userDataPath, "lvis-settings.json"),
      JSON.stringify({ appearance: { schemaVersion: 2, language: "en", bundleId: "forest" } }),
      "utf-8",
    );
    const s = new SettingsService({ userDataPath });
    expect(s.get("appearance")).toEqual({ schemaVersion: 2, language: "en", bundleId: "forest" });
  });

  // Main process has no window.matchMedia — system theme must not crash and must
  // produce a deterministic DEFAULT_BUNDLE_ID result (no silent OS-scheme access).
  it("system + default → DEFAULT_BUNDLE_ID (main process: no matchMedia needed)", () => {
    writeV1({ theme: "system", chatTheme: "default", codeTheme: "auto" });
    const s = new SettingsService({ userDataPath });
    expect(s.get("appearance")).toEqual({ schemaVersion: 2, language: "en", bundleId: DEFAULT_BUNDLE_ID });
  });

  it("system + lg → violet-dark + followSystem:true (main process: renderer will track OS)", () => {
    writeV1({ theme: "system", chatTheme: "lg", codeTheme: "auto" });
    const s = new SettingsService({ userDataPath });
    expect(s.get("appearance")).toEqual({ schemaVersion: 2, language: "en", bundleId: "violet-dark", followSystem: true });
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

describe("SettingsService appearance.font — Track A user-configurable font", () => {
  let userDataPath: string;

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), "settings-store-font-"));
  });
  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true });
  });

  function writeAppearance(font: unknown): void {
    writeFileSync(
      join(userDataPath, "lvis-settings.json"),
      JSON.stringify({ appearance: { schemaVersion: 2, language: "en", bundleId: "tokyo-night", font } }),
    );
  }

  it("accepts `family: 'system'` verbatim", () => {
    writeAppearance({ family: "system" });
    const s = new SettingsService({ userDataPath });
    expect(s.get("appearance")).toMatchObject({ font: { family: "system" } });
  });

  it("accepts a valid user stack and roundtrips it", () => {
    const stack = 'Pretendard, system-ui, "Apple SD Gothic Neo", sans-serif';
    writeAppearance({ family: stack });
    const s = new SettingsService({ userDataPath });
    expect(s.get("appearance")).toMatchObject({ font: { family: stack } });
  });

  it("rejects a stack that contains injection metachars and drops the field", () => {
    writeAppearance({ family: 'Arial; color: red; url(http://evil)' });
    const s = new SettingsService({ userDataPath });
    expect(s.get("appearance").font?.family).toBeUndefined();
  });

  it("rejects a stack longer than 200 chars and drops the field", () => {
    writeAppearance({ family: "A".repeat(201) });
    const s = new SettingsService({ userDataPath });
    expect(s.get("appearance").font?.family).toBeUndefined();
  });

  it("accepts each preset sizeScale value", () => {
    for (const value of [0.875, 1, 1.125, 1.25]) {
      const dir = mkdtempSync(join(tmpdir(), `settings-store-size-${value}-`));
      writeFileSync(
        join(dir, "lvis-settings.json"),
        JSON.stringify({ appearance: { schemaVersion: 2, language: "en", bundleId: "tokyo-night", font: { sizeScale: value } } }),
      );
      const s = new SettingsService({ userDataPath: dir });
      expect(s.get("appearance")).toMatchObject({ font: { sizeScale: value } });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects an off-preset sizeScale (e.g. 0.4) and drops the field", () => {
    writeAppearance({ sizeScale: 0.4 });
    const s = new SettingsService({ userDataPath });
    expect(s.get("appearance").font?.sizeScale).toBeUndefined();
  });

  it("drops the entire `font` field when both fields are invalid", () => {
    writeAppearance({ family: 123, sizeScale: "huge" });
    const s = new SettingsService({ userDataPath });
    expect(s.get("appearance").font).toBeUndefined();
  });

  it("patch family-only preserves a previously patched sizeScale (PR #672 review HIGH#1)", async () => {
    const s = new SettingsService({ userDataPath });
    await s.patch({ appearance: { schemaVersion: 2, language: "en", bundleId: "tokyo-night", font: { sizeScale: 1.125 } } });
    await s.patch({ appearance: { schemaVersion: 2, language: "en", bundleId: "tokyo-night", font: { family: "Pretendard, system-ui, sans-serif" } } });
    expect(s.get("appearance").font).toEqual({
      sizeScale: 1.125,
      family: "Pretendard, system-ui, sans-serif",
    });
  });

  it("patch sizeScale-only preserves a previously patched family (PR #672 review HIGH#1, reverse order)", async () => {
    const s = new SettingsService({ userDataPath });
    await s.patch({ appearance: { schemaVersion: 2, language: "en", bundleId: "tokyo-night", font: { family: "Pretendard, sans-serif" } } });
    await s.patch({ appearance: { schemaVersion: 2, language: "en", bundleId: "tokyo-night", font: { sizeScale: 1.25 } } });
    expect(s.get("appearance").font).toEqual({
      family: "Pretendard, sans-serif",
      sizeScale: 1.25,
    });
  });

  it("validates font.family at patch time — drops injection metachars (PR #672 review MAJOR#4)", async () => {
    const s = new SettingsService({ userDataPath });
    await s.patch({
      appearance: {
        schemaVersion: 2,
        bundleId: "tokyo-night",
        font: { family: 'Arial; color: red; url(http://evil)' },
      },
    });
    expect(s.get("appearance").font?.family).toBeUndefined();
  });

  it("patch accepts unquoted Hangul family names with Unicode-aware validator (PR #672 review CRITICAL#3)", async () => {
    const s = new SettingsService({ userDataPath });
    await s.patch({
      appearance: {
        schemaVersion: 2,
        bundleId: "tokyo-night",
        font: { family: "맑은 고딕, sans-serif" },
      },
    });
    expect(s.get("appearance").font?.family).toBe("맑은 고딕, sans-serif");
  });

  it("rejects font.family containing embedded newlines (PR #672 review MAJOR#6)", async () => {
    const s = new SettingsService({ userDataPath });
    await s.patch({
      appearance: {
        schemaVersion: 2,
        bundleId: "tokyo-night",
        font: { family: "Arial\nevil" },
      },
    });
    expect(s.get("appearance").font?.family).toBeUndefined();
  });

  it("patch with `font: null` is a no-op — does not crash on null deref (PR #672 2차 critic N3)", async () => {
    const s = new SettingsService({ userDataPath });
    await s.patch({ appearance: { schemaVersion: 2, language: "en", bundleId: "tokyo-night", font: { sizeScale: 1.125 } } });
    // Caller deliberately sends `font: null` (some defensive call sites do this
    // to "clear" without specifying subfields). Must not throw, must preserve
    // the previously-patched font block.
    await s.patch({ appearance: { schemaVersion: 2, language: "en", bundleId: "tokyo-night", font: null as unknown as { sizeScale: 1 | 1.125 } } });
    expect(s.get("appearance").font?.sizeScale).toBe(1.125);
  });
});
