import type { ApprovalGate } from "../../permissions/approval-gate.js";
import type { RationaleScopeReviewer } from "../../permissions/reviewer/rationale-scope-reviewer.js";
import type {
  RationaleCoordinatorFactory,
} from "../../engine/turn/rationale-conversation-orchestration.js";
import type { RationaleAuditSink } from "../../audit/rationale-audit-adapter.js";
import {
  InMemoryHostAnchorRoundCasStore,
  type HostAnchorRoundCas,
} from "./rationale-control.js";
import { RationaleHostCoordinator } from "./rationale-host-coordinator.js";
import {
  InProcessRationaleTicketStore,
  type HostRationaleTicketSnapshot,
} from "./rationale-ticket-store.js";
import type { HostInvocationStartCas } from "./rationale-ticket-lifecycle.js";

type RationaleApprovalGate = Pick<
  ApprovalGate,
  "requestAndWait" | "cancelPendingRationale"
>;

export interface RationaleHostServiceOptions {
  readonly approvalGate: RationaleApprovalGate;
  readonly getRationaleScopeReviewer: () => RationaleScopeReviewer;
  readonly getRegistryGeneration: () => string | number;
  readonly getSandboxGeneration: () => string | number;
  /**
   * Required host authority. Production boot supplies the durable journal-backed
   * implementation and performs crash recovery before activation.
   */
  readonly invocationStartCas: HostInvocationStartCas;
  readonly auditSink: RationaleAuditSink;
  readonly now?: () => number;
}

export interface RationaleCoordinatorFactoryScope {
  /**
   * Must include the loop's live session/turn additional-directory scope, in
   * addition to the shared permission and hook generations.
   */
  readonly getRationalePolicyEpoch: () => string;
  /** Rejects a delayed factory call after its loop has switched sessions. */
  readonly isSessionCurrent: (sessionId: string) => boolean;
}

/**
 * Process-owned rationale authority host. Coordinator instances are ephemeral;
 * all ticket, anchor-round and invocation-start authority remains shared here.
 */
export class RationaleHostService {
  readonly #approvalGate: RationaleApprovalGate;
  readonly #getRationaleScopeReviewer: () => RationaleScopeReviewer;
  readonly #getRegistryGeneration: () => string | number;
  readonly #getSandboxGeneration: () => string | number;
  readonly #invocationStartCas: HostInvocationStartCas;
  readonly #auditSink: RationaleAuditSink;
  readonly #now: () => number;
  readonly #ticketStore: InProcessRationaleTicketStore;
  readonly #anchorRoundCas = new InMemoryHostAnchorRoundCasStore();
  readonly #sessionGenerations = new Map<string, number>();
  readonly #knownSessions = new Set<string>();
  readonly #retiringTicketIdsBySession = new Map<string, Set<string>>();
  #closed = false;
  #shutdownComplete = false;

