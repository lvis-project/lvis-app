/**
 * Policy Store — ~/.lvis/policy.json + admin-dir merge (§C2)
 *
 * 병합 순서 (나중 값이 우선):
 *  1. defaults: { version:1, requireExplicitApproval: true, managed: false }
 *  2. userPath:  ~/.lvis/policy.json
 *  3. adminPath: 플랫폼별 OS 관리자 위치 (존재 시에만)
 *
 * admin-dir 파일이 존재하면:
 *  - admin 값이 user 값을 override.
 *  - admin의 managed=true → 최종 managed가 항상 true.
 *  - savePolicy() 호출 시 admin-dir 파일 존재 여부를 먼저 체크하여 throw.
 *
 * ACL 강제는 하지 않는다 — OS 수준 쓰기 방지는 IT/MDM 담당.
 * admin-dir 파일의 부재가 기본 상황 (개발자 머신 / 해외망).
 *
 * async-mutex 패턴: permissions-store.ts §M1 복사.
 *
 * TODO: Windows (certutil), Linux (/etc/lvis) admin-dir 검증 강화.
 */
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createLogger } from "../lib/logger.js";
import { lvisHome } from "../shared/lvis-home.js";
const log = createLogger("policy-store");

// ─── 기본 경로 ────────────────────────────────────────

const DEFAULT_USER_POLICY_PATH = resolve(lvisHome(), "policy.json");

/**
 * 플랫폼별 admin-dir policy 경로.
 * 일반 사용자가 수정할 수 없는 OS 관리자 위치.
 */
export function getAdminPolicyPath(): string {
  switch (process.platform) {
    case "darwin":
      return "/Library/Application Support/LVIS/policy.json";
    case "win32":
      return join(process.env.ProgramData ?? "C:\\ProgramData", "LVIS", "policy.json");
    case "linux":
      return "/etc/lvis/policy.json";
    default:
      // 미지원 플랫폼: 존재하지 않는 경로 → 항상 null 반환 (soft skip)
      return "/nonexistent/lvis/policy.json";
  }
}

// ─── 파일 형태 ────────────────────────────────────────

export interface PolicyFile {
  version: 1;
  /** true = 모달 dismiss 차단, false = outside/Escape → deny-once */
  requireExplicitApproval: boolean;
  /** true = IT 설정, 사용자 UI에서 변경 불가 */
  managed: boolean;
  updatedAt: string;
}

/**
 * loadPolicy() 반환 형태 — source tracking 추가.
 */
export interface LoadedPolicy extends PolicyFile {
  /** 어디서 왔는지 추적 */
  source: "defaults" | "user" | "admin" | "merged";
  /** admin이 override한 필드 이름 리스트 (merged일 때만 의미 있음) */
  adminOverrides?: string[];
  /** admin-dir 경로 (source가 "admin" 또는 "merged"일 때 설정됨) */
  adminPath?: string;
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
  policyLocks.set(key, next.then(() => undefined, () => undefined));
  return next;
}

// ─── Read (single file) ───────────────────────────────

async function readPolicyFile(filePath: string): Promise<PolicyFile | null> {
  try {
    const raw = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as PolicyFile;
    if (parsed.version !== 1) {
      // major version 불일치 → fallback (에러 로그만)
      log.error(`version mismatch in ${filePath}: expected 1, got ${parsed.version} — ignoring`);
      return null;
    }
    return parsed;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    // JSON parse error 등 — 에러 로그 + fallback
    log.error(`failed to read ${filePath}: %s`, (err as Error).message);
    return null;
  }
}

// ─── Public API ──────────────────────────────────────

/**
 * policy를 로드한다. admin-dir 파일이 있으면 user 파일보다 우선 merge.
 *
 * 반환값의 `source` 필드:
 *  - "defaults": 파일 없음 → 기본값
 *  - "user":     user 파일만 존재
 *  - "admin":    admin 파일만 존재 (또는 user 파일 없이 admin만)
 *  - "merged":   둘 다 존재, admin이 user를 override
 *
 * @param userPath  사용자 policy 파일 경로 (기본: ~/.lvis/policy.json)
 * @param adminPath admin policy 파일 경로 (기본: getAdminPolicyPath())
 */
export async function loadPolicy(
  userPath = DEFAULT_USER_POLICY_PATH,
  adminPath = getAdminPolicyPath(),
): Promise<LoadedPolicy> {
  const [userFile, adminFile] = await Promise.all([
    readPolicyFile(userPath),
    readPolicyFile(adminPath),
  ]);

  // case 1: 둘 다 없음 → defaults
  if (!userFile && !adminFile) {
    return { ...defaultPolicy(), source: "defaults" };
  }

  // case 2: user만 존재
  if (userFile && !adminFile) {
    return { ...userFile, source: "user" };
  }

  // case 3: admin만 존재 (user 없음)
  if (!userFile && adminFile) {
    return { ...adminFile, source: "admin", adminPath };
  }

  // case 4: 둘 다 존재 → merge (admin wins)
  const base = { ...defaultPolicy(), ...userFile! };
  const overrides: string[] = [];
  const merged = { ...base };

  const adminFields = adminFile!;
  // requireExplicitApproval
  if (adminFields.requireExplicitApproval !== undefined &&
      adminFields.requireExplicitApproval !== base.requireExplicitApproval) {
    merged.requireExplicitApproval = adminFields.requireExplicitApproval;
    overrides.push("requireExplicitApproval");
  }
  // managed: admin true → always true
  if (adminFields.managed === true) {
    merged.managed = true;
    if (!base.managed) overrides.push("managed");
  }
  // updatedAt: use admin's timestamp when merged
  merged.updatedAt = adminFields.updatedAt;

  return {
    ...merged,
    version: 1,
    source: "merged",
    adminPath,
    adminOverrides: overrides,
  };
}

/**
 * policy를 디스크에 저장한다.
 *
 * 차단 조건 (우선순위):
 *  1. admin-dir 파일이 존재하면 항상 throw ("Policy is managed by IT (admin-dir file exists)")
 *  2. user 파일의 managed: true → throw ("IT 관리 정책은 사용자가 변경할 수 없습니다.")
 *
 * managed 플래그 자체는 patch로 변경 불가 — IT Admin API 전용.
 */
export async function savePolicy(
  patch: Partial<Omit<PolicyFile, "version" | "managed" | "updatedAt">>,
  userPath = DEFAULT_USER_POLICY_PATH,
  adminPath = getAdminPolicyPath(),
): Promise<PolicyFile> {
  return withPolicyLock(userPath, async () => {
    // admin-dir 우선 체크
    const adminFile = await readPolicyFile(adminPath);
    if (adminFile !== null) {
      throw new Error("Policy is managed by IT (admin-dir file exists)");
    }

    const existing = await readPolicyFile(userPath);

    // user managed: true 체크 (기존 B1 동작 유지)
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

    await mkdir(dirname(userPath), { recursive: true });
    // §S4: 0o600 — owner read/write only
    const fd = await open(userPath, "w", 0o600);
    try {
      await fd.writeFile(`${JSON.stringify(updated, null, 2)}\n`, "utf-8");
    } finally {
      await fd.close();
    }

    return updated;
  });
}
