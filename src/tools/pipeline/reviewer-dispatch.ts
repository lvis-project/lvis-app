/**
 * Tool pipeline — reviewer dispatch lanes (headless + interactive-auto).
 *
 * Extracted from `executor.ts` (C7 decomposition). Free functions that take the
 * executor's {@link PermissionManager} and drive the risk-reviewer for the two
 * non-modal foreground/headless approval lanes, emitting permission-review
 * callback events as they go. No other executor state is touched.
 */
import type { ToolSource, ToolCategory } from "../types.js";
import type {
  PermissionManager,
  PermissionCheckResult,
} from "../../permissions/permission-manager.js";
import type { PermissionEvaluationContext } from "../../permissions/evaluation-context.js";
import type { HostShellExecutionPlan } from "../../permissions/host-shell-execution-plan.js";
import { isReviewerAutoDecisionOutcome } from "../../permissions/permission-manager.js";
import type { RiskVerdict } from "../../permissions/reviewer/risk-classifier.js";
import type { ApprovalPurposeSuggestion } from "../../shared/permission-review-status.js";
import { t } from "../../i18n/index.js";
import type {
  ToolPermissionContext,
  ToolCallMeta,
  ToolExecutorCallbacks,
} from "../executor.js";
import { emitPermissionReview, summarizeInputForDeferred } from "./display-mask.js";

export async function dispatchReviewerForHeadless(
  permissionManager: PermissionManager | undefined,
  toolName: string,
  source: ToolSource,
  category: ToolCategory,
  pathFields: readonly string[],
  finalInput: Record<string, unknown>,
  cacheIdentityInput: Record<string, unknown>,
  allowedDirectories: string[],
  sensitivePathsAdjacent: string[],
  context: ToolPermissionContext,
  evaluationContext: PermissionEvaluationContext,
  sandboxAttestation: { ownerPluginSandboxRoot?: string },
  callbacks: ToolExecutorCallbacks | undefined,
  meta: ToolCallMeta,
  approvalPurpose: ApprovalPurposeSuggestion | undefined,
  hostShellExecutionPlan?: HostShellExecutionPlan,
  abortSignal?: AbortSignal,
): Promise<
  | { allowed: true; permissionResult: PermissionCheckResult }
  | { allowed: false; message: string; permissionResult: PermissionCheckResult }
