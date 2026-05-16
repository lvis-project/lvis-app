/**
 * R-2 User-Approval Memory Layer — persistent + session-scoped approval store.
 *
 * Spec ref: docs/research/sandbox-isolation.md §R-2
 * Issue: #691 PR-A4
 *
 * Stores per-tool approval decisions made by the user in the ToolApprovalDialog
 * so that subsequent calls with the same (toolName, args, source) triple can
 * skip the LLM classifier and go straight to the rule-based verdict.
 *
 * File: ~/.lvis/permissions/user-approvals.json
 * Permissions: directory 0o700, file 0o600 (per CLAUDE.md storage namespace rule)
 *
 * Scope semantics:
 *   "session"    — approval held in this process only; revoked on restart.
 *   "persistent" — approval written to disk; survives restarts.
 *
 * HIGH-verdict approvals MUST include a non-null nlJustification (enforced
 * by the ToolApprovalDialog). HIGH approvals cannot use scope "persistent"
 * (the dialog disables that option) — users must re-justify each session.
 *
 * Atomicity: writes use a random-suffix .tmp file + rename() so a crash
 * during write does not corrupt the store (same pattern as SkillApprovalsStore).
 */
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { lvisHome } from "../shared/lvis-home.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface UserApprovalEntry {
  /** ISO 8601 wall-clock time the approval was granted. */
  approvedAt: string;
  /** "session" approvals are held in-memory only; "persistent" are written to disk. */
  scope: "session" | "persistent";
  /** The reviewer verdict that was shown to the user when they approved. */
  verdictAtApproval: "low" | "medium" | "high";
  /**
   * Natural-language justification entered by the user.
   * Required (non-null) for HIGH-verdict approvals.
   * null for LOW/MEDIUM approvals where the dialog does not prompt for it.
   */
  nlJustification: string | null;
  /**
   * ISO 8601 timestamp when this approval was revoked, or null if active.
   * Revoked entries are retained for audit purposes but treated as absent
   * by {@link lookupApproval}.
   */
  revokedAt: string | null;
  /**
   * Display metadata — stored alongside the entry so listApprovals() can
   * return human-readable tool identity without re-parsing the hash key.
   * R-2 Round-3: required for PermissionsTab table to show toolName.
   */
  toolName?: string;
  source?: string;
}

interface ApprovalsFile {
  /** Map from entry key → approval entry. */
  approvals: Record<string, UserApprovalEntry>;
}

// ─── In-memory session store ───────────────────────────────────────────────────

/**
 * Session-scoped approvals held in-process only. Not written to disk.
 * Cleared on process exit.
 */
const sessionStore = new Map<string, UserApprovalEntry>();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function filePath(): string {
  return resolve(lvisHome(), "permissions", "user-approvals.json");
}

/**
 * Stable cache key for a (toolName, args, source, trustOrigin?, approvalCacheKey?) tuple.
 *
 * `trustOrigin` and `approvalCacheKey` are included when present so that two
 * invocations of the same tool from different trust origins (e.g. "user-keyboard"
 * vs "plugin-abc") or with different semantic keys cannot collapse onto the same
 * cached approval. This prevents a low-trust caller from inheriting a high-trust
 * approval made by a different origin (CRITICAL-4 cache identity collapse fix).
 *
 * args is canonicalized via `canonicalStringify` (from shared/canonical-json.ts)
 * before hashing so that object key ordering differences ({a,b} vs {b,a}) do
 * not produce distinct keys for semantically identical inputs (HIGH-2 JSON
 * canonical fix). Re-exported for backward-compat with existing importers.
 */
export { canonicalStringify } from "../shared/canonical-json.js";

function entryKey(
  toolName: string,
  args: string,
  source: string,
  trustOrigin?: string,
  approvalCacheKey?: string,
): string {
  const components = [toolName, args, source];
  if (trustOrigin) components.push(trustOrigin);
  if (approvalCacheKey) components.push(approvalCacheKey);
  return createHash("sha256").update(components.join("\0")).digest("hex");
}

async function readApprovalsFile(): Promise<ApprovalsFile> {
  try {
    const raw = await readFile(filePath(), "utf8");
    const parsed = JSON.parse(raw) as ApprovalsFile;
    // Tolerate missing approvals key in malformed file.
    if (!parsed || typeof parsed.approvals !== "object") {
      return { approvals: {} };
    }
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { approvals: {} };
    throw err;
  }
}

