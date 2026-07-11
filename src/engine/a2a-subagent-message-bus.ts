import { randomUUID } from "node:crypto";
import type { AuditLogger } from "../audit/audit-logger.js";
import type { SettingsService } from "../data/settings-store.js";
import { maskSensitiveData } from "../shared/dlp.js";
import {
  A2A_ROLE_AGENT,
  type A2AJsonObject,
  type A2AJsonValue,
  type A2AMessage,
  type A2APart,
} from "../shared/a2a.js";
import type { ConversationLoop } from "./conversation-loop.js";
import { GUIDE_MAX_CHARS } from "./turn/guidance-limits.js";
import { type ParentMailboxEntry, type SubAgentMessageMailbox } from "./subagent-message-mailbox.js";

const MESSAGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;

function isSafeMessageId(value: unknown): value is string {
  return typeof value === "string"
    && MESSAGE_ID_PATTERN.test(value)
    && maskSensitiveData(value).detections.length === 0;
}

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

interface MaskedMessageResult {
  message: A2AMessage;
  detectionCount: number;
}

function sanitizeLabel(value: string): string {
  const masked = maskSensitiveData(value).masked
    .replace(/[^\p{L}\p{N} _.-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return masked.length > 120 ? `${masked.slice(0, 119)}...` : masked;
}

function maskStructuredValue(
  value: unknown,
  seen: Set<object>,
  depth = 0,
): { value: A2AJsonValue; detections: number } {
  if (depth > 20) throw new Error("a2a structured data exceeds maximum depth");
  if (typeof value === "string") {
    const result = maskSensitiveData(value);
    return { value: result.masked, detections: result.detections.length };
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return { value, detections: 0 };
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error("a2a structured data contains a cycle");
    seen.add(value);
    let detections = 0;
    const next = value.map((item) => {
      const masked = maskStructuredValue(item, seen, depth + 1);
      detections += masked.detections;
      return masked.value;
    });
    seen.delete(value);
    return { value: next, detections };
  }
  if (value && typeof value === "object") {
    if (seen.has(value)) throw new Error("a2a structured data contains a cycle");
    seen.add(value);
    let detections = 0;
    const next: A2AJsonObject = {};
    for (const [key, item] of Object.entries(value)) {
      const maskedKey = maskSensitiveData(key);
      const maskedValue = maskStructuredValue(item, seen, depth + 1);
      detections += maskedKey.detections.length + maskedValue.detections;
      next[maskedKey.masked] = maskedValue.value;
    }
    seen.delete(value);
    return { value: next, detections };
  }
  throw new Error("a2a structured data contains an unsupported value");
}

function maskPart(part: A2APart): { part: A2APart; detections: number } {
  const contentFields = [
    part.text !== undefined,
    part.raw !== undefined,
    part.url !== undefined,
    part.data !== undefined,
  ].filter(Boolean).length;
  if (contentFields !== 1) throw new Error("a2a part must contain exactly one content field");
  if (part.raw !== undefined) throw new Error("a2a raw parts are unsupported in ph1");

  let detections = 0;
  const common: {
    metadata?: A2AJsonObject;
    filename?: string;
    mediaType?: string;
  } = {};
  if (part.metadata !== undefined) {
    const result = maskStructuredValue(part.metadata, new Set());
    common.metadata = result.value as A2AJsonObject;
    detections += result.detections;
  }
  if (part.filename !== undefined) {
    const result = maskSensitiveData(part.filename);
    common.filename = result.masked;
    detections += result.detections.length;
  }
  if (part.mediaType !== undefined) {
    const result = maskSensitiveData(part.mediaType);
    common.mediaType = result.masked;
    detections += result.detections.length;
  }
  if (part.text !== undefined) {
    const result = maskSensitiveData(part.text);
    return {
      part: { ...common, text: result.masked },
      detections: detections + result.detections.length,
    };
  }
  if (part.url !== undefined) {
    const result = maskSensitiveData(part.url);
    return {
      part: { ...common, url: result.masked },
      detections: detections + result.detections.length,
    };
  }
  const result = maskStructuredValue(part.data, new Set());
  return {
    part: { ...common, data: result.value },
    detections: detections + result.detections,
  };
}

export function maskA2AMessage(message: A2AMessage): MaskedMessageResult {
  let detectionCount = 0;
  const parts = message.parts.map((part) => {
    const masked = maskPart(part);
    detectionCount += masked.detections;
    return masked.part;
  }) as A2AMessage["parts"];
  const metadata = message.metadata === undefined
    ? undefined
    : maskStructuredValue(message.metadata, new Set());
  if (metadata) detectionCount += metadata.detections;
  const extensions = message.extensions?.map((extension) => {
    const masked = maskSensitiveData(extension);
    detectionCount += masked.detections.length;
    return masked.masked;
  });
  const referenceTaskIds = message.referenceTaskIds?.map((taskId) => {
    const masked = maskSensitiveData(taskId);
    detectionCount += masked.detections.length;
    return masked.masked;
  });
  return {
    message: {
      ...message,
      parts,
      ...(metadata ? { metadata: metadata.value as A2AJsonObject } : {}),
      ...(extensions ? { extensions } : {}),
      ...(referenceTaskIds ? { referenceTaskIds } : {}),
    },
    detectionCount,
  };
}

function renderPart(part: A2APart): string {
  if (part.text !== undefined) return part.text;
  if (part.url !== undefined) {
    const label = part.filename ? `${part.filename}: ` : "";
    return `[file] ${label}${part.url}`;
  }
  if (part.data !== undefined) return JSON.stringify(part.data);
  return "[unsupported part]";
}

export function formatAgentMessage(
  address: ResolvedSubAgentAddress,
  message: A2AMessage,
): { text: string; approvalLabel: string; childTitle: string } {
  const title = sanitizeLabel(address.childTitle) || "sub-agent";
  const approvalLabel = `[Sub-Agent: ${title}]`;
  const body = message.parts.map(renderPart).filter(Boolean).join("\n\n");
  return {
    approvalLabel,
    childTitle: title,
    text: `${approvalLabel} (task ${address.childSessionId}, message ${message.messageId})\n${body}`,
  };
}

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
    if (
      input.message === null
      || typeof input.message !== "object"
      || Array.isArray(input.message)
      || !Array.isArray(input.message.parts)
      || input.message.parts.length === 0
      || input.message.role !== A2A_ROLE_AGENT
      || input.message.contextId !== input.parentSessionId
      || input.message.taskId !== input.childSessionId
      || !isSafeMessageId(input.message.messageId)
    ) {
      return this.drop(input, "invalid-message");
    }

    let masked: MaskedMessageResult;
    try {
      masked = maskA2AMessage(input.message);
    } catch (error) {
      const unsupported = error instanceof Error && error.message.includes("raw parts");
      return this.drop(input, unsupported ? "unsupported-part" : "invalid-message");
    }
    let serializedMessage: string;
    try {
      serializedMessage = JSON.stringify(masked.message);
    } catch {
      return this.drop(input, "invalid-message");
    }
    if (serializedMessage.length > GUIDE_MAX_CHARS) {
      return this.drop(input, "message-too-long");
    }
    const formatted = formatAgentMessage(address, masked.message);
    if (formatted.text.length > GUIDE_MAX_CHARS) return this.drop(input, "message-too-long");
    const deliveryInput: DeliverToParentInput = {
      ...input,
      message: masked.message,
    };

    const entry: ParentMailboxEntry = {
      id: randomUUID(),
      parentSessionId: input.parentSessionId,
      childSessionId: input.childSessionId,
      childTitle: formatted.childTitle,
      createdAt: new Date().toISOString(),
      message: masked.message,
      formattedText: formatted.text,
      approvalLabel: formatted.approvalLabel,
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
    this.audit("info", deliveryInput, `stored:detections=${masked.detectionCount}`);

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
        return { ok: true, disposition: "queued", messageId: masked.message.messageId };
      }
      this.audit("warn", deliveryInput, `deferred:${queued}`);
    }

    if (this.shouldWake(input.parentSessionId)) {
      this.requestWake(input.parentSessionId, deliveryInput);
      return { ok: true, disposition: "wake-requested", messageId: masked.message.messageId };
    }
    return { ok: true, disposition: "mailbox", messageId: masked.message.messageId };
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
    const messageId = isSafeMessageId(rawMessageId) ? rawMessageId : "invalid";
    const parentSessionId = typeof input.parentSessionId === "string"
      ? input.parentSessionId
      : "unknown";
    const childSessionId = typeof input.childSessionId === "string"
      ? sanitizeLabel(input.childSessionId)
      : "invalid";
    this.deps.auditLogger.log({
      timestamp: new Date().toISOString(),
      sessionId: parentSessionId || "unknown",
      type,
      input: `a2a:parent-delivery:${outcome}:child=${childSessionId}:message=${messageId}`,
    });
  }
}
