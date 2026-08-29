/**
 * Host-only route authority for the Telegram platform bridge.
 *
 * Telegram user and private-chat identifiers stay only in this short-lived
 * main-process runtime.  The only durable value created here is a random
 * domain-specific HMAC key stored through Electron safeStorage; it contains
 * no provider identity, bot token, chat id, or conversation id.
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import { safeStorage } from "electron";
import {
  SafeStorageSecretStore,
  type SafeStorageLike,
  type SecretStore,
} from "../audit/hmac-chain.js";
import type {
  PlatformBridgeInboundAuthorization,
  PlatformBridgeInboundAuthorizer,
  PlatformBridgeVerifiedEnvelope,
} from "./platform-bridge-inbound.js";
import type { PlatformBridgeBinding, PlatformBridgeGuard } from "../shared/chat-origin.js";
import { isTelegramConversationId } from "../shared/telegram-connection.js";
import { hasNonWhitespaceControlChars } from "../shared/display-safe-text.js";
import { isPositiveSafeInteger } from "../shared/safe-integer.js";

export const TELEGRAM_PLATFORM_ACTOR_SECRET_NAME = "telegram-platform-bridge-actor-v1.key";

const ACTOR_SECRET_BYTES = 32;
const ACTOR_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const BOT_FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;
const TELEGRAM_ID_PATTERN = /^[1-9][0-9]{0,15}$/;

const MAX_DELIVERY_ID_CHARS = 256;
const MAX_TEXT_CHARS = 24_000;
const ACTOR_HMAC_DOMAIN = "lvis/telegram-platform-bridge/actor/v1\0";
const ACTOR_KEY_HMAC_DOMAIN = "lvis/telegram-platform-bridge/actor-key/v1\0";
const BINDING_HMAC_DOMAIN = "lvis/telegram-platform-bridge/binding/v1\0";
const CONVERSATION_HASH_DOMAIN = "lvis/telegram-platform-bridge/conversation/v1\0";

/**
 * A single static owner-configured private-DM route. `chatId` is intentionally
 * runtime-only so the outbound Telegram transport can select its destination;
 * it is never written to a receipt, feature namespace, log, or secret store.
 */
export interface TelegramPlatformRoute {
  readonly chatId: string;
  /** Main-process-only target for the safe projection delivery adapter. */
  readonly conversationId: string;
  readonly actorDigest: string;
  /** Preferred route binding field for new lifecycle composition. */
  readonly binding: PlatformBridgeBinding;
  /** Compatibility alias for the bridge core's authorization terminology. */
  readonly bridgeBinding: PlatformBridgeBinding;
}

export interface TelegramPlatformRuntime {
  /** Pass directly to `createPlatformBridgeInboundGateway({ authorize })`. */
  readonly authorize: PlatformBridgeInboundAuthorizer;
  /** Main-process-only target captured at start; never provider-visible or persisted. */
  readonly conversationId: string;
  /** Frozen, main-process-only routes for safe outbound delivery registration. */
  readonly routes: readonly TelegramPlatformRoute[];
  /** Resolve a verified private-DM envelope without mutating route authority. */
  routeForEnvelope(envelope: Readonly<PlatformBridgeVerifiedEnvelope>): TelegramPlatformRoute | null;
  /** Egress fence for a route before opening/sending on its delivery channel. */
  isRouteCurrent(route: TelegramPlatformRoute): boolean;
  /** Revoke every route and every already-admitted bridge guard. */
  dispose(): void;
}

/**
 * Load or mint the sole durable value used by this runtime.
 *
 * Two different corruptions, two different outcomes, and only one of them is a
 * boot failure:
 *
 * - a value that decrypts but has the wrong shape throws, because nothing can
 *   be derived from it and guessing would be worse than refusing;
 * - a value that cannot be decrypted at all does NOT throw. `SecretStore.read`
 *   answers null for it — `SafeStorageSecretStore` quarantines the unreadable
 *   ciphertext first — so this function reaches its mint branch and returns a
 *   FRESH key.
 *
 * The second case is the ordinary one in the field: an OS keychain reset, or
 * the app data restored onto another machine. Every digest derived here then
 * changes, which silently turns a paired owner into a stranger. Callers that
 * hold durable state keyed by these digests must therefore detect the change
 * rather than assume this function is stable across restarts — see
 * {@link createTelegramActorDigester}'s `actorKeyDigest` and the connection
 * store's `reconcileActorKey`.
 */
