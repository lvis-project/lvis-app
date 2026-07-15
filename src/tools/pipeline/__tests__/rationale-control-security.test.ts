import { describe, expect, it, vi } from "vitest";
import type { PermissionCheckResult } from "../../../permissions/permission-manager.js";
import {
  InMemoryHostAnchorRoundCasStore,
  createActionIdentity,
  createRationaleRequiredControl,
  parseRationaleResponse,
  createRequestAnchor,
  createTriggeringBatchDisposition,
  isRationaleEligible,
  isRationaleEligibilityContextCurrent,
  toRationaleProviderEnvelope,
  type ActionIdentity,
  verifyRationaleRequiredControl,
  RATIONALE_RESPONSE_SCHEMA,
} from "../rationale-control.js";

const permission = {
  decision: "ask",
  reason: "reviewer medium",
  layer: 5,
  reviewer: {
    route: "foreground-auto",
    verdict: { level: "medium", reason: "bounded shell action" },
    outcome: "fresh",
  },
} as const satisfies PermissionCheckResult;
const eligibilityContext = {
  headless: false,
  forceModal: false,
  approvalReasonPrefix: null,
} as const;


function anchorAt(now = Date.now(), ttlMs = 10 * 60 * 1_000) {
  const anchor = createRequestAnchor({
    sessionId: "session-1",
    turnId: "turn-1",
    inputMessageId: "message-1",
    inputOrigin: "user-keyboard",
    rawIntent: "프로젝트의 빌드 산출물을 정리해줘",
    now,
    ttlMs,
  });
  if (!anchor) throw new Error("expected anchor");
  return anchor;
}

function actionFor(
  anchorId: string,
  overrides: Partial<Parameters<typeof createActionIdentity>[0]> = {},
): ActionIdentity {
  return createActionIdentity({
    anchorId,
    invocationTrustOrigin: "llm-tool-arg",
    rationaleProvenance: { startedFromUserKeyboard: true, taint: "none" },
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
    sandboxExecutionPlan: { cwd: "workspace" },
    ...overrides,
  });
}

const sealedAction = {
  toolUseId: "tool-use-1",
  toolName: "bash",
  originalInput: { command: "Remove-Item -Recurse build" },
  finalInput: { command: "Remove-Item -Recurse build" },
};

function anchorRoundFor(
  anchor: ReturnType<typeof anchorAt>,
  action: ActionIdentity,
  toolUseId = "tool-use-1",
  now = Date.now(),
) {
  const triggeringBatchDisposition = createTriggeringBatchDisposition({
    batchId: "provider-batch-1",
    originalToolUseIds: ["tool-use-completed", toolUseId, "tool-use-cancelled"],
    triggeringToolUseId: toolUseId,
    completedToolUseIds: ["tool-use-completed"],
  });
  const hostAnchorRoundCas = new InMemoryHostAnchorRoundCasStore();
  const anchorRoundReservation = hostAnchorRoundCas.tryReserve({
    anchor, action, triggeringBatchDisposition, round: 1, now,
  });
  if (!anchorRoundReservation) throw new Error("expected anchor reservation");
  return { triggeringBatchDisposition, anchorRoundReservation, hostAnchorRoundCas };
}

