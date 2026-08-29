import { createDynamicTool, type Tool } from "./base.js";
import type { ToolResult } from "./types.js";
import type { A2APart } from "../shared/a2a.js";
import {
  A2A_CAUSAL_CONTEXT_METADATA_KEY,
  A2A_PARENT_RECIPIENT,
  isA2AAgentCausalContext,
  isSafeA2AStructuralId,
  type A2AAgentSendAuditInput,
  type A2AAgentSendRequest,
  type A2AAgentSendResult,
} from "../engine/a2a-agent-message-envelope.js";
import { GUIDE_MAX_CHARS } from "../engine/turn/guidance-limits.js";
import { createDlpSafeUuid } from "../shared/dlp-safe-id.js";
import { isRecord } from "../shared/is-record.js";

export const A2A_INPUT_REQUIRED_CONTROL_KIND = "a2a-input-required" as const;
export const A2A_INPUT_REQUIRED_CONTROL_VERSION = 1 as const;
const MAX_AGENT_SEND_PARTS = 16;

export interface A2AQuestionInputRequiredControl {
  kind: typeof A2A_INPUT_REQUIRED_CONTROL_KIND;
  version: typeof A2A_INPUT_REQUIRED_CONTROL_VERSION;
  reason: "question";
  prompt: string;
}

export function isA2AQuestionInputRequiredControl(
  value: unknown,
): value is A2AQuestionInputRequiredControl {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return keys.length === 4
    && keys.every((key) => ["kind", "version", "reason", "prompt"].includes(key))
    && record.kind === A2A_INPUT_REQUIRED_CONTROL_KIND
    && record.version === A2A_INPUT_REQUIRED_CONTROL_VERSION
    && record.reason === "question"
    && typeof record.prompt === "string"
    && record.prompt.trim().length > 0
    && record.prompt.length <= GUIDE_MAX_CHARS
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(record.prompt);
}

export type A2AQuestionWaitReservation =
  | { ok: true; token: unknown }
  | { ok: false; reason: "question-already-outstanding" };

export interface AgentSendRuntime {
  sendAgentMessage(input: A2AAgentSendRequest): Promise<A2AAgentSendResult>;
  auditAgentSendDrop(input: A2AAgentSendAuditInput): void | Promise<void>;
  reserveQuestionWait(
    senderChildSessionId: string,
    prompt: string,
  ): A2AQuestionWaitReservation | Promise<A2AQuestionWaitReservation>;
  cancelQuestionWait(
    senderChildSessionId: string,
    token: unknown,
  ): void | Promise<void>;
}

export interface AgentSendToolDeps {
  getRuntime: () => AgentSendRuntime | undefined;
}

function validatePart(value: unknown): { ok: true; part: A2APart } | {
  ok: false;
  reason: "invalid-message" | "unsupported-part";
} {
  if (!isRecord(value)) return { ok: false, reason: "invalid-message" };
  const allowed = new Set(["text", "raw", "url", "data", "metadata", "filename", "mediaType"]);
  if (!Object.keys(value).every((key) => allowed.has(key))) {
    return { ok: false, reason: "invalid-message" };
  }
  const contentKeys = ["text", "raw", "url", "data"].filter((key) =>
    Object.prototype.hasOwnProperty.call(value, key));
  if (contentKeys.length !== 1) return { ok: false, reason: "invalid-message" };
  if (contentKeys[0] === "raw") return { ok: false, reason: "unsupported-part" };
  if (
    (contentKeys[0] === "text" || contentKeys[0] === "url")
    && typeof value[contentKeys[0]!] !== "string"
  ) {
    return { ok: false, reason: "invalid-message" };
  }
  if (contentKeys[0] === "data" && value.data === undefined) {
    return { ok: false, reason: "invalid-message" };
  }
  if (value.metadata !== undefined && !isRecord(value.metadata)) {
    return { ok: false, reason: "invalid-message" };
  }
  if (value.filename !== undefined && typeof value.filename !== "string") {
    return { ok: false, reason: "invalid-message" };
  }
  if (value.mediaType !== undefined && typeof value.mediaType !== "string") {
    return { ok: false, reason: "invalid-message" };
  }
  return { ok: true, part: structuredClone(value) as unknown as A2APart };
}

/**
 * Every way a send can be refused.
 *
 * Declared as a union rather than plain strings so {@link SEND_FAILURE_GUIDANCE}
 * has to cover all of them: adding a refusal without saying what to do about it
 * then fails to compile, instead of silently shipping a bare error token.
 */
export type AgentSendFailureReason =
  | "recipient-unavailable"
  | "terminal-recipient"
  | "cross-origin"
  | "unknown-sender"
  | "unknown-recipient"
  | "message-bus-unavailable"
  | "invalid-message"
  | "storage-failed"
  | "aborted";

