import { sha256Hex } from "../lib/hex-digest-equal.js";
import { canonicalStringify } from "../shared/canonical-json.js";
import type {
  HostShellExecutionPlan,
  HostShellFallbackReason,
} from "./host-shell-execution-plan.js";
import {
  getIssuedHostShellExecutionPlanGeneration,
  getSandboxGeneration,
  isIssuedHostShellExecutionPlan,
} from "./sandbox-capability.js";
import {
  consumeOperatorContainerRevalidationLease,
  isCurrentPublishedOperatorContainerCapability,
  isIssuedOperatorContainerCapability,
  type OperatorContainerCapability,
  type OperatorContainerRevalidationLease,
} from "./operator-container-attestation.js";
import {
  isIssuedActiveBrokeredWorkloadCapability,
  issueWorkloadToolCorrelationAuthority,
  type BrokeredWorkloadCapability,
} from "../workload/runtime.js";
import type {
  WorkloadToolCorrelationAuthority,
  WorkloadToolCorrelationProjection,
} from "../workload/runtime.js";
import type { WorkloadToolOperation } from "../workload/runtime.js";
import { assertValidToolUseId } from "../shared/tool-use-id.js";
import { isValidToolName } from "../tools/types.js";

const EXECUTION_ROUTER_VERSION = "execution-router/v1" as const;
const EFFECT_ENVELOPE_VERSION = "effect-envelope/v1" as const;
const EXECUTION_CAPABILITY_VERSION = "execution-capability/v1" as const;
const EXECUTION_GRANT_VERSION = "execution-grant/v1" as const;

/** Route names describe execution substrates, not permission decisions. */
export type ExecutionRoute =
  | "workspace-sandbox"
  | "disposable-container"
  | "host";

export type DisposablePathPolicyRelaxation =
  | "dynamic-path"
  | "recursive-traversal"
  | "sandbox-boundary"
  | "sensitive-path";

type DisposableExecutionAuthority =
  | "operator-container"
  | "workload-broker";

type DisposableExecutionCapabilityProjection = Readonly<
  | {
      kind: "operator-container";
      id: string;
      generation: string;
      expiresAt: number;
    }
  | {
      kind: "workload-broker";
      id: string;
      generation: string;
      boundaryFingerprint: string;
      imageDigest: string;
      cwd: string;
      home: string;
      platform: "linux";
      expiresAt: string;
    }
>;

export type AnalysisUncertainRequirement = Readonly<{
  classification: "analysis-uncertain";
  source: "shell-path-policy";
  kind: "dynamic-path" | "recursive-traversal";
}>;

export interface ExecutionRuntimeLimits {
  readonly timeoutSeconds: number;
  readonly background: boolean;
}

/**
 * Host-normalized effect identity. The raw request is hashed and discarded so
 * route/audit metadata never becomes a second command or secret-bearing log.
 */
export interface EffectEnvelope {
  readonly version: typeof EFFECT_ENVELOPE_VERSION;
  readonly digest: string;
  readonly requestDigest: string;
  readonly cwd: string;
  readonly unresolvedRequirements: readonly AnalysisUncertainRequirement[];
  readonly runtimeLimits: Readonly<ExecutionRuntimeLimits>;
}

/** Availability is host-issued and generation-bound; it grants no authority. */
export interface ExecutionCapability {
  readonly version: typeof EXECUTION_CAPABILITY_VERSION;
  readonly identity: string;
  readonly generation: string;
  readonly availableRoutes: readonly ExecutionRoute[];
  readonly disposableCapability: DisposableExecutionCapabilityProjection | null;
}

type ExecutionDecision =
  | "selected"
  | "approval-required"
  | "analysis-required"
  | "blocked";

type ExecutionFallback =
  | HostShellFallbackReason
  | "analysis-uncertain"
  | "route-unavailable";

/**
 * Immutable route decision. `selected` still means only that a substrate was
 * chosen; the existing permission stack remains the authority in this slice.
 */
export interface ExecutionPlan {
  readonly version: typeof EXECUTION_ROUTER_VERSION;
  readonly identity: string;
  readonly legacyPlanIdentity: string;
  readonly effectDigest: string;
  readonly cwd: string;
  readonly unresolvedRequirements: readonly AnalysisUncertainRequirement[];
  readonly runtimeLimits: Readonly<ExecutionRuntimeLimits>;
  readonly capabilityIdentity: string;
  readonly capabilityGeneration: string;
  readonly disposableCapability: ExecutionCapability["disposableCapability"];
  readonly decision: ExecutionDecision;
  readonly route: ExecutionRoute | null;
  readonly fallback: ExecutionFallback;
}

