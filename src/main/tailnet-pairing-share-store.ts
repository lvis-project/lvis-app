/**
 * Durable pairing and conversation-share state for Tailnet surfaces.
 *
 * Pairing is identification only. A paired Tailnet account gets no transcript
 * or control authority until the desktop owner creates a separate, bounded
 * share for one exact current conversation. The persisted state contains no
 * raw Tailnet login, invite code, or conversation id.
 */
import { createHash, randomBytes as nodeRandomBytes, randomUUID as nodeRandomUuid } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { TailnetPairingShareBinding } from "../shared/chat-origin.js";
import { timingSafeEqualHexDigest } from "../lib/hex-digest-equal.js";
import {
  openFeatureNamespace,
  type FeatureNamespaceHandle,
} from "./storage/feature-namespace.js";

import { isRecord } from "../shared/is-record.js";
const STORE_VERSION = 1;
const DEFAULT_FILE_NAME = "pairing-share.json";
const DEFAULT_INVITE_TTL_MS = 10 * 60 * 1_000;
const DEFAULT_PENDING_TTL_MS = 10 * 60 * 1_000;
const DEFAULT_SHARE_TTL_MS = 8 * 60 * 60 * 1_000;
const MAX_INVITE_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_SHARE_TTL_MS = 24 * 60 * 60 * 1_000;
const TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_INVITATIONS = 64;
const MAX_PAIRINGS = 128;
const MAX_SHARES = 256;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTOR_ID = /^tailnet:[a-f0-9]{64}$/;

const TAILNET_SHARING_FEATURE = "tailnet-sharing";
export type TailnetSharePermission = "observe" | "control";
export type TailnetShareActorId = `tailnet:${string}`;

export interface TailnetPairingInvitation {
  readonly id: string;
  /** Raw high-entropy secret returned exactly once; it is never persisted. */
  readonly code: string;
  readonly expiresAt: number;
}

export interface TailnetPairingClaim {
  readonly pairingId: string;
  readonly expiresAt: number;
}

export interface TailnetPairingShareAuthority {
  readonly actorId: TailnetShareActorId;
  readonly pairing: TailnetPairingShareBinding;
  readonly permission: TailnetSharePermission;
}

export interface TailnetOwnerPairingSummary {
  readonly id: string;
  /** Opaque account fingerprint, not a raw Serve login. */
  readonly actorFingerprint: string;
  readonly state: "pending" | "active";
  readonly expiresAt: number | null;
}

export interface TailnetOwnerShareSummary {
  readonly id: string;
  readonly pairingId: string;
  readonly actorFingerprint: string;
  readonly permission: TailnetSharePermission;
  readonly expiresAt: number;
}

export interface TailnetOwnerSharingSnapshot {
  readonly invitations: readonly { readonly id: string; readonly expiresAt: number }[];
  readonly pairings: readonly TailnetOwnerPairingSummary[];
  readonly shares: readonly TailnetOwnerShareSummary[];
}

export interface CreateTailnetPairingShareStoreOptions {
  readonly namespace?: FeatureNamespaceHandle;
  readonly fileName?: string;
  readonly now?: () => number;
  readonly randomUuid?: () => string;
  readonly randomBytes?: (size: number) => Buffer;
  readonly defaultInvitationTtlMs?: number;
  readonly defaultShareTtlMs?: number;
}

interface StoredInvitation {
  readonly id: string;
  readonly codeDigest: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly state: "open" | "claimed";
  readonly pairingId: string | null;
}

interface StoredPairing {
  readonly id: string;
  readonly actorId: TailnetShareActorId;
  readonly invitationId: string;
  readonly createdAt: number;
  readonly state: "pending" | "active" | "revoked" | "expired";
  readonly epoch: number;
  readonly expiresAt: number | null;
  readonly activatedAt: number | null;
  readonly terminalAt: number | null;
}

interface StoredShare {
  readonly id: string;
  readonly pairingId: string;
  readonly actorId: TailnetShareActorId;
  readonly pairingEpoch: number;
  readonly conversationDigest: string;
  readonly scope: string;
  readonly permission: TailnetSharePermission;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly state: "active" | "revoked" | "expired";
  readonly epoch: number;
  readonly terminalAt: number | null;
}

interface StoreState {
  readonly version: typeof STORE_VERSION;
  readonly invitations: readonly StoredInvitation[];
  readonly pairings: readonly StoredPairing[];
  readonly shares: readonly StoredShare[];
}

