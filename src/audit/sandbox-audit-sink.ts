/**
 * S2 Sandbox Audit Sink — append pipeline for sandbox execution audit entries.
 *
 * Spec ref: docs/research/sandbox-isolation.md §3.6 (S2 audit fields)
 * Issue: #691 PR-A4
 *
 * This module provides the *sink* for `SandboxAuditEntry` records — the
 * emit pipeline deferred from PR-A1. Entries are appended in JSONL format
 * to `~/.lvis/audit.log` (the same file used by the permission-gate audit
 * channel). The discriminator between channels is the presence of the
 * `sandbox` field on S2 entries vs `decision` on permission-gate entries.
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
 * Path to the combined JSONL audit log.
 * Cross-cutting resource — lives at `~/.lvis/audit.log` per CLAUDE.md
 * storage namespace convention (cross-cutting resources at root, not in
 * a sub-directory).
 */
function sinkPath(): string {
  return resolve(lvisHome(), "audit.log");
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
