/**
 * #893 — Auth IPC mockup login handler tests.
 *
 * Verifies the kebab-case English `error` code contract, env-override
 * credential check, demo-key env-var sourcing, and the side-effect of
 * persisting the resolved key under `llm.apiKey.<vendor>`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
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

beforeEach(() => {
  handlers.clear();
  vi.resetModules();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("auth:login-mockup IPC handler (#893)", () => {
  it("rejects unknown vendors with invalid-vendor", async () => {
    const deps = makeDeps();
    const { registerAuthHandlers } = await import("../auth.js");
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
    const { registerAuthHandlers } = await import("../auth.js");
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
    const { registerAuthHandlers } = await import("../auth.js");
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
    const { registerAuthHandlers } = await import("../auth.js");
    registerAuthHandlers(deps as never);

    const result = await invoke("lvis:auth:login-mockup", {
      username: "demo",
      password: "demo123",
      vendor: "openai",
    });
    expect(result).toEqual({ ok: true, vendor: "openai" });
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
    const { registerAuthHandlers } = await import("../auth.js");
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
    expect(ok).toEqual({ ok: true, vendor: "claude" });
    expect(deps.settingsService.setSecret).toHaveBeenCalledWith(
      "llm.apiKey.claude",
      "sk-ant-demo",
    );
  });

  it("maps kebab-case vendor ids to underscored env-var suffixes", async () => {
    process.env.LVIS_DEMO_KEY_AZURE_FOUNDRY = "sk-azure-demo";
    const deps = makeDeps();
    const { registerAuthHandlers, demoKeyEnvVar } = await import("../auth.js");
    registerAuthHandlers(deps as never);
    expect(demoKeyEnvVar("azure-foundry")).toBe("LVIS_DEMO_KEY_AZURE_FOUNDRY");

    const result = await invoke("lvis:auth:login-mockup", {
      username: "demo",
      password: "demo123",
      vendor: "azure-foundry",
    });
    expect(result).toEqual({ ok: true, vendor: "azure-foundry" });
    expect(deps.settingsService.setSecret).toHaveBeenCalledWith(
      "llm.apiKey.azure-foundry",
      "sk-azure-demo",
    );
  });
});
