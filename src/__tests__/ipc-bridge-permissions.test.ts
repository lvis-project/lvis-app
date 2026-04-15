/**
 * IPC Bridge — Permissions + Policy handler tests (B2)
 *
 * Strategy: mock electron's ipcMain to capture handler registrations,
 * then invoke each handler directly with mock arguments.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

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
  return { resolve: vi.fn(), setPolicy: vi.fn() };
}

// ─── Build minimal AppServices stub ──────────────────

function makeServices(pm: ReturnType<typeof makeMockPM>, gate = makeMockGate()) {
  return {
    pluginRuntime: { call: vi.fn(), listMethods: vi.fn(() => []), listPluginIds: vi.fn(() => []), restartAll: vi.fn(), listUiExtensions: vi.fn(() => []) } as any,
    pluginMarketplace: { list: vi.fn(), install: vi.fn(), uninstall: vi.fn() } as any,
    taskService: { add: vi.fn(), update: vi.fn(), get: vi.fn(), delete: vi.fn(), query: vi.fn(), getPendingByPriority: vi.fn(() => []), getOverdue: vi.fn(() => []), getDueToday: vi.fn(() => []) } as any,
    settingsService: { getAll: vi.fn(), patch: vi.fn(), get: vi.fn(() => ({ provider: "openai" })), getSecret: vi.fn(), setSecret: vi.fn(), deleteSecret: vi.fn() } as any,
    memoryManager: { listNotes: vi.fn(() => []), saveNote: vi.fn(), deleteNote: vi.fn(), searchNotes: vi.fn(() => []), getLvisMd: vi.fn(), updateLvisMd: vi.fn(), getUserPreferences: vi.fn(), updateUserPreferences: vi.fn() } as any,
    conversationLoop: makeMockLoop(pm) as any,
    approvalGate: gate as any,
    mcpManager: { listServers: vi.fn(() => []), killSwitch: vi.fn() } as any,
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

// ─── Tests ───────────────────────────────────────────

describe("lvis:permission:add-rule", () => {
  it("action=allow → calls addAlwaysAllowedPersist with pattern", async () => {
    const { pm } = await setupHandlers();
    const result = await invoke("lvis:permission:add-rule", "my_tool", "allow") as { ok: boolean };
    expect(pm.addAlwaysAllowedPersist).toHaveBeenCalledWith("my_tool");
    expect(pm.addAlwaysDeniedPersist).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
  });

  it("action=deny → calls addAlwaysDeniedPersist with pattern", async () => {
    const { pm } = await setupHandlers();
    const result = await invoke("lvis:permission:add-rule", "dangerous_*", "deny") as { ok: boolean };
    expect(pm.addAlwaysDeniedPersist).toHaveBeenCalledWith("dangerous_*");
    expect(pm.addAlwaysAllowedPersist).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
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
    const result = await invoke("lvis:permission:add-rule", "tool", "allow") as { ok: boolean };
    expect(result.ok).toBe(false);
  });
});

describe("lvis:permission:remove-rule", () => {
  it("calls removeRule with pattern and action", async () => {
    const { pm } = await setupHandlers();
    const result = await invoke("lvis:permission:remove-rule", "my_tool", "allow") as { ok: boolean };
    expect(pm.removeRule).toHaveBeenCalledWith("my_tool", "allow");
    expect(result.ok).toBe(true);
  });

  it("deny action passes deny to removeRule", async () => {
    const { pm } = await setupHandlers();
    await invoke("lvis:permission:remove-rule", "mcp_*", "deny");
    expect(pm.removeRule).toHaveBeenCalledWith("mcp_*", "deny");
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

describe("lvis:policy:set", () => {
  it("success path → calls savePolicy, then gate.setPolicy, returns { ok: true }", async () => {
    const updatedPolicy = { version: 1, requireExplicitApproval: false, managed: false, updatedAt: "2026-01-02" };
    mockSavePolicy.mockResolvedValue(updatedPolicy);
    const { gate } = await setupHandlers();
    const result = await invoke("lvis:policy:set", { requireExplicitApproval: false }) as { ok: boolean; policy: unknown };
    expect(mockSavePolicy).toHaveBeenCalledWith({ requireExplicitApproval: false });
    expect(gate.setPolicy).toHaveBeenCalledWith(updatedPolicy);
    expect(result.ok).toBe(true);
    expect(result.policy).toEqual(updatedPolicy);
  });

  it("managed error → returns { ok: false, error: 'managed' } without throwing", async () => {
    mockSavePolicy.mockRejectedValue(new Error("IT 관리 정책은 사용자가 변경할 수 없습니다."));
    const { gate } = await setupHandlers();
    const result = await invoke("lvis:policy:set", { requireExplicitApproval: false }) as { ok: boolean; error: string; message: string };
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
    const result = await invoke("lvis:policy:set", {}) as { ok: boolean };
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
    await invoke("lvis:permission:set-mode", "auto");
    expect(pm.setModePersist).toHaveBeenCalledWith("auto");
  });

  // §F8: whitelist validation
  it("invalid mode → returns { ok: false, error: 'invalid-mode' } without calling setModePersist", async () => {
    const { pm } = await setupHandlers();
    const result = await invoke("lvis:permission:set-mode", "turbo") as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toBe("invalid-mode");
    expect(pm.setModePersist).not.toHaveBeenCalled();
  });

  it("empty string mode → returns { ok: false, error: 'invalid-mode' }", async () => {
    const { pm } = await setupHandlers();
    const result = await invoke("lvis:permission:set-mode", "") as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toBe("invalid-mode");
  });
});

// §F8: add-rule validation
describe("lvis:permission:add-rule — F8 validation", () => {
  it("empty pattern → returns { ok: false, error: 'invalid-pattern' }", async () => {
    const { pm } = await setupHandlers();
    const result = await invoke("lvis:permission:add-rule", "", "allow") as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toBe("invalid-pattern");
    expect(pm.addAlwaysAllowedPersist).not.toHaveBeenCalled();
  });

  it("pattern > 128 chars → returns { ok: false, error: 'invalid-pattern' }", async () => {
    const { pm } = await setupHandlers();
    const longPattern = "a".repeat(129);
    const result = await invoke("lvis:permission:add-rule", longPattern, "allow") as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toBe("invalid-pattern");
    expect(pm.addAlwaysAllowedPersist).not.toHaveBeenCalled();
  });

  it("invalid action → returns { ok: false, error: 'invalid-action' }", async () => {
    const { pm } = await setupHandlers();
    const result = await invoke("lvis:permission:add-rule", "my_tool", "permit") as { ok: boolean; error: string };
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
    const result = await invoke("lvis:policy:set", { managed: true }) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toBe("invalid-patch");
    expect(mockSavePolicy).not.toHaveBeenCalled();
  });

  it("requireExplicitApproval as non-boolean → returns { ok: false, error: 'invalid-patch' }", async () => {
    await setupHandlers();
    const result = await invoke("lvis:policy:set", { requireExplicitApproval: "yes" }) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toBe("invalid-patch");
    expect(mockSavePolicy).not.toHaveBeenCalled();
  });
});
