import { createHash, randomUUID } from "node:crypto";
import { canonicalStringify } from "../../permissions/user-approval-store.js";
import {
  RATIONALE_CONTROL_CONTRACT_VERSION,
  assertRationaleCanonicalJson,
  cloneRationaleCanonicalJson,
  verifyRationaleRequiredControl,
  type RationaleRequiredControl,
} from "./rationale-control.js";
import {
  REVIEWER_REEVALUATION_FAILURE_OUTCOMES,
  type ReviewerReevaluationOutcome,
} from "./rationale-pr1-contract.js";

function seal<T>(value: T, label: string): T {
  return cloneRationaleCanonicalJson(value, label) as T;
}

function exact(value: object, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((v, i) => v !== wanted[i])) {
    throw new TypeError(label + " contains unexpected or missing fields");
  }
}

export type RationaleTicketState =
  | "review_required" | "rationale_requested" | "rationale_ready"
  | "rationale_failed" | "user_pending" | "allowed_once" | "denied"
  | "cancelled" | "expired" | "rejected";

export type RationaleStatus = "not-requested" | "pending" | "ready" | "failed";

export type RationaleTerminalReason =
  | "allowed-once" | "user-deny" | "user-cancel" | "modal-timeout"
  | "caller-abort" | "session-close" | "identity-mismatch"
  | "stale-replay" | "expired";

export interface RationaleTicketStateRecord {
  contractVersion: typeof RATIONALE_CONTROL_CONTRACT_VERSION;
  ticketId: string;
  actionDigest: string;
  state: RationaleTicketState;
  rationaleStatus: RationaleStatus;
  reevaluationOutcome: ReviewerReevaluationOutcome | null;
  terminalReason: RationaleTerminalReason | null;
}

/**
 * Opaque receipt loaded from the host-owned one-shot CAS store after it
 * consumes an allow-once resolution. Structural validation is not
 * authenticity: callers MUST supply the receipt from that trusted store.
 */
export interface HostConsumedAllowOnceReceipt {
  contractVersion: typeof RATIONALE_CONTROL_CONTRACT_VERSION;
  kind: "host-consumed-allow-once-cas";
  receiptId: string;
  ticketId: string;
  actionDigest: string;
  invocationDigest: string;
  consumedAt: number;
  ticket: RationaleTicketStateRecord;
}

function equal(left: unknown, right: unknown): boolean {
  return canonicalStringify(left) === canonicalStringify(right);
}

export type RationaleTicketEventName =
  | "request-rationale" | "rationale-ready" | "rationale-failed" | "prompt-user"
  | "allow-once" | "deny" | "cancel" | "modal-timeout" | "abort"
  | "session-close" | "identity-mismatch" | "stale-replay" | "expire";

export interface RationaleTicketEvent {
  contractVersion: typeof RATIONALE_CONTROL_CONTRACT_VERSION;
  ticketId: string;
  actionDigest: string;
  event: RationaleTicketEventName;
  reevaluationOutcome: ReviewerReevaluationOutcome | null;
}

const STATE_NAMES: readonly RationaleTicketState[] = [
  "review_required", "rationale_requested", "rationale_ready", "rationale_failed",
  "user_pending", "allowed_once", "denied", "cancelled", "expired", "rejected",
];

const STATUS_NAMES: readonly RationaleStatus[] = [
  "not-requested", "pending", "ready", "failed",
];

const TERMINAL_STATES: readonly RationaleTicketState[] = [
  "allowed_once", "denied", "cancelled", "expired", "rejected",
];

const EVENT_NAMES: readonly RationaleTicketEventName[] = [
  "request-rationale", "rationale-ready", "rationale-failed", "prompt-user",
  "allow-once", "deny", "cancel", "modal-timeout", "abort", "session-close",
  "identity-mismatch", "stale-replay", "expire",
];