/** Public-safe, serializable receipt for the route decision. */
export interface ExecutionPlanAuditProjection {
  readonly version: typeof EXECUTION_ROUTER_VERSION;
  readonly identity: string;
  readonly legacyPlanIdentity: string;
  readonly effectDigest: string;
  readonly cwd: string;
  readonly unresolvedRequirements: readonly AnalysisUncertainRequirement[];
  readonly runtimeLimits: Readonly<ExecutionRuntimeLimits>;
  readonly capabilityIdentity: string;
  readonly capabilityGeneration: string;
  readonly disposableCapability: ExecutionCapability["disposableCapability"];
  readonly decision: ExecutionDecision;
  readonly route: ExecutionRoute | null;
  readonly fallback: ExecutionFallback;
}

/** Immutable one-shot execution authority for a fully selected route. */
export interface ShellExecutionGrant {
  readonly version: typeof EXECUTION_GRANT_VERSION;
  readonly action: "shell";
  readonly toolUseId: string;
  readonly toolName: "bash" | "powershell";
  readonly brokerOperation: "shell.run" | "shell.start";
  readonly identity: string;
  readonly planIdentity: string;
  readonly effectDigest: string;
  readonly capabilityGeneration: string;
  readonly disposableAuthority: DisposableExecutionAuthority | null;
  readonly disposableCapabilityGeneration: string | null;
  readonly route: ExecutionRoute;
  readonly pathPolicyRelaxations: readonly DisposablePathPolicyRelaxation[];
}

export interface BrokeredToolExecutionGrant {
  readonly version: typeof EXECUTION_GRANT_VERSION;
  readonly action: "builtin-tool";
  readonly toolUseId: string;
  readonly toolName: string;
  readonly brokerOperation: WorkloadToolOperation;
  readonly identity: string;
  readonly effectDigest: string;
  readonly capabilityGeneration: string;
  readonly disposableAuthority: "workload-broker";
  readonly disposableCapabilityGeneration: string;
  readonly route: "disposable-container";
  readonly pathPolicyRelaxations: readonly DisposablePathPolicyRelaxation[];
}

export type ExecutionGrant = ShellExecutionGrant | BrokeredToolExecutionGrant;

export function getExecutionGrantCorrelationAuthority(
  grant: ExecutionGrant,
): WorkloadToolCorrelationProjection | undefined {
  if (!issuedGrants.has(grant) || grant.disposableAuthority !== "workload-broker") {
    return undefined;
  }
  return Object.freeze({
    toolUseId: grant.toolUseId,
    toolName: grant.toolName,
    operation: grant.brokerOperation,
    grant: Object.freeze({
      identity: grant.identity,
      effectDigest: grant.effectDigest,
      action: grant.action,
      planIdentity: grant.action === "shell" ? grant.planIdentity : null,
    }),
  });
}

export interface ConsumedExecutionGrant {
  readonly route: ExecutionRoute;
  readonly disposableAuthority: DisposableExecutionAuthority | null;
  readonly brokeredWorkloadCapability?: BrokeredWorkloadCapability;
  readonly workloadCorrelationAuthority?: WorkloadToolCorrelationAuthority;
  readonly pathPolicyRelaxations: readonly DisposablePathPolicyRelaxation[];
}

const ROUTE_ORDER: readonly ExecutionRoute[] = Object.freeze([
  "workspace-sandbox",
  "disposable-container",
  "host",
]);
const DISPOSABLE_PATH_POLICY_RELAXATIONS: readonly DisposablePathPolicyRelaxation[] =
  Object.freeze(["dynamic-path", "recursive-traversal", "sandbox-boundary"]);
const BROKERED_WORKLOAD_PATH_POLICY_RELAXATIONS: readonly DisposablePathPolicyRelaxation[] =
  Object.freeze(["dynamic-path", "recursive-traversal", "sandbox-boundary", "sensitive-path"]);
const NO_PATH_POLICY_RELAXATIONS: readonly DisposablePathPolicyRelaxation[] = Object.freeze([]);
const issuedEffects = new WeakSet<EffectEnvelope>();
const issuedCapabilities = new WeakSet<ExecutionCapability>();
const issuedPlans = new WeakSet<ExecutionPlan>();
const issuedGrants = new WeakSet<ExecutionGrant>();
const consumedGrants = new WeakSet<ExecutionGrant>();
const auditProjections = new WeakMap<ExecutionPlan, ExecutionPlanAuditProjection>();
const executionCapabilityStates = new WeakMap<ExecutionCapability, Readonly<{
  disposableAuthority?: DisposableAuthorityState;
}>>();
const executionPlanStates = new WeakMap<ExecutionPlan, Readonly<{
  capability: ExecutionCapability;
  disposableAuthority?: DisposableAuthorityState;
}>>();
const executionGrantPlans = new WeakMap<ShellExecutionGrant, ExecutionPlan>();
const brokeredToolGrantStates = new WeakMap<BrokeredToolExecutionGrant, Readonly<{
  capability: BrokeredWorkloadCapability;
  toolName: string;
  cwd: string;
}>>();

