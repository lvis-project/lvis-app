import { randomUUID } from "node:crypto";
import type { AuditLogger } from "../audit/audit-logger.js";
import type { SettingsService } from "../data/settings-store.js";
import type { A2AMessage } from "../shared/a2a.js";
import type { ConversationLoop } from "./conversation-loop.js";
import { GUIDE_MAX_CHARS } from "./turn/guidance-limits.js";
import {
  type ParentMailboxEntry,
  type ParentMailboxLoadDiagnostic,
  type SubAgentMessageMailbox,
} from "./subagent-message-mailbox.js";
import {
  canonicalizeAgentMessage,
  isSafeA2AMessageId,
  sanitizeA2ALabel,
  wrapChildReportForParentJudgment,
} from "./a2a-subagent-message-codec.js";

export {
  formatAgentMessage,
  maskA2AMessage,
} from "./a2a-subagent-message-codec.js";
export interface ResolvedSubAgentAddress {
  parentSessionId: string;
  childSessionId: string;
  childTitle: string;
  /** Current-process fallback lease for an initial metadata write failure. */
  ephemeralMessageId?: string;
}

export interface DeliverToParentInput {
  parentSessionId: string;
  childSessionId: string;
  message: A2AMessage;
}

interface DeliveryAuditInput {
  parentSessionId: unknown;
  childSessionId: unknown;
  message?: unknown;
}

export type DeliverToParentResult =
  | { ok: true; disposition: "queued" | "mailbox" | "wake-requested"; messageId: string }
  | {
      ok: false;
      disposition: "dropped";
      reason:
        | "unknown-child"
        | "cross-origin"
        | "duplicate-message"
        | "invalid-message"
        | "unsupported-part"
        | "message-too-long"
        | "budget-exhausted"
        | "storage-failed"
        | "message-bus-unavailable";
    };

export type ParentWakeHandler = (parentSessionId: string) => Promise<void>;

/**
 * In-process A2A-semantic child-to-parent bus.
 *
 * Delivery is mailbox-first. A running parent acknowledges only after the
 * round-boundary injection callback fires, so a late queue entry that is
 * dropped at turn end remains durable for the next turn.
 */
/**
 * Wake-refusal reasons that are legitimate holds rather than stalls: the
 * mailbox entry's delivery is already owned by another mechanism (the active
 * turn's guidance injection and its turn-settled drain, or the in-flight
 * wake's completion drain). Everything else in wakeRefusalReasons is a HARD
 * refusal — nothing delivers until the outside world changes.
 */
const SOFT_WAKE_REFUSALS = new Set(["turn-active", "wake-in-flight"]);

export class A2ASubAgentMessageBus {
  private wakeHandler: ParentWakeHandler | null = null;
  private readonly wakeInFlight = new Set<string>();
  /**
   * Per-parent progress token — "a stored delivery for this parent has not yet
   * been reported as consumed". `drain` consumes it before dispatching a wake,
   * which is the ONLY thing that bounds the loop: a wake that consumes nothing
   * (a mailbox entry the receiving turn refused, an acknowledge that failed,
   * a `prepareParentMailboxTurn` that fails closed) finds no token when it
   * completes and therefore does not wake itself again. Peeking the mailbox
   * instead would re-wake such a poisoned entry forever.
   */
  private readonly wakeDirty = new Map<string, DeliverToParentInput>();
  private readonly ephemeralLeasesByEntryId = new Map<string, {
    parentSessionId: string;
    childSessionId: string;
    messageId: string;
  }>();

  constructor(
    private readonly deps: {
      parentLoop: ConversationLoop;
      mailbox: SubAgentMessageMailbox;
      settingsService: SettingsService;
      auditLogger: AuditLogger;
      resolveChildAddress: (
        parentSessionId: string,
        childSessionId: string,
        messageId: string,
      ) => Promise<ResolvedSubAgentAddress | null>;
      releaseEphemeralChildAddress?: (
        parentSessionId: string,
        childSessionId: string,
        messageId: string,
      ) => void;
    },
  ) {}

  setWakeHandler(handler: ParentWakeHandler | null): void {
    this.wakeHandler = handler;
  }

