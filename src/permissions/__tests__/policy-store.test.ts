/**
 * policy-store unit tests — B1 managed policy layer + §C2 admin-dir merge
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadPolicy, savePolicy, getAdminPolicyPath } from "../policy-store.js";
import { makeTestPolicy } from "./test-helpers.js";

// ─── Mock fs/promises ─────────────────────────────────
// Intercept readFile / mkdir / open so tests stay in-memory.

type MockFileStore = Record<string, string>;

const files: MockFileStore = {};

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn(async () => undefined),
  readFile: vi.fn(async (path: string) => {
    const content = files[path as string];
    if (content === undefined) {
      const err = Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      throw err;
    }
    return content;
  }),
  writeFile: vi.fn(async (path: string, data: string) => {
    files[path as string] = data;
  }),
  // §F6: open() mock — returns fd-like object with writeFile + close
  open: vi.fn(async (path: string, _flags: string, _mode: number) => ({
    writeFile: vi.fn(async (data: string) => {
      files[path] = data;
    }),
    close: vi.fn(async () => undefined),
  })),
}));

// ─── Helpers ─────────────────────────────────────────

const USER_PATH  = "/tmp/lvis-test/policy.json";
const ADMIN_PATH = "/tmp/lvis-admin/policy.json";

function writeFile(path: string, obj: object): void {
  files[path] = JSON.stringify(obj, null, 2) + "\n";
}

// ─── Tests ───────────────────────────────────────────

describe("policy-store", () => {
  beforeEach(() => {
    delete files[USER_PATH];
    delete files[ADMIN_PATH];
    vi.clearAllMocks();
  });

  // ══════════════════════════════════════════════════
  // Original B1 cases (regression — admin-dir absent)
  // ══════════════════════════════════════════════════

  it("파일 없을 때 lenient default 반환", async () => {
    const policy = await loadPolicy(USER_PATH, ADMIN_PATH);
    expect(policy.version).toBe(1);
    expect(policy.requireExplicitApproval).toBe(true);
    expect(policy.managed).toBe(false);
    expect(policy.source).toBe("defaults");
    expect(policy.updatedAt).toBeTruthy();
  });

  it("저장 후 load하면 같은 값", async () => {
    const saved = await savePolicy({ requireExplicitApproval: false }, USER_PATH, ADMIN_PATH);
    expect(saved.requireExplicitApproval).toBe(false);

    const loaded = await loadPolicy(USER_PATH, ADMIN_PATH);
    expect(loaded.requireExplicitApproval).toBe(false);
    expect(loaded.version).toBe(1);
    expect(loaded.managed).toBe(false);
    expect(loaded.source).toBe("user");
  });

  it("managed: true 박혀있을 때 savePolicy가 throw", async () => {
    writeFile(USER_PATH, makeTestPolicy({ managed: true }));

    await expect(
      savePolicy({ requireExplicitApproval: false }, USER_PATH, ADMIN_PATH),
    ).rejects.toThrow("IT 관리 정책은 사용자가 변경할 수 없습니다.");
  });

  it("managed 플래그는 사용자가 patch로 변경 불가", async () => {
    const saved = await savePolicy(
      // @ts-expect-error — 의도적 타입 위반 테스트
      { requireExplicitApproval: false, managed: true },
      USER_PATH, ADMIN_PATH,
    );
    expect(saved.managed).toBe(false);
  });

  it("동시 2개 save가 serialize — 둘 다 반영됨", async () => {
    const [r1, r2] = await Promise.all([
      savePolicy({ requireExplicitApproval: false }, USER_PATH, ADMIN_PATH),
      savePolicy({ requireExplicitApproval: true },  USER_PATH, ADMIN_PATH),
    ]);

    expect(r1.version).toBe(1);
    expect(r2.version).toBe(1);

    const final = await loadPolicy(USER_PATH, ADMIN_PATH);
    expect(final.requireExplicitApproval).toBe(true);
  });

  // ══════════════════════════════════════════════════
  // §C2 admin-dir merge cases
  // ══════════════════════════════════════════════════

  it("admin-dir 없음 → user만 사용, source: 'user'", async () => {
    writeFile(USER_PATH, makeTestPolicy({ requireExplicitApproval: false }));

    const result = await loadPolicy(USER_PATH, ADMIN_PATH);
    expect(result.source).toBe("user");
    expect(result.requireExplicitApproval).toBe(false);
    expect(result.adminPath).toBeUndefined();
  });

  it("admin-dir 존재 + user 존재 → merged, admin 값 우선", async () => {
    writeFile(USER_PATH,  makeTestPolicy({ requireExplicitApproval: false, managed: false }));
    writeFile(ADMIN_PATH, makeTestPolicy({ requireExplicitApproval: true,  managed: true  }));

    const result = await loadPolicy(USER_PATH, ADMIN_PATH);
    expect(result.source).toBe("merged");
    expect(result.requireExplicitApproval).toBe(true);   // admin wins
    expect(result.managed).toBe(true);                   // admin wins
    expect(result.adminPath).toBe(ADMIN_PATH);
    expect(result.adminOverrides).toContain("requireExplicitApproval");
    expect(result.adminOverrides).toContain("managed");
  });

  it("admin managed:true + user managed:false → 최종 managed:true", async () => {
    writeFile(USER_PATH,  makeTestPolicy({ managed: false }));
    writeFile(ADMIN_PATH, makeTestPolicy({ managed: true  }));

    const result = await loadPolicy(USER_PATH, ADMIN_PATH);
    expect(result.managed).toBe(true);
    expect(result.source).toBe("merged");
  });

  it("admin-dir만 존재(user 없음) → source: 'admin'", async () => {
    writeFile(ADMIN_PATH, makeTestPolicy({ requireExplicitApproval: false, managed: true }));

    const result = await loadPolicy(USER_PATH, ADMIN_PATH);
    expect(result.source).toBe("admin");
    expect(result.managed).toBe(true);
    expect(result.requireExplicitApproval).toBe(false);
    expect(result.adminPath).toBe(ADMIN_PATH);
  });

  it("admin-dir 존재 시 savePolicy throw (admin-dir file exists)", async () => {
    writeFile(ADMIN_PATH, makeTestPolicy({ managed: true }));

    await expect(
      savePolicy({ requireExplicitApproval: false }, USER_PATH, ADMIN_PATH),
    ).rejects.toThrow("Policy is managed by IT (admin-dir file exists)");
  });

  it("admin-dir path가 invalid JSON일 때 user로 fallback", async () => {
    writeFile(USER_PATH,  makeTestPolicy({ requireExplicitApproval: false }));
    // 잘못된 JSON
    files[ADMIN_PATH] = "not-valid-json";

    const result = await loadPolicy(USER_PATH, ADMIN_PATH);
    // admin parse 실패 → user만 적용
    expect(result.source).toBe("user");
    expect(result.requireExplicitApproval).toBe(false);
  });

  it("admin-dir version 불일치 시 admin 무시, user로 fallback", async () => {
    writeFile(USER_PATH,  makeTestPolicy({ requireExplicitApproval: false }));
    writeFile(ADMIN_PATH, JSON.stringify({ version: 2, requireExplicitApproval: true, managed: true, updatedAt: new Date().toISOString() }, null, 2) + "\n");

    const result = await loadPolicy(USER_PATH, ADMIN_PATH);
    // version 2 → null (ignored) → user만
    expect(result.source).toBe("user");
    expect(result.requireExplicitApproval).toBe(false);
  });

  // ══════════════════════════════════════════════════
  // §C2 platform path tests
  // ══════════════════════════════════════════════════

  describe("getAdminPolicyPath — 플랫폼별 경로", () => {
    const platforms: Array<[string, string]> = [
      ["darwin",  "/Library/Application Support/LVIS/policy.json"],
      ["linux",   "/etc/lvis/policy.json"],
    ];

    for (const [platform, expected] of platforms) {
      it(`${platform} → ${expected}`, () => {
        const original = process.platform;
        Object.defineProperty(process, "platform", { value: platform, configurable: true });
        try {
          expect(getAdminPolicyPath()).toBe(expected);
        } finally {
          Object.defineProperty(process, "platform", { value: original, configurable: true });
        }
      });
    }

    it("win32 → ProgramData/LVIS/policy.json", () => {
      const original = process.platform;
      const origPD = process.env.ProgramData;
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      process.env.ProgramData = "C:\\ProgramData";
      try {
        const p = getAdminPolicyPath();
        expect(p).toContain("LVIS");
        expect(p).toContain("policy.json");
        expect(p).toContain("ProgramData");
      } finally {
        Object.defineProperty(process, "platform", { value: original, configurable: true });
        if (origPD === undefined) delete process.env.ProgramData;
        else process.env.ProgramData = origPD;
      }
    });
  });
});
