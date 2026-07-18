/**
 * Host-owned execution plan for the two builtin shell tools.
 *
 * This deliberately models the execution substrate, not merely the process-wide
 * ASRT capability. On current Windows ASRT, a path-string ACL grant cannot make
 * a one-shot shell filesystem lease reparse-safe. Until upstream exposes a
 * handle-bound/no-follow grant primitive, requested Windows shell work therefore
 * uses an honest plain-host plan and must be explicitly approved per invocation.
 */

import { createHash } from "node:crypto";
import type { SandboxCapability } from "./sandbox-capability.js";
import type { SandboxConfinement } from "../shared/sandbox-capability-info.js";

export const HOST_SHELL_EXECUTION_PLAN_VERSION = "host-shell-execution-plan/v2" as const;

export type HostShellExecutionMode = "asrt" | "plain" | "blocked";

/** Machine-readable, host-owned fallback state. Never derive authority from UI text. */
export type HostShellFallbackReason =
  | "none"
  | "windows-partial-shell-acl-unsafe"
  | "requested-sandbox-unavailable"
  | "active-sandbox-not-shell-contained";

export interface HostShellExecutionPlan {
  readonly version: typeof HOST_SHELL_EXECUTION_PLAN_VERSION;
  readonly platform: NodeJS.Platform;
  /** Boot-sealed settings/env intent; never re-read from renderer settings. */
  readonly requestedSandbox: boolean;
  /** Actual route selected before permission/reviewer processing. */
  readonly mode: HostShellExecutionMode;
  /** Honest capability of the child selected by this plan. */
  readonly capability: SandboxCapability;
  readonly fallbackReason: HostShellFallbackReason;
  /** True only for a requested-sandbox plain-shell fallback requiring one-shot approval. */
  readonly requiresExplicitUserApproval: boolean;
  /** Stable identity for audit/cache consumers; contains no command or raw path. */
  readonly identity: string;
}

/**
 * The allowlist-only, serializable execution-plan view retained in audit data
 * and shell result metadata. It deliberately excludes command arguments,
 * directories, approval bindings, permits, nonces, HMACs, and free-form
 * capability reasons.
 */
export interface HostShellExecutionPlanAuditProjection {
  readonly version: typeof HOST_SHELL_EXECUTION_PLAN_VERSION;
  readonly identity: string;
  readonly platform: NodeJS.Platform;
  readonly requestedSandbox: boolean;
  readonly mode: HostShellExecutionMode;
  readonly fallbackReason: HostShellFallbackReason;
  readonly requiresExplicitUserApproval: boolean;
  readonly capability: Readonly<{
    kind: SandboxCapability["kind"];
    confidence: SandboxCapability["confidence"];
    platform: NodeJS.Platform;
    confines?: Readonly<SandboxConfinement>;
  }>;
}

const auditProjections = new WeakMap<
  HostShellExecutionPlan,
  HostShellExecutionPlanAuditProjection
>();
const issuedAuditProjections = new WeakSet<HostShellExecutionPlanAuditProjection>();

/**
 * Return the single immutable, public-safe projection for an issued plan.
 * A WeakMap keeps the result identity stable through approval, audit, and the
 * native shell result without retaining completed invocation plans.
 */
export function getHostShellExecutionPlanAuditProjection(
  plan: HostShellExecutionPlan,
): HostShellExecutionPlanAuditProjection {
  const existing = auditProjections.get(plan);
  if (existing !== undefined) return existing;

  const confines = plan.capability.confines === undefined
    ? undefined
    : Object.freeze({ ...plan.capability.confines });
  const projection = Object.freeze({
    version: plan.version,
    identity: plan.identity,
    platform: plan.platform,
    requestedSandbox: plan.requestedSandbox,
    mode: plan.mode,
    fallbackReason: plan.fallbackReason,
    requiresExplicitUserApproval: plan.requiresExplicitUserApproval,
    capability: Object.freeze({
      kind: plan.capability.kind,
      confidence: plan.capability.confidence,
      platform: plan.capability.platform,
      ...(confines === undefined ? {} : { confines }),
    }),
  });
  issuedAuditProjections.add(projection);
  auditProjections.set(plan, projection);
  return projection;
}

