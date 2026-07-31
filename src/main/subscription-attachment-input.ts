/**
 * Main-process-only normalized attachment payloads for subscription transports.
 *
 * The renderer and normal conversation model use main-issued image data URLs.
 * This is a distinct boundary from attach.ts's local-file inspection/mime
 * mapping: it accepts no filesystem path and strictly normalizes only the
 * already-created data URL. Subscription transports then share this one
 * protocol-neutral base64 representation so Codex can stage local images and
 * ACP can emit its standard image blocks without binary in the text envelope.
 */
import {
  MAX_COMPOSER_ATTACHMENT_COUNT,
  MAX_COMPOSER_IMAGE_BASE64_CHARS,
  MAX_COMPOSER_IMAGE_BYTES,
  composerImageFormatForMimeType,
  sniffComposerImageFormat,
} from "../shared/composer-image-input.js";
import { MCP_RESOURCE_ATTACHMENTS_PER_TURN } from "../shared/mcp-resource-bounds.js";
import type { SubscriptionImageAttachmentLimits } from "../shared/subscription-runtime.js";
import type { UserContentPart } from "../engine/llm/types.js";

/**
 * Original image bytes accepted by a subscription runtime's verified native
 * transport. Generic file payloads deliberately do not belong here: normal
 * LVIS file attachments are paths plus the governed read-tool flow, not an
 * unreviewed binary-upload parity promise.
 */
export type SubscriptionPromptAttachment = Readonly<{
  type: "image";
  mimeType: string;
  /** Canonical base64 bytes, without a `data:` URL prefix. */
  data: string;
}>;

/** Aliases of the composer source of truth, retained for transport callers. */
export const MAX_SUBSCRIPTION_PROMPT_ATTACHMENTS = MAX_COMPOSER_ATTACHMENT_COUNT;
/**
 * One composed turn has its text part plus independently bounded image and
 * resource attachment parts. Reject larger (including sparse) arrays before
 * iterating any element at IPC, import, restore, or provider boundaries.
 */
export const MAX_LOCAL_USER_CONTENT_PARTS =
  1 + MAX_COMPOSER_ATTACHMENT_COUNT + MCP_RESOURCE_ATTACHMENTS_PER_TURN;
export const MAX_SUBSCRIPTION_ATTACHMENT_BYTES = MAX_COMPOSER_IMAGE_BYTES;
/** Default Codex/native transport budget, derived from composer input limits. */
export const DEFAULT_SUBSCRIPTION_IMAGE_ATTACHMENT_LIMITS: SubscriptionImageAttachmentLimits = Object.freeze({
  maxCount: MAX_SUBSCRIPTION_PROMPT_ATTACHMENTS,
  maxBytesPerImage: MAX_SUBSCRIPTION_ATTACHMENT_BYTES,
  maxTotalBytes: MAX_SUBSCRIPTION_ATTACHMENT_BYTES,
});

const MAX_MIME_TYPE_LENGTH = 160;
const MIME_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,95}$/i;
const MAX_INLINE_LOCAL_DATA_URL_CHARS =
  "data:".length + MAX_MIME_TYPE_LENGTH + ";base64,".length + MAX_COMPOSER_IMAGE_BASE64_CHARS;

type DecodedBase64 = Readonly<{
  data: string;
  bytes: Buffer;
}>;

export type SubscriptionAttachmentTransportErrorCode =
  | "subscription-attachment-not-supported"
  | "subscription-attachment-too-large";

/** Stable transport-boundary failure; it never carries third-party detail. */
export class SubscriptionAttachmentTransportError extends Error {
  constructor(readonly code: SubscriptionAttachmentTransportErrorCode) {
    super(code);
    this.name = "SubscriptionAttachmentTransportError";
  }
}

function normalizedMimeType(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // MIME tokens are ASCII. Locale-sensitive lowercasing can change I/i under
  // a Turkish default locale and make a valid protocol token fail spuriously.
  const mimeType = value.trim().toLowerCase();
  return mimeType.length > 0
    && mimeType.length <= MAX_MIME_TYPE_LENGTH
    && MIME_TYPE_PATTERN.test(mimeType)
    ? mimeType
    : null;
}

function isBase64Character(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a)
    || (code >= 0x61 && code <= 0x7a)
    || (code >= 0x30 && code <= 0x39)
    || code === 0x2b
    || code === 0x2f;
}

