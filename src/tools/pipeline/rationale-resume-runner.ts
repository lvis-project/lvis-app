import { canonicalStringify } from "../../permissions/user-approval-store.js";
import type { PermissionEvaluationContext } from "../../permissions/evaluation-context.js";
import type { PermissionCheckResult } from "../../permissions/permission-manager.js";
import type { SandboxCapability } from "../../permissions/sandbox-capability.js";
import type { ToolCategory, ToolSource, ToolTrustOrigin } from "../types.js";
import {
  RATIONALE_UNKNOWN_SCOPE_SENTINEL,
  cloneRationaleCanonicalJson,
  isRationaleEligible,
  verifyActionIdentity,
  verifyRationaleRequiredControl,
  type ActionIdentity,
  type HostRationaleEligibilityContext,
  type RationaleRequiredControl,
} from "./rationale-control.js";
import {
  createRationaleExecutionAuthorityEntry,
  validateSealedRationaleResumeRequest,
  type RationaleExecutionAuthorityEntry,
  type SealedRationaleResumeRequest,
} from "./rationale-resume-contract.js";
import {
  createAuthorizedInvocationAudit,
  createInvocationAuditEvent,
  transitionInvocationAudit,
  type HostConsumedAllowOnceReceipt,
  type HostInvocationStartCas,
  type InvocationAuditRecord,
} from "./rationale-ticket-lifecycle.js";

export interface RationaleResumeIdentityProbe {
  readonly request: SealedRationaleResumeRequest;
  readonly finalInput: Readonly<Record<string, unknown>>;
  readonly toolName: string;
  readonly toolVersion: string;
  readonly source: ToolSource;
  readonly category: ToolCategory;
  readonly pluginId?: string;
  readonly mcpServerId?: string;
  readonly workerId?: string;
  readonly invocationTrustOrigin: ToolTrustOrigin;
  readonly canonicalTargets: readonly string[];
  readonly allowedDirectories: readonly string[];
  readonly approvalCacheKey?: string;
  readonly sandboxCapability: Readonly<SandboxCapability>;
  readonly sandboxExecutionPlan: Readonly<Record<string, unknown>>;
  readonly permission: PermissionCheckResult;
  readonly permissionEvaluationContext: Readonly<PermissionEvaluationContext>;
  readonly eligibilityContext: Readonly<HostRationaleEligibilityContext>;
}

/** Trusted host seams. Missing seams are deliberately fail-closed. */
export interface RationaleResumeHostRuntime {
  readonly resolveCurrentActionIdentity?: (
    probe: RationaleResumeIdentityProbe,
  ) => Promise<ActionIdentity | null> | ActionIdentity | null;
  readonly loadHostConsumedAllowOnceReceipt?: (
    request: SealedRationaleResumeRequest,
  ) => Promise<HostConsumedAllowOnceReceipt | null> | HostConsumedAllowOnceReceipt | null;
  readonly isAuthenticConsumedAllowOnceReceipt?: (
    receipt: HostConsumedAllowOnceReceipt,
    now: number,
  ) => Promise<boolean> | boolean;
  readonly hostInvocationStartCas?: HostInvocationStartCas;
  /** Required durable audit boundary; runtime validation still fails closed. */
  readonly onInvocationAudit: (
    record: InvocationAuditRecord,
  ) => Promise<void> | void;
}

export interface PreparedRationaleResume {
  readonly request: SealedRationaleResumeRequest;
  readonly currentActionIdentity: ActionIdentity;
  readonly currentEligibilityContext: HostRationaleEligibilityContext;
  readonly runtime: RationaleResumeHostRuntime;
}

export interface AuthorizedRationaleResume extends PreparedRationaleResume {
  readonly receipt: HostConsumedAllowOnceReceipt;
  readonly authorizedInvocationAudit: InvocationAuditRecord;
}

export interface StartedRationaleResume extends AuthorizedRationaleResume {
  readonly authorityEntry: RationaleExecutionAuthorityEntry;
}

export type RationaleResumeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

function equal(left: unknown, right: unknown): boolean {
  return canonicalStringify(left) === canonicalStringify(right);
}

function mismatch(reason: string): RationaleResumeResult<never> {
  return { ok: false, reason };
}