export function ensureTelegramPlatformActorSecret(secretStore: SecretStore): string {
  if (!isSecretStore(secretStore)) {
    throw new Error("telegram-platform-runtime-secret-store-invalid");
  }
  const existing = secretStore.read(TELEGRAM_PLATFORM_ACTOR_SECRET_NAME, 128);
  if (existing !== null) {
    if (!ACTOR_SECRET_PATTERN.test(existing)) {
      throw new Error("telegram-platform-runtime-actor-secret-invalid");
    }
    return existing;
  }
  const generated = randomBytes(ACTOR_SECRET_BYTES).toString("base64url");
  if (!ACTOR_SECRET_PATTERN.test(generated)) {
    throw new Error("telegram-platform-runtime-actor-secret-generation-invalid");
  }
  secretStore.write(TELEGRAM_PLATFORM_ACTOR_SECRET_NAME, generated);
  return generated;
}

/**
 * Durable pairing/approval authority for the owner-driven runtime.
 *
 * `resolveActiveApproval` is deliberately synchronous. It sits on the egress
 * fence, which runs between the authorization decision and the delivery bind;
 * an await there would let the owner switch conversations in between.
 */
export interface TelegramPairedRouteAuthority {
  /** Opaque digest of the currently paired Telegram account, if any. */
  activePairingActorDigest(): string | null;
  /** Non-null only while a live approval binds this actor to this conversation. */
  resolveActiveApproval(
    actorDigest: string,
    conversationDigest: string,
  ): { readonly scope: string } | null;
  /**
   * The conversation this actor's share is bound to, or null. Durable: it
   * answers the same after a restart. It authorizes nothing on its own — the
   * caller still has to clear `resolveActiveApproval` on its digest.
   */
  resolveBoundConversation(actorDigest: string): string | null;
}

/**
 * Derive the opaque conversation digest an approval is stored under.
 *
 * The owner service persists this when a conversation is shared and the paired
 * runtime recomputes it on every egress check, so both must use this one
 * derivation. It is bot-scoped on purpose: an approval must not survive being
 * re-pointed at a different bot.
 */
export function telegramConversationDigest(
  botFingerprint: string,
  conversationId: string,
): string {
  if (!BOT_FINGERPRINT_PATTERN.test(botFingerprint) || !isTelegramConversationId(conversationId)) {
    throw new Error("telegram-conversation-digest-invalid");
  }
  return hashConversation(botFingerprint, conversationId);
}

/**
 * One bot's account digester, plus the name of the key it derives from.
 *
 * The two travel together because a stored actor digest is only meaningful
 * under the key that produced it. Handing back the digest function alone is
 * what let a rotated key look like a working pairing.
 */
export interface TelegramActorDigester {
  /**
   * Opaque name of the durable actor key currently loadable on this machine.
   * Callers persist it next to the digests it produced and compare on every
   * activation; a mismatch means every digest this digester now yields names a
   * different actor than the stored one.
   */
  readonly actorKeyDigest: string;
  /** Null for anything that is not a canonical Telegram id. */
  digestFor(senderId: string): string | null;
}

/**
 * Derive the opaque account digest for a Telegram sender id.
 *
 * Pairing redemption stores this digest, and the paired runtime recomputes it
 * on every inbound envelope. Exporting one derivation keeps those two from
 * drifting; a second copy would make a correct pairing unresolvable.
 */
export function createTelegramActorDigester(options: {
  readonly botFingerprint: string;
  readonly secretStore?: SecretStore;
  readonly encryption?: SafeStorageLike;
}): TelegramActorDigester {
  if (!options || !BOT_FINGERPRINT_PATTERN.test(options.botFingerprint)) {
    throw new Error("telegram-actor-digester-invalid");
  }
  const secretStore = options.secretStore
    ?? new SafeStorageSecretStore(options.encryption ?? safeStorage);
  const actorSecret = ensureTelegramPlatformActorSecret(secretStore);
  return Object.freeze({
    actorKeyDigest: actorKeyDigestFor(actorSecret),
    digestFor: (senderId: string): string | null =>
      isCanonicalTelegramId(senderId)
        ? actorDigestFor(actorSecret, options.botFingerprint, senderId)
        : null,
  });
}

export interface CreateTelegramPairedPlatformRuntimeOptions {
  readonly botFingerprint: string;
  readonly authority: TelegramPairedRouteAuthority;
  readonly getCurrentConversationId: () => string;
  readonly activationEpoch: number;
  readonly secretStore?: SecretStore;
  readonly encryption?: SafeStorageLike;
}