describe("foreground rationale hostile input rejection", () => {
  it("rejects non-canonical final input and sandbox-plan values", () => {
    const anchor = anchorAt();
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const invalidValues: unknown[] = [
      new Map([["key", "value"]]),
      new Date(),
      { value: undefined },
      { value: Number.POSITIVE_INFINITY },
      { value: -0 },
      cycle,
    ];

    for (const value of invalidValues) {
      expect(() => actionFor(anchor.anchorId, {
        finalInput: value as Record<string, unknown>,
      })).toThrow();
    }
    expect(() => actionFor(anchor.anchorId, {
      sandboxExecutionPlan: new Date() as unknown as Record<string, unknown>,
    })).toThrow(/plain object prototype/);
  });

  it("rejects canonical JSON that exceeds depth or byte bounds", () => {
    const anchor = anchorAt();
    const tooDeep: Record<string, unknown> = {};
    let cursor = tooDeep;
    for (let index = 0; index < 14; index += 1) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }

    expect(() => actionFor(anchor.anchorId, { finalInput: tooDeep })).toThrow(
      /depth limit/,
    );
    expect(() => actionFor(anchor.anchorId, {
      finalInput: { payload: "x".repeat(70 * 1_024) },
    })).toThrow(/byte limit/);
  });

  it("rejects identity arrays before provider projection could truncate them", () => {
    const anchor = anchorAt();
    expect(() => actionFor(anchor.anchorId, {
      requestedEffects: Array.from({ length: 9 }, (_, index) => "effect-" + index),
    })).toThrow(/bounded string-list contract/);
    expect(() => actionFor(anchor.anchorId, {
      affectedResources: Array.from({ length: 9 }, (_, index) => "resource-" + index),
    })).toThrow(/bounded string-list contract/);
  });

  it("binds anchor, expiry, tool identity, and non-empty tool-use ID", () => {
    const anchor = anchorAt();
    const otherAnchor = createRequestAnchor({
      sessionId: "session-1",
      turnId: "turn-2",
      inputMessageId: "message-2",
      inputOrigin: "user-keyboard",
      rawIntent: "정리해줘",
    });
    if (!otherAnchor) throw new Error("expected other anchor");
    const action = actionFor(anchor.anchorId);

    expect(() => createRationaleRequiredControl({
      anchor: otherAnchor,
      action,
      ...anchorRoundFor(anchor, action),
      eligibilityContext,
      sealedAction,
      permission,
    })).toThrow(/eligible sealed action/);
    expect(() => createRationaleRequiredControl({
      anchor,
      action,
      ...anchorRoundFor(anchor, action),
      eligibilityContext,
      sealedAction: { ...sealedAction, toolUseId: "" },
      permission,
    })).toThrow(/bounded text contract/);
    expect(() => createRationaleRequiredControl({
      anchor,
      action,
      ...anchorRoundFor(anchor, action),
      eligibilityContext,
      sealedAction: { ...sealedAction, toolName: "other-tool" },
      permission,
    })).toThrow(/eligible sealed action/);

    const expiringAnchor = anchorAt(100, 10);
    const expiringAction = actionFor(expiringAnchor.anchorId);
    expect(() => createRationaleRequiredControl({
      anchor: expiringAnchor,
      action: expiringAction,
      ...anchorRoundFor(expiringAnchor, expiringAction, "tool-use-1", 100),
      eligibilityContext,
      sealedAction,
      permission,
      now: 110,
    })).toThrow(/eligible sealed action/);
    expect(isRationaleEligible({
      permission,
      anchor: expiringAnchor,
      invocationTrustOrigin: "llm-tool-arg",
      rationaleProvenance: { startedFromUserKeyboard: true, taint: "none" },
      now: 110,
    })).toBe(false);
  });

  it("projects every bounded item and DLP-masks reviewer text without leaking raw secrets", () => {
    const anchor = anchorAt();
    const targets = Array.from({ length: 32 }, (_, index) => "target-" + index);
    const effects = Array.from({ length: 8 }, (_, index) =>
      index === 0 ? "notify alice@example.com" : "effect-" + index
    );
    const resources = Array.from({ length: 8 }, (_, index) => "resource-" + index);
    const action = actionFor(anchor.anchorId, {
      canonicalTargets: targets,
      requestedEffects: effects,
      affectedResources: resources,
    });
    const secretPermission = {
      ...permission,
      reviewer: {
        ...permission.reviewer,
        verdict: {
          level: "medium" as const,
          reason: "Confirm with alice@example.com using sk-secret-token-value",
        },
      },
    };
    const control = createRationaleRequiredControl({
      anchor,
      action,
      ...anchorRoundFor(anchor, action),
      eligibilityContext,
      sealedAction,
      permission: secretPermission,
    });
    const envelope = toRationaleProviderEnvelope(control);
    const serialized = JSON.stringify(envelope);

    expect(envelope.requestedEffects).toHaveLength(8);
    expect(envelope.affectedResources).toHaveLength(8);
    expect(envelope.canonicalTargets).toEqual(targets);
    expect(serialized).not.toContain("alice@example.com");
    expect(serialized).not.toContain("sk-secret-token-value");
    expect(envelope.initialVerdict.reason.length).toBeLessThanOrEqual(500);
  });
});

