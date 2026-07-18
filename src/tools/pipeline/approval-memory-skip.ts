/**
 * Tool pipeline — Store-B explicit-approval memory skip (foreground modal path).
 *
 * Extracted from `executor.ts` (C7 decomposition). Pure aside from the
 * user-approval store lookup + sandbox-audit sink it drives. Behaviour is locked
 * by `executor-approval-memory-skip*.test.ts`.
 *
 * Background — two approval stores, asymmetric reads (root cause of the
 * "I chose 'allow this session' but the modal keeps reappearing" bug):
 *   • Store A — durable glob allow/deny rules + the `alwaysAllowed` Map,
 *     managed by PermissionsTab and consulted by the SYNC
 *     {@link PermissionManager.checkDetailed} (Layers 3 glob / 5 exact).
 *     Only the dialog's `allow-always` choice writes here
 *     (addAlwaysAllowedPersist).
 *   • Store B — exact-tuple user-approval memory written by
 *     ToolApprovalDialog for DURABLE choices only (allow-session /
 *     allow-always — allow-once never records, so "this time" cannot
 *     widen into a remembered grant) via the
 *     `userApprovalRecord` IPC. Keyed on the canonical
 *     (toolName, args, source, trustOrigin?, approvalCacheKey?) tuple.
 *
 * Pre-fix, the foreground ask path never read Store B — only the reviewer
 * lane ({@link PermissionManager.dispatchReviewer}) did. So a "session"
 * approval was recorded but never honored on re-entry through the modal
 * path. This function mirrors the reviewer lane's lookup so a prior,
 * non-revoked session/persistent approval skips the modal.
 *
 * The lookup args MUST match what ToolApprovalDialog stored:
 * `canonicalStringify(finalInput)` (the dialog records
 * `canonicalStringify(request.args)` where `request.args === finalInput`).
 * The IPC handler re-canonicalizes the same way, so identity is stable.
 *
 * Verdict escalation guard: re-run the rule classifier and take
 * `maxVerdict(ruleVerdict, storedVerdict)`. If the fresh rule verdict now
 * EXCEEDS the stored verdict (args mutated into something more dangerous),
 * re-prompt instead of auto-allowing — same principle as the reviewer
 * lane's max() composition. A legacy entry with `verdictAtApproval == null`
 * (provenance lost) is rejected → re-prompt (mirrors the dispatchReviewer
 * fail-closed gate).
 *
 * @returns an `allow` {@link PermissionCheckResult} when the modal should be
 *   skipped, or `null` to fall through to the modal.
 */
import type { ToolSource, ToolCategory } from "../types.js";
import type { PermissionCheckResult } from "../../permissions/permission-manager.js";
import type { ToolInvocationContext } from "../../permissions/reviewer/risk-classifier.js";
import { RuleBasedRiskClassifier, maxVerdict } from "../../permissions/reviewer/risk-classifier.js";
import { resolveReviewerSandboxCapability } from "../../permissions/sandbox-capability.js";
import type { HostShellExecutionPlan } from "../../permissions/host-shell-execution-plan.js";
import { lookupApproval, canonicalStringify } from "../../permissions/user-approval-store.js";
import type { UserApprovalVerdict } from "../../shared/permissions-events.js";
import { buildSandboxAuditEntry } from "../../audit/sandbox-audit.js";
import { emitSandboxAudit } from "../../audit/sandbox-audit-sink.js";
import { maskSensitiveData } from "../../audit/dlp-filter.js";
import type { ToolPermissionContext } from "../executor.js";

