/**
 * Telegram's deliberately narrow provider wire boundary.
 *
 * This module owns only Telegram's authenticated webhook shape and its
 * text-only Bot API delivery request. It neither starts an HTTP listener nor
 * decides which Telegram account is paired to a conversation; those remain
 * host-owned lifecycle and authorization concerns.
 */
import { timingSafeEqual } from "node:crypto";
import { performance } from "node:perf_hooks";
import type {
  PlatformBridgeVerifiedEnvelope,
  PlatformBridgeWebhookVerifier,
} from "./platform-bridge-inbound.js";
import type {
  PlatformBridgeDeliveryQueuedMessage,
  PlatformBridgeDeliveryTransport,
  PlatformBridgeDeliveryTransportSendOptions,
  PlatformBridgeOutboundMessage,
} from "./platform-bridge-delivery.js";

const TELEGRAM_SECRET_HEADER = "x-telegram-bot-api-secret-token";
const MAX_TELEGRAM_SECRET_TOKEN_CHARS = 256;
const MAX_TELEGRAM_BOT_TOKEN_CHARS = 256;
const MAX_TELEGRAM_TEXT_CODE_POINTS = 4_096;
const DEFAULT_MIN_TELEGRAM_DELIVERY_INTERVAL_MS = 1_000;
// Telegram FAQ documents an approximate free broadcast limit of 30 messages/s.
const FREE_TELEGRAM_GLOBAL_MESSAGES_PER_SECOND = 30;
const DEFAULT_MIN_TELEGRAM_GLOBAL_INTERVAL_MS = Math.ceil(
  1_000 / FREE_TELEGRAM_GLOBAL_MESSAGES_PER_SECOND,
);
const DEFAULT_TELEGRAM_REQUEST_TIMEOUT_MS = 15_000;
const TELEGRAM_SECRET_TOKEN = /^[A-Za-z0-9_-]{1,256}$/;
// Telegram bot tokens are path material in the Bot API URL. Keep the grammar
// deliberately narrow so configuration can never change the HTTPS endpoint.
const TELEGRAM_BOT_TOKEN = /^[A-Za-z0-9:_-]{1,256}$/;

const ALLOWED_UPDATE_KEYS = new Set(["update_id", "message"]);
// `entities` is harmless metadata which is deliberately ignored; allowing it
// preserves ordinary URL/formatting messages while still rejecting every
// attachment, reply, forward, sender-chat, web-app, and other message form.
const ALLOWED_TEXT_MESSAGE_KEYS = new Set([
  "message_id",
  "date",
  "from",
  "chat",
  "text",
  "entities",
]);

const OUTBOUND_STATUS_TEXT: Readonly<Record<string, string>> = Object.freeze({
  idle: "LVIS: idle",
  running: "LVIS: working",
  "awaiting-local-approval": "LVIS: waiting for local approval",
  "turn-started": "LVIS: working",
  "tool-running": "LVIS: working",
  "tool-completed": "LVIS: tool step completed",
  "tool-failed": "LVIS: tool step failed",
  "compaction-started": "LVIS: organizing context",
  "compaction-completed": "LVIS: context organized",
  "turn-failed": "LVIS: turn failed",
  "turn-completed": "LVIS: completed",
});

const FALLBACK_TEXT = "LVIS: message unavailable";
type TelegramSnapshotMessage = Extract<PlatformBridgeOutboundMessage, { readonly kind: "snapshot" }>;
type TelegramStatusMessage = Extract<PlatformBridgeOutboundMessage, { readonly kind: "status" }>;
const SNAPSHOT_STATUSES = new Set<TelegramSnapshotMessage["status"]>([
  "idle",
  "running",
  "awaiting-local-approval",
]);
const TRANSIENT_STATUSES = new Set<TelegramStatusMessage["status"]>([
  "turn-started",
  "tool-running",
  "tool-completed",
  "compaction-started",
  "compaction-completed",
]);

/** Configuration for Telegram's signed webhook verifier. */
export interface CreateTelegramWebhookVerifierOptions {
  /** Telegram's configured webhook `secret_token`; never logged or persisted here. */
  readonly secretToken: string;
}

