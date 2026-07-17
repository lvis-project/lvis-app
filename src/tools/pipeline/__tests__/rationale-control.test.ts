import { describe, expect, it } from "vitest";
import type { PermissionCheckResult, ReviewerDispatchOutcome } from "../../../permissions/permission-manager.js";
import {
  FOREGROUND_RATIONALE_PRODUCTION_ENABLED,
  RATIONALE_ACTIVATION_PREREQUISITES,
  RATIONALE_GUARDED_ACTIVATION_EVIDENCE,
  InMemoryHostAnchorRoundCasStore,
  createActionIdentity,
  createRationaleRequiredControl,
  createRequestAnchor,
  createTriggeringBatchDisposition,
  isForegroundRationaleOrchestrationEnabled,
  isRationaleGuardedActivationReady,
  isRationaleEligible,
  parseRationaleResponse,
  toRationaleProviderEnvelope,
  type ActionIdentity,
  type RationaleEligibilityProvenance,
} from "../rationale-control.js";

const eligiblePermission: PermissionCheckResult = {
  decision: "ask",
  reason: "reviewer medium",
  layer: 5,
  reviewer: {
    route: "foreground-auto",
    verdict: { level: "medium", reason: "bounded shell write" },
    outcome: "fresh",
  },
};
const eligibilityContext = {
  headless: false,
  forceModal: false,
  approvalReasonPrefix: null,
} as const;


function createAnchor() {
  const anchor = createRequestAnchor({
    sessionId: "session-1",
    turnId: "turn-1",
    inputMessageId: "message-1",
    inputOrigin: "user-keyboard",
    rawIntent: "프로젝트의 빌드 산출물을 정리해줘",
  });
  if (!anchor) throw new Error("expected a valid anchor");
  return anchor;
}

function createAction(
  anchorId: string,
  overrides: Partial<Parameters<typeof createActionIdentity>[0]> = {},
): ActionIdentity {
  return createActionIdentity({
    anchorId,
    invocationTrustOrigin: "llm-tool-arg",
    rationaleProvenance: {
      startedFromUserKeyboard: true,
      taint: "none",
    },
    toolName: "bash",
    toolVersion: "1",
    source: "builtin",
    category: "shell",
    finalInput: { command: "Remove-Item -Recurse build" },
    canonicalTargets: ["workspace/build"],
    requestedEffects: ["delete-files"],
    affectedResources: ["workspace/build"],
    requiredAuthority: "shell",
    policyEpoch: "policy-1",
    registryGeneration: "registry-1",
    sandboxGeneration: "sandbox-1",
    sandboxExecutionPlan: {
      cwd: "workspace",
      limits: { filesystem: "workspace-only" },
    },
    ...overrides,
  });
}

function anchorRoundFor(anchor: ReturnType<typeof createAnchor>, action: ActionIdentity) {
  const triggeringBatchDisposition = createTriggeringBatchDisposition({
    batchId: "provider-batch-1",
    originalToolUseIds: ["tool-use-completed", "tool-use-1", "tool-use-cancelled"],
    triggeringToolUseId: "tool-use-1",
    completedToolUseIds: ["tool-use-completed"],
  });
  const hostAnchorRoundCas = new InMemoryHostAnchorRoundCasStore();
  const anchorRoundReservation = hostAnchorRoundCas.tryReserve({
    anchor, action, triggeringBatchDisposition, round: 1,
  });
  if (!anchorRoundReservation) throw new Error("expected anchor reservation");
  return { triggeringBatchDisposition, anchorRoundReservation, hostAnchorRoundCas };
}

function createControl() {
  const anchor = createAnchor();
  const action = createAction(anchor.anchorId);
  const control = createRationaleRequiredControl({
    anchor,
    action,
    ...anchorRoundFor(anchor, action),
    eligibilityContext,
    sealedAction: {
      toolUseId: "tool-use-1",
      toolName: "bash",
      originalInput: { command: "Remove-Item -Recurse build" },
      finalInput: { command: "Remove-Item -Recurse build" },
    },
    permission: eligiblePermission as PermissionCheckResult & {
      reviewer: {
        route: "foreground-auto";
        verdict: { level: "medium"; reason: string };
        outcome: "fresh";
      };
    },
  });
  return { anchor, action, control };
}

