/**
 * Main-only owner facade for the Telegram private-DM bridge.
 *
 * The renderer never computes connection state, never names a conversation, and
 * never sees the bot token, a raw Telegram id, or a raw conversation id. This
 * facade owns the whole decision: it derives the coarse state, holds the bot
 * handle in memory, and returns only the shared wire contract's shapes.
 *
 * Every method answers with a stable error code instead of throwing. A raw
 * main-process error could carry the bot token (a fetch error carries the
 * request URL, and the token is URL path material), so nothing but a code from
 * `TELEGRAM_CONNECTION_ERROR_CODES` ever leaves this module.
 */
import { createHash } from "node:crypto";
import { SecretEncryptionUnavailableError } from "../data/secret-document-store.js";
import {
  TELEGRAM_PAIRING_CODE_TTL_MS,
  isTelegramApprovalDurationPreset,
  isTelegramBotToken,
  isTelegramBotUsername,
  isTelegramConnectionId,
  isTelegramConversationId,
  parseTelegramConnectionSnapshot,
  parseTelegramCreatedPairingCode,
  type TelegramApprovalDurationPreset,
  type TelegramConnectionErrorCode,
  type TelegramConnectionFailure,
  type TelegramConnectionMutationResult,
  type TelegramConnectionSnapshotResult,
  type TelegramConnectionState,
  type TelegramCreatePairingCodeResult,
} from "../shared/telegram-connection.js";
import {
  createTelegramBotApiClient,
  type TelegramBotApiClient,
  type TelegramBotApiFailureReason,
  type TelegramBotApiResult,
  type TelegramBotIdentity,
  type TelegramWebhookStatus,
} from "./telegram-bot-api-client.js";
import type {
  TelegramConnectionStore,
  TelegramDesiredState,
  TelegramOwnerApprovalSummary,
  TelegramOwnerConnectionSnapshot,
} from "./telegram-connection-store.js";
import { mintTelegramPairingCode, telegramPairingCodeDigest } from "./telegram-pairing-code.js";

/**
 * Sole storage key for the owner bot token; activation reads the same one.
 * Security-sensitive: read it only through `getEncryptedSecret`.
 */
export const TELEGRAM_BOT_TOKEN_SECRET_KEY = "telegram.botToken.v1";
const SECRET_KEY = TELEGRAM_BOT_TOKEN_SECRET_KEY;
/**
 * Must stay byte-identical to `botFingerprint()` in telegram-bridge-server.ts:
 * the platform runtime derives every actor digest from this value, so a second
 * grammar would silently invalidate stored pairings.
 */
const BOT_FINGERPRINT_DOMAIN = "lvis/telegram-bridge/bot-fingerprint/v1\0";
const PAIRING_CODE_MAX_ATTEMPTS = 5;

const APPROVAL_DURATION_MS: Readonly<Record<TelegramApprovalDurationPreset, number>> = Object.freeze({
  "1h": 60 * 60 * 1_000,
  "8h": 8 * 60 * 60 * 1_000,
  "24h": 24 * 60 * 60 * 1_000,
});

/** Lifecycle hooks owned by main composition; this facade only sequences them. */
interface TelegramConnectionBridgeControl {
  start(): Promise<void>;
  stop(reason: "shutdown" | "user"): Promise<void>;
}

/**
 * The narrow slice of the settings store this facade may use. `getSecret` is
 * deliberately absent: it can return a value stored under the development
 * plain-text encoding, which must never be sent to an external cloud provider.
 */
interface TelegramConnectionSecretService {
  setSecret(key: string, value: string): Promise<void>;
  getEncryptedSecret(key: string): string | null;
  deleteSecret(key: string): Promise<void>;
  isSecretStorageEncrypted(): boolean;
}