type DisposableAuthorityState = Readonly<
  | {
      kind: "operator-container";
      capability: OperatorContainerCapability;
      revalidationLease?: OperatorContainerRevalidationLease;
    }
  | { kind: "workload-broker"; capability: BrokeredWorkloadCapability }
>;

function freezeRequirements(
  requirements: readonly AnalysisUncertainRequirement[],
): readonly AnalysisUncertainRequirement[] {
  return Object.freeze(requirements.map((requirement) => Object.freeze({ ...requirement })));
}

function freezeLimits(limits: ExecutionRuntimeLimits): Readonly<ExecutionRuntimeLimits> {
  // Match the existing shell parser exactly: retries may deliberately carry a
  // very large positive integer and this observational layer must not narrow it.
  if (!Number.isInteger(limits.timeoutSeconds) || limits.timeoutSeconds < 1) {
    throw new Error("Execution runtime timeout must be a positive integer");
  }
  return Object.freeze({
    timeoutSeconds: limits.timeoutSeconds,
    background: limits.background,
  });
}

export function issueEffectEnvelope(input: {
  /** Host-private normalized request; only its digest survives. */
  request: unknown;
  cwd: string;
  unresolvedRequirements?: readonly AnalysisUncertainRequirement[];
  runtimeLimits: ExecutionRuntimeLimits;
}): EffectEnvelope {
  if (typeof input.cwd !== "string" || input.cwd.length === 0) {
    throw new Error("Execution effect cwd must be non-empty");
  }
  const requestDigest = sha256Hex(canonicalStringify(input.request));
  const unresolvedRequirements = freezeRequirements(input.unresolvedRequirements ?? []);
  const runtimeLimits = freezeLimits(input.runtimeLimits);
  const digest = sha256Hex(canonicalStringify({
    cwd: input.cwd,
    requestDigest,
    runtimeLimits,
    unresolvedRequirements,
    version: EFFECT_ENVELOPE_VERSION,
  }));
  const envelope: EffectEnvelope = Object.freeze({
    version: EFFECT_ENVELOPE_VERSION,
    digest,
    requestDigest,
    cwd: input.cwd,
    unresolvedRequirements,
    runtimeLimits,
  });
  issuedEffects.add(envelope);
  return envelope;
}

export function issueExecutionCapability(input: {
  generation: string;
  availableRoutes: readonly ExecutionRoute[];
  disposableCapability?: OperatorContainerCapability;
  disposableRevalidationLease?: OperatorContainerRevalidationLease;
  brokeredWorkloadCapability?: BrokeredWorkloadCapability;
}): ExecutionCapability {
  if (typeof input.generation !== "string" || input.generation.length === 0) {
    throw new Error("Execution capability generation must be non-empty");
  }
  const requested = new Set(input.availableRoutes);
  if (requested.size !== input.availableRoutes.length ||
      input.availableRoutes.some((route) => !ROUTE_ORDER.includes(route))) {
    throw new Error("Execution capability routes must be unique known routes");
  }
  const disposableInputs = Number(input.disposableCapability !== undefined) +
    Number(input.brokeredWorkloadCapability !== undefined);
  const requestsDisposable = requested.has("disposable-container");
  if (requestsDisposable !== (disposableInputs === 1)) {
    throw new Error("Disposable execution route requires exactly one live substrate capability");
  }
  if (
    input.disposableCapability !== undefined &&
    (!isIssuedOperatorContainerCapability(input.disposableCapability) ||
      !isCurrentPublishedOperatorContainerCapability(input.disposableCapability))
  ) {
    throw new Error("Disposable execution capability is not current host authority");
  }
  if (input.disposableCapability === undefined && input.disposableRevalidationLease !== undefined) {
    throw new Error("Disposable revalidation lease requires its operator capability");
  }
  if (
    input.brokeredWorkloadCapability !== undefined &&
    !isIssuedActiveBrokeredWorkloadCapability(input.brokeredWorkloadCapability)
  ) {
    throw new Error("Brokered workload execution capability is not current host authority");
  }
  const availableRoutes = Object.freeze(
    ROUTE_ORDER.filter((route) => requested.has(route)),
  );
  const disposableCapability: DisposableExecutionCapabilityProjection | null =
    input.disposableCapability !== undefined
      ? Object.freeze({
          kind: "operator-container" as const,
          id: input.disposableCapability.id,
          generation: input.disposableCapability.generation,
          expiresAt: input.disposableCapability.expiresAt,
        })
      : input.brokeredWorkloadCapability !== undefined
        ? Object.freeze({
            kind: "workload-broker" as const,
            id: input.brokeredWorkloadCapability.workload.id,
            generation: input.brokeredWorkloadCapability.workload.generation,
            boundaryFingerprint:
              input.brokeredWorkloadCapability.workload.boundaryFingerprint,
            imageDigest: input.brokeredWorkloadCapability.workload.imageDigest,
            cwd: input.brokeredWorkloadCapability.workload.cwd,
            home: input.brokeredWorkloadCapability.workload.home,
            platform: input.brokeredWorkloadCapability.workload.platform,
            expiresAt: input.brokeredWorkloadCapability.expiresAt,
          })
        : null;
  const identity = sha256Hex(canonicalStringify({
    availableRoutes,
    disposableCapability,
    generation: input.generation,
    version: EXECUTION_CAPABILITY_VERSION,
  }));
  const capability: ExecutionCapability = Object.freeze({
    version: EXECUTION_CAPABILITY_VERSION,
    identity,
    generation: input.generation,
    availableRoutes,
    disposableCapability,
  });
  issuedCapabilities.add(capability);
  executionCapabilityStates.set(capability, Object.freeze({
    ...(input.disposableCapability !== undefined
      ? {
          disposableAuthority: Object.freeze({
            kind: "operator-container" as const,
            capability: input.disposableCapability,
            ...(input.disposableRevalidationLease === undefined
              ? {}
              : { revalidationLease: input.disposableRevalidationLease }),
          }),
        }
      : input.brokeredWorkloadCapability !== undefined
        ? {
            disposableAuthority: Object.freeze({
              kind: "workload-broker" as const,
              capability: input.brokeredWorkloadCapability,
            }),
          }
        : {}),
  }));
  return capability;
}

