import type { ConversationLoop } from "./conversation-loop.js";
import type {
  A2APart,
  A2AProjectedTaskState,
} from "../shared/a2a.js";
import { maskSensitiveData } from "../shared/dlp.js";

export const A2A_PARENT_RECIPIENT = "parent" as const;
export const A2A_AGENT_ENVELOPE_VERSION = 1 as const;
export const A2A_CAUSAL_CONTEXT_METADATA_KEY = "a2aCausalContext" as const;

/** Host policy. Neither value is exposed through the agent_send schema. */
export const A2A_AGENT_MAX_HOPS = 8;
export const A2A_AGENT_TREE_MESSAGE_BUDGET = 64;
export const A2A_AGENT_MAX_TRACKED_TREES = 100;

export interface A2ASubAgentAddress {
  childSessionId: string;
  title: string;
}

export interface ResolvedA2ASender extends A2ASubAgentAddress {
  originSessionId: string;
  background: boolean;
  taskState: A2AProjectedTaskState;
}

export type ResolveSubAgentPeerResult =
  | {
      ok: true;
      originSessionId: string;
      sender: A2ASubAgentAddress;
      recipient: A2ASubAgentAddress & {
        taskState: A2AProjectedTaskState;
        activeLoop?: ConversationLoop;
      };
    }
  | {
      ok: false;
      reason: "unknown-sender" | "unknown-recipient" | "cross-origin";
    };

export interface A2AAgentSendRequest {
  senderChildSessionId: string;
  recipient: typeof A2A_PARENT_RECIPIENT | string;
  messageId: string;
  parts: readonly A2APart[];
  waitForReply?: true;
  causalContext?: A2AAgentCausalContext;
}

export interface A2AAgentRouteDraft {
  version: typeof A2A_AGENT_ENVELOPE_VERSION;
  originSessionId: string;
  senderChildSessionId: string;
  recipientChildSessionId: string;
  hopCount: number;
}

export interface A2AAgentMessageEnvelope extends A2AAgentRouteDraft {
  /** Monotonic, durable count within one parent-owned delegation tree. */
  treeSequence: number;
}

export interface A2AAgentCausalContext {
  kind: "a2a-causal-hop";
  version: typeof A2A_AGENT_ENVELOPE_VERSION;
  originSessionId: string;
  recipientChildSessionId: string;
  hopCount: number;
}

export type A2AAgentSendDropReason =
  | "unknown-sender"
  | "unknown-recipient"
  | "cross-origin"
  | "self-send"
  | "terminal-recipient"
  | "recipient-unavailable"
  | "duplicate-message"
  | "invalid-message"
  | "unsupported-part"
  | "message-too-long"
  | "hop-limit"
  | "budget-exhausted"
  | "storage-failed"
  | "message-bus-unavailable"
  | "aborted"
  | "question-already-outstanding";

export type A2AAgentSendResult =
  | {
      ok: true;
      disposition:
        | "queued"
        | "mailbox"
        | "parent"
        | "foreground-return"
        | "question-staged";
      messageId: string;
      /** Canonical DLP-masked message; never serialized in the tool output. */
      canonicalMessage: import("../shared/a2a.js").A2AMessage;
    }
  | {
      ok: false;
      disposition: "dropped";
      reason: A2AAgentSendDropReason;
    };

export interface A2AAgentSendAuditInput {
  senderChildSessionId: string;
  recipient: string;
  messageId?: string;
  reason: A2AAgentSendDropReason;
}

export function isSafeA2AStructuralId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 256
    && !/[\u0000-\u001f\u007f]/.test(value)
    && maskSensitiveData(value).detections.length === 0;
}

export function isA2AAgentCausalContext(value: unknown): value is A2AAgentCausalContext {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return keys.length === 5
    && keys.every((key) => [
      "kind",
      "version",
      "originSessionId",
      "recipientChildSessionId",
      "hopCount",
    ].includes(key))
    && record.kind === "a2a-causal-hop"
    && record.version === A2A_AGENT_ENVELOPE_VERSION
    && isSafeA2AStructuralId(record.originSessionId)
    && isSafeA2AStructuralId(record.recipientChildSessionId)
    && Number.isInteger(record.hopCount)
    && (record.hopCount as number) >= 1
    && (record.hopCount as number) <= A2A_AGENT_MAX_HOPS;
}

export function mergeA2AAgentCausalContexts(
  recipientChildSessionId: string,
  contexts: readonly unknown[],
): A2AAgentCausalContext | undefined {
  if (!isSafeA2AStructuralId(recipientChildSessionId) || contexts.length === 0) {
    return undefined;
  }
  const validated: A2AAgentCausalContext[] = [];
  for (const context of contexts) {
    if (
      !isA2AAgentCausalContext(context)
      || context.recipientChildSessionId !== recipientChildSessionId
    ) {
      return undefined;
    }
    validated.push(context);
  }
  const originSessionId = validated[0]!.originSessionId;
  if (validated.some((context) => context.originSessionId !== originSessionId)) {
    return undefined;
  }
  return {
    kind: "a2a-causal-hop",
    version: A2A_AGENT_ENVELOPE_VERSION,
    originSessionId,
    recipientChildSessionId,
    hopCount: Math.max(...validated.map((context) => context.hopCount)),
  };
}

export function causalContextForEnvelopes(
  recipientChildSessionId: string,
  envelopes: readonly A2AAgentMessageEnvelope[],
): A2AAgentCausalContext | undefined {
  return mergeA2AAgentCausalContexts(
    recipientChildSessionId,
    envelopes.map((envelope) => ({
      kind: "a2a-causal-hop",
      version: A2A_AGENT_ENVELOPE_VERSION,
      originSessionId: envelope.originSessionId,
      recipientChildSessionId: envelope.recipientChildSessionId,
      hopCount: envelope.hopCount,
    })),
  );
}

export function isA2AAgentMessageEnvelope(
  value: unknown,
): value is A2AAgentMessageEnvelope {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== 6
    || !keys.every((key) => [
      "version",
      "originSessionId",
      "senderChildSessionId",
      "recipientChildSessionId",
      "hopCount",
      "treeSequence",
    ].includes(key))
  ) {
    return false;
  }
  return record.version === A2A_AGENT_ENVELOPE_VERSION
    && isSafeA2AStructuralId(record.originSessionId)
    && isSafeA2AStructuralId(record.senderChildSessionId)
    && isSafeA2AStructuralId(record.recipientChildSessionId)
    && Number.isInteger(record.hopCount)
    && (record.hopCount as number) >= 1
    && (record.hopCount as number) <= A2A_AGENT_MAX_HOPS
    && Number.isInteger(record.treeSequence)
    && (record.treeSequence as number) >= 1
    && (record.treeSequence as number) <= A2A_AGENT_TREE_MESSAGE_BUDGET;
}