/**
 * Owner-driven variant of the platform runtime.
 *
 * Unlike the environment-configured runtime, this one holds no allow-list and
 * captures no conversation at construction. Routes are minted lazily from a
 * verified inbound envelope, which is what keeps the raw Telegram chat id off
 * disk: a bot cannot open a chat, so the paired owner always re-supplies it.
 *
 * The conversation a route binds comes from the durable share, never from
 * whatever is on screen when a message arrives. That is the difference between
 * "the phone talks to the conversation you shared" and a surface that follows
 * the owner around; it also survives a restart, which is the case the feature
 * exists for.
 *
 * Currency requires BOTH that the route's own bound conversation still has a
 * live approval AND that this bound conversation is the one on screen. Checking
 * only the second — or resolving approval against the *current* conversation
 * rather than the bound one — leaks the safe projection of a conversation the
 * owner never approved.
 */
export function createTelegramPairedPlatformRuntime(
  options: CreateTelegramPairedPlatformRuntimeOptions,
): TelegramPlatformRuntime {
  if (!options
    || typeof options !== "object"
    || !BOT_FINGERPRINT_PATTERN.test(options.botFingerprint)
    || typeof options.getCurrentConversationId !== "function"
    || !isPositiveSafeInteger(options.activationEpoch)
    || !isRouteAuthority(options.authority)) {
    throw new Error("telegram-paired-platform-runtime-invalid");
  }
  const { authority, botFingerprint, activationEpoch } = options;
  const secretStore = options.secretStore
    ?? new SafeStorageSecretStore(options.encryption ?? safeStorage);
  const actorSecret = ensureTelegramPlatformActorSecret(secretStore);
  const bridgeId = deterministicUuid(actorSecret, "bridge", [botFingerprint]);
  const routesByChatId = new Map<string, TelegramPlatformRoute>();
  const guardsByRoute = new Map<TelegramPlatformRoute, PlatformBridgeGuard>();
  let disposed = false;

  const currentConversationId = (): string | null => {
    try {
      const candidate = options.getCurrentConversationId();
      return isTelegramConversationId(candidate) ? candidate : null;
    } catch {
      return null;
    }
  };

  const approvalFor = (
    actorDigest: string,
    conversationId: string,
  ): { readonly scope: string } | null => {
    try {
      return authority.resolveActiveApproval(
        actorDigest,
        hashConversation(botFingerprint, conversationId),
      );
    } catch {
      return null;
    }
  };

  /**
   * The durable share, re-read per envelope rather than captured, so revoking
   * or re-sharing takes effect on the next message without a restart. The store
   * hands back plaintext only after re-deriving its digest, and `approvalFor`
   * below re-derives it again from this value, so a store that lied here would
   * still resolve no approval.
   */
  const boundConversationId = (actorDigest: string): string | null => {
    try {
      const candidate = authority.resolveBoundConversation(actorDigest);
      return isTelegramConversationId(candidate) ? candidate : null;
    } catch {
      return null;
    }
  };

  // The approval's own scope participates, so revoking and re-approving
  // produces a binding the previous one cannot satisfy.
  const scopeUuid = (chatId: string, approvalScope: string): string =>
    deterministicUuid(actorSecret, "scope", [botFingerprint, chatId, approvalScope]);

  /**
   * Three conditions, each catching a different transition:
   *
   * - the BOUND conversation still has a live approval — revoking the share
   *   stops delivery even while the owner is still looking at that
   *   conversation;
   * - the approval is the same one this route was minted under — revoke and
   *   re-approve must retire the earlier binding rather than let it inherit
   *   the new authority;
   * - the bound conversation is the one on screen — the host runs a single
   *   active session, so anything else is a pause, never a re-point.
   *
   * The third condition is deliberately unchanged: making the binding durable
   * does NOT enable background execution. A message that arrives while the
   * shared conversation is closed is still refused here, and the owner is told
   * so by the control notice; running it in a conversation nobody is watching
   * is a separate decision with its own approval story.
   *
   * That third condition is the ONLY place "one conversation at a time" is
   * enforced. The store does not enforce it and cannot: it holds up to 32
   * grants and `createApproval` merely retires the previous live one, so a
   * document written before that rule, or by hand, can hold several. Reading
   * the store's shape and concluding the limit lives there is the mistake this
   * paragraph exists to prevent — delete the line below and every stored grant
   * becomes independently runnable from a phone, with no other check left.
   */
  const isRouteCurrent = (route: TelegramPlatformRoute): boolean => {
    if (disposed || routesByChatId.get(route.chatId) !== route) return false;
    const approval = approvalFor(route.actorDigest, route.conversationId);
    if (approval === null) return false;
    if (scopeUuid(route.chatId, approval.scope) !== route.binding.scope) return false;
    return currentConversationId() === route.conversationId;
  };

  const mintRoute = (chatId: string, conversationId: string, scope: string): TelegramPlatformRoute => {
    const bridgeBinding = Object.freeze({
      bridgeId,
      bridgeEpoch: activationEpoch,
      routeId: deterministicUuid(actorSecret, "route", [botFingerprint, chatId]),
      routeEpoch: 1,
      scope: scopeUuid(chatId, scope),
    } satisfies PlatformBridgeBinding);
    const route = Object.freeze({
      chatId,
      conversationId,
      actorDigest: actorDigestFor(actorSecret, botFingerprint, chatId),
      binding: bridgeBinding,
      bridgeBinding,
    } satisfies TelegramPlatformRoute);
    routesByChatId.set(chatId, route);
    guardsByRoute.set(route, Object.freeze({
      isCurrent(candidate: PlatformBridgeBinding): boolean {
        try {
          return isRouteCurrent(route) && sameBinding(candidate, route.binding);
        } catch {
          return false;
        }
      },
    }));
    return route;
  };

  const routeForEnvelope = (
    envelope: Readonly<PlatformBridgeVerifiedEnvelope>,
  ): TelegramPlatformRoute | null => {
    const verified = normalizeTelegramEnvelope(envelope);
    if (verified === null || disposed) return null;
    if (verified.channelId !== verified.senderId) return null;

    const actorDigest = actorDigestFor(actorSecret, botFingerprint, verified.senderId);
    let pairedDigest: string | null;
    try {
      pairedDigest = authority.activePairingActorDigest();
    } catch {
      return null;
    }
    if (pairedDigest === null || pairedDigest !== actorDigest) return null;

    // The share decides the conversation, not the screen. Reading the active id
    // here instead is what made the surface follow the owner into conversations
    // they never shared.
    const conversationId = boundConversationId(actorDigest);
    if (conversationId === null) return null;
    const approval = approvalFor(actorDigest, conversationId);
    if (approval === null) return null;

    const existing = routesByChatId.get(verified.senderId);
    // A different bound conversation or a superseded approval must never reuse
    // the previous route object; the caller closes the stale channel.
    const route = existing !== undefined
      && existing.conversationId === conversationId
      && existing.binding.scope === scopeUuid(existing.chatId, approval.scope)
      ? existing
      : mintRoute(verified.senderId, conversationId, approval.scope);
    // Execution semantics are untouched: a durable binding still only runs while
    // its conversation is on screen, so this answers null and the caller sends
    // the paired owner the control notice instead.
    return isRouteCurrent(route) ? route : null;
  };

  const authorize: PlatformBridgeInboundAuthorizer = (envelope) => {
    const route = routeForEnvelope(envelope);
    if (route === null) return null;
    const bridgeGuard = guardsByRoute.get(route);
    if (bridgeGuard === undefined) return null;
    return Object.freeze({
      actorDigest: route.actorDigest,
      conversationDigest: hashConversation(botFingerprint, route.conversationId),
      bridgeBinding: route.binding,
      bridgeGuard,
    } satisfies PlatformBridgeInboundAuthorization);
  };

  return Object.freeze({
    authorize,
    // No conversation is captured up front; the paired owner's first message
    // decides it, and it is re-verified on every send.
    get conversationId(): string {
      return currentConversationId() ?? "";
    },
    get routes(): readonly TelegramPlatformRoute[] {
      return Object.freeze([...routesByChatId.values()]);
    },
    routeForEnvelope,
    isRouteCurrent,
    dispose: () => {
      disposed = true;
      routesByChatId.clear();
    },
  });
}