export function extractSealedRationaleExecutionTarget(request: unknown):
  | { readonly request: SealedRationaleResumeRequest; readonly control: RationaleRequiredControl }
  | null {
  try {
    const sealed = cloneRationaleCanonicalJson(
      request,
      "SealedRationaleResumeRequest",
    ) as SealedRationaleResumeRequest;
    if (
      !sealed || typeof sealed !== "object" || Array.isArray(sealed) ||
      sealed.kind !== "sealed-rationale-resume" ||
      sealed.executionEntryPoint !== "tool-executor-security-suffix" ||
      sealed.directToolExecute !== "forbidden" ||
      !verifyRationaleRequiredControl(sealed.control)
    ) {
      return null;
    }
    return { request: sealed, control: sealed.control };
  } catch {
    return null;
  }
}

function actionMatchesCurrentProbe(
  action: ActionIdentity,
  probe: RationaleResumeIdentityProbe,
): boolean {
  const expectedTargets = probe.canonicalTargets.length > 0
    ? probe.canonicalTargets
    : [RATIONALE_UNKNOWN_SCOPE_SENTINEL];
  const sealed = probe.request.control.action;
  return verifyActionIdentity(action) &&
    equal(action, sealed) &&
    action.anchorId === probe.request.control.anchor.anchorId &&
    action.toolName === probe.toolName &&
    action.toolVersion === probe.toolVersion &&
    action.source === probe.source &&
    action.category === probe.category &&
    action.pluginId === probe.pluginId &&
    action.mcpServerId === probe.mcpServerId &&
    action.workerId === probe.workerId &&
    action.invocationTrustOrigin === probe.invocationTrustOrigin &&
    action.approvalCacheKey === probe.approvalCacheKey &&
    equal(action.canonicalTargets, expectedTargets) &&
    equal(action.sandboxExecutionPlan, probe.sandboxExecutionPlan) &&
    equal(probe.request.control.sealedAction.finalInput, probe.finalInput);
}

export async function prepareRationaleResume(
  request: SealedRationaleResumeRequest,
  probe: Omit<RationaleResumeIdentityProbe, "request">,
  runtime: RationaleResumeHostRuntime | undefined,
  now = Date.now(),
): Promise<RationaleResumeResult<PreparedRationaleResume>> {
  try {
    if (!runtime?.resolveCurrentActionIdentity) {
      return mismatch("rationale resume current ActionIdentity resolver is unavailable");
    }
    const currentEligibilityContext: HostRationaleEligibilityContext = {
      headless: probe.eligibilityContext.headless,
      forceModal: probe.eligibilityContext.forceModal,
      approvalReasonPrefix: probe.eligibilityContext.approvalReasonPrefix,
    };
    if (!verifyRationaleRequiredControl(request.control, {
      now,
      currentEligibilityContext,
    })) {
      return mismatch("rationale resume control is expired or eligibility context changed");
    }
    if (!equal(request.control.sealedAction.finalInput, probe.finalInput)) {
      return mismatch("rationale resume post-hook input changed");
    }
    const eligibility = {
      permission: probe.permission,
      anchor: request.control.anchor,
      invocationTrustOrigin: probe.invocationTrustOrigin,
      rationaleProvenance: request.control.action.rationaleProvenance,
      headless: currentEligibilityContext.headless,
      forceModal: currentEligibilityContext.forceModal,
      approvalReasonPrefix: currentEligibilityContext.approvalReasonPrefix ?? undefined,
      now,
    };
    if (!isRationaleEligible(eligibility) ||
        !equal(eligibility.permission.reviewer.verdict, request.control.initialVerdict)) {
      return mismatch("rationale resume permission/reviewer decision is no longer the same eligible ask");
    }
    const identityProbe: RationaleResumeIdentityProbe = { request, ...probe };
    const currentActionIdentity = await runtime.resolveCurrentActionIdentity(identityProbe);
    if (currentActionIdentity === null ||
        !actionMatchesCurrentProbe(currentActionIdentity, identityProbe)) {
      return mismatch("rationale resume ActionIdentity, policy, registry, or sandbox binding changed");
    }
    return {
      ok: true,
      value: {
        request,
        currentActionIdentity,
        currentEligibilityContext,
        runtime,
      },
    };
  } catch (error) {
    return mismatch(
      "rationale resume current-state validation failed: " +
        (error instanceof Error ? error.message : String(error)),
    );
  }
}

