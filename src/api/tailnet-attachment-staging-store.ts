/**
 * Ephemeral image staging for a paired Tailnet controller.
 *
 * A remote binary upload is never put in a command receipt, projection, audit
 * record, URL, or filesystem path. It remains in bounded process memory only
 * until exactly one accepted message.send claims it. Restarting the host drops
 * all staged bytes by design.
 */
import { randomUUID as nodeRandomUUID } from "node:crypto";
import type { UserContentPart } from "../engine/llm/types.js";
import {
  MAX_SUBSCRIPTION_ATTACHMENT_BYTES,
  MAX_SUBSCRIPTION_PROMPT_ATTACHMENTS,
  normalizeSubscriptionImageBytes,
  subscriptionAttachmentByteLength,
  type SubscriptionPromptAttachment,
} from "../main/subscription-attachment-input.js";

const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_TOTAL_BYTES = MAX_SUBSCRIPTION_ATTACHMENT_BYTES * 2;
const OWNER_KEY = /^[a-f0-9]{64}$/;
const STAGED_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface StagedAttachment {
  readonly id: string;
  readonly ownerKey: string;
  readonly isCurrent: () => boolean;
  readonly attachment: SubscriptionPromptAttachment;
  readonly bytes: number;
  readonly expiresAt: number;
  reservationId: string | null;
}

export interface TailnetAttachmentStageInput {
  /** SHA-256 of the exact paired actor/share binding; never a raw identity. */
  readonly ownerKey: string;
  /** Rechecked on durable pairing/share changes and immediately before claim. */
  readonly isCurrent: () => boolean;
  readonly mimeType: string;
  readonly bytes: Buffer;
}

export interface TailnetAttachmentStageResult {
  readonly id: string;
  readonly expiresAt: number;
}

export interface TailnetAttachmentClaim {
  /** Host-private reservation token; never serialized to a remote surface. */
  readonly reservationId: string;
  readonly attachmentIds: readonly string[];
  readonly attachments: readonly UserContentPart[];
}

export interface CreateTailnetAttachmentStagingStoreOptions {
  readonly now?: () => number;
  readonly randomUuid?: () => string;
  readonly ttlMs?: number;
  readonly maxTotalBytes?: number;
}

export interface TailnetAttachmentStagingStore {
  stage(input: TailnetAttachmentStageInput): TailnetAttachmentStageResult | null;
  reserve(ownerKey: string, attachmentIds: readonly string[]): TailnetAttachmentClaim | null;
  commit(claim: TailnetAttachmentClaim): void;
  release(claim: TailnetAttachmentClaim): void;
  /** Drop expired or revoked-binding entries without disclosing their existence. */
  discardStale(): void;
  clear(): void;
}

