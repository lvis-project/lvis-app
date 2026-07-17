import { randomUUID } from "node:crypto";
import { canonicalStringify } from "../../permissions/user-approval-store.js";
import {
  RATIONALE_CONTROL_CONTRACT_VERSION,
  cloneRationaleCanonicalJson,
  verifyRationaleRequiredControl,
  type RationaleRequiredControl,
} from "./rationale-control.js";
import {
  createRationaleReviewRequiredRecord,
  createRationaleTicketEvent,
  transitionRationaleTicket,
  validateHostConsumedAllowOnceReceipt,
  validateRationaleTicketRecord,
  type HostConsumedAllowOnceReceipt,
  type RationaleTerminalReason,
  type RationaleTicketEventName,
  type RationaleTicketResolvedOutcomes,
  type RationaleTicketState,
  type RationaleTicketStateRecord,
} from "./rationale-ticket-lifecycle.js";

function seal<T>(value: T, label: string): T {
  return cloneRationaleCanonicalJson(value, label) as T;
}

const TICKET_STATES: readonly RationaleTicketState[] = [
  "review_required",
  "rationale_requested",
  "rationale_ready",
  "rationale_failed",
  "user_pending",
  "allowed_once",
  "denied",
  "cancelled",
  "expired",
  "rejected",
];

const TERMINAL_STATES: readonly RationaleTicketState[] = [
  "allowed_once",
  "denied",
  "cancelled",
  "expired",
  "rejected",
];

const EXPIRY_SAFE_EVENTS: readonly RationaleTicketEventName[] = [
  "abort",
  "session-close",
  "identity-mismatch",
  "stale-replay",
  "expire",
];

export interface HostRationaleTicketSnapshot {
  readonly contractVersion: typeof RATIONALE_CONTROL_CONTRACT_VERSION;
  readonly kind: "host-rationale-ticket-snapshot";
  readonly sessionId: string;
  readonly control: RationaleRequiredControl;
  readonly ticket: RationaleTicketStateRecord;
  readonly version: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface RationaleTicketCasExpectation {
  readonly sessionId: string;
  readonly ticketId: string;
  readonly actionDigest: string;
  readonly expectedState: RationaleTicketState;
  readonly expectedVersion: number;
}

export type RationaleTicketStoreAuditOperation =
  | "created"
  | "transitioned"
  | "retired"
  | "allow-once-consumed"
  | "receipt-revoked"
  | "replay-rejected";

/** Contains identifiers and lifecycle state only; never raw intent or tool input. */
export interface RationaleTicketStoreAuditEvent {
  readonly contractVersion: typeof RATIONALE_CONTROL_CONTRACT_VERSION;
  readonly kind: "host-rationale-ticket-store-audit";
  readonly operation: RationaleTicketStoreAuditOperation;
  readonly sessionId: string;
  readonly ticketId: string;
  readonly actionDigest: string;
  readonly invocationDigest: string;
  readonly event: RationaleTicketEventName | null;
  readonly previousState: RationaleTicketState | null;
  readonly state: RationaleTicketState | null;
  readonly previousVersion: number | null;
  readonly version: number | null;
  readonly terminalReason: RationaleTerminalReason | null;
  readonly receiptId: string | null;
  readonly at: number;
}

export type RationaleTicketStoreAuditCallback = (
  event: RationaleTicketStoreAuditEvent,
) => unknown;

export interface InProcessRationaleTicketStoreOptions {
  readonly onAudit: RationaleTicketStoreAuditCallback;
}

export type RationaleTicketStoreTransitionEvent = Exclude<
  RationaleTicketEventName,
  "allow-once"
>;

interface TicketTombstone {
  readonly sessionId: string;
  readonly ticketId: string;
  readonly actionDigest: string;
  readonly invocationDigest: string;
  readonly expiresAt: number;
  readonly state: RationaleTicketState;
  readonly version: number;
  readonly terminalReason: RationaleTerminalReason;
  readonly retiredAt: number;
}

interface AuthenticReceiptEntry {
  readonly sessionId: string;
  readonly expiresAt: number;
  readonly receipt: HostConsumedAllowOnceReceipt;
}

function assertFiniteNow(now: number): void {
  if (!Number.isFinite(now)) {
    throw new TypeError("ticket store time must be finite");
  }
}

function assertSessionId(sessionId: string): void {
  if (
    typeof sessionId !== "string" ||
    sessionId.length === 0 ||
    sessionId.length > 256
  ) {
    throw new TypeError("invalid rationale ticket session id");
  }
}

function assertExpectation(expectation: RationaleTicketCasExpectation): void {
  assertSessionId(expectation.sessionId);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(expectation.ticketId) ||
    !/^[0-9a-f]{64}$/.test(expectation.actionDigest) ||
    !TICKET_STATES.includes(expectation.expectedState) ||
    !Number.isSafeInteger(expectation.expectedVersion) ||
    expectation.expectedVersion < 0
  ) {
    throw new TypeError("invalid rationale ticket CAS expectation");
  }
}

