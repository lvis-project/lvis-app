import { randomUUID } from "node:crypto";
import type { AuditLogger } from "../audit/audit-logger.js";
import {
  A2A_ROLE_AGENT,
  A2ATaskState,
  isA2ATerminalTaskState,
  type A2AMessage,
} from "../shared/a2a.js";
import {
  canonicalizeAgentMessage,
  isSafeA2AMessageId,
  sanitizeA2ALabel,
} from "./a2a-subagent-message-codec.js";
import type { A2ASubAgentMessageBus } from "./a2a-subagent-message-bus.js";
import {
  A2A_AGENT_ENVELOPE_VERSION,
  A2A_AGENT_MAX_HOPS,
  A2A_PARENT_RECIPIENT,
  causalContextForEnvelopes,
  isA2AAgentCausalContext,
  isSafeA2AStructuralId,
  type A2AAgentCausalContext,
  type A2AAgentMessageEnvelope,
  type A2AAgentSendAuditInput,
  type A2AAgentSendDropReason,
  type A2AAgentSendRequest,
  type A2AAgentSendResult,
  type ResolveSubAgentPeerResult,
  type ResolvedA2ASender,
} from "./a2a-agent-message-envelope.js";
import {
  A2AAgentMessageMailbox,
  type A2AAgentMailboxDiagnostic,
  type A2AAgentMailboxEntry,
} from "./a2a-agent-message-mailbox.js";
import { GUIDE_MAX_CHARS } from "./turn/guidance-limits.js";

export interface A2AAgentMessageBusDeps {
  parentBus: A2ASubAgentMessageBus;
  mailbox: A2AAgentMessageMailbox;
  auditLogger: AuditLogger;
  resolveSender: (senderChildSessionId: string) => Promise<ResolvedA2ASender | null>;
  resolvePeer: (
    senderChildSessionId: string,
    recipientChildSessionId: string,
  ) => Promise<ResolveSubAgentPeerResult>;
  isOriginActive?: (
    originSessionId: string,
  ) => boolean | Promise<boolean>;
}

type GuidanceDisposition = Parameters<
  NonNullable<Extract<ResolveSubAgentPeerResult, { ok: true }>["recipient"]["activeLoop"]>["queueGuidanceWithDisposition"]
>[1] & { a2aCausalContext?: A2AAgentCausalContext };

type PreparedAgentSend = {
  ok: true;
  sender: ResolvedA2ASender;
  message: A2AMessage;
  canonical: Extract<ReturnType<typeof canonicalizeAgentMessage>, { ok: true }>;
  hopCount: number;
};

class StagedQuestionDelivery {
  state: "staged" | "committing" | "committed" | "rolled-back" | "indeterminate" = "staged";

  constructor(
    readonly owner: A2AAgentMessageBus,
    readonly input: A2AAgentSendRequest,
    readonly sender: ResolvedA2ASender,
    readonly message: A2AMessage,
    readonly envelope: A2AAgentMessageEnvelope,
    readonly prompt: string,
  ) {}
}

export type A2AStagedQuestionDelivery = StagedQuestionDelivery;

export type A2AAgentQuestionStageResult =
  | {
      ok: true;
      stage: A2AStagedQuestionDelivery;
      result: Extract<A2AAgentSendResult, { ok: true }>;
    }
  | {
      ok: false;
      result: Extract<A2AAgentSendResult, { ok: false }>;
    };

export type A2ATerminalMailboxCleanupResult =
  | { ok: true; removed: number; retained: number }
  | { ok: false; reason: "storage-failed" };

/** Host-mediated child-to-parent and sibling A2A bus. */
export class A2AAgentMessageBus {
  private sendTail: Promise<void> = Promise.resolve();