/**
 * What the caller should DO about a refusal.
 *
 * A bare `{"error":"recipient-unavailable"}` tells the model that something
 * failed but not what to try instead, which is how a refused send turns into a
 * guess — re-sending in a loop, or asking for a replacement sub-agent to be
 * spawned when the existing one is merely idle. `agent_guide` and `agent_spawn`
 * both attach guidance to their failures; this is the same treatment for the
 * one A2A tool that lacked it.
 */
export const SEND_FAILURE_GUIDANCE: Readonly<Record<AgentSendFailureReason, string>> =
  Object.freeze({
    "recipient-unavailable":
      "The recipient is not accepting messages right now — it is neither running nor waiting for input. This is a timing miss, not a permanent failure: do NOT re-send in a loop, and do NOT ask for a replacement agent to be spawned. Carry on with what you can do and report what you still needed from it.",
    "terminal-recipient":
      "The recipient has finished and can never receive another message. Use whatever it already returned; if the work is still open, say so rather than waiting.",
    "cross-origin":
      "That childSessionId belongs to another conversation's agent, so it is not addressable from here. Only your parent and your sibling sub-agents are.",
    "unknown-sender":
      "agent_send is callable only from INSIDE a sub-agent. From a parent conversation, steer a RUNNING sub-agent with agent_guide, or continue a SUSPENDED one with agent_spawn using its resumeId.",
    "unknown-recipient":
      "No sub-agent has that childSessionId. Agent names are not addresses — take the exact childSessionId from agent_list or agent_status.",
    "message-bus-unavailable":
      "A2A messaging is not wired up in this run, so no send can succeed. Do not retry; finish what you can alone and report the gap.",
    "invalid-message":
      "The message payload was rejected before delivery. Re-send with plain text content rather than retrying the same payload unchanged.",
    "storage-failed":
      "The message could not be durably recorded, so it was not delivered. One retry is reasonable; if it fails again, treat the channel as unavailable and continue without it.",
    aborted:
      "The turn was stopped while this send was in flight. Do not re-send automatically — the stop was deliberate.",
  });

function resultError(reason: string): ToolResult {
  const guidance = (SEND_FAILURE_GUIDANCE as Record<string, string | undefined>)[reason];
  return {
    output: JSON.stringify({ error: reason, ...(guidance ? { guidance } : {}) }),
    isError: true,
  };
}