/**
 * Verify one Telegram webhook before decoding its body.
 *
 * The fixed secret header is Telegram's webhook authenticity mechanism. Header
 * authentication intentionally happens before even UTF-8/JSON decoding, so an
 * unauthenticated request cannot exercise the parser.
 */
export function createTelegramWebhookVerifier(
  options: CreateTelegramWebhookVerifierOptions,
): PlatformBridgeWebhookVerifier {
  const secretToken = readConfiguredSecretToken(options);
  const expectedSecret = Buffer.from(secretToken, "utf8");

  return Object.freeze({
    verify(request: Readonly<unknown>): PlatformBridgeVerifiedEnvelope | undefined {
      let authenticated = false;
      try {
        const presentedHeader = readSingleTelegramSecretHeader(request);
        authenticated = presentedHeader !== undefined && constantTimeEquals(presentedHeader, expectedSecret);
      } catch {
        authenticated = false;
      }
      // The generic throw is intentional: the core distinguishes an
      // unauthenticated webhook (`verification-failed`) from a correctly
      // authenticated but unsupported Telegram Update (`invalid-envelope`).
      if (!authenticated) throw telegramWebhookVerificationFailure();

      // Do not touch rawBody until the signed header has been authenticated.
      const rawBody = readRawBody(request);
      if (rawBody === undefined) return undefined;
      return parseTelegramTextUpdate(rawBody);
    },
  });
}

/**
 * Verify one Telegram Update that THIS host already fetched over its own
 * authenticated outbound `getUpdates` call.
 *
 * Authenticity here comes from TLS to api.telegram.org plus the bot token on
 * that outbound request — not from a signature over these bytes, because the
 * bytes are host-produced rather than attacker-presented. This is a separate
 * factory on purpose: adding a "skip the header when none is present" branch
 * to `createTelegramWebhookVerifier` would make the loopback webhook listener
 * forgeable by any local process. The shape allow-list is still applied, so a
 * compromised or unexpected Bot API response cannot widen the envelope.
 */
export function createTelegramPollingVerifier(): PlatformBridgeWebhookVerifier {
  return Object.freeze({
    verify(request: Readonly<unknown>): PlatformBridgeVerifiedEnvelope | undefined {
      const rawBody = readRawBody(request);
      if (rawBody === undefined) return undefined;
      return parseTelegramTextUpdate(rawBody);
    },
  });
}

/** A Telegram Bot API destination already paired by the host. */
export interface TelegramDeliveryChannel {
  /** Canonical decimal positive safe integer, never a group/channel id. */
  readonly chatId: string;
  /**
   * Opaque host-only identity minted for one delivery attachment. It never
   * crosses the Telegram wire and fences an old in-flight attachment.
   */
  readonly deliveryLease?: string;
}

/** One pending safe projection entry, exactly matching the generic queue hook. */
export type TelegramDeliveryQueueEntry = PlatformBridgeDeliveryQueuedMessage;

/**
 * Coalesce a pending Telegram queue without looking at a raw conversation
 * timeline. Adjacent text deltas retain their exact order but are packed into
 * Bot API-sized Unicode code-point chunks. Only adjacent transient progress
 * statuses are collapsed; approval and terminal statuses remain visible.
 */
