/**
 * Risk shadow log — structured emission of host-derived vs plugin-declared
 * permission category for every tool invocation.
 *
 * The host-classifies-risk migration ships with the
 * `hostClassifiesRisk` feature flag OFF: enforcement still uses the DECLARED
 * category, but the host ALSO computes what it would classify the call as
 * ({@link inspectHostRisk}) and logs the pair here. Reconciling these logs
 * across the installed plugins is the gate that must pass before the flag is
 * flipped — migration can therefore only TIGHTEN, never silently change live
 * behaviour.
 *
 * This module performs NO enforcement. It is a pure side-effect sink (a single
 * structured log line) so the shadow path cannot alter a permission decision.
 */
import type { ToolCategory } from "../../tools/types.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger("risk-shadow");

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
}

/**
 * Emit one structured shadow record. The `diverged` field is the field the
 * reconciliation tooling filters on: a `true` means the host and the plugin
 * disagree about the call's risk, which must be understood before enforcement
 * is enabled for that plugin.
 */
export function emitRiskShadowLog(record: RiskShadowRecord): void {
  const diverged = record.declaredCategory !== record.hostDerivedCategory;
  log.info(
    {
      event: "risk-shadow",
      toolName: record.toolName,
      source: record.source,
      ...(record.pluginId ? { pluginId: record.pluginId } : {}),
      declaredCategory: record.declaredCategory,
      hostDerivedCategory: record.hostDerivedCategory,
      diverged,
      enforced: record.enforced,
    },
    "risk-shadow",
  );
}
