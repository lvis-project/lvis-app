/**
 * S2 Sandbox Audit Sink — append pipeline for sandbox execution audit entries.
 *
 * Spec ref: docs/research/sandbox-isolation.md §3.6 (S2 audit fields)
 * Issue: #691 PR-A4
 *
 * This module provides the *sink* for `SandboxAuditEntry` records — the
 * emit pipeline deferred from PR-A1. Entries are appended in JSONL format
 * to `~/.lvis/audit/<YYYY-MM-DD>.sandbox.jsonl` (daily-rotated, same
 * directory as the permission-gate audit channel so the AuditPanel reader
 * can glob both channels from one directory).
 *
 * DLP note: callers MUST pass DLP-redacted args and nlJustification.
 * This sink does NOT apply DLP — it trusts the caller has already run
 * `maskSensitiveData()` on sensitive fields before calling `emitSandboxAudit`.
 * That responsibility is co-located with the PermissionManager.dispatchReviewer
 * call-site, which already has a DLP-redacted `finalInput` in scope.
 *
 * File permissions: 0o600 (user-read/write only).
 * Directory permissions: 0o700 (created if absent).
 */
import { appendFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { lvisHome } from "../shared/lvis-home.js";
import type { SandboxAuditEntry } from "./sandbox-audit.js";

// ─── Sink path ────────────────────────────────────────────────────────────────

/**
 * Path to the daily-rotated sandbox JSONL audit log.
 *
 * Returns `~/.lvis/audit/<YYYY-MM-DD>.sandbox.jsonl` — one file per calendar
 * day in the same `~/.lvis/audit/` directory used by the permission-gate audit
 * channel. The `.sandbox` infix distinguishes the two channels; the AuditPanel
 * reader globs `~/.lvis/audit/` and surfaces both without needing a discriminator
 * field scan on every entry.
 *
 * Accepts an optional `date` parameter so tests can inject a fixed date without
 * touching the real clock.
 *
 * Timezone — UTC (issue #801). `toISOString().slice(0, 10)` yields the UTC
 * calendar day, matching the daily rollover convention used by
 * `audit-logger.ts` (lines 147 / 292 / 433 — same `toISOString().slice(0, 10)`).
 * Both channels roll at UTC midnight so events emitted moments apart cannot
 * land in different daily files based on the operator's local timezone.
 * Forensic correlation across timezones relies on this invariant.
 */
function sinkPath(date = new Date()): string {
  const ymd = date.toISOString().slice(0, 10); // YYYY-MM-DD (UTC, see #801)
  return resolve(lvisHome(), "audit", `${ymd}.sandbox.jsonl`);
}

// ─── Emit ─────────────────────────────────────────────────────────────────────

/**
 * Append a single `SandboxAuditEntry` to the JSONL audit log.
 *
 * Each call appends exactly one line: `${JSON.stringify(entry)}\n`.
 * The file is created if it does not exist (mode 0o600).
 * The parent directory is created if absent (mode 0o700).
 *
 * Failures are NOT swallowed — the caller decides whether to log-and-continue
 * or surface the error. Production call-sites in `permission-manager.ts` wrap
 * this in a try/catch and log the error without blocking the tool execution.
 */
export async function emitSandboxAudit(entry: SandboxAuditEntry): Promise<void> {
  const path = sinkPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await appendFile(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

/**
 * Return the resolved audit log path (for tests and the AuditPanel IPC handler).
 */
export function sandboxAuditSinkPath(): string {
  return sinkPath();
}