describe("foreground rationale identity and eligibility binding", () => {
  it("rejects arbitrary trust origins and invalid source identity combinations", () => {
    const anchor = anchorAt();
    expect(() => actionFor(anchor.anchorId, {
      invocationTrustOrigin: "attacker-controlled" as never,
    })).toThrow(/trust origin/);
    expect(() => actionFor(anchor.anchorId, {
      source: "builtin",
      pluginId: "plugin-a",
    })).toThrow(/builtin action/);
    expect(() => actionFor(anchor.anchorId, {
      source: "plugin",
    })).toThrow(/plugin action requires/);
    expect(() => actionFor(anchor.anchorId, {
      source: "plugin",
      pluginId: "plugin-a",
      mcpServerId: "mcp-a",
    })).toThrow(/plugin action requires/);
    expect(() => actionFor(anchor.anchorId, {
      source: "mcp",
    })).toThrow(/MCP action requires/);
    expect(() => actionFor(anchor.anchorId, {
      source: "mcp",
      mcpServerId: "mcp-a",
      workerId: "worker-a",
    })).toThrow(/MCP action requires/);

    expect(() => actionFor(anchor.anchorId, {
      source: "plugin",
      pluginId: "plugin-a",
      workerId: "worker-a",
    })).not.toThrow();
    expect(() => actionFor(anchor.anchorId, {
      source: "mcp",
      mcpServerId: "mcp-a",
    })).not.toThrow();
  });

  it("keeps actionDigest deterministic while binding toolUseId to a unique control", () => {
    const anchor = anchorAt();
    const action = actionFor(anchor.anchorId);
    const first = createRationaleRequiredControl({
      anchor,
      action,
      ...anchorRoundFor(anchor, action),
      eligibilityContext,
      sealedAction,
      permission,
    });
    const second = createRationaleRequiredControl({
      anchor,
      action,
      ...anchorRoundFor(anchor, action, "tool-use-2"),
      eligibilityContext,
      sealedAction: { ...sealedAction, toolUseId: "tool-use-2" },
      permission,
    });

    expect(first.action.actionDigest).toBe(second.action.actionDigest);
    expect(first.sealedAction.toolUseId).toBe("tool-use-1");
    expect(second.sealedAction.toolUseId).toBe("tool-use-2");
    expect(first.ticketId).not.toBe(second.ticketId);
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.invocationDigest).not.toBe(second.invocationDigest);
  });



it("requires and revalidates the host eligibility snapshot for every control", () => {
  const anchor = anchorAt();
  const action = actionFor(anchor.anchorId);
  for (const blockedContext of [
    { ...eligibilityContext, headless: true },
    { ...eligibilityContext, forceModal: true },
    { ...eligibilityContext, approvalReasonPrefix: "explicit retry" },
  ]) {
    expect(() => createRationaleRequiredControl({
      anchor,
      action,
      ...anchorRoundFor(anchor, action),
      sealedAction,
      eligibilityContext: blockedContext,
      permission,
    })).toThrow(/eligible sealed action/);
  }

  const control = createRationaleRequiredControl({
    anchor,
    action,
    ...anchorRoundFor(anchor, action),
    sealedAction,
    eligibilityContext,
    permission,
  });
  expect(isRationaleEligibilityContextCurrent(control, eligibilityContext)).toBe(true);
  expect(isRationaleEligibilityContextCurrent(control, {
    ...eligibilityContext,
    headless: true,
  })).toBe(false);
  expect(isRationaleEligibilityContextCurrent(control, {
    ...eligibilityContext,
    approvalReasonPrefix: "changed before resume",
  })).toBe(false);
});

});

it("binds reviewer outcome and a normalized exact verdict outside actionDigest", () => {
  const anchor = anchorAt();
  const action = actionFor(anchor.anchorId);
  const control = createRationaleRequiredControl({
    anchor,
    action,
    ...anchorRoundFor(anchor, action),
    sealedAction,
    eligibilityContext,
    permission,
  });
  const cacheControl = createRationaleRequiredControl({
    anchor,
    action,
    ...anchorRoundFor(anchor, action),
    sealedAction,
    eligibilityContext,
    permission: {
      ...permission,
      reviewer: {
        ...permission.reviewer,
        outcome: "cache",
        verdict: { level: "low", reason: "cached bounded action" },
      },
    },
  });
  expect(cacheControl.action.actionDigest).toBe(control.action.actionDigest);
  expect(verifyRationaleRequiredControl(cacheControl)).toBe(true);
  expect(verifyRationaleRequiredControl(control)).toBe(true);
  expect(verifyRationaleRequiredControl({
    ...control,
    reviewerOutcome: "cache",
  })).toBe(false);
  expect(verifyRationaleRequiredControl({
    ...control,
    initialVerdict: {
      ...control.initialVerdict,
      reason: "modified after review",
    },
  })).toBe(false);
  expect(verifyRationaleRequiredControl({
    ...control,
    sealedAction: {
      ...control.sealedAction,
      toolUseId: "different-tool-use",
    },
  })).toBe(false);
  expect(action.actionDigest).toBe(control.action.actionDigest);

  expect(() => createRationaleRequiredControl({
    anchor,
    action,
    ...anchorRoundFor(anchor, action),
    sealedAction,
    eligibilityContext,
    permission: {
      ...permission,
      reviewer: {
        ...permission.reviewer,
        verdict: {
          level: "medium",
          reason: "valid",
          allow: true,
        } as never,
      },
    },
  })).toThrow(/unexpected or missing fields/);
  expect(() => createRationaleRequiredControl({
    anchor,
    action,
    ...anchorRoundFor(anchor, action),
    sealedAction,
    eligibilityContext,
    permission: {
      ...permission,
      reviewer: {
        ...permission.reviewer,
        verdict: { level: "critical", reason: "invalid" } as never,
      },
    },
  })).toThrow(/invalid RiskVerdict/);
});

