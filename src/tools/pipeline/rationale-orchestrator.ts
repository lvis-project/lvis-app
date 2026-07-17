import type { PermissionEvaluationContext } from "../../permissions/evaluation-context.js";
import type { PermissionCheckResult } from "../../permissions/permission-manager.js";
import type { RiskVerdict } from "../../permissions/reviewer/risk-classifier.js";
import type { SandboxCapability } from "../../permissions/sandbox-capability.js";
import { canonicalStringify } from "../../permissions/user-approval-store.js";
import type { ToolCategory, ToolSource, ToolTrustOrigin } from "../types.js";
import {
  RATIONALE_UNKNOWN_SCOPE_SENTINEL,
  createTriggeringBatchDisposition,
  isRationaleEligible,
  validateTriggeringBatchDisposition,
  verifyActionIdentity,
  verifyRationaleRequiredControl,
  type ActionIdentity,
  type HostRationaleEligibilityContext,
  type RationaleEligibilityProvenance,
  type RationaleRequiredControl,
  type RequestAnchor,
  type TriggeringBatchDisposition,
} from "./rationale-control.js";
import type { RationaleExecutorControlOutcome } from "./rationale-pr1-contract.js";
import {
  validateRationaleTicketRecord,
  type RationaleTicketStateRecord,
} from "./rationale-ticket-lifecycle.js";

export type RationaleEligiblePermission = PermissionCheckResult & {
  reviewer: {
    route: "foreground-auto";
    verdict: RiskVerdict;
    outcome: "fresh" | "cache";
  };
};

export interface RationaleControlCandidate {
  readonly now: number;
  readonly requestAnchor: RequestAnchor;
  readonly rationaleProvenance: RationaleEligibilityProvenance;
  readonly triggeringBatchDisposition: TriggeringBatchDisposition;
  readonly toolUseId: string;
  readonly originalInput: Readonly<Record<string, unknown>>;
  /** Raw, post-PreToolUse-hook input. It has not been display/DLP masked. */
  readonly finalInput: Readonly<Record<string, unknown>>;
  readonly toolName: string;
  readonly toolVersion: string;
  readonly source: ToolSource;
  readonly category: ToolCategory;
  readonly pluginId?: string;
  readonly mcpServerId?: string;
  readonly workerId?: string;
  readonly invocationTrustOrigin: ToolTrustOrigin;
  readonly targetFilePaths: readonly string[];
  readonly canonicalTargets: readonly string[];
  readonly allowedDirectories: readonly string[];
  readonly approvalCacheKey?: string;
  readonly sandboxCapability: Readonly<SandboxCapability>;
  readonly sandboxExecutionPlan: Readonly<Record<string, unknown>>;
  readonly permission: RationaleEligiblePermission;
  readonly permissionEvaluationContext: Readonly<PermissionEvaluationContext>;
  readonly eligibilityContext: Readonly<HostRationaleEligibilityContext>;
}

export interface RationaleRuntimeMaterialization {
  readonly action: ActionIdentity;
  readonly control: RationaleRequiredControl;
  readonly ticket: RationaleTicketStateRecord;
  readonly executorControl: RationaleExecutorControlOutcome;
}

export interface RationaleHostRuntime {
  /** Null means this turn has no direct user-keyboard request anchor. */
  readonly requestAnchor: RequestAnchor | null;
  readonly rationaleProvenance: RationaleEligibilityProvenance;
  readonly materializeRationaleControl: (
    candidate: RationaleControlCandidate,
  ) => Promise<RationaleRuntimeMaterialization | null> | RationaleRuntimeMaterialization | null;
}

export interface RationaleControlProbe {
  readonly now?: number;
  readonly batchId: string;
  readonly originalToolUseIds: readonly string[];
  readonly completedToolUseIds: readonly string[];
  readonly toolUseId: string;
  readonly originalInput: Readonly<Record<string, unknown>>;
  readonly finalInput: Readonly<Record<string, unknown>>;
  readonly toolName: string;
  readonly toolVersion: string;
  readonly source: ToolSource;
  readonly category: ToolCategory;
  readonly pluginId?: string;
  readonly mcpServerId?: string;
  readonly workerId?: string;
  readonly invocationTrustOrigin: ToolTrustOrigin;
  readonly targetFilePaths: readonly string[];
  readonly canonicalTargets: readonly string[];
  readonly allowedDirectories: readonly string[];
  readonly approvalCacheKey?: string;
  readonly sandboxCapability: Readonly<SandboxCapability>;
  readonly sandboxExecutionPlan: Readonly<Record<string, unknown>>;
  readonly permission: PermissionCheckResult;
  readonly permissionEvaluationContext: Readonly<PermissionEvaluationContext>;
  readonly eligibilityContext: Readonly<HostRationaleEligibilityContext>;
}

