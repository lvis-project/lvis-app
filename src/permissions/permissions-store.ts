/**
 * Permissions Store — ~/.lvis/permissions.json 비동기 직렬 읽기/쓰기
 *
 * in-process async mutex + cross-process proper-lockfile 이중 잠금.
 * 키: 파일 절대경로 → 직렬화된 Promise 체인 (in-process).
 * proper-lockfile: 여러 Electron 인스턴스 동시 실행 시 race 방지 (cross-process).
 */
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { PermissionRule, ExecutionMode } from "./permission-manager.js";
import { withFileLock } from "../lib/with-file-lock.js";

// ─── 파일 형태 ────────────────────────────────────────

export interface PermissionsFile {
  version: 1;
  rules: PermissionRule[];
  mode: ExecutionMode;
  updatedAt: string;
}

// ─── in-process async mutex (§M1 패턴) ──────────────

const permissionsLocks = new Map<string, Promise<void>>();

async function withPermissionsLock<T>(
  filePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = resolve(filePath);
  const prev = permissionsLocks.get(key) ?? Promise.resolve();
  const next = prev.then(() => fn());
  // 다음 대기자는 이번 턴 완료 여부에 관계없이 체이닝
  permissionsLocks.set(key, next.then(() => undefined, () => undefined));
  return next;
}

// ─── Read ────────────────────────────────────────────

export async function readPermissionsFile(filePath: string): Promise<PermissionsFile | null> {
  try {
    const raw = await readFile(filePath, "utf-8");
    if (!raw.trim()) return null;
    const parsed = JSON.parse(raw) as PermissionsFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.rules)) return null;
    return parsed;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (err instanceof SyntaxError) return null;
    throw err;
  }
}

// ─── Write (atomic read-modify-write under lock) ─────

export async function updatePermissionsFile(
  filePath: string,
  mutator: (file: PermissionsFile) => void | Promise<void>,
): Promise<void> {
  await withPermissionsLock(filePath, async () => {
    await withFileLock(filePath, async () => {
      const existing = await readPermissionsFile(filePath);
      const file: PermissionsFile = existing ?? {
        version: 1,
        rules: [],
        mode: "default",
        updatedAt: new Date().toISOString(),
      };
      await mutator(file);
      file.updatedAt = new Date().toISOString();
      await mkdir(dirname(filePath), { recursive: true });
      // §S4: 0o600 — owner read/write only (world-readable 방지)
      const fd = await open(filePath, "w", 0o600);
      try {
        await fd.writeFile(`${JSON.stringify(file, null, 2)}\n`, "utf-8");
      } finally {
        await fd.close();
      }
    });
  });
}