async function atomicWrite(data: ApprovalsFile): Promise<void> {
  const path = filePath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Record a user approval decision.
 *
 * For "session" scope, stores only in memory (no disk write).
 * For "persistent" scope, appends to ~/.lvis/permissions/user-approvals.json.
 *
 * Callers (ToolApprovalDialog via IPC) MUST:
 *   - Pass nlJustification !== null when verdictAtApproval === "high".
 *   - Use scope "session" (not "persistent") for high-verdict approvals.
 */
export async function recordApproval(
  toolName: string,
  args: string,
  source: string,
  entry: {
    scope: "session" | "persistent";
    verdictAtApproval: "low" | "medium" | "high";
    nlJustification: string | null;
    approvedAt?: string;
    trustOrigin?: string;
    approvalCacheKey?: string;
  },
): Promise<void> {
  const key = entryKey(toolName, args, source, entry.trustOrigin, entry.approvalCacheKey);
  const full: UserApprovalEntry = {
    approvedAt: entry.approvedAt ?? new Date().toISOString(),
    scope: entry.scope,
    verdictAtApproval: entry.verdictAtApproval,
    nlJustification: entry.nlJustification,
    revokedAt: null,
    // Store display metadata so listApprovals() can surface toolName/source
    // without re-parsing the hash key. R-2 Round-3 MEDIUM fix.
    toolName,
    source,
  };

  if (entry.scope === "session") {
    sessionStore.set(key, full);
    return;
  }

  // persistent — write to disk
  const file = await readApprovalsFile();
  file.approvals[key] = full;
  await atomicWrite(file);
  // Mirror into session cache for fast lookups.
  sessionStore.set(key, full);
}

/**
 * Look up an active (non-revoked) approval for the given triple.
 *
 * Fast path: checks the in-memory session store first.
 * For persistent-scoped entries that survived a restart, falls through
 * to the disk file.
 *
 * Returns null when no approval is found or the approval is revoked.
 */
export async function lookupApproval(
  toolName: string,
  args: string,
  source: string,
  trustOrigin?: string,
  approvalCacheKey?: string,
): Promise<UserApprovalEntry | null> {
  const key = entryKey(toolName, args, source, trustOrigin, approvalCacheKey);

  // Fast: in-memory session cache.
  const cached = sessionStore.get(key);
  if (cached) {
    if (cached.revokedAt) return null;
    return cached;
  }

  // Slow: persistent disk store (e.g. after a restart).
  const file = await readApprovalsFile();
  const entry = file.approvals[key];
  if (!entry) return null;
  if (entry.revokedAt) return null;

  // Warm the session cache.
  sessionStore.set(key, entry);
  return entry;
}

/**
 * Revoke an active approval by key triple.
 *
 * Records `revokedAt` on the persistent entry (if present) and evicts
 * from the session cache. Idempotent: no-op if not found.
 */
export async function revokeApproval(
  toolName: string,
  args: string,
  source: string,
  trustOrigin?: string,
  approvalCacheKey?: string,
): Promise<void> {
  const key = entryKey(toolName, args, source, trustOrigin, approvalCacheKey);

  // Evict from session store.
  sessionStore.delete(key);

  // Mark revoked on disk (if persistent entry exists).
  const file = await readApprovalsFile();
  const existing = file.approvals[key];
  if (!existing) return;
  existing.revokedAt = new Date().toISOString();
  await atomicWrite(file);
}

/**
 * Revoke an approval by its raw composite key (as returned by {@link listApprovals}).
 *
 * Used by the PermissionsTab UI which receives pre-computed keys from the IPC list response.
 */
export async function revokeApprovalByKey(rawKey: string): Promise<void> {
  // Evict from session store.
  sessionStore.delete(rawKey);

  const file = await readApprovalsFile();
  const existing = file.approvals[rawKey];
  if (!existing) return;
  existing.revokedAt = new Date().toISOString();
  await atomicWrite(file);
}

/**
 * List all approval entries (including revoked) from the persistent store,
 * augmented with the in-memory session-only entries.
 *
 * Returned entries include the composite key so the UI can pass it back
 * for targeted revocation.
 */
export async function listApprovals(): Promise<Array<{ key: string } & UserApprovalEntry>> {
  const file = await readApprovalsFile();

  const result: Array<{ key: string } & UserApprovalEntry> = Object.entries(
    file.approvals,
  ).map(([key, entry]) => ({ key, ...entry }));

  // Include session-only entries not persisted to disk.
  for (const [key, entry] of sessionStore.entries()) {
    if (entry.scope === "session" && !file.approvals[key]) {
      result.push({ key, ...entry });
    }
  }

  return result;
}

/**
 * Read all persistent approvals (raw file contents). Exported for audit access.
 */
export async function readApprovals(): Promise<ApprovalsFile> {
  return readApprovalsFile();
}

// ─── Test helpers ─────────────────────────────────────────────────────────────

/** @internal Test only — clears the session cache between test cases. */
export function __resetSessionStoreForTest(): void {
  sessionStore.clear();
}