export function createRationaleReviewRequiredRecord(
  control: RationaleRequiredControl, now = Date.now(),
): RationaleTicketStateRecord {
  if (!verifyRationaleRequiredControl(control, { now })) {
    throw new Error("invalid or expired rationale control");
  }
  return seal({ contractVersion: RATIONALE_CONTROL_CONTRACT_VERSION,
    ticketId: control.ticketId, actionDigest: control.action.actionDigest,
    state: "review_required", rationaleStatus: "not-requested",
    reevaluationOutcome: null, terminalReason: null,
  }, "RationaleTicketStateRecord");
}

export function createRationaleTicketEvent(
  control: RationaleRequiredControl,
  event: RationaleTicketEventName,
  reevaluationOutcome: ReviewerReevaluationOutcome | null =
    event === "rationale-ready" ? "fresh" : null,
): RationaleTicketEvent {
  if (!EVENT_NAMES.includes(event)) throw new TypeError("invalid rationale ticket event");
  const isFailure = REVIEWER_REEVALUATION_FAILURE_OUTCOMES.includes(
    reevaluationOutcome as never,
  );
  if ((event === "rationale-ready" && reevaluationOutcome !== "fresh") ||
      (event === "rationale-failed" && !isFailure) ||
      (!["rationale-ready", "rationale-failed"].includes(event) &&
        reevaluationOutcome !== null)) {
    throw new TypeError("rationale ticket event/outcome mismatch");
  }
  return seal({ contractVersion: RATIONALE_CONTROL_CONTRACT_VERSION,
    ticketId: control.ticketId, actionDigest: control.action.actionDigest, event,
    reevaluationOutcome,
  }, "RationaleTicketEvent");
}

export function validateRationaleTicketRecord(record: RationaleTicketStateRecord): void {
  assertRationaleCanonicalJson(record, "RationaleTicketStateRecord");
  exact(record, ["contractVersion", "ticketId", "actionDigest", "state",
    "rationaleStatus", "reevaluationOutcome", "terminalReason"],
    "RationaleTicketStateRecord");
  if (record.contractVersion !== RATIONALE_CONTROL_CONTRACT_VERSION ||
      typeof record.ticketId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        .test(record.ticketId) ||
      !/^[0-9a-f]{64}$/.test(record.actionDigest) ||
      !STATE_NAMES.includes(record.state) || !STATUS_NAMES.includes(record.rationaleStatus)) {
    throw new TypeError("invalid rationale ticket binding");
  }
  const failureOutcome = REVIEWER_REEVALUATION_FAILURE_OUTCOMES.includes(
    record.reevaluationOutcome as never,
  );
  if ((record.rationaleStatus === "ready" && record.reevaluationOutcome !== "fresh") ||
      (record.rationaleStatus === "failed" && !failureOutcome) ||
      (["not-requested", "pending"].includes(record.rationaleStatus) &&
        record.reevaluationOutcome !== null)) {
    throw new TypeError("rationale status/reevaluation outcome mismatch");
  }
  if (record.state === "review_required" &&
      (record.rationaleStatus !== "not-requested" || record.terminalReason !== null)) {
    throw new TypeError("invalid review_required status");
  }
  if (record.state === "rationale_requested" &&
      (record.rationaleStatus !== "pending" || record.terminalReason !== null)) {
    throw new TypeError("invalid rationale_requested status");
  }
  if (record.state === "rationale_ready" &&
      (record.rationaleStatus !== "ready" || record.terminalReason !== null)) {
    throw new TypeError("invalid rationale_ready status");
  }
  if (record.state === "rationale_failed" &&
      (record.rationaleStatus !== "failed" || record.terminalReason !== null)) {
    throw new TypeError("invalid rationale_failed status");
  }
  if (record.state === "user_pending" &&
      (!["ready", "failed"].includes(record.rationaleStatus) || record.terminalReason !== null)) {
    throw new TypeError("invalid user_pending status");
  }
  const reasonByState: Partial<Record<RationaleTicketState, readonly RationaleTerminalReason[]>> = {
    allowed_once: ["allowed-once"], denied: ["user-deny"],
    cancelled: ["user-cancel", "modal-timeout", "caller-abort", "session-close"],
    rejected: ["identity-mismatch", "stale-replay"], expired: ["expired"],
  };
  if ((record.state === "allowed_once" || record.state === "denied") &&
      !["ready", "failed"].includes(record.rationaleStatus)) {
    throw new TypeError("authorization terminal requires a reviewed rationale status");
  }

  if (TERMINAL_STATES.includes(record.state) &&
      !reasonByState[record.state]?.includes(record.terminalReason as RationaleTerminalReason)) {
    throw new TypeError("terminal state/reason mismatch");
  }
}