function isRouteAuthority(value: unknown): value is TelegramPairedRouteAuthority {
  return typeof value === "object"
    && value !== null
    && typeof (value as TelegramPairedRouteAuthority).activePairingActorDigest === "function"
    && typeof (value as TelegramPairedRouteAuthority).resolveActiveApproval === "function"
    && typeof (value as TelegramPairedRouteAuthority).resolveBoundConversation === "function";
}

function normalizeTelegramEnvelope(value: unknown): PlatformBridgeVerifiedEnvelope | null {
  const record = exactDataRecord(value, ["provider", "deliveryId", "channelId", "senderId", "text"]);
  if (record === null
    || record.provider !== "telegram"
    || !isOpaqueIdentifier(record.deliveryId)
    || !isCanonicalTelegramId(record.channelId)
    || !isCanonicalTelegramId(record.senderId)
    || !isSafeText(record.text)) {
    return null;
  }
  return Object.freeze({
    provider: "telegram",
    deliveryId: record.deliveryId,
    channelId: record.channelId,
    senderId: record.senderId,
    text: record.text,
  });
}

function exactDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Readonly<Record<string, unknown>> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== expectedKeys.length || !expectedKeys.every((key) => ownKeys.includes(key))) {
      return null;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const normalized: Record<string, unknown> = {};
    for (const key of expectedKeys) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
        return null;
      }
      normalized[key] = descriptor.value;
    }
    return Object.freeze(normalized);
  } catch {
    return null;
  }
}

