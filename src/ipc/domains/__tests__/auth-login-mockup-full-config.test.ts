/**
 * Auth IPC login-mockup tests — full vendor config application (#893).
 *
 * Verifies that after a successful login the handler applies not just
 * apiKey but also baseUrl / model / vertexProject / vertexLocation when
 * the corresponding LVIS_DEMO_* env vars are present.
 *
 * Also verifies backward compat: when only LVIS_DEMO_KEY_<VENDOR> is set
 * (no extra env vars), only apiKey is applied and settingsService.patch
 * is never called.
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
      get: vi.fn(() => ({
        provider: "openai",
        vendors: { openai: { model: "gpt-4o" } },
      })),
      getSecret: vi.fn(() => null),
      setSecret: vi.fn(async () => undefined),
      deleteSecret: vi.fn(async () => undefined),
      patch: vi.fn(async () => undefined),
    },
    auditLogger: { log: vi.fn() },
    conversationLoop: { refreshProvider: vi.fn() },
    rewireReviewerAgent: vi.fn(),
    refreshActiveLlmWildcard: vi.fn(),
  };
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(async () => {
  handlers.clear();
  _isPackaged = false;
  vi.resetModules();
  process.env.LVIS_DEMO_ENABLED = "1";
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

describe("auth:login-mockup — full vendor config application (#893)", () => {
  it("applies only apiKey when no extra demo env vars are set (backward compat)", async () => {
    process.env.LVIS_DEMO_KEY_OPENAI = "sk-openai-only";
    // No LVIS_DEMO_BASEURL_OPENAI, no LVIS_DEMO_MODEL_OPENAI.
    const deps = makeDeps();
    const { registerAuthHandlers } = await loadAuthModule();
    registerAuthHandlers(deps as never);

    const result = await invoke("lvis:auth:login-mockup", {
      username: "demo",
      password: "demo123",
    }) as { ok: boolean; fieldsApplied?: string[] };

    expect(result.ok).toBe(true);
    expect(result.fieldsApplied).toEqual(["apiKey"]);
    expect(deps.settingsService.setSecret).toHaveBeenCalledWith(
      "llm.apiKey.openai",
      "sk-openai-only",
    );
    // patch is always called now (to flip authMode + provider at top level)
    // even when there are no extra vendor fields.
    expect(deps.settingsService.patch).toHaveBeenCalled();
    const patchArg = deps.settingsService.patch.mock.calls[0][0];
    expect(patchArg.llm.authMode).toBe("login");
    expect(patchArg.llm.provider).toBe("openai");
    // No `vendors` key when there are no extra fields to apply.
    expect(patchArg.llm.vendors).toBeUndefined();
  });

  it("applies apiKey + baseUrl when LVIS_DEMO_BASEURL_<VENDOR> is set", async () => {
    process.env.LVIS_DEMO_VENDOR = "azure-foundry";
    process.env.LVIS_DEMO_KEY_AZURE_FOUNDRY = "sk-azure-key";
    process.env.LVIS_DEMO_BASEURL_AZURE_FOUNDRY = "https://my-resource.openai.azure.com/";
    const deps = makeDeps();
    const { registerAuthHandlers } = await loadAuthModule();
    registerAuthHandlers(deps as never);

    const result = await invoke("lvis:auth:login-mockup", {
      username: "demo",
      password: "demo123",
    }) as { ok: boolean; vendor: string; fieldsApplied?: string[] };

    expect(result.ok).toBe(true);
    expect(result.fieldsApplied).toContain("apiKey");
    expect(result.fieldsApplied).toContain("baseUrl");
    expect(deps.settingsService.setSecret).toHaveBeenCalledWith(
      "llm.apiKey.azure-foundry",
      "sk-azure-key",
    );
    expect(deps.settingsService.patch).toHaveBeenCalledWith({
      llm: {
        authMode: "login",
        provider: "azure-foundry",
        vendors: {
          "azure-foundry": expect.objectContaining({ baseUrl: "https://my-resource.openai.azure.com/" }),
        },
      },
    });
  });

  it("applies apiKey + model when LVIS_DEMO_MODEL_<VENDOR> is set", async () => {
    process.env.LVIS_DEMO_KEY_OPENAI = "sk-openai-key";
    process.env.LVIS_DEMO_MODEL_OPENAI = "gpt-5";
    const deps = makeDeps();
    const { registerAuthHandlers } = await loadAuthModule();
    registerAuthHandlers(deps as never);

    const result = await invoke("lvis:auth:login-mockup", {
      username: "demo",
      password: "demo123",
    }) as { ok: boolean; fieldsApplied?: string[]; model?: string };

    expect(result.ok).toBe(true);
    expect(result.fieldsApplied).toContain("model");
    expect(result.model).toBe("gpt-5");
    expect(deps.settingsService.patch).toHaveBeenCalledWith({
      llm: {
        authMode: "login",
        provider: "openai",
        vendors: { openai: expect.objectContaining({ model: "gpt-5" }) },
      },
    });
  });

  it("applies apiKey + vertexProject + vertexLocation for vertex-ai", async () => {
    process.env.LVIS_DEMO_VENDOR = "vertex-ai";
    process.env.LVIS_DEMO_KEY_VERTEX_AI = "ignored-key";
    process.env.LVIS_DEMO_VERTEX_PROJECT = "my-gcp-project";
    process.env.LVIS_DEMO_VERTEX_LOCATION = "us-central1";
    const deps = makeDeps();
    const { registerAuthHandlers } = await loadAuthModule();
    registerAuthHandlers(deps as never);

    const result = await invoke("lvis:auth:login-mockup", {
      username: "demo",
      password: "demo123",
    }) as { ok: boolean; fieldsApplied?: string[] };

    expect(result.ok).toBe(true);
    expect(result.fieldsApplied).toContain("vertexProject");
    expect(result.fieldsApplied).toContain("vertexLocation");
    expect(deps.settingsService.patch).toHaveBeenCalledWith({
      llm: {
        authMode: "login",
        provider: "vertex-ai",
        vendors: {
          "vertex-ai": expect.objectContaining({
            vertexProject: "my-gcp-project",
            vertexLocation: "us-central1",
          }),
        },
      },
    });
  });

  it("applies all fields when all env vars are present", async () => {
    process.env.LVIS_DEMO_VENDOR = "azure-foundry";
    process.env.LVIS_DEMO_KEY_AZURE_FOUNDRY = "sk-full-config";
    process.env.LVIS_DEMO_BASEURL_AZURE_FOUNDRY = "https://resource.openai.azure.com/";
    process.env.LVIS_DEMO_MODEL_AZURE_FOUNDRY = "gpt-4o-deployment";
    const deps = makeDeps();
    const { registerAuthHandlers } = await loadAuthModule();
    registerAuthHandlers(deps as never);

    const result = await invoke("lvis:auth:login-mockup", {
      username: "demo",
      password: "demo123",
    }) as { ok: boolean; fieldsApplied?: string[] };

    expect(result.ok).toBe(true);
    expect(result.fieldsApplied).toEqual(
      expect.arrayContaining(["apiKey", "baseUrl", "model"]),
    );
    expect(deps.settingsService.patch).toHaveBeenCalledWith({
      llm: {
        authMode: "login",
        provider: "azure-foundry",
        vendors: {
          "azure-foundry": {
            baseUrl: "https://resource.openai.azure.com/",
            model: "gpt-4o-deployment",
          },
        },
      },
    });
  });

  it("returns { ok: true, vendor, fieldsApplied } shape on success", async () => {
    process.env.LVIS_DEMO_VENDOR = "claude";
    process.env.LVIS_DEMO_KEY_CLAUDE = "sk-ant-demo";
    const deps = makeDeps();
    const { registerAuthHandlers } = await loadAuthModule();
    registerAuthHandlers(deps as never);

    const result = await invoke("lvis:auth:login-mockup", {
      username: "demo",
      password: "demo123",
    });

    expect(result).toMatchObject({ ok: true, vendor: "claude", fieldsApplied: ["apiKey"] });
  });

  it("calls patch even when only apiKey is provided — flips top-level authMode", async () => {
    process.env.LVIS_DEMO_VENDOR = "gemini";
    process.env.LVIS_DEMO_KEY_GEMINI = "gemini-demo-key";
    const deps = makeDeps();
    const { registerAuthHandlers } = await loadAuthModule();
    registerAuthHandlers(deps as never);

    await invoke("lvis:auth:login-mockup", {
      username: "demo",
      password: "demo123",
    });

    // patch is now ALWAYS called — it carries the top-level authMode/provider
    // flip. No `vendors` key when there are no extra fields to apply, so the
    // user's existing per-vendor settings are preserved.
    expect(deps.settingsService.patch).toHaveBeenCalled();
    const patchArg = deps.settingsService.patch.mock.calls[0][0];
    expect(patchArg.llm.authMode).toBe("login");
    expect(patchArg.llm.provider).toBe("gemini");
    expect(patchArg.llm.vendors).toBeUndefined();
  });
});