  constructor(private readonly deps: A2AAgentMessageBusDeps) {}

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.sendTail.then(operation);
    this.sendTail = run.then(() => undefined, () => undefined);
    return run;
  }

  send(input: A2AAgentSendRequest): Promise<A2AAgentSendResult> {
    return this.serialize(() => this.sendLocked(input));
  }

  stageQuestion(input: A2AAgentSendRequest): Promise<A2AAgentQuestionStageResult> {
    return this.serialize(() => this.stageQuestionLocked(input));
  }

  commitStagedQuestion(
    stage: A2AStagedQuestionDelivery,
  ): Promise<A2AAgentSendResult> {
    return this.serialize(() => this.commitStagedQuestionLocked(stage));
  }

  rollbackStagedQuestion(stage: A2AStagedQuestionDelivery): Promise<boolean> {
    return this.serialize(() => this.rollbackStagedQuestionLocked(stage));
  }

  cleanupTerminalRecipientMailbox(
    recipientChildSessionId: string,
  ): Promise<A2ATerminalMailboxCleanupResult> {
    return this.serialize(() =>
      this.cleanupTerminalRecipientMailboxLocked(recipientChildSessionId));
  }

  async auditToolDrop(input: A2AAgentSendAuditInput): Promise<void> {
    let originSessionId = "unknown";
    try {
      originSessionId = (await this.deps.resolveSender(input.senderChildSessionId))
        ?.originSessionId ?? "unknown";
    } catch {
      // The fail-closed outcome is still recorded under an unknown origin.
    }
    this.audit("warn", {
      originSessionId,
      senderChildSessionId: input.senderChildSessionId,
      recipient: input.recipient,
      messageId: input.messageId,
    }, "dropped:" + input.reason);
  }

  async peekRecipientMailbox(
    recipientChildSessionId: string,
  ): Promise<A2AAgentMailboxEntry[]> {
    const loaded = await this.deps.mailbox.peekWithDiagnostics(recipientChildSessionId);
    for (const diagnostic of loaded.diagnostics) this.auditDiagnostic(diagnostic);
    if (loaded.cleanupFailed) {
      this.audit("warn", {
        originSessionId: "unknown",
        senderChildSessionId: "unknown",
        recipient: recipientChildSessionId,
      }, "drop-cleanup-failed");
      return [];
    }

    const accepted: A2AAgentMailboxEntry[] = [];
    const rejected: A2AAgentMailboxEntry[] = [];
    for (const entry of loaded.entries) {
      let route: ResolveSubAgentPeerResult;
      try {
        route = await this.deps.resolvePeer(
          entry.envelope.senderChildSessionId,
          recipientChildSessionId,
        );
      } catch {
        this.auditEntry("warn", entry, "dropped:storage-failed");
        continue;
      }
      if (!route.ok) {
        this.auditEntry("warn", entry, "dropped:" + route.reason);
        rejected.push(entry);
        continue;
      }
      if (
        route.originSessionId !== entry.envelope.originSessionId
        || route.sender.childSessionId !== entry.envelope.senderChildSessionId
        || route.recipient.childSessionId !== recipientChildSessionId
      ) {
        this.auditEntry("warn", entry, "dropped:cross-origin");
        rejected.push(entry);
        continue;
      }
      if (route.recipient.taskState !== A2ATaskState.INPUT_REQUIRED) {
        this.auditEntry(
          "warn",
          entry,
          isA2ATerminalTaskState(route.recipient.taskState)
            ? "dropped:terminal-recipient"
            : "dropped:recipient-unavailable",
        );
        rejected.push(entry);
        continue;
      }
      const canonical = canonicalizeAgentMessage({
        parentSessionId: route.originSessionId,
        childSessionId: route.sender.childSessionId,
        childTitle: route.sender.title,
      }, entry.message);
      if (
        !canonical.ok
        || canonical.detectionCount !== 0
        || canonical.childTitle !== entry.senderTitle
        || canonical.formattedText !== entry.formattedText
        || canonical.approvalLabel !== entry.approvalLabel
        || sanitizeA2ALabel(route.recipient.title) !== entry.recipientTitle
      ) {
        this.auditEntry("warn", entry, "dropped:invalid-message");
        rejected.push(entry);
        continue;
      }
      accepted.push(entry);
    }

    if (rejected.length > 0) {
      try {
        const removed = await this.deps.mailbox.acknowledge(
          recipientChildSessionId,
          rejected.map((entry) => entry.id),
        );
        if (removed !== rejected.length) {
          this.audit("warn", {
            originSessionId: "unknown",
            senderChildSessionId: "unknown",
            recipient: recipientChildSessionId,
          }, "drop-ack-failed");
          return [];
        }
      } catch {
        this.audit("warn", {
          originSessionId: "unknown",
          senderChildSessionId: "unknown",
          recipient: recipientChildSessionId,
        }, "drop-ack-failed");
        return [];
      }
    }
    return accepted;
  }

  acknowledgeRecipientMailbox(
    recipientChildSessionId: string,
    entries: readonly A2AAgentMailboxEntry[],
  ): Promise<number> {
    return this.deps.mailbox.acknowledge(
      recipientChildSessionId,
      entries.map((entry) => entry.id),
    );
  }

  private async prepareSendLocked(
    input: A2AAgentSendRequest,
  ): Promise<PreparedAgentSend | { ok: false; result: A2AAgentSendResult }> {
    if (!isSafeA2AMessageId(input.messageId)) {
      return { ok: false, result: await this.dropUnknown(input, "invalid-message") };
    }
    let sender: ResolvedA2ASender | null;
    try {
      sender = await this.deps.resolveSender(input.senderChildSessionId);
    } catch {
      return { ok: false, result: this.drop(input, "storage-failed", "unknown") };
    }
    if (!sender || sender.childSessionId !== input.senderChildSessionId) {
      return {
        ok: false,
        result: this.drop(input, "unknown-sender", sender?.originSessionId ?? "unknown"),
      };
    }
    if (sender.taskState !== A2ATaskState.WORKING) {
      return { ok: false, result: this.drop(input, "unknown-sender", sender.originSessionId) };
    }
    if (
      input.recipient !== A2A_PARENT_RECIPIENT
      && !isSafeA2AStructuralId(input.recipient)
    ) {
      return { ok: false, result: this.drop(input, "unknown-recipient", sender.originSessionId) };
    }
    if (input.waitForReply === true && input.recipient !== A2A_PARENT_RECIPIENT) {
      return { ok: false, result: this.drop(input, "invalid-message", sender.originSessionId) };
    }

    const causal = input.causalContext;
    if (
      causal !== undefined
      && (
        !isA2AAgentCausalContext(causal)
        || causal.originSessionId !== sender.originSessionId
        || causal.recipientChildSessionId !== sender.childSessionId
      )
    ) {
      return { ok: false, result: this.drop(input, "cross-origin", sender.originSessionId) };
    }
    const hopCount = (causal?.hopCount ?? 0) + 1;
    if (hopCount > A2A_AGENT_MAX_HOPS) {
      return { ok: false, result: this.drop(input, "hop-limit", sender.originSessionId) };
    }

    const message: A2AMessage = {
      messageId: input.messageId,
      contextId: sender.originSessionId,
      taskId: sender.childSessionId,
      role: A2A_ROLE_AGENT,
      parts: structuredClone(input.parts) as A2AMessage["parts"],
    };
    const canonical = canonicalizeAgentMessage({
      parentSessionId: sender.originSessionId,
      childSessionId: sender.childSessionId,
      childTitle: sender.title,
    }, message);
    if (!canonical.ok) {
      return { ok: false, result: this.drop(input, canonical.reason, sender.originSessionId) };
    }
    let serialized = "";
    try {
      serialized = JSON.stringify(canonical.message);
    } catch {
      return { ok: false, result: this.drop(input, "invalid-message", sender.originSessionId) };
    }
    if (serialized.length > GUIDE_MAX_CHARS || canonical.formattedText.length > GUIDE_MAX_CHARS) {
      return { ok: false, result: this.drop(input, "message-too-long", sender.originSessionId) };
    }
    return {
      ok: true,
      sender,
      message: canonical.message,
      canonical,
      hopCount,
    };
  }

  private async sendLocked(input: A2AAgentSendRequest): Promise<A2AAgentSendResult> {
    const prepared = await this.prepareSendLocked(input);
    if (!prepared.ok) return prepared.result;
    if (input.waitForReply === true) {
      return this.drop(input, "invalid-message", prepared.sender.originSessionId);
    }
    if (input.recipient === A2A_PARENT_RECIPIENT) {
      if (!prepared.sender.background) {
        return this.drop(input, "recipient-unavailable", prepared.sender.originSessionId);
      }
      return await this.sendToParent(
        input,
        prepared.sender,
        prepared.message,
        prepared.hopCount,
      );
    }
    return await this.sendToPeer(
      input,
      prepared.sender,
      prepared.canonical,
      prepared.hopCount,
    );
  }

  private buildQuestionCommitMessage(
    message: A2AMessage,
    sender: ResolvedA2ASender,
    prompt: string,
  ): A2AMessage {
    return {
      ...structuredClone(message),
      metadata: {
        ...(message.metadata ?? {}),
        taskState: A2ATaskState.INPUT_REQUIRED,
        suspension: {
          reason: "question",
          prompt,
          resumeId: sender.childSessionId,
        },
      },
    };
  }

  private async stageQuestionLocked(
    input: A2AAgentSendRequest,
  ): Promise<A2AAgentQuestionStageResult> {
    const prepared = await this.prepareSendLocked(input);
    if (!prepared.ok) {
      return { ok: false, result: prepared.result as Extract<A2AAgentSendResult, { ok: false }> };
    }
    if (input.waitForReply !== true || input.recipient !== A2A_PARENT_RECIPIENT) {
      return {
        ok: false,
        result: this.drop(
          input,
          "invalid-message",
          prepared.sender.originSessionId,
        ) as Extract<A2AAgentSendResult, { ok: false }>,
      };
    }
    const part = prepared.message.parts.length === 1
      ? prepared.message.parts[0]
      : undefined;
    const prompt = part && "text" in part && typeof part.text === "string"
      ? part.text.trim()
      : "";
    if (!prompt) {
      return {
        ok: false,
        result: this.drop(
          input,
          "invalid-message",
          prepared.sender.originSessionId,
        ) as Extract<A2AAgentSendResult, { ok: false }>,
      };
    }
    try {
      const committedMessage = this.buildQuestionCommitMessage(
        prepared.message,
        prepared.sender,
        prompt,
      );
      if (JSON.stringify(committedMessage).length > GUIDE_MAX_CHARS) {
        return {
          ok: false,
          result: this.drop(
            input,
            "message-too-long",
            prepared.sender.originSessionId,
          ) as Extract<A2AAgentSendResult, { ok: false }>,
        };
      }
    } catch {
      return {
        ok: false,
        result: this.drop(
          input,
          "invalid-message",
          prepared.sender.originSessionId,
        ) as Extract<A2AAgentSendResult, { ok: false }>,
      };
    }
    const allocated = await this.allocate(
      input,
      prepared.sender.originSessionId,
      A2A_PARENT_RECIPIENT,
      prepared.hopCount,
    );
    if (!allocated.ok) {
      return {
        ok: false,
        result: allocated.result as Extract<A2AAgentSendResult, { ok: false }>,
      };
    }
    const stage = new StagedQuestionDelivery(
      this,
      structuredClone(input),
      prepared.sender,
      prepared.message,
      allocated.envelope,
      prompt,
    );
    return {
      ok: true,
      stage,
      result: {
        ok: true,
        disposition: "question-staged",
        messageId: prepared.message.messageId,
        canonicalMessage: prepared.message,
      },
    };
  }

  private async commitStagedQuestionLocked(
    stage: A2AStagedQuestionDelivery,
  ): Promise<A2AAgentSendResult> {
    if (!(stage instanceof StagedQuestionDelivery) || stage.owner !== this) {
      return { ok: false, disposition: "dropped", reason: "invalid-message" };
    }
    if (stage.state !== "staged") {
      return this.drop(stage.input, "duplicate-message", stage.sender.originSessionId);
    }
    stage.state = "committing";
    const message = this.buildQuestionCommitMessage(
      stage.message,
      stage.sender,
      stage.prompt,
    );
    if (stage.sender.background) {
      let delivered;
      try {
        delivered = await this.deps.parentBus.deliverToParent({
          parentSessionId: stage.sender.originSessionId,
          childSessionId: stage.sender.childSessionId,
          message,
        });
      } catch {
        delivered = { ok: false as const, reason: "storage-failed" as const };
      }
      if (!delivered.ok) {
        let rolledBack = false;
        try {
          rolledBack = await this.deps.mailbox.rollbackEnvelope(stage.envelope);
        } catch {
          rolledBack = false;
        }
        // A failed rollback leaves one bounded ledger allocation behind. The
        // stage must still become terminal: retrying either operation could
        // duplicate a parent edge after an indeterminate delivery.
        stage.state = rolledBack ? "rolled-back" : "indeterminate";
        return this.drop(
          stage.input,
          rolledBack ? this.mapParentDrop(delivered.reason) : "storage-failed",
          stage.sender.originSessionId,
        );
      }
      stage.state = "committed";
      this.audit("info", {
        originSessionId: stage.sender.originSessionId,
        senderChildSessionId: stage.sender.childSessionId,
        recipient: A2A_PARENT_RECIPIENT,
        messageId: message.messageId,
      }, "delivered:parent:hop=" + stage.envelope.hopCount
        + ":sequence=" + stage.envelope.treeSequence);
      return {
        ok: true,
        disposition: "parent",
        messageId: message.messageId,
        canonicalMessage: message,
      };
    }

    stage.state = "committed";
    this.audit("info", {
      originSessionId: stage.sender.originSessionId,
      senderChildSessionId: stage.sender.childSessionId,
      recipient: A2A_PARENT_RECIPIENT,
      messageId: message.messageId,
    }, "delivered:foreground-return:hop=" + stage.envelope.hopCount
      + ":sequence=" + stage.envelope.treeSequence);
    return {
      ok: true,
      disposition: "foreground-return",
      messageId: message.messageId,
      canonicalMessage: message,
    };
  }

  private async rollbackStagedQuestionLocked(
    stage: A2AStagedQuestionDelivery,
  ): Promise<boolean> {
    if (
      !(stage instanceof StagedQuestionDelivery)
      || stage.owner !== this
      || stage.state !== "staged"
    ) {
      return false;
    }
    try {
      const rolledBack = await this.deps.mailbox.rollbackEnvelope(stage.envelope);
      if (rolledBack) stage.state = "rolled-back";
      return rolledBack;
    } catch {
      return false;
    }
  }

  private async cleanupTerminalRecipientMailboxLocked(
    recipientChildSessionId: string,
  ): Promise<A2ATerminalMailboxCleanupResult> {
    let loaded;
    try {
      loaded = await this.deps.mailbox.peekWithDiagnostics(recipientChildSessionId);
    } catch {
      return { ok: false, reason: "storage-failed" };
    }
    for (const diagnostic of loaded.diagnostics) this.auditDiagnostic(diagnostic);
    if (loaded.cleanupFailed) return { ok: false, reason: "storage-failed" };

    const removable: Array<{ entry: A2AAgentMailboxEntry; outcome: string }> = [];
    let retained = 0;
    for (const entry of loaded.entries) {
      let route: ResolveSubAgentPeerResult;
      try {
        route = await this.deps.resolvePeer(
          entry.envelope.senderChildSessionId,
          recipientChildSessionId,
        );
      } catch {
        this.auditEntry("warn", entry, "cleanup-deferred:storage-failed");
        retained += 1;
        continue;
      }
      if (!route.ok) {
        removable.push({ entry, outcome: "dropped:" + route.reason });
        continue;
      }
      if (
        route.originSessionId !== entry.envelope.originSessionId
        || route.sender.childSessionId !== entry.envelope.senderChildSessionId
        || route.recipient.childSessionId !== recipientChildSessionId
      ) {
        removable.push({ entry, outcome: "dropped:cross-origin" });
        continue;
      }
      if (isA2ATerminalTaskState(route.recipient.taskState)) {
        removable.push({ entry, outcome: "dropped:terminal-recipient" });
      } else {
        retained += 1;
      }
    }

    if (removable.length === 0) return { ok: true, removed: 0, retained };
    let removed: number;
    try {
      removed = await this.deps.mailbox.acknowledge(
        recipientChildSessionId,
        removable.map(({ entry }) => entry.id),
      );
    } catch {
      return { ok: false, reason: "storage-failed" };
    }
    if (removed !== removable.length) return { ok: false, reason: "storage-failed" };
    for (const { entry, outcome } of removable) this.auditEntry("warn", entry, outcome);
    return { ok: true, removed, retained };
  }

  private async sendToParent(
    input: A2AAgentSendRequest,
    sender: ResolvedA2ASender,
    message: A2AMessage,
    hopCount: number,
  ): Promise<A2AAgentSendResult> {
    const allocated = await this.allocate(
      input,
      sender.originSessionId,
      A2A_PARENT_RECIPIENT,
      hopCount,
    );
    if (!allocated.ok) return allocated.result;
    let delivered;
    try {
      delivered = await this.deps.parentBus.deliverToParent({
        parentSessionId: sender.originSessionId,
        childSessionId: sender.childSessionId,
        message,
      });
    } catch {
      delivered = { ok: false as const, reason: "storage-failed" as const };
    }
    if (!delivered.ok) {
      let rolledBack = false;
      try {
        rolledBack = await this.deps.mailbox.rollbackEnvelope(allocated.envelope);
      } catch {
        rolledBack = false;
      }
      return this.drop(
        input,
        rolledBack ? this.mapParentDrop(delivered.reason) : "storage-failed",
        sender.originSessionId,
      );
    }
    this.audit("info", {
      originSessionId: sender.originSessionId,
      senderChildSessionId: sender.childSessionId,
      recipient: A2A_PARENT_RECIPIENT,
      messageId: message.messageId,
    }, "delivered:parent:hop=" + hopCount + ":sequence=" + allocated.envelope.treeSequence);
    return {
      ok: true,
      disposition: "parent",
      messageId: message.messageId,
      canonicalMessage: message,
    };
  }

  private async sendToPeer(
    input: A2AAgentSendRequest,
    sender: ResolvedA2ASender,
    canonical: Extract<ReturnType<typeof canonicalizeAgentMessage>, { ok: true }>,
    hopCount: number,
  ): Promise<A2AAgentSendResult> {
    if (input.recipient === sender.childSessionId) {
      return this.drop(input, "self-send", sender.originSessionId);
    }
    let route: ResolveSubAgentPeerResult;
    try {
      route = await this.deps.resolvePeer(sender.childSessionId, input.recipient);
    } catch {
      return this.drop(input, "storage-failed", sender.originSessionId);
    }
    if (!route.ok) return this.drop(input, route.reason, sender.originSessionId);
    if (
      route.originSessionId !== sender.originSessionId
      || route.sender.childSessionId !== sender.childSessionId
      || route.recipient.childSessionId !== input.recipient
    ) {
      return this.drop(input, "cross-origin", sender.originSessionId);
    }
    if (isA2ATerminalTaskState(route.recipient.taskState)) {
      return this.drop(input, "terminal-recipient", sender.originSessionId);
    }

    const active = route.recipient.taskState === A2ATaskState.WORKING
      && route.recipient.activeLoop?.hasActiveTurn() === true;
    const idle = route.recipient.taskState === A2ATaskState.INPUT_REQUIRED;
    if (!active && !idle) {
      return this.drop(input, "recipient-unavailable", sender.originSessionId);
    }

    const allocated = await this.allocate(
      input,
      sender.originSessionId,
      route.recipient.childSessionId,
      hopCount,
    );
    if (!allocated.ok) return allocated.result;
    const entry: A2AAgentMailboxEntry = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      envelope: allocated.envelope,
      senderTitle: canonical.childTitle,
      recipientTitle: sanitizeA2ALabel(route.recipient.title),
      message: canonical.message,
      formattedText: canonical.formattedText,
      approvalLabel: canonical.approvalLabel,
    };
    let stored;
    try {
      stored = await this.deps.mailbox.enqueue(entry);
    } catch {
      await this.deps.mailbox.rollbackEnvelope(allocated.envelope);
      return this.drop(input, "storage-failed", sender.originSessionId);
    }
    if (!stored.ok) {
      await this.deps.mailbox.rollbackEnvelope(allocated.envelope);
      return this.drop(
        input,
        stored.reason === "duplicate-message"
          ? "duplicate-message"
          : stored.reason === "message-too-long"
            ? "message-too-long"
            : "budget-exhausted",
        sender.originSessionId,
      );
    }
    this.auditEntry("info", entry, "stored");
    if (idle) {
      return {
        ok: true,
        disposition: "mailbox",
        messageId: canonical.message.messageId,
        canonicalMessage: canonical.message,
      };
    }

    const loop = route.recipient.activeLoop!;
    const queuedCausalContext = causalContextForEnvelopes(
      route.recipient.childSessionId,
      [entry.envelope],
    );
    if (!queuedCausalContext) {
      try {
        const removed = await this.deps.mailbox.acknowledge(
          route.recipient.childSessionId,
          [entry.id],
        );
        const rolledBack = await this.deps.mailbox.rollbackEnvelope(allocated.envelope);
        if (removed !== 1 || !rolledBack) {
          return this.drop(input, "storage-failed", sender.originSessionId);
        }
      } catch {
        return this.drop(input, "storage-failed", sender.originSessionId);
      }
      return this.drop(input, "cross-origin", sender.originSessionId);
    }
    const disposition: GuidanceDisposition = {
      approvalReasonPrefix: entry.approvalLabel,
      a2aCausalContext: queuedCausalContext,
      onInjected: () => {
        return this.acknowledgeRecipientMailbox(route.recipient.childSessionId, [entry])
          .then((removed) => this.auditEntry(
            removed === 1 ? "info" : "warn",
            entry,
            removed === 1 ? "injected" : "ack-failed",
          ))
          .catch(() => this.auditEntry("warn", entry, "ack-failed"));
      },
      onDropped: (reason) => this.auditEntry("warn", entry, "deferred:" + reason),
    };
    const queued = loop.queueGuidanceWithDisposition(entry.formattedText, disposition);
    if (queued === "queued") {
      return {
        ok: true,
        disposition: "queued",
        messageId: canonical.message.messageId,
        canonicalMessage: canonical.message,
      };
    }
    if (queued === "queue-full") {
      try {
        const removed = await this.deps.mailbox.acknowledge(
          route.recipient.childSessionId,
          [entry.id],
        );
        const rolledBack = await this.deps.mailbox.rollbackEnvelope(allocated.envelope);
        if (removed !== 1 || !rolledBack) {
          return this.drop(input, "storage-failed", sender.originSessionId);
        }
      } catch {
        return this.drop(input, "storage-failed", sender.originSessionId);
      }
      return this.drop(input, "budget-exhausted", sender.originSessionId);
    }

    let refreshed: ResolveSubAgentPeerResult;
    try {
      refreshed = await this.deps.resolvePeer(sender.childSessionId, input.recipient);
    } catch {
      refreshed = { ok: false, reason: "unknown-recipient" };
    }
    if (refreshed.ok && refreshed.recipient.taskState === A2ATaskState.INPUT_REQUIRED) {
      this.auditEntry("warn", entry, "deferred:" + queued);
      return {
        ok: true,
        disposition: "mailbox",
        messageId: canonical.message.messageId,
        canonicalMessage: canonical.message,
      };
    }

    try {
      await this.deps.mailbox.acknowledge(route.recipient.childSessionId, [entry.id]);
      await this.deps.mailbox.rollbackEnvelope(allocated.envelope);
    } catch {
      return this.drop(input, "storage-failed", sender.originSessionId);
    }
    return this.drop(
      input,
      refreshed.ok && isA2ATerminalTaskState(refreshed.recipient.taskState)
        ? "terminal-recipient"
        : "recipient-unavailable",
      sender.originSessionId,
    );
  }

  private async allocate(
    input: A2AAgentSendRequest,
    originSessionId: string,
    recipientChildSessionId: string,
    hopCount: number,
  ): Promise<
    | { ok: true; envelope: A2AAgentMailboxEntry["envelope"] }
    | { ok: false; result: A2AAgentSendResult }
  > {
    try {
      const allocated = await this.deps.mailbox.allocateEnvelope({
        version: A2A_AGENT_ENVELOPE_VERSION,
        originSessionId,
        senderChildSessionId: input.senderChildSessionId,
        recipientChildSessionId,
        hopCount,
      }, this.deps.isOriginActive);
      if (allocated.ok) return allocated;
      return {
        ok: false,
        result: this.drop(
          input,
          allocated.reason === "hop-limit" ? "hop-limit" : "budget-exhausted",
          originSessionId,
        ),
      };
    } catch {
      return {
        ok: false,
        result: this.drop(input, "storage-failed", originSessionId),
      };
    }
  }

  private mapParentDrop(reason: string): A2AAgentSendDropReason {
    switch (reason) {
      case "unknown-child": return "unknown-sender";
      case "cross-origin": return "cross-origin";
      case "duplicate-message": return "duplicate-message";
      case "invalid-message": return "invalid-message";
      case "unsupported-part": return "unsupported-part";
      case "message-too-long": return "message-too-long";
      case "budget-exhausted": return "budget-exhausted";
      case "storage-failed": return "storage-failed";
      default: return "message-bus-unavailable";
    }
  }

  private async dropUnknown(
    input: A2AAgentSendRequest,
    reason: A2AAgentSendDropReason,
  ): Promise<A2AAgentSendResult> {
    await this.auditToolDrop({
      senderChildSessionId: input.senderChildSessionId,
      recipient: input.recipient,
      messageId: input.messageId,
      reason,
    });
    return { ok: false, disposition: "dropped", reason };
  }

  private drop(
    input: A2AAgentSendRequest,
    reason: A2AAgentSendDropReason,
    originSessionId: string,
  ): A2AAgentSendResult {
    this.audit("warn", {
      originSessionId,
      senderChildSessionId: input.senderChildSessionId,
      recipient: input.recipient,
      messageId: input.messageId,
    }, "dropped:" + reason);
    return { ok: false, disposition: "dropped", reason };
  }

  private auditDiagnostic(diagnostic: A2AAgentMailboxDiagnostic): void {
    this.audit("warn", {
      originSessionId: diagnostic.originSessionId ?? "unknown",
      senderChildSessionId: diagnostic.senderChildSessionId ?? "unknown",
      recipient: diagnostic.recipientChildSessionId ?? "unknown",
      messageId: diagnostic.messageId,
    }, "dropped:" + diagnostic.reason);
  }

  private auditEntry(
    type: "info" | "warn",
    entry: A2AAgentMailboxEntry,
    outcome: string,
  ): void {
    this.audit(type, {
      originSessionId: entry.envelope.originSessionId,
      senderChildSessionId: entry.envelope.senderChildSessionId,
      recipient: entry.envelope.recipientChildSessionId,
      messageId: entry.message.messageId,
    }, outcome + ":hop=" + entry.envelope.hopCount
      + ":sequence=" + entry.envelope.treeSequence);
  }

  private audit(
    type: "info" | "warn",
    input: {
      originSessionId: string;
      senderChildSessionId: string;
      recipient: string;
      messageId?: string;
    },
    outcome: string,
  ): void {
    const sender = sanitizeA2ALabel(input.senderChildSessionId);
    const recipient = sanitizeA2ALabel(input.recipient);
    const messageId = isSafeA2AMessageId(input.messageId) ? input.messageId : "invalid";
    this.deps.auditLogger.log({
      timestamp: new Date().toISOString(),
      sessionId: input.originSessionId || "unknown",
      type,
      input: [
        "a2a:agent-delivery:", outcome,
        ":sender=", sender,
        ":recipient=", recipient,
        ":message=", messageId,
      ].join(""),
    });
  }
}
