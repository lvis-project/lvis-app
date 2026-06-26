/**
 * Risk shadow log — shadow reconciliation dataset for the
 * host-classifies-risk migration.
 *
 * Two structured, NON-ENFORCING records, both written to the AuditLogger's
 * DEDICATED shadow channel (`~/.lvis/audit/<date>.permission-shadow.jsonl`, via
 * {@link AuditLogger.logShadow}) so the reconciliation dataset is queryable
 * without polluting the canonical telemetry channel or accelerating its
 * size-rotation. This is the PLAIN, non-HMAC channel — the records are NOT
 * tamper-evident / audit-grade; treat them as a shadow reconciliation log:
 *
 *  1. {@link emitRiskShadowLog} — the per-invocation CATEGORY shadow: the
 *     plugin-DECLARED category vs the category the host derives from its own
 *     signals ({@link inspectHostRisk}). Emitted pre-execution. The
 *     `hostClassifiesRisk` flag ships OFF: enforcement still uses the declared
 *     category; this pair is what must reconcile before the flag flips.
 *
 *  2. {@link emitEffectShadowLog} — the per-invocation EFFECT shadow: the
 *     host-OBSERVED read/write classification ({@link EffectSummary}) collected
 *     from non-forgeable host-mediated effects during the call. Emitted
 *     post-execution. This is the dataset the later read-recognition gate consumes.
 *
 * Both records carry the SAME `correlationId` for one invocation so the category
 * shadow and the effect shadow join on a single key.
 *
 * Both functions perform NO enforcement — they are pure side-effect sinks (a
 * single shadow line) so the shadow path cannot alter a permission decision. The
 * AuditLogger is passed in so this module owns no global state and stays unit
 * testable against a temp LVIS_HOME.
 */
import type { ToolCategory } from "../../tools/types.js";
import type { AuditLogger } from "../../audit/audit-logger.js";
import type { EffectSummary } from "../effect-ledger.js";

export interface RiskShadowRecord {
  toolName: string;
  source: "builtin" | "plugin" | "mcp";
  pluginId?: string;
  /** Category the host would enforce today (declared category). */
  declaredCategory: ToolCategory;
  /** Category the host derived from its own signals ({@link inspectHostRisk}). */
  hostDerivedCategory: ToolCategory;
  /** Whether `hostClassifiesRisk` enforcement was active for this call. */
  enforced: boolean;
  /**
   * Per-invocation join key (the EffectLedger's correlationId). Threaded
   * identically into the matching {@link emitEffectShadowLog} record so the
   * pre-exec category shadow and the post-exec effect shadow for ONE invocation
   * join on this id.
   */
  correlationId: string;
}

export interface EffectShadowRecord {
  toolName: string;
  source: "builtin" | "plugin" | "mcp";
  pluginId?: string;
  /** Category the plugin declared for this tool (pre-removal artifact). */
  declaredCategory: ToolCategory;
  /**
   * Whether this tool's effects are HOST-OBSERVABLE — `true` for in-process
   * plugin tools whose hostApi closures are instrumented, `false` for tools the
   * host does not mediate (external `source:"mcp"`, which never reaches the
   * instrumented chokepoints). When `false`, an EMPTY effect summary is NOT a
   * confirmed read — a later read-recognition gate MUST fail closed on
   * `hostObservable:false` and never auto-relax to read.
   */
  hostObservable: boolean;
  /** Host-observed effects collected for this invocation (the EffectLedger summary). */
  hostObservedEffect: EffectSummary;
}

/**
 * Emit one structured CATEGORY shadow record to the dedicated shadow channel. The
 * `diverged` field is what reconciliation tooling filters on: `true` means the
 * host and the plugin disagree about the call's risk, which must be understood
 * before enforcement is enabled for that plugin.
 */
export function emitRiskShadowLog(
  record: RiskShadowRecord,
  auditLogger: AuditLogger,
): void {
  const diverged = record.declaredCategory !== record.hostDerivedCategory;
  const fields = {
    event: "risk-shadow",
    toolName: record.toolName,
    source: record.source,
    ...(record.pluginId ? { pluginId: record.pluginId } : {}),
    declaredCategory: record.declaredCategory,
    hostDerivedCategory: record.hostDerivedCategory,
    diverged,
    enforced: record.enforced,
    correlationId: record.correlationId,
  };
  try {
    auditLogger.logShadow({
      timestamp: new Date().toISOString(),
      sessionId: "permission-shadow",
      type: "info",
      input: `risk-shadow ${record.toolName} source=${record.source} diverged=${diverged}`,
      output: JSON.stringify(fields),
    });
  } catch {
    // Shadow logging must never break a tool invocation.
  }
}

/**
 * Emit one structured EFFECT shadow record to the dedicated shadow channel: the
 * plugin-declared category against the host-OBSERVED effect summary. The
 * `hasMutatingEffect` boolean is the host-owned read/write classification for
 * this invocation — the signal a later read-recognition gate will reconcile
 * against the declared category before effect-boundary gating is enabled.
 */
export function emitEffectShadowLog(
  record: EffectShadowRecord,
  auditLogger: AuditLogger,
): void {
  const { correlationId, hasMutatingEffect, effects } = record.hostObservedEffect;
  const fields = {
    event: "effect-shadow",
    toolName: record.toolName,
    source: record.source,
    ...(record.pluginId ? { pluginId: record.pluginId } : {}),
    declaredCategory: record.declaredCategory,
    hostObservable: record.hostObservable,
    hasMutatingEffect,
    effects,
    correlationId,
  };
  try {
    auditLogger.logShadow({
      timestamp: new Date().toISOString(),
      sessionId: "permission-shadow",
      type: "info",
      input: `effect-shadow ${record.toolName} source=${record.source} hostObservable=${record.hostObservable} hasMutatingEffect=${hasMutatingEffect}`,
      output: JSON.stringify(fields),
    });
  } catch {
    // Shadow logging must never break a tool invocation.
  }
}