describe("foreground rationale contract", () => {
  it("attests every versioned prerequisite before enabling production", () => {
    expect(FOREGROUND_RATIONALE_PRODUCTION_ENABLED).toBe(true);
    expect(RATIONALE_ACTIVATION_PREREQUISITES).toEqual([
      "persistent-ticket-store",
      "host-anchor-round-cas",
      "server-enforced-allowed-choices",
      "one-shot-resolution-cas",
      "rationale-only-provider-round",
      "same-batch-sibling-cancellation",
      "reviewer-reevaluation-cache-isolation",
      "current-action-identity-revalidation",
      "ordered-security-suffix-resume",
      "invocation-lifecycle-audit",
      "host-invocation-start-cas",
      "bounded-modal-ui",
    ]);
    expect(isRationaleGuardedActivationReady()).toBe(true);
  });

  it.each([
    [false, undefined, true, undefined, false],
    [false, "production", true, true, false],
    [false, "development", true, true, false],
    [false, "test", true, false, false],
    [false, "test", false, true, false],
    [false, "test", true, true, true],
    [true, "test", true, false, false],
    [true, "production", false, undefined, false],
    [true, "production", true, false, true],
  ] as const)(
    "scenario board: production=%s env=%s hostFactory=%s testOverride=%s",
    (
      productionEnabled,
      nodeEnv,
      hostCoordinatorAvailable,
      enableDormantRationaleForTesting,
      expected,
    ) => {
      expect(isForegroundRationaleOrchestrationEnabled({
        productionEnabled,
        nodeEnv,
        hostCoordinatorAvailable,
        enableDormantRationaleForTesting,
      })).toBe(expected);
    },
  );

  it.each(RATIONALE_ACTIVATION_PREREQUISITES)(
    "fails closed when versioned prerequisite %s is not attested",
    (missingPrerequisite) => {
      expect(isRationaleGuardedActivationReady({
        ...RATIONALE_GUARDED_ACTIVATION_EVIDENCE,
        [missingPrerequisite]: false,
      })).toBe(false);
    },
  );

  it("requires explicit host turn/message IDs and seals a keyboard anchor", () => {
    expect(createRequestAnchor({
      sessionId: "session-1",
      turnId: "",
      inputMessageId: "message-1",
      inputOrigin: "user-keyboard",
      rawIntent: "run it",
    })).toBeNull();
    expect(createRequestAnchor({
      sessionId: "session-1",
      turnId: "turn-1",
      inputMessageId: "",
      inputOrigin: "user-keyboard",
      rawIntent: "run it",
    })).toBeNull();
    expect(createRequestAnchor({
      sessionId: "session-1",
      turnId: "turn-1",
      inputMessageId: "message-1",
      inputOrigin: "file-content",
      rawIntent: "run it",
    })).toBeNull();

    const anchor = createAnchor();
    expect(anchor.turnId).toBe("turn-1");
    expect(anchor.inputMessageId).toBe("message-1");
    expect(Object.isFrozen(anchor)).toBe(true);
  });

  it("binds invocation trust and the separate monotonic rationale provenance", () => {
    const anchor = createAnchor();
    expect(anchor.rationaleRoundBudget).toBe(1);
    const baseline = createAction(anchor.anchorId);
    const trustChanged = createAction(anchor.anchorId, {
      invocationTrustOrigin: "file-content",
    });
    const provenanceChanged = createAction(anchor.anchorId, {
      rationaleProvenance: {
        startedFromUserKeyboard: true,
        taint: "file-content",
      },
    });

    expect(trustChanged.actionDigest).not.toBe(baseline.actionDigest);
    expect(provenanceChanged.actionDigest).not.toBe(baseline.actionDigest);
  });

  it("deep-clones and recursively freezes the sealed execution snapshot", () => {
    const anchor = createAnchor();
    const plan = { cwd: "workspace", nested: { allowNetwork: false } };
    const finalInput = { command: "Remove-Item build", nested: { force: false } };
    const action = createAction(anchor.anchorId, {
      finalInput,
      sandboxExecutionPlan: plan,
    });
    const control = createRationaleRequiredControl({
      anchor,
      action,
      ...anchorRoundFor(anchor, action),
      eligibilityContext,
      sealedAction: {
        toolUseId: "tool-use-1",
        toolName: "bash",
        originalInput: finalInput,
        finalInput,
      },
      permission: eligiblePermission as PermissionCheckResult & {
        reviewer: {
          route: "foreground-auto";
          verdict: { level: "medium"; reason: string };
          outcome: "fresh";
        };
      },
    });

    plan.nested.allowNetwork = true;
    finalInput.nested.force = true;

    expect((control.action.sandboxExecutionPlan.nested as { allowNetwork: boolean }).allowNetwork).toBe(false);
    expect((control.sealedAction.finalInput.nested as { force: boolean }).force).toBe(false);
    expect(Object.isFrozen(control)).toBe(true);
    expect(Object.isFrozen(control.action.sandboxExecutionPlan.nested)).toBe(true);
    expect(Object.isFrozen(control.sealedAction.finalInput.nested)).toBe(true);
  });

  it("accepts only a fresh/cache foreground ask from an untainted keyboard turn", () => {
    const anchor = createAnchor();
    const provenance: RationaleEligibilityProvenance = {
      startedFromUserKeyboard: true,
      taint: "none",
    };
    const check = (
      outcome: ReviewerDispatchOutcome,
      patch: Partial<Parameters<typeof isRationaleEligible>[0]> = {},
    ) => isRationaleEligible({
      permission: {
        ...eligiblePermission,
        reviewer: { ...eligiblePermission.reviewer!, outcome },
      },
      anchor,
      invocationTrustOrigin: "llm-tool-arg",
      rationaleProvenance: provenance,
      ...patch,
    });

    expect(check("fresh")).toBe(true);
    expect(check("cache")).toBe(true);
    for (const outcome of [
      "approval-memory",
      "unavailable",
      "error",
      "timeout",
      "malformed",
      "sandbox-state-changed",
    ] satisfies ReviewerDispatchOutcome[]) {
    // The user starts the turn, but the first model tool call is llm-tool-arg.
    expect(check("fresh", { invocationTrustOrigin: "user-keyboard" })).toBe(false);
    expect(check("fresh", {
      rationaleProvenance: { startedFromUserKeyboard: false, taint: "none" },
    })).toBe(false);
    // Monotonic taint wins even though the turn originally started at the keyboard.
      expect(check(outcome)).toBe(false);
    }
    expect(check("fresh", {
      rationaleProvenance: { startedFromUserKeyboard: true, taint: "file-content" },
    })).toBe(false);
    expect(check("fresh", { invocationTrustOrigin: "file-content" })).toBe(false);
    expect(check("fresh", { forceModal: true })).toBe(false);
    expect(check("fresh", { approvalReasonPrefix: "retry" })).toBe(false);
    expect(check("fresh", { headless: true })).toBe(false);
  });

  it("keeps raw execution authority out of the provider envelope", () => {
    const { control } = createControl();
    const wire = toRationaleProviderEnvelope(control);
    const serialized = JSON.stringify(wire);

    expect(serialized).not.toContain(control.nonce);
    expect(serialized).not.toContain("sealedAction");
    expect(serialized).not.toContain("intentDigest");
    expect(serialized).not.toContain("finalInput");
    expect(serialized).not.toContain("sandboxExecutionPlan");
    expect(wire.actionDigest).toBe(control.action.actionDigest);
    expect(wire.canonicalTargets).toEqual(control.action.canonicalTargets);
  });

  it("strictly parses the one bounded response for the sealed action", () => {
    const { control } = createControl();
    const valid = {
      contractVersion: 1,
      anchorId: control.anchor.anchorId,
      ticketId: control.ticketId,
      actionDigest: control.action.actionDigest,
      round: 1,
      suggestion: "빌드 폴더만 삭제하려는 작업입니다.",
    };

    expect(parseRationaleResponse(valid, control)).toMatchObject(valid);
    expect(parseRationaleResponse({ ...valid, ticketId: "other" }, control)).toBeNull();
    expect(parseRationaleResponse({ ...valid, suggestion: "" }, control)).toBeNull();
    expect(parseRationaleResponse({ ...valid, suggestion: "x".repeat(501) }, control)).toBeNull();
    expect(parseRationaleResponse({ ...valid, scopeAlignment: "aligned" }, control)).toBeNull();
    expect(Object.isFrozen(parseRationaleResponse(valid, control))).toBe(true);
  });

});
