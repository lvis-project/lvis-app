/**
 * Tool pipeline — host-classifies-risk enforced-category resolution + shadow log.
 *
 * Extracted from `executor.ts` (C7 decomposition). Pure aside from the audit
 * shadow-log sink it is handed. The executor owns the `hostClassifiesRisk`
 * provider + the shared AuditLogger and passes their resolved values in.
 */
import type { Tool } from "../base.js";
import type { ToolCategory } from "../types.js";
import type { AuditLogger } from "../../audit/audit-logger.js";
import { inspectHostRisk } from "../../permissions/reviewer/host-risk-inspector.js";
import { emitRiskShadowLog } from "../../permissions/reviewer/risk-shadow-log.js";
import { maxOperationRisk, type GovernedRiskFloor } from "../plugin-operation-governance.js";

/**
 * Permission policy host-classifies-risk — resolve the EFFECTIVE category the
 * policy pipeline will enforce for this invocation, and emit the shadow log.
 *
 * Shadow mode (always on): compute the host-derived category from host-owned
 * signals ({@link inspectHostRisk}) and log it against the declared category
 * so divergence can be reconciled across plugins before enforcement flips.
 *
 * Enforcement: when `hostClassifiesRisk` is `false` (the unset/disabled
 * fallback — the SHIPPED default is `true`, see settings-store.ts), the DECLARED
 * category is returned unchanged — behaviour is identical to before this helper
 * existed. When it is `true`, the host-derived category is returned
 * (default-strict: never below the declared level is NOT asserted here — the
 * inspector itself never classifies down to read without positive evidence).
 */
export function resolveEnforcedCategory(args: {
  tool: Tool;
  declaredCategory: ToolCategory;
  finalInput: Record<string, unknown>;
  allowedDirectories: readonly string[];
  correlationId: string;
  hostClassifiesRisk: boolean;
  auditLogger: AuditLogger;
  operationFloor?: GovernedRiskFloor;
}): ToolCategory {
  const {
    tool,
    declaredCategory,
    finalInput,
    allowedDirectories,
    correlationId,
    hostClassifiesRisk,
    auditLogger,
    operationFloor,
  } = args;
  // Only plugin/MCP tools carry an UNTRUSTED declared category worth
  // re-deriving. `meta` control-flow primitives (which route through
  // `decisionOverride`, not the category matrix) and builtins (trusted, known
  // categories the inspector cannot re-derive — it would default-strict a
  // read-only builtin to write) are self-consistent: their host-derived
  // category IS the declared one. Skipping inspection for them means they
  // never diverge, so they produce no shadow-log noise on every invocation.
  const eligibleForHostDerivation =
    (tool.source === "plugin" || tool.source === "mcp") &&
    declaredCategory !== "meta";

  const hostDerivedCategory = eligibleForHostDerivation
    ? inspectHostRisk({
        source: tool.source,
        finalInput,
        pathFields: tool.pathFields ?? [],
        allowedDirectories,
      })
    : declaredCategory;

  const enforced = hostClassifiesRisk;
  emitRiskShadowLog(
    {
      toolName: tool.name,
      source: tool.source,
      ...(tool.pluginId ? { pluginId: tool.pluginId } : {}),
      declaredCategory,
      hostDerivedCategory,
      enforced,
      // Same id as the post-exec effect shadow for THIS invocation → the
      // category shadow and the effect shadow join on this key.
      correlationId,
    },
    auditLogger,
  );

  const baseline = enforced && eligibleForHostDerivation
    ? hostDerivedCategory
    : declaredCategory;
  return operationFloor === undefined
    ? baseline
    : maxOperationRisk(declaredCategory, hostDerivedCategory, operationFloor);
}