export async function authorizeRationaleResume(
  prepared: PreparedRationaleResume,
  now = Date.now(),
): Promise<RationaleResumeResult<AuthorizedRationaleResume>> {
  try {
    const loadReceipt = prepared.runtime.loadHostConsumedAllowOnceReceipt;
    const verifyReceipt = prepared.runtime.isAuthenticConsumedAllowOnceReceipt;
    if (!loadReceipt || !verifyReceipt) {
      return mismatch("rationale resume receipt authenticity boundary is unavailable");
    }
    const receipt = await loadReceipt(prepared.request);
    if (receipt === null || !(await verifyReceipt(receipt, now))) {
      return mismatch("rationale resume allow-once receipt is absent or inauthentic");
    }
    if (!validateSealedRationaleResumeRequest(
      prepared.request,
      prepared.currentActionIdentity,
      prepared.currentEligibilityContext,
      receipt,
      now,
    )) {
      return mismatch("sealed rationale resume request failed exact receipt/identity validation");
    }
    const authorizedInvocationAudit = createAuthorizedInvocationAudit({
      control: prepared.request.control,
      ticket: prepared.request.ticket,
      hostConsumedAllowOnceReceipt: receipt,
      now,
    });
    return { ok: true, value: { ...prepared, receipt, authorizedInvocationAudit } };
  } catch (error) {
    return mismatch(
      "rationale resume authorization failed: " +
        (error instanceof Error ? error.message : String(error)),
    );
  }
}

export async function startRationaleResume(
  authorized: AuthorizedRationaleResume,
  now = Date.now(),
): Promise<RationaleResumeResult<StartedRationaleResume>> {
  try {
    const hostStartCas = authorized.runtime.hostInvocationStartCas;
    if (!hostStartCas) return mismatch("rationale resume host invocation-start CAS is unavailable");
    const persistAudit = authorized.runtime.onInvocationAudit;
    if (typeof persistAudit !== "function") {
      return mismatch("rationale resume invocation audit sink is unavailable");
    }
    const startCommit = await hostStartCas.commitStart({
      sessionId: authorized.request.control.anchor.sessionId,
      control: authorized.request.control,
      authorized: authorized.authorizedInvocationAudit,
      expectedInvocationVersion: 0,
      persistAudit,
      now,
    });
    if (startCommit === null) {
      return mismatch("rationale resume invocation was already started");
    }
    const authorityEntry = createRationaleExecutionAuthorityEntry({
      resumeRequest: authorized.request,
      currentActionIdentity: authorized.currentActionIdentity,
      currentEligibilityContext: authorized.currentEligibilityContext,
      hostConsumedAllowOnceReceipt: authorized.receipt,
      authorizedInvocationAudit: authorized.authorizedInvocationAudit,
      hostInvocationStartLease: startCommit.lease,
      startedInvocationAudit: startCommit.startedInvocationAudit,
      now,
    });
    // commitStart is the sole execution-authority boundary. It makes the
    // started state authoritative before publishing its at-least-once audit
    // projection and before this function can release the tool for execution.
    return { ok: true, value: { ...authorized, authorityEntry } };
  } catch (error) {
    return mismatch(
      "rationale resume invocation-start failed: " +
        (error instanceof Error ? error.message : String(error)),
    );
  }
}

export async function finishRationaleResume(
  started: StartedRationaleResume,
  succeeded: boolean,
): Promise<boolean> {
  try {
    const persistAudit = started.runtime.onInvocationAudit;
    const hostStartCas = started.runtime.hostInvocationStartCas;
    if (typeof persistAudit !== "function" || !hostStartCas) return false;
    const event = createInvocationAuditEvent(
      started.authorityEntry.startedInvocationAudit,
      succeeded ? "complete" : "fail",
    );
    const terminal = transitionInvocationAudit(
      started.authorityEntry.startedInvocationAudit,
      event,
    );
    const committed = await hostStartCas.commitTerminal({
      lease: started.authorityEntry.startLease,
      terminal,
      persistAudit,
    });
    if (!committed) return false;
    return true;
  } catch {
    return false;
  }
}