export function coalesceTelegramDeliveryQueue(
  queued: readonly TelegramDeliveryQueueEntry[],
  incoming: TelegramDeliveryQueueEntry,
  maxTextChars: number,
): readonly TelegramDeliveryQueueEntry[] {
  if (!Array.isArray(queued)) {
    throw new TypeError("telegram-delivery-queue-invalid");
  }
  const maxCodePoints = Math.min(
    positiveSafeInteger(maxTextChars, "telegram-delivery-queue-max-text-invalid"),
    MAX_TELEGRAM_TEXT_CODE_POINTS,
  );

  const output: TelegramDeliveryQueueEntry[] = [];
  let pendingText = "";
  let pendingTextCodePoints = 0;
  let pendingTextCursor = 0;
  let pendingStatus: TelegramDeliveryQueueEntry | undefined;

  const flushText = (): void => {
    if (pendingTextCodePoints === 0) return;
    output.push(freezeQueueEntry(pendingTextCursor, {
      kind: "text",
      cursor: pendingTextCursor,
      text: pendingText,
    }));
    pendingText = "";
    pendingTextCodePoints = 0;
  };
  const appendText = (text: string, cursor: number): void => {
    for (let index = 0; index < text.length;) {
      const codePoint = text.codePointAt(index);
      if (codePoint === undefined) break;
      const width = codePoint > 0xffff ? 2 : 1;
      if (!isUnsafeTelegramCodePoint(codePoint) && !(codePoint >= 0xd800 && codePoint <= 0xdfff)) {
        pendingText += text.slice(index, index + width);
        pendingTextCodePoints += 1;
        pendingTextCursor = cursor;
        if (pendingTextCodePoints === maxCodePoints) flushText();
      }
      index += width;
    }
  };
  const flushStatus = (): void => {
    if (pendingStatus === undefined) return;
    output.push(pendingStatus);
    pendingStatus = undefined;
  };

  for (const entry of [...queued, incoming]) {
    const normalized = normalizeTelegramQueueEntry(entry);
    switch (normalized.message.kind) {
      case "text":
        flushStatus();
        appendText(normalized.message.text, normalized.cursor);
        break;
      case "status":
        flushText();
        if (TRANSIENT_STATUSES.has(normalized.message.status)) {
          pendingStatus = normalized;
        } else {
          flushStatus();
          output.push(normalized);
        }
        break;
      case "snapshot":
        flushText();
        flushStatus();
        appendTelegramSnapshot(output, normalized, maxCodePoints);
        break;
    }
  }
  flushText();
  flushStatus();
  return Object.freeze(output);
}
/** Configuration for Telegram's strictly text-only outbound transport. */
export interface CreateTelegramOutboundTransportOptions {
  /** Bot API token. It is used only as validated path material and never logged. */
  readonly botToken: string;
  /** Injectable for tests; defaults to the runtime Fetch implementation. */
  readonly fetch?: typeof globalThis.fetch;
  /** Optional host-owned re-pair/revocation fence checked before wire delivery. */
  readonly isChannelCurrent?: (
    channel: Readonly<TelegramDeliveryChannel>,
    generation: number,
  ) => boolean;
  /** Minimum spacing for calls to one Telegram chat; defaults to one second. */
  readonly minIntervalMs?: number;
  /** Bound one Bot API request so a hung network cannot hold a chat gate forever. */
  readonly requestTimeoutMs?: number;
  /** Injectable clock for deterministic lifecycle tests. */
  readonly now?: () => number;
  /** Injectable delay seam for deterministic lifecycle tests. */
  readonly wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

/**
 * Build one outbound Telegram transport.
 *
 * It accepts only the already-safe projection messages from the generic bridge
 * delivery adapter, renders statuses as fixed text, and sends no Bot API
 * feature that could add rich interaction or reveal local state.
 */
export function createTelegramOutboundTransport(
  options: CreateTelegramOutboundTransportOptions,
): PlatformBridgeDeliveryTransport<TelegramDeliveryChannel> {
  const botToken = readConfiguredBotToken(options);
  const fetchImplementation = options?.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== "function") {
    throw new TypeError("telegram-outbound-fetch-invalid");
  }
  if (options?.isChannelCurrent !== undefined && typeof options.isChannelCurrent !== "function") {
    throw new TypeError("telegram-outbound-current-channel-guard-invalid");
  }
  if (options?.now !== undefined && typeof options.now !== "function") {
    throw new TypeError("telegram-outbound-now-invalid");
  }
  if (options?.wait !== undefined && typeof options.wait !== "function") {
    throw new TypeError("telegram-outbound-wait-invalid");
  }
  const minIntervalMs = positiveSafeInteger(
    options?.minIntervalMs ?? DEFAULT_MIN_TELEGRAM_DELIVERY_INTERVAL_MS,
    "telegram-outbound-min-interval-invalid",
  );
  const requestTimeoutMs = positiveSafeInteger(
    options?.requestTimeoutMs ?? DEFAULT_TELEGRAM_REQUEST_TIMEOUT_MS,
    "telegram-outbound-request-timeout-invalid",
  );
  const endpoint = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const isChannelCurrent = options.isChannelCurrent;
  const now = options.now ?? monotonicNow;
  const wait = options.wait ?? defaultTelegramWait;
  const lastDeliveryAttemptAt = new Map<string, number>();
  let lastGlobalDeliveryAttemptAt: number | undefined;
  const chatTails = new Map<string, Promise<void>>();
  const globalGateState: TelegramDeliveryGateState = { tail: undefined };