it("rejects extra authority, coercion, hostile arrays, and stale controls", () => {
  expect(RATIONALE_RESPONSE_SCHEMA.inputSchema.additionalProperties).toBe(false);
  const anchor = anchorAt();
  const action = actionFor(anchor.anchorId);
  const control = createRationaleRequiredControl({
    anchor,
    action,
    ...anchorRoundFor(anchor, action),
    sealedAction,
    eligibilityContext,
    permission,
  });
  const valid = {
    contractVersion: 1,
    anchorId: control.anchor.anchorId,
    ticketId: control.ticketId,
    actionDigest: control.action.actionDigest,
    round: 1,
    suggestion: "빌드 폴더만 삭제합니다.",
  };

  expect(parseRationaleResponse({
    ...valid,
    allowedChoices: ["allow-always"],
  }, control)).toBeNull();
  expect(parseRationaleResponse({
    ...valid,
    nonce: control.nonce,
  }, control)).toBeNull();
  expect(parseRationaleResponse({
    ...valid,
    scopeAlignment: ["aligned"],
  }, control)).toBeNull();
  expect(parseRationaleResponse({
    ...valid,
    scopeAlignment: { toString: () => "aligned" },
  }, control)).toBeNull();

  const sparseReasons = Array<string>(2);
  sparseReasons[1] = "reason";
  expect(parseRationaleResponse({
    ...valid,
    scopeReasons: sparseReasons,
  }, control)).toBeNull();

  const getter = vi.fn(() => "must not run");
  const accessorReasons: string[] = [];
  Object.defineProperty(accessorReasons, "0", {
    configurable: true,
    enumerable: true,
    get: getter,
  });
  expect(parseRationaleResponse({
    ...valid,
    scopeReasons: accessorReasons,
  }, control)).toBeNull();
  expect(getter).not.toHaveBeenCalled();

  const symbolReasons = ["reason"];
  Object.defineProperty(symbolReasons, Symbol("authority"), {
    value: "allow",
    enumerable: true,
  });
  expect(parseRationaleResponse({
    ...valid,
    scopeReasons: symbolReasons,
  }, control)).toBeNull();

  const extraReasons = ["reason"];
  Object.defineProperty(extraReasons, "authority", {
    value: "allow",
    enumerable: false,
  });
  expect(parseRationaleResponse({
    ...valid,
    scopeReasons: extraReasons,
  }, control)).toBeNull();

  const modifiedControl = {
    ...control,
    invocationDigest: "0".repeat(64),
  };
  expect(parseRationaleResponse(valid, modifiedControl)).toBeNull();
  expect(() => toRationaleProviderEnvelope(modifiedControl)).toThrow(
    /invalid or expired rationale control/,
  );

  const expiringAnchor = anchorAt(100, 100);
  const expiringAction = actionFor(expiringAnchor.anchorId);
  const expiringControl = createRationaleRequiredControl({
    anchor: expiringAnchor,
    action: expiringAction,
    ...anchorRoundFor(expiringAnchor, expiringAction, "tool-use-1", 100),
    sealedAction,
    eligibilityContext,
    permission,
    now: 110,
  });
  const expiringResponse = {
    ...valid,
    anchorId: expiringControl.anchor.anchorId,
    ticketId: expiringControl.ticketId,
    actionDigest: expiringControl.action.actionDigest,
  };
  expect(parseRationaleResponse(expiringResponse, expiringControl, 200)).toBeNull();
  expect(() => toRationaleProviderEnvelope(expiringControl)).toThrow(
    /invalid or expired rationale control/,
  );
});


