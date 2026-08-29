/**
 * Renderer-safe wire contract for the owner-driven Telegram private-DM bridge.
 *
 * Telegram is an external cloud recipient, so this contract is deliberately
 * narrower than the Tailnet one. It carries opaque fingerprints and coarse
 * state only: the bot token, the webhook secret, raw Telegram user/chat ids,
 * raw conversation ids, message text, and the raw pairing code never appear in
 * a snapshot or a change event.
 *
 * Pairing identifies a Telegram account. It grants nothing on its own; sharing
 * the open conversation is a separate, explicitly gestured owner action.
 */
import { hasUserKeyboardIntent, type UserKeyboardIntent } from "./chat-origin.js";
import { UUID_PATTERN } from "./uuid.js";

/** How long an unredeemed pairing code stays valid. */
export const TELEGRAM_PAIRING_CODE_TTL_MS = 10 * 60 * 1_000;

export const TELEGRAM_APPROVAL_DURATION_PRESETS = ["1h", "8h", "24h"] as const;
export type TelegramApprovalDurationPreset = (typeof TELEGRAM_APPROVAL_DURATION_PRESETS)[number];

/**
 * Coarse owner-visible connection state. It is derived by the main process;
 * the renderer never computes it, so a stale renderer cannot invent `active`.
 */
const TELEGRAM_CONNECTION_STATES = [
  /** This machine has no usable encrypted store, so no token may be saved. */
  "unsupported",
  /** Boot environment owns the bridge; the desktop surface is read-only. */
  "disconnected",
  "connected-unpaired",
  /**
   * There was a pairing, and this machine can no longer recognise the account
   * it named: the local key its digest was derived under is gone, which an OS
   * keychain reset or a restore onto another machine both cause. Separate from
   * `connected-unpaired` because the owner lost something and has to act, and
   * separate from `error` because the bot connection itself is fine — the one
   * repair is to pair again, so this state carries the pairing affordance.
   */
  "pairing-unrecognized",
  "pairing-pending",
  "paired-unapproved",
  /**
   * A share exists and survives a restart. Whether its conversation is the one
   * on screen is a property of the approval, not a state of the connection.
   */
  "active",
  /**
   * A share exists and names a conversation that no longer does. Distinct from
   * `active`, which the surface renders as "that conversation is not open" —
   * a deleted conversation is not one the owner can go back to, and telling
   * them to open it sends them looking for something that is gone.
   *
   * It is a state rather than a flag on the approval because the repair is a
   * connection-level action: share a different conversation. The share itself
   * is still durable and still authorises nothing else, so this is not `error`.
   */
  "shared-conversation-missing",
  "paused-by-owner",
  "error",
] as const;
export type TelegramConnectionState = (typeof TELEGRAM_CONNECTION_STATES)[number];

const TELEGRAM_CONNECTION_ERROR_CODES = [
  "unauthorized",
  "unauthorized-frame",
  "telegram-connection-disabled",
  "telegram-connection-unavailable",
  "telegram-connection-input-invalid",
  "telegram-connection-operation-rejected",
  "user-keyboard-required",
  "telegram-encryption-unavailable",
  "telegram-bot-token-rejected",
  /**
   * A token was stored and can no longer be read back. Distinct from
   * `telegram-encryption-unavailable`, which says this machine cannot hold a
   * secret at all: here the store reports itself encrypted and the saved value
   * is simply gone, which an OS keychain reset or a restore onto another
   * machine both cause. Also distinct from `telegram-bot-token-rejected`, which
   * is Telegram's verdict on a token this desktop could read.
   */
  "telegram-bot-token-unreadable",
  /**
   * This desktop could not write the connection's own durable state. Nothing is
   * wrong with the bot or with Telegram, so it is not a provider code — but
   * receiving stops, because the alternative is a bridge whose pairing,
   * approvals, and poll position can no longer be recorded.
   */
  "telegram-connection-state-unwritable",
  "telegram-provider-unreachable",
  "telegram-webhook-conflict",
  "telegram-poll-conflict",
] as const;
export type TelegramConnectionErrorCode = (typeof TELEGRAM_CONNECTION_ERROR_CODES)[number];

interface TelegramPairingSummary {
  readonly id: string;
  /** Opaque, shortened local digest. Never a Telegram user id or @username. */
  readonly accountFingerprint: string;
}