/** Build the in-memory, single-use remote image staging boundary. */
export function createTailnetAttachmentStagingStore(
  options: CreateTailnetAttachmentStagingStoreOptions = {},
): TailnetAttachmentStagingStore {
  const now = options.now ?? Date.now;
  const randomUuid = options.randomUuid ?? nodeRandomUUID;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  if (
    !Number.isSafeInteger(ttlMs)
    || ttlMs <= 0
    || !Number.isSafeInteger(maxTotalBytes)
    || maxTotalBytes < MAX_SUBSCRIPTION_ATTACHMENT_BYTES
  ) {
    throw new Error("tailnet-attachment-staging-config-invalid");
  }

  const entries = new Map<string, StagedAttachment>();

  const checkedNow = (): number => {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("tailnet-attachment-staging-clock-invalid");
    }
    return value;
  };

  const current = (entry: StagedAttachment): boolean => {
    try {
      return entry.isCurrent() === true;
    } catch {
      return false;
    }
  };

  const discardStale = (): void => {
    const timestamp = checkedNow();
    for (const [id, entry] of entries) {
      if (entry.expiresAt <= timestamp || !current(entry)) entries.delete(id);
    }
  };

  const totalBytes = (): number => {
    let total = 0;
    for (const entry of entries.values()) total += entry.bytes;
    return total;
  };

  const ownerEntries = (ownerKey: string): StagedAttachment[] =>
    [...entries.values()].filter((entry) => entry.ownerKey === ownerKey);

  return Object.freeze({
    stage(input: TailnetAttachmentStageInput): TailnetAttachmentStageResult | null {
      discardStale();
      if (!validOwnerKey(input.ownerKey) || typeof input.isCurrent !== "function") return null;
      let allowed = false;
      try {
        allowed = input.isCurrent() === true;
      } catch {
        allowed = false;
      }
      if (!allowed || !Buffer.isBuffer(input.bytes)) return null;
      const attachment = normalizeSubscriptionImageBytes(input.mimeType, input.bytes);
      if (attachment === null) return null;
      const bytes = subscriptionAttachmentByteLength(attachment);
      const owned = ownerEntries(input.ownerKey);
      if (
        owned.length >= MAX_SUBSCRIPTION_PROMPT_ATTACHMENTS
        || bytes > MAX_SUBSCRIPTION_ATTACHMENT_BYTES
        || owned.reduce((total, entry) => total + entry.bytes, 0) + bytes > MAX_SUBSCRIPTION_ATTACHMENT_BYTES
        || totalBytes() + bytes > maxTotalBytes
      ) {
        return null;
      }
      // A pairing/share revocation may land while bytes were normalized.
      try {
        if (input.isCurrent() !== true) return null;
      } catch {
        return null;
      }
      const id = randomUuid();
      if (!STAGED_ID.test(id) || entries.has(id)) {
        throw new Error("tailnet-attachment-staging-id-invalid");
      }
      const timestamp = checkedNow();
      if (timestamp > Number.MAX_SAFE_INTEGER - ttlMs) {
        throw new Error("tailnet-attachment-staging-clock-invalid");
      }
      entries.set(id, {
        id,
        ownerKey: input.ownerKey,
        isCurrent: input.isCurrent,
        attachment,
        bytes,
        expiresAt: timestamp + ttlMs,
        reservationId: null,
      });
      return Object.freeze({ id, expiresAt: timestamp + ttlMs });
    },

    reserve(ownerKey: string, attachmentIds: readonly string[]): TailnetAttachmentClaim | null {
      discardStale();
      if (!validOwnerKey(ownerKey) || !validAttachmentIds(attachmentIds)) return null;
      const selected: StagedAttachment[] = [];
      for (const id of attachmentIds) {
        const entry = entries.get(id);
        if (
          entry === undefined
          || entry.ownerKey !== ownerKey
          || entry.reservationId !== null
          || !current(entry)
        ) {
          return null;
        }
        selected.push(entry);
      }
      const reservationId = randomUuid();
      if (!STAGED_ID.test(reservationId)) {
        throw new Error("tailnet-attachment-staging-id-invalid");
      }
      for (const entry of selected) entry.reservationId = reservationId;
      const attachments = selected.map((entry) => toUserContentPart(entry.attachment));
      return Object.freeze({
        reservationId,
        attachmentIds: Object.freeze([...attachmentIds]),
        attachments: Object.freeze(attachments),
      });
    },

    commit(claim: TailnetAttachmentClaim): void {
      if (!validClaim(claim)) return;
      for (const id of claim.attachmentIds) {
        const entry = entries.get(id);
        if (entry?.reservationId === claim.reservationId) entries.delete(id);
      }
    },

    release(claim: TailnetAttachmentClaim): void {
      if (!validClaim(claim)) return;
      for (const id of claim.attachmentIds) {
        const entry = entries.get(id);
        if (entry?.reservationId === claim.reservationId) entry.reservationId = null;
      }
    },

    discardStale,
    clear(): void {
      entries.clear();
    },
  });
}

function toUserContentPart(attachment: SubscriptionPromptAttachment): UserContentPart {
  return Object.freeze({
    type: "image",
    image: `data:${attachment.mimeType};base64,${attachment.data}`,
    mimeType: attachment.mimeType,
  });
}

function validOwnerKey(value: unknown): value is string {
  return typeof value === "string" && OWNER_KEY.test(value);
}

function validAttachmentIds(value: readonly string[]): boolean {
  return Array.isArray(value)
    && value.length > 0
    && value.length <= MAX_SUBSCRIPTION_PROMPT_ATTACHMENTS
    && value.every((id) => STAGED_ID.test(id))
    && new Set(value).size === value.length;
}

function validClaim(value: TailnetAttachmentClaim): boolean {
  return STAGED_ID.test(value.reservationId) && validAttachmentIds(value.attachmentIds);
}