function canonicalBase64(value: unknown): DecodedBase64 | null {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_COMPOSER_IMAGE_BASE64_CHARS
    || value.length % 4 !== 0
  ) {
    return null;
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const dataLength = value.length - padding;
  if (dataLength === 0) return null;
  // Avoid a backtracking regex over up to 25MiB of image data. Validate the
  // canonical ASCII alphabet in one bounded linear scan before decoding.
  for (let index = 0; index < dataLength; index += 1) {
    if (!isBase64Character(value.charCodeAt(index))) return null;
  }
  for (let index = dataLength; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 0x3d) return null;
  }
  const estimatedBytes = (value.length / 4) * 3 - padding;
  if (estimatedBytes <= 0 || estimatedBytes > MAX_SUBSCRIPTION_ATTACHMENT_BYTES) return null;
  try {
    const bytes = Buffer.from(value, "base64");
    return bytes.length === estimatedBytes && bytes.toString("base64") === value
      ? Object.freeze({ data: value, bytes })
      : null;
  } catch {
    return null;
  }
}

function dataUrlParts(value: unknown): { mimeType: string; data: DecodedBase64 } | null {
  if (typeof value !== "string" || value.length > MAX_INLINE_LOCAL_DATA_URL_CHARS) return null;
  if (!value.startsWith("data:")) return null;
  const separator = value.indexOf(";base64,", 5);
  if (separator <= 5) return null;
  const mimeType = normalizedMimeType(value.slice(5, separator));
  const data = canonicalBase64(value.slice(separator + ";base64,".length));
  return mimeType && data ? { mimeType, data } : null;
}
function ownField(value: object, key: string): unknown {
  try {
    return Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined;
  } catch {
    return undefined;
  }
}

type NormalizedInlineDataUrl = Readonly<{
  mimeType: string;
  data: DecodedBase64;
}>;

function normalizedInlineDataUrl(
  dataUrl: unknown,
  declaredMimeType?: unknown,
): NormalizedInlineDataUrl | null {
  const parsed = dataUrlParts(dataUrl);
  if (!parsed) return null;
  const declared = declaredMimeType === undefined
    ? parsed.mimeType
    : normalizedMimeType(declaredMimeType);
  return declared && declared === parsed.mimeType
    ? Object.freeze({ mimeType: parsed.mimeType, data: parsed.data })
    : null;
}

/**
 * Normalize an inline local data URL before it reaches an API-key provider.
 *
 * This deliberately accepts only the existing bounded canonical base64 format
 * and a syntactically valid, explicitly matching media type. It is shared by
 * image and generic file IPC so a string can never be reinterpreted as a URL
 * by the AI SDK's provider mapper.
 */
export function normalizeInlineLocalDataUrl(
  dataUrl: unknown,
  declaredMimeType?: unknown,
): Readonly<{ mimeType: string; data: string }> | null {
  const normalized = normalizedInlineDataUrl(dataUrl, declaredMimeType);
  return normalized
    ? Object.freeze({ mimeType: normalized.mimeType, data: normalized.data.data })
    : null;
}

function normalizedImageAttachment(
  mimeType: string,
  decoded: DecodedBase64,
): SubscriptionPromptAttachment | null {
  const expectedFormat = composerImageFormatForMimeType(mimeType);
  const actualFormat = sniffComposerImageFormat(decoded.bytes);
  if (!expectedFormat || !actualFormat || actualFormat.mimeType !== expectedFormat.mimeType) return null;
  return Object.freeze({ type: "image", mimeType: expectedFormat.mimeType, data: decoded.data });
}

function normalizedPromptAttachment(value: unknown): SubscriptionPromptAttachment | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as { type?: unknown; mimeType?: unknown; data?: unknown };
  if (candidate.type !== "image") return null;
  const mimeType = normalizedMimeType(candidate.mimeType);
  const data = canonicalBase64(candidate.data);
  return mimeType && data ? normalizedImageAttachment(mimeType, data) : null;
}

/** Convert a normal LVIS image data URL into a strict protocol payload. */
export function normalizeSubscriptionImageAttachment(
  dataUrl: unknown,
  declaredMimeType?: unknown,
): SubscriptionPromptAttachment | null {
  const normalized = normalizedInlineDataUrl(dataUrl, declaredMimeType);
  return normalized
    ? normalizedImageAttachment(normalized.mimeType, normalized.data)
    : null;
}