  return Object.freeze({
    async send(
      channel: TelegramDeliveryChannel,
      message: PlatformBridgeOutboundMessage,
      sendOptions: PlatformBridgeDeliveryTransportSendOptions,
    ): Promise<void> {
      let releaseChatGate: (() => void) | undefined;
      let releaseGlobalGate: (() => void) | undefined;
      let requestAbort: TelegramRequestAbort | undefined;
      try {
        const chatId = readTelegramChatId(channel);
        if (!isCanonicalTelegramChatId(chatId)) throw telegramDeliveryFailure();
        if (!isAbortSignal(sendOptions?.signal)) throw telegramDeliveryFailure();
        if (!Number.isSafeInteger(sendOptions.generation) || sendOptions.generation < 1) {
          throw telegramDeliveryFailure();
        }

        const chatGate = acquireTelegramChatGate(chatTails, chatId);
        releaseChatGate = chatGate.release;
        await chatGate.previous;
        assertTelegramDeliveryCurrent(channel, sendOptions, isChannelCurrent);

        const previousChatAttemptAt = lastDeliveryAttemptAt.get(chatId);
        if (previousChatAttemptAt !== undefined) {
          const delay = telegramDeliveryDelay(
            previousChatAttemptAt,
            readTelegramNow(now),
            minIntervalMs,
          );
          if (delay > 0) await waitForTelegramDelay(wait, delay, sendOptions.signal);
        }
        assertTelegramDeliveryCurrent(channel, sendOptions, isChannelCurrent);

        // Telegram's free broadcast budget is bot-wide, not just per-chat.
        // Hold this gate only through request launch; a slow response must not
        // unnecessarily serialize unrelated private DMs.
        const globalGate = acquireTelegramGlobalGate(globalGateState);
        releaseGlobalGate = globalGate.release;
        await globalGate.previous;
        assertTelegramDeliveryCurrent(channel, sendOptions, isChannelCurrent);

        if (lastGlobalDeliveryAttemptAt !== undefined) {
          const delay = telegramDeliveryDelay(
            lastGlobalDeliveryAttemptAt,
            readTelegramNow(now),
            DEFAULT_MIN_TELEGRAM_GLOBAL_INTERVAL_MS,
          );
          if (delay > 0) await waitForTelegramDelay(wait, delay, sendOptions.signal);
        }
        assertTelegramDeliveryCurrent(channel, sendOptions, isChannelCurrent);

        const text = telegramOutboundText(message);
        if (text === undefined) throw telegramDeliveryFailure();
        // Mark launch rather than success: a failing Bot API cannot be hammered
        // by a retry loop, and both free-rate budgets use one monotonic sample.
        const launchedAt = readTelegramNow(now);
        lastDeliveryAttemptAt.set(chatId, launchedAt);
        lastGlobalDeliveryAttemptAt = launchedAt;
        requestAbort = createTelegramRequestAbort(sendOptions.signal, requestTimeoutMs);
        let responsePromise: Promise<Response>;
        try {
          responsePromise = fetchImplementation(endpoint, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              chat_id: chatId,
              text,
              link_preview_options: { is_disabled: true },
              protect_content: true,
            }),
            signal: requestAbort.signal,
          });
        } finally {
          releaseGlobalGate?.();
          releaseGlobalGate = undefined;
        }
        const response = await responsePromise;
        requestAbort.dispose();
        requestAbort = undefined;
        if (!(await isSuccessfulTelegramResponse(response))) throw telegramDeliveryFailure();
        assertTelegramDeliveryCurrent(channel, sendOptions, isChannelCurrent);
      } catch {
        // Do not reveal bot token, endpoint, response body, or provider detail
        // through a projection fan-out failure.
        throw telegramDeliveryFailure();
      } finally {
        requestAbort?.dispose();
        releaseGlobalGate?.();
        releaseChatGate?.();
      }
    },
  });
}
function readConfiguredSecretToken(options: unknown): string {
  const secretToken = readOptionString(options, "secretToken");
  if (!isValidTelegramSecretToken(secretToken)) {
    throw new TypeError("telegram-webhook-secret-token-invalid");
  }
  return secretToken;
}