  async peekParentMailbox(parentSessionId: string): Promise<ParentMailboxEntry[]> {
    const mailboxResult = typeof this.deps.mailbox.peekWithDiagnostics === "function"
      ? await this.deps.mailbox.peekWithDiagnostics(parentSessionId)
      : {
          entries: await this.deps.mailbox.peek(parentSessionId),
          diagnostics: [],
          cleanupFailed: false,
        };
    for (const diagnostic of mailboxResult.diagnostics) {
      this.auditPersistedDiagnostic(
        diagnostic,
        "dropped:" + diagnostic.reason,
      );
      if (!mailboxResult.cleanupFailed) {
        this.releaseEphemeralAddress(diagnostic);
      }
    }
    if (mailboxResult.cleanupFailed) {
      this.auditPersistedDiagnostic(
        undefined,
        "drop-cleanup-failed",
      );
    }

    const entries = mailboxResult.entries;
    const accepted: ParentMailboxEntry[] = [];
    const rejected: ParentMailboxEntry[] = [];

    for (const entry of entries) {
      const input: DeliverToParentInput = {
        parentSessionId,
        childSessionId: entry.childSessionId,
        message: entry.message,
      };
      let address: ResolvedSubAgentAddress | null;
      try {
        address = await this.deps.resolveChildAddress(
          parentSessionId,
          entry.childSessionId,
          entry.message.messageId,
        );
      } catch {
        // Resolver failures may be transient. Do not inject or delete the
        // durable entry; a later turn can retry the authoritative lookup.
        this.audit("warn", input, "dropped:storage-failed");
        continue;
      }

      if (!address) {
        this.audit("warn", input, "dropped:unknown-child");
        rejected.push(entry);
        continue;
      }
      if (
        entry.parentSessionId !== parentSessionId
        || address.parentSessionId !== parentSessionId
      ) {
        this.audit("warn", input, "dropped:cross-origin");
        rejected.push(entry);
        continue;
      }

      const canonical = canonicalizeAgentMessage(address, entry.message);
      let sameMessage = false;
      if (canonical.ok) {
        try {
          sameMessage = JSON.stringify(canonical.message) === JSON.stringify(entry.message);
        } catch {
          sameMessage = false;
        }
      }
      if (
        address.childSessionId !== entry.childSessionId
        || (address.ephemeralMessageId !== undefined
          && address.ephemeralMessageId !== entry.message.messageId)
        || !canonical.ok
        || canonical.detectionCount !== 0
        || !sameMessage
        || canonical.childTitle !== entry.childTitle
        || canonical.formattedText !== entry.formattedText
        || canonical.approvalLabel !== entry.approvalLabel
      ) {
        this.audit("warn", input, "dropped:invalid-message");
        rejected.push(entry);
        continue;
      }

      accepted.push({
        ...entry,
        childTitle: canonical.childTitle,
        message: canonical.message,
        formattedText: canonical.formattedText,
        approvalLabel: canonical.approvalLabel,
      });
    }

    if (rejected.length > 0) {
      const rejectedIds = rejected.map((entry) => entry.id);
      let removed = 0;
      try {
        removed = await this.deps.mailbox.acknowledge(parentSessionId, rejectedIds);
      } catch {
        // Copy-on-write mailbox persistence leaves every rejected entry
        // durable on failure. They remain quarantined by the checks above.
      }
      if (removed !== rejectedIds.length) {
        for (const entry of rejected) {
          this.audit("warn", {
            parentSessionId,
            childSessionId: entry.childSessionId,
            message: entry.message,
          }, "drop-ack-failed");
        }
        return [];
      }
      for (const entry of rejected) {
        this.releaseEphemeralAddress(entry);
      }
    }

    return accepted;
  }

  async acknowledgeParentMailbox(
    parentSessionId: string,
    ids: readonly string[],
  ): Promise<number> {
    const removed = await this.deps.mailbox.acknowledge(parentSessionId, ids);
    if (removed === ids.length) {
      for (const id of ids) {
        const lease = this.ephemeralLeasesByEntryId.get(id);
        if (!lease) continue;
        this.deps.releaseEphemeralChildAddress?.(
          lease.parentSessionId,
          lease.childSessionId,
          lease.messageId,
        );
        this.ephemeralLeasesByEntryId.delete(id);
      }
    }
    return removed;
  }