export interface CreateTelegramConnectionServiceOptions {
  readonly store: TelegramConnectionStore;
  readonly settingsService: TelegramConnectionSecretService;
  readonly bridgeControl: TelegramConnectionBridgeControl;
  /** Read at the moment of an approval; a renderer can never choose this id. */
  readonly getCurrentConversationId: () => string;
  readonly conversationDigestFor: (conversationId: string) => string;
  /** True when `LVIS_TELEGRAM_BRIDGE` owns the bridge. Wins over stored state. */
  readonly envManaged: boolean;
  /** Test-only injection; production builds a real Bot API client. */
  readonly createBotApiClient?: (botToken: string) => TelegramBotApiClient;
}

export interface TelegramConnectionService {
  snapshot(): TelegramConnectionSnapshotResult;
  connect(botToken: string): Promise<TelegramConnectionMutationResult>;
  disconnect(): Promise<TelegramConnectionMutationResult>;
  pause(): Promise<TelegramConnectionMutationResult>;
  resume(): Promise<TelegramConnectionMutationResult>;
  /** Boot-time continuation only; never a user action. */
  resumeStoredConnection(): Promise<void>;
  createPairingCode(): Promise<TelegramCreatePairingCodeResult>;
  revokePairing(id: string): Promise<TelegramConnectionMutationResult>;
  approveCurrentConversation(
    duration?: TelegramApprovalDurationPreset,
  ): Promise<TelegramConnectionMutationResult>;
  revokeApproval(id: string): Promise<TelegramConnectionMutationResult>;
  subscribe(listener: () => void): () => void;
}

/** Same digest the platform runtime is handed as `botFingerprint`. */
function telegramBotFingerprint(botToken: string): string {
  return createHash("sha256")
    .update(BOT_FINGERPRINT_DOMAIN, "utf8")
    .update(botToken, "utf8")
    .digest("hex");
}

const OK: TelegramConnectionMutationResult = Object.freeze({ ok: true as const });

function failure(error: TelegramConnectionErrorCode): TelegramConnectionFailure {
  return Object.freeze({ ok: false as const, error });
}

const MANAGED = failure("telegram-managed-by-environment");
const UNAVAILABLE = failure("telegram-connection-unavailable");
const ENCRYPTION_UNAVAILABLE = failure("telegram-encryption-unavailable");
const INPUT_INVALID = failure("telegram-connection-input-invalid");
const REJECTED = failure("telegram-connection-operation-rejected");

/**
 * Classify a Bot API failure. A 401 is the token itself; a 409 means another
 * receiver already owns this bot's updates. Everything else is reported as an
 * unreachable provider rather than guessed at.
 */
function providerFailure(reason: TelegramBotApiFailureReason): TelegramConnectionFailure {
  if (reason === "unauthorized") return failure("telegram-bot-token-rejected");
  if (reason === "conflict") return failure("telegram-poll-conflict");
  return failure("telegram-provider-unreachable");
}

function isFailure(value: { readonly ok: boolean }): value is TelegramConnectionFailure {
  return value.ok === false;
}

/** A verified bot carries its handle; a failure carries only a stable code. */
type VerifiedBot =
  | { readonly ok: true; readonly username: string }
  | TelegramConnectionFailure;

function isBridgeControl(value: unknown): value is TelegramConnectionBridgeControl {
  return typeof value === "object"
    && value !== null
    && typeof (value as TelegramConnectionBridgeControl).start === "function"
    && typeof (value as TelegramConnectionBridgeControl).stop === "function";
}

function isSecretService(value: unknown): value is TelegramConnectionSecretService {
  const candidate = value as TelegramConnectionSecretService | null;
  return typeof value === "object"
    && value !== null
    && typeof candidate?.setSecret === "function"
    && typeof candidate.getEncryptedSecret === "function"
    && typeof candidate.deleteSecret === "function"
    && typeof candidate.isSecretStorageEncrypted === "function";
}

function isStore(value: unknown): value is TelegramConnectionStore {
  const candidate = value as TelegramConnectionStore | null;
  return typeof value === "object"
    && value !== null
    && typeof candidate?.ownerSnapshot === "function"
    && typeof candidate.setConnected === "function"
    && typeof candidate.createPendingCode === "function"
    && typeof candidate.createApproval === "function"
    && typeof candidate.subscribe === "function";
}

