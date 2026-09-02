/**
 * Telegram's deliberately narrow provider wire boundary.
 *
 * This module owns only Telegram's authenticated webhook shape and its
 * text-only Bot API delivery request. It neither starts an HTTP listener nor
 * decides which Telegram account is paired to a conversation; those remain
 * host-owned lifecycle and authorization concerns.
 */
import { performance } from "node:perf_hooks";
import type {
  PlatformBridgeVerifiedEnvelope,
  PlatformBridgeWebhookVerifier,
} from "./platform-bridge-inbound.js";
import type {
  PlatformBridgeDeliveryQueuedMessage,
  PlatformBridgeDeliverySendFailure,
  PlatformBridgeDeliveryTransport,
  PlatformBridgeDeliveryTransportSendOptions,
  PlatformBridgeOutboundMessage,
} from "./platform-bridge-delivery.js";
import {
  platformBridgeDeliverySendFailureError,
  readPlatformBridgeDeliverySendFailure,
  safeTrailingText,
} from "./platform-bridge-delivery.js";
import {
  toSafeTurnFailureSummary,
  type TurnFailureCategory,
} from "../engine/shared-conversation-projection.js";
import { isSharedApprovalToolIdentifier } from "../shared/permission-review-status.js";
import { isPositiveSafeInteger, requirePositiveInteger } from "../shared/safe-integer.js";
import { sleep } from "../shared/abortable-deadline.js";
import { TELEGRAM_BOT_TOKEN_PATH_GRAMMAR } from "../shared/telegram-connection.js";

const MAX_TELEGRAM_BOT_TOKEN_CHARS = 256;
/**
 * Telegram measures `sendMessage` text in UTF-16 code units, the same unit its
 * MessageEntity offsets use. Counting Unicode code points instead lets an
 * emoji-heavy reply reach 8,192 units, which the Bot API rejects with
 * 400 "message is too long" — and a rejected send closes the delivery channel.
 */
const MAX_TELEGRAM_TEXT_UTF16_UNITS = 4_096;
const DEFAULT_MIN_TELEGRAM_DELIVERY_INTERVAL_MS = 1_000;
// Telegram FAQ documents an approximate free broadcast limit of 30 messages/s.
const FREE_TELEGRAM_GLOBAL_MESSAGES_PER_SECOND = 30;
const DEFAULT_MIN_TELEGRAM_GLOBAL_INTERVAL_MS = Math.ceil(
  1_000 / FREE_TELEGRAM_GLOBAL_MESSAGES_PER_SECOND,
);
const DEFAULT_TELEGRAM_REQUEST_TIMEOUT_MS = 15_000;
/** Bound on an honored Bot API `retry_after` hint; anything longer is capped. */
const MAX_TELEGRAM_RETRY_AFTER_MS = 30_000;
/** Provider-supplied error descriptions are truncated before they may be logged. */
const MAX_LOGGED_DESCRIPTION_CHARS = 120;
/** Network errno-style codes are the only free-form error detail admitted to a log. */
const SAFE_NETWORK_ERROR_CODE = /^[A-Z][A-Z0-9_]{1,31}$/;

const ALLOWED_UPDATE_KEYS = new Set(["update_id", "message"]);
const ALLOWED_CALLBACK_UPDATE_KEYS = new Set(["update_id", "callback_query"]);
// The exact fields a private-chat button press carries. `message` and
// `chat_instance` are admitted for PRESENCE only — a press on a real card
// always echoes the card message — and are never read: the host keeps its own
// nonce→card record, so nothing routing-relevant is taken from the wire.
const ALLOWED_CALLBACK_QUERY_KEYS = new Set([
  "id",
  "from",
  "message",
  "chat_instance",
  "data",
]);
/**
 * The host mints callback tokens from this grammar and the parser re-applies
 * it on the way back in, so a forged update carrying structured data — JSON,
 * tool names, separators — dies here rather than reaching a handler.
 */
