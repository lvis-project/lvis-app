import { maskSensitiveData } from "../shared/dlp.js";
import {
  A2A_ROLE_AGENT,
  A2A_ROLE_USER,
  type A2AJsonObject,
  type A2AJsonValue,
  type A2AMessage,
  type A2APart,
} from "../shared/a2a.js";
import {
  GUIDE_MAX_CHARS,
  GUIDE_MAX_ENTRIES,
} from "./turn/guidance-limits.js";

const MESSAGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const MESSAGE_KEYS = new Set([
  "messageId",
  "contextId",
  "taskId",
  "role",
  "parts",
  "metadata",
  "extensions",
  "referenceTaskIds",
]);
const PART_KEYS = new Set([
  "text",
  "raw",
  "url",
  "data",
  "metadata",
  "filename",
  "mediaType",
]);
const PART_CONTENT_KEYS = ["text", "raw", "url", "data"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && [...value].every((item) => typeof item === "string");
}

export function isSafeA2AMessageId(value: unknown): value is string {
  return typeof value === "string"
    && MESSAGE_ID_PATTERN.test(value)
    && maskSensitiveData(value).detections.length === 0;
}

function isSafeStructuralId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 256
    && !/[\u0000-\u001f\u007f]/.test(value)
    && maskSensitiveData(value).detections.length === 0;
}