export function validateHostConsumedAllowOnceReceipt(
  receipt: HostConsumedAllowOnceReceipt,
  control: RationaleRequiredControl,
  embeddedTicket: RationaleTicketStateRecord,
  now = Date.now(),
): void {
  if (!verifyRationaleRequiredControl(control, { now })) {
    throw new Error("invalid or expired rationale control");
  }
  assertRationaleCanonicalJson(receipt, "HostConsumedAllowOnceReceipt");
  exact(receipt, ["contractVersion", "kind", "receiptId", "ticketId",
    "actionDigest", "invocationDigest", "consumedAt", "ticket"],
    "HostConsumedAllowOnceReceipt");
  validateRationaleTicketRecord(embeddedTicket);
  validateRationaleTicketRecord(receipt.ticket);
  if (receipt.contractVersion !== RATIONALE_CONTROL_CONTRACT_VERSION ||
      receipt.kind !== "host-consumed-allow-once-cas" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        .test(receipt.receiptId) ||
      receipt.ticketId !== control.ticketId ||
      receipt.actionDigest !== control.action.actionDigest ||
      receipt.invocationDigest !== control.invocationDigest ||
      receipt.ticketId !== embeddedTicket.ticketId ||
      receipt.actionDigest !== embeddedTicket.actionDigest ||
      embeddedTicket.state !== "allowed_once" ||
      embeddedTicket.terminalReason !== "allowed-once" ||
      !equal(receipt.ticket, embeddedTicket) ||
      !Number.isFinite(receipt.consumedAt) ||
      receipt.consumedAt < control.anchor.createdAt || receipt.consumedAt > now) {
    throw new Error("host consumed allow-once receipt binding mismatch");
  }
}
function next(record: RationaleTicketStateRecord, state: RationaleTicketState,
  rationaleStatus: RationaleStatus,
  reevaluationOutcome: ReviewerReevaluationOutcome | null,
  terminalReason: RationaleTerminalReason | null,
): RationaleTicketStateRecord {
  return seal({ contractVersion: RATIONALE_CONTROL_CONTRACT_VERSION,
    ticketId: record.ticketId, actionDigest: record.actionDigest,
    state, rationaleStatus, reevaluationOutcome, terminalReason },
    "RationaleTicketStateRecord");
}

