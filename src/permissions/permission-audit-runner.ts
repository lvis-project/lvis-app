/**
 * Q12 Phase 5 — `/permission audit` runtime helpers.
 *
 * Spec ref: docs/architecture/q12-permission-policy-design.md §3 Layer 7,
 * §3 Layer 8 (slash subcommand `/permission audit show|verify`).
 *
 * Two operations:
 *
 *   show   — surface the last N entries from the Q12 audit log so
 *            the renderer's `AuditPanel` can render them. Read-only,
 *            no chain verification.
 *   verify — recompute the chain across one or more day-files, report
 *            the first broken line on failure.
 *
 * The functions take the audit dir + secret as parameters (not from
 * a singleton) so unit tests can run in a tmpdir without IPC
 * scaffolding.
 */
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import {
  computeDailySeal,
  sealKeyName,
  verifyChain,
  type SecretStore,
} from "../audit/hmac-chain.js";
import {
  isQ12AuditEntry,
  type Q12AuditEntry,
} from "../audit/audit-schema.js";

const TAIL_CHUNK_BYTES = 64 * 1024;

function readLastNonEmptyLines(filePath: string, limit: number): string[] {
  if (limit <= 0) return [];
  const { size } = statSync(filePath);
  if (size === 0) return [];

  const fd = openSync(filePath, "r");
  const chunks: Buffer[] = [];
  let remaining = size;
  let newlineCount = 0;

  try {
    while (remaining > 0 && newlineCount <= limit) {
      const bytesToRead = Math.min(TAIL_CHUNK_BYTES, remaining);
      remaining -= bytesToRead;
      const buffer = Buffer.allocUnsafe(bytesToRead);
      const bytesRead = readSync(fd, buffer, 0, bytesToRead, remaining);
      const chunk = bytesRead === bytesToRead ? buffer : buffer.subarray(0, bytesRead);
      chunks.push(chunk);
      for (const byte of chunk) {
        if (byte === 0x0a) newlineCount += 1;
      }
    }
  } finally {
    closeSync(fd);
  }

  return Buffer.concat(chunks.reverse())
    .toString("utf-8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .slice(-limit);
}

/**
 * Return the most recent N audit entries across all `.q12.jsonl`
 * files in the audit directory. Files are processed in date-sorted
 * order; the tail of the newest file appears first in the result.
 */
export function readRecentAuditEntries(
  auditDir: string,
  limit: number,
): Q12AuditEntry[] {
  if (!existsSync(auditDir)) return [];
  const files = readdirSync(auditDir)
    .filter((f) => f.endsWith(".q12.jsonl"))
    .sort()
    .reverse(); // newest first

  const out: Q12AuditEntry[] = [];
  for (const file of files) {
    const filePath = join(auditDir, file);
    const lines = readLastNonEmptyLines(filePath, limit - out.length);
    // Walk in reverse so the newest entry of the file lands first.
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(lines[i]) as unknown;
        if (isQ12AuditEntry(parsed)) {
          out.push(parsed);
          if (out.length >= limit) return out;
        }
      } catch {
        // Skip unparseable lines — the chain verifier will surface them.
      }
    }
  }
  return out;
}

/**
 * Per-file chain verification result. Verification iterates through
 * every `.q12.jsonl` file in the audit directory; each file gets
 * its own genesis-anchored chain because rotations create fresh
 * files.
 */
export interface DayVerifyResult {
  file: string;
  totalLines: number;
  result:
    | { ok: true }
    | { ok: false; firstBrokenLineIndex: number; reason: string };
  /**
   * Daily seal verification — present only when a seal exists for
   * the file's date. `null` when no seal is stored (legacy boot or
   * day not yet sealed).
   */
  sealMatch: boolean | null;
}

export interface VerifyAllAuditResult {
  totalFiles: number;
  totalEntries: number;
  intact: boolean;
  perDay: DayVerifyResult[];
  /** First broken file (for prompt error messaging). */
  firstBrokenFile?: string;
}

/**
 * Verify every `.q12.jsonl` file in the audit directory. Returns a
 * structured report for the renderer's "verify" tile.
 */
export function verifyAllAuditFiles(
  auditDir: string,
  secret: string,
  sealStore?: SecretStore,
): VerifyAllAuditResult {
  if (!existsSync(auditDir)) {
    return { totalFiles: 0, totalEntries: 0, intact: true, perDay: [] };
  }
  const files = readdirSync(auditDir)
    .filter((f) => f.endsWith(".q12.jsonl"))
    .sort();

  const perDay: DayVerifyResult[] = [];
  let totalEntries = 0;
  let firstBrokenFile: string | undefined;

  for (const file of files) {
    const filePath = join(auditDir, file);
    const raw = readFileSync(filePath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    const result = verifyChain(secret, lines);
    let sealMatch: boolean | null = null;
    const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})\.q12\.jsonl$/);
    if (sealStore && dateMatch && lines.length > 0) {
      const stored = sealStore.read(sealKeyName(dateMatch[1]));
      if (stored) {
        const computed = computeDailySeal(secret, lines[lines.length - 1]);
        sealMatch = stored === computed;
      }
    }
    perDay.push({ file, totalLines: lines.length, result, sealMatch });
    totalEntries += lines.length;
    if (!result.ok && firstBrokenFile === undefined) {
      firstBrokenFile = file;
    }
  }

  const intact =
    perDay.every((d) => d.result.ok) &&
    perDay.every((d) => d.sealMatch !== false);

  return {
    totalFiles: files.length,
    totalEntries,
    intact,
    perDay,
    firstBrokenFile,
  };
}

/**
 * Path-builder used by the IPC handler so tests can drop in a
 * controlled audit dir.
 */
export function getDefaultAuditDir(home: string): string {
  return join(home, ".lvis", "audit");
}

/**
 * Return total bytes occupied by `.q12.jsonl` files — used by the
 * renderer's panel header ("12 files / 1.2 MB").
 */
export function summarizeAuditDir(auditDir: string): { files: number; bytes: number } {
  if (!existsSync(auditDir)) return { files: 0, bytes: 0 };
  const files = readdirSync(auditDir).filter((f) => f.endsWith(".q12.jsonl"));
  let bytes = 0;
  for (const f of files) {
    try {
      bytes += statSync(join(auditDir, f)).size;
    } catch {
      // missing/raced
    }
  }
  return { files: files.length, bytes };
}
