/**
 * PermissionManager unit tests — B1 persistence layer
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PermissionManager } from "../permission-manager.js";
import { updatePermissionsFile } from "../permissions-store.js";

// ─── Mock permissions-store ───────────────────────────
// We mock the store module so tests don't touch the real filesystem.

const mockStore: { rules: Array<{ pattern: string; action: "allow" | "deny"; source?: string }>; mode: string } = {
  rules: [],
  mode: "default",
};

// Serialize concurrent updatePermissionsFile calls (mirrors real withPermissionsLock)
let _mockLock: Promise<void> = Promise.resolve();

vi.mock("../permissions-store.js", () => ({
  readPermissionsFile: vi.fn(async () => {
    if (mockStore.rules.length === 0 && mockStore.mode === "default") return null;
    return { version: 1, rules: [...mockStore.rules], mode: mockStore.mode, updatedAt: new Date().toISOString() };
  }),
  updatePermissionsFile: vi.fn((_path: string, mutator: (f: { version: 1; rules: typeof mockStore.rules; mode: string; updatedAt: string }) => void) => {
    const prev = _mockLock;
    const next = prev.then(async () => {
      const file = {
        version: 1 as const,
        rules: [...mockStore.rules],
        mode: mockStore.mode,
        updatedAt: new Date().toISOString(),
      };
      await mutator(file);
      mockStore.rules = file.rules;
      mockStore.mode = file.mode;
    });
    _mockLock = next.then(() => undefined, () => undefined);
    return next;
  }),
}));

// ─── Tests ───────────────────────────────────────────

describe("PermissionManager (B1 persistence)", () => {
  let pm: PermissionManager;

  beforeEach(() => {
    mockStore.rules = [];
    mockStore.mode = "default";
    _mockLock = Promise.resolve();
    pm = new PermissionManager("/tmp/test-permissions.json");
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ── addAlwaysAllowedPersist ──────────────────────

  it("addAlwaysAllowedPersist writes rule to the store and updates in-memory", async () => {
    await pm.addAlwaysAllowedPersist("my_tool");

    // 인메모리: checkDetailed이 allow 반환해야 함
    const result = pm.checkDetailed("my_tool", "builtin", "write");
    expect(result.decision).toBe("allow");
    expect(result.reason).toBe("사용자 영구 승인");
    expect(result.layer).toBe(5);

    // 영구: store에 rule이 추가됐는지
    expect(mockStore.rules).toContainEqual({ pattern: "my_tool", action: "allow" });
  });

  it("does not add in-memory allow when durable allow persistence fails", async () => {
    vi.mocked(updatePermissionsFile).mockRejectedValueOnce(new Error("persist failed"));

    await expect(pm.addAlwaysAllowedPersist("volatile_tool")).rejects.toThrow("persist failed");

    const result = pm.checkDetailed("volatile_tool", "builtin", "write");
    expect(result.decision).toBe("ask");
    expect(mockStore.rules).toEqual([]);
  });

  it("addAlwaysAllowedPersist is idempotent — no duplicate rules", async () => {
    await pm.addAlwaysAllowedPersist("dup_tool");
    await pm.addAlwaysAllowedPersist("dup_tool");

    const allowRules = mockStore.rules.filter(
      (r) => r.pattern === "dup_tool" && r.action === "allow",
    );
    expect(allowRules).toHaveLength(1);
  });

  // ── addAlwaysDeniedPersist ───────────────────────

  it("addAlwaysDeniedPersist writes deny rule and blocks execution", async () => {
    await pm.addAlwaysDeniedPersist("dangerous_tool");

    const result = pm.checkDetailed("dangerous_tool", "builtin", "write");
    expect(result.decision).toBe("deny");
    expect(result.layer).toBe(1);

    expect(mockStore.rules).toContainEqual({ pattern: "dangerous_tool", action: "deny" });
    expect(pm.getVisibilityDenyRules()).toEqual([{ pattern: "dangerous_tool" }]);
  });

  it("uses shared glob matcher for allow/deny rules", async () => {
    pm.setRules([
      { pattern: "path:/work/**/*.md", action: "allow" },
      { pattern: "path:/work/private/**", action: "deny" },
    ]);

    const allowed = pm.checkDetailed("write_file", "builtin", "write", null, {
      approvalCacheKey: "path:/work/docs/readme.md",
    });
    const denied = pm.checkDetailed("write_file", "builtin", "write", null, {
      approvalCacheKey: "path:/work/private/secret.md",
    });

    expect(allowed.decision).toBe("allow");
    expect(denied.decision).toBe("deny");
  });

  // ── loadRulesFromFile ────────────────────────────

  it("loadRulesFromFile rehydrates allow rules into in-memory", async () => {
    // 파일에 규칙 사전 세팅
    mockStore.rules = [{ pattern: "pre_allowed_tool", action: "allow" }];

    const fresh = new PermissionManager("/tmp/test-permissions.json");
    await fresh.loadRulesFromFile();

    const result = fresh.checkDetailed("pre_allowed_tool", "builtin", "write");
    expect(result.decision).toBe("allow");
    expect(result.layer).toBe(3);
  });

  it("loadRulesFromFile is a no-op when file does not exist", async () => {
    // mockStore가 비어 있으면 readPermissionsFile이 null을 반환
    mockStore.rules = [];
    mockStore.mode = "default";

    const fresh = new PermissionManager("/tmp/test-permissions.json");
    // throw가 없어야 함
    await expect(fresh.loadRulesFromFile()).resolves.toBeUndefined();
  });

  it("loadRulesFromFile restores mode from file", async () => {
    mockStore.mode = "strict";
    mockStore.rules = [{ pattern: "any_tool", action: "allow" }];

    const fresh = new PermissionManager("/tmp/test-permissions.json");
    await fresh.loadRulesFromFile();

    expect(fresh.getMode()).toBe("strict");
  });

  // ── concurrent writes serialize ──────────────────

  it("concurrent addAlwaysAllowedPersist calls produce 2 rules, not 1", async () => {
    // 두 개의 다른 도구를 동시에 추가
    await Promise.all([
      pm.addAlwaysAllowedPersist("concurrent_tool_a"),
      pm.addAlwaysAllowedPersist("concurrent_tool_b"),
    ]);

    const aRule = mockStore.rules.filter((r) => r.pattern === "concurrent_tool_a" && r.action === "allow");
    const bRule = mockStore.rules.filter((r) => r.pattern === "concurrent_tool_b" && r.action === "allow");

    expect(aRule).toHaveLength(1);
    expect(bRule).toHaveLength(1);
  });

  // ── removeRule ───────────────────────────────────

  it("removeRule removes in-memory and persisted rule", async () => {
    await pm.addAlwaysAllowedPersist("removable_tool");
    expect(mockStore.rules.some((r) => r.pattern === "removable_tool" && r.action === "allow")).toBe(true);

    await pm.removeRule("removable_tool", "allow");
    expect(mockStore.rules.some((r) => r.pattern === "removable_tool" && r.action === "allow")).toBe(false);

    // 인메모리에서도 제거됐는지 — write category이므로 ask여야 함
    const result = pm.checkDetailed("removable_tool", "builtin", "write");
    expect(result.decision).toBe("ask");
    expect(result.layer).toBe(6);
  });

  // ── listPersistedRules ───────────────────────────

  it("listPersistedRules returns rules from store", async () => {
    await pm.addAlwaysAllowedPersist("listed_tool");
    const rules = await pm.listPersistedRules();
    expect(rules.some((r) => r.pattern === "listed_tool" && r.action === "allow")).toBe(true);
  });

  // ── setModePersist ───────────────────────────────

  it("setModePersist updates mode in-memory and in store", async () => {
    await pm.setModePersist("auto");
    expect(pm.getMode()).toBe("auto");
    expect(mockStore.mode).toBe("auto");
  });

  it("allow mode permits non-hard-blocked shell and MCP tools", async () => {
    await pm.setModePersist("allow");

    const shell = pm.checkDetailed("bash", "builtin", "shell");
    const mcp = pm.checkDetailed("mcp_server__fetch", "mcp", "network");

    expect(shell.decision).toBe("allow");
    expect(shell.reason).toContain("전체 허용 모드");
    expect(mcp.decision).toBe("allow");
    expect(mcp.reason).toContain("전체 허용 모드");
  });

  it("strict MCP tool override forces ask regardless of global auto mode", async () => {
    await pm.setModePersist("auto");
    pm.setToolModeOverride("mcp_server__write_note", "strict");

    const result = pm.checkDetailed("mcp_server__write_note", "mcp", "write");

    expect(result.decision).toBe("ask");
    expect(result.reason).toBe("MCP 서버 strict 모드");
    expect(result.layer).toBe(2);
  });

  it("auto MCP tool override stays on the category policy path", () => {
    pm.setToolModeOverride("mcp_server__fetch", "auto");

    const result = pm.checkDetailed("mcp_server__fetch", "mcp", "network");

    expect(result.decision).toBe("ask");
    expect(result.reason).toContain("MCP 도구 strict 강제");
    expect(result.layer).toBe(6);

    pm.setMode("strict");
    const strictResult = pm.checkDetailed("mcp_server__fetch", "mcp", "network");

    expect(strictResult.decision).toBe("ask");
    expect(strictResult.reason).toContain("strict 모드");
    expect(strictResult.layer).toBe(2);
  });

  it("strict mode asks even when an allow rule matches", () => {
    pm.setRules([{ pattern: "read_file", action: "allow" }]);
    pm.setMode("strict");

    const result = pm.checkDetailed("read_file", "builtin", "read");

    expect(result.decision).toBe("ask");
    expect(result.reason).toContain("strict 모드");
    expect(result.layer).toBe(2);
  });

  it("strict mode asks even when always-allowed cache matches", async () => {
    await pm.addAlwaysAllowedPersist("write_report");
    pm.setMode("strict");

    const result = pm.checkDetailed("write_report", "builtin", "write");

    expect(result.decision).toBe("ask");
    expect(result.reason).toContain("strict 모드");
    expect(result.layer).toBe(2);
  });

  it("trust-based terminal decision uses a unique layer number", () => {
    const result = pm.checkDetailed("builtin_read_tool", "builtin", "read");

    expect(result.decision).toBe("allow");
    expect(result.layer).toBe(6);
  });

  it("headless context routes write tools through reviewer before allow rules or auto mode", async () => {
    await pm.setModePersist("auto");
    await pm.addAlwaysAllowedPersist("write_report");

    const result = pm.checkDetailed(
      "write_report",
      "builtin",
      "write",
      null,
      { headless: true },
    );

    expect(result.decision).toBe("ask");
    expect(result.reason).toMatch(/reviewer agent/);
    expect(result.layer).toBe(6);
  });

  it("uses approvalCacheKey for authority-sensitive allow-always cache hits", async () => {
    await pm.addAlwaysAllowedPersist("routine_schedule:scope:allow:meeting");

    const sameScope = pm.checkDetailed(
      "routine_schedule",
      "builtin",
      "write",
      null,
      { approvalCacheKey: "routine_schedule:scope:allow:meeting" },
    );
    const widerScope = pm.checkDetailed(
      "routine_schedule",
      "builtin",
      "write",
      null,
      { approvalCacheKey: "routine_schedule:scope:allow:alpha-plugin,beta-plugin" },
    );

    expect(sameScope.decision).toBe("allow");
    expect(sameScope.layer).toBe(5);
    expect(widerScope.decision).toBe("ask");
    expect(widerScope.layer).toBe(6);
  });

  it("does not reuse bare tool-name allow rules when approvalCacheKey is present", async () => {
    await pm.addAlwaysAllowedPersist("routine_schedule");

    const result = pm.checkDetailed(
      "routine_schedule",
      "builtin",
      "write",
      null,
      { approvalCacheKey: "routine_schedule:scope:allow:meeting" },
    );

    expect(result.decision).toBe("ask");
    expect(result.layer).toBe(6);
  });
});