  constructor(options: RationaleHostServiceOptions) {
    if (
      !options ||
      typeof options.auditSink?.assertWritable !== "function" ||
      typeof options.auditSink?.appendTicket !== "function" ||
      typeof options.auditSink.appendInvocation !== "function" ||
      typeof options.auditSink.appendProjection !== "function"
    ) {
      throw new TypeError("rationale host service requires a synchronous audit sink");
    }
    if (!options.invocationStartCas) {
      throw new TypeError("rationale host service requires invocation-start authority");
    }
    this.#approvalGate = options.approvalGate;
    this.#getRationaleScopeReviewer = options.getRationaleScopeReviewer;
    this.#getRegistryGeneration = options.getRegistryGeneration;
    this.#getSandboxGeneration = options.getSandboxGeneration;
    this.#invocationStartCas = options.invocationStartCas;
    this.#auditSink = options.auditSink;
    this.#now = options.now ?? Date.now;
    this.#ticketStore = new InProcessRationaleTicketStore({
      onAudit: (event) => {
        this.#auditSink.appendTicket(event);
      },
    });
  }

  /**
   * Creating/injecting this factory is dormant: no audit file, reviewer call or
   * journal access occurs until the query-loop activation gate invokes it.
   */
  createCoordinatorFactory(
    scope: RationaleCoordinatorFactoryScope,
  ): RationaleCoordinatorFactory {
    if (
      !scope ||
      typeof scope.getRationalePolicyEpoch !== "function" ||
      typeof scope.isSessionCurrent !== "function"
    ) {
      throw new TypeError("invalid rationale coordinator factory scope");
    }

    return (input) => {
      const now = this.#now();
      if (
        this.#closed ||
        !Number.isFinite(now) ||
        input.sessionId !== input.requestAnchor.sessionId ||
        input.requestAnchor.createdAt > now ||
        input.requestAnchor.expiresAt <= now ||
        !this.#isLoopSessionCurrent(scope, input.sessionId)
      ) {
        return null;
      }

      try {
        this.#auditSink.assertWritable(now);
        const reviewer = this.#getRationaleScopeReviewer();
        if (!reviewer || typeof reviewer.reevaluate !== "function") return null;

        const generation = this.#sessionGenerations.get(input.sessionId) ?? 0;
        const isCurrent = () =>
          !this.#closed &&
          (this.#sessionGenerations.get(input.sessionId) ?? 0) === generation &&
          this.#isLoopSessionCurrent(scope, input.sessionId);
        const anchorRoundCas: HostAnchorRoundCas = {
          tryReserve: (reservationInput) =>
            isCurrent() ? this.#anchorRoundCas.tryReserve(reservationInput) : null,
          isCurrentReservation: (receipt) =>
            isCurrent() && this.#anchorRoundCas.isCurrentReservation(receipt),
        };
        const invocationStartCas: HostInvocationStartCas = {
          commitStart: async (startInput) => {
            if (!isCurrent()) return null;
            const committed = await this.#invocationStartCas.commitStart({
              ...startInput,
              sessionId: input.sessionId,
            });
            // A close may race the durable commit. Discarding the committed
            // authority prevents execution; boot recovery later records unknown.
            return isCurrent() ? committed : null;
          },
          commitTerminal: (terminalInput) =>
            this.#invocationStartCas.commitTerminal(terminalInput),
        };

        this.#knownSessions.add(input.sessionId);
        return new RationaleHostCoordinator({
          requestAnchor: input.requestAnchor,
          rationaleProvenance: input.rationaleProvenance,
          ticketStore: this.#ticketStore,
          rationaleScopeReviewer: reviewer,
          approvalGate: this.#approvalGate,
          getRationalePolicyEpoch: scope.getRationalePolicyEpoch,
          getRegistryGeneration: this.#getRegistryGeneration,
          getSandboxGeneration: this.#getSandboxGeneration,
          anchorRoundCas,
          hostInvocationStartCas: invocationStartCas,
          onInvocationAudit: (record) => {
            this.#auditSink.appendInvocation(input.sessionId, record);
          },
          onProjectionAudit: (sessionId, projection, at) => {
            if (sessionId !== input.sessionId) {
              throw new Error("rationale projection audit session mismatch");
            }
            this.#auditSink.appendProjection(sessionId, projection, at);
          },
          isCurrent,
          now: this.#now,
        });
      } catch {
        // No authority was materialized. The caller preserves the direct modal.
        return null;
      }
    };
  }

  closeSession(
    sessionId: string,
    now = this.#now(),
  ): readonly HostRationaleTicketSnapshot[] {
    if (!Number.isFinite(now)) {
      throw new TypeError("rationale host close time must be finite");
    }
    this.#sessionGenerations.set(
      sessionId,
      (this.#sessionGenerations.get(sessionId) ?? 0) + 1,
    );
    const errors: unknown[] = [];
    const ticketIds = new Set(
      this.#retiringTicketIdsBySession.get(sessionId) ?? [],
    );
    let activeTicketsListed = false;
    try {
      for (const ticketId of this.#ticketStore.activeTicketIds(sessionId, now)) {
        ticketIds.add(ticketId);
      }
      activeTicketsListed = true;
    } catch (error) {
      errors.push(error);
    }
    const failedGateCancellations = new Set<string>();
    let closed: readonly HostRationaleTicketSnapshot[] = [];
    for (const ticketId of ticketIds) {
      try {
        this.#approvalGate.cancelPendingRationale(ticketId, "session-close");
      } catch (error) {
        failedGateCancellations.add(ticketId);
        errors.push(error);
      }
    }
    if (failedGateCancellations.size > 0) {
      this.#retiringTicketIdsBySession.set(
        sessionId,
        failedGateCancellations,
      );
    } else {
      this.#retiringTicketIdsBySession.delete(sessionId);
    }
    if (activeTicketsListed) {
      try {
        closed = this.#ticketStore.closeSession(sessionId, now);
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      this.#anchorRoundCas.closeSession(sessionId);
    } catch (error) {
      errors.push(error);
    }

    if (errors.length > 0) {
      throw new AggregateError(errors, "rationale host session close failed");
    }
    this.#retiringTicketIdsBySession.delete(sessionId);
    this.#knownSessions.delete(sessionId);
    return closed;
  }

  shutdown(now = this.#now()): void {
    if (this.#shutdownComplete) return;
    this.#closed = true;
    const errors: unknown[] = [];
    for (const sessionId of [...this.#knownSessions]) {
      try {
        this.closeSession(sessionId, now);
      } catch (error) {
        errors.push(error);
      }
    }
    this.#anchorRoundCas.clear();
    if (errors.length > 0) {
      throw new AggregateError(errors, "rationale host shutdown failed");
    }
    this.#shutdownComplete = true;
  }

  #isLoopSessionCurrent(
    scope: RationaleCoordinatorFactoryScope,
    sessionId: string,
  ): boolean {
    try {
      return scope.isSessionCurrent(sessionId);
    } catch {
      return false;
    }
  }
}