interface TelegramApprovalSummary {
  readonly id: string;
  readonly expiresAt: number;
  /**
   * Whether the shared conversation is the one currently on screen. The share
   * itself is durable, so this says only whether replies can flow right now:
   * execution still requires the shared conversation to be open. The renderer
   * must not compare conversation ids itself; it never receives one.
   */
  readonly matchesCurrentConversation: boolean;
}

/** A minted-but-unredeemed pairing code, described without its secret. */
interface TelegramPendingCodeSummary {
  readonly id: string;
  readonly expiresAt: number;
  readonly attemptsRemaining: number;
}

export interface TelegramConnectionSnapshot {
  readonly state: TelegramConnectionState;
  /** Resolved in-memory from getMe; absent until the bot is verified. */
  readonly botUsername: string | null;
  readonly pairing: TelegramPairingSummary | null;
  readonly approval: TelegramApprovalSummary | null;
  readonly pendingCode: TelegramPendingCodeSummary | null;
  readonly lastErrorCode: TelegramConnectionErrorCode | null;
}

/** Returned exactly once by createPairingCode and never present in a snapshot. */
export interface TelegramCreatedPairingCode {
  readonly id: string;
  readonly code: string;
  readonly expiresAt: number;
  /** Convenience for building the t.me link; the bot's public handle only. */
  readonly botUsername: string;
}

export interface TelegramConnectInput {
  readonly intent: UserKeyboardIntent;
  readonly botToken: string;
}

export interface TelegramIntentOnlyInput {
  readonly intent: UserKeyboardIntent;
}

export interface TelegramApproveCurrentConversationInput {
  readonly intent: UserKeyboardIntent;
  readonly duration?: TelegramApprovalDurationPreset;
}

export interface TelegramRevokeInput {
  readonly intent: UserKeyboardIntent;
  readonly id: string;
}

export type TelegramConnectionFailure = {
  readonly ok: false;
  readonly error: TelegramConnectionErrorCode;
};

export type TelegramConnectionMutationResult =
  | { readonly ok: true }
  | TelegramConnectionFailure;

export type TelegramConnectionSnapshotResult =
  | { readonly ok: true; readonly snapshot: TelegramConnectionSnapshot }
  | TelegramConnectionFailure;

export type TelegramCreatePairingCodeResult =
  | { readonly ok: true; readonly pairingCode: TelegramCreatedPairingCode }
  | TelegramConnectionFailure;

/**
 * The only Telegram owner-control surface exposed to the trusted renderer.
 * Every mutation carries a preload-minted live keyboard intent, and the
 * renderer never names a conversation: main resolves the open one at execution.
 */
export interface TelegramConnectionOwnerApi {
  snapshot(): Promise<TelegramConnectionSnapshotResult>;
  connect(botToken: string): Promise<TelegramConnectionMutationResult>;
  disconnect(): Promise<TelegramConnectionMutationResult>;
  pause(): Promise<TelegramConnectionMutationResult>;
  resume(): Promise<TelegramConnectionMutationResult>;
  createPairingCode(): Promise<TelegramCreatePairingCodeResult>;
  revokePairing(id: string): Promise<TelegramConnectionMutationResult>;
  approveCurrentConversation(
    duration?: TelegramApprovalDurationPreset,
  ): Promise<TelegramConnectionMutationResult>;
  revokeApproval(id: string): Promise<TelegramConnectionMutationResult>;
  /** Hint only: callers must pull a fresh snapshot; it carries no state. */
  onChanged(handler: () => void): () => void;
}

const ACCOUNT_FINGERPRINT = /^[a-f0-9]{12}$/;
/**
 * Deliberately not slash-prefixed. The shared ingress core rejects all leading
 * slash text unconditionally, so a `/start`-style code could never be redeemed
 * without branching that gate.
 */
export const TELEGRAM_PAIRING_CODE = /^lvis-tg-v1\.[A-Za-z0-9_-]{43}$/;
/**
 * BotFather handles are 5-32 chars TOTAL and must end in "bot"
 * (case-insensitive). The middle quantifier is total-length arithmetic:
 * 1 leading letter + {1,28} middle + 3-char suffix = 5..32. A wider middle
 * bound would silently raise the minimum above BotFather's own floor and
 * reject real 5-6 char handles (e.g. `aebot`) after a successful identity
 * call — which the connect flow then misreports as provider-unreachable.
 */