const OPAQUE_CALLBACK_TOKEN = /^[A-Za-z0-9_-]{1,64}$/;
// Metadata the parser never reads, admitted so an ordinary DM is not rejected
// for HOW it was composed:
//
// - `entities` preserves ordinary URL/formatting messages;
// - `reply_to_message` and `quote` are what Telegram's default swipe gesture
//   attaches in a private chat. Rejecting them killed the message rather than
//   ignoring the decoration, and admitting them changes nothing that is read:
//   the sender, chat, and text checks below are untouched, and the quoted
//   material never enters the envelope.
//
// Everything else — attachments, forwards, sender-chat, web-app, and every
// other message form — is still rejected by omission.
const ALLOWED_TEXT_MESSAGE_KEYS = new Set([
  "message_id",
  "date",
  "from",
  "chat",
  "text",
  "entities",
  "reply_to_message",
  "quote",
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

/**
 * Display labels for the closed share-safe failure categories carried on a
 * `turn-failed` status. Same pattern as `OUTBOUND_STATUS_TEXT`: a fixed table
 * keyed by an already-classified value, never a match over raw error text.
 * Typed over the closed union so a new category cannot ship without a label.
 */
const FAILURE_CATEGORY_TEXT: Readonly<Record<TurnFailureCategory, string>> = Object.freeze({
  provider: "provider error",
  auth: "auth error",
  "rate-limit": "rate limit",
  context: "context limit",
  network: "network error",
  model: "model error",
  internal: "internal error",
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

/**
 * Verify one Telegram Update that THIS host already fetched over its own
 * authenticated outbound `getUpdates` call.
 *
 * Authenticity here comes from TLS to api.telegram.org plus the bot token on
 * that outbound request — not from a signature over these bytes, because the
 * bytes are host-produced rather than attacker-presented. The shape allow-list
 * is still applied, so a compromised or unexpected Bot API response cannot
 * widen the envelope.
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
 * Bot API-sized UTF-16 chunks. Only adjacent transient progress statuses are
 * collapsed; approval and terminal statuses remain visible.
 */
export function coalesceTelegramDeliveryQueue(
  queued: readonly TelegramDeliveryQueueEntry[],
  incoming: TelegramDeliveryQueueEntry,
  maxTextChars: number,
): readonly TelegramDeliveryQueueEntry[] {
  if (!Array.isArray(queued)) {
    throw new TypeError("telegram-delivery-queue-invalid");
  }
  const maxUnits = Math.min(
    requirePositiveInteger(maxTextChars, "telegram-delivery-queue-max-text-invalid"),
    MAX_TELEGRAM_TEXT_UTF16_UNITS,
  );

  const output: TelegramDeliveryQueueEntry[] = [];
  let pendingText = "";
  let pendingTextUnits = 0;
  let pendingTextCursor = 0;
  let pendingStatus: TelegramDeliveryQueueEntry | undefined;

  const flushText = (): void => {
    if (pendingTextUnits === 0) return;
    output.push(freezeQueueEntry(pendingTextCursor, {
      kind: "text",
      cursor: pendingTextCursor,
      text: pendingText,
    }));
    pendingText = "";
    pendingTextUnits = 0;
  };
  const appendText = (text: string, cursor: number): void => {
    for (let index = 0; index < text.length;) {
      const codePoint = text.codePointAt(index);
      if (codePoint === undefined) break;
      const width = codePoint > 0xffff ? 2 : 1;
      if (!isUnsafeTelegramCodePoint(codePoint) && !(codePoint >= 0xd800 && codePoint <= 0xdfff)) {
        // Chunk before, never inside, a surrogate pair: a split pair is neither
        // valid text nor within the unit bound the Bot API actually applies.
        if (pendingTextUnits + width > maxUnits) flushText();
        pendingText += text.slice(index, index + width);
        pendingTextUnits += width;
        pendingTextCursor = cursor;
        if (pendingTextUnits === maxUnits) flushText();
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
          const previous = output[output.length - 1];
          if (
            normalized.message.status === "awaiting-local-approval"
            && previous !== undefined
            && previous.message.kind === "status"
            && previous.message.status === "awaiting-local-approval"
            && previous.message.tool === normalized.message.tool
          ) {
            // One approval card is one notice. A repeated identical wait for
            // the same tool keeps the newest cursor instead of sending the
            // same rate-limited message again.
            output[output.length - 1] = normalized;
          } else {
            output.push(normalized);
          }
        }
        break;
      case "snapshot":
        flushText();
        flushStatus();
        // One reconnect snapshot stays one Bot API message. Splitting it would
        // replay the retained window as several rate-limited sends on every
        // inbound message, so the newest bounded window is kept instead.
        output.push(freezeQueueEntry(normalized.cursor, {
          ...normalized.message,
          text: safeTrailingText(normalized.message.text, maxUnits),
        }));
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
  /**
   * Host log sink for SAFE egress failure classification lines. It receives
   * only coarse failure detail (network code, HTTP status, Bot API error_code,
   * a truncated description) — never the bot token, the request URL, the chat
   * id, or any message text.
   */
  readonly log?: (message: string) => void;
}

/**
 * The single classification of every way one Telegram send can fail.
 *
 * `terminal` covers host-side lifecycle and precondition failures that carry
 * no wire detail; the wire kinds carry only the coarse, share-safe fields the
 * policy and log line below are allowed to see. All failure construction goes
 * through `telegramDeliveryFailure`, so retry semantics and log content cannot
 * drift between call sites.
 */
type TelegramSendFailureClass =
  | { readonly kind: "terminal"; readonly code: TelegramTerminalSendFailureCode }
  | { readonly kind: "network"; readonly networkCode?: string }
  | { readonly kind: "timeout" }
  | {
    readonly kind: "response";
    readonly httpStatus?: number;
    readonly apiErrorCode?: number;
    readonly description?: string;
    readonly retryAfterMs?: number;
  };

type TelegramTerminalSendFailureCode =
  | "invalid-destination"
  | "stale-channel"
  | "aborted"
  | "clock-invalid"
  | "unrenderable-message"
  | "internal-error";

/**
 * The one failure chokepoint: map a classification to the generic delivery
 * failure contract (transient or not, bounded retry-after), emit at most one
 * safe log line, and mint the single generic error the projection fan-out may
 * observe. The error message is always `telegram-delivery-failed`.
 */
function telegramDeliveryFailure(
  classification: TelegramSendFailureClass,
  log?: (message: string) => void,
): Error {
  const line = formatTelegramSendFailureLog(classification);
  if (line !== undefined) {
    try {
      log?.(line);
    } catch {
      // A log sink failure must not change delivery behavior.
    }
  }
  return platformBridgeDeliverySendFailureError(
    "telegram-delivery-failed",
    telegramSendFailurePolicy(classification),
  );
}

/** One policy table: which failures are transient, and their kebab-case reason. */
function telegramSendFailurePolicy(
  classification: TelegramSendFailureClass,
): PlatformBridgeDeliverySendFailure {
  switch (classification.kind) {
    case "terminal":
      return { transient: false, reason: classification.code };
    case "network":
      return { transient: true, reason: "network" };
    case "timeout":
      return { transient: true, reason: "timeout" };
    case "response": {
      const code = classification.apiErrorCode ?? classification.httpStatus;
      const transient = code === 429 || (code !== undefined && code >= 500 && code <= 599);
      const reason = classification.apiErrorCode !== undefined
        ? `api-${classification.apiErrorCode}`
        : classification.httpStatus !== undefined
          ? `http-${classification.httpStatus}`
          : "invalid-response";
      return {
        transient,
        reason,
        ...(transient && classification.retryAfterMs !== undefined
          ? { retryAfterMs: classification.retryAfterMs }
          : {}),
      };
    }
  }
}

/**
 * One log formatter for wire failures. Terminal classifications return
 * `undefined`: they carry no wire detail, and their reason code still reaches
 * the bridge log through the delivery adapter's close-reason callback.
 */
function formatTelegramSendFailureLog(
  classification: TelegramSendFailureClass,
): string | undefined {
  switch (classification.kind) {
    case "terminal":
      return undefined;
    case "network":
      return `[telegram-egress] sendMessage failed: network error${
        classification.networkCode !== undefined ? ` (${classification.networkCode})` : ""
      }`;
    case "timeout":
      return "[telegram-egress] sendMessage failed: request timeout";
    case "response":
      return `[telegram-egress] sendMessage rejected: http_status=${classification.httpStatus ?? "unknown"}${
        classification.apiErrorCode !== undefined ? ` error_code=${classification.apiErrorCode}` : ""
      }${
        classification.description !== undefined ? ` description="${classification.description}"` : ""
      }${
        classification.retryAfterMs !== undefined ? ` retry_after_ms=${classification.retryAfterMs}` : ""
      }`;
  }
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
  if (options?.log !== undefined && typeof options.log !== "function") {
    throw new TypeError("telegram-outbound-log-invalid");
  }
  const minIntervalMs = requirePositiveInteger(
    options?.minIntervalMs ?? DEFAULT_MIN_TELEGRAM_DELIVERY_INTERVAL_MS,
    "telegram-outbound-min-interval-invalid",
  );
  const requestTimeoutMs = requirePositiveInteger(
    options?.requestTimeoutMs ?? DEFAULT_TELEGRAM_REQUEST_TIMEOUT_MS,
    "telegram-outbound-request-timeout-invalid",
  );
  const endpoint = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const isChannelCurrent = options.isChannelCurrent;
  const now = options.now ?? monotonicNow;
  const wait = options.wait ?? sleep;
  const log = options.log;
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
        if (
          !isCanonicalTelegramChatId(chatId)
          || !isAbortSignal(sendOptions?.signal)
          || !Number.isSafeInteger(sendOptions.generation)
          || sendOptions.generation < 1
        ) {
          throw telegramDeliveryFailure({ kind: "terminal", code: "invalid-destination" });
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
        if (text === undefined) {
          throw telegramDeliveryFailure({ kind: "terminal", code: "unrenderable-message" });
        }
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
        let response: Response;
        try {
          response = await responsePromise;
        } catch (error) {
          // A channel-driven abort is host lifecycle; only a timer expiry on
          // this request's own controller is a wire timeout worth reporting.
          if (sendOptions.signal.aborted) {
            throw telegramDeliveryFailure({ kind: "terminal", code: "aborted" });
          }
          if (requestAbort?.signal.aborted === true) {
            throw telegramDeliveryFailure({ kind: "timeout" }, log);
          }
          const networkCode = readSafeNetworkErrorCode(error);
          throw telegramDeliveryFailure(
            { kind: "network", ...(networkCode !== undefined ? { networkCode } : {}) },
            log,
          );
        }
        requestAbort.dispose();
        requestAbort = undefined;
        const responseFailure = await classifyTelegramSendResponse(response);
        if (responseFailure !== undefined) throw telegramDeliveryFailure(responseFailure, log);
        assertTelegramDeliveryCurrent(channel, sendOptions, isChannelCurrent);
      } catch (error) {
        // Every classified failure re-throws unchanged; anything else stays
        // one generic error so a projection fan-out failure can never reveal
        // the bot token, the endpoint, a response body, or provider detail.
        if (readPlatformBridgeDeliverySendFailure(error) !== undefined) throw error;
        throw telegramDeliveryFailure({ kind: "terminal", code: "internal-error" });
      } finally {
        requestAbort?.dispose();
        releaseGlobalGate?.();
        releaseChatGate?.();
      }
    },
  });
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

function isValidTelegramBotToken(value: string | undefined): value is string {
  return value !== undefined
    && value.length <= MAX_TELEGRAM_BOT_TOKEN_CHARS
    && TELEGRAM_BOT_TOKEN_PATH_GRAMMAR.test(value);
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

/**
 * One verified inline-keyboard press, reduced to the three facts the host
 * needs: which query to acknowledge, who pressed, and the opaque token the
 * host minted. Deliberately NOT a `PlatformBridgeVerifiedEnvelope`: a press is
 * a decision signal, never conversation input, so it must not be submittable
 * through the shared ingress gateway.
 */
export interface TelegramCallbackQueryEnvelope {
  readonly provider: "telegram";
  /** Provider-issued id, echoed back verbatim to `answerCallbackQuery`. */
  readonly callbackQueryId: string;
  readonly senderId: string;
  /** Opaque host-minted token; the grammar admits nothing structured. */
  readonly data: string;
}

/**
 * Decode one Telegram `callback_query` update, or `undefined` for anything
 * else. Same posture as {@link parseTelegramTextUpdate} and applied at the
 * same ingress parse point: a strict key allow-list, fail-closed on every
 * unknown shape, and nothing free-form admitted — the callback data must match
 * the host's own opaque token grammar.
 */
export function parseTelegramCallbackQueryUpdate(
  rawBody: Uint8Array,
): TelegramCallbackQueryEnvelope | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(rawBody).toString("utf8"));
  } catch {
    return undefined;
  }
  if (!isDataRecord(parsed) || !hasOnlyOwnDataKeys(parsed, ALLOWED_CALLBACK_UPDATE_KEYS)) {
    return undefined;
  }
  const updateId = readOwnDataValue(parsed, "update_id");
  const callbackQuery = readOwnDataValue(parsed, "callback_query");
  if (!isPositiveSafeInteger(updateId) || !isDataRecord(callbackQuery)) return undefined;
  if (!hasOnlyOwnDataKeys(callbackQuery, ALLOWED_CALLBACK_QUERY_KEYS)) return undefined;

  const callbackQueryId = readOwnDataValue(callbackQuery, "id");
  const from = readOwnDataValue(callbackQuery, "from");
  const data = readOwnDataValue(callbackQuery, "data");
  if (
    typeof callbackQueryId !== "string"
    || !OPAQUE_CALLBACK_TOKEN.test(callbackQueryId)
    || typeof data !== "string"
    || !OPAQUE_CALLBACK_TOKEN.test(data)
    || !isDataRecord(from)
  ) {
    return undefined;
  }
  const senderId = readOwnDataValue(from, "id");
  const senderIsBot = readOwnDataValue(from, "is_bot");
  if (senderIsBot !== false || !isPositiveSafeInteger(senderId)) return undefined;

  return Object.freeze({
    provider: "telegram",
    callbackQueryId,
    senderId: String(senderId),
    data,
  });
}

function isSafeTelegramText(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  // `String.length` already is the UTF-16 unit count Telegram itself bounds.
  if (value.length > MAX_TELEGRAM_TEXT_UTF16_UNITS) return false;
  for (let index = 0; index < value.length;) {
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined || isUnsafeTelegramCodePoint(codePoint)) return false;
    // A lone surrogate is not a Unicode scalar value. Telegram normally cannot
    // send one, but rejecting it keeps the decoded envelope well formed.
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) return false;
    index += codePoint > 0xffff ? 2 : 1;
  }
  return true;
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
    // A failure summary that fails re-validation is dropped, not fatal: the
    // bare status still reaches the reader.
    const failure = toSafeTurnFailureSummary(readOwnDataValue(message, "failure"));
    // Same drop-not-fatal rule for the approval tool identifier: it is only
    // admitted on the approval wait status and against the one shared grammar.
    const tool = readOwnDataValue(message, "tool");
    const safeTool = status === "awaiting-local-approval" && isSharedApprovalToolIdentifier(tool)
      ? tool
      : undefined;
    return freezeQueueEntry(cursor, {
      kind,
      cursor,
      status,
      ...(failure === undefined ? {} : { failure: Object.freeze(failure) }),
      ...(safeTool === undefined ? {} : { tool: safeTool }),
    });
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
    throw telegramDeliveryFailure({ kind: "terminal", code: "aborted" });
  }
  if (isChannelCurrent !== undefined && !isChannelCurrent(channel, sendOptions.generation)) {
    throw telegramDeliveryFailure({ kind: "terminal", code: "stale-channel" });
  }
}