  async deliverToParent(input: DeliverToParentInput): Promise<DeliverToParentResult> {
    const rawMessage = input.message as unknown;
    if (
      rawMessage === null
      || typeof rawMessage !== "object"
      || !isSafeA2AMessageId((rawMessage as { messageId?: unknown }).messageId)
    ) {
      return this.drop(input, "invalid-message");
    }

    let address: ResolvedSubAgentAddress | null;
    try {
      address = await this.deps.resolveChildAddress(
        input.parentSessionId,
        input.childSessionId,
        input.message.messageId,
      );
    } catch {
      return this.drop(input, "storage-failed");
    }
    if (!address) return this.drop(input, "unknown-child");
    if (address.parentSessionId !== input.parentSessionId) {
      return this.drop(input, "cross-origin");
    }
    if (
      address.childSessionId !== input.childSessionId
      || (address.ephemeralMessageId !== undefined
        && address.ephemeralMessageId !== input.message.messageId)
    ) {
      return this.drop(input, "invalid-message");
    }
    const canonical = canonicalizeAgentMessage(address, input.message);
    if (!canonical.ok) return this.drop(input, canonical.reason);

    let serializedMessage: string;
    try {
      serializedMessage = JSON.stringify(canonical.message);
    } catch {
      return this.drop(input, "invalid-message");
    }
    if (serializedMessage.length > GUIDE_MAX_CHARS) {
      return this.drop(input, "message-too-long");
    }
    if (canonical.formattedText.length > GUIDE_MAX_CHARS) {
      return this.drop(input, "message-too-long");
    }
    const deliveryInput: DeliverToParentInput = {
      ...input,
      message: canonical.message,
    };

    const entry: ParentMailboxEntry = {
      id: randomUUID(),
      parentSessionId: input.parentSessionId,
      childSessionId: input.childSessionId,
      childTitle: canonical.childTitle,
      createdAt: new Date().toISOString(),
      message: canonical.message,
      formattedText: canonical.formattedText,
      approvalLabel: canonical.approvalLabel,
    };
    let stored;
    try {
      stored = await this.deps.mailbox.enqueue(entry);
    } catch {
      return this.drop(input, "storage-failed");
    }
    if (!stored.ok) {
      const reason = stored.reason === "message-too-long"
        ? "message-too-long"
        : stored.reason === "duplicate-message"
          ? "duplicate-message"
          : "budget-exhausted";
      return this.drop(input, reason);
    }
    this.audit("info", deliveryInput, `stored:detections=${canonical.detectionCount}`);
    if (canonical.emptyBody) {
      // The producer sent a report with no renderable content and the codec
      // substituted a host-composed body. Never silent: an empty terminal
      // delivery is a producer defect, and this is where it becomes visible.
      this.audit("warn", deliveryInput, "empty-body-fallback");
    }

    if (address.ephemeralMessageId !== undefined) {
      this.ephemeralLeasesByEntryId.set(entry.id, {
        parentSessionId: entry.parentSessionId,
        childSessionId: entry.childSessionId,
        messageId: address.ephemeralMessageId,
      });
    }

    // The entry is durable from here on, so every path below owes it exactly
    // one delivery attempt. Marking the parent dirty first means no branch can
    // forget: a wake racing this store, a turn that ends before injection, and
    // an outright refusal all converge on the same token for `drain` to spend.
    this.wakeDirty.set(input.parentSessionId, deliveryInput);

    if (
      this.deps.parentLoop.getSessionId() === input.parentSessionId
      && this.deps.parentLoop.hasActiveTurn()
    ) {
      const queued = this.deps.parentLoop.queueGuidanceWithDisposition(
        wrapChildReportForParentJudgment(entry.formattedText),
        {
          approvalReasonPrefix: entry.approvalLabel,
          // Structured provenance for the renderer: a child report is not the
          // generic "injected from the message queue" chip.
          subAgentTitle: entry.childTitle,
          onInjected: () => this.acknowledgeParentMailbox(
            entry.parentSessionId,
            [entry.id],
          )
            .then((removed) => {
              if (removed === 1) {
                // The running turn consumed this delivery, so the token it
                // minted is spent. Identity-matched on purpose: a later
                // delivery may already own the slot, and its claim outranks
                // this acknowledgement. Without this, every injected message
                // would leave a token behind for the turn-settled drain to
                // spend on a wake with nothing left to deliver.
                if (this.wakeDirty.get(entry.parentSessionId) === deliveryInput) {
                  this.wakeDirty.delete(entry.parentSessionId);
                }
              }
              this.audit(
                removed === 1 ? "info" : "warn",
                deliveryInput,
                removed === 1 ? "injected" : "ack-failed",
              );
            })
            .catch(() => this.audit("warn", deliveryInput, "ack-failed")),
          onDropped: (reason) => {
            this.audit("warn", deliveryInput, `deferred:${reason}`);
            // `turn-ended` needs nothing here: this callback runs inside the
            // turn's own cleanup, whose turn-settled notification drains the
            // very same token moments later.
            if (reason === "joined-limit") {
              // The guidance was accepted into the active queue but could not
              // join the next model call. Nothing else will carry it, so spend
              // the token now; the lease-aware handler waits out the turn.
              this.drain(entry.parentSessionId);
            }
          },
        },
      );
      if (queued === "queued") {
        return { ok: true, disposition: "queued", messageId: canonical.message.messageId };
      }
      this.audit("warn", deliveryInput, `deferred:${queued}`);
    }

    return this.drain(input.parentSessionId)
      ? { ok: true, disposition: "wake-requested", messageId: canonical.message.messageId }
      : { ok: true, disposition: "mailbox", messageId: canonical.message.messageId };
  }

