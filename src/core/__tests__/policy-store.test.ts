/**
 * policy-store unit tests — B1 managed policy layer
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadPolicy, savePolicy } from "../policy-store.js";

// ─── Mock fs/promises ─────────────────────────────────
// Intercept readFile / writeFile / mkdir so tests stay in-memory.

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

const TEST_PATH = "/tmp/lvis-test/policy.json";

function writePolicyFile(obj: object): void {
  files[TEST_PATH] = JSON.stringify(obj, null, 2) + "\n";
}

// ─── Tests ───────────────────────────────────────────

describe("policy-store", () => {
  beforeEach(() => {
    // 각 테스트 전 파일 스토어 초기화
    delete files[TEST_PATH];
    vi.clearAllMocks();
  });

  // ── loadPolicy ────────────────────────────────────

  it("파일 없을 때 lenient default 반환", async () => {
    const policy = await loadPolicy(TEST_PATH);
    expect(policy.version).toBe(1);
    expect(policy.requireExplicitApproval).toBe(true);
    expect(policy.managed).toBe(false);
    expect(policy.updatedAt).toBeTruthy();
  });

  it("저장 후 load하면 같은 값", async () => {
    const saved = await savePolicy({ requireExplicitApproval: false }, TEST_PATH);
    expect(saved.requireExplicitApproval).toBe(false);

    const loaded = await loadPolicy(TEST_PATH);
    expect(loaded.requireExplicitApproval).toBe(false);
    expect(loaded.version).toBe(1);
    expect(loaded.managed).toBe(false);
  });

  it("managed: true 박혀있을 때 savePolicy가 throw", async () => {
    writePolicyFile({
      version: 1,
      requireExplicitApproval: true,
      managed: true,
      updatedAt: new Date().toISOString(),
    });

    await expect(
      savePolicy({ requireExplicitApproval: false }, TEST_PATH),
    ).rejects.toThrow("IT 관리 정책은 사용자가 변경할 수 없습니다.");
  });

  it("managed 플래그는 사용자가 patch로 변경 불가", async () => {
    // managed: false 상태에서 patch에 managed 전달해도 무시됨
    // savePolicy의 Omit 시그니처 때문에 TS에서도 막히지만,
    // 런타임에서도 managed가 덮이지 않아야 한다
    const saved = await savePolicy(
      // @ts-expect-error — 의도적 타입 위반 테스트
      { requireExplicitApproval: false, managed: true },
      TEST_PATH,
    );
    expect(saved.managed).toBe(false);
  });

  // ── concurrent writes serialize ───────────────────

  it("동시 2개 save가 serialize — 둘 다 반영됨", async () => {
    // 첫 번째 save: requireExplicitApproval false
    // 두 번째 save: requireExplicitApproval true (덮어씀)
    // 직렬화되면 마지막 값이 최종
    const [r1, r2] = await Promise.all([
      savePolicy({ requireExplicitApproval: false }, TEST_PATH),
      savePolicy({ requireExplicitApproval: true }, TEST_PATH),
    ]);

    // 둘 다 성공 (throw 없음)
    expect(r1.version).toBe(1);
    expect(r2.version).toBe(1);

    // 파일에 마지막 write가 반영됨 (직렬화 보장)
    const final = await loadPolicy(TEST_PATH);
    // r2가 r1보다 나중 — 최종값은 true
    expect(final.requireExplicitApproval).toBe(true);
  });
});