function readTelegramNow(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw telegramDeliveryFailure({ kind: "terminal", code: "clock-invalid" });
  }
  return value;
}

function telegramDeliveryDelay(previousAttemptAt: number, currentTime: number, minIntervalMs: number): number {
  const elapsed = Math.max(0, currentTime - previousAttemptAt);
  return Math.max(0, minIntervalMs - elapsed);
}

function waitForTelegramDelay(
  wait: (milliseconds: number, signal: AbortSignal) => Promise<void>,
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(telegramDeliveryFailure({ kind: "terminal", code: "aborted" }));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error: Error | undefined): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      if (error === undefined) resolve();
      else reject(error);
    };
    const onAbort = (): void => finish(telegramDeliveryFailure({ kind: "terminal", code: "aborted" }));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve()
      .then(() => wait(milliseconds, signal))
      .then(
        () => finish(undefined),
        () => finish(telegramDeliveryFailure({ kind: "terminal", code: "aborted" })),
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
    const statusText = typeof status === "string" ? OUTBOUND_STATUS_TEXT[status] : undefined;
    if (statusText === undefined) return undefined;
    const detail = telegramFailureText(readOwnDataValue(message, "failure"))
      ?? telegramApprovalToolText(status, readOwnDataValue(message, "tool"));
    if (detail === undefined) return statusText;
    return boundedOutboundText(`${statusText} — ${detail}`) || statusText;
  }
  return undefined;
}