/**
 * Accept only an allowlist projection issued by this module. Approval payloads
 * remain in-process until IPC serialization, so object identity gives the host
 * a stronger boundary than trusting a structural lookalike with extra fields.
 */
export function isIssuedHostShellExecutionPlanAuditProjection(
  projection: unknown,
): projection is HostShellExecutionPlanAuditProjection {
  return typeof projection === "object" &&
    projection !== null &&
    issuedAuditProjections.has(projection as HostShellExecutionPlanAuditProjection);
}

/**
 * Stable approval/reviewer-cache partition for a host shell execution plan.
 *
 * This deliberately hashes the complete renderer-safe projection instead of
 * relying on {@link HostShellExecutionPlan.identity} alone. In particular, a
 * plain `none` plan can have the same route identity while differing in
 * `requestedSandbox`; an approval or reviewer verdict produced under one must
 * never be replayed under the other.
 */
export function getHostShellExecutionPlanCacheIdentity(
  projection: HostShellExecutionPlanAuditProjection,
): string {
  // Keep this explicit, ordered shape rather than relying on object insertion
  // order. Every authority-relevant projection field participates, including
  // the distinction between an omitted legacy `confines` value and all-false.
  const canonicalProjection = JSON.stringify({
    capability: {
      confidence: projection.capability.confidence,
      confines: projection.capability.confines === undefined
        ? null
        : {
            filesystem: projection.capability.confines.filesystem,
            network: projection.capability.confines.network,
            process: projection.capability.confines.process,
          },
      kind: projection.capability.kind,
      platform: projection.capability.platform,
    },
    fallbackReason: projection.fallbackReason,
    identity: projection.identity,
    mode: projection.mode,
    platform: projection.platform,
    requestedSandbox: projection.requestedSandbox,
    requiresExplicitUserApproval: projection.requiresExplicitUserApproval,
    version: projection.version,
  });
  return "host-shell-execution-plan-cache/v2:" +
    createHash("sha256").update(canonicalProjection).digest("hex");
}

const NO_CONFINEMENT: Readonly<SandboxConfinement> = Object.freeze({
  filesystem: false,
  process: false,
  network: false,
});

function freezeCapability(capability: SandboxCapability): SandboxCapability {
  const confines = capability.confines === undefined
    ? undefined
    : Object.freeze({ ...capability.confines });
  return Object.freeze({
    ...capability,
    ...(confines === undefined ? {} : { confines }),
  });
}

function noneCapability(platform: NodeJS.Platform, reason: string): SandboxCapability {
  return Object.freeze({
    kind: "none" as const,
    confidence: "verified" as const,
    platform,
    reason,
    confines: NO_CONFINEMENT,
  });
}

function hasShellContainment(capability: SandboxCapability): boolean {
  if (capability.kind !== "asrt" || capability.confidence === "assumed") return false;
  // Preserve the legacy full-ASRT contract for fixtures produced before the
  // per-dimension field existed. Real current producers always declare it.
  return capability.confines === undefined ||
    (capability.confines.filesystem === true && capability.confines.process === true);
}

/**
 * Build the immutable plan once per invocation, after final tool category/input
 * are known and before permission routing. It intentionally does not attempt
 * Windows ACL grants or an ASRT wrapper for the Plan-B branch.
 */