/** Pure compatibility mapping for the current host-shell substrate contract. */
export function executionRouteForHostShellPlan(
  plan: Pick<HostShellExecutionPlan, "mode" | "capability">,
): ExecutionRoute | null {
  if (
    plan.mode === "asrt" &&
    plan.capability.kind === "asrt" &&
    plan.capability.confines?.filesystem === true &&
    plan.capability.confines.process === true
  ) {
    return "workspace-sandbox";
  }
  if (plan.mode === "plain") return "host";
  return null;
}

function assertIssuedInputs(
  effect: EffectEnvelope,
  capability: ExecutionCapability,
): void {
  if (!issuedEffects.has(effect)) throw new Error("Execution effect was not issued by the host");
  if (!issuedCapabilities.has(capability)) {
    throw new Error("Execution capability was not issued by the host");
  }
}

export function buildExecutionPlan(input: {
  legacyPlan: HostShellExecutionPlan;
  effect: EffectEnvelope;
  capability: ExecutionCapability;
}): ExecutionPlan {
  if (!isIssuedHostShellExecutionPlan(input.legacyPlan)) {
    throw new Error("Legacy shell execution plan was not issued by the host");
  }
  assertIssuedInputs(input.effect, input.capability);
  const legacyGeneration = getIssuedHostShellExecutionPlanGeneration(input.legacyPlan);
  if (legacyGeneration === undefined) {
    throw new Error("Legacy shell execution plan has no issuance generation");
  }
  if (input.capability.generation !== legacyGeneration) {
    throw new Error("Execution capability generation does not match the legacy plan snapshot");
  }
  const legacyCandidate = executionRouteForHostShellPlan(input.legacyPlan);
  const capabilityState = executionCapabilityStates.get(input.capability);
  if (!capabilityState) throw new Error("Execution capability state is unavailable");
  const brokerExclusive = capabilityState.disposableAuthority?.kind === "workload-broker";
  const workspaceAvailable = !brokerExclusive && legacyCandidate === "workspace-sandbox" &&
    input.capability.availableRoutes.includes("workspace-sandbox");
  const disposableAvailable = input.capability.availableRoutes.includes("disposable-container") &&
    capabilityState.disposableAuthority !== undefined;
  const hostAvailable = !brokerExclusive && legacyCandidate === "host" &&
    input.capability.availableRoutes.includes("host");
  let route: ExecutionRoute | null = workspaceAvailable
    ? "workspace-sandbox"
    : disposableAvailable
      ? "disposable-container"
      : hostAvailable
        ? "host"
        : null;
  let decision: ExecutionDecision;
  let fallback: ExecutionFallback = input.legacyPlan.fallbackReason;

  if (route === null) {
    decision = "blocked";
    if (input.legacyPlan.mode === "asrt") fallback = "route-unavailable";
  } else if (
    route === "host" &&
    input.effect.unresolvedRequirements.length > 0 &&
    input.legacyPlan.executionRequest !== "host"
  ) {
    // An uncertain effect may be re-analysed, isolated in a future container,
    // or explicitly approved. It must never fall through to host by default.
    route = null;
    decision = "analysis-required";
    fallback = "analysis-uncertain";
  } else if (route === "host" && input.legacyPlan.requiresExplicitUserApproval) {
    decision = "approval-required";
  } else {
    decision = "selected";
  }

  const unresolvedRequirements = freezeRequirements(input.effect.unresolvedRequirements);
  const runtimeLimits = freezeLimits(input.effect.runtimeLimits);
  const fields = {
    version: EXECUTION_ROUTER_VERSION,
    legacyPlanIdentity: input.legacyPlan.identity,
    effectDigest: input.effect.digest,
    cwd: input.effect.cwd,
    unresolvedRequirements,
    runtimeLimits,
    capabilityIdentity: input.capability.identity,
    capabilityGeneration: input.capability.generation,
    disposableCapability: input.capability.disposableCapability,
    decision,
    route,
    fallback,
  } as const;
  const identity = sha256Hex(canonicalStringify(fields));
  const plan: ExecutionPlan = Object.freeze({ ...fields, identity });
  issuedPlans.add(plan);
  executionPlanStates.set(plan, Object.freeze({
    capability: input.capability,
    ...(capabilityState.disposableAuthority === undefined
      ? {}
      : { disposableAuthority: capabilityState.disposableAuthority }),
  }));
  return plan;
}