/**
 * Render `<category>: <short summary>` from an already-safe failure summary,
 * or `undefined` (fail closed to the bare status text) for anything else. The
 * shared fail-closed sanitizer is the one validation authority; this function
 * only adds the display label lookup.
 */
function telegramFailureText(value: unknown): string | undefined {
  const failure = toSafeTurnFailureSummary(value);
  if (failure === undefined) return undefined;
  return `${FAILURE_CATEGORY_TEXT[failure.category]}: ${failure.summary}`;
}

/**
 * Render `tool <identifier> (waiting for approval)` for the approval wait, or
 * `undefined` (fail closed to the bare status text) for anything else. The
 * shared grammar predicate is the one validation authority; this function
 * only adds the display template. It deliberately does not say WHERE to
 * approve: the desk card is always live, and when the remote-approval
 * coordinator holds a current route it follows up with its own button card.
 */
function telegramApprovalToolText(status: unknown, tool: unknown): string | undefined {
  if (status !== "awaiting-local-approval" || !isSharedApprovalToolIdentifier(tool)) {
    return undefined;
  }
  return `tool ${tool} (waiting for approval)`;
}

/** Last bound before the wire: Telegram rejects the whole send past this. */
function boundedOutboundText(value: string): string {
  let output = "";
  let unitCount = 0;
  for (let index = 0; index < value.length && unitCount < MAX_TELEGRAM_TEXT_UTF16_UNITS;) {
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) break;
    const width = codePoint > 0xffff ? 2 : 1;
    if (!isUnsafeTelegramCodePoint(codePoint) && !(codePoint >= 0xd800 && codePoint <= 0xdfff)) {
      if (unitCount + width > MAX_TELEGRAM_TEXT_UTF16_UNITS) break;
      output += value.slice(index, index + width);
      unitCount += width;
    }
    index += width;
  }
  return output;
}

