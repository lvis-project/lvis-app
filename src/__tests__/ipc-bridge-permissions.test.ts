/**
 * IPC Bridge — Permissions + Policy handler tests (B2)
 *
 * Strategy: mock electron's ipcMain to capture handler registrations,
 * then invoke each handler directly with mock arguments.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeLlmSettings } from "../shared/__tests__/fake-llm-settings.js";

// ─── Mock electron ────────────────────────────────────

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
}));

// ─── Mock policy-store ───────────────────────────────

const mockLoadPolicy = vi.fn();
const mockSavePolicy = vi.fn();

vi.mock("../permissions/policy-store.js", () => ({
  loadPolicy: mockLoadPolicy,
  savePolicy: mockSavePolicy,
}));

// ─── Mock PermissionManager ──────────────────────────

function makeMockPM() {
  return {
    getMode: vi.fn(() => "default"),
    setModePersist: vi.fn(),
    listPersistedRules: vi.fn(async () => []),
    addAlwaysAllowedPersist: vi.fn(),
    addAlwaysDeniedPersist: vi.fn(),
    removeRule: vi.fn(),
    getVisibilityDenyRules: vi.fn(() => [{ pattern: "dangerous_*" }]),
  };
}

// ─── Mock ConversationLoop ────────────────────────────

function makeMockLoop(pm: ReturnType<typeof makeMockPM>) {
  return {
    permissionManager: pm,
    hasProvider: vi.fn(),
    runTurn: vi.fn(),
    newConversation: vi.fn(),
    getSessionId: vi.fn(() => "s1"),
    listSessions: vi.fn(() => []),
    loadSession: vi.fn(),
    refreshProvider: vi.fn(),
  };
}

// ─── Mock ApprovalGate ───────────────────────────────

function makeMockGate() {
  return {
    resolve: vi.fn(),
    requestAndWait: vi.fn(async (req: { id: string }) => ({
      requestId: req.id,
      choice: "allow-once",
    })),
    setPolicy: vi.fn(),
  };
}

// ─── Build minimal AppServices stub ──────────────────

function makeServices(pm: ReturnType<typeof makeMockPM>, gate = makeMockGate()) {
  return {
    pluginRuntime: {
      call: vi.fn(),
      listToolNames: vi.fn(() => []),
      listPluginIds: vi.fn(() => []),
      restartAll: vi.fn(),
      // US-3c.2: config:set now calls restartPlugin(pluginId) instead of
      // restartAll() so only the affected plugin is restarted.
      restartPlugin: vi.fn(),
      setConfigOverride: vi.fn(),
      listUiExtensions: vi.fn(() => []),
      // §9.2 Track B — config:set IPC handler reads the manifest to detect
      // `format: "secret"` keys. Default to undefined so the strip pass is
      // a no-op for legacy tests.
      getPluginManifest: vi.fn(() => undefined),
    } as any,
    pluginMarketplace: { list: vi.fn(), install: vi.fn(), uninstall: vi.fn() } as any,
    settingsService: {
      getAll: vi.fn(),
      patch: vi.fn(),
      get: vi.fn(() => fakeLlmSettings()),
      getSecret: vi.fn(),
      setSecret: vi.fn(),
      deleteSecret: vi.fn(),
      getPluginConfig: vi.fn(() => ({})),
      setPluginConfig: vi.fn(async (_pluginId: string, config: unknown) => config),
    } as any,
    memoryManager: { listMemoryEntries: vi.fn(() => []), saveMemory: vi.fn(), deleteMemory: vi.fn(), searchMemoryEntries: vi.fn(() => []), getMemoryContext: vi.fn(() => ""), getLvisMd: vi.fn(), updateLvisMd: vi.fn(), getUserPreferences: vi.fn(), updateUserPreferences: vi.fn() } as any,
    conversationLoop: makeMockLoop(pm) as any,
    approvalGate: gate as any,
    mcpManager: { listServers: vi.fn(() => []), killSwitch: vi.fn() } as any,
    toolRegistry: { setDenyRules: vi.fn() } as any,
    auditLogger: {
      log: vi.fn(),
      isPermissionAuditChainReady: vi.fn(() => true),
      appendPermissionAuditEntry: vi.fn(async (entry: Record<string, unknown>) => entry),
    } as any,
    idleScheduler: undefined,
    bashAstValidator: {} as any,
    auditService: {} as any,
    postTurnHookChain: {} as any,
    knowledgeAvailable: false,
  };
}

// ─── Setup: register handlers before each test ───────

async function setupHandlers(pm = makeMockPM(), gate = makeMockGate()) {
  handlers.clear();
  vi.clearAllMocks();
  // Re-import to re-run ipcMain.handle registrations
  const { registerIpcHandlers } = await import("../ipc-bridge.js");
  registerIpcHandlers(makeServices(pm, gate), () => null);
  return { pm, gate };
}

function invoke(channel: string, ...args: unknown[]): unknown {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`No handler registered for: ${channel}`);
  // ipcMain handlers receive (_event, ...args) — pass null as event
  return fn(null, ...args);
}

function invokeWithEvent(channel: string, event: unknown, ...args: unknown[]): unknown {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`No handler registered for: ${channel}`);
  return fn(event, ...args);
}

const USER_INTENT = { inputOrigin: "user-keyboard", userActivation: true };
const modePayload = (mode: string) => ({ mode, intent: USER_INTENT });
const rulePayload = (pattern: string, action: string) => ({ pattern, action, intent: USER_INTENT });
const policyPayload = (patch: Record<string, unknown>) => ({ patch, intent: USER_INTENT });

// ─── Tests ───────────────────────────────────────────

describe("lvis:permission:add-rule", () => {
  it("action=allow → calls addAlwaysAllowedPersist with pattern", async () => {
    const { pm } = await setupHandlers();
    const result = await invoke("lvis:permission:add-rule", rulePayload("my_tool", "allow")) as { ok: boolean };
    expect(pm.addAlwaysAllowedPersist).toHaveBeenCalledWith("my_tool");
    expect(pm.addAlwaysDeniedPersist).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
  });

  it("action=deny → calls addAlwaysDeniedPersist with pattern", async () => {
    const { pm } = await setupHandlers();
    const result = await invoke("lvis:permission:add-rule", rulePayload("dangerous_*", "deny")) as { ok: boolean };
    expect(pm.addAlwaysDeniedPersist).toHaveBeenCalledWith("dangerous_*");
    expect(pm.addAlwaysAllowedPersist).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
  });

  it("syncs visibility deny rules into ToolRegistry after add", async () => {
    const pm = makeMockPM();
    handlers.clear();
    vi.clearAllMocks();
    const { registerIpcHandlers } = await import("../ipc-bridge.js");
    const services = makeServices(pm);
    registerIpcHandlers(services, () => null);

    await invoke("lvis:permission:add-rule", rulePayload("dangerous_*", "deny"));

    expect(pm.getVisibilityDenyRules).toHaveBeenCalled();
    expect(services.toolRegistry.setDenyRules).toHaveBeenCalledWith([{ pattern: "dangerous_*" }]);
  });

  it("no permissionManager → returns { ok: false }", async () => {
    const pm = makeMockPM();
    const { pm: _p } = await setupHandlers(pm);
    // Simulate missing PM by overwriting conversationLoop.permissionManager after setup
    handlers.clear();
    const { registerIpcHandlers } = await import("../ipc-bridge.js");
    const services = makeServices(pm);
    (services.conversationLoop as any).permissionManager = undefined;
    registerIpcHandlers(services, () => null);
    const result = await invoke("lvis:permission:add-rule", rulePayload("tool", "allow")) as { ok: boolean };
    expect(result.ok).toBe(false);
  });
});

describe("lvis:permission:remove-rule", () => {
  it("calls removeRule with pattern and action", async () => {
    const { pm } = await setupHandlers();
    const result = await invoke("lvis:permission:remove-rule", rulePayload("my_tool", "allow")) as { ok: boolean };
    expect(pm.removeRule).toHaveBeenCalledWith("my_tool", "allow");
    expect(result.ok).toBe(true);
  });

  it("deny action passes deny to removeRule", async () => {
    const { pm } = await setupHandlers();
    await invoke("lvis:permission:remove-rule", rulePayload("mcp_*", "deny"));
    expect(pm.removeRule).toHaveBeenCalledWith("mcp_*", "deny");
  });

  it("syncs visibility deny rules into ToolRegistry after remove", async () => {
    const pm = makeMockPM();
    handlers.clear();
    vi.clearAllMocks();
    const { registerIpcHandlers } = await import("../ipc-bridge.js");
    const services = makeServices(pm);
    registerIpcHandlers(services, () => null);

    await invoke("lvis:permission:remove-rule", rulePayload("mcp_*", "deny"));

    expect(pm.getVisibilityDenyRules).toHaveBeenCalled();
    expect(services.toolRegistry.setDenyRules).toHaveBeenCalledWith([{ pattern: "dangerous_*" }]);
  });
});

describe("lvis:policy:get", () => {
  it("returns loadPolicy() result", async () => {
    const fakePolicy = { version: 1, requireExplicitApproval: true, managed: false, updatedAt: "2026-01-01" };
    mockLoadPolicy.mockResolvedValue(fakePolicy);
    await setupHandlers();
    const result = await invoke("lvis:policy:get");
    expect(result).toEqual(fakePolicy);
    expect(mockLoadPolicy).toHaveBeenCalled();
  });
});

describe("lvis:mcp:servers", () => {
  it("rejects unauthorized sender frames", async () => {
    await setupHandlers();

    const result = await invokeWithEvent(
      "lvis:mcp:servers",
      { senderFrame: { url: "https://evil.example.com/" } },
    );

    expect(result).toEqual({ ok: false, error: "unauthorized-frame" });
  });
});

describe("lvis:memory:entries:*", () => {
  it("memory list rejects unauthorized frames", async () => {
    await setupHandlers();

    const result = await invokeWithEvent(
      "lvis:memory:entries:list",
      { senderFrame: { url: "https://evil.example.com/" } },
    );

    expect(result).toEqual({ ok: false, error: "unauthorized-frame" });
  });

  it("memory search returns renderer-safe shape", async () => {
    const pm = makeMockPM();
    handlers.clear();
    vi.clearAllMocks();
    const { registerIpcHandlers } = await import("../ipc-bridge.js");
    const services = makeServices(pm);
    services.memoryManager.searchMemoryEntries.mockReturnValue([
      {
        filename: "my-memory.md",
        title: "My Memory",
        content: "# My Memory\n\nThis is the body.",
        updatedAt: "2026-04-20T00:00:00Z",
      },
    ]);
    registerIpcHandlers(services, () => null);

    const result = await invoke("lvis:memory:entries:search", "body") as Array<Record<string, unknown>>;

    expect(result[0]).toMatchObject({
      filename: "my-memory.md",
      title: "My Memory",
      content: "# My Memory\n\nThis is the body.",
      excerpt: "This is the body.",
      updatedAt: "2026-04-20T00:00:00Z",
    });
  });

  it("memory search strips only a leading heading from excerpt", async () => {
    const pm = makeMockPM();
    handlers.clear();
    vi.clearAllMocks();
    const { registerIpcHandlers } = await import("../ipc-bridge.js");
    const services = makeServices(pm);
    services.memoryManager.searchMemoryEntries.mockReturnValue([
      {
        filename: "manual-memory.md",
        title: "Manual Memory",
        content: "첫 문단\n# 중간 제목\n본문",
        updatedAt: "2026-04-20T00:00:00Z",
      },
    ]);
    registerIpcHandlers(services, () => null);

    const result = await invoke("lvis:memory:entries:search", "본문") as Array<Record<string, unknown>>;

    expect(result[0]?.excerpt).toBe("첫 문단\n# 중간 제목\n본문");
  });

  it("memory delete targets deleteMemory", async () => {
    const pm = makeMockPM();
    handlers.clear();
    vi.clearAllMocks();
    const { registerIpcHandlers } = await import("../ipc-bridge.js");
    const services = makeServices(pm);
    registerIpcHandlers(services, () => null);

    await invoke("lvis:memory:entries:delete", "my-memory.md");

    expect(services.memoryManager.deleteMemory).toHaveBeenCalledWith("my-memory.md");
  });

  it("memory search rejects unauthorized frames", async () => {
    await setupHandlers();

    const result = await invokeWithEvent(
      "lvis:memory:entries:search",
      { senderFrame: { url: "https://evil.example.com/" } },
      "query",
    );

    expect(result).toEqual({ ok: false, error: "unauthorized-frame" });
  });
});

describe("lvis:plugins:config:*", () => {
  it("returns an explicit message for unauthorized plugin-config reads", async () => {
    await setupHandlers();

    const result = await invokeWithEvent(
      "lvis:plugins:config:get",
      { senderFrame: { url: "https://evil.example.com/" } },
      "meeting",
    );

    expect(result).toEqual({
      ok: false,
      error: "unauthorized-frame",
      message: "권한이 없는 프레임입니다.",
    });
  });

  it("returns an explicit message for unauthorized plugin-config writes", async () => {
    await setupHandlers();

    const result = await invokeWithEvent(
      "lvis:plugins:config:set",
      { senderFrame: { url: "https://evil.example.com/" } },
      "meeting",
      { apiKey: "secret" },
    );

    expect(result).toEqual({
      ok: false,
      error: "unauthorized-frame",
      message: "권한이 없는 프레임입니다.",
    });
  });

  it("restarts the plugin runtime after a successful plugin-config save", async () => {
    const pm = makeMockPM();
    handlers.clear();
    vi.clearAllMocks();
    const { registerIpcHandlers } = await import("../ipc-bridge.js");
    const services = makeServices(pm);
    registerIpcHandlers(services, () => null);

    const result = await invoke("lvis:plugins:config:set", "meeting", { apiKey: "secret" }) as {
      ok: boolean;
      config: unknown;
    };

    expect(result).toEqual({ ok: true, config: { apiKey: "secret" } });
    expect(services.settingsService.setPluginConfig).toHaveBeenCalledWith("meeting", { apiKey: "secret" });
    expect(services.pluginRuntime.setConfigOverride).toHaveBeenCalledWith("meeting", { apiKey: "secret" });
    // US-3c.2: targeted restart — only the affected plugin is restarted.
    expect(services.pluginRuntime.restartPlugin).toHaveBeenCalledWith("meeting");
    expect(services.pluginRuntime.restartAll).not.toHaveBeenCalled();
  });

  // §9.2 Track B — US-B5
  it("strips `format:'secret'` keys from cleartext pluginConfigs at save time", async () => {
    const pm = makeMockPM();
    handlers.clear();
    vi.clearAllMocks();
    const { registerIpcHandlers } = await import("../ipc-bridge.js");
    const services = makeServices(pm);
    // Manifest declares apiKey as a secret. The IPC handler MUST drop
    // it from the payload before calling setPluginConfig so the
    // cleartext settings.json never sees it.
    services.pluginRuntime.getPluginManifest = vi.fn(() => ({
      id: "meeting",
      name: "Meeting",
      version: "1.0.0",
      entry: "index.js",
      tools: [],
      configSchema: {
        properties: {
          endpoint: { type: "string" },
          apiKey: { type: "string", format: "secret" },
        },
      },
    }));
    registerIpcHandlers(services, () => null);

    const result = await invoke(
      "lvis:plugins:config:set",
      "meeting",
      { endpoint: "https://api.example.com", apiKey: "sk-LEAK" },
    ) as { ok: boolean; config: unknown };

    expect(result.ok).toBe(true);
    // setPluginConfig is the only path that lands on disk for cleartext
    // pluginConfigs — verify it never received the secret key.
    const savedArg = (services.settingsService.setPluginConfig as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][1] as Record<string, unknown>;
    expect(savedArg).toEqual({ endpoint: "https://api.example.com" });
    expect("apiKey" in savedArg).toBe(false);
    expect(JSON.stringify(savedArg)).not.toContain("sk-LEAK");
  });

  // §9.2 Track B — US-B5: secret writes go through settingsService.setSecret
  it("config:secret:set persists via setSecret and never via setPluginConfig", async () => {
    const pm = makeMockPM();
    handlers.clear();
    vi.clearAllMocks();
    const { registerIpcHandlers } = await import("../ipc-bridge.js");
    const services = makeServices(pm);
    services.pluginRuntime.getPluginManifest = vi.fn(() => ({
      id: "meeting",
      name: "Meeting",
      version: "1.0.0",
      entry: "index.js",
      tools: [],
      configSchema: {
        properties: {
          apiKey: { type: "string", format: "secret" },
        },
      },
    }));
    registerIpcHandlers(services, () => null);

    const result = await invoke(
      "lvis:plugins:config:secret:set",
      "meeting",
      "apiKey",
      "sk-LIVE",
    ) as { ok: boolean };

    expect(result.ok).toBe(true);
    expect(services.settingsService.setSecret).toHaveBeenCalledWith(
      "plugin.meeting.apiKey",
      "sk-LIVE",
    );
    // The secret value must NOT pass through setPluginConfig.
    const setPluginConfigMock = services.settingsService.setPluginConfig as unknown as { mock: { calls: unknown[][] } };
    for (const call of setPluginConfigMock.mock.calls) {
      const arg = call[1];
      expect(JSON.stringify(arg ?? {})).not.toContain("sk-LIVE");
    }
  });

  it("config:secret:set rejects keys not declared as `format:'secret'`", async () => {
    const pm = makeMockPM();
    handlers.clear();
    vi.clearAllMocks();
    const { registerIpcHandlers } = await import("../ipc-bridge.js");
    const services = makeServices(pm);
    services.pluginRuntime.getPluginManifest = vi.fn(() => ({
      id: "meeting",
      name: "Meeting",
      version: "1.0.0",
      entry: "index.js",
      tools: [],
      configSchema: { properties: { endpoint: { type: "string" } } },
    }));
    registerIpcHandlers(services, () => null);

    const result = await invoke(
      "lvis:plugins:config:secret:set",
      "meeting",
      "endpoint",
      "leak",
    ) as { ok: boolean; error?: string };
    expect(result.ok).toBe(false);
    expect(result.error).toBe("plugin-config-secret-invalid-key");
    expect(services.settingsService.setSecret).not.toHaveBeenCalled();
  });
});

describe("lvis:policy:set", () => {
  it("success path → calls savePolicy, then gate.setPolicy, returns { ok: true }", async () => {
    const updatedPolicy = { version: 1, requireExplicitApproval: false, managed: false, updatedAt: "2026-01-02" };
    mockSavePolicy.mockResolvedValue(updatedPolicy);
    const { gate } = await setupHandlers();
    const result = await invoke("lvis:policy:set", policyPayload({ requireExplicitApproval: false })) as { ok: boolean; policy: unknown };
    expect(mockSavePolicy).toHaveBeenCalledWith({ requireExplicitApproval: false });
    expect(gate.setPolicy).toHaveBeenCalledWith(updatedPolicy);
    expect(result.ok).toBe(true);
    expect(result.policy).toEqual(updatedPolicy);
  });

  it("managed error → returns { ok: false, error: 'managed' } without throwing", async () => {
    mockSavePolicy.mockRejectedValue(new Error("IT 관리 정책은 사용자가 변경할 수 없습니다."));
    const { gate } = await setupHandlers();
    const result = await invoke("lvis:policy:set", policyPayload({ requireExplicitApproval: false })) as { ok: boolean; error: string; message: string };
    expect(result.ok).toBe(false);
    expect(result.error).toBe("managed");
    expect(result.message).toContain("IT 관리");
    // gate.setPolicy must NOT have been called
    expect(gate.setPolicy).not.toHaveBeenCalled();
  });

  it("gate.setPolicy is skipped when approvalGate is undefined", async () => {
    const updatedPolicy = { version: 1, requireExplicitApproval: true, managed: false, updatedAt: "now" };
    mockSavePolicy.mockResolvedValue(updatedPolicy);
    handlers.clear();
    const { registerIpcHandlers } = await import("../ipc-bridge.js");
    const pm = makeMockPM();
    const services = makeServices(pm);
    services.approvalGate = undefined as any;
    registerIpcHandlers(services, () => null);
    // Should not throw even with no gate
    const result = await invoke("lvis:policy:set", policyPayload({})) as { ok: boolean };
    expect(result.ok).toBe(true);
  });
});

describe("lvis:permission:get-mode", () => {
  it("returns mode from permissionManager.getMode()", async () => {
    const pm = makeMockPM();
    pm.getMode.mockReturnValue("strict");
    await setupHandlers(pm);
    const result = await invoke("lvis:permission:get-mode") as { mode: string };
    expect(result.mode).toBe("strict");
  });
});

describe("lvis:permission:set-mode", () => {
  it("calls setModePersist with given mode", async () => {
    const { pm } = await setupHandlers();
    await invoke("lvis:permission:set-mode", modePayload("auto"));
    expect(pm.setModePersist).toHaveBeenCalledWith("auto");
  });

  // §F8: whitelist validation
  it("invalid mode → returns { ok: false, error: 'invalid-mode' } without calling setModePersist", async () => {
    const { pm } = await setupHandlers();
    const result = await invoke("lvis:permission:set-mode", modePayload("turbo")) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toBe("invalid-mode");
    expect(pm.setModePersist).not.toHaveBeenCalled();
  });

  it("empty string mode → returns { ok: false, error: 'invalid-mode' }", async () => {
    const { pm } = await setupHandlers();
    const result = await invoke("lvis:permission:set-mode", modePayload("")) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toBe("invalid-mode");
  });
});

// §F8: add-rule validation
describe("lvis:permission:add-rule — F8 validation", () => {
  it("empty pattern → returns { ok: false, error: 'invalid-pattern' }", async () => {
    const { pm } = await setupHandlers();
    const result = await invoke("lvis:permission:add-rule", rulePayload("", "allow")) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toBe("invalid-pattern");
    expect(pm.addAlwaysAllowedPersist).not.toHaveBeenCalled();
  });

  it("pattern > 128 chars → returns { ok: false, error: 'invalid-pattern' }", async () => {
    const { pm } = await setupHandlers();
    const longPattern = "a".repeat(129);
    const result = await invoke("lvis:permission:add-rule", rulePayload(longPattern, "allow")) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toBe("invalid-pattern");
    expect(pm.addAlwaysAllowedPersist).not.toHaveBeenCalled();
  });

  it("invalid action → returns { ok: false, error: 'invalid-action' }", async () => {
    const { pm } = await setupHandlers();
    const result = await invoke("lvis:permission:add-rule", rulePayload("my_tool", "permit")) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toBe("invalid-action");
    expect(pm.addAlwaysAllowedPersist).not.toHaveBeenCalled();
    expect(pm.addAlwaysDeniedPersist).not.toHaveBeenCalled();
  });
});

// §F8: policy:set validation
describe("lvis:policy:set — F8 validation", () => {
  it("patch with 'managed' key → returns { ok: false, error: 'invalid-patch' } without calling savePolicy", async () => {
    await setupHandlers();
    const result = await invoke("lvis:policy:set", policyPayload({ managed: true })) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toBe("invalid-patch");
    expect(mockSavePolicy).not.toHaveBeenCalled();
  });

  it("requireExplicitApproval as non-boolean → returns { ok: false, error: 'invalid-patch' }", async () => {
    await setupHandlers();
    const result = await invoke("lvis:policy:set", policyPayload({ requireExplicitApproval: "yes" })) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toBe("invalid-patch");
    expect(mockSavePolicy).not.toHaveBeenCalled();
  });
});
