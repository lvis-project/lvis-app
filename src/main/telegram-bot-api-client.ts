/**
 * Minimal outbound Telegram Bot API client for the owner-driven bridge.
 *
 * It deliberately exposes only read/receive calls. LVIS never calls
 * `setWebhook`, `deleteWebhook`, `logOut`, or `close`: those mutate a
 * third-party production bot, and `logOut` locks it out of the cloud Bot API
 * entirely. A webhook that is already registered is reported, never removed.
 *
 * The bot token is request material only. It is never logged, never returned,
 * and never placed in an error message.
 */

/** Telegram caps `getUpdates` at 100; ask for a bounded batch explicitly. */
const DEFAULT_UPDATE_LIMIT = 25;
/**
 * The documented ceiling for the long-poll `timeout` is not stated in the API
 * reference, so stay well under the value Telegram's own server uses.
 */
const DEFAULT_POLL_TIMEOUT_SECONDS = 45;
/** Must exceed the long-poll timeout or every poll would abort mid-flight. */
const DEFAULT_POLL_REQUEST_TIMEOUT_MS = 60_000;
/** Short calls (getMe/getWebhookInfo) do not long-poll. */
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
/** Hard ceiling applied to a response body BEFORE it is parsed. */
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
/** Same narrow grammar the delivery transport uses: the token is URL path material. */
const TELEGRAM_BOT_TOKEN = /^[A-Za-z0-9:_-]{1,256}$/;
const MAX_RETRY_AFTER_SECONDS = 3_600;

export type TelegramBotApiFailureReason =
  /** 401: the token is wrong or was revoked. */
  | "unauthorized"
  /** 409: another receiver owns this bot's updates, or a webhook is set. */
  | "conflict"
  /** 429: flood control; `retryAfterMs` is set when Telegram supplied it. */
  | "rate-limited"
  /** Network failure, timeout, abort, or a non-2xx we cannot classify. */
  | "unreachable"
  /** Well-formed HTTP, unusable payload: oversized, non-JSON, or wrong shape. */
  | "invalid-response";

export type TelegramBotApiResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
    readonly ok: false;
    readonly reason: TelegramBotApiFailureReason;
    readonly retryAfterMs?: number;
  };

export interface TelegramBotIdentity {
  readonly username: string;
}

export interface TelegramWebhookStatus {
  /** True when the owner already pointed this bot at a webhook URL. */
  readonly hasWebhook: boolean;
}

/**
 * One update, kept as the exact bytes handed to the shared ingress core. The
 * re-serialization is deliberate: the core's contract is bytes-in, and it
 * re-applies the same shape allow-list the webhook path uses.
 */
export interface TelegramPolledUpdate {
  readonly updateId: number;
  readonly rawBody: Uint8Array;
}

interface TelegramGetUpdatesInput {
  /**
   * Confirms every update below it. Omit only before the first confirmation.
   * `-1` is Telegram's documented idiom for "the most recent update", used once
   * to seed past a backlog; no other negative value is accepted.
   */
  readonly offset?: number;
  readonly limit?: number;
  readonly timeoutSeconds?: number;
  readonly signal?: AbortSignal;
}

export interface TelegramBotApiClient {
  getMe(signal?: AbortSignal): Promise<TelegramBotApiResult<TelegramBotIdentity>>;
  getWebhookInfo(signal?: AbortSignal): Promise<TelegramBotApiResult<TelegramWebhookStatus>>;
  getUpdates(input?: TelegramGetUpdatesInput): Promise<TelegramBotApiResult<readonly TelegramPolledUpdate[]>>;
}

export interface CreateTelegramBotApiClientOptions {
  /** Process-held credential. Never persisted or logged by this module. */
  readonly botToken: string;
  /** Test-only injection; production uses the global fetch. */
  readonly fetchImplementation?: typeof fetch;
  readonly requestTimeoutMs?: number;
  readonly pollRequestTimeoutMs?: number;
}

