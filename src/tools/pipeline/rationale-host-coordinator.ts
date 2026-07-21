import { createHash } from "node:crypto";
import {
  isHostApprovalRejectedDecision,
  isHostApprovalTimeoutDecision,
  type ApprovalDecision,
  type ApprovalRequest,
  type ApprovalGate,
} from "../../permissions/approval-gate.js";
import type { PermissionEvaluationContext } from "../../permissions/evaluation-context.js";
import type {
  RationaleScopeReviewer,
} from "../../permissions/reviewer/rationale-scope-reviewer.js";
import type { SandboxCapability } from "../../permissions/sandbox-capability.js";
import { canonicalStringify } from "../../shared/canonical-json.js";
import { runWithAbortableDeadline } from "../../shared/abortable-deadline.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import type { ToolCategory, ToolSource, ToolTrustOrigin } from "../types.js";
import {
  RATIONALE_UNKNOWN_SCOPE_SENTINEL,
  cloneRationaleCanonicalJson,
  createActionIdentity,
  createRationaleRequiredControl,
  verifyRationaleRequiredControl,
  type ActionIdentity,
  type HostAnchorRoundCas,
  type HostRationaleEligibilityContext,
  type RationaleEligibilityProvenance,
  type RationaleRequiredControl,
  type RationaleResponse,
  type RequestAnchor,
} from "./rationale-control.js";
import type {
  RationaleControlCandidate,
  RationaleHostRuntime,
  RationaleRuntimeMaterialization,
} from "./rationale-orchestrator.js";
import {
  createRationaleExecutorControlOutcome,
  createReviewerScopeReevaluation,
  evaluateRationaleOnlyBatch,
  isReviewerAutoApproveEligible,
  validateRationaleOnlyBatchDecision,
  validateReviewerScopeReevaluation,
  type RationaleGenerationOutcome,
  type RationaleOnlyBatchDecision,
  type RationaleRoundCall,
  type ReviewerScopeReevaluation,
} from "./rationale-pr1-contract.js";
import {
  createRationaleApprovalDisplayFromProjection,
  createRationaleUiAuditProjection,
  createSealedRationaleResumeRequest as createContractSealedRationaleResumeRequest,
  type RationaleUiAuditProjection,
  type SealedRationaleResumeRequest,
} from "./rationale-resume-contract.js";
import type { RationaleApprovalDisplay } from "../../shared/rationale-approval-display.js";
import {
  type HostConsumedAllowOnceReceipt,
  type HostInvocationStartCas,
  type InvocationAuditRecord,
  type RationaleGenerationProviderFailureCause,
  type RationaleTicketStateRecord,
} from "./rationale-ticket-lifecycle.js";
import {
  createRationaleTicketCasExpectation,
  type HostRationaleTicketSnapshot,
  type InProcessRationaleTicketStore,
} from "./rationale-ticket-store.js";
import type {
  RationaleResumeHostRuntime,
  RationaleResumeIdentityProbe,
} from "./rationale-resume-runner.js";

export interface ConservativeRationaleActionSummary {
  readonly requestedEffects: readonly string[];
  readonly affectedResources: readonly string[];
  readonly requiredAuthority: string;
}

const CATEGORY_SUMMARIES = Object.freeze({
  read: Object.freeze({
    requestedEffects: Object.freeze(["read-data"]),
    requiredAuthority: "read-data",
  }),
  write: Object.freeze({
    requestedEffects: Object.freeze(["mutate-data", "delete-or-overwrite-data"]),
    requiredAuthority: "workspace-write",
  }),
  shell: Object.freeze({
    requestedEffects: Object.freeze(["execute-command", "mutate-host-state"]),
    requiredAuthority: "shell-execution",
  }),
  network: Object.freeze({
    requestedEffects: Object.freeze(["network-egress", "transmit-data"]),
    requiredAuthority: "network-egress",
  }),
  meta: Object.freeze({
    requestedEffects: Object.freeze(["change-host-or-agent-state"]),
    requiredAuthority: "host-orchestration",
  }),
}) satisfies Readonly<Record<ToolCategory, {
  readonly requestedEffects: readonly string[];
  readonly requiredAuthority: string;
}>>;

const PROVIDER_FAILURES: readonly RationaleGenerationProviderFailureCause[] =
  Object.freeze([
    "generation-unavailable",
    "generation-error",
    "generation-timeout",
  ]);

function equal(left: unknown, right: unknown): boolean {
  return canonicalStringify(left) === canonicalStringify(right);
}

function compactResource(value: string): string {
  const normalized = value.trim();
  if (normalized.length <= 160) return normalized;
  const suffix = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return normalized.slice(0, 142) + "#" + suffix;
}

/**
 * Effects and authority come from the host-owned category, never from
 * model-authored rationale text or tool arguments.
 */
export function deriveConservativeRationaleActionSummary(input: {
  readonly category: ToolCategory;
  readonly source: ToolSource;
  readonly toolName: string;
  readonly canonicalTargets: readonly string[];
}): ConservativeRationaleActionSummary {
  const category = CATEGORY_SUMMARIES[input.category];
  const resources: string[] = [];
  const seen = new Set<string>();
  const candidates = input.canonicalTargets.length > 0
    ? input.canonicalTargets
    : ["tool:" + input.source + ":" + input.toolName];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !candidate.trim()) continue;
    const resource = compactResource(candidate);
    if (!seen.has(resource)) {
      seen.add(resource);
      resources.push(resource);
    }
    if (resources.length === 8) break;
  }
  if (resources.length === 0) resources.push(RATIONALE_UNKNOWN_SCOPE_SENTINEL);
  return Object.freeze({
    requestedEffects: category.requestedEffects,
    affectedResources: Object.freeze(resources),
    requiredAuthority: category.requiredAuthority,
  });
}

