/**
 * IPC Bridge — lvis:runtime:counts, lvis:runtime:env, lvis:marketplace:ping
 * handler smoke tests (PR #240).
 *
 * Strategy: mirrors ipc-bridge-permissions.test.ts — register handlers via
 * registerIpcHandlers with mocked services, then invoke each handler directly
 * with a synthetic IpcMainInvokeEvent.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeLlmSettings } from "../shared/__tests__/fake-llm-settings.js";
import {
  makeMockApprovalGate,
  makeMockConversationLoop,
  makeMockPermissionManager,
  invokeRegisteredHandler,
  invokeRegisteredHandlerWithEvent,
} from "./test-helpers.js";

// ─── Mock electron ────────────────────────────────────────────────────────────

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
}));

// ─── Mock policy-store ────────────────────────────────────────────────────────

const mockLoadPolicy = vi.fn();
const mockSavePolicy = vi.fn();

vi.mock("../permissions/policy-store.js", () => ({
  loadPolicy: mockLoadPolicy,
  savePolicy: mockSavePolicy,
}));

// ─── Mock PermissionManager ───────────────────────────────────────────────────

// ─── Build AppServices stub ───────────────────────────────────────────────────

function makeServices(
  pm = makeMockPermissionManager(),
  gate = makeMockApprovalGate(),
  overrides: {
    toolRegistrySize?: number;
    pluginIds?: string[];
    mcpServers?: Array<{ status: string }>;
    marketplaceSettings?: {
      backend: string;
      cloudBaseUrl?: string;
      cloudAllowPrivateNetwork?: boolean;
    };
  } = {},
) {
  const toolRegistrySize = overrides.toolRegistrySize ?? 5;
  const pluginIds = overrides.pluginIds ?? ["meeting", "email"];
  const mcpServers = overrides.mcpServers ?? [
    { status: "connected" },
    { status: "connected" },
    { status: "disconnected" },
  ];
  const marketplaceSettings = overrides.marketplaceSettings ?? { backend: "mock" };

  return {
    pluginRuntime: {
      call: vi.fn(),
      listToolNames: vi.fn(() => []),
      listPluginIds: vi.fn(() => pluginIds),
      listPluginCards: vi.fn(() => []),
      restartAll: vi.fn(),
      setConfigOverride: vi.fn(),
      listUiExtensions: vi.fn(() => []),
    } as any,
    pluginMarketplace: { list: vi.fn(), install: vi.fn(), uninstall: vi.fn() } as any,
    settingsService: {
      getAll: vi.fn(),
      patch: vi.fn(),
      get: vi.fn((key: string) => {
        if (key === "marketplace") return marketplaceSettings;
        return fakeLlmSettings();
      }),
      getSecret: vi.fn(),
      setSecret: vi.fn(),
      deleteSecret: vi.fn(),
      getPluginConfig: vi.fn(() => ({})),
      setPluginConfig: vi.fn(async (_pluginId: string, config: unknown) => config),
    } as any,
    memoryManager: {
      listMemoryEntries: vi.fn(() => []),
      saveMemory: vi.fn(),
      deleteMemory: vi.fn(),
      searchMemoryEntries: vi.fn(() => []),
      getMemoryContext: vi.fn(() => ""),
      getUserPreferences: vi.fn(),
      updateUserPreferences: vi.fn(),
    } as any,
    conversationLoop: makeMockConversationLoop(pm) as any,
    approvalGate: gate as any,
    mcpManager: { listServers: vi.fn(() => mcpServers), killSwitch: vi.fn() } as any,
    toolRegistry: { setDenyRules: vi.fn(), size: toolRegistrySize } as any,
    auditLogger: { log: vi.fn() } as any,
    idleScheduler: undefined,
    bashAstValidator: {} as any,
    auditService: {} as any,
    postTurnHookChain: {} as any,
    knowledgeAvailable: false,
  };
}

// ─── Handler registration helper ─────────────────────────────────────────────

async function setupHandlers(
  pm = makeMockPermissionManager(),
  gate = makeMockApprovalGate(),
  serviceOverrides: Parameters<typeof makeServices>[2] = {},
) {
  handlers.clear();
  vi.clearAllMocks();
  const { registerIpcHandlers } = await import("../ipc-bridge.js");
  registerIpcHandlers(makeServices(pm, gate, serviceOverrides), () => null);
  return { pm, gate };
}

// ─── Invocation helpers ───────────────────────────────────────────────────────

function invoke(channel: string, ...args: unknown[]): unknown {
  return invokeRegisteredHandler(handlers, channel, ...args);
}

function invokeWithEvent(
  channel: string,
  event: unknown,
  ...args: unknown[]
): unknown {
  return invokeRegisteredHandlerWithEvent(handlers, channel, event, ...args);
}

// Convenience: build a fake IpcMainInvokeEvent with an untrusted sender.
function untrustedEvent() {
  return { senderFrame: { url: "https://evil.example.com/" } };
}

// ─────────────────────────────────────────────────────────────────────────────
// lvis:runtime:counts
// ─────────────────────────────────────────────────────────────────────────────
describe("lvis:runtime:counts", () => {
  it("returns { tools, plugins, mcps } with correct numeric values", async () => {
    await setupHandlers(makeMockPermissionManager(), makeMockApprovalGate(), {
      toolRegistrySize: 7,
      pluginIds: ["meeting", "email", "calendar"],
      mcpServers: [
        { status: "connected" },
        { status: "connected" },
        { status: "disconnected" },
        { status: "connected" },
      ],
    });

    const result = await invoke("lvis:runtime:counts") as {
      tools: number;
      plugins: number;
      mcps: number;
    };

    expect(result.tools).toBe(7);
    expect(result.plugins).toBe(3);
    // Only connected servers count.
    expect(result.mcps).toBe(3);
  });

  it("rejects unauthorized sender frames", async () => {
    await setupHandlers();

    const result = await invokeWithEvent(
      "lvis:runtime:counts",
      untrustedEvent(),
    );

    expect(result).toEqual({ ok: false, error: "unauthorized-frame" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// lvis:runtime:env
// ─────────────────────────────────────────────────────────────────────────────
describe("lvis:runtime:env", () => {
  it("returns { platform, hostname, user } — no cwd, no release", async () => {
    await setupHandlers();

    const result = await invoke("lvis:runtime:env") as Record<string, unknown>;

    // Required fields.
    expect(typeof result.platform).toBe("string");
    expect(result.platform).toBeTruthy();
    expect(typeof result.hostname).toBe("string");
    expect(result.hostname).toBeTruthy();
    expect(typeof result.user).toBe("string");
    expect(result.user).toBeTruthy();

    // Explicitly trimmed fields must NOT appear in the response.
    expect(result).not.toHaveProperty("cwd");
    expect(result).not.toHaveProperty("release");
  });

  it("rejects unauthorized sender frames", async () => {
    await setupHandlers();

    const result = await invokeWithEvent(
      "lvis:runtime:env",
      untrustedEvent(),
    );

    expect(result).toEqual({ ok: false, error: "unauthorized-frame" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// lvis:marketplace:ping
// ─────────────────────────────────────────────────────────────────────────────
describe("lvis:marketplace:ping", () => {
  it("returns { configured: false, online: false } when backend is not real-cloud", async () => {
    await setupHandlers(makeMockPermissionManager(), makeMockApprovalGate(), {
      marketplaceSettings: { backend: "mock" },
    });

    const result = await invoke("lvis:marketplace:ping") as {
      configured: boolean;
      online: boolean;
    };

    expect(result.configured).toBe(false);
    expect(result.online).toBe(false);
  });

  it("returns { configured: false } when backend is real-cloud but no base URL", async () => {
    await setupHandlers(makeMockPermissionManager(), makeMockApprovalGate(), {
      marketplaceSettings: {
        backend: "real-cloud",
        cloudBaseUrl: "",
      },
    });

    const result = await invoke("lvis:marketplace:ping") as {
      configured: boolean;
      online: boolean;
    };

    expect(result.configured).toBe(false);
  });

  it("rejects unauthorized sender frames", async () => {
    await setupHandlers();

    const result = await invokeWithEvent(
      "lvis:marketplace:ping",
      untrustedEvent(),
    );

    expect(result).toEqual({ ok: false, error: "unauthorized-frame" });
  });

  it("returns { configured: true, online: false } when real-cloud fetch throws", async () => {
    // Use cloudAllowPrivateNetwork=true so the handler uses the direct
    // fetch path (no dynamic network-guard import) and we can control the
    // global fetch stub.
    const fetchSpy = vi.spyOn(global, "fetch").mockRejectedValueOnce(
      new Error("ECONNREFUSED"),
    );

    await setupHandlers(makeMockPermissionManager(), makeMockApprovalGate(), {
      marketplaceSettings: {
        backend: "real-cloud",
        cloudBaseUrl: "http://127.0.0.1:9999/",
        cloudAllowPrivateNetwork: true,
      },
    });

    const result = await invoke("lvis:marketplace:ping") as {
      configured: boolean;
      online: boolean;
    };

    expect(result.configured).toBe(true);
    expect(result.online).toBe(false);

    fetchSpy.mockRestore();
  });

  it("returns { configured: true, online: true } when real-cloud fetch succeeds (ok=true)", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValueOnce({
      ok: true,
    } as Response);

    await setupHandlers(makeMockPermissionManager(), makeMockApprovalGate(), {
      marketplaceSettings: {
        backend: "real-cloud",
        cloudBaseUrl: "http://127.0.0.1:9999/",
        cloudAllowPrivateNetwork: true,
      },
    });

    const result = await invoke("lvis:marketplace:ping") as {
      configured: boolean;
      online: boolean;
    };

    expect(result.configured).toBe(true);
    expect(result.online).toBe(true);

    fetchSpy.mockRestore();
  });

  it("coalesces concurrent real-cloud pings into one network request", async () => {
    let resolveFetch: (value: Response) => void = () => undefined;
    const fetchSpy = vi.spyOn(global, "fetch").mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    );

    await setupHandlers(makeMockPermissionManager(), makeMockApprovalGate(), {
      marketplaceSettings: {
        backend: "real-cloud",
        cloudBaseUrl: "http://127.0.0.1:9999/",
        cloudAllowPrivateNetwork: true,
      },
    });

    const first = invoke("lvis:marketplace:ping") as Promise<{ configured: boolean; online: boolean }>;
    const second = invoke("lvis:marketplace:ping") as Promise<{ configured: boolean; online: boolean }>;

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    resolveFetch({ ok: true } as Response);
    await expect(first).resolves.toEqual({ configured: true, online: true });
    await expect(second).resolves.toEqual({ configured: true, online: true });

    fetchSpy.mockRestore();
  });

  it("serves near-repeat pings from the main-process cache", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
    } as Response);

    await setupHandlers(makeMockPermissionManager(), makeMockApprovalGate(), {
      marketplaceSettings: {
        backend: "real-cloud",
        cloudBaseUrl: "http://127.0.0.1:9999/",
        cloudAllowPrivateNetwork: true,
      },
    });

    const first = await invoke("lvis:marketplace:ping") as {
      configured: boolean;
      online: boolean;
    };
    const second = await invoke("lvis:marketplace:ping") as {
      configured: boolean;
      online: boolean;
    };

    expect(first).toEqual({ configured: true, online: true });
    expect(second).toEqual({ configured: true, online: true });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    fetchSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// All three handlers — unified unauthorized-frame guard
// ─────────────────────────────────────────────────────────────────────────────
describe("new runtime handlers — all reject unauthorized frames", () => {
  const channels = [
    "lvis:runtime:counts",
    "lvis:runtime:env",
    "lvis:marketplace:ping",
  ] as const;

  beforeEach(async () => {
    await setupHandlers();
  });

  for (const channel of channels) {
    it(`${channel} returns UNAUTHORIZED_FRAME for a foreign origin`, async () => {
      const result = await invokeWithEvent(channel, untrustedEvent());
      expect(result).toEqual({ ok: false, error: "unauthorized-frame" });
    });
  }
});
