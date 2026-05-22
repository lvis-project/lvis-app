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
import {
  loadAuthHandlersForMockup as loadAuthModule,
  makeAppIpcInvoker,
  makeAuthLoginMockupDeps as makeDeps,
} from "./test-helpers.js";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
let _isPackaged = false;
const invoke = makeAppIpcInvoker(handlers);

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


const ORIGINAL_ENV = { ...process.env };

beforeEach(async () => {
  handlers.clear();
  _isPackaged = false;
  vi.resetModules();
  // Default: a captured demo key signals demo activation. Individual
  // tests override (delete the key to simulate "no activation captured").
  process.env.LVIS_DEMO_KEY_OPENAI = process.env.LVIS_DEMO_KEY_OPENAI ?? "sk-default-test";
  const mod = await import("../../../main/demo-credentials.js");
  mod.resetDemoCredentialsForTesting();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});


describe("auth:login-mockup IPC handler (#893 top-level)", () => {
  it("rejects bad credentials with invalid-credentials and audits the failure", async () => {
    const deps = makeDeps();
    const { registerAuthHandlers } = await loadAuthModule();
    registerAuthHandlers(deps as never);

    const result = await invoke("lvis:auth:login-mockup", {
      username: "demo",
      password: "wrong",
    });
    expect(result).toEqual({ ok: false, error: "invalid-credentials" });
    expect(deps.auditLogger.log).toHaveBeenCalled();
    expect(deps.settingsService.setSecret).not.toHaveBeenCalled();
  });

  it("returns no-demo-key when the active vendor's env var is missing", async () => {
    delete process.env.LVIS_DEMO_KEY_OPENAI;
    // Path 2 hotfix: default vendor is now azure-foundry; force openai for
    // this scenario so the test's "missing key" assertion stays meaningful
    // for the historical openai default.
    process.env.LVIS_DEMO_VENDOR = "openai";
    const deps = makeDeps();
    const { registerAuthHandlers } = await loadAuthModule();
    registerAuthHandlers(deps as never);

    const result = await invoke("lvis:auth:login-mockup", {
      username: "demo",
      password: "demo123",
    });
    expect(result).toEqual({ ok: false, error: "no-demo-key" });
    expect(deps.settingsService.setSecret).not.toHaveBeenCalled();
  });

  it("uses LVIS_DEMO_VENDOR to pick the active vendor (default azure-foundry, overridable)", async () => {
    // Path 2 hotfix: default is now azure-foundry. The test explicitly
    // sets LVIS_DEMO_VENDOR=openai to exercise the override path.
    process.env.LVIS_DEMO_VENDOR = "openai";
    process.env.LVIS_DEMO_KEY_OPENAI = "sk-demo-test";
    const deps = makeDeps();
    const { registerAuthHandlers } = await loadAuthModule();
    registerAuthHandlers(deps as never);

    const result = await invoke("lvis:auth:login-mockup", {
      username: "demo",
      password: "demo123",
    });
    expect(result).toMatchObject({ ok: true, vendor: "openai" });
    expect(deps.settingsService.setSecret).toHaveBeenCalledWith(
      "llm.apiKey.openai",
      "sk-demo-test",
    );
    expect(deps.rewireReviewerAgent).toHaveBeenCalled();
    expect(deps.conversationLoop.refreshProvider).toHaveBeenCalled();
    expect(deps.refreshActiveLlmWildcard).toHaveBeenCalled();
  });

  it("rolls back LLM settings when reviewer rewire fails", async () => {
    process.env.LVIS_DEMO_VENDOR = "claude";
    process.env.LVIS_DEMO_KEY_CLAUDE = "sk-ant-demo";
    const prevLlm = {
      provider: "openai",
      vendors: { openai: { model: "gpt-4o" }, claude: { model: "claude-sonnet-4-6" } },
    };
    const deps = makeDeps();
    deps.settingsService.get.mockReturnValue(prevLlm);
    deps.rewireReviewerAgent
      .mockImplementationOnce(() => {
        throw new Error("missing reviewer provider");
      })
      .mockImplementationOnce(() => undefined);
    const { registerAuthHandlers } = await loadAuthModule();
    registerAuthHandlers(deps as never);

    const result = await invoke("lvis:auth:login-mockup", {
      username: "demo",
      password: "demo123",
    });

    expect(result).toEqual({ ok: false, error: "reviewer-rewire-failed" });
    expect(deps.settingsService.patch).toHaveBeenNthCalledWith(1, {
      llm: {
        authMode: "login",
        provider: "claude",
      },
    });
    expect(deps.settingsService.replaceLlm).toHaveBeenCalledWith(prevLlm);
    expect(deps.rewireReviewerAgent).toHaveBeenCalledTimes(2);
    expect(deps.conversationLoop.refreshProvider).toHaveBeenCalled();
    expect(deps.refreshActiveLlmWildcard).toHaveBeenCalled();
  });

  it("restores the previous same-vendor API key when reviewer rewire fails", async () => {
    process.env.LVIS_DEMO_VENDOR = "openai";
    process.env.LVIS_DEMO_KEY_OPENAI = "sk-new-demo";
    const deps = makeDeps();
    deps.settingsService.getSecret.mockReturnValue("sk-old-manual");
    deps.rewireReviewerAgent
      .mockImplementationOnce(() => {
        throw new Error("missing reviewer provider");
      })
      .mockImplementationOnce(() => undefined);
    const { registerAuthHandlers } = await loadAuthModule();
    registerAuthHandlers(deps as never);

    const result = await invoke("lvis:auth:login-mockup", {
      username: "demo",
      password: "demo123",
    });

    expect(result).toEqual({ ok: false, error: "reviewer-rewire-failed" });
    expect(deps.settingsService.setSecret).toHaveBeenNthCalledWith(
      1,
      "llm.apiKey.openai",
      "sk-new-demo",
    );
    expect(deps.settingsService.setSecret).toHaveBeenNthCalledWith(
      2,
      "llm.apiKey.openai",
      "sk-old-manual",
    );
    expect(deps.settingsService.deleteSecret).not.toHaveBeenCalled();
  });

  it("flips top-level llm.authMode and llm.provider in the settings patch", async () => {
    process.env.LVIS_DEMO_VENDOR = "claude";
    process.env.LVIS_DEMO_KEY_CLAUDE = "sk-ant-demo";
    const deps = makeDeps();
    const { registerAuthHandlers } = await loadAuthModule();
    registerAuthHandlers(deps as never);

    const result = await invoke("lvis:auth:login-mockup", {
      username: "demo",
      password: "demo123",
    });
    expect(result).toMatchObject({ ok: true, vendor: "claude" });
    expect(deps.settingsService.patch).toHaveBeenCalled();
    const patchArg = deps.settingsService.patch.mock.calls[0][0];
    expect(patchArg.llm.authMode).toBe("login");
    expect(patchArg.llm.provider).toBe("claude");
  });

  it("honours LVIS_DEMO_USER / LVIS_DEMO_PASS env overrides", async () => {
    process.env.LVIS_DEMO_USER = "alice";
    process.env.LVIS_DEMO_PASS = "secret";
    process.env.LVIS_DEMO_VENDOR = "claude";
    process.env.LVIS_DEMO_KEY_CLAUDE = "sk-ant-demo";
    const deps = makeDeps();
    const { registerAuthHandlers } = await loadAuthModule();
    registerAuthHandlers(deps as never);

    const denied = await invoke("lvis:auth:login-mockup", {
      username: "demo",
      password: "demo123",
    });
    expect(denied).toEqual({ ok: false, error: "invalid-credentials" });

    const ok = await invoke("lvis:auth:login-mockup", {
      username: "alice",
      password: "secret",
    });
    expect(ok).toMatchObject({ ok: true, vendor: "claude" });
    expect(deps.settingsService.setSecret).toHaveBeenCalledWith(
      "llm.apiKey.claude",
      "sk-ant-demo",
    );
  });

  it("maps kebab-case vendor ids to underscored env-var suffixes", async () => {
    process.env.LVIS_DEMO_VENDOR = "azure-foundry";
    process.env.LVIS_DEMO_KEY_AZURE_FOUNDRY = "sk-azure-demo";
    process.env.LVIS_DEMO_BASEURL_AZURE_FOUNDRY =
      "https://example.openai.azure.com/openai/v1/";
    process.env.LVIS_DEMO_HOST_MAP = "example.openai.azure.com=10.182.192.24";
    const deps = makeDeps();
    const { registerAuthHandlers, demoKeyEnvVar } = await loadAuthModule();
    registerAuthHandlers(deps as never);
    expect(demoKeyEnvVar("azure-foundry")).toBe("LVIS_DEMO_KEY_AZURE_FOUNDRY");

    const result = await invoke("lvis:auth:login-mockup", {
      username: "demo",
      password: "demo123",
    });
    expect(result).toMatchObject({ ok: true, vendor: "azure-foundry" });
    expect(deps.settingsService.setSecret).toHaveBeenCalledWith(
      "llm.apiKey.azure-foundry",
      "sk-azure-demo",
    );
  });

  // PR #894 review B1 — production gate
  it("skips handler registration in packaged builds when no demo activation was captured", async () => {
    _isPackaged = true;
    delete process.env.LVIS_DEMO_KEY_OPENAI;
    const deps = makeDeps();
    const { registerAuthHandlers } = await loadAuthModule();
    registerAuthHandlers(deps as never);

    expect(handlers.has("lvis:auth:login-mockup")).toBe(false);
  });

  it("registers handler in packaged builds when demo key was captured pre-scrub", async () => {
    _isPackaged = true;
    // Path 2 hotfix: default vendor is now azure-foundry; pin to openai
    // to preserve the historical assertion shape.
    process.env.LVIS_DEMO_VENDOR = "openai";
    process.env.LVIS_DEMO_KEY_OPENAI = "sk-demo-prod-test";
    const deps = makeDeps();
    const { registerAuthHandlers } = await loadAuthModule();
    registerAuthHandlers(deps as never);

    expect(handlers.has("lvis:auth:login-mockup")).toBe(true);
    const result = await invoke("lvis:auth:login-mockup", {
      username: "demo",
      password: "demo123",
    });
    expect(result).toMatchObject({ ok: true, vendor: "openai" });
  });

  it("registers handler in dev builds even when no demo activation was captured", async () => {
    _isPackaged = false;
    delete process.env.LVIS_DEMO_KEY_OPENAI;
    const deps = makeDeps();
    const { registerAuthHandlers } = await loadAuthModule();
    registerAuthHandlers(deps as never);

    expect(handlers.has("lvis:auth:login-mockup")).toBe(true);
  });

  // v0.2.1 hotfix — Step 2 (llm-key-issuing) try/catch + Step 3
  // rollback inner try/catch. The user-reported "sandbox 준비 중" fail
  // was rooted in an unhandled throw from setSecret / replaceLlm.
  it("returns llm-key-issuing-failed when setSecret throws (Step 2)", async () => {
    process.env.LVIS_DEMO_VENDOR = "openai";
    process.env.LVIS_DEMO_KEY_OPENAI = "sk-issuing-fail-test";
    const deps = makeDeps();
    deps.settingsService.setSecret.mockImplementationOnce(async () => {
      throw new Error("EACCES: keychain access denied");
    });
    const { registerAuthHandlers } = await loadAuthModule();
    registerAuthHandlers(deps as never);

    const result = await invoke("lvis:auth:login-mockup", {
      username: "demo",
      password: "demo123",
    });
    expect(result).toEqual({ ok: false, error: "llm-key-issuing-failed" });
    // Best-effort rollback ran (no prior key → deleteSecret path).
    expect(deps.settingsService.deleteSecret).toHaveBeenCalledWith(
      "llm.apiKey.openai",
    );
    // Step 3 (rewireReviewerAgent) MUST NOT run after Step 2 failed.
    expect(deps.rewireReviewerAgent).not.toHaveBeenCalled();
  });

  it("returns llm-key-issuing-failed when settings.patch throws (Step 2)", async () => {
    process.env.LVIS_DEMO_VENDOR = "openai";
    process.env.LVIS_DEMO_KEY_OPENAI = "sk-patch-fail-test";
    const deps = makeDeps();
    deps.settingsService.patch.mockImplementationOnce(async () => {
      throw new Error("ENOSPC: disk full");
    });
    const { registerAuthHandlers } = await loadAuthModule();
    registerAuthHandlers(deps as never);

    const result = await invoke("lvis:auth:login-mockup", {
      username: "demo",
      password: "demo123",
    });
    expect(result).toEqual({ ok: false, error: "llm-key-issuing-failed" });
    expect(deps.rewireReviewerAgent).not.toHaveBeenCalled();
  });

  it("still returns reviewer-rewire-failed when Step 3 rollback replaceLlm throws", async () => {
    process.env.LVIS_DEMO_VENDOR = "claude";
    process.env.LVIS_DEMO_KEY_CLAUDE = "sk-ant-rollback-throw";
    const deps = makeDeps();
    deps.rewireReviewerAgent
      .mockImplementationOnce(() => {
        throw new Error("missing reviewer provider");
      })
      .mockImplementationOnce(() => undefined);
    // Simulate the rollback inner throwing — IPC contract MUST still
    // resolve to the kebab-case error envelope, never reject.
    deps.settingsService.replaceLlm.mockImplementationOnce(async () => {
      throw new Error("EACCES: settings file locked");
    });
    const { registerAuthHandlers } = await loadAuthModule();
    registerAuthHandlers(deps as never);

    const result = await invoke("lvis:auth:login-mockup", {
      username: "demo",
      password: "demo123",
    });
    expect(result).toEqual({ ok: false, error: "reviewer-rewire-failed" });
  });

  // PR #894 review T1-10 — audit log fingerprint redaction
  it("redacts keySource from the audit log to `present` on successful login", async () => {
    // Path 2 hotfix: pin vendor to openai to preserve historical scenario
    // (default vendor changed to azure-foundry).
    process.env.LVIS_DEMO_VENDOR = "openai";
    process.env.LVIS_DEMO_KEY_OPENAI = "sk-redact-test";
    const deps = makeDeps();
    const { registerAuthHandlers } = await loadAuthModule();
    registerAuthHandlers(deps as never);

    await invoke("lvis:auth:login-mockup", {
      username: "demo",
      password: "demo123",
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