export function transitionRationaleTicket(
  record: RationaleTicketStateRecord, event: RationaleTicketEvent,
): RationaleTicketStateRecord {
  validateRationaleTicketRecord(record);
  assertRationaleCanonicalJson(event, "RationaleTicketEvent");
  exact(event, ["contractVersion", "ticketId", "actionDigest", "event",
    "reevaluationOutcome"],
    "RationaleTicketEvent");
  if (event.contractVersion !== RATIONALE_CONTROL_CONTRACT_VERSION ||
      event.ticketId !== record.ticketId || event.actionDigest !== record.actionDigest ||
      !EVENT_NAMES.includes(event.event)) {
    throw new Error("ticket/action/event binding mismatch");
  }
  const eventFailure = REVIEWER_REEVALUATION_FAILURE_OUTCOMES.includes(
    event.reevaluationOutcome as never,
  );
  if ((event.event === "rationale-ready" && event.reevaluationOutcome !== "fresh") ||
      (event.event === "rationale-failed" && !eventFailure) ||
      (!["rationale-ready", "rationale-failed"].includes(event.event) &&
        event.reevaluationOutcome !== null)) {
    throw new Error("ticket event/outcome binding mismatch");
  }
  if (TERMINAL_STATES.includes(record.state)) {
    throw new Error("terminal rationale ticket rejects every event");
  }
  switch (event.event) {
    case "abort": return next(record, "cancelled", record.rationaleStatus,
      record.reevaluationOutcome, "caller-abort");
    case "session-close":
      return next(record, "cancelled", record.rationaleStatus,
        record.reevaluationOutcome, "session-close");
    case "identity-mismatch":
      return next(record, "rejected", record.rationaleStatus,
        record.reevaluationOutcome, "identity-mismatch");
    case "stale-replay":
      return next(record, "rejected", record.rationaleStatus,
        record.reevaluationOutcome, "stale-replay");
    case "expire": return next(record, "expired", record.rationaleStatus,
      record.reevaluationOutcome, "expired");
    default: break;
  }
  const key = record.state + ":" + event.event;
  switch (key) {
    case "review_required:request-rationale":
      return next(record, "rationale_requested", "pending", null, null);
    case "rationale_requested:rationale-ready":
      return next(record, "rationale_ready", "ready", "fresh", null);
    case "rationale_requested:rationale-failed":
      return next(record, "rationale_failed", "failed", event.reevaluationOutcome, null);
    case "rationale_ready:prompt-user":
    case "rationale_failed:prompt-user":
      return next(record, "user_pending", record.rationaleStatus,
        record.reevaluationOutcome, null);
    case "user_pending:allow-once":
      return next(record, "allowed_once", record.rationaleStatus,
        record.reevaluationOutcome, "allowed-once");
    case "user_pending:deny":
      return next(record, "denied", record.rationaleStatus,
        record.reevaluationOutcome, "user-deny");
    case "user_pending:cancel":
      return next(record, "cancelled", record.rationaleStatus,
        record.reevaluationOutcome, "user-cancel");
    case "user_pending:modal-timeout":
      return next(record, "cancelled", record.rationaleStatus,
        record.reevaluationOutcome, "modal-timeout");
    default: throw new Error("invalid rationale ticket transition: " + key);
  }
}

export type InvocationAuditState =
  "authorized" | "started" | "completed" | "failed" | "unknown-after-crash";

export interface InvocationAuditRecord {
  contractVersion: typeof RATIONALE_CONTROL_CONTRACT_VERSION;
  ticketId: string; actionDigest: string; invocationDigest: string; toolUseId: string;
  authorizationReceiptId: string;
  invocationStartLeaseId: string | null;
  version: 0 | 1 | 2;
  state: InvocationAuditState;
  automaticRetry: "forbidden";
}

export type InvocationAuditEventName = "complete" | "fail" | "crash-recovery";

export interface InvocationAuditEvent {
  contractVersion: typeof RATIONALE_CONTROL_CONTRACT_VERSION;
  ticketId: string; actionDigest: string; invocationDigest: string;
  authorizationReceiptId: string;
  invocationStartLeaseId: string;
  expectedInvocationVersion: 1;
  event: InvocationAuditEventName;
}

export interface HostInvocationStartLease {
  contractVersion: typeof RATIONALE_CONTROL_CONTRACT_VERSION;
  kind: "host-invocation-start-cas-lease";
  leaseId: string;
  ticketId: string;
  actionDigest: string;
  invocationDigest: string;
  toolUseId: string;
  authorizationReceiptId: string;
  authorizedRecordDigest: string;
  expectedInvocationVersion: 0;
  committedInvocationVersion: 1;
  startedAt: number;
}

/**
 * Host-owned atomic store boundary. A lease is an opaque result loaded from
 * this trusted store; its canonical fields are consistency bindings, not a
 * caller-verifiable authenticity primitive.
 */
