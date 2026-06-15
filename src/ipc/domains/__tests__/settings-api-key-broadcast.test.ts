/**
 * MAJOR-3 regression: all 4 secret-mutation handlers broadcast SETTINGS.updated
 * to all app windows so the reviewer tab auto-unlocks without a full reload:
 *   - lvis:settings:set-api-key
 *   - lvis:settings:delete-api-key
 *   - lvis:settings:set-web-api-key
 *   - lvis:settings:delete-web-api-key
 *   - lvis:settings:marketplace:set-api-key
 *   - lvis:settings:marketplace:delete-api-key
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SETTINGS } from "../../../shared/ipc-channels.js";

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
  return Promise.resolve(fn({ frameId: 0, processId: 0, frame: { url: "lvis://app" } } as never, ...args));
}

function makeWindow() {
  return {
    isDestroyed: vi.fn(() => false),
    webContents: {
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
    },
  };
}

function makeDeps(appWindows: ReturnType<typeof makeWindow>[], vendorBaseUrl?: string) {
  return {
    settingsService: {
      getAll: vi.fn(() => ({ llm: { provider: "openai" } })),
      get: vi.fn(() => ({
        provider: "openai",
        vendors: { "azure-foundry": { baseUrl: vendorBaseUrl ?? null } },
      })),
      patch: vi.fn(async (p: unknown) => p),
      replaceLlm: vi.fn(async (llm: unknown) => llm),
      getSecret: vi.fn(() => null),
      setSecret: vi.fn(async () => undefined),
      deleteSecret: vi.fn(async () => undefined),
    },
    conversationLoop: {
      refreshProvider: vi.fn(),
    },
    auditLogger: { log: vi.fn() },
    getAppWindows: vi.fn(() => appWindows),
  };
}

beforeEach(() => {
  handlers.clear();
  vi.resetModules();
});

describe("set-api-key broadcast (M3)", () => {
  it("broadcasts SETTINGS.updated to all app windows after storing the key", async () => {
    const windows = [makeWindow(), makeWindow()];
    const deps = makeDeps(windows);
    const snapshot = { llm: { provider: "openai" } };
    deps.settingsService.getAll.mockReturnValue(snapshot);

    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    await invoke("lvis:settings:set-api-key", "claude", "sk-ant-test");

    expect(deps.settingsService.setSecret).toHaveBeenCalledWith("llm.apiKey.claude", "sk-ant-test");
    expect(deps.conversationLoop.refreshProvider).toHaveBeenCalled();
    for (const win of windows) {
      expect(win.webContents.send).toHaveBeenCalledWith(SETTINGS.updated, snapshot);
    }
  });

  it("broadcasts to all windows, skipping destroyed ones via sendToWindow", async () => {
    const liveWindow = makeWindow();
    const deadWindow = makeWindow();
    deadWindow.isDestroyed.mockReturnValue(true);
    const deps = makeDeps([liveWindow, deadWindow]);

    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    await invoke("lvis:settings:set-api-key", "azure-foundry", "az-key");

    // live window gets the broadcast; destroyed window is skipped by sendToWindow
    expect(liveWindow.webContents.send).toHaveBeenCalledWith(SETTINGS.updated, expect.anything());
    expect(deadWindow.webContents.send).not.toHaveBeenCalled();
  });
});

describe("delete-api-key broadcast (MAJOR-3)", () => {
  it("broadcasts SETTINGS.updated to all app windows after deleting the key", async () => {
    const windows = [makeWindow(), makeWindow()];
    const deps = makeDeps(windows);
    const snapshot = { llm: { provider: "openai" } };
    deps.settingsService.getAll.mockReturnValue(snapshot);

    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    await invoke("lvis:settings:delete-api-key", "gemini");

    expect(deps.settingsService.deleteSecret).toHaveBeenCalledWith("llm.apiKey.gemini");
    expect(deps.conversationLoop.refreshProvider).toHaveBeenCalled();
    for (const win of windows) {
      expect(win.webContents.send).toHaveBeenCalledWith(SETTINGS.updated, snapshot);
    }
  });
});

// ─── MAJOR-3: set/delete-web-api-key broadcast ────────────────────────

describe("set-web-api-key broadcast (MAJOR-3)", () => {
  it("broadcasts SETTINGS.updated to all app windows after storing the web key", async () => {
    const windows = [makeWindow(), makeWindow()];
    const deps = makeDeps(windows);
    const snapshot = { llm: { provider: "openai" } };
    deps.settingsService.getAll.mockReturnValue(snapshot);

    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    await invoke("lvis:settings:set-web-api-key", "bing", "bing-key-123");

    expect(deps.settingsService.setSecret).toHaveBeenCalledWith("web.apiKey.bing", "bing-key-123");
    for (const win of windows) {
      expect(win.webContents.send).toHaveBeenCalledWith(SETTINGS.updated, snapshot);
    }
  });
});

describe("delete-web-api-key broadcast (MAJOR-3)", () => {
  it("broadcasts SETTINGS.updated to all app windows after deleting the web key", async () => {
    const windows = [makeWindow(), makeWindow()];
    const deps = makeDeps(windows);
    const snapshot = { llm: { provider: "openai" } };
    deps.settingsService.getAll.mockReturnValue(snapshot);

    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    await invoke("lvis:settings:delete-web-api-key", "bing");

    expect(deps.settingsService.deleteSecret).toHaveBeenCalledWith("web.apiKey.bing");
    for (const win of windows) {
      expect(win.webContents.send).toHaveBeenCalledWith(SETTINGS.updated, snapshot);
    }
  });
});

// ─── MAJOR-3: marketplace:set/delete-api-key broadcast ───────────────

describe("marketplace:set-api-key broadcast (MAJOR-3)", () => {
  it("broadcasts SETTINGS.updated to all app windows after storing marketplace key", async () => {
    const windows = [makeWindow(), makeWindow()];
    const deps = makeDeps(windows);
    const snapshot = { llm: { provider: "openai" } };
    deps.settingsService.getAll.mockReturnValue(snapshot);

    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    await invoke("lvis:settings:marketplace:set-api-key", "mkt-key-xyz");

    expect(deps.settingsService.setSecret).toHaveBeenCalledWith("marketplace.apiKey", "mkt-key-xyz");
    for (const win of windows) {
      expect(win.webContents.send).toHaveBeenCalledWith(SETTINGS.updated, snapshot);
    }
  });
});

describe("marketplace:delete-api-key broadcast (MAJOR-3)", () => {
  it("broadcasts SETTINGS.updated to all app windows after deleting marketplace key", async () => {
    const windows = [makeWindow(), makeWindow()];
    const deps = makeDeps(windows);
    const snapshot = { llm: { provider: "openai" } };
    deps.settingsService.getAll.mockReturnValue(snapshot);

    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    await invoke("lvis:settings:marketplace:delete-api-key");

    expect(deps.settingsService.deleteSecret).toHaveBeenCalledWith("marketplace.apiKey");
    for (const win of windows) {
      expect(win.webContents.send).toHaveBeenCalledWith(SETTINGS.updated, snapshot);
    }
  });
});

// ─── MAJOR-2 R2: settings:update triggers rewireReviewerAgent when baseUrl changes ──

describe("MAJOR-2: settings:update triggers rewireReviewerAgent on azure-foundry baseUrl change", () => {
  it("calls rewireReviewerAgent when the active LLM provider changes", async () => {
    const windows: ReturnType<typeof makeWindow>[] = [];
    const rewire = vi.fn();
    const prevLlm = {
      provider: "openai",
      vendors: {
        openai: { model: "gpt-4o" },
        claude: { model: "claude-sonnet-4-6" },
        "azure-foundry": { baseUrl: null },
      },
    };
    const nextLlm = {
      provider: "claude",
      vendors: {
        openai: { model: "gpt-4o" },
        claude: { model: "claude-sonnet-4-6" },
        "azure-foundry": { baseUrl: null },
      },
    };
    let llmReads = 0;
    const baseDeps = makeDeps(windows);
    const deps = {
      ...baseDeps,
      settingsService: {
        ...baseDeps.settingsService,
        get: vi.fn((key: string) => {
          if (key === "marketplace") return { cloudAllowPrivateNetwork: false };
          llmReads += 1;
          return llmReads === 1 ? prevLlm : nextLlm;
        }),
        patch: vi.fn(async (p: unknown) => p),
      },
      rewireReviewerAgent: rewire,
    };

    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    await invoke("lvis:settings:update", { llm: { provider: "claude" } });

    expect(rewire).toHaveBeenCalledOnce();
  });

  it("calls rewireReviewerAgent when the active LLM model changes", async () => {
    const windows: ReturnType<typeof makeWindow>[] = [];
    const rewire = vi.fn();
    const prevLlm = {
      provider: "openai",
      vendors: {
        openai: { model: "gpt-4o" },
        "azure-foundry": { baseUrl: null },
      },
    };
    const nextLlm = {
      provider: "openai",
      vendors: {
        openai: { model: "gpt-5.4" },
        "azure-foundry": { baseUrl: null },
      },
    };
    let llmReads = 0;
    const baseDeps = makeDeps(windows);
    const deps = {
      ...baseDeps,
      settingsService: {
        ...baseDeps.settingsService,
        get: vi.fn((key: string) => {
          if (key === "marketplace") return { cloudAllowPrivateNetwork: false };
          llmReads += 1;
          return llmReads === 1 ? prevLlm : nextLlm;
        }),
        patch: vi.fn(async (p: unknown) => p),
      },
      rewireReviewerAgent: rewire,
    };

    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    await invoke("lvis:settings:update", {
      llm: { vendors: { openai: { model: "gpt-5.4" } } },
    });

    expect(rewire).toHaveBeenCalledOnce();
  });

  it("rolls back active LLM settings when reviewer rewire fails", async () => {
    const windows: ReturnType<typeof makeWindow>[] = [];
    const rewire = vi.fn()
      .mockImplementationOnce(() => {
        throw new Error("missing reviewer provider");
      })
      .mockImplementationOnce(() => undefined);
    const refreshWildcard = vi.fn();
    const prevLlm = {
      provider: "openai",
      vendors: {
        openai: { model: "gpt-4o" },
        claude: { model: "claude-sonnet-4-6" },
        "azure-foundry": { baseUrl: null },
      },
    };
    const nextLlm = {
      provider: "claude",
      vendors: {
        openai: { model: "gpt-4o" },
        claude: { model: "claude-sonnet-4-6" },
        "azure-foundry": { baseUrl: null },
      },
    };
    let llmReads = 0;
    const patch = vi.fn(async (p: unknown) => p);
    const replaceLlm = vi.fn(async (llm: unknown) => llm);
    const baseDeps = makeDeps(windows);
    const deps = {
      ...baseDeps,
      settingsService: {
        ...baseDeps.settingsService,
        get: vi.fn((key: string) => {
          if (key === "marketplace") return { cloudAllowPrivateNetwork: false };
          llmReads += 1;
          return llmReads === 1 ? prevLlm : nextLlm;
        }),
        patch,
        replaceLlm,
      },
      rewireReviewerAgent: rewire,
      refreshActiveLlmWildcard: refreshWildcard,
    };

    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    const result = await invoke("lvis:settings:update", { llm: { provider: "claude" } });

    expect(result).toMatchObject({
      ok: false,
      error: "reviewer-rewire-failed",
      message: "missing reviewer provider",
    });
    expect(patch).toHaveBeenNthCalledWith(1, { llm: { provider: "claude" } });
    expect(replaceLlm).toHaveBeenCalledWith(prevLlm);
    expect(rewire).toHaveBeenCalledTimes(2);
    expect(deps.conversationLoop.refreshProvider).toHaveBeenCalled();
    expect(refreshWildcard).toHaveBeenCalled();
  });

  it("uses exact LLM replacement rollback when failed update adds active transport fields", async () => {
    const windows: ReturnType<typeof makeWindow>[] = [];
    const rewire = vi.fn()
      .mockImplementationOnce(() => {
        throw new Error("bad transport");
      })
      .mockImplementationOnce(() => undefined);
    const prevLlm = {
      provider: "openai",
      vendors: {
        openai: { model: "gpt-4o" },
        "azure-foundry": { baseUrl: null },
      },
    };
    const nextLlm = {
      provider: "openai",
      vendors: {
        openai: {
          model: "gpt-4o",
          baseUrl: "https://proxy.example/v1",
          vertexProject: "bad-project",
          vertexLocation: "us-central1",
        },
        "azure-foundry": { baseUrl: null },
      },
    };
    let llmReads = 0;
    const replaceLlm = vi.fn(async (llm: unknown) => llm);
    const baseDeps = makeDeps(windows);
    const deps = {
      ...baseDeps,
      settingsService: {
        ...baseDeps.settingsService,
        get: vi.fn((key: string) => {
          if (key === "marketplace") return { cloudAllowPrivateNetwork: false };
          llmReads += 1;
          return llmReads === 1 ? prevLlm : nextLlm;
        }),
        patch: vi.fn(async (p: unknown) => p),
        replaceLlm,
      },
      rewireReviewerAgent: rewire,
    };

    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    const result = await invoke("lvis:settings:update", {
      llm: {
        vendors: {
          openai: {
            baseUrl: "https://proxy.example/v1",
            vertexProject: "bad-project",
            vertexLocation: "us-central1",
          },
        },
      },
    });

    expect(result).toMatchObject({ ok: false, error: "reviewer-rewire-failed" });
    expect(replaceLlm).toHaveBeenCalledWith(prevLlm);
  });

  it("calls rewireReviewerAgent when baseUrl changes from null to a new value", async () => {
    const windows: ReturnType<typeof makeWindow>[] = [];
    const rewire = vi.fn();
    const baseDeps = makeDeps(windows, undefined);
    const deps = {
      ...baseDeps,
      settingsService: {
        ...baseDeps.settingsService,
        get: vi.fn()
          .mockReturnValueOnce({ provider: "openai", vendors: { "azure-foundry": { baseUrl: null } } })  // prevBaseUrl read (key: "llm")
          .mockReturnValueOnce({ cloudAllowPrivateNetwork: false })  // prevAllowPrivate read (key: "marketplace")
          .mockReturnValueOnce({ provider: "openai", vendors: { "azure-foundry": { baseUrl: "https://proj.services.ai.azure.com" } } })  // newBaseUrl read (key: "llm")
          .mockReturnValueOnce({ cloudAllowPrivateNetwork: false }),  // newAllowPrivate read (key: "marketplace")
        patch: vi.fn(async (p: unknown) => p),
      },
      rewireReviewerAgent: rewire,
    };

    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    await invoke("lvis:settings:update", {
      llm: { vendors: { "azure-foundry": { baseUrl: "https://proj.services.ai.azure.com" } } },
    });

    expect(rewire).toHaveBeenCalledOnce();
  });

  it("does NOT call rewireReviewerAgent when baseUrl stays the same", async () => {
    const windows: ReturnType<typeof makeWindow>[] = [];
    const rewire = vi.fn();
    const sameUrl = "https://proj.services.ai.azure.com";
    const baseDeps = makeDeps(windows, sameUrl);
    const deps = {
      ...baseDeps,
      settingsService: {
        ...baseDeps.settingsService,
        get: vi.fn(() => ({ provider: "openai", vendors: { "azure-foundry": { baseUrl: sameUrl } } })),
        patch: vi.fn(async (p: unknown) => p),
      },
      rewireReviewerAgent: rewire,
    };

    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    await invoke("lvis:settings:update", { llm: { provider: "openai" } });

    expect(rewire).not.toHaveBeenCalled();
  });

  it("calls rewireReviewerAgent on set-api-key so cacheScope refreshes", async () => {
    const windows: ReturnType<typeof makeWindow>[] = [];
    const rewire = vi.fn();
    const deps = { ...makeDeps(windows), rewireReviewerAgent: rewire };

    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    await invoke("lvis:settings:set-api-key", "azure-foundry", "az-key");

    expect(rewire).toHaveBeenCalledOnce();
  });

  it("calls rewireReviewerAgent on delete-api-key so cacheScope refreshes", async () => {
    const windows: ReturnType<typeof makeWindow>[] = [];
    const rewire = vi.fn();
    const deps = { ...makeDeps(windows), rewireReviewerAgent: rewire };

    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    await invoke("lvis:settings:delete-api-key", "azure-foundry");

    expect(rewire).toHaveBeenCalledOnce();
  });
});

// ─── PR #795 follow-up: settings:update triggers refreshMarketplaceFetcherConfig
//     when the allowPrivateNetwork toggle changes so the live SSRF-bypass flag
//     honors the "즉시 적용" UX badge instead of waiting for an app restart.
describe("settings:update triggers refreshMarketplaceFetcherConfig on allowPrivateNetwork toggle", () => {
  it("calls refreshMarketplaceFetcherConfig when the flag flips false → true", async () => {
    const windows: ReturnType<typeof makeWindow>[] = [];
    const refresh = vi.fn();
    const baseDeps = makeDeps(windows);
    const deps = {
      ...baseDeps,
      settingsService: {
        ...baseDeps.settingsService,
        get: vi.fn()
          .mockReturnValueOnce({ provider: "openai", vendors: { "azure-foundry": { baseUrl: null } } })  // prevBaseUrl
          .mockReturnValueOnce({ cloudAllowPrivateNetwork: false })                                    // prevAllowPrivate
          .mockReturnValueOnce({ provider: "openai", vendors: { "azure-foundry": { baseUrl: null } } })  // newBaseUrl
          .mockReturnValueOnce({ cloudAllowPrivateNetwork: true }),                                    // newAllowPrivate
        patch: vi.fn(async (p: unknown) => p),
      },
      refreshMarketplaceFetcherConfig: refresh,
    };

    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    await invoke("lvis:settings:update", { marketplace: { cloudAllowPrivateNetwork: true } });

    expect(refresh).toHaveBeenCalledOnce();
  });

  it("does NOT call refreshMarketplaceFetcherConfig when the flag stays the same", async () => {
    const windows: ReturnType<typeof makeWindow>[] = [];
    const refresh = vi.fn();
    const baseDeps = makeDeps(windows);
    const deps = {
      ...baseDeps,
      settingsService: {
        ...baseDeps.settingsService,
        get: vi.fn((key: string) =>
          key === "marketplace"
            ? { cloudAllowPrivateNetwork: true }
            : { provider: "openai", vendors: { "azure-foundry": { baseUrl: null } } },
        ),
        patch: vi.fn(async (p: unknown) => p),
      },
      refreshMarketplaceFetcherConfig: refresh,
    };

    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    await invoke("lvis:settings:update", { marketplace: { cloudAllowPrivateNetwork: true } });

    expect(refresh).not.toHaveBeenCalled();
  });
});

// ─── Minor-1 R2: broadcastSettingsSnapshot helper consolidation ───────────────

describe("Minor-1: broadcastSettingsSnapshot helper — all mutation handlers call it", () => {
  it("set-api-key broadcasts snapshot via helper (not stale inline copy)", async () => {
    const win = makeWindow();
    const snapshot = { llm: { provider: "anthropic", version: 2 } };
    const deps = {
      ...makeDeps([win]),
      settingsService: {
        ...makeDeps([win]).settingsService,
        getAll: vi.fn(() => snapshot),
        setSecret: vi.fn(async () => undefined),
      },
    };

    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    await invoke("lvis:settings:set-api-key", "openai", "sk-test");

    expect(win.webContents.send).toHaveBeenCalledWith(SETTINGS.updated, snapshot);
  });
});

// ─── Minor-4 R2: settings:update rejects non-string baseUrl ──────────────────

describe("Minor-4: settings:update rejects non-string baseUrl", () => {
  it("returns invalid-foundry-endpoint when baseUrl is a number", async () => {
    const deps = makeDeps([]);

    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    const result = await invoke("lvis:settings:update", {
      llm: { vendors: { "azure-foundry": { baseUrl: 12345 } } },
    });

    expect(result).toMatchObject({ ok: false, error: "invalid-foundry-endpoint", message: "baseUrl must be a string" });
    expect(deps.settingsService.patch).not.toHaveBeenCalled();
  });

  it("returns invalid-foundry-endpoint when baseUrl is an object", async () => {
    const deps = makeDeps([]);

    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    const result = await invoke("lvis:settings:update", {
      llm: { vendors: { "azure-foundry": { baseUrl: { toString: () => "evil" } } } },
    });

    expect(result).toMatchObject({ ok: false, error: "invalid-foundry-endpoint", message: "baseUrl must be a string" });
  });

  it("accepts valid string baseUrl", async () => {
    const deps = makeDeps([]);
    deps.settingsService.patch.mockResolvedValue({ ok: true });
    deps.settingsService.get = vi.fn(() => ({ provider: "openai", vendors: { "azure-foundry": { baseUrl: "https://proj.services.ai.azure.com" } } }));

    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    await invoke("lvis:settings:update", {
      llm: { vendors: { "azure-foundry": { baseUrl: "https://proj.services.ai.azure.com" } } },
    });

    expect(deps.settingsService.patch).toHaveBeenCalled();
  });
});

// ─── Host resolver map trust boundary ───────────────────────────────────────

describe("settings:update rejects hostResolverMap changes", () => {
  it("requires the dedicated applyHostMap IPC for manual host resolver updates", async () => {
    const deps = makeDeps([]);

    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    const result = await invoke("lvis:settings:update", {
      llm: {
        authMode: "manual",
        hostResolverMap: "10.0.0.1 endpoint.example.com",
      },
    });

    expect(result).toMatchObject({
      ok: false,
      error: "host-map-requires-apply-host-map",
    });
    expect(deps.settingsService.patch).not.toHaveBeenCalled();
    expect(deps.conversationLoop.refreshProvider).not.toHaveBeenCalled();
  });
});

// ─── LOW-2: settings:update validates vendors["azure-foundry"].baseUrl ────────

describe("LOW-2: settings:update validates azure-foundry baseUrl at write time", () => {
  it("returns invalid-foundry-endpoint when baseUrl is HTTP (not HTTPS)", async () => {
    const windows: ReturnType<typeof makeWindow>[] = [];
    const deps = makeDeps(windows);

    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    const result = await invoke("lvis:settings:update", {
      llm: { vendors: { "azure-foundry": { baseUrl: "http://proj.services.ai.azure.com" } } },
    });

    expect(result).toMatchObject({ ok: false, error: "invalid-foundry-endpoint" });
    // Must NOT have called settingsService.patch with invalid endpoint
    expect(deps.settingsService.patch).not.toHaveBeenCalled();
  });

  it("returns invalid-foundry-endpoint when baseUrl has non-azure hostname", async () => {
    const windows: ReturnType<typeof makeWindow>[] = [];
    const deps = makeDeps(windows);

    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    const result = await invoke("lvis:settings:update", {
      llm: { vendors: { "azure-foundry": { baseUrl: "https://evil.example.com" } } },
    });

    expect(result).toMatchObject({ ok: false, error: "invalid-foundry-endpoint" });
    expect(deps.settingsService.patch).not.toHaveBeenCalled();
  });

  it("passes through and patches when baseUrl is a valid Foundry endpoint", async () => {
    const windows: ReturnType<typeof makeWindow>[] = [];
    const deps = makeDeps(windows);
    deps.settingsService.patch.mockResolvedValue({ ok: true });

    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    const patch = {
      llm: { vendors: { "azure-foundry": { baseUrl: "https://proj.services.ai.azure.com" } } },
    };
    await invoke("lvis:settings:update", patch);

    expect(deps.settingsService.patch).toHaveBeenCalledWith(patch);
  });

  it("passes through updates that don't touch azure-foundry baseUrl", async () => {
    const windows: ReturnType<typeof makeWindow>[] = [];
    const deps = makeDeps(windows);
    deps.settingsService.patch.mockResolvedValue({ ok: true });

    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(deps as never);

    const patch = { llm: { provider: "openai" } };
    await invoke("lvis:settings:update", patch);

    expect(deps.settingsService.patch).toHaveBeenCalledWith(patch);
  });
});