export function buildHostShellExecutionRoute(input: {
  legacyPlan: HostShellExecutionPlan;
  toolName: "bash" | "powershell";
  command: string;
  cwd: string;
  timeoutSeconds: number;
  background: boolean;
  unresolvedRequirementKind?: AnalysisUncertainRequirement["kind"];
  disposableCapability?: OperatorContainerCapability;
  disposableRevalidationLease?: OperatorContainerRevalidationLease;
  brokeredWorkloadCapability?: BrokeredWorkloadCapability;
}): Readonly<{ plan: ExecutionPlan; audit: ExecutionPlanAuditProjection }> {
  if (input.brokeredWorkloadCapability !== undefined && input.toolName !== "bash") {
    throw new Error("Brokered workload execution supports only the canonical bash tool");
  }
  const capabilityGeneration = getIssuedHostShellExecutionPlanGeneration(input.legacyPlan);
  if (capabilityGeneration === undefined) {
    throw new Error("Legacy shell execution plan has no issuance generation");
  }
  const legacyRoute = executionRouteForHostShellPlan(input.legacyPlan);
  const effect = issueEffectEnvelope({
    request: {
      tool: input.toolName,
      command: input.command,
      executionMode: input.legacyPlan.executionRequest,
    },
    cwd: input.cwd,
    unresolvedRequirements: input.unresolvedRequirementKind === undefined ? [] : [{
      classification: "analysis-uncertain",
      source: "shell-path-policy",
      kind: input.unresolvedRequirementKind,
    }],
    runtimeLimits: {
      timeoutSeconds: input.timeoutSeconds,
      background: input.background,
    },
  });
  const availableRoutes: ExecutionRoute[] = [];
  if (input.brokeredWorkloadCapability !== undefined) {
    // A configured workload broker is an exclusive task substrate. Advertising
    // a local route here would turn a broker outage into host execution.
    availableRoutes.push("disposable-container");
  } else {
    if (legacyRoute === "workspace-sandbox") availableRoutes.push("workspace-sandbox");
    if (input.disposableCapability !== undefined) availableRoutes.push("disposable-container");
    if (legacyRoute === "host") availableRoutes.push("host");
  }
  const capability = issueExecutionCapability({
    generation: capabilityGeneration,
    availableRoutes,
    ...(input.disposableCapability === undefined
      ? {}
      : { disposableCapability: input.disposableCapability }),
    ...(input.disposableRevalidationLease === undefined
      ? {}
      : { disposableRevalidationLease: input.disposableRevalidationLease }),
    ...(input.brokeredWorkloadCapability === undefined
      ? {}
      : { brokeredWorkloadCapability: input.brokeredWorkloadCapability }),
  });
  const plan = buildExecutionPlan({ legacyPlan: input.legacyPlan, effect, capability });
  return Object.freeze({ plan, audit: getExecutionPlanAuditProjection(plan) });
}

/** Current host-shell adapter; kept here so callers do not duplicate mapping. */
export function buildHostShellExecutionRouteProjection(input: {
  legacyPlan: HostShellExecutionPlan;
  toolName: "bash" | "powershell";
  command: string;
  cwd: string;
  timeoutSeconds: number;
  background: boolean;
  unresolvedRequirementKind?: AnalysisUncertainRequirement["kind"];
}): ExecutionPlanAuditProjection {
  return buildHostShellExecutionRoute(input).audit;
}