interface ApprovalProjection {
  readonly id: string;
  readonly expiresAt: number;
  readonly matchesCurrentConversation: boolean;
}

/**
 * Project the one live share. The store decides which grant that is; this only
 * reports whether it happens to be the conversation on screen, which is what
 * the owner needs to know because execution still requires it — the share
 * itself is durable and does not lapse when they look away.
 */
function projectApproval(
  approval: TelegramOwnerApprovalSummary | null,
  currentDigest: string | null,
): ApprovalProjection | null {
  if (approval === null) return null;
  return Object.freeze({
    id: approval.id,
    expiresAt: approval.expiresAt,
    matchesCurrentConversation: currentDigest !== null
      && approval.conversationDigest === currentDigest,
  });
}

/**
 * Ordered so no earlier condition can be skipped: an environment-managed or
 * unencryptable host answers before any stored state is consulted, and both
 * "paused" and "no approval" are answered before `active` can be reached.
 *
 * A share that exists is `active` whether or not its conversation is on screen.
 * The binding is durable, so "you are looking elsewhere" is a property of the
 * approval, not a state of the connection — it does not survive a restart as a
 * state, and it never described anything the owner had to repair.
 *
 * A pairing retired by an actor-key rotation is the opposite: it IS something
 * the owner has to repair, it survives a restart, and it ends only when a new
 * pairing exists. That is why it is a state and not a `lastErrorCode` note —
 * an error code would be answered above as `error`, which withholds the very
 * affordance the owner needs, and `setConnected` clears the note on the next
 * reconnect while the pairing stays gone.
 */
function deriveState(
  owner: TelegramOwnerConnectionSnapshot,
  approval: ApprovalProjection | null,
): TelegramConnectionState {
  if (owner.desiredState === "disconnected") return "disconnected";
  if (owner.desiredState === "paused") return "paused-by-owner";
  if (owner.lastErrorCode !== null) return "error";
  if (owner.pairing === null) {
    // A code already minted is the repair in progress; say so rather than
    // repeating the loss the owner is in the middle of fixing.
    if (owner.pendingCode !== null) return "pairing-pending";
    return owner.pairingUnrecognized ? "pairing-unrecognized" : "connected-unpaired";
  }
  return approval === null ? "paired-unapproved" : "active";
}

/** Serialize multi-step lifecycle work so two connects cannot interleave. */
function createMutex(): <T>(work: () => Promise<T>) => Promise<T> {
  let tail: Promise<void> = Promise.resolve();
  return async <T>(work: () => Promise<T>): Promise<T> => {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  };
}

