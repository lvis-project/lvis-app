import { describe, expect, it } from "vitest";
import type { PermissionCheckResult } from "../../../permissions/permission-manager.js";
import {
  InMemoryHostAnchorRoundCasStore,
  createActionIdentity,
  createRationaleRequiredControl,
  createRequestAnchor,
  createTriggeringBatchDisposition,
  type RationaleRequiredControl,
} from "../rationale-control.js";
import {
  validateHostConsumedAllowOnceReceipt,
  type HostConsumedAllowOnceReceipt,
  RATIONALE_TICKET_TERMINAL_STATES,
} from "../rationale-ticket-lifecycle.js";
import {
  InProcessRationaleTicketStore,
  createRationaleTicketCasExpectation,
  type HostRationaleTicketSnapshot,
  type RationaleTicketStoreAuditEvent,
} from "../rationale-ticket-store.js";

const NOW = 1_900_000_000_000;
const permission = {
  decision: "ask",
  reason: "reviewer medium",
  layer: 5,
  reviewer: {
    route: "foreground-auto",
    verdict: { level: "medium", reason: "bounded workspace deletion" },
    outcome: "fresh",
  },
} as const satisfies PermissionCheckResult;
const eligibilityContext = {
  headless: false,
  forceModal: false,
  approvalReasonPrefix: null,
} as const;

function fixture(
  sessionId = "84097828-fc31-48c8-8292-10df48901a85",
  suffix = "1",
): RationaleRequiredControl {
  const anchor = createRequestAnchor({
    sessionId,
    turnId: "turn-" + suffix,
    inputMessageId: "message-" + suffix,
    inputOrigin: "user-keyboard",
    rawIntent: "delete private build output " + suffix,
    now: NOW,
    ttlMs: 60_000,
  });
  if (!anchor) throw new Error("expected anchor");
  const finalInput = { command: "Remove-Item -Recurse build-" + suffix };
  const action = createActionIdentity({
    anchorId: anchor.anchorId,
    invocationTrustOrigin: "llm-tool-arg",
    rationaleProvenance: { startedFromUserKeyboard: true, taint: "none" },
    toolName: "bash",
    toolVersion: "1",
    source: "builtin",
    category: "shell",
    finalInput,
    canonicalTargets: ["workspace/build-" + suffix],
    requestedEffects: ["delete-files"],
    affectedResources: ["workspace/build-" + suffix],
    requiredAuthority: "shell",
    policyEpoch: "policy-1",
    registryGeneration: "registry-1",
    sandboxGeneration: "sandbox-1",
    sandboxExecutionPlan: { cwd: "workspace", filesystem: "workspace-only" },
  });
  const triggeringBatchDisposition = createTriggeringBatchDisposition({
    batchId: "provider-batch-" + suffix,
    originalToolUseIds: ["tool-use-" + suffix],
    triggeringToolUseId: "tool-use-" + suffix,
    completedToolUseIds: [],
  });
  const hostAnchorRoundCas = new InMemoryHostAnchorRoundCasStore();
  const anchorRoundReservation = hostAnchorRoundCas.tryReserve({
    anchor,
    action,
    triggeringBatchDisposition,
    round: 1,
    now: NOW,
  });
  if (!anchorRoundReservation) throw new Error("expected reservation");
  return createRationaleRequiredControl({
    anchor,
    action,
    triggeringBatchDisposition,
    anchorRoundReservation,
    hostAnchorRoundCas,
    eligibilityContext,
    permission,
    now: NOW,
    sealedAction: {
      toolUseId: "tool-use-" + suffix,
      toolName: "bash",
      originalInput: finalInput,
      finalInput,
    },
  });
}

function required(
  snapshot: HostRationaleTicketSnapshot | null,
): HostRationaleTicketSnapshot {
  expect(snapshot).not.toBeNull();
  return snapshot as HostRationaleTicketSnapshot;
}

function createStored(
  store: InProcessRationaleTicketStore,
  control: RationaleRequiredControl,
  now = NOW,
): HostRationaleTicketSnapshot {
  return required(store.create({
    sessionId: control.anchor.sessionId,
    control,
    now,
  }));
}

