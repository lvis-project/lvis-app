/**
 * S2 sandbox audit entry schema + builder.
 *
 * Spec ref: docs/research/sandbox-isolation.md §3.6 (S2 audit fields)
 * Issue: #691 PR-A1 Foundation
 *
 * This module defines the JSON shape of a sandbox execution audit entry
 * and a builder function that callers use to construct one.
 *
 * The *sink* (audit.log append, HMAC chain linkage) is intentionally
 * omitted here — it lands in PR-A4 where the full user-approval-store
 * and emit pipeline are wired. This keeps PR-A1 focused on types and
 * skeletons only.
 *
 * Relationship to existing audit:
 *   `src/audit/audit-schema.ts` defines the permission-gate audit entries
 *   (AuditAllow, AuditDeny, …). This file defines a *separate* S2 channel
 *   for per-spawn sandbox telemetry — tool execution metadata plus
 *   reviewer composition signals that are not captured in the gate entries.
 *   Both channels are JSONL; the discriminator is the presence of
 *   `SandboxAuditEntry.sandbox` vs `PermissionAuditEntry.decision`.
 */

import type { SandboxKind, SandboxCapability } from "../permissions/sandbox-capability.js";

// ─── Event shapes ─────────────────────────────────────────────────────────────

/**
 * An observable event captured during a single sandboxed tool execution.
 * PR-A2/A3 runner implementations emit these as they intercept syscalls
 * (via bwrap seccomp / sandbox-exec / AppContainer filter logs).
 */
export type SandboxEvent =
  | {
      type: "egress_attempted";
      /** Whether the runner's policy blocked the connection attempt. */
      blocked: boolean;
      /** Destination IP or hostname. */
      target: string;
    }
  | {
      type: "fs_write_attempted";
      /** Whether the runner's policy blocked the write. */
      blocked: boolean;
      /** Absolute path the child attempted to write. */
      path: string;
    };

// ─── SandboxAuditEntry ───────────────────────────────────────────────────────

/**
 * Full S2 audit entry. One entry per sandboxed tool invocation.
 *
 * Fields:
 *   `timestamp`  ISO 8601 — wall-clock time the spawn was initiated.
 *   `tool`       Identifies the tool invocation (name, raw args string,
 *                trust origin source).
 *   `sandbox`    Execution context: kind/confidence from the SOT, events
 *                observed during execution, and spawn overhead metrics.
 *   `reviewer`   Reviewer composition signals: rule + LLM + final verdicts,
 *                which composition rules fired, and user-approval provenance
 *                if the action required interactive approval.
 */
export interface SandboxAuditEntry {
  timestamp: string;  // ISO 8601

  tool: {
    /** Tool name (underscore format, per CLAUDE.md Tool Naming Convention). */
    name: string;
    /** Raw args as a JSON string (pre-DLP-redaction — PR-A4 will apply DLP). */
    args: string;
    /** Trust origin of the tool call (mirrors ToolInvocationContext.trustOrigin). */
    source: string;
  };

  sandbox: {
    kind: SandboxKind;
    confidence: SandboxCapability["confidence"];
    /** Events observed by the runner during this invocation. */
    events: SandboxEvent[];
    /** Wall-clock ms from spawn() call to first byte of child stdout. */
    spawnLatencyMs: number;
    /**
     * Sandbox overhead as a percentage of total execution time:
     *   (spawnLatencyMs / totalExecutionMs) * 100
     * Rounded to 2 decimal places. Used for SLA tracking.
     */
    overheadPercent: number;
  };

  reviewer: {
    /** Verdict from the deterministic rule-based classifier. */
    ruleVerdict: "low" | "medium" | "high";
    /** Verdict from the LLM classifier (or "high" on parse failure). */
    llmVerdict: "low" | "medium" | "high";
    /** Final composed verdict: max(ruleVerdict, llmVerdict). */
    finalVerdict: "low" | "medium" | "high";
    /**
     * Composition rules that fired and influenced the final verdict.
     * Populated by the reviewer engine (PR-A4). Empty when no rule
     * overrode the base verdict.
     */
    compositionRulesTriggered: Array<{
      rule: string;
      reason: string;
    }>;
    /**
     * Present when the action required interactive user approval.
     * `null` when the action was auto-approved or auto-denied without
     * user interaction.
     */
    userApprovalUsed: {
      /** true if the approval was served from the memory/cache store. */
      memoryHit: boolean;
      /** NL justification provided by the user, or null if not given. */
      nlJustification: string | null;
      /** Reviewer verdict at the moment the user was prompted. */
      verdictAtApproval: "low" | "medium" | "high" | null;
    } | null;
  };
}

// ─── Builder ─────────────────────────────────────────────────────────────────

/**
 * Build a S2 audit entry, injecting the current ISO 8601 timestamp.
 *
 * The `timestamp` field is always set by this builder — callers MUST NOT
 * set it manually to ensure consistent UTC wall-clock recording.
 *
 * PR-A4 will wire the actual sink (audit.log append + HMAC chain linkage).
 * Until then, callers can use this builder for in-memory event capture
 * and test assertions.
 *
 * @example
 * ```ts
 * const entry = buildSandboxAuditEntry({
 *   tool: { name: "bash_run", args: '{"command":"ls"}', source: "user-keyboard" },
 *   sandbox: { kind: "none", confidence: "verified", events: [], spawnLatencyMs: 0, overheadPercent: 0 },
 *   reviewer: { ruleVerdict: "low", llmVerdict: "low", finalVerdict: "low",
 *               compositionRulesTriggered: [], userApprovalUsed: null },
 * });
 * ```
 */
export function buildSandboxAuditEntry(params: {
  tool: SandboxAuditEntry["tool"];
  sandbox: SandboxAuditEntry["sandbox"];
  reviewer: SandboxAuditEntry["reviewer"];
}): SandboxAuditEntry {
  return {
    timestamp: new Date().toISOString(),
    ...params,
  };
}
