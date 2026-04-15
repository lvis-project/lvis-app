/**
 * PermissionManager unit tests — B1 persistence layer
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PermissionManager } from "../permission-manager.js";

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

    // 영구: store에 rule이 추가됐는지
    expect(mockStore.rules).toContainEqual({ pattern: "my_tool", action: "allow" });
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

    expect(mockStore.rules).toContainEqual({ pattern: "dangerous_tool", action: "deny" });
  });

  // ── loadRulesFromFile ────────────────────────────

  it("loadRulesFromFile rehydrates allow rules into in-memory", async () => {
    // 파일에 규칙 사전 세팅
    mockStore.rules = [{ pattern: "pre_allowed_tool", action: "allow" }];

    const fresh = new PermissionManager("/tmp/test-permissions.json");
    await fresh.loadRulesFromFile();

    const result = fresh.checkDetailed("pre_allowed_tool", "builtin", "write");
    expect(result.decision).toBe("allow");
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
});
