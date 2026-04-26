/**
 * SkillApprovalsStore — persistent allowlist for user-authored skills the
 * user has already approved at least once. Without this, every `skill_load`
 * call would pop an approval modal even after the user said "yes" 30
 * seconds ago, which is a clear UX regression.
 *
 * File: `~/.lvis/skill-approvals.json`
 *
 * {
 *   "version": 1,
 *   "approvedSkills": ["report-writing", "interview-template"],
 *   "approvedAt": { "report-writing": "2026-04-27T..." }
 * }
 *
 * Built-in skills are NOT recorded here — they ship with the host so the
 * load tool short-circuits the approval gate for them entirely (see
 * `skill-load.ts`).
 */
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";

export interface SkillApprovalsFile {
  version: 1;
  approvedSkills: string[];
  approvedAt?: Record<string, string>;
}

const DEFAULT_PATH = resolve(homedir(), ".lvis", "skill-approvals.json");

const fileLocks = new Map<string, Promise<void>>();

async function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const key = resolve(filePath);
  const prev = fileLocks.get(key) ?? Promise.resolve();
  const next = prev.then(() => fn());
  fileLocks.set(key, next.then(() => undefined, () => undefined));
  return next;
}

async function readFileOrEmpty(filePath: string): Promise<SkillApprovalsFile> {
  try {
    const raw = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<SkillApprovalsFile>;
    return {
      version: 1,
      approvedSkills: Array.isArray(parsed.approvedSkills)
        ? (parsed.approvedSkills.filter((x) => typeof x === "string") as string[])
        : [],
      approvedAt: parsed.approvedAt && typeof parsed.approvedAt === "object"
        ? (parsed.approvedAt as Record<string, string>)
        : {},
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, approvedSkills: [], approvedAt: {} };
    }
    throw err;
  }
}

async function writeAtomic(filePath: string, data: SkillApprovalsFile): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
  await rename(tmp, filePath);
}

export class SkillApprovalsStore {
  private cache: Set<string> | null = null;
  private readonly filePath: string;

  constructor(filePath: string = DEFAULT_PATH) {
    this.filePath = filePath;
  }

  async load(): Promise<void> {
    const file = await readFileOrEmpty(this.filePath);
    this.cache = new Set(file.approvedSkills);
  }

  async isApproved(skillName: string): Promise<boolean> {
    if (this.cache === null) await this.load();
    return this.cache!.has(skillName);
  }

  async approve(skillName: string): Promise<void> {
    return withFileLock(this.filePath, async () => {
      const file = await readFileOrEmpty(this.filePath);
      if (!file.approvedSkills.includes(skillName)) {
        file.approvedSkills.push(skillName);
      }
      file.approvedAt = file.approvedAt ?? {};
      file.approvedAt[skillName] = new Date().toISOString();
      await writeAtomic(this.filePath, file);
      this.cache = new Set(file.approvedSkills);
    });
  }
}
