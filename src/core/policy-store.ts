/**
 * Policy Store — ~/.lvis/policy.json 비동기 직렬 읽기/쓰기
 *
 * managed 플래그로 IT/회사가 설정을 잠글 수 있다.
 * managed: true → savePolicy()가 오류 throw → 사용자 UI에서 변경 불가.
 *
 * TODO Phase 2: IT Admin API에서 policy를 push하고 managed를 lock.
 *
 * async-mutex 패턴: permissions-store.ts §M1 복사 (경로 기반 lock map).
 */
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";

// ─── 기본 경로 ────────────────────────────────────────

const DEFAULT_POLICY_PATH = resolve(homedir(), ".lvis", "policy.json");

// ─── 파일 형태 ────────────────────────────────────────

export interface PolicyFile {
  version: 1;
  /** true = 모달 dismiss 차단, false = outside/Escape → deny-once */
  requireExplicitApproval: boolean;
  /** true = IT 설정, 사용자 UI에서 변경 불가 (savePolicy 시 throw) */
  managed: boolean;
  updatedAt: string;
}

// ─── lenient default (파일 없을 때) ─────────────────

function defaultPolicy(): PolicyFile {
  return {
    version: 1,
    requireExplicitApproval: true,
    managed: false,
    updatedAt: new Date().toISOString(),
  };
}

// ─── in-process async mutex (§M1 패턴 복사) ─────────

const policyLocks = new Map<string, Promise<void>>();

async function withPolicyLock<T>(
  filePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = resolve(filePath);
  const prev = policyLocks.get(key) ?? Promise.resolve();
  const next = prev.then(() => fn());
  // 다음 대기자는 이번 턴 완료 여부에 관계없이 체이닝
  policyLocks.set(key, next.then(() => undefined, () => undefined));
  return next;
}

// ─── Read ────────────────────────────────────────────

async function readPolicyFile(filePath: string): Promise<PolicyFile | null> {
  try {
    const raw = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as PolicyFile;
    if (parsed.version !== 1) return null;
    return parsed;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

// ─── Public API ──────────────────────────────────────

/**
 * 파일에서 policy를 로드한다.
 * 파일이 없으면 기본값(requireExplicitApproval: true, managed: false)을 반환.
 */
export async function loadPolicy(filePath = DEFAULT_POLICY_PATH): Promise<PolicyFile> {
  const existing = await readPolicyFile(filePath);
  return existing ?? defaultPolicy();
}

/**
 * policy를 디스크에 저장한다.
 *
 * 현재 파일에 managed: true가 박혀 있으면
 * Error("IT 관리 정책은 사용자가 변경할 수 없습니다.") throw.
 *
 * managed 플래그 자체는 patch로 변경할 수 없다 — IT Admin API 전용 (Phase 2+).
 */
export async function savePolicy(
  patch: Partial<Omit<PolicyFile, "version" | "managed" | "updatedAt">>,
  filePath = DEFAULT_POLICY_PATH,
): Promise<PolicyFile> {
  return withPolicyLock(filePath, async () => {
    const existing = await readPolicyFile(filePath);

    // managed: true이면 사용자 변경 차단
    if (existing?.managed === true) {
      throw new Error("IT 관리 정책은 사용자가 변경할 수 없습니다.");
    }

    const current = existing ?? defaultPolicy();
    const updated: PolicyFile = {
      ...current,
      ...patch,
      version: 1,
      managed: current.managed, // 사용자가 managed를 바꿀 수 없음
      updatedAt: new Date().toISOString(),
    };

    await mkdir(dirname(filePath), { recursive: true });
    // §S4: 0o600 — owner read/write only (world-readable 방지)
    const fd = await open(filePath, "w", 0o600);
    try {
      await fd.writeFile(`${JSON.stringify(updated, null, 2)}\n`, "utf-8");
    } finally {
      await fd.close();
    }

    return updated;
  });
}
