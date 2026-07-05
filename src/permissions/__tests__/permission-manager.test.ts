/**
 * PermissionManager unit tests — B1 persistence layer
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  PermissionManager,
  requiredTier,
  grantCovers,
  normalizeTier,
  tierRank,
  extractGrantPath,
  isStrictPathDescendant,
} from "../permission-manager.js";
import { updatePermissionsFile } from "../permissions-store.js";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ─── Mock permissions-store ───────────────────────────
// We mock the store module so tests don't touch the real filesystem.

const mockStore: { rules: Array<{ pattern: string; action: "allow" | "deny"; source?: string; tier?: "read" | "write" }>; mode: string } = {
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

    // 영구: store에 rule이 추가됐는지 (P2: 수동 경로 default write-tier)
    expect(mockStore.rules).toContainEqual({ pattern: "my_tool", action: "allow", tier: "write" });
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

// ─── P2 graduated grant tier ─────────────────────────

describe("P2 grant-tier helpers", () => {
  it("requiredTier maps read→read and every mutating category→write", () => {
    expect(requiredTier("read")).toBe("read");
    expect(requiredTier("write")).toBe("write");
    expect(requiredTier("shell")).toBe("write");
    expect(requiredTier("network")).toBe("write");
    // meta requires write so a read-tier grant cannot short-circuit it.
    expect(requiredTier("meta")).toBe("write");
  });

  it("grantCovers — write covers all, read covers only read", () => {
    for (const cat of ["read", "write", "shell", "network", "meta"] as const) {
      expect(grantCovers("write", cat)).toBe(true);
    }
    expect(grantCovers("read", "read")).toBe(true);
    expect(grantCovers("read", "write")).toBe(false);
    expect(grantCovers("read", "shell")).toBe(false);
    expect(grantCovers("read", "network")).toBe(false);
    expect(grantCovers("read", "meta")).toBe(false);
  });

  it("tierRank orders read below write", () => {
    expect(tierRank("read")).toBeLessThan(tierRank("write"));
  });

  it("normalizeTier keeps read, coerces everything else (garbage/undefined) to write", () => {
    expect(normalizeTier("read")).toBe("read");
    expect(normalizeTier("write")).toBe("write");
    expect(normalizeTier(undefined)).toBe("write");
    expect(normalizeTier("garbage")).toBe("write");
    expect(normalizeTier(42)).toBe("write");
    expect(normalizeTier(null)).toBe("write");
  });
});

describe("PermissionManager — P2 graduated grant tiers", () => {
  let pm: PermissionManager;

  beforeEach(() => {
    mockStore.rules = [];
    mockStore.mode = "default";
    _mockLock = Promise.resolve();
    pm = new PermissionManager("/tmp/test-tier-permissions.json");
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ── tier gate (in-session, layer-5 Map) ──────────────

  it("read-tier grant allows a read invocation but ASKS on write/shell/network", async () => {
    await pm.addAlwaysAllowedPersist("dual_tool", "read");

    // read invocation → covered (allow). read is allowed by policy anyway, but
    // this confirms the grant does not downgrade it.
    expect(pm.checkDetailed("dual_tool", "builtin", "read").decision).toBe("allow");

    // write/shell/network invocations of the same pattern → NOT covered → ask.
    const write = pm.checkDetailed("dual_tool", "builtin", "write");
    expect(write.decision).toBe("ask");
    expect(write.layer).toBe(6);
    expect(pm.checkDetailed("dual_tool", "builtin", "shell").decision).toBe("ask");
    expect(pm.checkDetailed("dual_tool", "builtin", "network").decision).toBe("ask");
  });

  it("write-tier grant covers read, write, shell, and network invocations", async () => {
    await pm.addAlwaysAllowedPersist("power_tool", "write");

    for (const cat of ["read", "write", "shell", "network"] as const) {
      const r = pm.checkDetailed("power_tool", "builtin", cat);
      expect(r.decision).toBe("allow");
      expect(r.layer).toBe(5);
    }
  });

  it("grandfather — an untiered persisted allow rule defaults to write-tier (covers writes)", () => {
    // A rule with no `tier` field (legacy / hand-edited) must preserve the
    // pre-P2 all-or-nothing behaviour = write-tier coverage.
    pm.setRules([{ pattern: "legacy_tool", action: "allow" }]);
    const r = pm.checkDetailed("legacy_tool", "builtin", "write");
    expect(r.decision).toBe("allow");
    expect(r.layer).toBe(3);
  });

  // ── restart-shadow regression (layer-3 gate) ─────────

  it("restart-shadow: a reloaded read-tier grant ASKS on write (layer-3 gate, not just layer-5)", async () => {
    // Simulate a persisted read-tier grant, then a fresh app process reloading
    // it. loadRulesFromFile hydrates the grant into BOTH this.rules (layer-3,
    // checked first) AND alwaysAllowed (layer-5). If the tier gate lived only at
    // layer-5, the layer-3 shadow would wrongly allow the write after restart.
    mockStore.rules = [{ pattern: "reloaded_tool", action: "allow", tier: "read" }];
    const fresh = new PermissionManager("/tmp/test-tier-permissions.json");
    await fresh.loadRulesFromFile();

    // read is covered (allowed by the reloaded grant / policy)…
    expect(fresh.checkDetailed("reloaded_tool", "builtin", "read").decision).toBe("allow");
    // …but the write invocation MUST ask — proving the layer-3 gate.
    const write = fresh.checkDetailed("reloaded_tool", "builtin", "write");
    expect(write.decision).toBe("ask");
    expect(write.layer).toBe(6);
  });

  it("restart-shadow: a reloaded write-tier grant still covers write after reload", async () => {
    mockStore.rules = [{ pattern: "reloaded_writer", action: "allow", tier: "write" }];
    const fresh = new PermissionManager("/tmp/test-tier-permissions.json");
    await fresh.loadRulesFromFile();

    const write = fresh.checkDetailed("reloaded_writer", "builtin", "write");
    expect(write.decision).toBe("allow");
    expect(write.layer).toBe(3);
  });

  // ── migration round-trip ─────────────────────────────

  it("migration round-trip — read grant persists tier:read and re-reads preserved", async () => {
    await pm.addAlwaysAllowedPersist("roundtrip_tool", "read");
    // Persisted with tier:read, version:1 kept (store serializes verbatim).
    expect(mockStore.rules).toContainEqual({
      pattern: "roundtrip_tool",
      action: "allow",
      tier: "read",
    });

    // A fresh process reloads the file — the read tier survives.
    const fresh = new PermissionManager("/tmp/test-tier-permissions.json");
    await fresh.loadRulesFromFile();
    expect(fresh.checkDetailed("roundtrip_tool", "builtin", "read").decision).toBe("allow");
    expect(fresh.checkDetailed("roundtrip_tool", "builtin", "write").decision).toBe("ask");
  });

  // ── monotonic upgrade / no downgrade ─────────────────

  it("monotonic — read then write upgrades the grant to write-tier", async () => {
    await pm.addAlwaysAllowedPersist("upgrade_tool", "read");
    expect(pm.checkDetailed("upgrade_tool", "builtin", "write").decision).toBe("ask");

    await pm.addAlwaysAllowedPersist("upgrade_tool", "write");
    // Now write is covered, and the persisted rule reflects the upgrade.
    expect(pm.checkDetailed("upgrade_tool", "builtin", "write").decision).toBe("allow");
    expect(mockStore.rules).toContainEqual({
      pattern: "upgrade_tool",
      action: "allow",
      tier: "write",
    });
    // No duplicate rule — upgrade mutated in place.
    expect(mockStore.rules.filter((r) => r.pattern === "upgrade_tool")).toHaveLength(1);
  });

  it("monotonic — write then read never downgrades (stays write-tier)", async () => {
    await pm.addAlwaysAllowedPersist("noshrink_tool", "write");
    await pm.addAlwaysAllowedPersist("noshrink_tool", "read");

    // Still covers write — the read re-grant was a no-op.
    expect(pm.checkDetailed("noshrink_tool", "builtin", "write").decision).toBe("allow");
    expect(mockStore.rules).toContainEqual({
      pattern: "noshrink_tool",
      action: "allow",
      tier: "write",
    });
  });

  it("manual default — addAlwaysAllowedPersist with no tier arg grants write-tier", async () => {
    await pm.addAlwaysAllowedPersist("manual_tool");
    expect(pm.checkDetailed("manual_tool", "builtin", "write").decision).toBe("allow");
    expect(mockStore.rules).toContainEqual({
      pattern: "manual_tool",
      action: "allow",
      tier: "write",
    });
  });

  it("garbage persisted tier is grandfathered to write-tier on reload", async () => {
    // A hand-edited file with an invalid tier must fail to write-tier (most
    // permissive — preserves the saved grant), never silently to read.
    mockStore.rules = [
      { pattern: "corrupt_tool", action: "allow", tier: "banana" as unknown as "read" },
    ];
    const fresh = new PermissionManager("/tmp/test-tier-permissions.json");
    await fresh.loadRulesFromFile();
    expect(fresh.checkDetailed("corrupt_tool", "builtin", "write").decision).toBe("allow");
  });

  // ── MINOR-1: layer-3 glob + corrupt tier grandfathers to write ──────────────

  it("MINOR-1: glob allow rule with corrupt tier grandfathers to write at layer-3 (not ask)", () => {
    // A hand-edited rule with an invalid tier string must NOT cause the gate to
    // skip the glob and produce an ask. normalizeTier maps anything non-"read"
    // to "write" (external-boundary grandfather), so the glob still fires and
    // the write is allowed. Without this fix, `?? "write"` passes the raw
    // garbage string into grantCovers whose TIER_RANK lookup yields undefined →
    // the >= comparison is false → the glob is skipped → writes ask.
    pm.setRules([{ pattern: "mem_*", action: "allow", tier: "banana" as unknown as "write" }]);

    const r = pm.checkDetailed("mem_tool", "builtin", "write");
    expect(r.decision).toBe("allow");
    expect(r.layer).toBe(3);
  });

  // ── MINOR-2: dup-hit tier reconciliation (boot-default shadow) ───────────

  it("MINOR-2: persisted read-tier grant matching an untiered boot default is not lost to dedup", async () => {
    // Simulate the boot-default scenario: setRules pre-seeds an untiered allow
    // rule (like web_search/web_fetch in conversation.ts), then loadRulesFromFile
    // loads a user-persisted read-tier grant for the same pattern. Previously the
    // dedup branch skipped the Map update entirely, leaving the Map empty — so
    // layer-5 missed the pattern and layer-3's untiered surviving rule grandfathered
    // to write, silently over-permitting writes relative to the user's intent.
    // After the MINOR-2 fix, the surviving rule's tier AND the Map are reconciled
    // to merged = maxTier(Map.get(undefined), normalizeTier("read")) = "read".
    pm.setRules([{ pattern: "boot_tool", action: "allow" }]); // untiered boot default

    mockStore.rules = [{ pattern: "boot_tool", action: "allow", tier: "read" }];
    await pm.loadRulesFromFile();

    // Reads are still covered.
    expect(pm.checkDetailed("boot_tool", "builtin", "read").decision).toBe("allow");
    // Writes MUST ask — user's explicit read-tier persisted intent wins.
    expect(pm.checkDetailed("boot_tool", "builtin", "write").decision).toBe("ask");
  });

  // ── P1 post-guard composition (meta + write grant + override:ask) ─────────

  it("post-guard composes with tier gate: meta write-grant → allow then ask+forceModal", async () => {
    // A write-tier grant covers meta (write ≥ requiredTier(meta)=write), so the
    // layer produces allow — then the P1 per-invocation post-guard re-elevates
    // an author's decisionOverride:'ask' to ask+forceModal.
    await pm.addAlwaysAllowedPersist("agent_spawn", "write");
    const r = pm.checkDetailed("agent_spawn", "builtin", "meta", null, {
      decisionOverride: "ask",
    });
    expect(r.decision).toBe("ask");
    expect(r.forceModal).toBe(true);
    expect(r.layer).toBe(6);
  });
});

// ── #1493 prunePathGrantsUnderRoot + helpers ─────────────────────────────────
// Real temp dirs so canonicalizePathForMatch (realpathSync) resolves the root
// and the grant patterns' paths consistently. The store is still the module
// mock above, so persistence stays in-memory.
describe("PermissionManager.prunePathGrantsUnderRoot (#1493)", () => {
  let pm: PermissionManager;
  let root: string;

  beforeEach(() => {
    mockStore.rules = [];
    mockStore.mode = "default";
    _mockLock = Promise.resolve();
    pm = new PermissionManager("/tmp/test-permissions.json");
    root = realpathSync.native(mkdtempSync(join(tmpdir(), "lvis-prune-")));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("prunes an allow grant whose path is strictly under the removed root", async () => {
    const under = join(root, "sub", "note.md");
    await pm.addAlwaysAllowedPersist(`write_file:path:${under}`, "write");
    expect(mockStore.rules).toHaveLength(1);

    const pruned = await pm.prunePathGrantsUnderRoot(root);
    expect(pruned).toBe(1);
    expect(mockStore.rules).toHaveLength(0);
    // In-memory alwaysAllowed entry also cleared → the grant no longer allows.
    expect(pm.checkDetailed(`write_file:path:${under}`, "builtin", "write").decision).toBe("ask");
  });

  it("keeps a grant on the root directory entry itself (strict descendant only)", async () => {
    await pm.addAlwaysAllowedPersist(`read_file:path:${root}`, "read");
    const pruned = await pm.prunePathGrantsUnderRoot(root);
    expect(pruned).toBe(0);
    expect(mockStore.rules).toHaveLength(1);
  });

  it("keeps a grant under a sibling root (no false path-prefix match)", async () => {
    // `${root}-other` shares the `${root}` string prefix but is NOT a descendant
    // — the separator-boundary guard must reject it.
    const sibling = realpathSync.native(mkdtempSync(join(tmpdir(), "lvis-prune-sibling-")));
    try {
      const underSibling = join(sibling, "file.md");
      await pm.addAlwaysAllowedPersist(`write_file:path:${underSibling}`, "write");
      const pruned = await pm.prunePathGrantsUnderRoot(root);
      expect(pruned).toBe(0);
      expect(mockStore.rules).toHaveLength(1);
    } finally {
      rmSync(sibling, { recursive: true, force: true });
    }
  });

  it("never prunes deny rules or non-path tool-name grants", async () => {
    await pm.addAlwaysAllowedPersist("web_fetch", "read"); // plain tool-name glob
    await pm.addAlwaysDeniedPersist(`write_file:path:${join(root, "x.md")}`); // deny under root
    const pruned = await pm.prunePathGrantsUnderRoot(root);
    expect(pruned).toBe(0);
    expect(mockStore.rules).toHaveLength(2);
  });

  it("prunes multiple grants and reports the count", async () => {
    await pm.addAlwaysAllowedPersist(`write_file:path:${join(root, "a.md")}`, "write");
    await pm.addAlwaysAllowedPersist(`edit_file:path:${join(root, "deep", "b.ts")}`, "write");
    await pm.addAlwaysAllowedPersist("web_fetch", "read"); // untouched
    const pruned = await pm.prunePathGrantsUnderRoot(root);
    expect(pruned).toBe(2);
    expect(mockStore.rules).toHaveLength(1);
    expect(mockStore.rules[0]!.pattern).toBe("web_fetch");
  });

  it("returns 0 when nothing matches (no persist side effect)", async () => {
    await pm.addAlwaysAllowedPersist("web_fetch", "read");
    const pruned = await pm.prunePathGrantsUnderRoot(root);
    expect(pruned).toBe(0);
    expect(mockStore.rules).toHaveLength(1);
  });
});

describe("path-grant prune helpers (#1493)", () => {
  it("extractGrantPath returns the path tail after the marker (Windows drive-safe)", () => {
    expect(extractGrantPath("write_file:path:/home/ken/a.md")).toBe("/home/ken/a.md");
    expect(extractGrantPath("write_file:path:C:\\Users\\ken\\a.md")).toBe("C:\\Users\\ken\\a.md");
    expect(extractGrantPath("web_fetch")).toBeNull();
    expect(extractGrantPath("write_file:path:")).toBeNull();
  });

  it("isStrictPathDescendant matches descendants, rejects self + sibling-prefix", () => {
    expect(isStrictPathDescendant("/a/b", "/a/b/c")).toBe(true);
    expect(isStrictPathDescendant("/a/b", "/a/b")).toBe(false); // self
    expect(isStrictPathDescendant("/a/b", "/a/bc")).toBe(false); // sibling prefix
    expect(isStrictPathDescendant("/a/b/", "/a/b/c")).toBe(true); // trailing-slash root
    expect(isStrictPathDescendant("C:/a", "C:/a/b")).toBe(true);
  });
});
