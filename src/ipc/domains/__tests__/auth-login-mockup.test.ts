/**
 * #893 — Auth IPC mockup login handler tests.
 *
 * Verifies the kebab-case English `error` code contract, env-override
 * credential check, demo-key env-var sourcing, and the side-effect of
 * persisting the resolved key under `llm.apiKey.<vendor>`.
 *
 * PR #894 review B1 / T1-10 — tests cover the production gate (handler
 * skipped when `getIsPackaged() && !isDemoEnabled()`) and the redacted
 * audit `keySource=present` fingerprint.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
let _isPackaged = false;

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
}));

vi.mock("../../../boot/dev-flags.js", () => ({
  getIsPackaged: vi.fn(() => _isPackaged),
}));

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`No handler registered for: ${channel}`);
  return Promise.resolve(
    fn(
      { frameId: 0, processId: 0, frame: { url: "lvis://app" } } as never,
      ...args,
    ),
  );
}

function makeDeps() {
  return {
    settingsService: {
      setSecret: vi.fn(async () => undefined),
    },
    auditLogger: { log: vi.fn() },
    refreshActiveLlmWildcard: vi.fn(),
  };
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(async () => {
  handlers.clear();
  _isPackaged = false;
  vi.resetModules();
  // Default: enable demo so handler registers. Individual tests override.
  process.env.LVIS_DEMO_ENABLED = "1";
  process.env.LVIS_DEMO_KEY_OPENAI = process.env.LVIS_DEMO_KEY_OPENAI ?? "";
  const mod = await import("../../../main/demo-credentials.js");
  mod.resetDemoCredentialsForTesting();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

async function loadAuthModule() {
  const demoMod = await import("../../../main/demo-credentials.js");
  demoMod.resetDemoCredentialsForTesting();
  demoMod.captureDemoCredentials();
  return await import("../auth.js");
}

describe("auth:login-mockup IPC handler (#893)", () => {
  it("rejects unknown vendors with invalid-vendor", async () => {
    const deps = makeDeps();
    const { registerAuthHandlers } = await loadAuthModule();
    registerAuthHandlers(deps as never);

    const result = await invoke("lvis:auth:login-mockup", {
      username: "demo",
      password: "demo123",
      vendor: "not-a-vendor",
    });
    expect(result).toEqual({ ok: false, error: "invalid-vendor" });
    expect(deps.settingsService.setSecret).not.toHaveBeenCalled();
  });

  it("rejects bad credentials with invalid-credentials and audits the failure", async () => {
    const deps = makeDeps();
    const { registerAuthHandlers } = await loadAuthModule();
    registerAuthHandlers(deps as never);

    const result = await invoke("lvis:auth:login-mockup", {
      username: "demo",
      password: "wrong",
      vendor: "openai",
    });
    expect(result).toEqual({ ok: false, error: "invalid-credentials" });
    expect(deps.auditLogger.log).toHaveBeenCalled();
    expect(deps.settingsService.setSecret).not.toHaveBeenCalled();
  });

  it("returns no-demo-key when the per-vendor env var is missing", async () => {
    delete process.env.LVIS_DEMO_KEY_OPENAI;
    const deps = makeDeps();
    const { registerAuthHandlers } = await loadAuthModule();
    registerAuthHandlers(deps as never);

    const result = await invoke("lvis:auth:login-mockup", {
      username: "demo",
      password: "demo123",
      vendor: "openai",
    });
    expect(result).toEqual({ ok: false, error: "no-demo-key" });
    expect(deps.settingsService.setSecret).not.toHaveBeenCalled();
  });

  it("persists the demo key under llm.apiKey.<vendor> on success", async () => {
    process.env.LVIS_DEMO_KEY_OPENAI = "sk-demo-test";
    const deps = makeDeps();
    const { registerAuthHandlers } = await loadAuthModule();
    registerAuthHandlers(deps as never);

    const result = await invoke("lvis:auth:login-mockup", {
      username: "demo",
      password: "demo123",
      vendor: "openai",
    });
    expect(result).toMatchObject({ ok: true, vendor: "openai" });
    expect(deps.settingsService.setSecret).toHaveBeenCalledWith(
      "llm.apiKey.openai",
      "sk-demo-test",
    );
    expect(deps.refreshActiveLlmWildcard).toHaveBeenCalled();
  });

  it("honours LVIS_DEMO_USER / LVIS_DEMO_PASS env overrides", async () => {
    process.env.LVIS_DEMO_USER = "alice";
    process.env.LVIS_DEMO_PASS = "secret";
    process.env.LVIS_DEMO_KEY_CLAUDE = "sk-ant-demo";
    const deps = makeDeps();
    const { registerAuthHandlers } = await loadAuthModule();
    registerAuthHandlers(deps as never);

    const denied = await invoke("lvis:auth:login-mockup", {
      username: "demo",
      password: "demo123",
      vendor: "claude",
    });
    expect(denied).toEqual({ ok: false, error: "invalid-credentials" });

    const ok = await invoke("lvis:auth:login-mockup", {
      username: "alice",
      password: "secret",
      vendor: "claude",
    });
    expect(ok).toMatchObject({ ok: true, vendor: "claude" });
    expect(deps.settingsService.setSecret).toHaveBeenCalledWith(
      "llm.apiKey.claude",
      "sk-ant-demo",
    );
  });

  it("maps kebab-case vendor ids to underscored env-var suffixes", async () => {
    process.env.LVIS_DEMO_KEY_AZURE_FOUNDRY = "sk-azure-demo";
    const deps = makeDeps();
    const { registerAuthHandlers, demoKeyEnvVar } = await loadAuthModule();
    registerAuthHandlers(deps as never);
    expect(demoKeyEnvVar("azure-foundry")).toBe("LVIS_DEMO_KEY_AZURE_FOUNDRY");

    const result = await invoke("lvis:auth:login-mockup", {
      username: "demo",
      password: "demo123",
      vendor: "azure-foundry",
    });
    expect(result).toMatchObject({ ok: true, vendor: "azure-foundry" });
    expect(deps.settingsService.setSecret).toHaveBeenCalledWith(
      "llm.apiKey.azure-foundry",
      "sk-azure-demo",
    );
  });

  // PR #894 review B1 — production gate
  it("skips handler registration in packaged builds when LVIS_DEMO_ENABLED is unset", async () => {
    _isPackaged = true;
    delete process.env.LVIS_DEMO_ENABLED;
    const deps = makeDeps();
    const { registerAuthHandlers } = await loadAuthModule();
    registerAuthHandlers(deps as never);

    expect(handlers.has("lvis:auth:login-mockup")).toBe(false);
  });

  it("registers handler in packaged builds when LVIS_DEMO_ENABLED=1 was captured pre-scrub", async () => {
    _isPackaged = true;
    process.env.LVIS_DEMO_ENABLED = "1";
    process.env.LVIS_DEMO_KEY_OPENAI = "sk-demo-prod-test";
    const deps = makeDeps();
    const { registerAuthHandlers } = await loadAuthModule();
    registerAuthHandlers(deps as never);

    expect(handlers.has("lvis:auth:login-mockup")).toBe(true);
    const result = await invoke("lvis:auth:login-mockup", {
      username: "demo",
      password: "demo123",
      vendor: "openai",
    });
    expect(result).toMatchObject({ ok: true, vendor: "openai" });
  });

  it("registers handler in dev builds even when LVIS_DEMO_ENABLED is unset", async () => {
    _isPackaged = false;
    delete process.env.LVIS_DEMO_ENABLED;
    process.env.LVIS_DEMO_KEY_OPENAI = "sk-dev-test";
    const deps = makeDeps();
    const { registerAuthHandlers } = await loadAuthModule();
    registerAuthHandlers(deps as never);

    expect(handlers.has("lvis:auth:login-mockup")).toBe(true);
  });

  // PR #894 review T1-10 — audit log fingerprint redaction
  it("redacts keySource from the audit log to `present` on successful login", async () => {
    process.env.LVIS_DEMO_KEY_OPENAI = "sk-redact-test";
    const deps = makeDeps();
    const { registerAuthHandlers } = await loadAuthModule();
    registerAuthHandlers(deps as never);

    await invoke("lvis:auth:login-mockup", {
      username: "demo",
      password: "demo123",
      vendor: "openai",
    });

    const calls = deps.auditLogger.log.mock.calls;
    const successCall = calls.find((c) => {
      const input = (c[0] as { input?: string }).input ?? "";
      return input.startsWith("login_mockup_ok");
    });
    expect(successCall).toBeDefined();
    const successInput = (successCall![0] as { input: string }).input;
    expect(successInput).toContain("keySource=present");
    expect(successInput).not.toContain("LVIS_DEMO_KEY_");
  });
});
