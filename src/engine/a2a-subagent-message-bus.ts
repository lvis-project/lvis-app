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
export class A2ASubAgentMessageBus {
  private wakeHandler: ParentWakeHandler | null = null;
  private readonly wakeInFlight = new Set<string>();
  private readonly wakeRecheckPending = new Map<string, DeliverToParentInput>();
  private readonly wakeRecheckInFlight = new Set<string>();
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

    if (address.ephemeralMessageId !== undefined) {
      this.ephemeralLeasesByEntryId.set(entry.id, {
        parentSessionId: entry.parentSessionId,
        childSessionId: entry.childSessionId,
        messageId: address.ephemeralMessageId,
      });
    }

    // A wake handler snapshots the durable mailbox before it starts the turn.
    // Remember deliveries that race that snapshot so completion rechecks the
    // mailbox once. The recheck is mailbox-backed and bounded: a wake that
    // consumes nothing does not schedule itself again.
    if (this.wakeInFlight.has(input.parentSessionId)) {
      this.scheduleWakeRecheck(input.parentSessionId, deliveryInput);
    }

    if (
      this.deps.parentLoop.getSessionId() === input.parentSessionId
      && this.deps.parentLoop.hasActiveTurn()
    ) {
      const queued = this.deps.parentLoop.queueGuidanceWithDisposition(
        entry.formattedText,
        {
          approvalReasonPrefix: entry.approvalLabel,
          onInjected: () => this.acknowledgeParentMailbox(
            entry.parentSessionId,
            [entry.id],
          )
            .then((removed) => this.audit(
              removed === 1 ? "info" : "warn",
              deliveryInput,
              removed === 1 ? "injected" : "ack-failed",
            ))
            .catch(() => this.audit("warn", deliveryInput, "ack-failed")),
          onDropped: (reason) => {
            this.audit("warn", deliveryInput, `deferred:${reason}`);
            if (reason === "turn-ended") {
              this.scheduleWakeRecheck(entry.parentSessionId, deliveryInput);
            } else if (
              reason === "joined-limit"
              && this.canRequestAutonomousWakeForCurrentParent(entry.parentSessionId)
            ) {
              // The guidance was accepted into the active queue but could not
              // join the next model call. The lease-aware handler waits for
              // that turn to release, then revalidates the durable mailbox.
              this.requestWake(entry.parentSessionId, deliveryInput);
            }
          },
        },
      );
      if (queued === "queued") {
        return { ok: true, disposition: "queued", messageId: canonical.message.messageId };
      }
      this.audit("warn", deliveryInput, `deferred:${queued}`);
      if (
        queued === "queue-full"
        && this.canRequestAutonomousWakeForCurrentParent(input.parentSessionId)
      ) {
        // The host wake handler snapshots and awaits the current turn/session
        // lease before revalidating idle state. Request it now so an active
        // queue overflow cannot silently degrade opt-in wake to manual-only.
        this.requestWake(input.parentSessionId, deliveryInput);
        return {
          ok: true,
          disposition: "wake-requested",
          messageId: canonical.message.messageId,
        };
      }
    }

    if (this.shouldWake(input.parentSessionId)) {
      this.requestWake(input.parentSessionId, deliveryInput);
      return { ok: true, disposition: "wake-requested", messageId: canonical.message.messageId };
    }
    return { ok: true, disposition: "mailbox", messageId: canonical.message.messageId };
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

  private shouldWake(parentSessionId: string): boolean {
    return this.canWakeIdleParent(parentSessionId)
      && !this.wakeInFlight.has(parentSessionId);
  }

  private canWakeIdleParent(parentSessionId: string): boolean {
    return this.canRequestAutonomousWakeForCurrentParent(parentSessionId)
      && !this.deps.parentLoop.hasActiveTurn();
  }

  private canRequestAutonomousWakeForCurrentParent(parentSessionId: string): boolean {
    return (this.deps.settingsService.get("features")?.subAgentAutonomousWake ?? false)
      && this.deps.parentLoop.getSessionId() === parentSessionId
      && this.wakeHandler !== null;
  }

  private requestWake(parentSessionId: string, input: DeliverToParentInput): void {
    const handler = this.wakeHandler;
    if (!handler || this.wakeInFlight.has(parentSessionId)) return;
    this.wakeInFlight.add(parentSessionId);
    void handler(parentSessionId)
      .then(() => this.audit("info", input, "wake-finished"))
      .catch(() => this.audit("warn", input, "wake-failed"))
      .finally(() => {
        this.wakeInFlight.delete(parentSessionId);
        this.runWakeRecheck(parentSessionId);
      });
  }

  private scheduleWakeRecheck(parentSessionId: string, input: DeliverToParentInput): void {
    this.wakeRecheckPending.set(parentSessionId, input);
    if (!this.wakeInFlight.has(parentSessionId)) {
      this.runWakeRecheck(parentSessionId);
    }
  }

  private runWakeRecheck(parentSessionId: string): void {
    if (
      this.wakeInFlight.has(parentSessionId)
      || this.wakeRecheckInFlight.has(parentSessionId)
    ) {
      return;
    }
    const input = this.wakeRecheckPending.get(parentSessionId);
    if (!input) return;
    this.wakeRecheckPending.delete(parentSessionId);
    this.wakeRecheckInFlight.add(parentSessionId);

    void this.peekParentMailbox(parentSessionId)
      .then((entries) => {
        if (entries.length > 0 && this.shouldWake(parentSessionId)) {
          this.requestWake(parentSessionId, input);
        }
      })
      .catch(() => this.audit("warn", input, "wake-recheck-failed"))
      .finally(() => {
        this.wakeRecheckInFlight.delete(parentSessionId);
        if (
          this.wakeRecheckPending.has(parentSessionId)
          && !this.wakeInFlight.has(parentSessionId)
        ) {
          this.runWakeRecheck(parentSessionId);
        }
      });
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