function isTerminal(state: RationaleTicketState): boolean {
  return TERMINAL_STATES.includes(state);
}

export function createRationaleTicketCasExpectation(
  snapshot: HostRationaleTicketSnapshot,
): RationaleTicketCasExpectation {
  validateRationaleTicketRecord(snapshot.ticket);
  if (
    snapshot.contractVersion !== RATIONALE_CONTROL_CONTRACT_VERSION ||
    snapshot.kind !== "host-rationale-ticket-snapshot" ||
    snapshot.sessionId !== snapshot.control.anchor.sessionId ||
    snapshot.ticket.ticketId !== snapshot.control.ticketId ||
    snapshot.ticket.actionDigest !== snapshot.control.action.actionDigest ||
    !Number.isSafeInteger(snapshot.version) ||
    snapshot.version < 0
  ) {
    throw new TypeError("invalid host rationale ticket snapshot");
  }
  return seal({
    sessionId: snapshot.sessionId,
    ticketId: snapshot.ticket.ticketId,
    actionDigest: snapshot.ticket.actionDigest,
    expectedState: snapshot.ticket.state,
    expectedVersion: snapshot.version,
  }, "RationaleTicketCasExpectation");
}

/**
 * Host-owned process-lifetime store. Active ticket/control records are removed
 * on every terminal transition; minimal tombstones prevent replay recreation.
 * It intentionally exposes no PermissionCheckResult or direct-allow API.
 */
export class InProcessRationaleTicketStore {
  readonly #entries = new Map<string, HostRationaleTicketSnapshot>();
  readonly #activeBySession = new Map<string, Set<string>>();
  readonly #tombstones = new Map<string, TicketTombstone>();
  readonly #receipts = new Map<string, AuthenticReceiptEntry>();
  readonly #onAudit: RationaleTicketStoreAuditCallback;
  #lastObservedAt = Number.NEGATIVE_INFINITY;

  constructor(options: InProcessRationaleTicketStoreOptions) {
    if (!options || typeof options.onAudit !== "function") {
      throw new TypeError("rationale ticket store requires a synchronous audit sink");
    }
    this.#onAudit = options.onAudit;
  }

  create(input: {
    sessionId: string;
    control: RationaleRequiredControl;
    now?: number;
  }): HostRationaleTicketSnapshot | null {
    const requestedNow = input.now ?? Date.now();
    assertFiniteNow(requestedNow);
    assertSessionId(input.sessionId);
    const now = this.#observeTimeAndPrune(requestedNow);
    if (
      input.control.anchor.sessionId !== input.sessionId ||
      !verifyRationaleRequiredControl(input.control, { now })
    ) {
      throw new TypeError("invalid rationale control/session binding");
    }

    const active = this.#entries.get(input.control.ticketId);
    if (active) {
      if (active.sessionId === input.sessionId) {
        this.#assertMonotonicTime(active, now);
        this.#retireUnexpected(
          active,
          active.ticket.actionDigest === input.control.action.actionDigest
            ? "stale-replay"
            : "identity-mismatch",
          now,
        );
      } else {
        this.#emitReplayRejected(active, now);
      }
      return null;
    }