function assertMaterializationBinding(
  materialized: RationaleRuntimeMaterialization,
  candidate: RationaleControlCandidate,
): void {
  const { action, control, ticket, executorControl } = materialized;
  const expectedTargets = candidate.canonicalTargets.length > 0
    ? candidate.canonicalTargets
    : [RATIONALE_UNKNOWN_SCOPE_SENTINEL];
  validateRationaleTicketRecord(ticket);
  if (
    !verifyActionIdentity(action) ||
    !verifyRationaleRequiredControl(control, {
      now: candidate.now,
      currentEligibilityContext: candidate.eligibilityContext,
    }) ||
    !validateTriggeringBatchDisposition(candidate.triggeringBatchDisposition) ||
    action.anchorId !== candidate.requestAnchor.anchorId ||
    action.toolName !== candidate.toolName ||
    action.toolVersion !== candidate.toolVersion ||
    action.source !== candidate.source ||
    action.category !== candidate.category ||
    action.pluginId !== candidate.pluginId ||
    action.mcpServerId !== candidate.mcpServerId ||
    action.workerId !== candidate.workerId ||
    action.approvalCacheKey !== candidate.approvalCacheKey ||
    action.invocationTrustOrigin !== candidate.invocationTrustOrigin ||
    canonicalStringify(action.canonicalTargets) !== canonicalStringify(expectedTargets) ||
    canonicalStringify(action.sandboxExecutionPlan) !==
      canonicalStringify(candidate.sandboxExecutionPlan) ||
    control.action.actionDigest !== action.actionDigest ||
    control.anchor.anchorId !== candidate.requestAnchor.anchorId ||
    control.sealedAction.toolUseId !== candidate.toolUseId ||
    control.sealedAction.toolName !== candidate.toolName ||
    canonicalStringify(control.sealedAction.originalInput) !==
      canonicalStringify(candidate.originalInput) ||
    canonicalStringify(control.sealedAction.finalInput) !==
      canonicalStringify(candidate.finalInput) ||
    control.triggeringBatchDisposition.batchDigest !==
      candidate.triggeringBatchDisposition.batchDigest ||
    ticket.ticketId !== control.ticketId ||
    ticket.actionDigest !== action.actionDigest ||
    ticket.state !== "review_required" ||
    executorControl.channel !== "executor-control" ||
    executorControl.outcome !== "rationale-required" ||
    executorControl.transcriptVisibility !== "hidden" ||
    executorControl.ordinaryToolResult !== null ||
    executorControl.executionAuthorized !== false ||
    executorControl.control.invocationDigest !== control.invocationDigest ||
    executorControl.triggeringBatchDisposition.batchDigest !==
      candidate.triggeringBatchDisposition.batchDigest ||
    executorControl.anchorRoundReservation.reservationId !==
      control.anchorRoundReservation.reservationId
  ) {
    throw new Error("host rationale materialization is not bound to the executor candidate");
  }
}

export async function maybeMaterializeRationaleControl(
  runtime: RationaleHostRuntime,
  probe: RationaleControlProbe,
): Promise<RationaleExecutorControlOutcome | null> {
  const now = probe.now ?? Date.now();
  const eligibility = {
    permission: probe.permission,
    anchor: runtime.requestAnchor,
    invocationTrustOrigin: probe.invocationTrustOrigin,
    rationaleProvenance: runtime.rationaleProvenance,
    headless: probe.eligibilityContext.headless,
    forceModal: probe.eligibilityContext.forceModal,
    approvalReasonPrefix: probe.eligibilityContext.approvalReasonPrefix ?? undefined,
    now,
  };
  if (!isRationaleEligible(eligibility)) return null;

  const triggeringBatchDisposition = createTriggeringBatchDisposition({
    batchId: probe.batchId,
    originalToolUseIds: probe.originalToolUseIds,
    triggeringToolUseId: probe.toolUseId,
    completedToolUseIds: probe.completedToolUseIds,
  });
  const candidate: RationaleControlCandidate = {
    now,
    requestAnchor: eligibility.anchor,
    rationaleProvenance: runtime.rationaleProvenance,
    triggeringBatchDisposition,
    toolUseId: probe.toolUseId,
    originalInput: probe.originalInput,
    finalInput: probe.finalInput,
    toolName: probe.toolName,
    toolVersion: probe.toolVersion,
    source: probe.source,
    category: probe.category,
    ...(probe.pluginId === undefined ? {} : { pluginId: probe.pluginId }),
    ...(probe.mcpServerId === undefined ? {} : { mcpServerId: probe.mcpServerId }),
    ...(probe.workerId === undefined ? {} : { workerId: probe.workerId }),
    invocationTrustOrigin: probe.invocationTrustOrigin,
    targetFilePaths: [...probe.targetFilePaths],
    canonicalTargets: [...probe.canonicalTargets],
    allowedDirectories: [...probe.allowedDirectories],
    ...(probe.approvalCacheKey === undefined
      ? {}
      : { approvalCacheKey: probe.approvalCacheKey }),
    sandboxCapability: probe.sandboxCapability,
    sandboxExecutionPlan: probe.sandboxExecutionPlan,
    permission: eligibility.permission,
    permissionEvaluationContext: probe.permissionEvaluationContext,
    eligibilityContext: probe.eligibilityContext,
  };
  const materialized = await runtime.materializeRationaleControl(candidate);
  if (materialized === null) return null;
  assertMaterializationBinding(materialized, candidate);
  return materialized.executorControl;
}