function readConfiguredBotToken(options: unknown): string {
  const botToken = readOptionString(options, "botToken");
  if (!isValidTelegramBotToken(botToken)) {
    throw new TypeError("telegram-outbound-bot-token-invalid");
  }
  return botToken;
}

function readOptionString(options: unknown, key: string): string | undefined {
  if (!isDataRecord(options)) return undefined;
  const value = readOwnDataValue(options, key);
  return typeof value === "string" ? value : undefined;
}

function isValidTelegramSecretToken(value: string | undefined): value is string {
  return value !== undefined
    && value.length <= MAX_TELEGRAM_SECRET_TOKEN_CHARS
    && TELEGRAM_SECRET_TOKEN.test(value);
}

function isValidTelegramBotToken(value: string | undefined): value is string {
  return value !== undefined
    && value.length <= MAX_TELEGRAM_BOT_TOKEN_CHARS
    && TELEGRAM_BOT_TOKEN.test(value);
}

function readSingleTelegramSecretHeader(request: unknown): string | undefined {
  if (!isDataRecord(request)) return undefined;
  const headers = readOwnDataValue(request, "headers");
  if (!isDataRecord(headers)) return undefined;

  let value: string | undefined;
  let count = 0;
  for (const key of Reflect.ownKeys(headers)) {
    if (typeof key !== "string") return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(headers, key);
    if (descriptor === undefined || !("value" in descriptor)) return undefined;
    if (key.toLowerCase() !== TELEGRAM_SECRET_HEADER) continue;
    count += 1;
    // Arrays represent duplicate header lines. A non-string is malformed.
    if (count > 1 || typeof descriptor.value !== "string") return undefined;
    value = descriptor.value;
  }
  return count === 1 ? value : undefined;
}

function constantTimeEquals(presented: string, expected: Buffer): boolean {
  const candidate = Buffer.from(presented, "utf8");
  try {
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  } finally {
    candidate.fill(0);
  }
}

function readRawBody(request: unknown): Uint8Array | undefined {
  if (!isDataRecord(request)) return undefined;
  const rawBody = readOwnDataValue(request, "rawBody");
  return rawBody instanceof Uint8Array ? rawBody : undefined;
}

/**
 * Decode one Telegram Update into the exact envelope the shared ingress core
 * admits, or `undefined` for anything else. Exported so the polling ingress
 * uses the same definition of "a safe Telegram text message" as the webhook
 * path; forking it would let the two ingresses drift.
 */
export function parseTelegramTextUpdate(
  rawBody: Uint8Array,
): PlatformBridgeVerifiedEnvelope | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(rawBody).toString("utf8"));
  } catch {
    return undefined;
  }
  if (!isDataRecord(parsed) || !hasOnlyOwnDataKeys(parsed, ALLOWED_UPDATE_KEYS)) return undefined;

  const updateId = readOwnDataValue(parsed, "update_id");
  const message = readOwnDataValue(parsed, "message");
  if (!isPositiveSafeInteger(updateId) || !isDataRecord(message)) return undefined;
  if (!hasOnlyOwnDataKeys(message, ALLOWED_TEXT_MESSAGE_KEYS)) return undefined;

  const chat = readOwnDataValue(message, "chat");
  const from = readOwnDataValue(message, "from");
  const text = readOwnDataValue(message, "text");
  if (!isDataRecord(chat) || !isDataRecord(from) || !isSafeTelegramText(text)) return undefined;

  const chatId = readOwnDataValue(chat, "id");
  const chatType = readOwnDataValue(chat, "type");
  const senderId = readOwnDataValue(from, "id");
  const senderIsBot = readOwnDataValue(from, "is_bot");
  if (
    chatType !== "private"
    || senderIsBot !== false
    || !isPositiveSafeInteger(chatId)
    || !isPositiveSafeInteger(senderId)
    || chatId !== senderId
  ) {
    return undefined;
  }

  return Object.freeze({
    provider: "telegram",
    deliveryId: String(updateId),
    channelId: String(chatId),
    senderId: String(senderId),
    text,
  });
}