  /**
   * The parent's turn released the loop — retry whatever is still owed.
   *
   * This replaces the bus's old habit of inferring that transition from its
   * own state. A message stored mid-turn but never injected (queue drop, ack
   * failure, a turn that ended first) keeps its token, and this is the moment
   * it becomes deliverable.
   */
  notifyTurnSettled(parentSessionId: string): void {
    this.drain(parentSessionId);
  }

  /**
   * The one wake trigger. Idle delivery, turn end, and wake completion all
   * funnel here; none of them decides for itself whether to wake.
   *
   * Deliberately does NOT peek the mailbox: a non-empty mailbox cannot tell
   * "work nobody has tried to deliver" apart from "work the last wake already
   * tried and could not consume". Only the token carries that distinction, and
   * spending it before dispatch is what bounds the wake. The cost of that
   * choice is stated plainly: a wake whose turn refuses the entry (a
   * fail-closed mailbox turn, a stop reason that withholds the
   * acknowledgement) does not retry, and the entry waits for the next real
   * trigger — a later delivery, or the mailbox fold on the user's next turn.
   * Re-arming on non-consumption instead is precisely the infinite wake loop
   * this design exists to prevent.
   *
   * @returns true when this call dispatched a wake.
   */
  private drain(parentSessionId: string): boolean {
    const input = this.wakeDirty.get(parentSessionId);
    if (input === undefined) return false;

    const refusals = this.wakeRefusalReasons(parentSessionId);
    // `turn-active` alone never blocks: the host handler's first action is to
    // await the live turn/session lease, so dispatching now is how an overflow
    // during a running turn avoids degrading to manual-only. Every other
    // refusal — including `wake-in-flight`, whose completion re-drains — means
    // this call must not dispatch.
    const blocking = refusals.filter((reason) => reason !== "turn-active");
    if (blocking.length > 0) {
      // HARD refusals (flag-off / session-mismatch / handler-unregistered)
      // leave the message sitting until the user's next manual turn — the
      // silent stall the field hit — so they are logged loudly. A held token
      // is not lost: the next drain trigger re-evaluates it.
      this.audit(
        blocking.every((reason) => SOFT_WAKE_REFUSALS.has(reason)) ? "info" : "warn",
        input,
        `mailbox-no-wake:${refusals.join(",")}`,
      );
      return false;
    }
    const handler = this.wakeHandler;
    // Unreachable in practice — `wakeRefusalReasons` already reported a null
    // handler above — but the narrowing is what lets the call below be typed.
    if (handler === null) return false;

    // Spend the token BEFORE dispatch. Deliveries that arrive while the wake
    // runs set a fresh one and are picked up by the completion drain below;
    // a wake that consumed nothing leaves the map empty and stops.
    this.wakeDirty.delete(parentSessionId);
    this.wakeInFlight.add(parentSessionId);
    try {
      void handler(parentSessionId)
        .then(() => this.audit("info", input, "wake-finished"))
        .catch(() => this.audit("warn", input, "wake-failed"))
        .finally(() => {
          this.wakeInFlight.delete(parentSessionId);
          this.drain(parentSessionId);
        });
    } catch {
      // A handler that throws before returning its promise never attached the
      // cleanup above. Leaving the in-flight mark would refuse every future
      // drain for this parent — now the only delivery path there is.
      this.wakeInFlight.delete(parentSessionId);
      this.wakeDirty.set(parentSessionId, input);
      this.audit("warn", input, "wake-failed");
      return false;
    }
    return true;
  }