> {
  if (permissionManager?.getMode() === "strict") {
    const reason = "strict mode requires explicit user approval";
    const verdict: RiskVerdict = { level: "high", reason };
    const deferredId = await permissionManager.getDeferredQueue()?.append({
      toolName,
      source,
      category,
      inputSummary: summarizeInputForDeferred(finalInput),
      evaluationContext,
      verdict,
    });
    return {
      allowed: false,
      message:
        t("be_executor.permHoldStrictHeadless", { toolName, source }) +
        (deferredId ? ` (deferredId=${deferredId})` : ""),
      permissionResult: {
        decision: "deny",
        reason: "strict headless requires explicit approval",
        layer: 5,
        reviewer: { route: "headless", verdict },
        ...(deferredId ? { deferred: { queueId: deferredId, reviewerVerdict: verdict } } : {}),
      },
    };
  }

  if (!permissionManager?.hasReviewer()) {
    return {
      allowed: false,
      message: t("be_executor.permBlockHeadlessNoReviewer", { toolName, source }),
      permissionResult: {
        decision: "deny",
        reason: "headless reviewer not wired",
        layer: 5,
      },
    };
  }
  emitPermissionReview(callbacks, {
    status: "reviewing",
    toolName,
    toolCategory: category,
    source,
    ...meta,
    ...(approvalPurpose ? { approvalPurpose } : {}),
  });
  const reviewer = await permissionManager.dispatchReviewer(
    toolName,
    {
      source,
      category,
      pathFields,
      finalInput,
      cacheIdentityInput,
      allowedDirectories,
      sensitivePathsAdjacent,
      trustOrigin: context.trustOrigin,
      evaluationContext,
      ...(context.userIntent ? { conversationContext: { recentUserMessage: context.userIntent } } : {}),
      ...(context.approvalCacheKey ? { approvalCacheKey: context.approvalCacheKey } : {}),
      ...(sandboxAttestation.ownerPluginSandboxRoot !== undefined
        ? { ownerPluginSandboxRoot: sandboxAttestation.ownerPluginSandboxRoot }
        : {}),
      // Thread worker identity so the reviewer reports the genuine asrt
      // capability for wrapped external workers and scopes the verdict cache by
      // the correct substrate.
      ...(meta.mcpServerId !== undefined ? { mcpServerId: meta.mcpServerId } : {}),
      ...(meta.pluginId !== undefined ? { pluginId: meta.pluginId } : {}),
      ...(meta.workerId !== undefined ? { workerId: meta.workerId } : {}),
      ...(hostShellExecutionPlan === undefined
        ? {}
        : { hostShellExecutionPlan }),
    },
    {
      allowedPluginIds: context.allowedPluginIds
        ? [...context.allowedPluginIds]
        : undefined,
      additionalDirectories: context.additionalDirectories ?? [],
    },
    { defer: "medium-high", abortSignal },
  );
  // V3 SOT — PermissionManager owns the verdict→decision mapping; the pipeline
  // only wires the human-facing message + deferred-queue metadata around it.
  // The review-status telemetry is derived from the resolved decision so the
  // auto-approve disclosure and the audit decision share one source.
  const autoDecisionOutcome = isReviewerAutoDecisionOutcome(reviewer.outcome);
  const resolved = autoDecisionOutcome
    ? permissionManager.resolveReviewerDecision(reviewer.verdict, "headless")
    : {
        decision: "deny" as const,
        reason: `headless reviewer ${reviewer.outcome} — execution blocked`,
        layer: 5,
      };
  const decision: PermissionCheckResult = {
    ...resolved,
    reviewer: { route: "headless", verdict: reviewer.verdict, outcome: reviewer.outcome },
  };
  emitPermissionReview(callbacks, {
    status: !autoDecisionOutcome
      ? "failed"
      : decision.decision === "allow" ? "auto_approved" : "needs_approval",
    toolName,
    toolCategory: category,
    source,
    ...meta,
    verdictLevel: reviewer.verdict.level,
    reason: decision.reason,
    ...(approvalPurpose ? { approvalPurpose } : {}),
  });
  if (decision.decision !== "allow") {
    return {
      allowed: false,
      message:
        t("be_executor.permHoldReviewer", { toolName, source, reason: reviewer.verdict.reason }) +
        (reviewer.deferredId ? ` (deferredId=${reviewer.deferredId})` : ""),
      permissionResult: {
        ...decision,
        ...(reviewer.deferredId
          ? { deferred: { queueId: reviewer.deferredId, reviewerVerdict: reviewer.verdict } }
          : {}),
      },
    };
  }
  return {
    allowed: true,
    permissionResult: decision,
  };
}

