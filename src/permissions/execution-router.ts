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

const EXECUTION_ROUTER_VERSION = "execution-router/v1" as const;
const EFFECT_ENVELOPE_VERSION = "effect-envelope/v1" as const;
const EXECUTION_CAPABILITY_VERSION = "execution-capability/v1" as const;
const EXECUTION_GRANT_VERSION = "execution-grant/v1" as const;

/** Route names describe execution substrates, not permission decisions. */
export type ExecutionRoute =
  | "workspace-sandbox"
  | "disposable-container"
  | "host";

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
  readonly decision: ExecutionDecision;
  readonly route: ExecutionRoute | null;
  readonly fallback: ExecutionFallback;
}

/** Public-safe, serializable receipt for the shadow route decision. */
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
  readonly decision: ExecutionDecision;
  readonly route: ExecutionRoute | null;
  readonly fallback: ExecutionFallback;
}

/**
 * Future execution authority. This first slice can mint it only for a plan
 * that needs no additional approval; no current spawn path consumes it.
 */
export interface ExecutionGrant {
  readonly version: typeof EXECUTION_GRANT_VERSION;
  readonly identity: string;
  readonly planIdentity: string;
  readonly effectDigest: string;
  readonly capabilityGeneration: string;
  readonly route: ExecutionRoute;
}

const ROUTE_ORDER: readonly ExecutionRoute[] = Object.freeze([
  "workspace-sandbox",
  "disposable-container",
  "host",
]);
const issuedEffects = new WeakSet<EffectEnvelope>();
const issuedCapabilities = new WeakSet<ExecutionCapability>();
const issuedPlans = new WeakSet<ExecutionPlan>();
const issuedGrants = new WeakSet<ExecutionGrant>();
const auditProjections = new WeakMap<ExecutionPlan, ExecutionPlanAuditProjection>();

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
}): ExecutionCapability {
  if (typeof input.generation !== "string" || input.generation.length === 0) {
    throw new Error("Execution capability generation must be non-empty");
  }
  const requested = new Set(input.availableRoutes);
  if (requested.size !== input.availableRoutes.length ||
      input.availableRoutes.some((route) => !ROUTE_ORDER.includes(route))) {
    throw new Error("Execution capability routes must be unique known routes");
  }
  const availableRoutes = Object.freeze(
    ROUTE_ORDER.filter((route) => requested.has(route)),
  );
  const identity = sha256Hex(canonicalStringify({
    availableRoutes,
    generation: input.generation,
    version: EXECUTION_CAPABILITY_VERSION,
  }));
  const capability: ExecutionCapability = Object.freeze({
    version: EXECUTION_CAPABILITY_VERSION,
    identity,
    generation: input.generation,
    availableRoutes,
  });
  issuedCapabilities.add(capability);
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
  const candidate = executionRouteForHostShellPlan(input.legacyPlan);
  let route: ExecutionRoute | null = candidate;
  let decision: ExecutionDecision;
  let fallback: ExecutionFallback = input.legacyPlan.fallbackReason;

  if (candidate === null) {
    decision = "blocked";
    if (input.legacyPlan.mode === "asrt") fallback = "route-unavailable";
  } else if (!input.capability.availableRoutes.includes(candidate)) {
    route = null;
    decision = "blocked";
    fallback = "route-unavailable";
  } else if (
    candidate === "host" &&
    input.effect.unresolvedRequirements.length > 0 &&
    input.legacyPlan.executionRequest !== "host"
  ) {
    // An uncertain effect may be re-analysed, isolated in a future container,
    // or explicitly approved. It must never fall through to host by default.
    route = null;
    decision = "analysis-required";
    fallback = "analysis-uncertain";
  } else if (input.legacyPlan.requiresExplicitUserApproval) {
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
    decision,
    route,
    fallback,
  } as const;
  const identity = sha256Hex(canonicalStringify(fields));
  const plan: ExecutionPlan = Object.freeze({ ...fields, identity });
  issuedPlans.add(plan);
  return plan;
}

/** Current host-shell adapter; kept here so callers do not duplicate mapping. */
export function buildHostShellExecutionRouteProjection(input: {
  legacyPlan: HostShellExecutionPlan;
  toolName: "bash" | "powershell";
  command: string;
  cwd: string;
  timeoutSeconds: number;
  background: boolean;
  unresolvedRequirements?: readonly AnalysisUncertainRequirement[];
}): ExecutionPlanAuditProjection {
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
    unresolvedRequirements: input.unresolvedRequirements,
    runtimeLimits: {
      timeoutSeconds: input.timeoutSeconds,
      background: input.background,
    },
  });
  const capability = issueExecutionCapability({
    generation: capabilityGeneration,
    availableRoutes: legacyRoute === "workspace-sandbox"
      ? ["workspace-sandbox", "host"]
      : ["host"],
  });
  return getExecutionPlanAuditProjection(buildExecutionPlan({
    legacyPlan: input.legacyPlan,
    effect,
    capability,
  }));
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
    decision: plan.decision,
    route: plan.route,
    fallback: plan.fallback,
  });
  auditProjections.set(plan, projection);
  return projection;
}

export function issueExecutionGrant(plan: ExecutionPlan): ExecutionGrant {
  if (!issuedPlans.has(plan)) throw new Error("Execution plan was not issued by the host");
  if (plan.capabilityGeneration !== getSandboxGeneration()) {
    throw new Error("Execution capability generation is stale");
  }
  if (plan.decision !== "selected" || plan.route === null) {
    throw new Error("Execution plan requires another decision before a grant can be issued");
  }
  const fields = {
    version: EXECUTION_GRANT_VERSION,
    planIdentity: plan.identity,
    effectDigest: plan.effectDigest,
    capabilityGeneration: plan.capabilityGeneration,
    route: plan.route,
  } as const;
  const grant: ExecutionGrant = Object.freeze({
    ...fields,
    identity: sha256Hex(canonicalStringify(fields)),
  });
  issuedGrants.add(grant);
  return grant;
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