export function getExecutionPlanAuditProjection(
  plan: ExecutionPlan,
): ExecutionPlanAuditProjection {
  if (!issuedPlans.has(plan)) throw new Error("Execution plan was not issued by the host");
  const existing = auditProjections.get(plan);
  if (existing) return existing;
  const projection: ExecutionPlanAuditProjection = Object.freeze({
    version: plan.version,
    identity: plan.identity,
    legacyPlanIdentity: plan.legacyPlanIdentity,
    effectDigest: plan.effectDigest,
    cwd: plan.cwd,
    unresolvedRequirements: freezeRequirements(plan.unresolvedRequirements),
    runtimeLimits: freezeLimits(plan.runtimeLimits),
    capabilityIdentity: plan.capabilityIdentity,
    capabilityGeneration: plan.capabilityGeneration,
    disposableCapability: plan.disposableCapability,
    decision: plan.decision,
    route: plan.route,
    fallback: plan.fallback,
  });
  auditProjections.set(plan, projection);
  return projection;
}

function isCurrentDisposableAuthority(authority: DisposableAuthorityState): boolean {
  return authority.kind === "operator-container"
    ? isCurrentPublishedOperatorContainerCapability(authority.capability)
    : isIssuedActiveBrokeredWorkloadCapability(authority.capability);
}

function disposableAuthorityGeneration(authority: DisposableAuthorityState): string {
  return authority.kind === "operator-container"
    ? authority.capability.generation
    : authority.capability.workload.generation;
}

function relaxationsForAuthority(
  authority: DisposableAuthorityState | undefined,
): readonly DisposablePathPolicyRelaxation[] {
  if (authority?.kind === "workload-broker") {
    return BROKERED_WORKLOAD_PATH_POLICY_RELAXATIONS;
  }
  return authority?.kind === "operator-container"
    ? DISPOSABLE_PATH_POLICY_RELAXATIONS
    : NO_PATH_POLICY_RELAXATIONS;
}

export function issueExecutionGrant(
  plan: ExecutionPlan,
  binding: { readonly toolUseId: string; readonly toolName: "bash" | "powershell" },
): ShellExecutionGrant {
  if (!issuedPlans.has(plan)) throw new Error("Execution plan was not issued by the host");
  if (plan.capabilityGeneration !== getSandboxGeneration()) {
    throw new Error("Execution capability generation is stale");
  }
  if (plan.decision !== "selected" || plan.route === null) {
    throw new Error("Execution plan requires another decision before a grant can be issued");
  }
  assertValidToolUseId(binding.toolUseId, "execution grant tool use ID");
  const planState = executionPlanStates.get(plan);
  if (!planState) throw new Error("Execution plan state is unavailable");
  if (
    plan.route === "disposable-container" &&
    (planState.disposableAuthority === undefined ||
      !isCurrentDisposableAuthority(planState.disposableAuthority))
  ) {
    throw new Error("Disposable execution capability is stale");
  }
  const disposableAuthority = planState.disposableAuthority;
  if (plan.route === "disposable-container" &&
      disposableAuthority?.kind === "operator-container" &&
      (disposableAuthority.revalidationLease === undefined ||
        !consumeOperatorContainerRevalidationLease(
          disposableAuthority.capability,
          disposableAuthority.revalidationLease,
        ))) {
    throw new Error("Disposable execution capability has no fresh revalidation lease");
  }
  const fields = {
    version: EXECUTION_GRANT_VERSION,
    action: "shell" as const,
    toolUseId: binding.toolUseId,
    toolName: binding.toolName,
    brokerOperation: plan.runtimeLimits.background ? "shell.start" as const : "shell.run" as const,
    planIdentity: plan.identity,
    effectDigest: plan.effectDigest,
    capabilityGeneration: plan.capabilityGeneration,
    disposableAuthority: disposableAuthority?.kind ?? null,
    disposableCapabilityGeneration:
      disposableAuthority === undefined
        ? null
        : disposableAuthorityGeneration(disposableAuthority),
    route: plan.route,
    pathPolicyRelaxations: plan.route === "disposable-container"
      ? relaxationsForAuthority(disposableAuthority)
      : NO_PATH_POLICY_RELAXATIONS,
  } as const;
  const grant: ShellExecutionGrant = Object.freeze({
    ...fields,
    identity: sha256Hex(canonicalStringify(fields)),
  });
  issuedGrants.add(grant);
  executionGrantPlans.set(grant, plan);
  return grant;
}

/**
 * Consume a host-issued route proof for the exact shell action. A structural
 * lookalike, replay, changed request, stale sandbox snapshot, or replaced
 * operator capability returns no route and therefore cannot relax policy.
 */
