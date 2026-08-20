/**
 * SkillApprovalsStore — persistent allowlist for user-authored skills the
 * user has already approved at least once. Without this, every `skill_load`
 * call would reopen the approval dock even after the user said "yes" 30
 * seconds ago, which is a clear UX regression.
 *
 * File: `~/.lvis/skill-approvals.json`
 *
 * v2 schema (hash-binding):
 * {
 *   "version": 2,
 *   "approvedSkills": [
 *     { "name": "report-writing", "sha256": "abc…", "approvedAt": "2026-…" },
 *     { "name": "field-guide#bundled", "sha256": "def…", "approvedAt": "2026-…" }
 *   ]
 * }
 *
 * `name` is a RECORD KEY, not necessarily a skill name, and `sha256` is a hash of
 * approval MATERIAL, not necessarily a body. Both are chosen by the caller
 * (`tools/skill-load.ts`): a skill carrying bundled resources is keyed
 * `<key>#bundled` and its material covers the body AND the resource manifest, so
 * adding or resizing a bundled file re-prompts. This store deliberately does not
 * know that scheme — it stores opaque (key, hash) pairs, which is what lets the
 * caller change what an approval covers without a schema migration.
 *
 * Why hash-bind? Pre-fix, approval was keyed by NAME ONLY. A user approves
 * `report-writing` once, the body is later swapped (file overwrite, sync
 * tool, malicious overwrite, etc.), and the next `skill_load` short-circuits
 * without re-prompting — provenance changes silently. Post-fix, `isApproved`
 * matches BOTH the key AND the hash of the current material; any mismatch
 * forces re-approval.
 *
 * Migration: any v1 (or pre-v2-without-hash) record is treated as
 * un-approved on read. A re-approval cycle is required after upgrade — this
 * is acceptable in dev-stage and gives the user a chance to re-confirm any
 * previously-blessed skill bodies.
 *
 * Every skill — including seeded built-ins under `~/.lvis/skills/` — is
 * recorded here once approved. The load tool gates uniformly because the
 * on-disk body is user-editable post-seed; hash-binding closes the
 * post-approval mutation TOCTOU window (see `skill-load.ts`).
 */
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { lvisHome } from "../shared/lvis-home.js";
import { withInProcessFileQueue } from "../lib/with-file-lock.js";

export interface SkillApprovalRecord {
  /** Record key from the caller — a skill name, or `<name>#bundled`. */
  name: string;
  /** Hash of the approval material bound to that key. */
  sha256: string;
  approvedAt: string;
}

export interface SkillApprovalsFile {
  version: 2;
  approvedSkills: SkillApprovalRecord[];
}

const DEFAULT_PATH = resolve(lvisHome(), "skill-approvals.json");

/**
 * Hash the approval material so a record binds to exactly what the user said yes
 * to. NOT trimmed, and that is the strict direction on purpose: a whitespace-only
 * edit still re-prompts. (An earlier comment here claimed a trim that the code
 * never did — the claim is removed rather than the behavior changed, because
 * re-prompting on an unexpected byte change is the safe side of that trade.)
 *
 * Named for its original caller; it hashes whatever material the caller binds,
 * which for a bundled skill is a digest pair rather than a body.
 */
export function hashSkillMaterial(material: string): string {
  return createHash("sha256").update(material, "utf-8").digest("hex");
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
  private cache: Map<string, string> | null = null; // record key → material hash
  private readonly filePath: string;

  constructor(filePath: string = DEFAULT_PATH) {
    this.filePath = filePath;
  }

  async load(): Promise<void> {
    const file = await readFileOrEmpty(this.filePath);
    this.cache = new Map(file.approvedSkills.map((r) => [r.name, r.sha256]));
  }

  /**
   * Approved iff (record key, hash of current material) matches a stored pair.
   * Any change to the material invalidates the approval — this returns false and
   * the caller (skill-load) re-prompts via ApprovalGate.
   */
  async isApproved(recordKey: string, currentMaterial: string): Promise<boolean> {
    if (this.cache === null) await this.load();
    const recordedHash = this.cache!.get(recordKey);
    if (!recordedHash) return false;
    return recordedHash === hashSkillMaterial(currentMaterial);
  }

  /**
   * Record (or refresh) an approval. The hash of the current material is bound to
   * the record so the next `isApproved` call detects post-approval mutations.
   * The key must be the SAME one `isApproved` will use — the caller owns that
   * derivation, and a mismatch between the two would silently re-prompt forever.
   */
  async approve(recordKey: string, currentMaterial: string): Promise<void> {
    return withInProcessFileQueue(this.filePath, async () => {
      const file = await readFileOrEmpty(this.filePath);
      const newHash = hashSkillMaterial(currentMaterial);
      const existing = file.approvedSkills.find((r) => r.name === recordKey);
      if (existing) {
        existing.sha256 = newHash;
        existing.approvedAt = new Date().toISOString();
      } else {
        file.approvedSkills.push({
          name: recordKey,
          sha256: newHash,
          approvedAt: new Date().toISOString(),
        });
      }
      await writeAtomic(this.filePath, file);
      this.cache = new Map(file.approvedSkills.map((r) => [r.name, r.sha256]));
    });
  }
}