export async function tryUserApprovalMemorySkip(
  toolName: string,
  source: ToolSource,
  category: ToolCategory,
  pathFields: readonly string[],
  finalInput: Record<string, unknown>,
  allowedDirectories: string[],
  sensitivePathsAdjacent: string[],
  context: ToolPermissionContext,
  approvalCacheKey: string | undefined,
  sandboxAttestation: { ownerPluginSandboxRoot?: string },
  mcpServerId?: string,
  workerId?: string,
  pluginId?: string,
  hostShellExecutionPlan?: HostShellExecutionPlan,
): Promise<PermissionCheckResult | null> {
  // Identity = exactly what ToolApprovalDialog stored (canonical finalInput).
  const canonicalArgs = canonicalStringify(finalInput);
  const approval = await lookupApproval(
    toolName,
    canonicalArgs,
    source,
    context.trustOrigin,
    approvalCacheKey,
  ).catch(() => null); // storage failure must never block tool execution

  // No active (non-revoked) approval → fall through to the modal.
  if (!approval) return null;

  // Legacy-null guard: an entry without a recorded verdict has lost its
  // provenance. Treat as a miss and re-prompt (fail-closed) — mirrors the
  // dispatchReviewer gate. A null can never be silently coerced to a level.
  if (approval.verdictAtApproval == null) {
    console.warn(
      `[permission] foreground memory skip — legacy entry without verdictAtApproval, forcing fresh approval (tool=${toolName}, scope=${approval.scope})`,
      { event: "legacy-null-verdict", toolName, scope: approval.scope },
    );
    return null;
  }

  // Verdict escalation guard. Re-run the deterministic rule classifier on
  // the CURRENT args; if it now ranks higher than the stored verdict, the
  // invocation became more dangerous since approval — re-prompt.
  // Substrate-aware (NOT process-global): a plugin/MCP or in-process builtin
  // call resolves to a "none" capability so the audit + any sandbox-sensitive
  // rule reflect that this call's effects are NOT ASRT-isolated — except a
  // genuinely ASRT-wrapped external MCP worker (keyed on id)
  // or host-spawned plugin worker (keyed on pluginId + workerId).
  const sandboxCapability = hostShellExecutionPlan?.capability ??
    resolveReviewerSandboxCapability(
      source,
      toolName,
      mcpServerId,
      workerId,
      pluginId,
    );
  const ctx: ToolInvocationContext = {
    toolName,
    source,
    category,
    pathFields,
    trustOrigin: context.trustOrigin,
    finalInput,
    allowedDirectories,
    sensitivePathsAdjacent,
    sandboxCapability,
    ...(context.userIntent ? { conversationContext: { recentUserMessage: context.userIntent } } : {}),
    ...(sandboxAttestation.ownerPluginSandboxRoot !== undefined
      ? { ownerPluginSandboxRoot: sandboxAttestation.ownerPluginSandboxRoot }
      : {}),
  };
  const ruleVerdict = new RuleBasedRiskClassifier().classify(ctx);
  const storedLevel: UserApprovalVerdict = approval.verdictAtApproval;
  const composed = maxVerdict(ruleVerdict, {
    level: storedLevel,
    reason: "stored approval verdict at approval time",
  });
  if (composed.level !== storedLevel) {
    // Fresh rule verdict exceeded the stored one → escalation, re-prompt.
    console.warn(
      `[permission] foreground memory skip — fresh rule verdict (${ruleVerdict.level}) exceeds stored (${storedLevel}), forcing fresh approval (tool=${toolName})`,
      { event: "memory-skip-escalation", toolName, ruleVerdict: ruleVerdict.level, storedLevel },
    );
    return null;
  }

  // Memory hit — skip the modal. Emit an audit entry recording the skip so
  // forensics can see the auto-allow + its provenance. Swallow-on-failure:
  // an audit write must never block tool execution.
  try {
    const auditEntry = buildSandboxAuditEntry({
      tool: {
        name: toolName,
        // emitSandboxAudit's sink trusts callers to pass DLP-redacted
        // fields (sandbox-audit-sink.ts DLP note) — mask before writing.
        args: maskSensitiveData(JSON.stringify(finalInput)).masked,
        source,
        trustOrigin: context.trustOrigin,
        ...(approvalCacheKey ? { approvalCacheKey } : {}),
      },
      sandbox: {
        kind: sandboxCapability.kind,
        confidence: sandboxCapability.confidence,
        // No sandbox run — this is a memory skip (the tool has not executed
        // yet). The zero telemetry below reflects "not measured", not "0ms".
        events: [],
        spawnLatencyMs: 0,
        overheadPercent: 0,
      },
      reviewer: {
        // ruleVerdict is the fresh deterministic classification of the
        // current args; finalVerdict is the composed max(rule, stored).
        ruleVerdict: ruleVerdict.level,
        // No LLM call on the memory-skip path — record null rather than a
        // composed level so the audit does not imply the classifier ran.
        llmVerdict: null,
        finalVerdict: composed.level,
        compositionRulesTriggered: [],
        userApprovalUsed: {
          memoryHit: true,
          // Stored justification is user/LLM-authored free text — DLP-mask
          // it like every other audit field (the sink does not re-redact).
          nlJustification:
            approval.nlJustification === null
              ? null
              : maskSensitiveData(approval.nlJustification).masked,
          verdictAtApproval: approval.verdictAtApproval,
        },
      },
    });
    emitSandboxAudit(auditEntry).catch(() => {
      // intentionally swallowed — audit failure must not block execution
    });
  } catch {
    // building the audit entry must never block tool execution
  }

  console.info(
    `[permission] foreground memory-hit auto-approve: ${toolName} (scope=${approval.scope}, verdict=${storedLevel})`,
  );
  return {
    decision: "allow",
    reason: `prior user approval (scope=${approval.scope})`,
    layer: 5,
  };
}