export function createAgentSendTool(deps: AgentSendToolDeps): Tool {
  return createDynamicTool({
    name: "agent_send",
    description: "Send an A2A message from inside a sub-agent to its parent or a sibling sub-agent by childSessionId. Set waitForReply only when asking the parent a question.",
    source: "builtin",
    category: "meta",
    decisionOverride: "always-allow-with-audit",
    // Hidden at the root scope on purpose: execute() rejects every non-child
    // caller (`spawnDepth !== 1`), so a root-visible schema would advertise a
    // tool the parent can never successfully call — the model would try
    // `agent_send(to: <child>)` and get a bare "unknown-sender". The sub-agent
    // runner re-registers this tool `modelVisible: true` for children only
    // (`buildChildDeps`), which is the one scope where it works. The parent's
    // own outbound paths are separate tools: `agent_guide` addresses a child
    // (delivered live to a running one, or queued in the durable parent
    // directive mailbox for a suspended one), and `agent_spawn(resumeId=...)`
    // continues a suspended child with new instructions.
    //
    // This grants no new authority. `agent_send` moves a message; it mutates no
    // file and touches no network. Whatever the recipient does with the message
    // re-enters this same permission pipeline at the recipient's own tool calls,
    // which is where effects are gated.
    modelVisible: false,
    jsonSchema: {
      type: "object",
      additionalProperties: false,
      required: ["to", "parts"],
      properties: {
        to: {
          type: "string",
          description: "The literal parent or a sibling childSessionId. Agent names are not addresses.",
        },
        parts: {
          type: "array",
          minItems: 1,
          maxItems: MAX_AGENT_SEND_PARTS,
          items: {
            type: "object",
            description: "One A2A part. Allowed shapes: Text {text, metadata?}; URL file {url, filename?, mediaType?, metadata?}; Data {data, metadata?}. Raw file parts are unsupported.",
          },
        },
        waitForReply: {
          type: "boolean",
          description: "Only for to=parent. Ends this child turn as INPUT_REQUIRED(question) after successful delivery.",
        },
      },
    },
    execute: async (rawInput, ctx) => {
      const runtime = deps.getRuntime();
      const senderChildSessionId = typeof ctx.metadata?.sessionId === "string"
        ? ctx.metadata.sessionId
        : "";
      const messageId = createDlpSafeUuid();
      const rawRecipient = isRecord(rawInput) && typeof rawInput.to === "string"
        ? rawInput.to.trim()
        : "invalid";
      const fail = async (reason: A2AAgentSendAuditInput["reason"]): Promise<ToolResult> => {
        try {
          await runtime?.auditAgentSendDrop({
            senderChildSessionId: senderChildSessionId || "invalid",
            recipient: rawRecipient,
            messageId,
            reason,
          });
        } catch {
          // Audit backend failure must not turn a rejected message into delivery.
        }
        return resultError(reason);
      };

      if (!runtime) return await fail("message-bus-unavailable");
      if (ctx.metadata?.spawnDepth !== 1 || !isSafeA2AStructuralId(senderChildSessionId)) {
        return await fail("unknown-sender");
      }
      if (!isRecord(rawInput)) return await fail("invalid-message");
      const keys = Object.keys(rawInput);
      if (!keys.every((key) => ["to", "parts", "waitForReply"].includes(key))) {
        return await fail("invalid-message");
      }
      const recipient = typeof rawInput.to === "string" ? rawInput.to.trim() : "";
      if (
        recipient !== A2A_PARENT_RECIPIENT
        && !isSafeA2AStructuralId(recipient)
      ) {
        return await fail("unknown-recipient");
      }
      if (
        rawInput.waitForReply !== undefined
        && typeof rawInput.waitForReply !== "boolean"
      ) {
        return await fail("invalid-message");
      }
      if (
        !Array.isArray(rawInput.parts)
        || rawInput.parts.length === 0
        || rawInput.parts.length > MAX_AGENT_SEND_PARTS
      ) {
        return await fail("invalid-message");
      }
      const parts: A2APart[] = [];
      for (const candidate of rawInput.parts) {
        const part = validatePart(candidate);
        if (!part.ok) return await fail(part.reason);
        parts.push(part.part);
      }

      const waitForReply = rawInput.waitForReply === true;
      if (waitForReply && recipient !== A2A_PARENT_RECIPIENT) {
        return await fail("invalid-message");
      }
      const questionPart = waitForReply && parts.length === 1 ? parts[0] : undefined;
      const rawPrompt = questionPart && "text" in questionPart
        ? questionPart.text
        : undefined;
      if (
        waitForReply
        && (
          typeof rawPrompt !== "string"
          || rawPrompt.trim().length === 0
          || rawPrompt.length > GUIDE_MAX_CHARS
        )
      ) {
        return await fail("invalid-message");
      }

      const rawCausalContext = ctx.metadata?.[A2A_CAUSAL_CONTEXT_METADATA_KEY];
      if (rawCausalContext !== undefined && !isA2AAgentCausalContext(rawCausalContext)) {
        return await fail("cross-origin");
      }
      if (ctx.abortSignal?.aborted) return await fail("aborted");

      let reservation: Extract<A2AQuestionWaitReservation, { ok: true }> | undefined;
      if (waitForReply) {
        const reserved = await runtime.reserveQuestionWait(senderChildSessionId, rawPrompt!);
        if (!reserved.ok) return await fail(reserved.reason);
        reservation = reserved;
      }
      const cancelReservation = async (): Promise<void> => {
        if (!reservation) return;
        try {
          await runtime.cancelQuestionWait(senderChildSessionId, reservation.token);
        } finally {
          reservation = undefined;
        }
      };

      let delivered: A2AAgentSendResult;
      try {
        delivered = await runtime.sendAgentMessage({
          senderChildSessionId,
          recipient,
          messageId,
          parts,
          ...(waitForReply ? { waitForReply: true as const } : {}),
          ...(rawCausalContext !== undefined
            ? { causalContext: rawCausalContext }
            : {}),
        });
      } catch {
        await cancelReservation();
        return await fail("storage-failed");
      }
      if (!delivered.ok) {
        await cancelReservation();
        return resultError(delivered.reason);
      }
      if (waitForReply && ctx.abortSignal?.aborted) {
        await cancelReservation();
        return await fail("aborted");
      }

      const output = JSON.stringify({
        messageId: delivered.messageId,
        to: recipient,
        disposition: delivered.disposition,
        waitForReply,
      });
      if (!waitForReply) return { output, isError: false };

      const canonicalPart = delivered.canonicalMessage.parts[0];
      const canonicalPrompt = canonicalPart && "text" in canonicalPart
        ? canonicalPart.text
        : undefined;
      const control: A2AQuestionInputRequiredControl = {
        kind: A2A_INPUT_REQUIRED_CONTROL_KIND,
        version: A2A_INPUT_REQUIRED_CONTROL_VERSION,
        reason: "question",
        prompt: canonicalPrompt ?? "",
      };
      if (!isA2AQuestionInputRequiredControl(control)) {
        await cancelReservation();
        return await fail("invalid-message");
      }
      return {
        output,
        isError: false,
        metadata: { rawResult: control },
      };
    },
  });
}