function isSafeTelegramText(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  let codePointCount = 0;
  for (let index = 0; index < value.length;) {
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined || isUnsafeTelegramCodePoint(codePoint)) return false;
    // A lone surrogate is not a Unicode scalar value. Telegram normally cannot
    // send one, but rejecting it preserves the stated Unicode-code-point bound.
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) return false;
    codePointCount += 1;
    if (codePointCount > MAX_TELEGRAM_TEXT_CODE_POINTS) return false;
    index += codePoint > 0xffff ? 2 : 1;
  }
  return codePointCount > 0;
}

function isUnsafeTelegramCodePoint(codePoint: number): boolean {
  return (codePoint >= 0 && codePoint <= 0x08)
    || codePoint === 0x0b
    || codePoint === 0x0c
    || (codePoint >= 0x0e && codePoint <= 0x1f)
    || codePoint === 0x7f;
}

function hasOnlyOwnDataKeys(record: Record<string, unknown>, allowedKeys: ReadonlySet<string>): boolean {
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== "string" || !allowedKeys.has(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (descriptor === undefined || !("value" in descriptor)) return false;
  }
  return true;
}

function isDataRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readOwnDataValue(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function positiveSafeInteger(value: unknown, errorCode: string): number {
  if (!isPositiveSafeInteger(value)) throw new RangeError(errorCode);
  return value;
}

function normalizeTelegramQueueEntry(value: unknown): TelegramDeliveryQueueEntry {
  if (!isDataRecord(value)) throw new TypeError("telegram-delivery-queue-entry-invalid");
  const cursor = readOwnDataValue(value, "cursor");
  const message = readOwnDataValue(value, "message");
  if (typeof cursor !== "number" || !Number.isSafeInteger(cursor) || cursor < 0 || !isDataRecord(message)) {
    throw new TypeError("telegram-delivery-queue-entry-invalid");
  }
  const messageCursor = readOwnDataValue(message, "cursor");
  if (messageCursor !== cursor) throw new TypeError("telegram-delivery-queue-entry-invalid");
  const kind = readOwnDataValue(message, "kind");
  if (kind === "text") {
    const text = readOwnDataValue(message, "text");
    if (typeof text !== "string") throw new TypeError("telegram-delivery-queue-entry-invalid");
    return freezeQueueEntry(cursor, { kind, cursor, text });
  }
  if (kind === "snapshot") {
    const status = readOwnDataValue(message, "status");
    const text = readOwnDataValue(message, "text");
    if (!isTelegramSnapshotStatus(status) || typeof text !== "string") {
      throw new TypeError("telegram-delivery-queue-entry-invalid");
    }
    return freezeQueueEntry(cursor, { kind, cursor, status, text });
  }
  if (kind === "status") {
    const status = readOwnDataValue(message, "status");
    if (!isTelegramStatus(status)) throw new TypeError("telegram-delivery-queue-entry-invalid");
    return freezeQueueEntry(cursor, { kind, cursor, status });
  }
  throw new TypeError("telegram-delivery-queue-entry-invalid");
}

function freezeQueueEntry(
  cursor: number,
  message: PlatformBridgeOutboundMessage,
): TelegramDeliveryQueueEntry {
  return Object.freeze({
    cursor,
    message: Object.freeze({ ...message }) as PlatformBridgeOutboundMessage,
  });
}

function appendTelegramSnapshot(
  output: TelegramDeliveryQueueEntry[],
  entry: TelegramDeliveryQueueEntry,
  maxCodePoints: number,
): void {
  if (entry.message.kind !== "snapshot") return;
  const chunks = telegramTextChunks(entry.message.text, maxCodePoints);
  if (chunks.length === 0) {
    output.push(freezeQueueEntry(entry.cursor, { ...entry.message, text: "" }));
    return;
  }
  const [first, ...rest] = chunks;
  output.push(freezeQueueEntry(entry.cursor, { ...entry.message, text: first ?? "" }));
  for (const text of rest) {
    output.push(freezeQueueEntry(entry.cursor, {
      kind: "text",
      cursor: entry.cursor,
      text,
    }));
  }
}

function telegramTextChunks(value: string, maxCodePoints: number): string[] {
  const chunks: string[] = [];
  let current = "";
  let codePointCount = 0;
  for (let index = 0; index < value.length;) {
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) break;
    const width = codePoint > 0xffff ? 2 : 1;
    if (!isUnsafeTelegramCodePoint(codePoint) && !(codePoint >= 0xd800 && codePoint <= 0xdfff)) {
      current += value.slice(index, index + width);
      codePointCount += 1;
      if (codePointCount === maxCodePoints) {
        chunks.push(current);
        current = "";
        codePointCount = 0;
      }
    }
    index += width;
  }
  if (codePointCount > 0) chunks.push(current);
  return chunks;
}