function normalizeTitle(value: string): { title: string; detections: number } {
  const result = maskSensitiveData(value);
  const sanitized = result.masked
    .replace(/[^\p{L}\p{N} _.-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const bounded = sanitized.length > 120 ? `${sanitized.slice(0, 119)}...` : sanitized;
  return {
    title: bounded || "sub-agent",
    detections: result.detections.length,
  };
}

export function sanitizeA2ALabel(value: string): string {
  return normalizeTitle(value).title;
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
  if (value === null || typeof value === "boolean") {
    return { value, detections: 0 };
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("a2a structured data contains a non-finite number");
    }
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
  if (isRecord(value)) {
    if (seen.has(value)) throw new Error("a2a structured data contains a cycle");
    seen.add(value);
    let detections = 0;
    const next: A2AJsonObject = {};
    for (const [key, item] of Object.entries(value)) {
      const maskedKey = maskSensitiveData(key);
      const maskedValue = maskStructuredValue(item, seen, depth + 1);
      if (hasOwn(next, maskedKey.masked)) {
        throw new Error("a2a structured data contains colliding masked keys");
      }
      detections += maskedKey.detections.length + maskedValue.detections;
      Object.defineProperty(next, maskedKey.masked, {
        value: maskedValue.value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    seen.delete(value);
    return { value: next, detections };
  }
  throw new Error("a2a structured data contains an unsupported value");
}

function validatePart(part: unknown): "invalid-message" | "unsupported-part" | null {
  if (!isRecord(part) || !hasOnlyKeys(part, PART_KEYS)) return "invalid-message";
  const contentKeys = PART_CONTENT_KEYS.filter((key) => hasOwn(part, key));
  if (contentKeys.length !== 1) return "invalid-message";
  const contentKey = contentKeys[0]!;
  if (contentKey === "raw") return "unsupported-part";
  if ((contentKey === "text" || contentKey === "url")
    && typeof part[contentKey] !== "string") {
    return "invalid-message";
  }
  if (contentKey === "data" && part.data === undefined) return "invalid-message";
  if (hasOwn(part, "metadata") && !isRecord(part.metadata)) return "invalid-message";
  if (hasOwn(part, "filename") && typeof part.filename !== "string") return "invalid-message";
  if (hasOwn(part, "mediaType") && typeof part.mediaType !== "string") return "invalid-message";
  return null;
}

function validateMessageEnvelope(
  message: unknown,
  address: AgentMessageAddress,
): "invalid-message" | "unsupported-part" | null {
  if (!isRecord(message) || !hasOnlyKeys(message, MESSAGE_KEYS)) return "invalid-message";
  if (!isSafeStructuralId(address.parentSessionId)
    || !isSafeStructuralId(address.childSessionId)) {
    return "invalid-message";
  }
  if (!isSafeA2AMessageId(message.messageId)) return "invalid-message";
  if (message.role !== A2A_ROLE_AGENT) return "invalid-message";
  if (message.contextId !== address.parentSessionId) return "invalid-message";
  if (message.taskId !== address.childSessionId) return "invalid-message";
  if (!Array.isArray(message.parts) || message.parts.length === 0) return "invalid-message";
  if (hasOwn(message, "metadata") && !isRecord(message.metadata)) return "invalid-message";
  if (hasOwn(message, "extensions") && !isStringArray(message.extensions)) {
    return "invalid-message";
  }
  if (hasOwn(message, "referenceTaskIds") && !isStringArray(message.referenceTaskIds)) {
    return "invalid-message";
  }
  for (const part of message.parts) {
    const reason = validatePart(part);
    if (reason) return reason;
  }
  return null;
}

function maskPart(part: A2APart): { part: A2APart; detections: number } {
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
  if (part.raw !== undefined) throw new Error("a2a raw parts are unsupported in ph1");
  const result = maskStructuredValue(part.data, new Set());
  return {
    part: { ...common, data: result.value },
    detections: detections + result.detections,
  };
}

export interface MaskedA2AMessageResult {
  message: A2AMessage;
  detectionCount: number;
}

export function maskA2AMessage(message: A2AMessage): MaskedA2AMessageResult {
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
      messageId: message.messageId,
      contextId: message.contextId,
      taskId: message.taskId,
      role: message.role,
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

export interface AgentMessageAddress {
  parentSessionId: string;
  childSessionId: string;
  childTitle: string;
}

function formatAgentMessageWithDetections(
  address: AgentMessageAddress,
  message: A2AMessage,
): { text: string; approvalLabel: string; childTitle: string; detections: number } {
  const normalizedTitle = normalizeTitle(address.childTitle);
  const approvalLabel = `[Sub-Agent: ${normalizedTitle.title}]`;
  const body = message.parts.map(renderPart).filter(Boolean).join("\n\n");
  return {
    approvalLabel,
    childTitle: normalizedTitle.title,
    text: `${approvalLabel} (task ${address.childSessionId}, message ${message.messageId})\n${body}`,
    detections: normalizedTitle.detections,
  };
}

export function formatAgentMessage(
  address: AgentMessageAddress,
  message: A2AMessage,
): { text: string; approvalLabel: string; childTitle: string } {
  const formatted = formatAgentMessageWithDetections(address, message);
  return {
    text: formatted.text,
    approvalLabel: formatted.approvalLabel,
    childTitle: formatted.childTitle,
  };
}

export type CanonicalAgentMessageResult =
  | {
      ok: true;
      message: A2AMessage;
      detectionCount: number;
      formattedText: string;
      approvalLabel: string;
      childTitle: string;
    }
  | { ok: false; reason: "invalid-message" | "unsupported-part" };

export function canonicalizeAgentMessage(
  address: AgentMessageAddress,
  message: unknown,
): CanonicalAgentMessageResult {
  const invalidReason = validateMessageEnvelope(message, address);
  if (invalidReason) return { ok: false, reason: invalidReason };
  try {
    const masked = maskA2AMessage(message as A2AMessage);
    const formatted = formatAgentMessageWithDetections(address, masked.message);
    return {
      ok: true,
      message: masked.message,
      detectionCount: masked.detectionCount + formatted.detections,
      formattedText: formatted.text,
      approvalLabel: formatted.approvalLabel,
      childTitle: formatted.childTitle,
    };
  } catch {
    return { ok: false, reason: "invalid-message" };
  }
}

export type InboundA2ASubAgentMessageFailureReason =
  | "invalid-message"
  | "unsupported-role"
  | "unsupported-part"
  | "message-too-long";

export type CanonicalInboundA2ASubAgentMessageResult =
  | {
      ok: true;
      /** DLP-canonical value safe to persist as untrusted wire history. */
      message: A2AMessage;
      /** Parts-only runner input. Wire metadata never becomes a host control. */
      prompt: string;
      detectionCount: number;
    }
  | { ok: false; reason: InboundA2ASubAgentMessageFailureReason };

function validateInboundA2ASubAgentMessage(
  message: unknown,
): InboundA2ASubAgentMessageFailureReason | null {
  if (!isRecord(message) || !hasOnlyKeys(message, MESSAGE_KEYS)) return "invalid-message";
  if (!isSafeA2AMessageId(message.messageId)) return "invalid-message";
  if (typeof message.role !== "string") return "invalid-message";
  if (message.role !== A2A_ROLE_USER) return "unsupported-role";
  if (hasOwn(message, "contextId") && !isSafeStructuralId(message.contextId)) {
    return "invalid-message";
  }
  if (hasOwn(message, "taskId") && !isSafeStructuralId(message.taskId)) {
    return "invalid-message";
  }
  if (
    !Array.isArray(message.parts)
    || message.parts.length === 0
    || message.parts.length > GUIDE_MAX_ENTRIES
  ) {
    return "invalid-message";
  }
  if (hasOwn(message, "metadata") && !isRecord(message.metadata)) {
    return "invalid-message";
  }
  if (
    hasOwn(message, "extensions")
    && (!isStringArray(message.extensions) || message.extensions.length > GUIDE_MAX_ENTRIES)
  ) {
    return "invalid-message";
  }
  if (
    hasOwn(message, "referenceTaskIds")
    && (!isStringArray(message.referenceTaskIds)
      || message.referenceTaskIds.length > GUIDE_MAX_ENTRIES)
  ) {
    return "invalid-message";
  }
  for (const part of message.parts) {
    const reason = validatePart(part);
    if (reason) return reason;
  }
  return null;
}

/**
 * Decode one loopback A2A user Message into the only values the runner needs.
 *
 * Caller-supplied metadata remains inert protocol history: it is recursively
 * DLP-masked but is never rendered into the prompt or projected into origin,
 * title, cwd, project, tool-scope, or ApprovalGate options. Those controls are
 * host-owned at the runner boundary.
 */
export function canonicalizeInboundA2ASubAgentMessage(
  message: unknown,
): CanonicalInboundA2ASubAgentMessageResult {
  try {
    const invalidReason = validateInboundA2ASubAgentMessage(message);
    if (invalidReason) return { ok: false, reason: invalidReason };

    const masked = maskA2AMessage(message as A2AMessage);
    const prompt = masked.message.parts
      .map(renderPart)
      .filter((part) => part.trim().length > 0)
      .join("\n\n")
      .trim();
    if (prompt.length === 0) return { ok: false, reason: "invalid-message" };

    const serializedMessage = JSON.stringify(masked.message);
    if (
      prompt.length > GUIDE_MAX_CHARS
      || serializedMessage.length > GUIDE_MAX_CHARS
    ) {
      return { ok: false, reason: "message-too-long" };
    }

    return {
      ok: true,
      message: masked.message,
      prompt,
      detectionCount: masked.detectionCount,
    };
  } catch {
    return { ok: false, reason: "invalid-message" };
  }
}