export function createTelegramConnectionService(
  options: CreateTelegramConnectionServiceOptions,
): TelegramConnectionService {
  if (
    !options
    || typeof options !== "object"
    || !isStore(options.store)
    || !isSecretService(options.settingsService)
    || !isBridgeControl(options.bridgeControl)
    || typeof options.getCurrentConversationId !== "function"
    || typeof options.conversationDigestFor !== "function"
    || typeof options.envManaged !== "boolean"
  ) {
    throw new Error("telegram-connection-service-invalid");
  }
  const { store, settingsService, bridgeControl, envManaged } = options;
  const makeClient = options.createBotApiClient
    ?? ((botToken: string) => createTelegramBotApiClient({ botToken }));
  const listeners = new Set<() => void>();
  const runExclusive = createMutex();
  /** Resolved from getMe and never persisted; a restart re-verifies it. */
  let botUsername: string | null = null;

  const emitChange = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // A surface refresh failure must not abort a completed lifecycle step.
      }
    }
  };

  if (!envManaged) store.subscribe(emitChange);

  /**
   * The conversation on screen, named both ways. The store persists the id so
   * the share survives a restart and re-derives the digest to check it, so a
   * caller that produced one without the other could not be verified.
   */
  const currentConversation = (): { readonly id: string; readonly digest: string } | null => {
    try {
      const id = options.getCurrentConversationId();
      if (!isTelegramConversationId(id)) return null;
      const digest = options.conversationDigestFor(id);
      return typeof digest === "string" && /^[a-f0-9]{64}$/.test(digest) ? { id, digest } : null;
    } catch {
      return null;
    }
  };

  const inertSnapshot = (state: TelegramConnectionState): TelegramConnectionSnapshotResult => {
    const snapshot = parseTelegramConnectionSnapshot({
      state,
      botUsername: null,
      pairing: null,
      approval: null,
      pendingCode: null,
      lastErrorCode: null,
    });
    return snapshot === null ? UNAVAILABLE : Object.freeze({ ok: true as const, snapshot });
  };

  /** Best-effort: never let a persisted note about a failure mask the failure. */
  const noteError = async (error: TelegramConnectionErrorCode): Promise<void> => {
    try {
      await store.setLastError(error);
    } catch {
      /* the returned code is the authority; the stored note is a convenience */
    }
  };

  const readStoredToken = (): string | null => {
    try {
      const value = settingsService.getEncryptedSecret(SECRET_KEY);
      return isTelegramBotToken(value) ? value : null;
    } catch {
      return null;
    }
  };

  /**
   * Put the credential back the way it was. A connect attempt with a new token
   * must not destroy the working one it failed to replace.
   */
  const restoreSecret = async (previous: string | null): Promise<void> => {
    try {
      if (previous === null) await settingsService.deleteSecret(SECRET_KEY);
      else await settingsService.setSecret(SECRET_KEY, previous);
    } catch {
      /* rollback is best effort; the caller already has its failure code */
    }
  };

  /**
   * Verify the bot before anything durable points at it: identity first, then
   * webhook ownership. A bot that already has a webhook belongs to another
   * deployment, and LVIS never calls setWebhook/deleteWebhook to take it.
   */
  const verifyBot = async (botToken: string): Promise<VerifiedBot> => {
    let client: TelegramBotApiClient;
    try {
      client = makeClient(botToken);
    } catch {
      return INPUT_INVALID;
    }
    let identity: TelegramBotApiResult<TelegramBotIdentity>;
    try {
      identity = await client.getMe();
    } catch {
      return failure("telegram-provider-unreachable");
    }
    if (!identity.ok) return providerFailure(identity.reason);
    if (!isTelegramBotUsername(identity.value.username)) {
      return failure("telegram-provider-unreachable");
    }
    let webhook: TelegramBotApiResult<TelegramWebhookStatus>;
    try {
      webhook = await client.getWebhookInfo();
    } catch {
      return failure("telegram-provider-unreachable");
    }
    if (!webhook.ok) return providerFailure(webhook.reason);
    // Fail closed: an already-registered webhook belongs to someone else, and
    // removing it is not LVIS's call to make.
    if (webhook.value.hasWebhook) return failure("telegram-webhook-conflict");
    return Object.freeze({ ok: true as const, username: identity.value.username });
  };

  const activate = async (
    botToken: string,
    username: string,
  ): Promise<TelegramConnectionMutationResult> => {
    try {
      await store.setConnected(telegramBotFingerprint(botToken));
    } catch {
      return UNAVAILABLE;
    }
    try {
      await bridgeControl.start();
    } catch {
      try {
        await store.setDisconnected();
      } catch {
        /* the bridge is not running either way */
      }
      return UNAVAILABLE;
    }
    botUsername = username;
    emitChange();
    return OK;
  };

  const snapshot = (): TelegramConnectionSnapshotResult => {
    try {
      if (envManaged) return inertSnapshot("env-managed");
      if (!settingsService.isSecretStorageEncrypted()) return inertSnapshot("unsupported");
      const owner = store.ownerSnapshot();
      const approval = projectApproval(owner.approval, currentConversation()?.digest ?? null);
      const projected = parseTelegramConnectionSnapshot({
        state: deriveState(owner, approval),
        botUsername,
        pairing: owner.pairing === null
          ? null
          : { id: owner.pairing.id, accountFingerprint: owner.pairing.accountFingerprint },
        approval,
        pendingCode: owner.pendingCode === null
          ? null
          : {
              id: owner.pendingCode.id,
              expiresAt: owner.pendingCode.expiresAt,
              attemptsRemaining: owner.pendingCode.attemptsRemaining,
            },
        lastErrorCode: owner.lastErrorCode,
      });
      return projected === null ? UNAVAILABLE : Object.freeze({ ok: true as const, snapshot: projected });
    } catch {
      return UNAVAILABLE;
    }
  };

  const connect = async (botToken: string): Promise<TelegramConnectionMutationResult> => {
    if (envManaged) return MANAGED;
    if (!isTelegramBotToken(botToken)) return INPUT_INVALID;
    return await runExclusive(async () => {
      // Probed before any write: an unencryptable host must not receive the
      // token even briefly.
      let encrypted: boolean;
      try {
        encrypted = settingsService.isSecretStorageEncrypted();
      } catch {
        return ENCRYPTION_UNAVAILABLE;
      }
      if (!encrypted) return ENCRYPTION_UNAVAILABLE;

      const previous = readStoredToken();
      try {
        await settingsService.setSecret(SECRET_KEY, botToken);
      } catch (error) {
        return error instanceof SecretEncryptionUnavailableError
          ? ENCRYPTION_UNAVAILABLE
          : UNAVAILABLE;
      }

      const verified = await verifyBot(botToken);
      if (!verified.ok) {
        await restoreSecret(previous);
        await noteError(verified.error);
        return verified;
      }
      const activated = await activate(botToken, verified.username);
      if (isFailure(activated)) {
        await restoreSecret(previous);
        await noteError(activated.error);
      }
      return activated;
    });
  };

  const disconnect = async (): Promise<TelegramConnectionMutationResult> => {
    if (envManaged) return MANAGED;
    return await runExclusive(async () => {
      let secretFailure: TelegramConnectionMutationResult | null = null;
      try {
        await settingsService.deleteSecret(SECRET_KEY);
      } catch (error) {
        // Still tear the rest down: a token that survives is worse when the
        // bridge is also left running.
        secretFailure = error instanceof SecretEncryptionUnavailableError
          ? ENCRYPTION_UNAVAILABLE
          : UNAVAILABLE;
      }
      try {
        await store.setDisconnected();
      } catch {
        return UNAVAILABLE;
      }
      botUsername = null;
      try {
        await bridgeControl.stop("user");
      } catch {
        return UNAVAILABLE;
      }
      emitChange();
      return secretFailure ?? OK;
    });
  };

  const pause = async (): Promise<TelegramConnectionMutationResult> => {
    if (envManaged) return MANAGED;
    return await runExclusive(async () => {
      let paused: boolean;
      try {
        paused = await store.setPaused();
      } catch {
        return UNAVAILABLE;
      }
      if (!paused) return REJECTED;
      try {
        await bridgeControl.stop("user");
      } catch {
        return UNAVAILABLE;
      }
      emitChange();
      return OK;
    });
  };

  const resume = async (): Promise<TelegramConnectionMutationResult> => {
    if (envManaged) return MANAGED;
    return await runExclusive(async () => {
      let encrypted: boolean;
      try {
        encrypted = settingsService.isSecretStorageEncrypted();
      } catch {
        return ENCRYPTION_UNAVAILABLE;
      }
      if (!encrypted) return ENCRYPTION_UNAVAILABLE;
      // Disconnect deletes the token, so a resumable bridge is exactly one that
      // still has a stored credential.
      const botToken = readStoredToken();
      if (botToken === null) return UNAVAILABLE;
      const verified = await verifyBot(botToken);
      if (!verified.ok) {
        await noteError(verified.error);
        return verified;
      }
      const activated = await activate(botToken, verified.username);
      if (isFailure(activated)) await noteError(activated.error);
      return activated;
    });
  };

  /**
   * Boot-time continuation of whatever the owner left connected.
   *
   * A paused, disconnected, or environment-managed store is a no-op, so app
   * start never reaches Telegram on its own. Failures are recorded as the
   * connection's last error rather than surfaced: nobody is at the keyboard.
   */
  const resumeStoredConnection = async (): Promise<void> => {
    if (envManaged) return;
    let desired: TelegramDesiredState;
    try {
      desired = store.desiredState();
    } catch {
      return;
    }
    if (desired !== "connected") return;
    await resume();
  };

  const createPairingCode = async (): Promise<TelegramCreatePairingCodeResult> => {
    if (envManaged) return MANAGED;
    return await runExclusive(async () => {
      // The bot handle is in-memory only, so a code cannot be minted before
      // this activation verified the bot it would point the owner at.
      if (botUsername === null) return UNAVAILABLE;
      const handle = botUsername;
      let connected: boolean;
      try {
        connected = store.desiredState() === "connected";
      } catch {
        return UNAVAILABLE;
      }
      if (!connected) return REJECTED;
      // Minting and digesting both come from the shared pairing-code authority:
      // the polling ingress redeems with the same derivation, and a second one
      // here would make every correct code fail to pair.
      // A freshly minted code always digests, so a throw or a null here is an
      // internal invariant failure, not a state the owner can act on.
      let code: string;
      let codeDigest: string | null;
      try {
        code = mintTelegramPairingCode();
        codeDigest = telegramPairingCodeDigest(code);
      } catch {
        return REJECTED;
      }
      if (codeDigest === null) return REJECTED;
      let minted;
      try {
        minted = await store.createPendingCode({
          codeDigest,
          ttlMs: TELEGRAM_PAIRING_CODE_TTL_MS,
          maxAttempts: PAIRING_CODE_MAX_ATTEMPTS,
        });
      } catch {
        return REJECTED;
      }
      const pairingCode = parseTelegramCreatedPairingCode({
        id: minted.id,
        code,
        expiresAt: minted.expiresAt,
        botUsername: handle,
      });
      if (pairingCode === null) return UNAVAILABLE;
      return Object.freeze({ ok: true as const, pairingCode });
    });
  };

  const revokePairing = async (id: string): Promise<TelegramConnectionMutationResult> => {
    if (envManaged) return MANAGED;
    if (!isTelegramConnectionId(id)) return INPUT_INVALID;
    return await runExclusive(async () => {
      try {
        return await store.revokePairing(id) ? OK : REJECTED;
      } catch {
        return UNAVAILABLE;
      }
    });
  };

  const approveCurrentConversation = async (
    duration?: TelegramApprovalDurationPreset,
  ): Promise<TelegramConnectionMutationResult> => {
    if (envManaged) return MANAGED;
    if (duration !== undefined && !isTelegramApprovalDurationPreset(duration)) return INPUT_INVALID;
    return await runExclusive(async () => {
      // Resolved here, never received: the renderer cannot name a conversation.
      const conversation = currentConversation();
      if (conversation === null) return REJECTED;
      try {
        const approval = await store.createApproval({
          conversationId: conversation.id,
          conversationDigest: conversation.digest,
          ...(duration === undefined ? {} : { ttlMs: APPROVAL_DURATION_MS[duration] }),
        });
        return approval === null ? REJECTED : OK;
      } catch {
        return UNAVAILABLE;
      }
    });
  };

  const revokeApproval = async (id: string): Promise<TelegramConnectionMutationResult> => {
    if (envManaged) return MANAGED;
    if (!isTelegramConnectionId(id)) return INPUT_INVALID;
    return await runExclusive(async () => {
      try {
        return await store.revokeApproval(id) ? OK : REJECTED;
      } catch {
        return UNAVAILABLE;
      }
    });
  };

  return Object.freeze({
    snapshot,
    connect,
    disconnect,
    pause,
    resume,
    resumeStoredConnection,
    createPairingCode,
    revokePairing,
    approveCurrentConversation,
    revokeApproval,
    subscribe(listener: () => void): () => void {
      if (typeof listener !== "function") throw new Error("telegram-connection-service-invalid");
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
}