function isTelegramSnapshotStatus(value: unknown): value is TelegramSnapshotMessage["status"] {
  return typeof value === "string"
    && SNAPSHOT_STATUSES.has(value as TelegramSnapshotMessage["status"]);
}

function isTelegramStatus(value: unknown): value is TelegramStatusMessage["status"] {
  return typeof value === "string"
    && Object.hasOwn(OUTBOUND_STATUS_TEXT, value)
    && value !== "idle"
    && value !== "running";
}

type TelegramDeliveryGate = {
  readonly previous: Promise<void>;
  release(): void;
};

type TelegramDeliveryGateState = {
  tail: Promise<void> | undefined;
};

type TelegramRequestAbort = {
  readonly signal: AbortSignal;
  dispose(): void;
};

function acquireTelegramChatGate(
  chatTails: Map<string, Promise<void>>,
  chatId: string,
): TelegramDeliveryGate {
  return acquireTelegramDeliveryGate(
    chatTails.get(chatId),
    (tail) => chatTails.set(chatId, tail),
    (tail) => {
      if (chatTails.get(chatId) === tail) chatTails.delete(chatId);
    },
  );
}

function acquireTelegramGlobalGate(state: TelegramDeliveryGateState): TelegramDeliveryGate {
  return acquireTelegramDeliveryGate(
    state.tail,
    (tail) => { state.tail = tail; },
    (tail) => {
      if (state.tail === tail) state.tail = undefined;
    },
  );
}

function acquireTelegramDeliveryGate(
  previousTail: Promise<void> | undefined,
  install: (tail: Promise<void>) => void,
  clearIfCurrent: (tail: Promise<void>) => void,
): TelegramDeliveryGate {
  const previous = previousTail ?? Promise.resolve();
  let resolveCurrent: (() => void) | undefined;
  const current = new Promise<void>((resolve) => {
    resolveCurrent = resolve;
  });
  const tail = previous.then(() => current);
  install(tail);
  let released = false;
  return {
    previous,
    release: () => {
      if (released) return;
      released = true;
      resolveCurrent?.();
      clearIfCurrent(tail);
    },
  };
}

function monotonicNow(): number {
  return Math.floor(performance.now());
}

function createTelegramRequestAbort(
  source: AbortSignal,
  timeoutMs: number,
): TelegramRequestAbort {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (source.aborted) abort();
  else source.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, timeoutMs);
  timeout.unref?.();
  let disposed = false;
  return {
    signal: controller.signal,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      clearTimeout(timeout);
      source.removeEventListener("abort", abort);
    },
  };
}