type RationaleApprovalGate = Pick<ApprovalGate, "requestAndWait" | "cancelPendingRationale">;

export interface RationaleHostCoordinatorOptions {
  readonly requestAnchor: RequestAnchor | null;
  readonly rationaleProvenance: RationaleEligibilityProvenance;
  /** Shared with every coordinator created for this host session. */
  readonly ticketStore: InProcessRationaleTicketStore;
  readonly rationaleScopeReviewer: RationaleScopeReviewer;
  readonly approvalGate: RationaleApprovalGate;
  readonly getRationalePolicyEpoch: () => string;
  readonly getRegistryGeneration: () => string | number;
  readonly getSandboxGeneration: () => string | number;
  /** Shared across every coordinator created for this host session. */
  readonly anchorRoundCas: HostAnchorRoundCas;
  /** Shared persistent/CAS boundary; never reset per coordinator instance. */
  readonly hostInvocationStartCas: HostInvocationStartCas;
  /** Required audit sink. Missing or failing persistence blocks invocation start. */
  readonly onInvocationAudit: (record: InvocationAuditRecord) => Promise<void> | void;
  /** Required synchronous audit sink. Failure blocks modal publication. */
  readonly onProjectionAudit: (
    sessionId: string,
    projection: RationaleUiAuditProjection,
    at: number,
  ) => unknown;
  /** Shared host generation guard; stale coordinators must not open authority. */
  readonly isCurrent?: () => boolean;
  readonly now?: () => number;
}

export type RationaleRoundResult =
  | {
      readonly kind: "batch-decision";
      readonly decision: RationaleOnlyBatchDecision;
    }
  | {
      readonly kind: "generation-failure";
      readonly generationOutcome: RationaleGenerationProviderFailureCause;
    }
  | {
      readonly kind: "interrupted";
    }
  | {
      /** Compatibility/test surface; production query-loop passes batch-decision. */
      readonly kind: "calls";
      readonly calls: readonly RationaleRoundCall[];
    }
  | {
      /** Compatibility alias for older host wiring. */
      readonly kind: "provider-failure";
      readonly outcome: RationaleGenerationProviderFailureCause;
    };

export interface RationaleRoundResolution {
  readonly status: "ready" | "failed";
  readonly generationOutcome: RationaleGenerationOutcome;
  readonly response: RationaleResponse | null;
  readonly reevaluation: ReviewerScopeReevaluation | null;
  readonly batchDecision: RationaleOnlyBatchDecision | null;
  readonly ticket: HostRationaleTicketSnapshot;
  readonly projection: RationaleUiAuditProjection;
  /**
   * True only on the reviewer auto-approve-on-aligned terminal: the ticket is
   * already authorized (one-shot receipt minted) and the caller must SKIP the
   * user modal and go straight to `createSealedResume`. False on every path
   * that still requires the modal.
   */
  readonly autoApproved: boolean;
}

export type RationaleApprovalResolution =
  | {
      readonly outcome: "allowed-once";
      readonly ticket: RationaleTicketStateRecord;
      readonly projection: RationaleUiAuditProjection;
      readonly receiptId: string;
    }
  | {
      readonly outcome: "denied" | "cancelled" | "timed-out";
      readonly ticket: RationaleTicketStateRecord;
      readonly projection: RationaleUiAuditProjection;
    };

export interface RationaleSealedResumeResolution {
  readonly resumeRequest: SealedRationaleResumeRequest;
  readonly hostConsumedAllowOnceReceipt: HostConsumedAllowOnceReceipt;
}

export interface RationaleApprovalPromptInput {
  readonly abortSignal?: AbortSignal;
  readonly now?: number;
}

export interface CreateRationaleSealedResumeInput {
  readonly ticketId: string;
  readonly currentEligibilityContext: HostRationaleEligibilityContext;
  readonly now?: number;
}

interface ApprovalMetadata {
  readonly evaluationContext: PermissionEvaluationContext;
  readonly sandboxCapability: SandboxCapability;
  readonly targetFilePath: string | null;
  readonly toolName: string;
  readonly category: ToolCategory;
  readonly source: ToolSource;
  readonly pluginId?: string;
  readonly trustOrigin: ToolTrustOrigin;
}

interface TicketContext {
  readonly sessionId: string;
  readonly control: RationaleRequiredControl;
  readonly approval: ApprovalMetadata;
  snapshot: HostRationaleTicketSnapshot;
  response: RationaleResponse | null;
  reevaluation: ReviewerScopeReevaluation | null;
  projection: RationaleUiAuditProjection | null;
  display: RationaleApprovalDisplay | null;
  projectionAuditCommitted: boolean;
  terminalTicket: RationaleTicketStateRecord | null;
  receipt: HostConsumedAllowOnceReceipt | null;
  issuedResumeRequest: SealedRationaleResumeRequest | null;
  roundResultStarted: boolean;
  approvalStarted: boolean;
  resumeIssued: boolean;
}