  private releaseEphemeralAddress(
    entry: Pick<ParentMailboxEntry, "parentSessionId" | "childSessionId" | "message">
      | ParentMailboxLoadDiagnostic,
  ): void {
    const parentSessionId = entry.parentSessionId;
    const childSessionId = entry.childSessionId;
    const messageId = "message" in entry ? entry.message.messageId : entry.messageId;
    if (!parentSessionId || !childSessionId || !messageId) return;
    this.deps.releaseEphemeralChildAddress?.(
      parentSessionId,
      childSessionId,
      messageId,
    );
    for (const [entryId, lease] of this.ephemeralLeasesByEntryId) {
      if (
        lease.parentSessionId === parentSessionId
        && lease.childSessionId === childSessionId
        && lease.messageId === messageId
      ) {
        this.ephemeralLeasesByEntryId.delete(entryId);
      }
    }
  }

  private wakeFlagEnabled(): boolean {
    // `?? false` only guards the optional `features` type; loadSettings
    // materializes the block on every path. Collapses once AppSettings makes
    // `features` required (follow-up).
    return this.deps.settingsService.get("features")?.subAgentAutonomousWake ?? false;
  }

  /**
   * Every reason wake is currently refused for this parent; empty = wake.
   *
   * Exists because the field failure mode of this gate is SILENCE: a child
   * result reached the mailbox ("stored" audit) and nothing woke the parent,
   * and the audit trail could not say which of the five conditions failed —
   * the flag, a session mismatch, a missing handler, an active turn, or an
   * in-flight wake. The refusal branch now names its reasons (see the
   * mailbox-disposition audit below), turning the next occurrence from
   * archaeology into a log line.
   */
  private wakeRefusalReasons(parentSessionId: string): string[] {
    const reasons: string[] = [];
    if (!this.wakeFlagEnabled()) {
      reasons.push("flag-off");
    }
    if (this.deps.parentLoop.getSessionId() !== parentSessionId) {
      reasons.push("session-mismatch");
    }
    if (this.wakeHandler === null) reasons.push("handler-unregistered");
    if (this.deps.parentLoop.hasActiveTurn()) reasons.push("turn-active");
    if (this.wakeInFlight.has(parentSessionId)) reasons.push("wake-in-flight");
    return reasons;
  }

  private drop(
    input: DeliverToParentInput,
    reason: Exclude<DeliverToParentResult, { ok: true }>["reason"],
  ): DeliverToParentResult {
    this.audit("warn", input, `dropped:${reason}`);
    return { ok: false, disposition: "dropped", reason };
  }

  private auditPersistedDiagnostic(
    diagnostic: ParentMailboxLoadDiagnostic | undefined,
    outcome: string,
  ): void {
    this.audit("warn", {
      parentSessionId: diagnostic?.parentSessionId ?? "unknown",
      childSessionId: diagnostic?.childSessionId,
      message: { messageId: diagnostic?.messageId },
    }, outcome);
  }

  private audit(type: "info" | "warn", input: DeliveryAuditInput, outcome: string): void {
    const rawMessage = (input as { message?: unknown }).message;
    const rawMessageId = rawMessage !== null
      && typeof rawMessage === "object"
      && !Array.isArray(rawMessage)
      ? (rawMessage as { messageId?: unknown }).messageId
      : undefined;
    const messageId = isSafeA2AMessageId(rawMessageId) ? rawMessageId : "invalid";
    const parentSessionId = typeof input.parentSessionId === "string"
      ? input.parentSessionId
      : "unknown";
    const childSessionId = typeof input.childSessionId === "string"
      ? sanitizeA2ALabel(input.childSessionId)
      : "invalid";
    this.deps.auditLogger.log({
      timestamp: new Date().toISOString(),
      sessionId: parentSessionId || "unknown",
      type,
      input: `a2a:parent-delivery:${outcome}:child=${childSessionId}:message=${messageId}`,
    });
  }
}