    const retired = this.#tombstones.get(input.control.ticketId);
    if (retired) {
      this.#emitReplayRejected(retired, now);
      return null;
    }

    const control = seal(input.control, "StoredRationaleRequiredControl");
    const ticket = createRationaleReviewRequiredRecord(control, now);
    const snapshot = this.#createSnapshot({
      sessionId: input.sessionId,
      control,
      ticket,
      version: 0,
      createdAt: now,
      updatedAt: now,
    });
    this.#emitAudit({
      operation: "created",
      snapshot,
      previous: null,
      event: null,
      receiptId: null,
      at: now,
    });
    this.#entries.set(control.ticketId, snapshot);
    let sessionTickets = this.#activeBySession.get(input.sessionId);
    if (!sessionTickets) {
      sessionTickets = new Set<string>();
      this.#activeBySession.set(input.sessionId, sessionTickets);
    }
    sessionTickets.add(control.ticketId);
    return snapshot;
  }

  get(input: {
    sessionId: string;
    ticketId: string;
    now?: number;
  }): HostRationaleTicketSnapshot | null {
    const requestedNow = input.now ?? Date.now();
    assertFiniteNow(requestedNow);
    assertSessionId(input.sessionId);
    const now = this.#observeTimeAndPrune(requestedNow);
    const entry = this.#entries.get(input.ticketId);
    if (!entry || entry.sessionId !== input.sessionId) return null;
    this.#assertMonotonicTime(entry, now);
    if (now >= entry.control.anchor.expiresAt) {
      this.#applyEvent(entry, "expire", null, now);
      return null;
    }
    if (!verifyRationaleRequiredControl(entry.control, { now })) {
      this.#retireUnexpected(entry, "identity-mismatch", now);
      return null;
    }
    return entry;
  }

  transition(input: {
    expectation: RationaleTicketCasExpectation;
    event: RationaleTicketStoreTransitionEvent;
    outcomes?: RationaleTicketResolvedOutcomes | null;
    now?: number;
  }): HostRationaleTicketSnapshot | null {
    if ((input.event as RationaleTicketEventName) === "allow-once") {
      throw new TypeError("allow-once requires one-shot receipt consumption");
    }
    const requestedNow = input.now ?? Date.now();
    assertFiniteNow(requestedNow);
    const now = this.#observeTimeAndPrune(requestedNow);
    const entry = this.#resolveExpectation(input.expectation, now, input.event);
    if (!entry) return null;
    return this.#applyEvent(entry, input.event, input.outcomes ?? null, now);
  }

  requestRationale(
    expectation: RationaleTicketCasExpectation,
    now = Date.now(),
  ): HostRationaleTicketSnapshot | null {
    return this.transition({ expectation, event: "request-rationale", now });
  }

  markRationaleReady(
    expectation: RationaleTicketCasExpectation,
    outcomes: RationaleTicketResolvedOutcomes,
    now = Date.now(),
  ): HostRationaleTicketSnapshot | null {
    return this.transition({ expectation, event: "rationale-ready", outcomes, now });
  }

  markRationaleFailed(
    expectation: RationaleTicketCasExpectation,
    outcomes: RationaleTicketResolvedOutcomes,
    now = Date.now(),
  ): HostRationaleTicketSnapshot | null {
    return this.transition({ expectation, event: "rationale-failed", outcomes, now });
  }

  promptUser(
    expectation: RationaleTicketCasExpectation,
    now = Date.now(),
  ): HostRationaleTicketSnapshot | null {
    return this.transition({ expectation, event: "prompt-user", now });
  }

  deny(
    expectation: RationaleTicketCasExpectation,
    now = Date.now(),
  ): HostRationaleTicketSnapshot | null {
    return this.transition({ expectation, event: "deny", now });
  }

  cancel(
    expectation: RationaleTicketCasExpectation,
    now = Date.now(),
  ): HostRationaleTicketSnapshot | null {
    return this.transition({ expectation, event: "cancel", now });
  }

  modalTimeout(
    expectation: RationaleTicketCasExpectation,
    now = Date.now(),
  ): HostRationaleTicketSnapshot | null {
    return this.transition({ expectation, event: "modal-timeout", now });
  }

  abort(
    expectation: RationaleTicketCasExpectation,
    now = Date.now(),
  ): HostRationaleTicketSnapshot | null {
    return this.transition({ expectation, event: "abort", now });
  }

  expire(
    expectation: RationaleTicketCasExpectation,
    now = Date.now(),
  ): HostRationaleTicketSnapshot | null {
    return this.transition({ expectation, event: "expire", now });
  }

  consumeAllowOnce(
    expectation: RationaleTicketCasExpectation,
    now = Date.now(),
  ): HostConsumedAllowOnceReceipt | null {
    assertFiniteNow(now);
    now = this.#observeTimeAndPrune(now);
    const entry = this.#resolveExpectation(expectation, now, "allow-once");
    if (!entry) return null;

    let ticket: RationaleTicketStateRecord;
    try {
      ticket = transitionRationaleTicket(
        entry.ticket,
        createRationaleTicketEvent(entry.control, "allow-once"),
      );
    } catch {
      this.#retireUnexpected(entry, "stale-replay", now);
      return null;
    }

    let receiptId = randomUUID();
    while (this.#receipts.has(receiptId)) receiptId = randomUUID();
    const receipt = seal({
      contractVersion: RATIONALE_CONTROL_CONTRACT_VERSION,
      kind: "host-consumed-allow-once-cas" as const,
      receiptId,
      ticketId: entry.control.ticketId,
      actionDigest: entry.control.action.actionDigest,
      invocationDigest: entry.control.invocationDigest,
      consumedAt: now,
      ticket,
    }, "HostConsumedAllowOnceReceipt") as HostConsumedAllowOnceReceipt;
    validateHostConsumedAllowOnceReceipt(receipt, entry.control, ticket, now);

    const committed = this.#commitSnapshot(
      entry,
      ticket,
      "allow-once",
      now,
      "allow-once-consumed",
      receipt.receiptId,
      {
        sessionId: entry.sessionId,
        expiresAt: entry.control.anchor.expiresAt,
        receipt,
      },
    );
    if (committed.ticket.state !== "allowed_once") {
      throw new Error("allow-once CAS failed to commit terminal state");
    }
    return receipt;
  }

  isAuthenticConsumedAllowOnceReceipt(
    receipt: HostConsumedAllowOnceReceipt,
    now = Date.now(),
  ): boolean {
    try {
      assertFiniteNow(now);
      now = this.#observeTimeAndPrune(now);
      const candidate = seal(receipt, "HostConsumedAllowOnceReceipt");
      const stored = this.#receipts.get(candidate.receiptId);
      if (
        !stored ||
        canonicalStringify(stored.receipt) !== canonicalStringify(candidate)
      ) {
        return false;
      }
      if (now < stored.receipt.consumedAt) return false;
      if (now >= stored.expiresAt) {
        this.#emitReceiptRevoked(stored, "expire", now);
        this.#receipts.delete(candidate.receiptId);
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  activeTicketIds(sessionId: string, now = Date.now()): readonly string[] {
    assertFiniteNow(now);
    assertSessionId(sessionId);
    this.#observeTimeAndPrune(now);
    return seal(
      [...(this.#activeBySession.get(sessionId) ?? [])],
      "ActiveRationaleTicketIds",
    );
  }

  closeSession(
    sessionId: string,
    now = Date.now(),
  ): readonly HostRationaleTicketSnapshot[] {
    assertFiniteNow(now);
    assertSessionId(sessionId);
    now = this.#observeTimeAndPrune(now);
    const ticketIds = [...(this.#activeBySession.get(sessionId) ?? [])];
    const receiptEntries = [...this.#receipts.values()]
      .filter((entry) => entry.sessionId === sessionId);

    for (const ticketId of ticketIds) {
      const entry = this.#entries.get(ticketId);
      if (entry) this.#assertMonotonicTime(entry, now);
    }
    for (const entry of receiptEntries) {
      if (now < entry.receipt.consumedAt) {
        throw new TypeError("ticket store time cannot move backwards");
      }
    }

    const retired: HostRationaleTicketSnapshot[] = [];
    let firstAuditError: unknown;
    for (const ticketId of ticketIds) {
      const entry = this.#entries.get(ticketId);
      if (!entry) continue;
      try {
        const terminal = this.#applyEvent(entry, "session-close", null, now);
        if (terminal) retired.push(terminal);
      } catch (error) {
        firstAuditError ??= error;
      }
    }
    for (const entry of receiptEntries) {
      try {
        this.#emitReceiptRevoked(entry, "session-close", now);
        this.#receipts.delete(entry.receipt.receiptId);
      } catch (error) {
        firstAuditError ??= error;
      }
    }
    if (firstAuditError !== undefined) throw firstAuditError;
    return seal(retired, "ClosedRationaleTicketSnapshots");
  }

  #resolveExpectation(
    expectation: RationaleTicketCasExpectation,
    now: number,
    requestedEvent: RationaleTicketEventName,
  ): HostRationaleTicketSnapshot | null {
    assertExpectation(expectation);
    const entry = this.#entries.get(expectation.ticketId);
    if (!entry) {
      const retired = this.#tombstones.get(expectation.ticketId);
      if (retired) this.#emitReplayRejected(retired, now);
      return null;
    }
    if (entry.sessionId !== expectation.sessionId) {
      this.#emitReplayRejected(entry, now);
      return null;
    }
    this.#assertMonotonicTime(entry, now);
    if (entry.ticket.actionDigest !== expectation.actionDigest) {
      this.#retireUnexpected(entry, "identity-mismatch", now);
      return null;
    }
    if (
      entry.ticket.state !== expectation.expectedState ||
      entry.version !== expectation.expectedVersion
    ) {
      this.#retireUnexpected(entry, "stale-replay", now);
      return null;
    }
    if (now >= entry.control.anchor.expiresAt && requestedEvent !== "expire") {
      this.#applyEvent(entry, "expire", null, now);
      return null;
    }
    if (
      !EXPIRY_SAFE_EVENTS.includes(requestedEvent) &&
      !verifyRationaleRequiredControl(entry.control, { now })
    ) {
      this.#retireUnexpected(entry, "identity-mismatch", now);
      return null;
    }
    return entry;
  }

  #applyEvent(
    entry: HostRationaleTicketSnapshot,
    event: RationaleTicketEventName,
    outcomes: RationaleTicketResolvedOutcomes | null,
    now: number,
  ): HostRationaleTicketSnapshot | null {
    let ticket: RationaleTicketStateRecord;
    try {
      const ticketEvent = createRationaleTicketEvent(entry.control, event, outcomes);
      ticket = transitionRationaleTicket(entry.ticket, ticketEvent);
    } catch {
      if (event === "stale-replay") {
        throw new Error("invalid stale-replay retirement");
      }
      this.#retireUnexpected(entry, "stale-replay", now);
      return null;
    }
    return this.#commitSnapshot(
      entry,
      ticket,
      event,
      now,
      isTerminal(ticket.state) ? "retired" : "transitioned",
      null,
    );
  }

  #retireUnexpected(
    entry: HostRationaleTicketSnapshot,
    event: Extract<
      RationaleTicketEventName,
      "identity-mismatch" | "stale-replay"
    >,
    now: number,
  ): HostRationaleTicketSnapshot {
    const ticket = transitionRationaleTicket(
      entry.ticket,
      createRationaleTicketEvent(entry.control, event),
    );
    return this.#commitSnapshot(entry, ticket, event, now, "retired", null);
  }

  #commitSnapshot(
    previous: HostRationaleTicketSnapshot,
    ticket: RationaleTicketStateRecord,
    event: RationaleTicketEventName,
    now: number,
    operation: Extract<
      RationaleTicketStoreAuditOperation,
      "transitioned" | "retired" | "allow-once-consumed"
    >,
    receiptId: string | null,
    receiptEntry?: AuthenticReceiptEntry,
  ): HostRationaleTicketSnapshot {
    validateRationaleTicketRecord(ticket);
    this.#assertMonotonicTime(previous, now);
    if (
      ticket.ticketId !== previous.control.ticketId ||
      ticket.actionDigest !== previous.control.action.actionDigest
    ) {
      throw new Error("ticket store committed an invalid control binding");
    }
    const snapshot = this.#createSnapshot({
      sessionId: previous.sessionId,
      control: previous.control,
      ticket,
      version: previous.version + 1,
      createdAt: previous.createdAt,
      updatedAt: now,
    });

    if (receiptEntry && (receiptId === null || this.#receipts.has(receiptId))) {
      throw new Error("duplicate allow-once receipt id");
    }
    if (isTerminal(ticket.state) && ticket.terminalReason === null) {
      throw new Error("terminal rationale ticket lacks a terminal reason");
    }
    this.#emitAudit({
      operation,
      snapshot,
      previous,
      event,
      receiptId,
      at: now,
    });
    if (isTerminal(ticket.state)) {
      this.#entries.delete(ticket.ticketId);
      this.#removeActiveSessionTicket(previous.sessionId, ticket.ticketId);
      if (now < previous.control.anchor.expiresAt) {
        this.#tombstones.set(ticket.ticketId, seal({
          sessionId: previous.sessionId,
          ticketId: ticket.ticketId,
          actionDigest: ticket.actionDigest,
          invocationDigest: previous.control.invocationDigest,
          expiresAt: previous.control.anchor.expiresAt,
          state: ticket.state,
          version: snapshot.version,
          terminalReason: ticket.terminalReason!,
          retiredAt: now,
        }, "RationaleTicketTombstone"));
      } else {
        this.#tombstones.delete(ticket.ticketId);
      }
    } else {
      this.#entries.set(ticket.ticketId, snapshot);
    }
    if (receiptEntry && receiptId !== null) {
      this.#receipts.set(receiptId, receiptEntry);
    }
    return snapshot;
  }

  #createSnapshot(
    input: Omit<HostRationaleTicketSnapshot, "contractVersion" | "kind">,
  ): HostRationaleTicketSnapshot {
    return seal({
      contractVersion: RATIONALE_CONTROL_CONTRACT_VERSION,
      kind: "host-rationale-ticket-snapshot" as const,
      ...input,
    }, "HostRationaleTicketSnapshot");
  }

  #removeActiveSessionTicket(sessionId: string, ticketId: string): void {
    const tickets = this.#activeBySession.get(sessionId);
    if (!tickets) return;
    tickets.delete(ticketId);
    if (tickets.size === 0) this.#activeBySession.delete(sessionId);
  }

  #assertMonotonicTime(entry: HostRationaleTicketSnapshot, now: number): void {
    if (now < entry.createdAt || now < entry.updatedAt) {
      throw new TypeError("ticket store time cannot move backwards");
    }
  }

  #observeTimeAndPrune(now: number): number {
    const effectiveNow = Math.max(this.#lastObservedAt, now);
    this.#lastObservedAt = effectiveNow;
    for (const [ticketId, tombstone] of this.#tombstones) {
      if (effectiveNow >= tombstone.expiresAt) this.#tombstones.delete(ticketId);
    }
    return effectiveNow;
  }

  #dispatchAudit(event: RationaleTicketStoreAuditEvent): void {
    const result = this.#onAudit(event);
    if (
      result !== null &&
      (typeof result === "object" || typeof result === "function") &&
      typeof (result as { then?: unknown }).then === "function"
    ) {
      void Promise.resolve(result).catch(() => undefined);
      throw new TypeError(
        "rationale ticket store audit sink must commit synchronously",
      );
    }
  }

  #emitAudit(input: {
    operation: RationaleTicketStoreAuditOperation;
    snapshot: HostRationaleTicketSnapshot;
    previous: HostRationaleTicketSnapshot | null;
    event: RationaleTicketEventName | null;
    receiptId: string | null;
    at: number;
  }): void {
    this.#dispatchAudit(seal({
      contractVersion: RATIONALE_CONTROL_CONTRACT_VERSION,
      kind: "host-rationale-ticket-store-audit" as const,
      operation: input.operation,
      sessionId: input.snapshot.sessionId,
      ticketId: input.snapshot.ticket.ticketId,
      actionDigest: input.snapshot.ticket.actionDigest,
      invocationDigest: input.snapshot.control.invocationDigest,
      event: input.event,
      previousState: input.previous?.ticket.state ?? null,
      state: input.snapshot.ticket.state,
      previousVersion: input.previous?.version ?? null,
      version: input.snapshot.version,
      terminalReason: input.snapshot.ticket.terminalReason,
      receiptId: input.receiptId,
      at: input.at,
    }, "RationaleTicketStoreAuditEvent"));
  }

  #emitReplayRejected(
    current: HostRationaleTicketSnapshot | TicketTombstone,
    now: number,
  ): void {
    if ("ticket" in current) {
      if (now < current.updatedAt) {
        throw new TypeError("ticket store time cannot move backwards");
      }
      this.#dispatchAudit(seal({
        contractVersion: RATIONALE_CONTROL_CONTRACT_VERSION,
        kind: "host-rationale-ticket-store-audit" as const,
        operation: "replay-rejected" as const,
        sessionId: current.sessionId,
        ticketId: current.ticket.ticketId,
        actionDigest: current.ticket.actionDigest,
        invocationDigest: current.control.invocationDigest,
        event: "stale-replay" as const,
        previousState: current.ticket.state,
        state: current.ticket.state,
        previousVersion: current.version,
        version: current.version,
        terminalReason: current.ticket.terminalReason,
        receiptId: null,
        at: now,
      }, "RationaleTicketStoreAuditEvent"));
      return;
    }

    if (now < current.retiredAt) {
      throw new TypeError("ticket store time cannot move backwards");
    }
    this.#dispatchAudit(seal({
      contractVersion: RATIONALE_CONTROL_CONTRACT_VERSION,
      kind: "host-rationale-ticket-store-audit" as const,
      operation: "replay-rejected" as const,
      sessionId: current.sessionId,
      ticketId: current.ticketId,
      actionDigest: current.actionDigest,
      invocationDigest: current.invocationDigest,
      event: "stale-replay" as const,
      previousState: current.state,
      state: current.state,
      previousVersion: current.version,
      version: current.version,
      terminalReason: current.terminalReason,
      receiptId: null,
      at: now,
    }, "RationaleTicketStoreAuditEvent"));
  }

  #emitReceiptRevoked(
    entry: AuthenticReceiptEntry,
    event: Extract<RationaleTicketEventName, "expire" | "session-close">,
    now: number,
  ): void {
    const tombstone = this.#tombstones.get(entry.receipt.ticketId);
    this.#dispatchAudit(seal({
      contractVersion: RATIONALE_CONTROL_CONTRACT_VERSION,
      kind: "host-rationale-ticket-store-audit" as const,
      operation: "receipt-revoked" as const,
      sessionId: entry.sessionId,
      ticketId: entry.receipt.ticketId,
      actionDigest: entry.receipt.actionDigest,
      invocationDigest: entry.receipt.invocationDigest,
      event,
      previousState: "allowed_once" as const,
      state: "allowed_once" as const,
      previousVersion: tombstone?.version ?? null,
      version: tombstone?.version ?? null,
      terminalReason: "allowed-once" as const,
      receiptId: entry.receipt.receiptId,
      at: now,
    }, "RationaleTicketStoreAuditEvent"));
  }
}