describe("PermissionManager — overlay-trigger origin override", () => {
  // Background: a user who once clicks "allow-always" on a write tool
  // (e.g. task_add) effectively delegated all future calls to that
  // tool. For the overlay trigger flow we want EVERY destructive
  // call to ask again — the user explicitly said "한번 더 체크할 수
  // 있도록". This guard wires a `overlayTriggerOrigin` parameter through
  // the executor so it's checked here BEFORE allow-rules / always-
  // allowed cache.
  let pm: PermissionManager;

  beforeEach(() => {
    mockStore.rules = [];
    mockStore.mode = "default";
    _mockLock = Promise.resolve();
    pm = new PermissionManager("/tmp/test-permissions.json");
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("forces ASK on a write tool when overlay trigger origin is set, even if always-allowed", async () => {
    await pm.addAlwaysAllowedPersist("task_add");
    // sanity: allow-always wins on a normal turn
    expect(
      pm.checkDetailed("task_add", "builtin", "write").decision,
    ).toBe("allow");
    // overlay trigger turn -> forced ask, regardless of the cached allow
    const r = pm.checkDetailed(
      "task_add",
      "builtin",
      "write",
      "overlay:meeting-detection",
    );
    expect(r.decision).toBe("ask");
    expect(r.reason).toMatch(/overlay trigger 출처/);
  });

  it("forces ASK on shell tools too", () => {
    // Permission policy — `shell` (formerly `dangerous`) is the 5-axis category for
    // bash/script execution. The overlay-trigger override must force ask
    // regardless of the user's allow-always cache.
    const r = pm.checkDetailed(
      "rm_anything",
      "builtin",
      "shell",
      "overlay:meeting-detection",
    );
    expect(r.decision).toBe("ask");
  });

  it("does NOT force ASK on read tools", async () => {
    await pm.addAlwaysAllowedPersist("email_read");
    const r = pm.checkDetailed(
      "email_read",
      "plugin",
      "read",
      "overlay:meeting-detection",
    );
    expect(r.decision).toBe("allow");
  });

  it("ignores non-overlay originSource strings (forward-compat)", async () => {
    await pm.addAlwaysAllowedPersist("task_add");
    // A future origin tag like "user-paste:x" must not trigger the
    // override — only "overlay:*" does.
    const r = pm.checkDetailed(
      "task_add",
      "builtin",
      "write",
      "user-paste:x",
    );
    expect(r.decision).toBe("allow");
  });

  it("deny rules still beat the overlay-trigger override (defense in depth)", async () => {
    await pm.addAlwaysDeniedPersist("task_add");
    const r = pm.checkDetailed(
      "task_add",
      "builtin",
      "write",
      "overlay:meeting-detection",
    );
    expect(r.decision).toBe("deny");
  });
});

describe("PermissionManager — broadcastConfigChanged SOT (round-5 regression guard)", () => {
  let pm: PermissionManager;

  beforeEach(() => {
    mockStore.rules = [];
    mockStore.mode = "default";
    _mockLock = Promise.resolve();
    pm = new PermissionManager("/tmp/test-permissions.json");
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("addAlwaysAllowedPersist fires broadcastConfigChanged when wired", async () => {
    const broadcast = vi.fn();
    pm.setBroadcastConfigChanged(broadcast);
    await pm.addAlwaysAllowedPersist("read_file");
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it("addAlwaysDeniedPersist fires broadcastConfigChanged when wired", async () => {
    const broadcast = vi.fn();
    pm.setBroadcastConfigChanged(broadcast);
    await pm.addAlwaysDeniedPersist("write_file");
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it("removeRule fires broadcastConfigChanged when wired", async () => {
    const broadcast = vi.fn();
    pm.setBroadcastConfigChanged(broadcast);
    // seed a rule so removeRule has something to remove
    await pm.addAlwaysAllowedPersist("read_file");
    broadcast.mockClear();
    await pm.removeRule("read_file", "allow");
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it("mutations do not throw when broadcastConfigChanged is not wired (optional contract)", async () => {
    // No setBroadcastConfigChanged call — the optional `?.` chain must
    // silently skip rather than crash early-boot or test setups that
    // don't need the renderer fan-out.
    await expect(pm.addAlwaysAllowedPersist("a")).resolves.toBeUndefined();
    await expect(pm.addAlwaysDeniedPersist("b")).resolves.toBeUndefined();
    await expect(pm.removeRule("a", "allow")).resolves.toBeUndefined();
  });
});

describe("PermissionManager — revoke controllers (cluster M1)", () => {
  let pm: PermissionManager;

  beforeEach(() => {
    mockStore.rules = [];
    mockStore.mode = "default";
    _mockLock = Promise.resolve();
    pm = new PermissionManager("/tmp/test-permissions.json");
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("getPluginRevokeSignal returns the same signal across calls until revoked", () => {
    const a1 = pm.getPluginRevokeSignal("plugin-a");
    const a2 = pm.getPluginRevokeSignal("plugin-a");
    expect(a1).toBe(a2);
    expect(a1.aborted).toBe(false);
  });

  it("revokePluginAccess aborts the current controller and recreates a fresh one", () => {
    const before = pm.getPluginRevokeSignal("plugin-a");
    expect(before.aborted).toBe(false);

    pm.revokePluginAccess("plugin-a", "test-reason");
    expect(before.aborted).toBe(true);
    // signal.reason is the Error we threw on abort
    const reason = (before as AbortSignal & { reason: unknown }).reason;
    expect((reason as Error).message).toContain("permission-revoked: test-reason");

    // Next call yields a fresh, un-aborted controller — outstanding bearers
    // released, future bearers re-resolve under the new policy.
    const after = pm.getPluginRevokeSignal("plugin-a");
    expect(after).not.toBe(before);
    expect(after.aborted).toBe(false);
  });

  it("addAlwaysDeniedPersist aborts outstanding bearers across all known plugins", async () => {
    const sigA = pm.getPluginRevokeSignal("plugin-a");
    const sigB = pm.getPluginRevokeSignal("plugin-b");
    expect(sigA.aborted).toBe(false);
    expect(sigB.aborted).toBe(false);

    await pm.addAlwaysDeniedPersist("some_tool");

    expect(sigA.aborted).toBe(true);
    expect(sigB.aborted).toBe(true);
  });

  it("addAlwaysAllowedPersist aborts outstanding bearers (rule change → re-resolve)", async () => {
    const sig = pm.getPluginRevokeSignal("plugin-a");
    expect(sig.aborted).toBe(false);
    await pm.addAlwaysAllowedPersist("safe_tool");
    expect(sig.aborted).toBe(true);
  });

  it("removeRule aborts outstanding bearers across all known plugins", async () => {
    await pm.addAlwaysAllowedPersist("removable_tool");
    const sig = pm.getPluginRevokeSignal("plugin-a");
    expect(sig.aborted).toBe(false);
    await pm.removeRule("removable_tool", "allow");
    expect(sig.aborted).toBe(true);
  });

  it("revokePluginAccess on unknown plugin is a safe no-op", () => {
    // No controller has been requested — revoke must not throw or create
    // spurious entries that leak memory.
    expect(() => pm.revokePluginAccess("never-seen", "test")).not.toThrow();
  });
});
