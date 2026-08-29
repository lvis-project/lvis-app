/**
 * Renderer-safe wire contract for local-owner Tailnet pairing and sharing.
 *
 * Pairing identifies a Tailnet account but grants no access by itself. A
 * current-conversation share is a separate, explicit local-owner action. This
 * module deliberately contains only opaque identifiers and summaries: raw
 * Tailnet logins, raw conversation ids, pairing bindings, and invitation codes
 * never appear in a snapshot or change event.
 */
import { hasUserKeyboardIntent, type UserKeyboardIntent } from "./chat-origin.js";
import { UUID_PATTERN } from "./uuid.js";

export const TAILNET_INVITATION_DURATION_PRESETS = ["10m", "1h", "24h"] as const;
export type TailnetInvitationDurationPreset = (typeof TAILNET_INVITATION_DURATION_PRESETS)[number];

export const TAILNET_SHARE_DURATION_PRESETS = ["1h", "8h", "24h"] as const;
export type TailnetShareDurationPreset = (typeof TAILNET_SHARE_DURATION_PRESETS)[number];

const TAILNET_SHARE_PERMISSIONS = ["observe", "control"] as const;
export type TailnetSharePermission = (typeof TAILNET_SHARE_PERMISSIONS)[number];

const TAILNET_SHARING_ERROR_CODES = [
  "unauthorized",
  "unauthorized-frame",
  "tailnet-sharing-disabled",
  "user-keyboard-required",
  "tailnet-sharing-input-invalid",
  "tailnet-sharing-operation-rejected",
  "tailnet-sharing-unavailable",
] as const;
export type TailnetSharingErrorCode = (typeof TAILNET_SHARING_ERROR_CODES)[number];

export interface TailnetSharingInvitationSummary {
  readonly id: string;
  readonly expiresAt: number;
}

export interface TailnetSharingPairingSummary {
  readonly id: string;
  /** Opaque, shortened local fingerprint; never a Tailnet login. */
  readonly actorFingerprint: string;
  readonly state: "pending" | "active";
  readonly expiresAt: number | null;
}

export interface TailnetSharingShareSummary {
  readonly id: string;
  readonly pairingId: string;
  /** Opaque, shortened local fingerprint; never a Tailnet login. */
  readonly actorFingerprint: string;
  readonly permission: TailnetSharePermission;
  readonly expiresAt: number;
}

/**
 * Owner-visible projection only. It is intentionally not a durable grant or
 * remote authorization object; the main process resolves current conversation
 * and revocation epochs internally.
 */
export interface TailnetSharingSnapshot {
  readonly invitations: readonly TailnetSharingInvitationSummary[];
  readonly pairings: readonly TailnetSharingPairingSummary[];
  readonly shares: readonly TailnetSharingShareSummary[];
}

/** The raw invite is returned exactly once by createInvitation and is never in TailnetSharingSnapshot. */
export interface TailnetSharingCreatedInvitation {
  readonly id: string;
  readonly code: string;
  readonly expiresAt: number;
}

export interface TailnetSharingCreateInvitationInput {
  readonly intent: UserKeyboardIntent;
  readonly duration?: TailnetInvitationDurationPreset;
}

export interface TailnetSharingActivatePairingInput {
  readonly intent: UserKeyboardIntent;
  readonly id: string;
}

export interface TailnetSharingCreateCurrentConversationShareInput {
  readonly intent: UserKeyboardIntent;
  readonly pairingId: string;
  readonly permission: TailnetSharePermission;
  readonly duration?: TailnetShareDurationPreset;
}

export interface TailnetSharingRevokeInput {
  readonly intent: UserKeyboardIntent;
  readonly id: string;
}

export type TailnetSharingFailure = {
  readonly ok: false;
  readonly error: TailnetSharingErrorCode;
};

export type TailnetSharingMutationResult =
  | { readonly ok: true }
  | TailnetSharingFailure;

export type TailnetSharingSnapshotResult =
  | { readonly ok: true; readonly snapshot: TailnetSharingSnapshot }
  | TailnetSharingFailure;

export type TailnetSharingCreateInvitationResult =
  | { readonly ok: true; readonly invitation: TailnetSharingCreatedInvitation }
  | TailnetSharingFailure;

/**
 * The only owner-control surface exposed to the trusted Electron renderer.
 * Every mutation has a preload-minted live keyboard intent. The renderer never
 * names a conversation/session; main resolves the active one at execution.
 */