export interface HostInvocationStartCas {
  tryStart(input: {
    authorized: InvocationAuditRecord;
    expectedInvocationVersion: 0;
    now?: number;
  }): HostInvocationStartLease | null;
  consumeStartLease(lease: HostInvocationStartLease): boolean;
  markTerminal(lease: HostInvocationStartLease, terminal: InvocationAuditRecord): boolean;
}

const INVOCATION_STATES: readonly InvocationAuditState[] = [
  "authorized", "started", "completed", "failed", "unknown-after-crash",
];
const INVOCATION_EVENTS: readonly InvocationAuditEventName[] = [
  "complete", "fail", "crash-recovery",
];
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function invocationRecordDigest(record: InvocationAuditRecord): string {
  return createHash("sha256").update(canonicalStringify(record)).digest("hex");
}

export function validateInvocationAuditRecord(record: InvocationAuditRecord): void {
  assertRationaleCanonicalJson(record, "InvocationAuditRecord");
  exact(record, ["contractVersion", "ticketId", "actionDigest", "invocationDigest",
    "toolUseId", "authorizationReceiptId", "invocationStartLeaseId", "version",
    "state", "automaticRetry"], "InvocationAuditRecord");
  if (record.contractVersion !== RATIONALE_CONTROL_CONTRACT_VERSION ||
      !UUID_PATTERN.test(record.ticketId) ||
      !/^[0-9a-f]{64}$/.test(record.actionDigest) ||
      !/^[0-9a-f]{64}$/.test(record.invocationDigest) ||
      typeof record.toolUseId !== "string" || !record.toolUseId ||
      !UUID_PATTERN.test(record.authorizationReceiptId) ||
      !INVOCATION_STATES.includes(record.state) || record.automaticRetry !== "forbidden") {
    throw new TypeError("invalid invocation audit record");
  }
  const authorized = record.state === "authorized" && record.version === 0 &&
    record.invocationStartLeaseId === null;
  const started = record.state === "started" && record.version === 1 &&
    typeof record.invocationStartLeaseId === "string" &&
    UUID_PATTERN.test(record.invocationStartLeaseId);
  const terminal = ["completed", "failed", "unknown-after-crash"].includes(record.state) &&
    record.version === 2 && typeof record.invocationStartLeaseId === "string" &&
    UUID_PATTERN.test(record.invocationStartLeaseId);
  if (!authorized && !started && !terminal) {
    throw new TypeError("invocation audit state/version/lease mismatch");
  }
}

function validateHostInvocationStartLeaseShape(lease: HostInvocationStartLease): void {
  assertRationaleCanonicalJson(lease, "HostInvocationStartLease");
  exact(lease, ["contractVersion", "kind", "leaseId", "ticketId", "actionDigest",
    "invocationDigest", "toolUseId", "authorizationReceiptId",
    "authorizedRecordDigest", "expectedInvocationVersion",
    "committedInvocationVersion", "startedAt"], "HostInvocationStartLease");
  if (lease.contractVersion !== RATIONALE_CONTROL_CONTRACT_VERSION ||
      lease.kind !== "host-invocation-start-cas-lease" ||
      !UUID_PATTERN.test(lease.leaseId) || !UUID_PATTERN.test(lease.ticketId) ||
      !/^[0-9a-f]{64}$/.test(lease.actionDigest) ||
      !/^[0-9a-f]{64}$/.test(lease.invocationDigest) ||
      typeof lease.toolUseId !== "string" || !lease.toolUseId ||
      !UUID_PATTERN.test(lease.authorizationReceiptId) ||
      !/^[0-9a-f]{64}$/.test(lease.authorizedRecordDigest) ||
      lease.expectedInvocationVersion !== 0 || lease.committedInvocationVersion !== 1 ||
      !Number.isFinite(lease.startedAt) || lease.startedAt < 0) {
    throw new TypeError("invalid host invocation-start CAS lease");
  }
}

