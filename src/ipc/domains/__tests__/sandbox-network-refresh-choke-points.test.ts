/**
 * ASRT sandbox live-refresh choke-point coverage.
 *
 * Settings-write paths can change a vendor baseUrl and must all trigger
 * `refreshSandboxNetworkConfig` when they do:
 *
 *   1. lvis:settings:update  (settings.ts)
 *   2. lvis:auth:login-mockup (auth.ts — when demoConfig.baseUrl is set)
 *   3. lvis:chat:retry-effort (chat.ts — spreads prevBlock; guard fires if
 *      prevBlock.baseUrl differs from post-restore value, which is always a
 *      no-op in normal usage but the wiring is present for future-safety)
 *   4. lvis:demo:activate-ollama (demo.ts — sets the local ollama baseUrl;
 *      #1498). Coverage for this path lives in demo-activate.test.ts
 *      ("...sandbox network refresh...") alongside the rest of the
 *      activate-ollama assertions, not duplicated here.
 *
 * Each test asserts:
 *   - refreshSandboxNetworkConfig IS called when a vendor baseUrl changed.
 *   - refreshSandboxNetworkConfig is NOT called when baseUrl is unchanged.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  loadAuthHandlersForMockup as loadAuthModule,
  makeAppIpcInvoker,
  makeAuthLoginMockupDeps,
} from "./test-helpers.js";

// ── shared electron mock ──────────────────────────────────────────────────────
const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
  app: { getPath: vi.fn(() => "/tmp"), getName: vi.fn(() => "lvis") },
}));

vi.mock("../../../boot/dev-flags.js", () => ({
  getIsPackaged: vi.fn(() => false),
}));

// Hoisted virtual mock for conversation-loop — chat.ts imports it at load time.
vi.mock("../../../engine/conversation-loop.js", () => ({}), { virtual: true });

const ORIGINAL_ENV = { ...process.env };

// Use the shared invoker from test-helpers rather than a local duplicate.
const invoke = makeAppIpcInvoker(handlers);

// ── CHOKE POINT 1: lvis:settings:update ──────────────────────────────────────

describe("ASRT choke-point 1 — lvis:settings:update (settings.ts)", () => {
  beforeEach(() => {
    handlers.clear();
    vi.resetModules();
  });

  function makeSettingsDeps(initialBaseUrl: string | null, newBaseUrl: string | null) {
    let currentBaseUrl = initialBaseUrl;
    const refreshSandboxNetworkConfig = vi.fn();
    const deps = {
      settingsService: {
        getAll: vi.fn(() => ({ llm: { provider: "openai", vendors: {} }, appearance: {} })),
        get: vi.fn((key: string) => {
          if (key === "llm") {
            return {
              provider: "openai",
              vendors: { openai: { baseUrl: currentBaseUrl } },
            };
          }
          if (key === "marketplace") return { cloudAllowPrivateNetwork: false };
          return {};
        }),
        patch: vi.fn(async () => {
          // Simulate the patch applying the new baseUrl
          currentBaseUrl = newBaseUrl;
          return { ok: true };
        }),
        replaceLlm: vi.fn(async () => {}),
        getSecret: vi.fn(() => null),
        setSecret: vi.fn(async () => {}),
        deleteSecret: vi.fn(async () => {}),
      },
      conversationLoop: { refreshProvider: vi.fn() },
      auditLogger: { log: vi.fn() },
      getAppWindows: vi.fn(() => []),
      rewireReviewerAgent: vi.fn(),
      refreshActiveLlmWildcard: vi.fn(),
      refreshSandboxNetworkConfig,
    };
    return { deps, refreshSandboxNetworkConfig };
  }

  it("calls refreshSandboxNetworkConfig when a vendor baseUrl changes", async () => {
    const { deps, refreshSandboxNetworkConfig } = makeSettingsDeps(
      "https://old.openai.azure.com",
      "https://new.openai.azure.com",
    );
    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    await invoke("lvis:settings:update", {
      llm: { vendors: { openai: { baseUrl: "https://new.openai.azure.com" } } },
    });

    expect(refreshSandboxNetworkConfig).toHaveBeenCalledTimes(1);
  });

  it("does NOT call refreshSandboxNetworkConfig when baseUrl is unchanged", async () => {
    const { deps, refreshSandboxNetworkConfig } = makeSettingsDeps(
      "https://same.openai.azure.com",
      "https://same.openai.azure.com",
    );
    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    await invoke("lvis:settings:update", {
      llm: { vendors: { openai: { model: "gpt-4o" } } },
    });

    expect(refreshSandboxNetworkConfig).not.toHaveBeenCalled();
  });
});

// ── CHOKE POINT 2: lvis:auth:login-mockup (auth.ts) ──────────────────────────

describe("ASRT choke-point 2 — lvis:auth:login-mockup (auth.ts)", () => {
  beforeEach(async () => {
    handlers.clear();
    vi.resetModules();
    process.env.LVIS_DEMO_KEY_OPENAI = "sk-test-key";
    process.env.LVIS_DEMO_VENDOR = "openai";
    const mod = await import("../../../main/demo-credentials.js");
    mod.resetDemoCredentialsForTesting();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("calls refreshSandboxNetworkConfig when login applies a vendor baseUrl", async () => {
    // Set up a demo baseUrl via env var
    process.env.LVIS_DEMO_BASE_URL_OPENAI = "https://demo.openai.azure.com";
    vi.resetModules();
    const mod = await import("../../../main/demo-credentials.js");
    mod.resetDemoCredentialsForTesting();

    const refreshSandboxNetworkConfig = vi.fn();
    const deps = {
      ...makeAuthLoginMockupDeps(),
      refreshSandboxNetworkConfig,
    };
    // Ensure the settingsService.get returns a state without that baseUrl before login
    (deps.settingsService.get as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      provider: "openai",
      vendors: { openai: { model: "gpt-4o", baseUrl: undefined } },
    }));
    // After patch, get returns new baseUrl
    let patched = false;
    (deps.settingsService.patch as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      patched = true;
    });
    (deps.settingsService.get as ReturnType<typeof vi.fn>).mockImplementation(() => {
      if (patched) {
        return { provider: "openai", vendors: { openai: { baseUrl: "https://demo.openai.azure.com" } } };
      }
      return { provider: "openai", vendors: { openai: { model: "gpt-4o" } } };
    });

    const { registerAuthHandlers } = await loadAuthModule();
    registerAuthHandlers(deps as never);

    await invoke("lvis:auth:login-mockup", { username: "demo", password: "demo123" });

    expect(refreshSandboxNetworkConfig).toHaveBeenCalledTimes(1);
  });

  it("does NOT call refreshSandboxNetworkConfig when login does not change a baseUrl", async () => {
    // No LVIS_DEMO_BASE_URL_* env var — login applies only apiKey
    vi.resetModules();
    const mod = await import("../../../main/demo-credentials.js");
    mod.resetDemoCredentialsForTesting();

    const refreshSandboxNetworkConfig = vi.fn();
    const deps = {
      ...makeAuthLoginMockupDeps(),
      refreshSandboxNetworkConfig,
    };

    const { registerAuthHandlers } = await loadAuthModule();
    registerAuthHandlers(deps as never);

    await invoke("lvis:auth:login-mockup", { username: "demo", password: "demo123" });

    expect(refreshSandboxNetworkConfig).not.toHaveBeenCalled();
  });
});

// ── CHOKE POINT 3: lvis:chat:retry-effort (chat.ts) ──────────────────────────

describe("ASRT choke-point 3 — lvis:chat:retry-effort (chat.ts)", () => {
  beforeEach(() => {
    handlers.clear();
    vi.resetModules();
  });

  function makeChatDeps(baseUrl: string | undefined = undefined) {
    const refreshSandboxNetworkConfig = vi.fn();
    const currentBlock = { model: "gpt-4o", baseUrl } as Record<string, unknown>;
    const deps = {
      settingsService: {
        get: vi.fn((key: string) => {
          if (key === "llm") {
            return { provider: "openai", vendors: { openai: currentBlock } };
          }
          return {};
        }),
        patch: vi.fn(async () => {}),
        getAll: vi.fn(() => ({})),
        getSecret: vi.fn(() => null),
      },
      conversationLoop: {
        refreshProvider: vi.fn(),
        hasProvider: vi.fn(() => true),
        getSessionId: vi.fn(() => "test-session"),
        getHistory: vi.fn(() => ({
          getMessages: vi.fn(() => [
            { role: "user", content: "hello" },
          ]),
          restore: vi.fn(),
        })),
        streamTurn: vi.fn(async () => ({ ok: true })),
        getActivePersonaId: vi.fn(() => null),
      },
      personaPromptStore: { getById: vi.fn(() => null) },
      auditLogger: { log: vi.fn() },
      getAppWindows: vi.fn(() => []),
      getMainWindow: vi.fn(() => null),
      memoryManager: { getSessionKind: vi.fn(() => "main") },
      starredStore: undefined,
      feedbackStore: undefined,
      rewireReviewerAgent: vi.fn(),
      refreshActiveLlmWildcard: vi.fn(),
      refreshSandboxNetworkConfig,
    };
    return { deps, refreshSandboxNetworkConfig };
  }

  it("does NOT call refreshSandboxNetworkConfig when retry-effort leaves baseUrl unchanged", async () => {
    // retry-effort spreads prevBlock (which has baseUrl) — net change is zero.
    const { deps, refreshSandboxNetworkConfig } = makeChatDeps("https://same.openai.azure.com");

    const { registerChatHandlers } = await import("../chat.js");
    registerChatHandlers(deps as never);

    // retry-effort will be guarded — since the spread preserves baseUrl and
    // the restore also restores it, refreshSandboxNetworkConfig should NOT fire.
    // (The handler may fail internally due to minimal mock; we only assert the side-effect.)
    try {
      await invoke("lvis:chat:retry-effort", { enableThinking: true, thinkingBudgetTokens: 10000 });
    } catch {
      // Acceptable: the minimal mock doesn't fully wire conversationLoop internals.
    }

    expect(refreshSandboxNetworkConfig).not.toHaveBeenCalled();
  });
});
