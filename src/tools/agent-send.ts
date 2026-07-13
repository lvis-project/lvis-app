import { randomUUID } from "node:crypto";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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

function resultError(reason: string): ToolResult {
  return {
    output: JSON.stringify({ error: reason }),
    isError: true,
  };
}

export function createAgentSendTool(deps: AgentSendToolDeps): Tool {
  return createDynamicTool({
    name: "agent_send",
    description: "Send an A2A message to the parent or a sibling sub-agent by childSessionId. Set waitForReply only when asking the parent a question.",
    source: "builtin",
    category: "meta",
    decisionOverride: "always-allow-with-audit",
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
      const messageId = randomUUID();
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