export function validateHostInvocationStartLease(
  lease: HostInvocationStartLease,
  authorized: InvocationAuditRecord,
  now = Date.now(),
): void {
  validateInvocationAuditRecord(authorized);
  validateHostInvocationStartLeaseShape(lease);
  if (!Number.isFinite(now) ||
      authorized.state !== "authorized" || authorized.version !== 0 ||
      lease.ticketId !== authorized.ticketId ||
      lease.actionDigest !== authorized.actionDigest ||
      lease.invocationDigest !== authorized.invocationDigest ||
      lease.toolUseId !== authorized.toolUseId ||
      lease.authorizationReceiptId !== authorized.authorizationReceiptId ||
      lease.authorizedRecordDigest !== invocationRecordDigest(authorized) ||
      lease.startedAt > now) {
    throw new Error("host invocation-start CAS lease binding mismatch");
  }
}

export class InMemoryHostInvocationStartCasStore implements HostInvocationStartCas {
  readonly #states = new Map<string, {
    lease: HostInvocationStartLease;
    state: "leased" | "started" | "terminal";
  }>();

  tryStart(input: {
    authorized: InvocationAuditRecord;
    expectedInvocationVersion: 0;
    now?: number;
  }): HostInvocationStartLease | null {
    const now = input.now ?? Date.now();
    validateInvocationAuditRecord(input.authorized);
    if (input.expectedInvocationVersion !== 0 ||
        input.authorized.state !== "authorized" || input.authorized.version !== 0 ||
        !Number.isFinite(now)) {
      throw new Error("invalid invocation-start CAS expectation");
    }
    if (this.#states.has(input.authorized.invocationDigest)) return null;
    const lease = seal({
      contractVersion: RATIONALE_CONTROL_CONTRACT_VERSION,
      kind: "host-invocation-start-cas-lease", leaseId: randomUUID(),
      ticketId: input.authorized.ticketId, actionDigest: input.authorized.actionDigest,
      invocationDigest: input.authorized.invocationDigest,
      toolUseId: input.authorized.toolUseId,
      authorizationReceiptId: input.authorized.authorizationReceiptId,
      authorizedRecordDigest: invocationRecordDigest(input.authorized),
      expectedInvocationVersion: 0, committedInvocationVersion: 1, startedAt: now,
    }, "HostInvocationStartLease") as HostInvocationStartLease;
    this.#states.set(input.authorized.invocationDigest, { lease, state: "leased" });
    return lease;
  }

  consumeStartLease(lease: HostInvocationStartLease): boolean {
    try {
      validateHostInvocationStartLeaseShape(lease);
      const current = this.#states.get(lease.invocationDigest);
      if (!current || current.state !== "leased" || !equal(current.lease, lease)) {
        return false;
      }
      current.state = "started";
      return true;
    } catch {
      return false;
    }
  }

  markTerminal(lease: HostInvocationStartLease, terminal: InvocationAuditRecord): boolean {
    try {
      validateHostInvocationStartLeaseShape(lease);
      validateInvocationAuditRecord(terminal);
      const current = this.#states.get(lease.invocationDigest);
      if (!current || current.state !== "started" || !equal(current.lease, lease) ||
          !["completed", "failed", "unknown-after-crash"].includes(terminal.state) ||
          terminal.version !== 2 || terminal.invocationStartLeaseId !== lease.leaseId ||
          terminal.ticketId !== lease.ticketId || terminal.actionDigest !== lease.actionDigest ||
          terminal.invocationDigest !== lease.invocationDigest ||
          terminal.toolUseId !== lease.toolUseId ||
          terminal.authorizationReceiptId !== lease.authorizationReceiptId) return false;
      current.state = "terminal";
      return true;
    } catch {
      return false;
    }
  }
}