export function createTelegramBotApiClient(
  options: CreateTelegramBotApiClientOptions,
): TelegramBotApiClient {
  if (!options || typeof options !== "object") {
    throw new TypeError("telegram-bot-api-client-options-invalid");
  }
  const { botToken } = options;
  if (typeof botToken !== "string" || !TELEGRAM_BOT_TOKEN.test(botToken)) {
    throw new TypeError("telegram-bot-api-client-bot-token-invalid");
  }
  const fetchImplementation = options.fetchImplementation ?? globalThis.fetch;
  if (typeof fetchImplementation !== "function") {
    throw new TypeError("telegram-bot-api-client-fetch-unavailable");
  }
  const requestTimeoutMs = boundedTimeout(
    options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  );
  const pollRequestTimeoutMs = boundedTimeout(
    options.pollRequestTimeoutMs ?? DEFAULT_POLL_REQUEST_TIMEOUT_MS,
  );
  const base = `https://api.telegram.org/bot${botToken}`;

  const call = async (
    method: string,
    body: Record<string, unknown>,
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<TelegramBotApiResult<unknown>> => {
    const abort = composeAbort(signal, timeoutMs);
    try {
      const response = await fetchImplementation(`${base}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: abort.signal,
      });
      const classified = classifyStatus(response);
      if (classified !== undefined) return classified;
      const payload = await readBoundedJson(response);
      if (payload === undefined) return failure("invalid-response");
      if (!isRecord(payload) || payload.ok !== true || !("result" in payload)) {
        return failure("invalid-response");
      }
      return { ok: true, value: payload.result };
    } catch {
      // Never surface the thrown value: a fetch error can carry the request
      // URL, which contains the bot token.
      return failure("unreachable");
    } finally {
      abort.dispose();
    }
  };

  return Object.freeze({
    async getMe(signal?: AbortSignal): Promise<TelegramBotApiResult<TelegramBotIdentity>> {
      const result = await call("getMe", {}, requestTimeoutMs, signal);
      if (!result.ok) return result;
      const value = result.value;
      if (!isRecord(value) || typeof value.username !== "string" || value.username.length === 0) {
        return failure("invalid-response");
      }
      return { ok: true, value: Object.freeze({ username: value.username }) };
    },

    async getWebhookInfo(signal?: AbortSignal): Promise<TelegramBotApiResult<TelegramWebhookStatus>> {
      const result = await call("getWebhookInfo", {}, requestTimeoutMs, signal);
      if (!result.ok) return result;
      const value = result.value;
      if (!isRecord(value)) return failure("invalid-response");
      const url = value.url;
      if (url !== undefined && typeof url !== "string") return failure("invalid-response");
      return { ok: true, value: Object.freeze({ hasWebhook: typeof url === "string" && url.length > 0 }) };
    },

    async getUpdates(
      input: TelegramGetUpdatesInput = {},
    ): Promise<TelegramBotApiResult<readonly TelegramPolledUpdate[]>> {
      const limit = boundedLimit(input.limit ?? DEFAULT_UPDATE_LIMIT);
      const timeoutSeconds = boundedPollTimeout(input.timeoutSeconds ?? DEFAULT_POLL_TIMEOUT_SECONDS);
      if (input.offset !== undefined && !isPollOffset(input.offset)) {
        throw new TypeError("telegram-bot-api-client-offset-invalid");
      }
      const result = await call(
        "getUpdates",
        {
          ...(input.offset === undefined ? {} : { offset: input.offset }),
          limit,
          timeout: timeoutSeconds,
          // Always explicit: omitting it inherits whatever a prior setWebhook
          // left configured on the bot.
          allowed_updates: ["message"],
        },
        timeoutSeconds * 1_000 + pollRequestTimeoutMs,
        input.signal,
      );
      if (!result.ok) return result;
      if (!Array.isArray(result.value)) return failure("invalid-response");
      const updates: TelegramPolledUpdate[] = [];
      for (const entry of result.value) {
        if (!isRecord(entry) || !isPositiveSafeInteger(entry.update_id)) {
          // Without a usable id the offset cannot advance past this batch, so
          // treat the whole response as unusable rather than losing updates.
          return failure("invalid-response");
        }
        let rawBody: Uint8Array;
        try {
          rawBody = Buffer.from(JSON.stringify(entry), "utf8");
        } catch {
          return failure("invalid-response");
        }
        updates.push(Object.freeze({ updateId: entry.update_id, rawBody }));
      }
      return { ok: true, value: Object.freeze(updates) };
    },
  });
}

/**
 * Classify by HTTP status only. Telegram documents that the contents of an
 * error description may change, and the 409 wording exists only in its
 * open-source server, so parsing the description string is not safe.
 */
function classifyStatus(response: Response): TelegramBotApiResult<never> | undefined {
  if (response.ok) return undefined;
  if (response.status === 401) return failure("unauthorized");
  if (response.status === 409) return failure("conflict");
  if (response.status === 429) {
    const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
    return retryAfterMs === undefined
      ? failure("rate-limited")
      : { ok: false, reason: "rate-limited", retryAfterMs };
  }
  return failure("unreachable");
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null || !/^\d{1,7}$/.test(value.trim())) return undefined;
  const seconds = Number(value.trim());
  if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > MAX_RETRY_AFTER_SECONDS) {
    return undefined;
  }
  return seconds * 1_000;
}

/**
 * Read at most `MAX_RESPONSE_BYTES` and parse only then. A polling ingress has
 * no proxy in front of it, so this is the only place the body size is bounded.
 */
async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > MAX_RESPONSE_BYTES) {
    return undefined;
  }
  const body = response.body;
  let text: string;
  if (body === null || typeof body.getReader !== "function") {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_RESPONSE_BYTES) return undefined;
    text = Buffer.from(buffer).toString("utf8");
  } else {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(value);
    }
    text = Buffer.concat(chunks).toString("utf8");
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

interface ComposedAbort {
  readonly signal: AbortSignal;
  dispose(): void;
}

function composeAbort(signal: AbortSignal | undefined, timeoutMs: number): ComposedAbort {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  const forward = () => controller.abort();
  if (signal !== undefined) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", forward, { once: true });
  }
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", forward);
    },
  };
}

function failure(reason: TelegramBotApiFailureReason): { ok: false; reason: TelegramBotApiFailureReason } {
  return Object.freeze({ ok: false as const, reason });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isPollOffset(value: unknown): value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return false;
  return value >= 0 || value === -1;
}

function boundedTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 600_000) {
    throw new RangeError("telegram-bot-api-client-timeout-invalid");
  }
  return value;
}

function boundedLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new RangeError("telegram-bot-api-client-limit-invalid");
  }
  return value;
}

function boundedPollTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 50) {
    throw new RangeError("telegram-bot-api-client-poll-timeout-invalid");
  }
  return value;
}
