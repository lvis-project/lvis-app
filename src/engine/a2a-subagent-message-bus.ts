import { randomUUID } from "node:crypto";
import type { AuditLogger } from "../audit/audit-logger.js";
import type { SettingsService } from "../data/settings-store.js";
import type { A2AMessage } from "../shared/a2a.js";
import type { ConversationLoop } from "./conversation-loop.js";
import { GUIDE_MAX_CHARS } from "./turn/guidance-limits.js";
import { type ParentMailboxEntry, type SubAgentMessageMailbox } from "./subagent-message-mailbox.js";
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
}

export interface DeliverToParentInput {
  parentSessionId: string;
  childSessionId: string;
  message: A2AMessage;
}

export type DeliverToParentResult =
  | { ok: true; disposition: "queued" | "mailbox" | "wake-requested"; messageId: string }
  | {
      ok: false;
      disposition: "dropped";
      reason:
        | "unknown-child"
        | "cross-origin"
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

  constructor(
    private readonly deps: {
      parentLoop: ConversationLoop;
      mailbox: SubAgentMessageMailbox;
      settingsService: SettingsService;
      auditLogger: AuditLogger;
      resolveChildAddress: (
        parentSessionId: string,
        childSessionId: string,
      ) => Promise<ResolvedSubAgentAddress | null>;
    },
  ) {}

  setWakeHandler(handler: ParentWakeHandler | null): void {
    this.wakeHandler = handler;
  }

  peekParentMailbox(parentSessionId: string): Promise<ParentMailboxEntry[]> {
    return this.deps.mailbox.peek(parentSessionId);
  }

  acknowledgeParentMailbox(
    parentSessionId: string,
    ids: readonly string[],
  ): Promise<number> {
    return this.deps.mailbox.acknowledge(parentSessionId, ids);
  }

  async deliverToParent(input: DeliverToParentInput): Promise<DeliverToParentResult> {
    let address: ResolvedSubAgentAddress | null;
    try {
      address = await this.deps.resolveChildAddress(
        input.parentSessionId,
        input.childSessionId,
      );
    } catch {
      return this.drop(input, "storage-failed");
    }
    if (!address) return this.drop(input, "unknown-child");
    if (address.parentSessionId !== input.parentSessionId) {
      return this.drop(input, "cross-origin");
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
      const reason = stored.reason === "message-too-long" ? "message-too-long" : "budget-exhausted";
      return this.drop(input, reason);
    }
    this.audit("info", deliveryInput, `stored:detections=${canonical.detectionCount}`);

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
          onInjected: () => this.deps.mailbox
            .acknowledge(entry.parentSessionId, [entry.id])
            .then(() => this.audit("info", deliveryInput, "injected"))
            .catch(() => this.audit("warn", deliveryInput, "ack-failed")),
          onDropped: (reason) => {
            this.audit("warn", deliveryInput, `deferred:${reason}`);
            if (reason === "turn-ended") {
              this.scheduleWakeRecheck(entry.parentSessionId, deliveryInput);
            }
          },
        },
      );
      if (queued === "queued") {
        return { ok: true, disposition: "queued", messageId: canonical.message.messageId };
      }
      this.audit("warn", deliveryInput, `deferred:${queued}`);
    }

    if (this.shouldWake(input.parentSessionId)) {
      this.requestWake(input.parentSessionId, deliveryInput);
      return { ok: true, disposition: "wake-requested", messageId: canonical.message.messageId };
    }
    return { ok: true, disposition: "mailbox", messageId: canonical.message.messageId };
  }

  private shouldWake(parentSessionId: string): boolean {
    return this.canWakeIdleParent(parentSessionId)
      && !this.wakeInFlight.has(parentSessionId);
  }

  private canWakeIdleParent(parentSessionId: string): boolean {
    return (this.deps.settingsService.get("features")?.subAgentAutonomousWake ?? false)
      && this.deps.parentLoop.getSessionId() === parentSessionId
      && !this.deps.parentLoop.hasActiveTurn()
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

    void this.deps.mailbox.peek(parentSessionId)
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

  private audit(type: "info" | "warn", input: DeliverToParentInput, outcome: string): void {
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