/**
 * Turn one Bot API response into the response classification, or `undefined`
 * on success. It reads only coarse, share-safe fields: the HTTP status, the
 * Bot API `error_code`, a defensively truncated `description`, and a bounded
 * `retry_after` hint. The response body is never propagated whole.
 */
async function classifyTelegramSendResponse(
  response: unknown,
): Promise<Extract<TelegramSendFailureClass, { kind: "response" }> | undefined> {
  const candidate = response && typeof response === "object"
    ? response as { ok?: unknown; status?: unknown; json?: unknown }
    : undefined;
  let body: unknown;
  if (candidate !== undefined && typeof candidate.json === "function") {
    try {
      body = await (candidate.json as () => Promise<unknown>).call(response);
    } catch {
      body = undefined;
    }
  }
  const bodyRecord = isDataRecord(body) ? body : undefined;
  if (candidate?.ok === true && bodyRecord !== undefined && readOwnDataValue(bodyRecord, "ok") === true) {
    return undefined;
  }
  const httpStatus = readHttpLikeCode(candidate?.status);
  const apiErrorCode = bodyRecord !== undefined
    ? readHttpLikeCode(readOwnDataValue(bodyRecord, "error_code"))
    : undefined;
  const description = bodyRecord !== undefined
    ? safeLoggedDescription(readOwnDataValue(bodyRecord, "description"))
    : undefined;
  const parameters = bodyRecord !== undefined ? readOwnDataValue(bodyRecord, "parameters") : undefined;
  const retryAfter = isDataRecord(parameters) ? readOwnDataValue(parameters, "retry_after") : undefined;
  const retryAfterMs = typeof retryAfter === "number" && Number.isSafeInteger(retryAfter) && retryAfter >= 0
    ? Math.min(retryAfter * 1_000, MAX_TELEGRAM_RETRY_AFTER_MS)
    : undefined;
  return {
    kind: "response",
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    ...(apiErrorCode !== undefined ? { apiErrorCode } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
}

/** Bot API `error_code` mirrors HTTP status grammar; anything else is dropped. */
function readHttpLikeCode(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined;
}

/**
 * Reduce a provider-supplied description to one short printable line: control
 * characters and quotes are dropped, and the length is hard-capped so a
 * hostile description cannot flood or restructure the log.
 */
function safeLoggedDescription(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  let output = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) break;
    if (isUnsafeTelegramCodePoint(codePoint) || codePoint === 0x09 || codePoint === 0x0a
      || codePoint === 0x0d || codePoint === 0x22) {
      continue;
    }
    output += character;
    if (output.length >= MAX_LOGGED_DESCRIPTION_CHARS) break;
  }
  return output.length === 0 ? undefined : output;
}

/**
 * Extract only an errno-style code (for example a refused or reset connection
 * constant) from a network failure. Error messages are never read: a runtime
 * network error message can embed the request URL, which embeds the token.
 */
function readSafeNetworkErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== null && typeof current === "object"; depth += 1) {
    const candidate = current as { code?: unknown; cause?: unknown };
    if (typeof candidate.code === "string" && SAFE_NETWORK_ERROR_CODE.test(candidate.code)) {
      return candidate.code;
    }
    current = candidate.cause;
  }
  return undefined;
}
