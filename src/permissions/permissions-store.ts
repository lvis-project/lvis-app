



import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { PermissionRule } from "./permission-manager.js";
import type { ExecutionMode } from "../shared/permission-mode.js";
import { withFileLock } from "../lib/with-file-lock.js";
import { writeUtf8FileAtomicSync, isMissingPathError } from "../lib/atomic-file.js";



export interface PermissionsFile {
  version: 1;
  rules: PermissionRule[];
  mode: ExecutionMode;
  updatedAt: string;
}

// ─── in-process async mutex ──────────────

const permissionsLocks = new Map<string, Promise<void>>();

async function withPermissionsLock<T>(
  filePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = resolve(filePath);
  const prev = permissionsLocks.get(key) ?? Promise.resolve();
  const next = prev.then(() => fn());

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
    if (isMissingPathError(err)) return null;
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
      writeUtf8FileAtomicSync(filePath, `${JSON.stringify(file, null, 2)}\n`, 0o600);
    });
  });
}