function generationValue(
  provider: () => string | number,
  label: string,
): string {
  const raw = provider();
  const value = typeof raw === "number"
    ? (Number.isFinite(raw) ? String(raw) : "")
    : raw;
  if (typeof value !== "string" || !value.trim() || value.length > 256) {
    throw new TypeError(label + " must be a bounded generation value");
  }
  return value;
}

/**
 * Host-owned coordinator for the PR(2) rationale path. It materializes control
 * records and modal/resume artifacts only; it never calls the provider or
 * executes a tool.
 */
export class RationaleHostCoordinator implements RationaleHostRuntime, RationaleResumeHostRuntime {
  readonly requestAnchor: RequestAnchor | null;
  readonly rationaleProvenance: RationaleEligibilityProvenance;

  readonly #ticketStore: InProcessRationaleTicketStore;
  readonly #rationaleScopeReviewer: RationaleScopeReviewer;
  readonly #approvalGate: RationaleApprovalGate;
  readonly #getRationalePolicyEpoch: () => string;
  readonly #getRegistryGeneration: () => string | number;
  readonly #getSandboxGeneration: () => string | number;
  readonly #anchorRoundCas: HostAnchorRoundCas;
  readonly hostInvocationStartCas: HostInvocationStartCas;
  readonly #onInvocationAudit: (
    record: InvocationAuditRecord,
  ) => Promise<void> | void;
  readonly #onProjectionAudit: (
    sessionId: string,
    projection: RationaleUiAuditProjection,
    at: number,
  ) => unknown;
  readonly #now: () => number;
  readonly #isCurrent: () => boolean;
  readonly #contexts = new Map<string, TicketContext>();
  readonly #retiringContexts = new Map<string, TicketContext>();

  constructor(options: RationaleHostCoordinatorOptions) {
    if (typeof options.onProjectionAudit !== "function") {
      throw new TypeError("rationale host coordinator requires projection audit");
    }
    this.requestAnchor = options.requestAnchor;
    this.rationaleProvenance = Object.freeze({ ...options.rationaleProvenance });
    this.#ticketStore = options.ticketStore;
    this.#rationaleScopeReviewer = options.rationaleScopeReviewer;
    this.#approvalGate = options.approvalGate;
    this.#getRationalePolicyEpoch = options.getRationalePolicyEpoch;
    this.#getRegistryGeneration = options.getRegistryGeneration;
    this.#getSandboxGeneration = options.getSandboxGeneration;
    this.#anchorRoundCas = options.anchorRoundCas;
    this.hostInvocationStartCas = options.hostInvocationStartCas;
    this.#onInvocationAudit = options.onInvocationAudit;
    this.#onProjectionAudit = options.onProjectionAudit;
    this.#now = options.now ?? Date.now;
    this.#isCurrent = options.isCurrent ?? (() => true);
  }

  materializeActionIdentity(candidate: RationaleControlCandidate): ActionIdentity {
    const canonicalTargets = candidate.canonicalTargets.length > 0
      ? [...candidate.canonicalTargets]
      : [RATIONALE_UNKNOWN_SCOPE_SENTINEL];
    const summary = deriveConservativeRationaleActionSummary({
      category: candidate.category,
      source: candidate.source,
      toolName: candidate.toolName,
      canonicalTargets,
    });
    return createActionIdentity({
      anchorId: candidate.requestAnchor.anchorId,
      invocationTrustOrigin: candidate.invocationTrustOrigin,
      rationaleProvenance: candidate.rationaleProvenance,
      toolName: candidate.toolName,
      toolVersion: candidate.toolVersion,
      source: candidate.source,
      category: candidate.category,
      ...(candidate.pluginId === undefined ? {} : { pluginId: candidate.pluginId }),
      ...(candidate.mcpServerId === undefined
        ? {}
        : { mcpServerId: candidate.mcpServerId }),
      ...(candidate.workerId === undefined ? {} : { workerId: candidate.workerId }),
      finalInput: candidate.finalInput,
      ...(candidate.approvalCacheKey === undefined
        ? {}
        : { approvalCacheKey: candidate.approvalCacheKey }),
      canonicalTargets,
      requestedEffects: summary.requestedEffects,
      affectedResources: summary.affectedResources,
      requiredAuthority: summary.requiredAuthority,
      policyEpoch: generationValue(
        this.#getRationalePolicyEpoch,
        "rationale policy epoch",
      ),
      registryGeneration: generationValue(
        this.#getRegistryGeneration,
        "tool registry generation",
      ),
      sandboxGeneration: generationValue(
        this.#getSandboxGeneration,
        "sandbox generation",
      ),
      sandboxExecutionPlan: candidate.sandboxExecutionPlan,
    });
  }

  recomputeSealedActionIdentity(
    control: RationaleRequiredControl,
    now = this.#now(),
  ): ActionIdentity {
    if (!verifyRationaleRequiredControl(control, { now })) {
      throw new Error("cannot recompute identity for invalid rationale control");
    }
    const sealed = control.action;
    const summary = deriveConservativeRationaleActionSummary({
      category: sealed.category,
      source: sealed.source,
      toolName: sealed.toolName,
      canonicalTargets: sealed.canonicalTargets,
    });
    return createActionIdentity({
      anchorId: sealed.anchorId,
      invocationTrustOrigin: sealed.invocationTrustOrigin,
      rationaleProvenance: sealed.rationaleProvenance,
      toolName: sealed.toolName,
      toolVersion: sealed.toolVersion,
      source: sealed.source,
      category: sealed.category,
      ...(sealed.pluginId === undefined ? {} : { pluginId: sealed.pluginId }),
      ...(sealed.mcpServerId === undefined
        ? {}
        : { mcpServerId: sealed.mcpServerId }),
      ...(sealed.workerId === undefined ? {} : { workerId: sealed.workerId }),
      finalInput: control.sealedAction.finalInput as Record<string, unknown>,
      ...(sealed.approvalCacheKey === undefined
        ? {}
        : { approvalCacheKey: sealed.approvalCacheKey }),
      canonicalTargets: sealed.canonicalTargets,
      requestedEffects: summary.requestedEffects,
      affectedResources: summary.affectedResources,
      requiredAuthority: summary.requiredAuthority,
      policyEpoch: generationValue(
        this.#getRationalePolicyEpoch,
        "rationale policy epoch",
      ),
      registryGeneration: generationValue(
        this.#getRegistryGeneration,
        "tool registry generation",
      ),
      sandboxGeneration: generationValue(
        this.#getSandboxGeneration,
        "sandbox generation",
      ),
      sandboxExecutionPlan: sealed.sandboxExecutionPlan,
    });
  }

  readonly resolveCurrentActionIdentity = (
    probe: RationaleResumeIdentityProbe,
  ): ActionIdentity | null => {
    if (!this.#isCoordinatorCurrent()) return null;
    const context = this.#contexts.get(probe.request.ticketId);
    if (
      !context ||
      !context.resumeIssued ||
      context.issuedResumeRequest === null ||
      !equal(context.issuedResumeRequest, probe.request) ||
      !equal(context.control, probe.request.control)
    ) {
      return null;
    }
    try {
      return this.recomputeSealedActionIdentity(probe.request.control, this.#now());
    } catch {
      return null;
    }
  };

  readonly loadHostConsumedAllowOnceReceipt = (
    request: SealedRationaleResumeRequest,
  ): HostConsumedAllowOnceReceipt | null => {
    if (!this.#isCoordinatorCurrent()) return null;
    const context = this.#contexts.get(request.ticketId);
    if (
      !context ||
      context.receipt === null ||
      context.issuedResumeRequest === null ||
      !equal(context.issuedResumeRequest, request)
    ) {
      return null;
    }
    return this.#ticketStore.isAuthenticConsumedAllowOnceReceipt(
      context.receipt,
      this.#now(),
    )
      ? context.receipt
      : null;
  };

  readonly isAuthenticConsumedAllowOnceReceipt = (
    receipt: HostConsumedAllowOnceReceipt,
    now: number,
  ): boolean => this.#isCoordinatorCurrent() &&
    this.#ticketStore.isAuthenticConsumedAllowOnceReceipt(receipt, now);

  readonly onInvocationAudit = async (
    record: InvocationAuditRecord,
  ): Promise<void> => {
    await this.#onInvocationAudit(record);
  };
  readonly materializeRationaleControl = (
    candidate: RationaleControlCandidate,
  ): RationaleRuntimeMaterialization | null => {
    try {
      if (!this.#isCoordinatorCurrent()) return null;
      if (
        this.requestAnchor === null ||
        !Number.isFinite(candidate.now) ||
        !equal(candidate.requestAnchor, this.requestAnchor) ||
        !equal(candidate.rationaleProvenance, this.rationaleProvenance)
      ) {
        return null;
      }
      const action = this.materializeActionIdentity(candidate);
      const anchorRoundReservation = this.#anchorRoundCas.tryReserve({
        anchor: candidate.requestAnchor,
        action,
        triggeringBatchDisposition: candidate.triggeringBatchDisposition,
        round: 1,
        now: candidate.now,
      });
      if (!anchorRoundReservation || this.#contexts.has(anchorRoundReservation.ticketId)) {
        return null;
      }
      // `tryReserve` is deliberately idempotent for an identical retry. A
      // coordinator recreated for the same batch must therefore consult the
      // shared ticket store before rebuilding the control; otherwise a fresh
      // coordinator could reopen the one-round anchor budget.
      const existingTicket = this.#ticketStore.get({
        sessionId: candidate.requestAnchor.sessionId,
        ticketId: anchorRoundReservation.ticketId,
        now: candidate.now,
      });
      if (existingTicket) return null;
      const control = createRationaleRequiredControl({
        anchor: candidate.requestAnchor,
        action,
        triggeringBatchDisposition: candidate.triggeringBatchDisposition,
        anchorRoundReservation,
        hostAnchorRoundCas: this.#anchorRoundCas,
        sealedAction: {
          toolUseId: candidate.toolUseId,
          toolName: candidate.toolName,
          originalInput: candidate.originalInput,
          finalInput: candidate.finalInput,
        },
        eligibilityContext: candidate.eligibilityContext,
        permission: candidate.permission,
        now: candidate.now,
      });
      const executorControl = createRationaleExecutorControlOutcome(
        control,
        candidate.now,
      );
      const created = this.#ticketStore.create({
        sessionId: control.anchor.sessionId,
        control,
        now: candidate.now,
      });
      if (!created) return null;
      const requested = this.#ticketStore.requestRationale(
        createRationaleTicketCasExpectation(created),
        candidate.now,
      );
      if (!requested) return null;
      const targetFilePath =
        candidate.targetFilePaths.find((path) => Boolean(path.trim())) ?? null;
      this.#contexts.set(control.ticketId, {
        sessionId: control.anchor.sessionId,
        control,
        approval: {
          evaluationContext: candidate.permissionEvaluationContext,
          sandboxCapability: candidate.sandboxCapability,
          targetFilePath,
          toolName: candidate.toolName,
          category: candidate.category,
          source: candidate.source,
          ...(candidate.pluginId === undefined
            ? {}
            : { pluginId: candidate.pluginId }),
          trustOrigin: candidate.invocationTrustOrigin,
        },
        snapshot: requested,
        response: null,
        reevaluation: null,
        projection: null,
        display: null,
        projectionAuditCommitted: false,
        terminalTicket: null,
        receipt: null,
        issuedResumeRequest: null,
        roundResultStarted: false,
        approvalStarted: false,
        resumeIssued: false,
      });
      return {
        action,
        control,
        ticket: created.ticket,
        executorControl,
      };
    } catch {
      return null;
    }
  };

  async handleRationaleRoundResult(input: {
    readonly ticketId: string;
    readonly result: RationaleRoundResult;
    readonly abortSignal?: AbortSignal;
    readonly now?: number;
  }): Promise<RationaleRoundResolution | null> {
    const startedAt = input.now ?? this.#now();
    if (!this.#isCoordinatorCurrent()) {
      this.#contexts.delete(input.ticketId);
      return null;
    }
    const context = this.#contexts.get(input.ticketId);
    if (!context || context.roundResultStarted || !Number.isFinite(startedAt)) {
      return null;
    }
    const active = this.#ticketStore.get({
      sessionId: context.sessionId,
      ticketId: input.ticketId,
      now: startedAt,
    });
    if (!active || active.ticket.state !== "rationale_requested") {
      this.#contexts.delete(input.ticketId);
      return null;
    }
    context.snapshot = active;
    context.roundResultStarted = true;
    if (input.abortSignal?.aborted) {
      this.abort(input.ticketId, startedAt);
      return null;
    }

    if (input.result.kind === "interrupted") {
      this.abort(input.ticketId, startedAt);
      return null;
    }

    let batchDecision: RationaleOnlyBatchDecision | null = null;
    let generationOutcome: RationaleGenerationOutcome;
    let generatedResponse: RationaleResponse | null = null;
    if (input.result.kind === "batch-decision") {
      try {
        const sealedDecision = cloneRationaleCanonicalJson(
          input.result.decision,
          "RationaleOnlyBatchDecision",
        ) as RationaleOnlyBatchDecision;
        if (!validateRationaleOnlyBatchDecision(
          sealedDecision,
          context.control,
          startedAt,
        )) {
          throw new TypeError("invalid rationale-only batch decision");
        }
        batchDecision = sealedDecision;
        generationOutcome = sealedDecision.generationOutcome;
        generatedResponse = sealedDecision.response;
      } catch {
        generationOutcome = "malformed-rationale";
      }
    } else if (input.result.kind === "calls") {
      try {
        batchDecision = evaluateRationaleOnlyBatch(
          context.control,
          input.result.calls,
          startedAt,
        );
        generationOutcome = batchDecision.generationOutcome;
        generatedResponse = batchDecision.response;
      } catch {
        generationOutcome = "malformed-rationale";
      }
    } else {
      const providerOutcome = input.result.kind === "generation-failure"
        ? input.result.generationOutcome
        : input.result.outcome;
      generationOutcome = PROVIDER_FAILURES.includes(providerOutcome)
        ? providerOutcome
        : "generation-error";
    }
    let reevaluation: ReviewerScopeReevaluation | null = null;
    if (generationOutcome === "accepted-rationale" && generatedResponse !== null) {
      let reviewerResult: ReviewerScopeReevaluation;
      const reviewerOutcome = await runWithAbortableDeadline(
        (abortSignal) => this.#rationaleScopeReviewer.reevaluate({
          control: context.control,
          response: generatedResponse,
          abortSignal,
          now: startedAt,
        }),
        {
          deadlineMs: TOOL_TIMEOUT_POLICY.rationaleScopeReviewMs,
          ...(input.abortSignal === undefined
            ? {}
            : { callerAbortSignal: input.abortSignal }),
        },
      );
      if (!reviewerOutcome.ok) {
        if (reviewerOutcome.reason === "caller-abort") {
          this.abort(input.ticketId, input.now ?? this.#now());
          return null;
        }
        reviewerResult = createReviewerScopeReevaluation({
          control: context.control,
          outcome: reviewerOutcome.reason === "deadline" ? "timeout" : "error",
          now: startedAt,
        });
      } else {
        reviewerResult = reviewerOutcome.value;
      }
      if (!validateReviewerScopeReevaluation(
        reviewerResult,
        context.control,
        startedAt,
      )) {
        reviewerResult = createReviewerScopeReevaluation({
          control: context.control,
          outcome: "malformed",
          now: startedAt,
        });
      }
      reevaluation = reviewerResult;
    } else if (generationOutcome === "accepted-rationale") {
      generationOutcome = "malformed-rationale";
    }

    const settledAt = input.now ?? this.#now();
    if (!this.#isCoordinatorCurrent()) {
      this.#contexts.delete(input.ticketId);
      return null;
    }
    if (
      this.#contexts.get(input.ticketId) !== context ||
      input.abortSignal?.aborted
    ) {
      this.abort(input.ticketId, settledAt);
      return null;
    }
    const ready = generationOutcome === "accepted-rationale" &&
      reevaluation?.outcome === "fresh";
    const outcomes = {
      generationOutcome,
      reevaluationOutcome: reevaluation?.outcome ?? null,
    };
    const resolved = ready
      ? this.#ticketStore.markRationaleReady(
          createRationaleTicketCasExpectation(context.snapshot),
          outcomes,
          settledAt,
        )
      : this.#ticketStore.markRationaleFailed(
          createRationaleTicketCasExpectation(context.snapshot),
          outcomes,
          settledAt,
        );
    if (!resolved) {
      this.#contexts.delete(input.ticketId);
      return null;
    }

    // Reviewer auto-approve-on-aligned terminal. Only a fresh + aligned +
    // non-high reviewer re-evaluation qualifies; every other outcome falls
    // through to the modal below. This mints the same one-shot allow-once
    // receipt a user allow-once would, skipping user_pending and the modal, so
    // the sealed-resume execution chokepoint downstream is unchanged.
    if (ready && reevaluation !== null &&
        isReviewerAutoApproveEligible(reevaluation)) {
      const receipt = this.#ticketStore.consumeReviewerAuthorizedOnce(
        createRationaleTicketCasExpectation(resolved),
        settledAt,
      );
      if (
        !receipt ||
        !this.#ticketStore.isAuthenticConsumedAllowOnceReceipt(receipt, settledAt)
      ) {
        this.#contexts.delete(input.ticketId);
        return null;
      }
      const autoResponse = generatedResponse;
      const autoProjection = createRationaleUiAuditProjection({
        control: context.control,
        response: autoResponse,
        reevaluation,
        ticket: receipt.ticket,
        now: settledAt,
        autoApproved: true,
      });
      // A failing projection audit fails closed exactly like the modal path:
      // the exception propagates before `context.receipt` is published, so the
      // minted receipt is unreachable and no resume can be sealed.
      this.#commitProjectionAudit(context.sessionId, autoProjection, settledAt);
      context.snapshot = resolved;
      context.response = autoResponse;
      context.reevaluation = reevaluation;
      context.receipt = receipt;
      context.terminalTicket = receipt.ticket;
      context.projection = autoProjection;
      context.projectionAuditCommitted = true;
      return {
        status: "ready",
        generationOutcome,
        response: autoResponse,
        reevaluation,
        batchDecision,
        ticket: resolved,
        projection: autoProjection,
        autoApproved: true,
      };
    }

    const pending = this.#ticketStore.promptUser(
      createRationaleTicketCasExpectation(resolved),
      settledAt,
    );
    if (!pending) {
      this.#contexts.delete(input.ticketId);
      return null;
    }
    const response = ready ? generatedResponse : null;
    const projection = createRationaleUiAuditProjection({
      control: context.control,
      response,
      reevaluation,
      ticket: pending.ticket,
      now: settledAt,
    });
    context.snapshot = pending;
    context.response = response;
    context.reevaluation = reevaluation;
    let display: RationaleApprovalDisplay;
    try {
      display = createRationaleApprovalDisplayFromProjection(projection);
    } catch (error) {
      // A projection/display contract drift must fail closed. `snapshot` is
      // already the user_pending ticket, allowing abort() to retire it rather
      // than stranding a non-modal approval state.
      try {
        this.abort(input.ticketId, settledAt);
      } catch (abortError) {
        throw new AggregateError(
          [error, abortError],
          "rationale display conversion and ticket abort failed",
        );
      }
      throw error;
    }
    this.#commitProjectionAudit(context.sessionId, projection, settledAt);
    context.projection = projection;
    context.display = display;
    context.projectionAuditCommitted = true;
    return {
      status: ready ? "ready" : "failed",
      generationOutcome,
      response,
      reevaluation,
      batchDecision,
      ticket: pending,
      projection,
      autoApproved: false,
    };
  }

  async promptForApproval(
    ticketId: string,
    input: RationaleApprovalPromptInput = {},
  ): Promise<RationaleApprovalResolution | null> {
    const requestedAt = input.now ?? this.#now();
    if (!this.#isCoordinatorCurrent()) {
      this.#contexts.delete(ticketId);
      return null;
    }
    const context = this.#contexts.get(ticketId);
    if (
      !context ||
      context.approvalStarted ||
      context.snapshot.ticket.state !== "user_pending" ||
      context.projection === null ||
      context.display === null ||
      !context.projectionAuditCommitted ||
      !Number.isFinite(requestedAt)
    ) {
      return null;
    }
    if (input.abortSignal?.aborted) {
      this.abort(ticketId, requestedAt);
      return null;
    }

    context.approvalStarted = true;
    type ApprovalAbortOutcome = {
      readonly kind: "aborted";
      readonly failure: { readonly error: unknown } | null;
    };
    const abortState: { current: ApprovalAbortOutcome | null } = {
      current: null,
    };
    let settleAbort: ((outcome: ApprovalAbortOutcome) => void) | null = null;
    const abortWait = new Promise<ApprovalAbortOutcome>((resolve) => {
      settleAbort = resolve;
    });
    const abortPending = (): void => {
      if (abortState.current !== null) return;
      let failure: ApprovalAbortOutcome["failure"] = null;
      try {
        this.abort(ticketId, Math.max(requestedAt, this.#now()));
      } catch (error) {
        failure = { error };
      }
      const outcome: ApprovalAbortOutcome = {
        kind: "aborted",
        failure,
      };
      abortState.current = outcome;
      settleAbort?.(outcome);
    };
    input.abortSignal?.addEventListener("abort", abortPending, { once: true });
    if (input.abortSignal?.aborted) abortPending();
    const subscribedAbort = abortState.current;
    if (subscribedAbort !== null) {
      input.abortSignal?.removeEventListener("abort", abortPending);
      if (subscribedAbort.failure !== null) throw subscribedAbort.failure.error;
      return null;
    }
    if (this.#contexts.get(ticketId) !== context) {
      input.abortSignal?.removeEventListener("abort", abortPending);
      return null;
    }

    const metadata = context.approval;
    const request: Omit<ApprovalRequest, "requireExplicit"> = {
      id: ticketId,
      category: "tool",
      kind: "rationale",
      allowedChoices: ["allow-once", "deny-once"],
      toolName: metadata.toolName,
      toolCategory: metadata.category,
      reviewerVerdict: context.display.effectiveVerdict,
      evaluationContext: metadata.evaluationContext,
      args: context.display,
      reason: "Review the host-sealed action and its permission rationale.",
      source: metadata.source,
      ...(metadata.pluginId === undefined
        ? {}
        : { sourcePluginId: metadata.pluginId }),
      createdAt: requestedAt,
      trustOrigin: metadata.trustOrigin,
      sandboxCapability: metadata.sandboxCapability,
      ...(metadata.targetFilePath === null
        ? {}
        : { target: { filePath: metadata.targetFilePath } }),
      isReadOnly: false,
    };

    const approvalWait = (() => {
      try {
        return Promise.resolve(this.#approvalGate.requestAndWait(request)).then(
          (decision) => ({ kind: "decision" as const, decision }),
          () => ({ kind: "decision" as const, decision: null }),
        );
      } catch {
        return Promise.resolve({
          kind: "decision" as const,
          decision: null,
        });
      }
    })();
    let waitOutcome: Awaited<typeof approvalWait> | ApprovalAbortOutcome;
    try {
      waitOutcome = await Promise.race([approvalWait, abortWait]);
    } finally {
      input.abortSignal?.removeEventListener("abort", abortPending);
    }
    const observedAbort = abortState.current;
    if (observedAbort !== null) {
      if (observedAbort.failure !== null) throw observedAbort.failure.error;
      return null;
    }
    if (waitOutcome.kind === "aborted") {
      if (waitOutcome.failure !== null) throw waitOutcome.failure.error;
      return null;
    }
    const decision: ApprovalDecision | null = waitOutcome.decision;
    const decidedAt = input.now ?? this.#now();
    if (
      !this.#isCoordinatorCurrent() ||
      this.#contexts.get(ticketId) !== context
    ) {
      this.#contexts.delete(ticketId);
      return null;
    }
    const expectation = createRationaleTicketCasExpectation(context.snapshot);

    if (
      decision?.requestId === ticketId &&
      decision.choice === "allow-once"
    ) {
      const receipt = this.#ticketStore.consumeAllowOnce(expectation, decidedAt);
      if (
        !receipt ||
        !this.#ticketStore.isAuthenticConsumedAllowOnceReceipt(receipt, decidedAt)
      ) {
        this.#contexts.delete(ticketId);
        return null;
      }
      const projection = createRationaleUiAuditProjection({
        control: context.control,
        response: context.response,
        reevaluation: context.reevaluation,
        ticket: receipt.ticket,
        now: decidedAt,
      });
      this.#commitProjectionAudit(context.sessionId, projection, decidedAt);
      context.receipt = receipt;
      context.terminalTicket = receipt.ticket;
      context.projection = projection;
      return {
        outcome: "allowed-once",
        ticket: receipt.ticket,
        projection,
        receiptId: receipt.receiptId,
      };
    }

    const requestedDeny = decision?.requestId === ticketId &&
      decision.choice === "deny-once";
    const timedOut = isHostApprovalTimeoutDecision(decision);
    const hostRejected = isHostApprovalRejectedDecision(decision);
    const denied = !timedOut && !hostRejected && requestedDeny;
    const terminal = timedOut
      ? this.#ticketStore.modalTimeout(expectation, decidedAt)
      : denied
        ? this.#ticketStore.deny(expectation, decidedAt)
        : this.#ticketStore.cancel(expectation, decidedAt);
    if (!terminal) return null;
    const projection = createRationaleUiAuditProjection({
      control: context.control,
      response: context.response,
      reevaluation: context.reevaluation,
      ticket: terminal.ticket,
      now: decidedAt,
    });
    this.#commitProjectionAudit(context.sessionId, projection, decidedAt);
    this.#contexts.delete(ticketId);
    return {
      outcome: timedOut ? "timed-out" : denied ? "denied" : "cancelled",
      ticket: terminal.ticket,
      projection,
    };
  }
  async createSealedResume(
    input: CreateRationaleSealedResumeInput,
  ): Promise<RationaleSealedResumeResolution | null> {
    const startedAt = input.now ?? this.#now();
    if (!this.#isCoordinatorCurrent()) {
      this.#contexts.delete(input.ticketId);
      return null;
    }
    const context = this.#contexts.get(input.ticketId);
    if (
      !context ||
      context.resumeIssued ||
      context.receipt === null ||
      context.terminalTicket === null ||
      !Number.isFinite(startedAt) ||
      !this.#ticketStore.isAuthenticConsumedAllowOnceReceipt(
        context.receipt,
        startedAt,
      )
    ) {
      return null;
    }
    context.resumeIssued = true;
    try {
      const settledAt = input.now ?? this.#now();
      const currentActionIdentity = this.recomputeSealedActionIdentity(
        context.control,
        settledAt,
      );
      if (
        this.#contexts.get(input.ticketId) !== context ||
        !this.#ticketStore.isAuthenticConsumedAllowOnceReceipt(
          context.receipt,
          settledAt,
        )
      ) {
        this.#contexts.delete(input.ticketId);
        return null;
      }
      const status = context.terminalTicket.rationaleStatus;
      if (status !== "ready" && status !== "failed") {
        this.#contexts.delete(input.ticketId);
        return null;
      }
      const resumeRequest = createContractSealedRationaleResumeRequest({
        control: context.control,
        response: context.response,
        rationaleStatus: status,
        reevaluation: context.reevaluation,
        ticket: context.terminalTicket,
        currentActionIdentity,
        currentEligibilityContext: input.currentEligibilityContext,
        hostConsumedAllowOnceReceipt: context.receipt,
        now: settledAt,
      });
      context.issuedResumeRequest = resumeRequest;
      return {
        resumeRequest,
        hostConsumedAllowOnceReceipt: context.receipt,
      };
    } catch {
      this.#contexts.delete(input.ticketId);
      return null;
    }
  }
  abort(ticketId: string, now = this.#now()): RationaleTicketStateRecord | null {
    let context = this.#contexts.get(ticketId);
    if (context) {
      this.#contexts.delete(ticketId);
      this.#retiringContexts.set(ticketId, context);
    } else {
      context = this.#retiringContexts.get(ticketId);
    }
    if (!context) return null;
    const errors: unknown[] = [];
    try {
      this.#approvalGate.cancelPendingRationale(ticketId, "caller-abort");
    } catch (error) {
      errors.push(error);
    }
    let result: RationaleTicketStateRecord | null =
      context.receipt?.ticket ?? context.terminalTicket;
    let ticketRetired = context.receipt !== null;
    if (!ticketRetired) {
      try {
        if (!this.#ticketStore.activeTicketIds(context.sessionId, now).includes(ticketId)) {
          ticketRetired = true;
        } else {
          const terminal = this.#ticketStore.abort(
            createRationaleTicketCasExpectation(context.snapshot),
            now,
          );
          if (terminal) {
            context.terminalTicket = terminal.ticket;
            result = terminal.ticket;
            ticketRetired = true;
          } else if (!this.#ticketStore.activeTicketIds(context.sessionId, now).includes(ticketId)) {
            ticketRetired = true;
          } else {
            errors.push(new Error("rationale abort CAS did not retire the active ticket"));
          }
        }
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "rationale coordinator abort failed");
    }
    if (ticketRetired) this.#retiringContexts.delete(ticketId);
    return result;
  }

  closeSession(
    sessionId: string,
    now = this.#now(),
  ): readonly HostRationaleTicketSnapshot[] {
    const retiring: Array<readonly [string, TicketContext]> = [];
    for (const [ticketId, context] of this.#contexts) {
      if (context.sessionId === sessionId) {
        this.#contexts.delete(ticketId);
        this.#retiringContexts.set(ticketId, context);
        retiring.push([ticketId, context]);
      }
    }
    for (const [ticketId, context] of this.#retiringContexts) {
      if (
        context.sessionId === sessionId &&
        !retiring.some(([retiringId]) => retiringId === ticketId)
      ) {
        retiring.push([ticketId, context]);
      }
    }
    const errors: unknown[] = [];
    const cancelledAtGate = new Set<string>();
    for (const [ticketId] of retiring) {
      try {
        this.#approvalGate.cancelPendingRationale(ticketId, "session-close");
        cancelledAtGate.add(ticketId);
      } catch (error) {
        errors.push(error);
      }
    }
    let closed: readonly HostRationaleTicketSnapshot[] = [];
    let storeClosed = false;
    try {
      closed = this.#ticketStore.closeSession(sessionId, now);
      storeClosed = true;
    } catch (error) {
      errors.push(error);
    }
    if (storeClosed) {
      for (const [ticketId, context] of retiring) {
        if (cancelledAtGate.has(ticketId) &&
            this.#retiringContexts.get(ticketId) === context) {
          this.#retiringContexts.delete(ticketId);
        }
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "rationale coordinator session close failed");
    }
    return closed;
  }

  #isCoordinatorCurrent(): boolean {
    try {
      return this.#isCurrent();
    } catch {
      return false;
    }
  }

  #commitProjectionAudit(
    sessionId: string,
    projection: RationaleUiAuditProjection,
    at: number,
  ): void {
    const result = this.#onProjectionAudit(sessionId, projection, at);
    if (
      result !== null &&
      (typeof result === "object" || typeof result === "function") &&
      typeof (result as { then?: unknown }).then === "function"
    ) {
      throw new TypeError("rationale projection audit must complete synchronously");
    }
  }
}