const BOT_USERNAME = /^[A-Za-z][A-Za-z0-9_]{1,28}[Bb][Oo][Tt]$/;
/** The bot token is bounded here only to reject obvious paste errors early. */
const BOT_TOKEN = /^[0-9]{5,20}:[A-Za-z0-9_-]{20,220}$/;
const MAX_CONVERSATION_CHARS = 4_096;
const UNSAFE_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function timestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function counter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isTelegramConnectionId(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

/**
 * The one grammar for a host conversation id on the Telegram path.
 *
 * A conversation id is never projected to a renderer, but three main-process
 * owners have to agree on what one is: the service validates the id it is about
 * to share, the connection store persists it as a routing hint, and the platform
 * runtime compares the bound id against the one on screen. A second inline copy
 * that admitted one more character would let a grant be written that the route
 * fence could never match.
 */
export function isTelegramConversationId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_CONVERSATION_CHARS
    && value.trim().length > 0
    && !UNSAFE_CONTROL_CHARACTERS.test(value);
}

function isTelegramConnectionState(value: unknown): value is TelegramConnectionState {
  return typeof value === "string"
    && (TELEGRAM_CONNECTION_STATES as readonly string[]).includes(value);
}

export function isTelegramConnectionErrorCode(
  value: unknown,
): value is TelegramConnectionErrorCode {
  return typeof value === "string"
    && (TELEGRAM_CONNECTION_ERROR_CODES as readonly string[]).includes(value);
}

export function isTelegramApprovalDurationPreset(
  value: unknown,
): value is TelegramApprovalDurationPreset {
  return typeof value === "string"
    && (TELEGRAM_APPROVAL_DURATION_PRESETS as readonly string[]).includes(value);
}

export function isTelegramBotToken(value: unknown): value is string {
  return typeof value === "string" && BOT_TOKEN.test(value);
}

export function isTelegramBotUsername(value: unknown): value is string {
  return typeof value === "string" && BOT_USERNAME.test(value);
}

export function isTelegramPairingCode(value: unknown): value is string {
  return typeof value === "string" && TELEGRAM_PAIRING_CODE.test(value);
}

function hasIntent(value: Record<string, unknown>): boolean {
  return hasUserKeyboardIntent(value.intent);
}

export function isTelegramConnectInput(value: unknown): value is TelegramConnectInput {
  return record(value) && exactKeys(value, ["botToken", "intent"])
    && hasIntent(value) && isTelegramBotToken(value.botToken);
}

export function isTelegramIntentOnlyInput(value: unknown): value is TelegramIntentOnlyInput {
  return record(value) && exactKeys(value, ["intent"]) && hasIntent(value);
}

export function isTelegramApproveCurrentConversationInput(
  value: unknown,
): value is TelegramApproveCurrentConversationInput {
  if (!record(value) || !hasIntent(value)) return false;
  if (exactKeys(value, ["intent"])) return true;
  return exactKeys(value, ["duration", "intent"])
    && isTelegramApprovalDurationPreset(value.duration);
}

export function isTelegramRevokeInput(value: unknown): value is TelegramRevokeInput {
  return record(value) && exactKeys(value, ["id", "intent"])
    && hasIntent(value) && isTelegramConnectionId(value.id);
}

function parsePairingSummary(value: unknown): TelegramPairingSummary | null {
  if (!record(value) || !exactKeys(value, ["accountFingerprint", "id"])
    || !isTelegramConnectionId(value.id)
    || typeof value.accountFingerprint !== "string"
    || !ACCOUNT_FINGERPRINT.test(value.accountFingerprint)) {
    return null;
  }
  return Object.freeze({ id: value.id, accountFingerprint: value.accountFingerprint });
}

function parseApprovalSummary(value: unknown): TelegramApprovalSummary | null {
  if (!record(value) || !exactKeys(value, ["expiresAt", "id", "matchesCurrentConversation"])
    || !isTelegramConnectionId(value.id)
    || !timestamp(value.expiresAt)
    || typeof value.matchesCurrentConversation !== "boolean") {
    return null;
  }
  return Object.freeze({
    id: value.id,
    expiresAt: value.expiresAt,
    matchesCurrentConversation: value.matchesCurrentConversation,
  });
}

