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
      setSecret: vi.fn(async () => undefined),
      patch: vi.fn(async () => undefined),
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
      vendor: "openai",
    }) as { ok: boolean; fieldsApplied?: string[] };

    expect(result.ok).toBe(true);
    expect(result.fieldsApplied).toEqual(["apiKey"]);
    expect(deps.settingsService.setSecret).toHaveBeenCalledWith(
      "llm.apiKey.openai",
      "sk-openai-only",
    );
    // patch should NOT be called when there are no additional fields.
    expect(deps.settingsService.patch).not.toHaveBeenCalled();
  });

  it("applies apiKey + baseUrl when LVIS_DEMO_BASEURL_<VENDOR> is set", async () => {
    process.env.LVIS_DEMO_KEY_AZURE_FOUNDRY = "sk-azure-key";
    process.env.LVIS_DEMO_BASEURL_AZURE_FOUNDRY = "https://my-resource.openai.azure.com/";
    const deps = makeDeps();
    const { registerAuthHandlers } = await loadAuthModule();
    registerAuthHandlers(deps as never);

    const result = await invoke("lvis:auth:login-mockup", {
      username: "demo",
      password: "demo123",
      vendor: "azure-foundry",
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
      vendor: "openai",
    }) as { ok: boolean; fieldsApplied?: string[] };

    expect(result.ok).toBe(true);
    expect(result.fieldsApplied).toContain("model");
    expect(deps.settingsService.patch).toHaveBeenCalledWith({
      llm: { vendors: { openai: expect.objectContaining({ model: "gpt-5" }) } },
    });
  });

  it("applies apiKey + vertexProject + vertexLocation for vertex-ai", async () => {
    process.env.LVIS_DEMO_KEY_VERTEX_AI = "ignored-key";
    process.env.LVIS_DEMO_VERTEX_PROJECT = "my-gcp-project";
    process.env.LVIS_DEMO_VERTEX_LOCATION = "us-central1";
    const deps = makeDeps();
    const { registerAuthHandlers } = await loadAuthModule();
    registerAuthHandlers(deps as never);

    const result = await invoke("lvis:auth:login-mockup", {
      username: "demo",
      password: "demo123",
      vendor: "vertex-ai",
    }) as { ok: boolean; fieldsApplied?: string[] };

    expect(result.ok).toBe(true);
    expect(result.fieldsApplied).toContain("vertexProject");
    expect(result.fieldsApplied).toContain("vertexLocation");
    expect(deps.settingsService.patch).toHaveBeenCalledWith({
      llm: {
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
    process.env.LVIS_DEMO_KEY_AZURE_FOUNDRY = "sk-full-config";
    process.env.LVIS_DEMO_BASEURL_AZURE_FOUNDRY = "https://resource.openai.azure.com/";
    process.env.LVIS_DEMO_MODEL_AZURE_FOUNDRY = "gpt-4o-deployment";
    const deps = makeDeps();
    const { registerAuthHandlers } = await loadAuthModule();
    registerAuthHandlers(deps as never);

    const result = await invoke("lvis:auth:login-mockup", {
      username: "demo",
      password: "demo123",
      vendor: "azure-foundry",
    }) as { ok: boolean; fieldsApplied?: string[] };

    expect(result.ok).toBe(true);
    expect(result.fieldsApplied).toEqual(
      expect.arrayContaining(["apiKey", "baseUrl", "model"]),
    );
    expect(deps.settingsService.patch).toHaveBeenCalledWith({
      llm: {
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
    process.env.LVIS_DEMO_KEY_CLAUDE = "sk-ant-demo";
    const deps = makeDeps();
    const { registerAuthHandlers } = await loadAuthModule();
    registerAuthHandlers(deps as never);

    const result = await invoke("lvis:auth:login-mockup", {
      username: "demo",
      password: "demo123",
      vendor: "claude",
    });

    expect(result).toMatchObject({ ok: true, vendor: "claude", fieldsApplied: ["apiKey"] });
  });

  it("does not call patch when only apiKey is provided — preserves user-entered fields", async () => {
    process.env.LVIS_DEMO_KEY_GEMINI = "gemini-demo-key";
    const deps = makeDeps();
    const { registerAuthHandlers } = await loadAuthModule();
    registerAuthHandlers(deps as never);

    await invoke("lvis:auth:login-mockup", {
      username: "demo",
      password: "demo123",
      vendor: "gemini",
    });

    // patch must not be called — user's existing baseUrl/model settings are preserved.
    expect(deps.settingsService.patch).not.toHaveBeenCalled();
  });
});
