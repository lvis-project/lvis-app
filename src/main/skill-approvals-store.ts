/**
 * SkillApprovalsStore — persistent allowlist for user-authored skills the
 * user has already approved at least once. Without this, every `skill_load`
 * call would pop an approval modal even after the user said "yes" 30
 * seconds ago, which is a clear UX regression.
 *
 * File: `~/.lvis/skill-approvals.json`
 *
 * v2 schema (R2-CR-3 hash-binding):
 * {
 *   "version": 2,
 *   "approvedSkills": [
 *     { "name": "report-writing", "sha256": "abc…", "approvedAt": "2026-…" }
 *   ]
 * }
 *
 * Why hash-bind? Pre-fix, approval was keyed by NAME ONLY. A user approves
 * `report-writing` once, the body is later swapped (file overwrite, sync
 * tool, malicious overwrite, etc.), and the next `skill_load` short-circuits
 * without re-prompting — body-content provenance changes silently. Post-fix,
 * `isApproved(name, body)` matches BOTH the name AND the sha256 of the
 * current body; hash mismatch forces re-approval.
 *
 * Migration: any v1 (or pre-v2-without-hash) record is treated as
 * un-approved on read. A re-approval cycle is required after upgrade — this
 * is acceptable in dev-stage and gives the user a chance to re-confirm any
 * previously-blessed skill bodies.
 *
 * Built-in skills are NOT recorded here — they ship with the host so the
 * load tool short-circuits the approval gate for them entirely (see
 * `skill-load.ts`).
 */
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

export interface SkillApprovalRecord {
  name: string;
  sha256: string;
  approvedAt: string;
}

export interface SkillApprovalsFile {
  version: 2;
  approvedSkills: SkillApprovalRecord[];
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

/** R2-CR-3: hash skill bodies so approval records bind to the exact content
 *  the user said yes to. Trim is intentional — leading/trailing whitespace
 *  changes from a save/sync round-trip should not invalidate approval. */
export function hashSkillBody(body: string): string {
  return createHash("sha256").update(body, "utf-8").digest("hex");
}

async function readFileOrEmpty(filePath: string): Promise<SkillApprovalsFile> {
  try {
    const raw = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<SkillApprovalsFile> & {
      version?: number;
      approvedSkills?: unknown;
    };
    // R2-CR-3: only v2 records with a hash are honored. Older formats
    // (v1 string array, or v2 without sha256) are silently dropped to force
    // re-approval. Dev-stage acceptable; do NOT silently upgrade.
    if (parsed.version !== 2 || !Array.isArray(parsed.approvedSkills)) {
      return { version: 2, approvedSkills: [] };
    }
    const records: SkillApprovalRecord[] = [];
    for (const r of parsed.approvedSkills) {
      if (
        r &&
        typeof r === "object" &&
        typeof (r as SkillApprovalRecord).name === "string" &&
        typeof (r as SkillApprovalRecord).sha256 === "string" &&
        typeof (r as SkillApprovalRecord).approvedAt === "string"
      ) {
        records.push(r as SkillApprovalRecord);
      }
    }
    return { version: 2, approvedSkills: records };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 2, approvedSkills: [] };
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
  private cache: Map<string, string> | null = null; // name → sha256
  private readonly filePath: string;

  constructor(filePath: string = DEFAULT_PATH) {
    this.filePath = filePath;
  }

  async load(): Promise<void> {
    const file = await readFileOrEmpty(this.filePath);
    this.cache = new Map(file.approvedSkills.map((r) => [r.name, r.sha256]));
  }

  /**
   * R2-CR-3: a skill is approved iff (name, sha256(body)) matches a record.
   * Body swaps invalidate the approval — `isApproved` returns false and the
   * caller (skill-load) re-prompts via ApprovalGate.
   */
  async isApproved(skillName: string, currentBody: string): Promise<boolean> {
    if (this.cache === null) await this.load();
    const recordedHash = this.cache!.get(skillName);
    if (!recordedHash) return false;
    return recordedHash === hashSkillBody(currentBody);
  }

  /**
   * Record (or refresh) an approval. The hash of the current body is bound
   * to the record so the next `isApproved` call can detect post-approval
   * mutations.
   */
  async approve(skillName: string, currentBody: string): Promise<void> {
    return withFileLock(this.filePath, async () => {
      const file = await readFileOrEmpty(this.filePath);
      const newHash = hashSkillBody(currentBody);
      const existing = file.approvedSkills.find((r) => r.name === skillName);
      if (existing) {
        existing.sha256 = newHash;
        existing.approvedAt = new Date().toISOString();
      } else {
        file.approvedSkills.push({
          name: skillName,
          sha256: newHash,
          approvedAt: new Date().toISOString(),
        });
      }
      await writeAtomic(this.filePath, file);
      this.cache = new Map(file.approvedSkills.map((r) => [r.name, r.sha256]));
    });
  }
}
