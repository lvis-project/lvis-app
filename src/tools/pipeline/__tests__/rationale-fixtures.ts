/**
 * The two rationale-control artifacts every foreground-rationale suite starts
 * from: the request anchor a turn is bound to, and the response a scripted
 * model returns for a control.
 *
 * Both have one correct shape — `createRequestAnchor` refuses anything that is
 * not a keyboard-originated turn and returns `null` rather than throwing, and
 * the response is the contract the host re-evaluates against. Six suites had
 * written them out; what actually differed between the copies were the
 * identifiers and the suggestion text, which stay with the caller.
 *
 * Here rather than in `src/__tests__/test-helpers.ts` because these name the
 * rationale-control domain: the general helper file is loaded by renderer and
 * boot suites that have no business pulling `rationale-control.ts` in with it.
 */
import { randomUUID } from "node:crypto";
import {
  createRequestAnchor,
  RATIONALE_CONTROL_CONTRACT_VERSION,
  type RationaleRequiredControl,
  type RequestAnchor,
} from "../rationale-control.js";
import type { InvocationAuditRecord } from "../rationale-ticket-lifecycle.js";

type RequestAnchorInput = Parameters<typeof createRequestAnchor>[0];

/**
 * A valid request anchor, or a thrown error — a suite that got `null` here has
 * a broken fixture, not a case to handle, and every copy of this said so.
 */
export function createTestRequestAnchor(
  overrides: Partial<RequestAnchorInput> = {},
): RequestAnchor {
  const anchor = createRequestAnchor({
    sessionId: "session-rationale",
    turnId: "turn-rationale",
    inputMessageId: "message-rationale",
    inputOrigin: "user-keyboard",
    rawIntent: "Perform the requested operation.",
    ...overrides,
  });
  if (!anchor) throw new Error("test request anchor was not created");
  return anchor;
}

/** The rationale a scripted model returns for `control`, at round 1. */
export function rationaleResponseFor(
  control: RationaleRequiredControl,
  suggestion: string,
) {
  return {
    contractVersion: 1,
    anchorId: control.anchor.anchorId,
    ticketId: control.ticketId,
    actionDigest: control.action.actionDigest,
    round: 1,
    suggestion,
  } as const;
}

/**
 * The invocation record an authorized tool call writes to the audit log.
 *
 * `authorized` with `automaticRetry: "forbidden"` is the only combination a
 * real authorization produces, so it is the shape rather than a parameter; the
 * identifiers a suite needs to recognize its own record — a `toolUseId` it
 * matches against a triggering call — come in through `overrides`.
 */
export function authorizedInvocationRecord(
  overrides: Partial<InvocationAuditRecord> = {},
): InvocationAuditRecord {
  return {
    contractVersion: RATIONALE_CONTROL_CONTRACT_VERSION,
    ticketId: randomUUID(),
    actionDigest: "c".repeat(64),
    invocationDigest: "d".repeat(64),
    toolUseId: "tool-use-authorized",
    authorizationReceiptId: randomUUID(),
    invocationStartLeaseId: null,
    version: 0,
    state: "authorized",
    automaticRetry: "forbidden",
    ...overrides,
  };
}