function parsePendingCodeSummary(value: unknown): TelegramPendingCodeSummary | null {
  if (!record(value) || !exactKeys(value, ["attemptsRemaining", "expiresAt", "id"])
    || !isTelegramConnectionId(value.id)
    || !timestamp(value.expiresAt)
    || !counter(value.attemptsRemaining)) {
    return null;
  }
  return Object.freeze({
    id: value.id,
    expiresAt: value.expiresAt,
    attemptsRemaining: value.attemptsRemaining,
  });
}

/**
 * Rebuild the safe projection field by field rather than passing the wire
 * object through, so a future main-process producer that accidentally widens
 * its record cannot leak the added field to the renderer.
 */
export function parseTelegramConnectionSnapshot(
  value: unknown,
): TelegramConnectionSnapshot | null {
  if (!record(value)
    || !exactKeys(value, ["approval", "botUsername", "lastErrorCode", "pairing", "pendingCode", "state"])
    || !isTelegramConnectionState(value.state)
    || (value.botUsername !== null && !isTelegramBotUsername(value.botUsername))
    || (value.lastErrorCode !== null && !isTelegramConnectionErrorCode(value.lastErrorCode))) {
    return null;
  }
  const pairing = value.pairing === null ? null : parsePairingSummary(value.pairing);
  const approval = value.approval === null ? null : parseApprovalSummary(value.approval);
  const pendingCode = value.pendingCode === null ? null : parsePendingCodeSummary(value.pendingCode);
  if ((value.pairing !== null && pairing === null)
    || (value.approval !== null && approval === null)
    || (value.pendingCode !== null && pendingCode === null)) {
    return null;
  }
  return Object.freeze({
    state: value.state,
    botUsername: value.botUsername as string | null,
    pairing,
    approval,
    pendingCode,
    lastErrorCode: value.lastErrorCode as TelegramConnectionErrorCode | null,
  });
}

export function parseTelegramCreatedPairingCode(
  value: unknown,
): TelegramCreatedPairingCode | null {
  if (!record(value) || !exactKeys(value, ["botUsername", "code", "expiresAt", "id"])
    || !isTelegramConnectionId(value.id)
    || !isTelegramPairingCode(value.code)
    || !isTelegramBotUsername(value.botUsername)
    || !timestamp(value.expiresAt)) {
    return null;
  }
  return Object.freeze({
    id: value.id,
    code: value.code,
    expiresAt: value.expiresAt,
    botUsername: value.botUsername,
  });
}

function parseFailure(value: unknown): TelegramConnectionFailure | null {
  if (!record(value) || !exactKeys(value, ["error", "ok"])
    || value.ok !== false || !isTelegramConnectionErrorCode(value.error)) {
    return null;
  }
  return Object.freeze({ ok: false, error: value.error });
}

/** Rebuild a result projection too, so unknown IPC fields never cross preload. */
export function parseTelegramConnectionMutationResult(
  value: unknown,
): TelegramConnectionMutationResult | null {
  const failure = parseFailure(value);
  if (failure !== null) return failure;
  if (!record(value) || !exactKeys(value, ["ok"]) || value.ok !== true) return null;
  return Object.freeze({ ok: true });
}

export function parseTelegramConnectionSnapshotResult(
  value: unknown,
): TelegramConnectionSnapshotResult | null {
  const failure = parseFailure(value);
  if (failure !== null) return failure;
  if (!record(value) || !exactKeys(value, ["ok", "snapshot"]) || value.ok !== true) return null;
  const snapshot = parseTelegramConnectionSnapshot(value.snapshot);
  return snapshot === null ? null : Object.freeze({ ok: true, snapshot });
}

export function parseTelegramCreatePairingCodeResult(
  value: unknown,
): TelegramCreatePairingCodeResult | null {
  const failure = parseFailure(value);
  if (failure !== null) return failure;
  if (!record(value) || !exactKeys(value, ["ok", "pairingCode"]) || value.ok !== true) return null;
  const pairingCode = parseTelegramCreatedPairingCode(value.pairingCode);
  return pairingCode === null ? null : Object.freeze({ ok: true, pairingCode });
}