type ChangeListener = () => void;

function initialState(): StoreState {
  return { version: STORE_VERSION, invitations: [], pairings: [], shares: [] };
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function timestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function epoch(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function uuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function actorId(value: unknown): value is TailnetShareActorId {
  return typeof value === "string" && ACTOR_ID.test(value);
}

function digest(value: unknown): value is string {
  return typeof value === "string" && SHA256_HEX.test(value);
}

function validInvitation(value: unknown): value is StoredInvitation {
  return isRecord(value)
    && exactKeys(value, ["id", "codeDigest", "createdAt", "expiresAt", "state", "pairingId"])
    && uuid(value.id)
    && digest(value.codeDigest)
    && timestamp(value.createdAt)
    && timestamp(value.expiresAt)
    && value.expiresAt > value.createdAt
    && (value.state === "open" || value.state === "claimed")
    && ((value.state === "open" && value.pairingId === null)
      || (value.state === "claimed" && uuid(value.pairingId)));
}

function validPairing(value: unknown): value is StoredPairing {
  if (
    !isRecord(value)
    || !exactKeys(value, [
      "id", "actorId", "invitationId", "createdAt", "state", "epoch",
      "expiresAt", "activatedAt", "terminalAt",
    ])
    || !uuid(value.id)
    || !actorId(value.actorId)
    || !uuid(value.invitationId)
    || !timestamp(value.createdAt)
    || !epoch(value.epoch)
    || !["pending", "active", "revoked", "expired"].includes(String(value.state))
    || !(value.expiresAt === null || timestamp(value.expiresAt))
    || !(value.activatedAt === null || timestamp(value.activatedAt))
    || !(value.terminalAt === null || timestamp(value.terminalAt))
  ) {
    return false;
  }
  if (value.state === "pending") {
    return timestamp(value.expiresAt)
      && value.expiresAt > value.createdAt
      && value.activatedAt === null
      && value.terminalAt === null;
  }
  if (value.state === "active") {
    return value.expiresAt === null
      && timestamp(value.activatedAt)
      && value.activatedAt >= value.createdAt
      && value.terminalAt === null;
  }
  return value.expiresAt === null
    && value.activatedAt === null
    && timestamp(value.terminalAt)
    && value.terminalAt >= value.createdAt;
}

function validShare(value: unknown): value is StoredShare {
  if (
    !isRecord(value)
    || !exactKeys(value, [
      "id", "pairingId", "actorId", "pairingEpoch", "conversationDigest",
      "scope", "permission", "createdAt", "expiresAt", "state", "epoch", "terminalAt",
    ])
    || !uuid(value.id)
    || !uuid(value.pairingId)
    || !actorId(value.actorId)
    || !epoch(value.pairingEpoch)
    || !digest(value.conversationDigest)
    || !uuid(value.scope)
    || (value.permission !== "observe" && value.permission !== "control")
    || !timestamp(value.createdAt)
    || !timestamp(value.expiresAt)
    || value.expiresAt <= value.createdAt
    || !["active", "revoked", "expired"].includes(String(value.state))
    || !epoch(value.epoch)
    || !(value.terminalAt === null || timestamp(value.terminalAt))
  ) {
    return false;
  }
  return value.state === "active"
    ? value.terminalAt === null
    : timestamp(value.terminalAt) && value.terminalAt >= value.createdAt;
}

function validState(value: unknown): value is StoreState {
  if (
    !isRecord(value)
    || !exactKeys(value, ["version", "invitations", "pairings", "shares"])
    || value.version !== STORE_VERSION
    || !Array.isArray(value.invitations)
    || !Array.isArray(value.pairings)
    || !Array.isArray(value.shares)
    || value.invitations.length > MAX_INVITATIONS
    || value.pairings.length > MAX_PAIRINGS
    || value.shares.length > MAX_SHARES
    || !value.invitations.every(validInvitation)
    || !value.pairings.every(validPairing)
    || !value.shares.every(validShare)
  ) {
    return false;
  }
  const invitationIds = new Set<string>();
  const pairings = new Map<string, StoredPairing>();
  const shareIds = new Set<string>();
  for (const invitation of value.invitations) {
    if (invitationIds.has(invitation.id)) return false;
    invitationIds.add(invitation.id);
  }
  for (const pairing of value.pairings) {
    if (pairings.has(pairing.id) || !invitationIds.has(pairing.invitationId)) return false;
    pairings.set(pairing.id, pairing);
  }
  for (const share of value.shares) {
    const pairing = pairings.get(share.pairingId);
    if (shareIds.has(share.id) || !pairing) return false;
    if (
      share.state === "active"
      && (
        pairing.state !== "active"
        || pairing.actorId !== share.actorId
        || pairing.epoch !== share.pairingEpoch
      )
    ) {
      return false;
    }
    shareIds.add(share.id);
  }
  return true;
}

function fail(): Error {
  return new Error("tailnet-pairing-share-store-invalid");
}

function capacity(): Error {
  return new Error("tailnet-pairing-share-store-capacity-reached");
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function inviteDigest(code: string): string {
  return hash("tailnet-pairing-invite-v1\0" + code);
}

function conversationDigest(value: string): string {
  return hash("tailnet-share-conversation-v1\0" + value);
}

function permits(granted: TailnetSharePermission, required: TailnetSharePermission): boolean {
  return granted === "control" || required === "observe";
}

function validDuration(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function addDuration(now: number, duration: number): number {
  if (now > Number.MAX_SAFE_INTEGER - duration) throw fail();
  return now + duration;
}

function nextEpoch(value: number): number {
  if (!epoch(value) || value === Number.MAX_SAFE_INTEGER) throw fail();
  return value + 1;
}

function conversationId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 512
    && value.trim().length > 0
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function invitationCode(value: unknown): value is string {
  return typeof value === "string" && /^lvis-pair-v1\.[A-Za-z0-9_-]{43}$/.test(value);
}

function binding(pairing: StoredPairing, share: StoredShare): TailnetPairingShareBinding {
  return Object.freeze({
    pairingId: pairing.id,
    pairingEpoch: pairing.epoch,
    shareId: share.id,
    shareEpoch: share.epoch,
    scope: share.scope,
  });
}

function validBinding(value: unknown): value is TailnetPairingShareBinding {
  return isRecord(value)
    && exactKeys(value, ["pairingId", "pairingEpoch", "shareId", "shareEpoch", "scope"])
    && uuid(value.pairingId)
    && epoch(value.pairingEpoch)
    && uuid(value.shareId)
    && epoch(value.shareEpoch)
    && uuid(value.scope);
}

function sameBinding(left: TailnetPairingShareBinding, right: TailnetPairingShareBinding): boolean {
  return left.pairingId === right.pairingId
    && left.pairingEpoch === right.pairingEpoch
    && left.shareId === right.shareId
    && left.shareEpoch === right.shareEpoch
    && left.scope === right.scope;
}

function fingerprint(value: TailnetShareActorId): string {
  return value.slice("tailnet:".length, "tailnet:".length + 12);
}

function terminalSince(value: { readonly state: string; readonly terminalAt: number | null }, now: number): boolean {
  return value.state !== "active" && value.state !== "pending"
    && value.terminalAt !== null
    && now - value.terminalAt > TERMINAL_RETENTION_MS;
}

function prune(state: StoreState, now: number): { readonly state: StoreState; readonly changed: boolean } {
  let changed = false;
  const pairings = state.pairings.map((entry): StoredPairing => {
    if (entry.state !== "pending" || entry.expiresAt === null || entry.expiresAt > now) return entry;
    changed = true;
    return {
      ...entry,
      state: "expired",
      epoch: nextEpoch(entry.epoch),
      expiresAt: null,
      terminalAt: now,
    };
  });
  const pairsById = new Map(pairings.map((entry) => [entry.id, entry] as const));
  const shares = state.shares.map((entry): StoredShare => {
    const pairing = pairsById.get(entry.pairingId);
    if (
      entry.state !== "active"
      || (entry.expiresAt > now
        && pairing?.state === "active"
        && pairing.epoch === entry.pairingEpoch)
    ) {
      return entry;
    }
    changed = true;
    return {
      ...entry,
      state: "expired",
      epoch: nextEpoch(entry.epoch),
      terminalAt: now,
    };
  });
  const retainedShares = shares.filter((entry) => {
    const keep = !terminalSince(entry, now);
    changed ||= !keep;
    return keep;
  });
  const sharePairingIds = new Set(retainedShares.map((entry) => entry.pairingId));
  const retainedPairings = pairings.filter((entry) => {
    const keep = !terminalSince(entry, now) || sharePairingIds.has(entry.id);
    changed ||= !keep;
    return keep;
  });
  const pairingInvitationIds = new Set(retainedPairings.map((entry) => entry.invitationId));
  const invitations = state.invitations.filter((entry) => {
    const keep = entry.state === "open"
      ? entry.expiresAt > now
      : pairingInvitationIds.has(entry.id);
    changed ||= !keep;
    return keep;
  });
  return {
    state: {
      version: STORE_VERSION,
      invitations,
      pairings: retainedPairings,
      shares: retainedShares,
    },
    changed,
  };
}

class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }
}

/**
 * Call open() before use. Corrupt state fails closed rather than becoming an
 * empty permission database.
 */
export class TailnetPairingShareStore {
  private readonly namespace: FeatureNamespaceHandle;
  private readonly fileName: string;
  private readonly now: () => number;
  private readonly randomUuid: () => string;
  private readonly randomBytes: (size: number) => Buffer;
  private readonly invitationTtlMs: number;
  private readonly shareTtlMs: number;
  private readonly mutex = new AsyncMutex();
  private readonly listeners = new Set<ChangeListener>();
  private state: StoreState | undefined;

  constructor(options: CreateTailnetPairingShareStoreOptions = {}) {
    this.namespace = options.namespace ?? openFeatureNamespace(TAILNET_SHARING_FEATURE);
    this.fileName = options.fileName ?? DEFAULT_FILE_NAME;
    this.now = options.now ?? Date.now;
    this.randomUuid = options.randomUuid ?? nodeRandomUuid;
    this.randomBytes = options.randomBytes ?? nodeRandomBytes;
    this.invitationTtlMs = options.defaultInvitationTtlMs ?? DEFAULT_INVITE_TTL_MS;
    this.shareTtlMs = options.defaultShareTtlMs ?? DEFAULT_SHARE_TTL_MS;
    if (
      !/^[a-z0-9][a-z0-9._-]{0,127}\.json$/i.test(this.fileName)
      || !validDuration(this.invitationTtlMs, MAX_INVITE_TTL_MS)
      || !validDuration(this.shareTtlMs, MAX_SHARE_TTL_MS)
    ) {
      throw fail();
    }
  }

  async open(): Promise<void> {
    await this.mutex.run(async () => {
      if (this.state !== undefined) return;
      let raw: string;
      try {
        raw = await readFile(join(this.namespace.dir, this.fileName), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          this.state = initialState();
          return;
        }
        throw fail();
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        throw fail();
      }
      if (!validState(parsed)) throw fail();
      const pruned = prune(parsed, this.checkedNow());
      this.state = pruned.state;
      if (pruned.changed) await this.persist(pruned.state);
    });
  }

  subscribe(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async createInvitation(ttlMs = this.invitationTtlMs): Promise<TailnetPairingInvitation> {
    if (!validDuration(ttlMs, MAX_INVITE_TTL_MS)) throw fail();
    return await this.mutate((state, now) => {
      if (state.invitations.filter((entry) => entry.state === "open").length >= MAX_INVITATIONS) {
        throw capacity();
      }
      const id = this.nextUuid();
      const code = "lvis-pair-v1." + this.randomBytes(32).toString("base64url");
      if (!invitationCode(code)) throw fail();
      const invitation: StoredInvitation = {
        id,
        codeDigest: inviteDigest(code),
        createdAt: now,
        expiresAt: addDuration(now, ttlMs),
        state: "open",
        pairingId: null,
      };
      return {
        state: { ...state, invitations: [...state.invitations, invitation] },
        value: Object.freeze({ id, code, expiresAt: invitation.expiresAt }),
        changed: true,
      };
    });
  }

  async claimInvitation(
    code: string,
    claimedActorId: TailnetShareActorId,
  ): Promise<TailnetPairingClaim | null> {
    if (!invitationCode(code) || !actorId(claimedActorId)) return null;
    return await this.mutate((state, now) => {
      const codeDigest = inviteDigest(code);
      const invitationIndex = state.invitations.findIndex((entry) => (
        entry.state === "open"
        && entry.expiresAt > now
        && timingSafeEqualHexDigest(entry.codeDigest, codeDigest)
      ));
      if (invitationIndex < 0) return { state, value: null, changed: false };
      if (state.pairings.some((entry) => (
        entry.actorId === claimedActorId
        && (entry.state === "pending" || entry.state === "active")
      ))) {
        return { state, value: null, changed: false };
      }
      if (state.pairings.length >= MAX_PAIRINGS) throw capacity();
      const pairingId = this.nextUuid();
      const expiresAt = addDuration(now, DEFAULT_PENDING_TTL_MS);
      const invitations = [...state.invitations];
      invitations[invitationIndex] = {
        ...invitations[invitationIndex]!,
        state: "claimed",
        pairingId,
      };
      const pairing: StoredPairing = {
        id: pairingId,
        actorId: claimedActorId,
        invitationId: invitations[invitationIndex]!.id,
        createdAt: now,
        state: "pending",
        epoch: 1,
        expiresAt,
        activatedAt: null,
        terminalAt: null,
      };
      return {
        state: { ...state, invitations, pairings: [...state.pairings, pairing] },
        value: Object.freeze({ pairingId, expiresAt }),
        changed: true,
      };
    });
  }

  async activatePairing(pairingId: string): Promise<boolean> {
    if (!uuid(pairingId)) return false;
    return await this.mutate((state, now) => {
      const index = state.pairings.findIndex((entry) => entry.id === pairingId);
      const pairing = state.pairings[index];
      if (
        !pairing
        || pairing.state !== "pending"
        || pairing.expiresAt === null
        || pairing.expiresAt <= now
      ) {
        return { state, value: false, changed: false };
      }
      const pairings = [...state.pairings];
      pairings[index] = {
        ...pairing,
        state: "active",
        expiresAt: null,
        activatedAt: now,
      };
      return { state: { ...state, pairings }, value: true, changed: true };
    });
  }

  async createShare(input: Readonly<{
    pairingId: string;
    conversationId: string;
    permission?: TailnetSharePermission;
    ttlMs?: number;
  }>): Promise<TailnetPairingShareAuthority | null> {
    const permission = input.permission ?? "observe";
    const ttlMs = input.ttlMs ?? this.shareTtlMs;
    if (
      !uuid(input.pairingId)
      || !conversationId(input.conversationId)
      || (permission !== "observe" && permission !== "control")
      || !validDuration(ttlMs, MAX_SHARE_TTL_MS)
    ) {
      return null;
    }
    return await this.mutate((state, now) => {
      const pairing = state.pairings.find((entry) => (
        entry.id === input.pairingId && entry.state === "active"
      ));
      if (!pairing) return { state, value: null, changed: false };
      const targetDigest = conversationDigest(input.conversationId);
      const shares = state.shares.map((entry): StoredShare => (
        entry.state === "active"
        && entry.pairingId === pairing.id
        && entry.conversationDigest === targetDigest
          ? {
              ...entry,
              state: "revoked",
              epoch: nextEpoch(entry.epoch),
              terminalAt: now,
            }
          : entry
      ));
      if (shares.length >= MAX_SHARES) throw capacity();
      const share: StoredShare = {
        id: this.nextUuid(),
        pairingId: pairing.id,
        actorId: pairing.actorId,
        pairingEpoch: pairing.epoch,
        conversationDigest: targetDigest,
        scope: this.nextUuid(),
        permission,
        createdAt: now,
        expiresAt: addDuration(now, ttlMs),
        state: "active",
        epoch: 1,
        terminalAt: null,
      };
      return {
        state: { ...state, shares: [...shares, share] },
        value: Object.freeze({
          actorId: pairing.actorId,
          pairing: binding(pairing, share),
          permission,
        }),
        changed: true,
      };
    });
  }

  async revokeShare(shareId: string): Promise<boolean> {
    if (!uuid(shareId)) return false;
    return await this.mutate((state, now) => {
      const index = state.shares.findIndex((entry) => entry.id === shareId);
      const share = state.shares[index];
      if (!share || share.state !== "active") return { state, value: false, changed: false };
      const shares = [...state.shares];
      shares[index] = {
        ...share,
        state: "revoked",
        epoch: nextEpoch(share.epoch),
        terminalAt: now,
      };
      return { state: { ...state, shares }, value: true, changed: true };
    });
  }

  async revokePairing(pairingId: string): Promise<boolean> {
    if (!uuid(pairingId)) return false;
    return await this.mutate((state, now) => {
      const index = state.pairings.findIndex((entry) => entry.id === pairingId);
      const pairing = state.pairings[index];
      if (!pairing || (pairing.state !== "pending" && pairing.state !== "active")) {
        return { state, value: false, changed: false };
      }
      const pairings = [...state.pairings];
      pairings[index] = {
        ...pairing,
        state: "revoked",
        epoch: nextEpoch(pairing.epoch),
        expiresAt: null,
        activatedAt: null,
        terminalAt: now,
      };
      const shares = state.shares.map((share): StoredShare => (
        share.pairingId === pairing.id && share.state === "active"
          ? {
              ...share,
              state: "revoked",
              epoch: nextEpoch(share.epoch),
              terminalAt: now,
            }
          : share
      ));
      return { state: { ...state, pairings, shares }, value: true, changed: true };
    });
  }

  resolveActiveShare(
    resolvedActorId: TailnetShareActorId,
    currentConversationId: string,
    required: TailnetSharePermission,
  ): TailnetPairingShareAuthority | null {
    if (!actorId(resolvedActorId) || !conversationId(currentConversationId)) return null;
    const state = this.requireState();
    const now = this.checkedNow();
    const pairing = state.pairings.find((entry) => (
      entry.actorId === resolvedActorId && entry.state === "active"
    ));
    if (!pairing) return null;
    const targetDigest = conversationDigest(currentConversationId);
    const share = state.shares.find((entry) => (
      entry.state === "active"
      && entry.pairingId === pairing.id
      && entry.pairingEpoch === pairing.epoch
      && entry.actorId === resolvedActorId
      && entry.conversationDigest === targetDigest
      && entry.expiresAt > now
      && permits(entry.permission, required)
    ));
    return share
      ? Object.freeze({
          actorId: resolvedActorId,
          pairing: binding(pairing, share),
          permission: share.permission,
        })
      : null;
  }

  isAuthorityCurrent(
    authority: TailnetPairingShareAuthority,
    currentConversationId: string,
    required: TailnetSharePermission = "control",
  ): boolean {
    if (!authority || !actorId(authority.actorId) || !validBinding(authority.pairing)) return false;
    const latest = this.resolveActiveShare(authority.actorId, currentConversationId, required);
    return latest !== null
      && permits(latest.permission, required)
      && sameBinding(latest.pairing, authority.pairing);
  }

  ownerSnapshot(): TailnetOwnerSharingSnapshot {
    const state = this.requireState();
    const now = this.checkedNow();
    return Object.freeze({
      invitations: state.invitations
        .filter((entry) => entry.state === "open" && entry.expiresAt > now)
        .map((entry) => Object.freeze({ id: entry.id, expiresAt: entry.expiresAt })),
      pairings: state.pairings
        .filter((entry): entry is StoredPairing & { state: "pending" | "active" } => (
          entry.state === "active"
          || (entry.state === "pending" && entry.expiresAt !== null && entry.expiresAt > now)
        ))
        .map((entry) => Object.freeze({
          id: entry.id,
          actorFingerprint: fingerprint(entry.actorId),
          state: entry.state,
          expiresAt: entry.expiresAt,
        })),
      shares: state.shares
        .filter((entry) => entry.state === "active" && entry.expiresAt > now)
        .map((entry) => Object.freeze({
          id: entry.id,
          pairingId: entry.pairingId,
          actorFingerprint: fingerprint(entry.actorId),
          permission: entry.permission,
          expiresAt: entry.expiresAt,
        })),
    });
  }

  private async mutate<T>(
    operation: (state: StoreState, now: number) => {
      readonly state: StoreState;
      readonly value: T;
      readonly changed: boolean;
    },
  ): Promise<T> {
    return await this.mutex.run(async () => {
      const pruned = prune(this.requireState(), this.checkedNow());
      const outcome = operation(pruned.state, this.checkedNow());
      if (pruned.changed || outcome.changed) {
        if (!validState(outcome.state)) throw fail();
        await this.persist(outcome.state);
        this.state = outcome.state;
        this.emitChange();
      }
      return outcome.value;
    });
  }

  private requireState(): StoreState {
    if (this.state === undefined) throw new Error("tailnet-pairing-share-store-not-open");
    return this.state;
  }

  private checkedNow(): number {
    const value = this.now();
    if (!timestamp(value)) throw fail();
    return value;
  }

  private nextUuid(): string {
    const value = this.randomUuid();
    if (!uuid(value)) throw fail();
    return value;
  }

  private async persist(value: StoreState): Promise<void> {
    if (!validState(value)) throw fail();
    try {
      await this.namespace.writeJson(this.fileName, value);
    } catch {
      throw fail();
    }
  }

  private emitChange(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // A transport close/recheck must not corrupt already-persisted state.
      }
    }
  }
}

export function createTailnetPairingShareStore(
  options: CreateTailnetPairingShareStoreOptions = {},
): TailnetPairingShareStore {
  return new TailnetPairingShareStore(options);
}