export function createAuthorizedInvocationAudit(input: {
  control: RationaleRequiredControl;
  ticket: RationaleTicketStateRecord;
  hostConsumedAllowOnceReceipt: HostConsumedAllowOnceReceipt;
  now?: number;
}): InvocationAuditRecord {
  const now = input.now ?? Date.now();
  if (!verifyRationaleRequiredControl(input.control, { now })) {
    throw new Error("invalid or expired rationale control");
  }
  validateRationaleTicketRecord(input.ticket);
  validateHostConsumedAllowOnceReceipt(
    input.hostConsumedAllowOnceReceipt, input.control, input.ticket, now,
  );
  if (input.ticket.ticketId !== input.control.ticketId ||
      input.ticket.actionDigest !== input.control.action.actionDigest ||
      input.ticket.state !== "allowed_once") {
    throw new Error("authorization CAS binding mismatch");
  }
  return seal({ contractVersion: RATIONALE_CONTROL_CONTRACT_VERSION,
    ticketId: input.control.ticketId, actionDigest: input.control.action.actionDigest,
    invocationDigest: input.control.invocationDigest,
    toolUseId: input.control.sealedAction.toolUseId,
    authorizationReceiptId: input.hostConsumedAllowOnceReceipt.receiptId,
    invocationStartLeaseId: null, version: 0, state: "authorized",
    automaticRetry: "forbidden" }, "InvocationAuditRecord");
}

export function createInvocationStartedAudit(input: {
  authorized: InvocationAuditRecord;
  startLease: HostInvocationStartLease;
  hostStartCas: HostInvocationStartCas;
  now?: number;
}): InvocationAuditRecord {
  const now = input.now ?? Date.now();
  validateHostInvocationStartLease(input.startLease, input.authorized, now);
  if (!input.hostStartCas.consumeStartLease(input.startLease)) {
    throw new Error("invocation-start lease was already consumed or is not current");
  }
  return seal({ ...input.authorized, invocationStartLeaseId: input.startLease.leaseId,
    version: 1, state: "started" }, "InvocationAuditRecord");
}

export function createInvocationAuditEvent(
  record: InvocationAuditRecord, event: InvocationAuditEventName,
): InvocationAuditEvent {
  if (!INVOCATION_EVENTS.includes(event)) {
    throw new TypeError("invalid invocation audit event");
  }
  validateInvocationAuditRecord(record);
  if (record.state !== "started" || record.version !== 1 ||
      record.invocationStartLeaseId === null) {
    throw new Error("terminal invocation event requires a started lease");
  }
  return seal({ contractVersion: RATIONALE_CONTROL_CONTRACT_VERSION,
    ticketId: record.ticketId, actionDigest: record.actionDigest,
    invocationDigest: record.invocationDigest,
    authorizationReceiptId: record.authorizationReceiptId,
    invocationStartLeaseId: record.invocationStartLeaseId,
    expectedInvocationVersion: 1, event }, "InvocationAuditEvent");
}

export function transitionInvocationAudit(
  record: InvocationAuditRecord, event: InvocationAuditEvent,
): InvocationAuditRecord {
  validateInvocationAuditRecord(record);
  assertRationaleCanonicalJson(event, "InvocationAuditEvent");
  exact(event, ["contractVersion", "ticketId", "actionDigest", "invocationDigest",
    "authorizationReceiptId", "invocationStartLeaseId", "expectedInvocationVersion",
    "event"], "InvocationAuditEvent");
  if (event.contractVersion !== RATIONALE_CONTROL_CONTRACT_VERSION ||
      event.ticketId !== record.ticketId || event.actionDigest !== record.actionDigest ||
      event.invocationDigest !== record.invocationDigest ||
      event.authorizationReceiptId !== record.authorizationReceiptId ||
      event.invocationStartLeaseId !== record.invocationStartLeaseId ||
      event.expectedInvocationVersion !== 1 || record.state !== "started" ||
      record.version !== 1 ||
      !INVOCATION_EVENTS.includes(event.event)) {
    throw new Error("invocation audit binding mismatch");
  }
  const states: Record<InvocationAuditEventName, InvocationAuditState> = {
    complete: "completed", fail: "failed", "crash-recovery": "unknown-after-crash",
  };
  return seal({ ...record, version: 2, state: states[event.event] },
    "InvocationAuditRecord");
}