export function consumeExecutionGrantForShellInvocation(input: {
  grant: ExecutionGrant | undefined;
  legacyPlan: HostShellExecutionPlan;
  toolName: "bash" | "powershell";
  command: string;
  cwd: string;
  timeoutSeconds: number;
  background: boolean;
}): ConsumedExecutionGrant | null {
  const { grant } = input;
  if (
    grant === undefined ||
    grant.action !== "shell" ||
    !issuedGrants.has(grant) ||
    consumedGrants.has(grant)
  ) {
    return null;
  }
  if (!isIssuedHostShellExecutionPlan(input.legacyPlan)) return null;
  const plan = executionGrantPlans.get(grant);
  const planState = plan === undefined ? undefined : executionPlanStates.get(plan);
  if (
    plan === undefined ||
    planState === undefined ||
    plan.legacyPlanIdentity !== input.legacyPlan.identity ||
    plan.capabilityGeneration !== getSandboxGeneration() ||
    grant.capabilityGeneration !== plan.capabilityGeneration ||
    grant.route !== plan.route ||
    grant.effectDigest !== plan.effectDigest ||
    grant.pathPolicyRelaxations !== (
      grant.route === "disposable-container"
        ? relaxationsForAuthority(planState.disposableAuthority)
        : NO_PATH_POLICY_RELAXATIONS
    )
  ) {
    return null;
  }
  const effect = issueEffectEnvelope({
    request: {
      tool: input.toolName,
      command: input.command,
      executionMode: input.legacyPlan.executionRequest,
    },
    cwd: input.cwd,
    unresolvedRequirements: plan.unresolvedRequirements,
    runtimeLimits: {
      timeoutSeconds: input.timeoutSeconds,
      background: input.background,
    },
  });
  if (effect.digest !== plan.effectDigest) return null;
  if (
    grant.route === "disposable-container" &&
    (planState.disposableAuthority === undefined ||
      grant.disposableAuthority !== planState.disposableAuthority.kind ||
      grant.disposableCapabilityGeneration !==
        disposableAuthorityGeneration(planState.disposableAuthority) ||
      !isCurrentDisposableAuthority(planState.disposableAuthority))
  ) {
    return null;
  }
  consumedGrants.add(grant);
  return Object.freeze({
    route: grant.route,
    disposableAuthority: grant.disposableAuthority,
    ...(planState.disposableAuthority?.kind === "workload-broker"
      ? {
          brokeredWorkloadCapability: planState.disposableAuthority.capability,
          workloadCorrelationAuthority: issueWorkloadToolCorrelationAuthority({
            toolUseId: grant.toolUseId,
            toolName: grant.toolName,
            operation: grant.brokerOperation,
            grant: Object.freeze({
              identity: grant.identity,
              effectDigest: grant.effectDigest,
              action: grant.action,
              planIdentity: grant.planIdentity,
            }),
          }),
        }
      : {}),
    pathPolicyRelaxations: grant.pathPolicyRelaxations,
  });
}

function brokeredToolEffectDigest(input: {
  capability: BrokeredWorkloadCapability;
  toolName: string;
  normalizedInput: unknown;
  cwd: string;
}): string {
  return sha256Hex(canonicalStringify({
    action: "builtin-tool",
    cwd: input.cwd,
    input: input.normalizedInput,
    tool: input.toolName,
    workload: {
      id: input.capability.workload.id,
      generation: input.capability.workload.generation,
      boundaryFingerprint: input.capability.workload.boundaryFingerprint,
      imageDigest: input.capability.workload.imageDigest,
      cwd: input.capability.workload.cwd,
      home: input.capability.workload.home,
      platform: input.capability.workload.platform,
    },
  }));
}

function brokerOperationForBuiltinTool(toolName: string): WorkloadToolOperation {
  const operations: Readonly<Record<string, WorkloadToolOperation>> = {
    bash_output: "shell.read",
    bash_kill: "shell.kill",
    read_file: "file.read",
    view_image: "file.read_binary",
    list_files: "file.list",
    glob_files: "file.glob",
    grep_files: "file.grep",
    write_file: "file.write",
    edit_file: "file.edit",
    apply_patch: "file.patch",
    move_file: "file.move",
    copy_path: "file.copy",
    extract_archive: "file.extract",
    delete_file: "file.delete",
  };
  const operation = operations[toolName];
  if (operation === undefined) throw new Error("Brokered workload tool has no broker operation");
  return operation;
}

/**
 * Mint a one-shot route proof for a canonical builtin whose implementation
 * will execute through the workload broker. The caller must have completed a
 * fresh handshake immediately before this synchronous issuance step.
 */