export interface TailnetSharingOwnerApi {
  snapshot(): Promise<TailnetSharingSnapshotResult>;
  createInvitation(duration?: TailnetInvitationDurationPreset): Promise<TailnetSharingCreateInvitationResult>;
  activatePairing(id: string): Promise<TailnetSharingMutationResult>;
  createCurrentConversationShare(
    pairingId: string,
    permission: TailnetSharePermission,
    duration?: TailnetShareDurationPreset,
  ): Promise<TailnetSharingMutationResult>;
  revokeShare(id: string): Promise<TailnetSharingMutationResult>;
  revokePairing(id: string): Promise<TailnetSharingMutationResult>;
  /** Hint only: callers must pull a fresh snapshot; it carries no share data. */
  onChanged(handler: () => void): () => void;
}

const ACTOR_FINGERPRINT = /^[a-f0-9]{12}$/;
const INVITATION_CODE = /^lvis-pair-v1\.[A-Za-z0-9_-]{43}$/;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function timestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isTailnetSharingId(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function isTailnetInvitationDurationPreset(value: unknown): value is TailnetInvitationDurationPreset {
  return typeof value === "string"
    && (TAILNET_INVITATION_DURATION_PRESETS as readonly string[]).includes(value);
}

export function isTailnetShareDurationPreset(value: unknown): value is TailnetShareDurationPreset {
  return typeof value === "string"
    && (TAILNET_SHARE_DURATION_PRESETS as readonly string[]).includes(value);
}

export function isTailnetSharePermission(value: unknown): value is TailnetSharePermission {
  return typeof value === "string" && (TAILNET_SHARE_PERMISSIONS as readonly string[]).includes(value);
}

function isTailnetSharingErrorCode(value: unknown): value is TailnetSharingErrorCode {
  return typeof value === "string" && (TAILNET_SHARING_ERROR_CODES as readonly string[]).includes(value);
}

export function isTailnetSharingCreateInvitationInput(
  value: unknown,
): value is TailnetSharingCreateInvitationInput {
  if (!record(value) || !hasUserKeyboardIntent(value.intent)) return false;
  return value.duration === undefined
    ? exactKeys(value, ["intent"])
    : exactKeys(value, ["duration", "intent"]) && isTailnetInvitationDurationPreset(value.duration);
}

export function isTailnetSharingActivatePairingInput(
  value: unknown,
): value is TailnetSharingActivatePairingInput {
  return record(value)
    && exactKeys(value, ["id", "intent"])
    && hasUserKeyboardIntent(value.intent)
    && isTailnetSharingId(value.id);
}

export function isTailnetSharingCreateCurrentConversationShareInput(
  value: unknown,
): value is TailnetSharingCreateCurrentConversationShareInput {
  if (!record(value) || !hasUserKeyboardIntent(value.intent)) return false;
  const base = isTailnetSharingId(value.pairingId) && isTailnetSharePermission(value.permission);
  return value.duration === undefined
    ? exactKeys(value, ["intent", "pairingId", "permission"]) && base
    : exactKeys(value, ["duration", "intent", "pairingId", "permission"])
      && base
      && isTailnetShareDurationPreset(value.duration);
}

export function isTailnetSharingRevokeInput(value: unknown): value is TailnetSharingRevokeInput {
  return record(value)
    && exactKeys(value, ["id", "intent"])
    && hasUserKeyboardIntent(value.intent)
    && isTailnetSharingId(value.id);
}

function parseInvitationSummary(value: unknown): TailnetSharingInvitationSummary | null {
  if (!record(value) || !exactKeys(value, ["expiresAt", "id"])
    || !isTailnetSharingId(value.id) || !timestamp(value.expiresAt)) {
    return null;
  }
  return Object.freeze({ id: value.id, expiresAt: value.expiresAt });
}

function parsePairingSummary(value: unknown): TailnetSharingPairingSummary | null {
  if (!record(value) || !exactKeys(value, ["actorFingerprint", "expiresAt", "id", "state"])
    || !isTailnetSharingId(value.id)
    || typeof value.actorFingerprint !== "string"
    || !ACTOR_FINGERPRINT.test(value.actorFingerprint)
    || (value.state !== "pending" && value.state !== "active")
    || !(value.expiresAt === null || timestamp(value.expiresAt))) {
    return null;
  }
  return Object.freeze({
    id: value.id,
    actorFingerprint: value.actorFingerprint,
    state: value.state,
    expiresAt: value.expiresAt,
  });
}

function parseShareSummary(value: unknown): TailnetSharingShareSummary | null {
  if (!record(value) || !exactKeys(value, ["actorFingerprint", "expiresAt", "id", "pairingId", "permission"])
    || !isTailnetSharingId(value.id)
    || !isTailnetSharingId(value.pairingId)
    || typeof value.actorFingerprint !== "string"
    || !ACTOR_FINGERPRINT.test(value.actorFingerprint)
    || !isTailnetSharePermission(value.permission)
    || !timestamp(value.expiresAt)) {
    return null;
  }
  return Object.freeze({
    id: value.id,
    pairingId: value.pairingId,
    actorFingerprint: value.actorFingerprint,
    permission: value.permission,
    expiresAt: value.expiresAt,
  });
}

/**
 * Rebuild the safe projection instead of returning the wire object directly.
 * This makes an accidental future raw-code/raw-login field non-observable to
 * renderer callers even if a main-process producer is broadened incorrectly.
 */
export function parseTailnetSharingSnapshot(value: unknown): TailnetSharingSnapshot | null {
  if (!record(value) || !exactKeys(value, ["invitations", "pairings", "shares"])
    || !Array.isArray(value.invitations)
    || !Array.isArray(value.pairings)
    || !Array.isArray(value.shares)) {
    return null;
  }
  const invitations = value.invitations.map(parseInvitationSummary);
  const pairings = value.pairings.map(parsePairingSummary);
  const shares = value.shares.map(parseShareSummary);
  if (invitations.some((entry) => entry === null)
    || pairings.some((entry) => entry === null)
    || shares.some((entry) => entry === null)) {
    return null;
  }
  return Object.freeze({
    invitations: Object.freeze(invitations as TailnetSharingInvitationSummary[]),
    pairings: Object.freeze(pairings as TailnetSharingPairingSummary[]),
    shares: Object.freeze(shares as TailnetSharingShareSummary[]),
  });
}

export function parseTailnetSharingCreatedInvitation(
  value: unknown,
): TailnetSharingCreatedInvitation | null {
  if (!record(value) || !exactKeys(value, ["code", "expiresAt", "id"])
    || !isTailnetSharingId(value.id)
    || typeof value.code !== "string"
    || !INVITATION_CODE.test(value.code)
    || !timestamp(value.expiresAt)) {
    return null;
  }
  return Object.freeze({ id: value.id, code: value.code, expiresAt: value.expiresAt });
}

function parseTailnetSharingFailure(value: unknown): TailnetSharingFailure | null {
  if (!record(value) || !exactKeys(value, ["error", "ok"])
    || value.ok !== false || !isTailnetSharingErrorCode(value.error)) {
    return null;
  }
  return Object.freeze({ ok: false, error: value.error });
}

/** Rebuild a result projection too, so unknown IPC fields never cross preload. */
export function parseTailnetSharingMutationResult(value: unknown): TailnetSharingMutationResult | null {
  const failure = parseTailnetSharingFailure(value);
  if (failure !== null) return failure;
  if (!record(value) || !exactKeys(value, ["ok"]) || value.ok !== true) return null;
  return Object.freeze({ ok: true });
}

export function parseTailnetSharingSnapshotResult(value: unknown): TailnetSharingSnapshotResult | null {
  const failure = parseTailnetSharingFailure(value);
  if (failure !== null) return failure;
  if (!record(value) || !exactKeys(value, ["ok", "snapshot"]) || value.ok !== true) return null;
  const snapshot = parseTailnetSharingSnapshot(value.snapshot);
  return snapshot === null ? null : Object.freeze({ ok: true, snapshot });
}

export function parseTailnetSharingCreateInvitationResult(
  value: unknown,
): TailnetSharingCreateInvitationResult | null {
  const failure = parseTailnetSharingFailure(value);
  if (failure !== null) return failure;
  if (!record(value) || !exactKeys(value, ["invitation", "ok"]) || value.ok !== true) return null;
  const invitation = parseTailnetSharingCreatedInvitation(value.invitation);
  return invitation === null ? null : Object.freeze({ ok: true, invitation });
}