function toPendingReady(
  store: InProcessRationaleTicketStore,
  initial: HostRationaleTicketSnapshot,
  startAt = NOW + 1,
): HostRationaleTicketSnapshot {
  const requested = required(store.requestRationale(
    createRationaleTicketCasExpectation(initial),
    startAt,
  ));
  const ready = required(store.markRationaleReady(
    createRationaleTicketCasExpectation(requested),
    { generationOutcome: "accepted-rationale", reevaluationOutcome: "fresh" },
    startAt + 1,
  ));
  return required(store.promptUser(
    createRationaleTicketCasExpectation(ready),
    startAt + 2,
  ));
}
function expectAuditPayloadsAreSafe(
  audit: readonly RationaleTicketStoreAuditEvent[],
): void {
  const auditJson = JSON.stringify(audit);
  expect(auditJson).not.toContain("delete private build output");
  expect(auditJson).not.toContain("Remove-Item");
  expect(auditJson).not.toContain("rawIntent");
  expect(auditJson).not.toContain("\"command\"");
}

describe("InProcessRationaleTicketStore", () => {
  it("binds control and ticket to one session and rejects duplicate creation", () => {
    const audit: RationaleTicketStoreAuditEvent[] = [];
    const store = new InProcessRationaleTicketStore({
      onAudit: (event) => audit.push(event),
    });
    const control = fixture();

    const created = createStored(store, control);
    expect(created).toMatchObject({
      sessionId: "84097828-fc31-48c8-8292-10df48901a85",
      version: 0,
      ticket: {
        ticketId: control.ticketId,
        actionDigest: control.action.actionDigest,
        state: "review_required",
      },
    });
    expect(Object.isFrozen(created)).toBe(true);
    expect(Object.isFrozen(created.control)).toBe(true);
    expect(store.get({
      sessionId: "84097828-fc31-48c8-8292-10df48901a85",
      ticketId: control.ticketId,
      now: NOW,
    })).toBe(created);
    expect(store.get({
      sessionId: "5f711b23-ee4f-4cbb-88e0-53b872bbda82",
      ticketId: control.ticketId,
      now: NOW,
    })).toBeNull();
    expect(() => store.create({
      sessionId: "5f711b23-ee4f-4cbb-88e0-53b872bbda82",
      control,
      now: NOW,
    })).toThrow(/control\/session binding/);

    expect(store.create({
      sessionId: "84097828-fc31-48c8-8292-10df48901a85",
      control,
      now: NOW + 1,
    })).toBeNull();
    expect(store.get({
      sessionId: "84097828-fc31-48c8-8292-10df48901a85",
      ticketId: control.ticketId,
      now: NOW + 1,
    })).toBeNull();
    expect(store.create({
      sessionId: "84097828-fc31-48c8-8292-10df48901a85",
      control,
      now: NOW + 2,
    })).toBeNull();

    expect(audit.map((event) => [event.operation, event.event, event.state]))
      .toEqual([
        ["created", null, "review_required"],
        ["retired", "stale-replay", "rejected"],
        ["replay-rejected", "stale-replay", "rejected"],
      ]);
    const auditJson = JSON.stringify(audit);
    expect(auditJson).not.toContain("delete private build output");
    expect(auditJson).not.toContain("Remove-Item");
  });

  it("prunes expired tombstones without allowing clock-rollback replay", () => {
    const audit: RationaleTicketStoreAuditEvent[] = [];
    const store = new InProcessRationaleTicketStore({
      onAudit: (event) => audit.push(event),
    });
    const control = fixture("f0100278-9f5c-47d3-87cd-caa530ab3542", "tombstone-expiry");
    const initial = createStored(store, control);
    const expectation = createRationaleTicketCasExpectation(initial);

    expect(required(store.abort(expectation, NOW + 1)).ticket).toMatchObject({
      state: "cancelled",
      terminalReason: "caller-abort",
    });
    expect(store.abort(expectation, NOW + 2)).toBeNull();
    expect(audit.filter((event) => event.operation === "replay-rejected"))
      .toHaveLength(1);

    expect(store.get({
      sessionId: control.anchor.sessionId,
      ticketId: control.ticketId,
      now: control.anchor.expiresAt,
    })).toBeNull();
    expect(store.abort(expectation, control.anchor.expiresAt)).toBeNull();
    expect(store.abort(expectation, control.anchor.expiresAt + 1)).toBeNull();
    expect(audit.filter((event) => event.operation === "replay-rejected"))
      .toHaveLength(1);
    expect(() => store.create({
      sessionId: control.anchor.sessionId,
      control,
      now: NOW + 2,
    })).toThrow(/invalid rationale control\/session binding/);
  });

  it("issues exactly one valid allow-once receipt after the CAS sequence", () => {
    const audit: RationaleTicketStoreAuditEvent[] = [];
    const store = new InProcessRationaleTicketStore({
      onAudit: (event) => audit.push(event),
    });
    const control = fixture("34725366-0fca-4f9b-8464-ee7e996d74c7", "receipt");
    const pending = toPendingReady(store, createStored(store, control));

    expect(() => store.transition({
      expectation: createRationaleTicketCasExpectation(pending),
      event: "allow-once" as never,
      now: NOW + 4,
    })).toThrow(/one-shot receipt/);

    const expectation = createRationaleTicketCasExpectation(pending);
    const receipt = store.consumeAllowOnce(expectation, NOW + 4);
    expect(receipt).not.toBeNull();
    validateHostConsumedAllowOnceReceipt(
      receipt as HostConsumedAllowOnceReceipt,
      control,
      (receipt as HostConsumedAllowOnceReceipt).ticket,
      NOW + 4,
    );
    expect(receipt).toMatchObject({
      kind: "host-consumed-allow-once-cas",
      ticketId: control.ticketId,
      actionDigest: control.action.actionDigest,
      invocationDigest: control.invocationDigest,
      ticket: { state: "allowed_once", terminalReason: "allowed-once" },
    });
    expect(store.get({
      sessionId: "34725366-0fca-4f9b-8464-ee7e996d74c7",
      ticketId: control.ticketId,
      now: NOW + 4,
    })).toBeNull();
    expect(store.isAuthenticConsumedAllowOnceReceipt(
      receipt as HostConsumedAllowOnceReceipt,
      NOW + 4,
    )).toBe(true);
    expect(store.consumeAllowOnce(expectation, NOW + 5)).toBeNull();

    const forged = {
      ...(receipt as HostConsumedAllowOnceReceipt),
      receiptId: "11111111-1111-4111-8111-111111111111",
    };
    expect(store.isAuthenticConsumedAllowOnceReceipt(forged, NOW + 5)).toBe(false);
    expect(audit.filter((event) => event.operation === "allow-once-consumed"))
      .toHaveLength(1);
    expect(audit.at(-1)).toMatchObject({
      operation: "replay-rejected",
      event: "stale-replay",
    });
  });

  it("issues exactly one reviewer-authorized-once receipt straight from rationale_ready", () => {
    const audit: RationaleTicketStoreAuditEvent[] = [];
    const store = new InProcessRationaleTicketStore({
      onAudit: (event) => audit.push(event),
    });
    const control = fixture("038f9292-1648-43cb-8d0b-a6673fb1b3d5", "reviewer-auto");
    const requested = required(store.requestRationale(
      createRationaleTicketCasExpectation(createStored(store, control)),
      NOW + 1,
    ));
    const ready = required(store.markRationaleReady(
      createRationaleTicketCasExpectation(requested),
      { generationOutcome: "accepted-rationale", reevaluationOutcome: "fresh" },
      NOW + 2,
    ));

    // The one-shot terminal cannot be driven through the generic transition API.
    expect(() => store.transition({
      expectation: createRationaleTicketCasExpectation(ready),
      event: "reviewer-authorize-once" as never,
      now: NOW + 3,
    })).toThrow(/one-shot receipt/);

    const expectation = createRationaleTicketCasExpectation(ready);
    const receipt = store.consumeReviewerAuthorizedOnce(expectation, NOW + 3);
    expect(receipt).not.toBeNull();
    validateHostConsumedAllowOnceReceipt(
      receipt as HostConsumedAllowOnceReceipt,
      control,
      (receipt as HostConsumedAllowOnceReceipt).ticket,
      NOW + 3,
    );
    expect(receipt).toMatchObject({
      kind: "host-consumed-allow-once-cas",
      ticketId: control.ticketId,
      actionDigest: control.action.actionDigest,
      invocationDigest: control.invocationDigest,
      ticket: {
        state: "allowed_once",
        terminalReason: "allowed-once",
        rationaleStatus: "ready",
      },
    });
    expect(store.isAuthenticConsumedAllowOnceReceipt(
      receipt as HostConsumedAllowOnceReceipt,
      NOW + 3,
    )).toBe(true);
    expect(store.get({
      sessionId: "038f9292-1648-43cb-8d0b-a6673fb1b3d5",
      ticketId: control.ticketId,
      now: NOW + 3,
    })).toBeNull();

    // Single-use: a second consume fails CAS (the ticket is already terminal).
    expect(store.consumeReviewerAuthorizedOnce(expectation, NOW + 4)).toBeNull();
    expect(audit.filter((event) =>
      event.operation === "reviewer-authorized-once-consumed"))
      .toHaveLength(1);
    expect(audit.some((event) =>
      event.operation === "reviewer-authorized-once-consumed" &&
      event.event === "reviewer-authorize-once")).toBe(true);
    expect(audit.at(-1)).toMatchObject({
      operation: "replay-rejected",
      event: "stale-replay",
    });
    expectAuditPayloadsAreSafe(audit);
  });

  it("handles failed rationale, deny, cancel, and expiry as terminal cleanup", () => {
    const store = new InProcessRationaleTicketStore({ onAudit: () => {} });

    const failedControl = fixture("61a38f06-4729-4bb1-8713-11bcfc344f5b", "failed");
    const failedInitial = createStored(store, failedControl);
    const requested = required(store.requestRationale(
      createRationaleTicketCasExpectation(failedInitial),
      NOW + 1,
    ));
    const failed = required(store.markRationaleFailed(
      createRationaleTicketCasExpectation(requested),
      { generationOutcome: "generation-timeout", reevaluationOutcome: null },
      NOW + 2,
    ));
    const failedPending = required(store.promptUser(
      createRationaleTicketCasExpectation(failed),
      NOW + 3,
    ));
    const denied = required(store.deny(
      createRationaleTicketCasExpectation(failedPending),
      NOW + 4,
    ));
    expect(denied.ticket).toMatchObject({
      state: "denied",
      rationaleStatus: "failed",
      terminalReason: "user-deny",
    });
    expect(store.get({
      sessionId: "61a38f06-4729-4bb1-8713-11bcfc344f5b",
      ticketId: failedControl.ticketId,
      now: NOW + 4,
    })).toBeNull();

    const cancelControl = fixture("5624fd6c-b8e0-4a21-8913-212ba5af311c", "cancel");
    const cancelPending = toPendingReady(store, createStored(store, cancelControl));
    const cancelled = required(store.cancel(
      createRationaleTicketCasExpectation(cancelPending),
      NOW + 4,
    ));
    expect(cancelled.ticket).toMatchObject({
      state: "cancelled",
      terminalReason: "user-cancel",
    });

    const timeoutControl = fixture("47b1f557-196f-46df-82f5-eebdcd474ee7", "timeout");
    const timeoutPending = toPendingReady(store, createStored(store, timeoutControl));
    const timedOut = required(store.modalTimeout(
      createRationaleTicketCasExpectation(timeoutPending),
      NOW + 4,
    ));
    expect(timedOut.ticket).toMatchObject({
      state: "cancelled",
      terminalReason: "modal-timeout",
    });

    const expireControl = fixture("74bc0b55-11e2-455a-8f0c-f0c62008c50f", "expire");
    createStored(store, expireControl);
    expect(store.get({
      sessionId: "74bc0b55-11e2-455a-8f0c-f0c62008c50f",
      ticketId: expireControl.ticketId,
      now: expireControl.anchor.expiresAt,
    })).toBeNull();
  });

  it("terminalizes stale version and identity mismatches without cross-session mutation", () => {
    const audit: RationaleTicketStoreAuditEvent[] = [];
    const store = new InProcessRationaleTicketStore({
      onAudit: (event) => audit.push(event),
    });

    const staleControl = fixture("9f9c6f7c-805d-4e10-8681-b887151bbcf3", "stale");
    const staleInitial = createStored(store, staleControl);
    const staleExpectation = createRationaleTicketCasExpectation(staleInitial);
    required(store.requestRationale(staleExpectation, NOW + 1));
    expect(store.requestRationale(staleExpectation, NOW + 2)).toBeNull();
    expect(store.get({
      sessionId: "9f9c6f7c-805d-4e10-8681-b887151bbcf3",
      ticketId: staleControl.ticketId,
      now: NOW + 2,
    })).toBeNull();
    expect(audit).toContainEqual(expect.objectContaining({
      event: "stale-replay",
      state: "rejected",
      terminalReason: "stale-replay",
    }));

    const identityControl = fixture("1b9a80fc-c4f3-4363-852b-277a64dac7bc", "identity");
    const identityInitial = createStored(store, identityControl);
    expect(store.requestRationale({
      ...createRationaleTicketCasExpectation(identityInitial),
      actionDigest: "0".repeat(64),
    }, NOW + 1)).toBeNull();
    expect(audit).toContainEqual(expect.objectContaining({
      ticketId: identityControl.ticketId,
      event: "identity-mismatch",
      terminalReason: "identity-mismatch",
    }));

    const scopedControl = fixture("d882c130-438a-4c28-81d6-200f91a8cd21", "owned");
    const scopedInitial = createStored(store, scopedControl);
    expect(store.requestRationale({
      ...createRationaleTicketCasExpectation(scopedInitial),
      sessionId: "30c6cee6-cac1-489d-8dae-f2f837ff17f6",
    }, NOW + 1)).toBeNull();
    expect(store.get({
      sessionId: "d882c130-438a-4c28-81d6-200f91a8cd21",
      ticketId: scopedControl.ticketId,
      now: NOW + 1,
    })).toBe(scopedInitial);
    required(store.abort(
      createRationaleTicketCasExpectation(scopedInitial),
      NOW + 2,
    ));
  });

  it("closes only the selected session and revokes its unused receipts", () => {
    const audit: RationaleTicketStoreAuditEvent[] = [];
    const store = new InProcessRationaleTicketStore({
      onAudit: (event) => audit.push(event),
    });
    const first = fixture("e8388133-375c-4f08-8f18-41665da4070f", "close-a");
    const second = fixture("e8388133-375c-4f08-8f18-41665da4070f", "close-b");
    const other = fixture("3bac543f-73e5-4d6a-8162-2013fa0c384e", "other");
    createStored(store, first);
    const secondInitial = createStored(store, second);
    required(store.requestRationale(
      createRationaleTicketCasExpectation(secondInitial),
      NOW + 1,
    ));
    const otherInitial = createStored(store, other);

    const closed = store.closeSession("e8388133-375c-4f08-8f18-41665da4070f", NOW + 5);
    expect(closed).toHaveLength(2);
    expect(closed.every((snapshot) =>
      snapshot.ticket.state === "cancelled" &&
      snapshot.ticket.terminalReason === "session-close"
    )).toBe(true);
    expect(store.get({
      sessionId: "e8388133-375c-4f08-8f18-41665da4070f",
      ticketId: first.ticketId,
      now: NOW + 5,
    })).toBeNull();
    expect(store.get({
      sessionId: "3bac543f-73e5-4d6a-8162-2013fa0c384e",
      ticketId: other.ticketId,
      now: NOW + 5,
    })).toBe(otherInitial);

    const receiptControl = fixture("e8388133-375c-4f08-8f18-41665da4070f", "close-receipt");
    const pending = toPendingReady(
      store,
      createStored(store, receiptControl, NOW + 6),
      NOW + 7,
    );
    const receipt = store.consumeAllowOnce(
      createRationaleTicketCasExpectation(pending),
      NOW + 10,
    ) as HostConsumedAllowOnceReceipt;
    expect(store.isAuthenticConsumedAllowOnceReceipt(receipt, NOW + 10)).toBe(true);
    expect(store.closeSession("e8388133-375c-4f08-8f18-41665da4070f", NOW + 11)).toEqual([]);
    expect(store.isAuthenticConsumedAllowOnceReceipt(receipt, NOW + 11)).toBe(false);
    expect(audit).toContainEqual(expect.objectContaining({
      operation: "receipt-revoked",
      event: "session-close",
      receiptId: receipt.receiptId,
    }));

    required(store.abort(
      createRationaleTicketCasExpectation(otherInitial),
      NOW + 12,
    ));
    expect(store.closeSession("e8388133-375c-4f08-8f18-41665da4070f", NOW + 13)).toEqual([]);
  });
  it.each([
    {
      label: "throws",
      failAudit: () => {
        throw new Error("audit unavailable");
      },
      expectedError: /audit unavailable/,
    },
    {
      label: "returns a thenable",
      failAudit: () => Promise.resolve(),
      expectedError: /audit sink must commit synchronously/,
    },
  ])(
    "does not create a ticket or session index when the audit sink $label",
    ({ failAudit, expectedError }) => {
      const audit: RationaleTicketStoreAuditEvent[] = [];
      let shouldFail = true;
      const store = new InProcessRationaleTicketStore({
        onAudit: (event) => {
          audit.push(event);
          if (shouldFail) return failAudit();
        },
      });
      const control = fixture("3cc929ba-6681-4a0e-85d0-5f27007283c9", "create-atomic");

      expect(() => createStored(store, control)).toThrow(expectedError);
      expect(store.activeTicketIds(control.anchor.sessionId)).toEqual([]);
      expect(store.get({
        sessionId: control.anchor.sessionId,
        ticketId: control.ticketId,
        now: NOW,
      })).toBeNull();

      shouldFail = false;
      const created = createStored(store, control);
      expect(created).toMatchObject({
        version: 0,
        ticket: { state: "review_required" },
      });
      expect(store.activeTicketIds(control.anchor.sessionId))
        .toEqual([control.ticketId]);
      expect(audit.filter((event) => event.operation === "created"))
        .toHaveLength(2);
      expectAuditPayloadsAreSafe(audit);
    },
  );

  it("keeps a normal transition unchanged when its audit write fails", () => {
    const audit: RationaleTicketStoreAuditEvent[] = [];
    let failTransition = false;
    const store = new InProcessRationaleTicketStore({
      onAudit: (event) => {
        audit.push(event);
        if (failTransition && event.operation === "transitioned") {
          throw new Error("transition audit unavailable");
        }
      },
    });
    const control = fixture("562ad4b1-ca6f-426f-8f49-f6545bfe6032", "transition-atomic");
    const initial = createStored(store, control);
    const expectation = createRationaleTicketCasExpectation(initial);

    failTransition = true;
    expect(() => store.requestRationale(expectation, NOW + 1))
      .toThrow(/transition audit unavailable/);
    expect(store.get({
      sessionId: control.anchor.sessionId,
      ticketId: control.ticketId,
      now: NOW + 1,
    })).toBe(initial);
    expect(store.activeTicketIds(control.anchor.sessionId))
      .toEqual([control.ticketId]);

    failTransition = false;
    const requested = required(store.requestRationale(expectation, NOW + 1));
    expect(requested).toMatchObject({
      version: 1,
      ticket: { state: "rationale_requested" },
    });
    expectAuditPayloadsAreSafe(audit);
  });

  it("commits no ticket or receipt mutation when allow-once audit fails", () => {
    const audit: RationaleTicketStoreAuditEvent[] = [];
    let failAllowOnce = false;
    const store = new InProcessRationaleTicketStore({
      onAudit: (event) => {
        audit.push(event);
        if (failAllowOnce && event.operation === "allow-once-consumed") {
          throw new Error("allow-once audit unavailable");
        }
      },
    });
    const control = fixture("21082466-2c6c-4822-8793-a670e5fa5b89", "allow-atomic");
    const pending = toPendingReady(store, createStored(store, control));
    const expectation = createRationaleTicketCasExpectation(pending);

    failAllowOnce = true;
    expect(() => store.consumeAllowOnce(expectation, NOW + 4))
      .toThrow(/allow-once audit unavailable/);
    expect(store.get({
      sessionId: control.anchor.sessionId,
      ticketId: control.ticketId,
      now: NOW + 4,
    })).toBe(pending);
    expect(store.activeTicketIds(control.anchor.sessionId))
      .toEqual([control.ticketId]);

    failAllowOnce = false;
    const receipt = store.consumeAllowOnce(
      expectation,
      NOW + 4,
    ) as HostConsumedAllowOnceReceipt;
    expect(receipt).toMatchObject({
      ticketId: control.ticketId,
      ticket: { state: "allowed_once" },
    });
    expect(store.isAuthenticConsumedAllowOnceReceipt(receipt, NOW + 5)).toBe(true);
    expect(store.consumeAllowOnce(expectation, NOW + 5)).toBeNull();

    expect(store.closeSession(control.anchor.sessionId, NOW + 6)).toEqual([]);
    expect(store.isAuthenticConsumedAllowOnceReceipt(receipt, NOW + 6)).toBe(false);
    expect(audit.filter((event) => event.operation === "receipt-revoked"))
      .toHaveLength(1);
    expectAuditPayloadsAreSafe(audit);
  });

  it("retains an allow-once receipt when session-close revoke audit fails", () => {
    const audit: RationaleTicketStoreAuditEvent[] = [];
    let failReceiptRevoke = false;
    const store = new InProcessRationaleTicketStore({
      onAudit: (event) => {
        audit.push(event);
        if (failReceiptRevoke && event.operation === "receipt-revoked") {
          throw new Error("receipt revoke audit unavailable");
        }
      },
    });
    const control = fixture("92b3fd65-f3e3-4ddb-8f55-0be10a9fd667", "revoke-atomic");
    const pending = toPendingReady(store, createStored(store, control));
    const receipt = store.consumeAllowOnce(
      createRationaleTicketCasExpectation(pending),
      NOW + 4,
    ) as HostConsumedAllowOnceReceipt;

    failReceiptRevoke = true;
    expect(() => store.closeSession(control.anchor.sessionId, NOW + 5))
      .toThrow(/receipt revoke audit unavailable/);
    expect(store.isAuthenticConsumedAllowOnceReceipt(receipt, NOW + 5)).toBe(true);

    failReceiptRevoke = false;
    expect(store.closeSession(control.anchor.sessionId, NOW + 6)).toEqual([]);
    expect(store.isAuthenticConsumedAllowOnceReceipt(receipt, NOW + 6)).toBe(false);
    expect(audit.filter((event) => event.operation === "receipt-revoked"))
      .toHaveLength(2);
    expectAuditPayloadsAreSafe(audit);
  });

  it("keeps the active ticket and creates no tombstone when terminal audit fails", () => {
    const audit: RationaleTicketStoreAuditEvent[] = [];
    let failRetirement = false;
    const store = new InProcessRationaleTicketStore({
      onAudit: (event) => {
        audit.push(event);
        if (failRetirement && event.operation === "retired") {
          throw new Error("terminal audit unavailable");
        }
      },
    });
    const control = fixture("fee7bcfe-4b02-47f1-8275-ad0bd3d6e8c9", "terminal-atomic");
    const initial = createStored(store, control);
    const expectation = createRationaleTicketCasExpectation(initial);

    failRetirement = true;
    expect(() => store.abort(expectation, NOW + 1))
      .toThrow(/terminal audit unavailable/);
    expect(store.get({
      sessionId: control.anchor.sessionId,
      ticketId: control.ticketId,
      now: NOW + 1,
    })).toBe(initial);
    expect(store.activeTicketIds(control.anchor.sessionId))
      .toEqual([control.ticketId]);

    failRetirement = false;
    const terminal = required(store.abort(expectation, NOW + 1));
    expect(terminal).toMatchObject({
      version: 1,
      ticket: { state: "cancelled", terminalReason: "caller-abort" },
    });
    expect(store.get({
      sessionId: control.anchor.sessionId,
      ticketId: control.ticketId,
      now: NOW + 1,
    })).toBeNull();
    expect(store.activeTicketIds(control.anchor.sessionId)).toEqual([]);
    expectAuditPayloadsAreSafe(audit);
  });
});

describe("RATIONALE_TICKET_TERMINAL_STATES", () => {
  it("lists the states a ticket never leaves", () => {
    expect([...RATIONALE_TICKET_TERMINAL_STATES].sort()).toEqual(["allowed_once", "cancelled", "denied", "expired", "rejected"]);
  });
});

describe("InProcessRationaleTicketStore — session id rule is the host's", () => {
  it("rejects a 257-character id the old length-only check accepted, accepts a namespaced one", () => {
    const store = new InProcessRationaleTicketStore({ onAudit: () => {} });
    expect(() => createStored(store, fixture("a".repeat(256), "long")))
      .toThrow(/invalid rationale ticket session id/);
    const namespaced = "sub-x-12434f55-fbb9-4a54-b1a7-fb9638d8eebd";
    createStored(store, fixture(namespaced, "namespaced"));
    expect(store.activeTicketIds(namespaced)).toHaveLength(1);
  });
});