export function issueBrokeredToolExecutionGrant(input: {
  capability: BrokeredWorkloadCapability;
  toolName: string;
  normalizedInput: unknown;
  cwd: string;
  toolUseId: string;
}): BrokeredToolExecutionGrant {
  if (!isIssuedActiveBrokeredWorkloadCapability(input.capability)) {
    throw new Error("Brokered workload execution capability is stale");
  }
  if (typeof input.toolName !== "string" || input.toolName.length === 0) {
    throw new Error("Brokered workload tool name must be non-empty");
  }
  if (!isValidToolName(input.toolName) || Buffer.byteLength(input.toolName, "utf8") > 128) {
    throw new Error("Brokered workload tool name is invalid");
  }
  assertValidToolUseId(input.toolUseId, "brokered workload tool use ID");
  if (typeof input.cwd !== "string" || input.cwd.length === 0) {
    throw new Error("Brokered workload cwd must be non-empty");
  }
  const effectDigest = brokeredToolEffectDigest(input);
  const brokerOperation = brokerOperationForBuiltinTool(input.toolName);
  const fields = {
    version: EXECUTION_GRANT_VERSION,
    action: "builtin-tool" as const,
    toolUseId: input.toolUseId,
    toolName: input.toolName,
    brokerOperation,
    effectDigest,
    capabilityGeneration: getSandboxGeneration(),
    disposableAuthority: "workload-broker" as const,
    disposableCapabilityGeneration: input.capability.workload.generation,
    route: "disposable-container" as const,
    pathPolicyRelaxations: BROKERED_WORKLOAD_PATH_POLICY_RELAXATIONS,
  };
  const grant: BrokeredToolExecutionGrant = Object.freeze({
    ...fields,
    identity: sha256Hex(canonicalStringify(fields)),
  });
  issuedGrants.add(grant);
  brokeredToolGrantStates.set(grant, Object.freeze({
    capability: input.capability,
    toolName: input.toolName,
    cwd: input.cwd,
  }));
  return grant;
}

/** Consume an exact, current broker proof once. Failure never implies local execution. */
export function consumeExecutionGrantForBuiltinToolInvocation(input: {
  grant: ExecutionGrant | undefined;
  toolName: string;
  normalizedInput: unknown;
  cwd: string;
}): ConsumedExecutionGrant | null {
  const { grant } = input;
  if (
    grant === undefined ||
    grant.action !== "builtin-tool" ||
    !issuedGrants.has(grant) ||
    consumedGrants.has(grant)
  ) {
    return null;
  }
  const state = brokeredToolGrantStates.get(grant);
  if (
    state === undefined ||
    state.toolName !== input.toolName ||
    state.cwd !== input.cwd ||
    grant.capabilityGeneration !== getSandboxGeneration() ||
    grant.disposableCapabilityGeneration !== state.capability.workload.generation ||
    grant.effectDigest !== brokeredToolEffectDigest({
      capability: state.capability,
      toolName: input.toolName,
      normalizedInput: input.normalizedInput,
      cwd: input.cwd,
    }) ||
    !isIssuedActiveBrokeredWorkloadCapability(state.capability) ||
    grant.pathPolicyRelaxations !== BROKERED_WORKLOAD_PATH_POLICY_RELAXATIONS
  ) {
    return null;
  }
  consumedGrants.add(grant);
  return Object.freeze({
    route: "disposable-container" as const,
    disposableAuthority: "workload-broker" as const,
    brokeredWorkloadCapability: state.capability,
    workloadCorrelationAuthority: issueWorkloadToolCorrelationAuthority({
      toolUseId: grant.toolUseId,
      toolName: grant.toolName,
      operation: grant.brokerOperation,
      grant: Object.freeze({
        identity: grant.identity,
        effectDigest: grant.effectDigest,
        action: grant.action,
        planIdentity: null,
      }),
    }),
    pathPolicyRelaxations: grant.pathPolicyRelaxations,
  });
}

export function disposableGrantRelaxesPathPolicy(
  consumed: ConsumedExecutionGrant | null,
  kind: string,
): kind is DisposablePathPolicyRelaxation {
  return consumed?.route === "disposable-container" &&
    isDisposablePathPolicyRelaxation(kind) &&
    consumed.pathPolicyRelaxations.includes(kind);
}

export function isDisposablePathPolicyRelaxation(
  kind: string,
): kind is DisposablePathPolicyRelaxation {
  return BROKERED_WORKLOAD_PATH_POLICY_RELAXATIONS.includes(
    kind as DisposablePathPolicyRelaxation,
  );
}

export function isIssuedExecutionCapability(value: unknown): value is ExecutionCapability {
  return typeof value === "object" && value !== null &&
    issuedCapabilities.has(value as ExecutionCapability);
}

export function isIssuedExecutionPlan(value: unknown): value is ExecutionPlan {
  return typeof value === "object" && value !== null && issuedPlans.has(value as ExecutionPlan);
}

export function isIssuedExecutionGrant(value: unknown): value is ExecutionGrant {
  return typeof value === "object" && value !== null && issuedGrants.has(value as ExecutionGrant);
}