/**
 * Normalize renderer/imported user content before it reaches an API-key
 * provider. Binary parts must be canonical inline local data URLs: URL-shaped
 * strings are rejected instead of being delegated to the AI SDK fetch path.
 * Total-part and binary-candidate caps run before element data is read or decoded.
 */
export function normalizeLocalUserContentParts(raw: unknown): UserContentPart[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  let rawLength = 0;
  try {
    rawLength = raw.length;
  } catch {
    return undefined;
  }
  if (!Number.isSafeInteger(rawLength) || rawLength > MAX_LOCAL_USER_CONTENT_PARTS) return undefined;
  const out: UserContentPart[] = [];
  let inspectedBinaryCandidateCount = 0;

  for (let index = 0; index < rawLength; index += 1) {
    let item: unknown;
    try {
      if (!Object.hasOwn(raw, index)) continue;
      item = raw[index];
    } catch {
      continue;
    }
    if (typeof item !== "object" || item === null) continue;
    const type = ownField(item, "type");
    if (type === "image" || type === "file") {
      if (inspectedBinaryCandidateCount >= MAX_COMPOSER_ATTACHMENT_COUNT) continue;
      inspectedBinaryCandidateCount += 1;
    }

    if (type === "text") {
      const text = ownField(item, "text");
      if (typeof text === "string") out.push({ type: "text", text });
      continue;
    }

    if (type === "image") {
      const image = ownField(item, "image");
      const mimeType = ownField(item, "mimeType");
      if (typeof image !== "string") continue;
      const normalized = normalizeSubscriptionImageAttachment(
        image,
        typeof mimeType === "string" ? mimeType : undefined,
      );
      if (!normalized) continue;
      out.push({
        type: "image",
        image: `data:${normalized.mimeType};base64,${normalized.data}`,
        mimeType: normalized.mimeType,
      });
      continue;
    }

    if (type === "file") {
      const data = ownField(item, "data");
      const mimeType = ownField(item, "mimeType");
      if (typeof data !== "string" || typeof mimeType !== "string") continue;
      const normalized = normalizeInlineLocalDataUrl(data, mimeType);
      if (!normalized) continue;
      out.push({
        type: "file",
        data: `data:${normalized.mimeType};base64,${normalized.data}`,
        mimeType: normalized.mimeType,
      });
    }
  }

  return out.length > 0 ? out : undefined;
}

/** Validate an internal attachment again at every process transport boundary. */
export function isSubscriptionPromptAttachment(value: unknown): value is SubscriptionPromptAttachment {
  return normalizedPromptAttachment(value) !== null;
}

export function subscriptionAttachmentByteLength(attachment: SubscriptionPromptAttachment): number {
  return Buffer.byteLength(attachment.data, "base64");
}

/**
 * Revalidate every value at the process boundary. Images may be large enough
 * to be useful, but a prompt remains bounded before staging or JSONL encoding.
 */
export function assertSubscriptionPromptAttachments(
  attachments: readonly SubscriptionPromptAttachment[] | undefined,
  limits: SubscriptionImageAttachmentLimits = DEFAULT_SUBSCRIPTION_IMAGE_ATTACHMENT_LIMITS,
): readonly SubscriptionPromptAttachment[] {
  if (attachments === undefined || attachments.length === 0) return Object.freeze([]);
  if (!Array.isArray(attachments) || attachments.length > limits.maxCount) {
    throw new SubscriptionAttachmentTransportError("subscription-attachment-too-large");
  }
  let totalBytes = 0;
  const validated: SubscriptionPromptAttachment[] = [];
  for (const attachment of attachments) {
    const normalized = normalizedPromptAttachment(attachment);
    if (!normalized) {
      throw new SubscriptionAttachmentTransportError("subscription-attachment-not-supported");
    }
    const attachmentBytes = subscriptionAttachmentByteLength(normalized);
    if (attachmentBytes > limits.maxBytesPerImage) {
      throw new SubscriptionAttachmentTransportError("subscription-attachment-too-large");
    }
    totalBytes += attachmentBytes;
    if (totalBytes > limits.maxTotalBytes) {
      throw new SubscriptionAttachmentTransportError("subscription-attachment-too-large");
    }
    // Return independent frozen values so later caller mutation cannot change
    // what this transport boundary validated.
    validated.push(normalized);
  }
  return Object.freeze(validated);
}

export function subscriptionImageExtension(mimeType: string): string | null {
  const normalized = normalizedMimeType(mimeType);
  return normalized ? composerImageFormatForMimeType(normalized)?.extension ?? null : null;
}