export function buildHostShellExecutionPlan(input: {
  platform: NodeJS.Platform;
  requestedSandbox: boolean;
  activeCapability: SandboxCapability;
}): HostShellExecutionPlan {
  const requestedSandbox = input.requestedSandbox || input.activeCapability.kind === "asrt";

  // A requested sandbox that is unavailable yields an honest plain child on
  // every platform. It must carry an opaque, exact-action allow-once permit;
  // explicit sandbox-off remains the normal plain-shell policy path below.
  if (requestedSandbox && input.activeCapability.kind === "none") {
    const fallbackReason: HostShellFallbackReason = "requested-sandbox-unavailable";
    const capability = noneCapability(
      input.platform,
      "The requested OS sandbox is unavailable, so this shell will run without OS isolation until it is restored.",
    );
    return Object.freeze({
      version: HOST_SHELL_EXECUTION_PLAN_VERSION,
      platform: input.platform,
      requestedSandbox,
      mode: "plain" as const,
      capability,
      fallbackReason,
      requiresExplicitUserApproval: true,
      identity: HOST_SHELL_EXECUTION_PLAN_VERSION + ":" + input.platform + ":" + fallbackReason,
    });
  }

  if (input.activeCapability.kind === "asrt" && hasShellContainment(input.activeCapability)) {
    const capability = freezeCapability(input.activeCapability);
    return Object.freeze({
      version: HOST_SHELL_EXECUTION_PLAN_VERSION,
      platform: input.platform,
      requestedSandbox,
      mode: "asrt" as const,
      capability,
      fallbackReason: "none" as const,
      requiresExplicitUserApproval: false,
      identity: HOST_SHELL_EXECUTION_PLAN_VERSION + ":" + input.platform + ":asrt",
    });
  }

  // Windows remains special only when a real ASRT substrate is active but is
  // not shell-contained. The execution authorization itself is generic.
  if (
    input.platform === "win32" &&
    requestedSandbox &&
    input.activeCapability.kind === "asrt"
  ) {
    const fallbackReason: HostShellFallbackReason = "windows-partial-shell-acl-unsafe";
    const capability = noneCapability(
      input.platform,
      "Windows ASRT partial shell confinement is unavailable: the host will not issue path-based ACL grants for one-shot shells.",
    );
    return Object.freeze({
      version: HOST_SHELL_EXECUTION_PLAN_VERSION,
      platform: input.platform,
      requestedSandbox,
      mode: "plain" as const,
      capability,
      fallbackReason,
      requiresExplicitUserApproval: true,
      identity: HOST_SHELL_EXECUTION_PLAN_VERSION + ":" + input.platform + ":" + fallbackReason,
    });
  }

  // Only a full ASRT route and the explicitly modelled Windows ASRT Plan B
  // may execute a requested shell. Future partial substrates (for example
  // `partial` or `fs-only`) must not silently degrade to an ordinary host
  // shell before they receive their own sealed execution contract.
  if (input.activeCapability.kind !== "none") {
    const fallbackReason: HostShellFallbackReason = "active-sandbox-not-shell-contained";
    const capability = noneCapability(
      input.platform,
      "The active OS sandbox does not provide both filesystem and process confinement required for shell execution.",
    );
    return Object.freeze({
      version: HOST_SHELL_EXECUTION_PLAN_VERSION,
      platform: input.platform,
      requestedSandbox,
      mode: "blocked" as const,
      capability,
      fallbackReason,
      requiresExplicitUserApproval: false,
      identity: HOST_SHELL_EXECUTION_PLAN_VERSION + ":" + input.platform + ":" + fallbackReason,
    });
  }

  const capability = noneCapability(
    input.platform,
    "no OS sandbox configured for the host process",
  );
  return Object.freeze({
    version: HOST_SHELL_EXECUTION_PLAN_VERSION,
    platform: input.platform,
    requestedSandbox,
    mode: "plain" as const,
    capability,
    fallbackReason: "none" as const,
    requiresExplicitUserApproval: false,
    identity: HOST_SHELL_EXECUTION_PLAN_VERSION + ":" + input.platform + ":none",
  });
}


/**
 * Host-owned hard gate for any requested sandbox that could not yield an
 * isolated plain shell child. Windows Plan B differs only in why its plan was
 * selected; every such plan needs the same opaque allow-once permit.
 */
export function requiresExplicitHostShellFallbackApproval(plan: HostShellExecutionPlan): boolean {
  return plan.mode === "plain" &&
    plan.requestedSandbox === true &&
    plan.capability.kind === "none" &&
    plan.requiresExplicitUserApproval === true;
}