function assertTelegramDeliveryCurrent(
  channel: TelegramDeliveryChannel,
  sendOptions: PlatformBridgeDeliveryTransportSendOptions,
  isChannelCurrent: CreateTelegramOutboundTransportOptions["isChannelCurrent"],
): void {
  if (!isAbortSignal(sendOptions.signal) || sendOptions.signal.aborted) {
    throw telegramDeliveryFailure();
  }
  if (isChannelCurrent !== undefined && !isChannelCurrent(channel, sendOptions.generation)) {
    throw telegramDeliveryFailure();
  }
}

function readTelegramNow(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) throw telegramDeliveryFailure();
  return value;
}

function telegramDeliveryDelay(previousAttemptAt: number, currentTime: number, minIntervalMs: number): number {
  const elapsed = Math.max(0, currentTime - previousAttemptAt);
  return Math.max(0, minIntervalMs - elapsed);
}

function defaultTelegramWait(milliseconds: number, _signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });
}

function waitForTelegramDelay(
  wait: (milliseconds: number, signal: AbortSignal) => Promise<void>,
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.reject(telegramDeliveryFailure());
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error: Error | undefined): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      if (error === undefined) resolve();
      else reject(error);
    };
    const onAbort = (): void => finish(telegramDeliveryFailure());
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve()
      .then(() => wait(milliseconds, signal))
      .then(
        () => finish(undefined),
        () => finish(telegramDeliveryFailure()),
      );
  });
}
function readTelegramChatId(channel: unknown): string | undefined {
  if (!isDataRecord(channel)) return undefined;
  const chatId = readOwnDataValue(channel, "chatId");
  return typeof chatId === "string" ? chatId : undefined;
}

function isCanonicalTelegramChatId(value: string | undefined): value is string {
  if (value === undefined || !/^[1-9]\d{0,15}$/.test(value)) return false;
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 && String(numeric) === value;
}

function isAbortSignal(value: unknown): value is AbortSignal {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { aborted?: unknown; addEventListener?: unknown };
  return typeof candidate.aborted === "boolean" && typeof candidate.addEventListener === "function";
}

function telegramOutboundText(message: unknown): string | undefined {
  if (!isDataRecord(message)) return undefined;
  const kind = readOwnDataValue(message, "kind");
  if (kind === "text") {
    const text = readOwnDataValue(message, "text");
    return typeof text === "string" ? boundedOutboundText(text) || FALLBACK_TEXT : undefined;
  }
  if (kind === "snapshot") {
    const text = readOwnDataValue(message, "text");
    const status = readOwnDataValue(message, "status");
    if (typeof text !== "string" || typeof status !== "string") return undefined;
    return boundedOutboundText(text) || OUTBOUND_STATUS_TEXT[status] || FALLBACK_TEXT;
  }
  if (kind === "status") {
    const status = readOwnDataValue(message, "status");
    return typeof status === "string" ? OUTBOUND_STATUS_TEXT[status] : undefined;
  }
  return undefined;
}

function boundedOutboundText(value: string): string {
  let output = "";
  let codePointCount = 0;
  for (let index = 0; index < value.length && codePointCount < MAX_TELEGRAM_TEXT_CODE_POINTS;) {
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) break;
    const width = codePoint > 0xffff ? 2 : 1;
    if (!isUnsafeTelegramCodePoint(codePoint) && !(codePoint >= 0xd800 && codePoint <= 0xdfff)) {
      output += value.slice(index, index + width);
      codePointCount += 1;
    }
    index += width;
  }
  return output;
}

async function isSuccessfulTelegramResponse(response: unknown): Promise<boolean> {
  if (!response || typeof response !== "object") return false;
  const candidate = response as { ok?: unknown; json?: unknown };
  if (candidate.ok !== true || typeof candidate.json !== "function") return false;
  try {
    const body = await candidate.json();
    return isDataRecord(body) && readOwnDataValue(body, "ok") === true;
  } catch {
    return false;
  }
}

function telegramDeliveryFailure(): Error {
  return new Error("telegram-delivery-failed");
}

function telegramWebhookVerificationFailure(): Error {
  return new Error("telegram-webhook-verification-failed");
}