function isCanonicalTelegramId(value: unknown): value is string {
  if (typeof value !== "string" || !TELEGRAM_ID_PATTERN.test(value)) return false;
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 && String(numeric) === value;
}

function isOpaqueIdentifier(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_DELIVERY_ID_CHARS
    && value.trim().length > 0
    && !hasNonWhitespaceControlChars(value);
}

function isSafeText(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_TEXT_CHARS
    && value.trim().length > 0
    && !hasNonWhitespaceControlChars(value);
}

/**
 * Name the actor key without carrying it.
 *
 * HMAC-SHA256 under the key itself, over one constant domain string and
 * nothing else. That makes it a fixed point of a PRF keyed by 32 random bytes:
 * irreversible to the key, and with no caller-supplied input anywhere in the
 * message, which is what lets it be persisted in the plaintext connection
 * document beside the pairing it names.
 *
 * The empty message is the collision argument. `actorDigestFor` and
 * `deterministicUuid` key their HMACs with the same secret, so the domains have
 * to be unable to produce a shared message. None of the three is a prefix of
 * another — "…/actor/v1\0" and "…/binding/v1\0" both diverge from
 * "…/actor-key/v1\0" at the character after "actor" — so no concatenation of
 * their fields can reconstruct this one.
 *
 * Deliberately bot-independent: a single key backs every bot identity this
 * desktop pairs, so folding a bot fingerprint in would report a bot change as
 * a key rotation and unpair an account that is still perfectly derivable.
 */
function actorKeyDigestFor(actorSecret: string): string {
  return createHmac("sha256", actorSecret)
    .update(ACTOR_KEY_HMAC_DOMAIN, "utf8")
    .digest("hex");
}

function actorDigestFor(actorSecret: string, botFingerprint: string, userId: string): string {
  return createHmac("sha256", actorSecret)
    .update(ACTOR_HMAC_DOMAIN, "utf8")
    .update(botFingerprint, "utf8")
    .update("\0", "utf8")
    .update(userId, "utf8")
    .digest("hex");
}

function hashConversation(botFingerprint: string, conversationId: string): string {
  return createHash("sha256")
    .update(CONVERSATION_HASH_DOMAIN, "utf8")
    .update(botFingerprint, "utf8")
    .update("\0", "utf8")
    .update(conversationId, "utf8")
    .digest("hex");
}

function deterministicUuid(actorSecret: string, purpose: string, fields: readonly string[]): string {
  const digest = createHmac("sha256", actorSecret)
    .update(BINDING_HMAC_DOMAIN, "utf8")
    .update(purpose, "utf8");
  for (const field of fields) {
    digest.update("\0", "utf8").update(field, "utf8");
  }
  const bytes = digest.digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function sameBinding(left: PlatformBridgeBinding, right: PlatformBridgeBinding): boolean {
  return left.bridgeId === right.bridgeId
    && left.bridgeEpoch === right.bridgeEpoch
    && left.routeId === right.routeId
    && left.routeEpoch === right.routeEpoch
    && left.scope === right.scope;
}

function isSecretStore(value: unknown): value is SecretStore {
  return typeof value === "object"
    && value !== null
    && typeof (value as { read?: unknown }).read === "function"
    && typeof (value as { write?: unknown }).write === "function";
}