it("binds every anchor, triggering-batch, reservation, and sealed-action field", () => {
  const now = Date.now();
  const anchor = anchorAt(now);
  const action = actionFor(anchor.anchorId);
  const control = createRationaleRequiredControl({
    anchor, action, ...anchorRoundFor(anchor, action, "tool-use-1", now),
    sealedAction, eligibilityContext, permission, now,
  });
  const mutations: Array<Partial<typeof anchor>> = [
    { contractVersion: 2 as never },
    { anchorId: "00000000-0000-4000-8000-000000000000" },
    { sessionId: "session-2" },
    { turnId: "turn-2" },
    { inputMessageId: "message-2" },
    { inputOrigin: "file-content" as never },
    { sanitizedIntent: "다른 의도" },
    { intentDigest: "0".repeat(64) },
    { createdAt: anchor.createdAt - 1 },
    { expiresAt: anchor.expiresAt + 1 },
    { rationaleRoundBudget: 0 as never },
  ];
  for (const mutation of mutations) {
    expect(verifyRationaleRequiredControl({
      ...control, anchor: { ...control.anchor, ...mutation },
    })).toBe(false);
  }
  for (const mutation of [
    { toolUseId: "tool-use-2" },
    { toolName: "other-tool" },
    { originalInput: { command: "Get-ChildItem build" } },
    { finalInput: { command: "Get-ChildItem build" } },
  ] as const) {
    expect(verifyRationaleRequiredControl({
      ...control,
      sealedAction: { ...control.sealedAction, ...mutation },
    })).toBe(false);
  }
  const alternateBatch = createTriggeringBatchDisposition({
    batchId: "provider-batch-2",
    originalToolUseIds: control.triggeringBatchDisposition.originalToolUseIds,
    triggeringToolUseId: control.triggeringBatchDisposition.triggeringToolUseId,
    completedToolUseIds: control.triggeringBatchDisposition.completedToolUseIds,
  });
  expect(verifyRationaleRequiredControl({
    ...control,
    triggeringBatchDisposition: alternateBatch,
    anchorRoundReservation: {
      ...control.anchorRoundReservation, batchDigest: alternateBatch.batchDigest,
    },
  })).toBe(false);
  expect(verifyRationaleRequiredControl({
    ...control,
    anchorRoundReservation: {
      ...control.anchorRoundReservation,
      reservationId: "11111111-1111-4111-8111-111111111111",
    },
  })).toBe(false);
});

it("rejects Array subclasses and custom prototypes before inherited helpers or getters run", () => {
  const anchor = anchorAt();
  const every = vi.fn(() => true);
  const map = vi.fn(() => ["delete-files"]);
  class HostileArray extends Array<string> {}
  Object.defineProperty(HostileArray.prototype, "every", { value: every });
  Object.defineProperty(HostileArray.prototype, "map", { value: map });
  const hostile = new HostileArray("delete-files");
  expect(() => actionFor(anchor.anchorId, { requestedEffects: hostile })).toThrow(
    /intrinsic Array prototype/,
  );
  expect(every).not.toHaveBeenCalled();
  expect(map).not.toHaveBeenCalled();

  const customPrototype = ["delete-files"];
  Object.setPrototypeOf(customPrototype, Object.create(Array.prototype));
  expect(() => actionFor(anchor.anchorId, { requestedEffects: customPrototype })).toThrow(
    /intrinsic Array prototype/,
  );

  const getter = vi.fn(() => "delete-files");
  const accessor: string[] = [];
  Object.defineProperty(accessor, "0", { enumerable: true, get: getter });
  expect(() => actionFor(anchor.anchorId, { requestedEffects: accessor })).toThrow();
  expect(getter).not.toHaveBeenCalled();
});

it("requires explicit non-empty scope lists or the sealed unknown sentinel", () => {
  const anchor = anchorAt();
  for (const field of ["canonicalTargets", "requestedEffects", "affectedResources"] as const) {
    expect(() => actionFor(anchor.anchorId, { [field]: [] })).toThrow(
      /bounded string-list contract/,
    );
    expect(() => actionFor(anchor.anchorId, {
      [field]: ["[unknown]", "extra"],
    })).toThrow(/unknown sentinel/);
    expect(() => actionFor(anchor.anchorId, { [field]: ["[unknown]"] })).not.toThrow();
  }
});