export async function dispatchReviewerForInteractiveAuto(
  permissionManager: PermissionManager | undefined,
  toolName: string,
  source: ToolSource,
  category: ToolCategory,
  pathFields: readonly string[],
  finalInput: Record<string, unknown>,
  cacheIdentityInput: Record<string, unknown>,
  allowedDirectories: string[],
  sensitivePathsAdjacent: string[],
  context: ToolPermissionContext,
  evaluationContext: PermissionEvaluationContext,
  sandboxAttestation: { ownerPluginSandboxRoot?: string },
  callbacks: ToolExecutorCallbacks | undefined,
  meta: ToolCallMeta,
  approvalPurpose: ApprovalPurposeSuggestion | undefined,
  hostShellExecutionPlan?: HostShellExecutionPlan,
  abortSignal?: AbortSignal,
): Promise<PermissionCheckResult | null> {
  if (context.headless === true) return null;
  // PermissionManager's resolved route marker is the sole eligibility SOT.
  // Reaching this dispatcher means foreground review was explicitly selected.
  const mgr = permissionManager;
  if (!mgr) return null;
  if (!mgr.hasReviewer()) {
    return {
      decision: "ask",
      reason: "auto-review reviewer unavailable — explicit user approval required",
      layer: 5,
    };
  }

  emitPermissionReview(callbacks, {
    status: "reviewing",
    toolName,
    toolCategory: category,
    source,
    ...meta,
    ...(approvalPurpose ? { approvalPurpose } : {}),
  });

  let reviewer: Awaited<ReturnType<PermissionManager["dispatchReviewer"]>>;
  try {
    reviewer = await mgr.dispatchReviewer(
      toolName,
      {
        source,
        category,
        pathFields,
        finalInput,
        cacheIdentityInput,
        allowedDirectories,
        sensitivePathsAdjacent,
        trustOrigin: context.trustOrigin,
        evaluationContext,
        ...(context.userIntent ? { conversationContext: { recentUserMessage: context.userIntent } } : {}),
        ...(context.approvalCacheKey ? { approvalCacheKey: context.approvalCacheKey } : {}),
        ...(sandboxAttestation.ownerPluginSandboxRoot !== undefined
          ? { ownerPluginSandboxRoot: sandboxAttestation.ownerPluginSandboxRoot }
          : {}),
        // Thread MCP/plugin worker identity (see headless dispatch).
        ...(meta.mcpServerId !== undefined ? { mcpServerId: meta.mcpServerId } : {}),
        ...(meta.pluginId !== undefined ? { pluginId: meta.pluginId } : {}),
        ...(meta.workerId !== undefined ? { workerId: meta.workerId } : {}),
        ...(hostShellExecutionPlan === undefined
          ? {}
          : { hostShellExecutionPlan }),
      },
      {
        allowedPluginIds: context.allowedPluginIds
          ? [...context.allowedPluginIds]
          : undefined,
        additionalDirectories: context.additionalDirectories ?? [],
      },
      { defer: "none", abortSignal },
    );
  } catch (err) {
    emitPermissionReview(callbacks, {
      status: "failed",
      toolName,
      toolCategory: category,
      source,
      ...meta,
      reason: err instanceof Error ? err.message : String(err),
      ...(approvalPurpose ? { approvalPurpose } : {}),
    });
    throw err;
  }
  if (abortSignal?.aborted) {
    emitPermissionReview(callbacks, {
      status: "failed",
      toolName,
      toolCategory: category,
      source,
      ...meta,
      reason: "foreground reviewer cancelled by caller",
      ...(approvalPurpose ? { approvalPurpose } : {}),
    });
    // Cancellation is terminal. Deliberately omit reviewer metadata so this
    // result can never be recorded as a fresh/cache text-authorization grant.
    return {
      decision: "deny",
      reason: "foreground reviewer cancelled by caller",
      layer: 5,
    };
  }


  // V3 SOT — PermissionManager owns the verdict→decision mapping.
  // Verdicts through the configured inclusive threshold allow; higher verdicts
  // ask the user. HIGH still requires explicit approval with justification.
  const autoDecisionOutcome = isReviewerAutoDecisionOutcome(reviewer.outcome);
  const resolved = autoDecisionOutcome
    ? mgr.resolveReviewerDecision(reviewer.verdict, "foreground-auto")
    : {
        decision: "ask" as const,
        reason: `foreground reviewer ${reviewer.outcome} — explicit approval required`,
        layer: 5,
        forceModal: true,
      };
  const decision: PermissionCheckResult = {
    ...resolved,
    reviewer: { route: "foreground-auto", verdict: reviewer.verdict, outcome: reviewer.outcome },
  };
  // Review-status telemetry derived from the resolved decision so the
  // auto-approve disclosure and the audit decision share one source.
  emitPermissionReview(callbacks, {
    status: decision.decision === "allow" ? "auto_approved" : "needs_approval",
    toolName,
    toolCategory: category,
    source,
    ...meta,
    verdictLevel: reviewer.verdict.level,
    reason: reviewer.verdict.reason,
    ...(approvalPurpose ? { approvalPurpose } : {}),
  });

  return decision;
}
