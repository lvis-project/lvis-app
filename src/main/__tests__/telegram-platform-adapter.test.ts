import { describe, expect, it, vi } from "vitest";
import type {
  PlatformBridgeDeliveryTransportSendOptions,
  PlatformBridgeOutboundMessage,
} from "../platform-bridge-delivery.js";
import {
  coalesceTelegramDeliveryQueue,
  createTelegramOutboundTransport,
  createTelegramWebhookVerifier,
  type TelegramDeliveryChannel,
  type TelegramDeliveryQueueEntry,
} from "../telegram-platform-adapter.js";

const SECRET = "telegram_webhook-secret_123";
const BOT_TOKEN = "123456:BOT_TOKEN-safe_123";
const SECRET_HEADER = "x-telegram-bot-api-secret-token";

function update(): Record<string, unknown> {
  return {
    update_id: 123,
    message: {
      message_id: 456,
      date: 1_700_000_000,
      from: { id: 42, is_bot: false, first_name: "Owner" },
      chat: { id: 42, type: "private", first_name: "Owner" },
      text: "safe telegram text",
    },
  };
}

function signedRequest(body: unknown, headers: Record<string, unknown> = { [SECRET_HEADER]: SECRET }) {
  return {
    rawBody: Buffer.from(JSON.stringify(body), "utf8"),
    headers,
  } as unknown as Parameters<ReturnType<typeof createTelegramWebhookVerifier>["verify"]>[0];
}

function sendOptions(): PlatformBridgeDeliveryTransportSendOptions {
  return { signal: new AbortController().signal, generation: 1 };
}

function successfulFetch() {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
}

function coalesceQueue(
  entries: readonly TelegramDeliveryQueueEntry[],
): readonly TelegramDeliveryQueueEntry[] {
  return entries.reduce<readonly TelegramDeliveryQueueEntry[]>(
    (queued, incoming) => coalesceTelegramDeliveryQueue(queued, incoming, 4_096),
    [],
  );
}

describe("Telegram platform adapter", () => {
  it("authenticates the one case-insensitive secret header before parsing and maps only a simple private text update", () => {
    const verifier = createTelegramWebhookVerifier({ secretToken: SECRET });

    expect(verifier.verify(signedRequest(update(), {
      "X-Telegram-Bot-Api-Secret-Token": SECRET,
      "content-type": "application/json",
    }))).toEqual({
      provider: "telegram",
      deliveryId: "123",
      channelId: "42",
      senderId: "42",
      text: "safe telegram text",
    });

    const unauthenticated = Object.create(null) as Record<string, unknown>;
    Object.defineProperties(unauthenticated, {
      headers: { enumerable: true, value: { [SECRET_HEADER]: "wrong" } },
      rawBody: {
        enumerable: true,
        get: () => {
          throw new Error("raw body must not be read before authentication");
        },
      },
    });
    expect(() => verifier.verify(unauthenticated as unknown as Parameters<ReturnType<typeof createTelegramWebhookVerifier>["verify"]>[0])).toThrow("telegram-webhook-verification-failed");
    expect(verifier.verify(signedRequest("not-json", { [SECRET_HEADER]: SECRET }))).toBeUndefined();
  });

  it("rejects missing, malformed, and duplicate Telegram secret headers", () => {
    const verifier = createTelegramWebhookVerifier({ secretToken: SECRET });
    const body = update();

    expect(() => verifier.verify(signedRequest(body, {}))).toThrow("telegram-webhook-verification-failed");
    expect(() => verifier.verify(signedRequest(body, { [SECRET_HEADER]: [SECRET] }))).toThrow("telegram-webhook-verification-failed");
    expect(() => verifier.verify(signedRequest(body, {
      [SECRET_HEADER]: SECRET,
      "X-Telegram-Bot-Api-Secret-Token": SECRET,
    }))).toThrow("telegram-webhook-verification-failed");
    expect(() => verifier.verify(signedRequest(body, { [SECRET_HEADER]: `${SECRET},${SECRET}` }))).toThrow("telegram-webhook-verification-failed");
    expect(() => verifier.verify(signedRequest(body, { [SECRET_HEADER]: "wrong" }))).toThrow("telegram-webhook-verification-failed");
  });

  it("ignores reply decoration instead of killing the message that carries it", () => {
    const verifier = createTelegramWebhookVerifier({ secretToken: SECRET });
    // Swipe-to-reply is Telegram's default gesture in a DM. The parser never
    // reads these fields, so rejecting them discarded a perfectly ordinary
    // message for HOW it was composed, with no containment gain.
    for (const decorate of [
      (candidate: Record<string, any>) => { candidate.message.reply_to_message = { message_id: 7 }; },
      (candidate: Record<string, any>) => { candidate.message.quote = { text: "earlier" }; },
    ]) {
      const candidate = structuredClone(update()) as Record<string, any>;
      decorate(candidate);
      const envelope = verifier.verify(signedRequest(candidate));
      expect(envelope).toBeDefined();
      // The decoration is metadata only: nothing from it enters the envelope.
      expect(JSON.stringify(envelope)).not.toContain("earlier");
    }
  });

  it("fails closed for every non-text or non-private message form", () => {
    const verifier = createTelegramWebhookVerifier({ secretToken: SECRET });
    const rejected: readonly [string, (candidate: Record<string, any>) => void][] = [
      ["another Update form", (candidate) => { candidate.edited_message = candidate.message; }],
      ["group chat", (candidate) => { candidate.message.chat.type = "group"; }],
      ["bot sender", (candidate) => { candidate.message.from.is_bot = true; }],
      ["sender chat", (candidate) => { candidate.message.sender_chat = { id: 42 }; }],
      ["forward", (candidate) => { candidate.message.forward_origin = {}; }],
      ["web app payload", (candidate) => { candidate.message.web_app_data = {}; }],
      ["photo", (candidate) => { candidate.message.photo = []; }],
      ["document", (candidate) => { candidate.message.document = {}; }],
      ["caption", (candidate) => { candidate.message.caption = "not text"; }],
    ];

    for (const [_name, mutate] of rejected) {
      const candidate = structuredClone(update()) as Record<string, any>;
      mutate(candidate);
      expect(verifier.verify(signedRequest(candidate))).toBeUndefined();
    }
  });

  it("enforces safe positive direct-message identifiers and text UTF-16 unit bounds", () => {
    const verifier = createTelegramWebhookVerifier({ secretToken: SECRET });
    const rejected: readonly [string, (candidate: Record<string, any>) => void][] = [
      ["zero update id", (candidate) => { candidate.update_id = 0; }],
      ["unsafe update id", (candidate) => { candidate.update_id = Number.MAX_SAFE_INTEGER + 1; }],
      ["zero chat id", (candidate) => { candidate.message.chat.id = 0; }],
      ["mismatched private sender", (candidate) => { candidate.message.from.id = 43; }],
      ["empty text", (candidate) => { candidate.message.text = ""; }],
      ["C0 control", (candidate) => { candidate.message.text = "before\u0000after"; }],
      ["DEL", (candidate) => { candidate.message.text = "before\u007fafter"; }],
      ["overlong BMP text", (candidate) => { candidate.message.text = "a".repeat(4_097); }],
      // Telegram counts UTF-16 units, so one emoji spends two of the 4,096.
      ["one emoji past the unit bound", (candidate) => { candidate.message.text = "😀".repeat(2_049); }],
      ["a code-point-sized emoji message", (candidate) => { candidate.message.text = "😀".repeat(4_096); }],
    ];

    for (const [_name, mutate] of rejected) {
      const candidate = structuredClone(update()) as Record<string, any>;
      mutate(candidate);
      expect(verifier.verify(signedRequest(candidate))).toBeUndefined();
    }

    const boundary = structuredClone(update()) as Record<string, any>;
    boundary.message.text = "😀".repeat(2_048);
    expect(boundary.message.text).toHaveLength(4_096);
    expect(verifier.verify(signedRequest(boundary))).toMatchObject({ text: boundary.message.text });

    const whitespace = structuredClone(update()) as Record<string, any>;
    whitespace.message.text = "safe\ntext\tstill allowed";
    expect(verifier.verify(signedRequest(whitespace))).toMatchObject({ text: whitespace.message.text });
  });

  it("validates secret and bot-token configuration without accepting URL-changing token material", () => {
    for (const secretToken of ["", "bad secret", "bad/secret", "x".repeat(257)]) {
      expect(() => createTelegramWebhookVerifier({ secretToken })).toThrow("telegram-webhook-secret-token-invalid");
    }
    for (const botToken of ["", "bad token", "bad/path", "x".repeat(257)]) {
      expect(() => createTelegramOutboundTransport({ botToken })).toThrow("telegram-outbound-bot-token-invalid");
    }
    expect(() => createTelegramOutboundTransport({
      botToken: BOT_TOKEN,
      fetch: 1 as unknown as typeof globalThis.fetch,
    })).toThrow("telegram-outbound-fetch-invalid");
  });

  it("sends only Telegram's safe text payload, composes an AbortSignal, and truncates by UTF-16 unit", async () => {
    const fetchSpy = successfulFetch();
    const transport = createTelegramOutboundTransport({
      botToken: BOT_TOKEN,
      fetch: fetchSpy as unknown as typeof globalThis.fetch,
    });
    const controller = new AbortController();

    await transport.send(
      { chatId: "42" },
      { kind: "text", cursor: 1, text: "😀".repeat(4_097) },
      { signal: controller.signal, generation: 1 },
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] ?? [undefined, undefined];
    expect(url).toBe(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`);
    expect(init).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(String(init?.body));
    // 2,048 emoji are already Telegram's whole 4,096-unit budget. Sending
    // 4,096 of them is 8,192 units and fails with 400 "message is too long",
    // which closes the delivery channel and loses the reply.
    expect(String(body.text)).toHaveLength(4_096);
    expect(body).toEqual({
      chat_id: "42",
      text: "😀".repeat(2_048),
      link_preview_options: { is_disabled: true },
      protect_content: true,
    });
    expect(body).not.toHaveProperty("parse_mode");
    expect(body).not.toHaveProperty("entities");
    expect(body).not.toHaveProperty("reply_markup");
  });

  it("renders empty snapshots and statuses with fixed safe text", async () => {
    const fetchSpy = successfulFetch();
    const transport = createTelegramOutboundTransport({
      botToken: BOT_TOKEN,
      fetch: fetchSpy as unknown as typeof globalThis.fetch,
      minIntervalMs: 1,
      wait: async () => undefined,
    });
    const messages: readonly PlatformBridgeOutboundMessage[] = [
      { kind: "snapshot", cursor: 1, status: "awaiting-local-approval", text: "" },
      { kind: "status", cursor: 2, status: "tool-running" },
      { kind: "text", cursor: 3, text: "\u0000" },
    ];

    for (const message of messages) {
      await transport.send({ chatId: "42" }, message, sendOptions());
    }

    const sentTexts = fetchSpy.mock.calls.map(([, init]) =>
      JSON.parse(String(init?.body)).text,
    );
    expect(sentTexts).toEqual([
      "LVIS: waiting for local approval",
      "LVIS: working",
      "LVIS: message unavailable",
    ]);
  });

  it("fails with one generic error for invalid destinations, stale routes, fetch failures, and invalid Bot API responses", async () => {
    const tokenBearingFetch = successfulFetch();
    const staleTransport = createTelegramOutboundTransport({
      botToken: BOT_TOKEN,
      fetch: tokenBearingFetch as unknown as typeof globalThis.fetch,
      isChannelCurrent: () => false,
    });
    await expect(staleTransport.send(
      { chatId: "42" },
      { kind: "text", cursor: 1, text: "safe" },
      sendOptions(),
    )).rejects.toThrow("telegram-delivery-failed");
    expect(tokenBearingFetch).not.toHaveBeenCalled();

    const failingFetch = vi.fn(async () => new Response(JSON.stringify({ ok: false }), { status: 200 }));
    const failingTransport = createTelegramOutboundTransport({
      botToken: BOT_TOKEN,
      fetch: failingFetch as unknown as typeof globalThis.fetch,
    });
    const delivery = failingTransport.send(
      { chatId: "042" },
      { kind: "text", cursor: 1, text: "safe" },
      sendOptions(),
    );
    await expect(delivery).rejects.toThrow("telegram-delivery-failed");
    expect(failingFetch).not.toHaveBeenCalled();

    const responseFailure = createTelegramOutboundTransport({
      botToken: BOT_TOKEN,
      fetch: vi.fn(async () => new Response(JSON.stringify({ ok: false }), { status: 200 })) as unknown as typeof globalThis.fetch,
    });
    await expect(responseFailure.send(
      { chatId: "42" },
      { kind: "status", cursor: 1, status: "turn-failed" },
      sendOptions(),
    )).rejects.toMatchObject({ message: "telegram-delivery-failed" });
  });
  it("coalesces adjacent safe text in order, chunks by UTF-16 unit, and retains meaningful status transitions", () => {
    const combined = coalesceQueue([
      { cursor: 1, message: { kind: "text", cursor: 1, text: "first " } },
      { cursor: 2, message: { kind: "text", cursor: 2, text: "second" } },
      { cursor: 3, message: { kind: "status", cursor: 3, status: "turn-started" } },
      { cursor: 4, message: { kind: "status", cursor: 4, status: "tool-running" } },
      { cursor: 5, message: { kind: "status", cursor: 5, status: "awaiting-local-approval" } },
      { cursor: 6, message: { kind: "text", cursor: 6, text: "after approval" } },
      { cursor: 7, message: { kind: "status", cursor: 7, status: "tool-completed" } },
      { cursor: 8, message: { kind: "status", cursor: 8, status: "compaction-completed" } },
      { cursor: 9, message: { kind: "status", cursor: 9, status: "turn-completed" } },
    ]);
    expect(combined).toEqual([
      { cursor: 2, message: { kind: "text", cursor: 2, text: "first second" } },
      { cursor: 4, message: { kind: "status", cursor: 4, status: "tool-running" } },
      { cursor: 5, message: { kind: "status", cursor: 5, status: "awaiting-local-approval" } },
      { cursor: 6, message: { kind: "text", cursor: 6, text: "after approval" } },
      { cursor: 8, message: { kind: "status", cursor: 8, status: "compaction-completed" } },
      { cursor: 9, message: { kind: "status", cursor: 9, status: "turn-completed" } },
    ]);
    expect(Object.isFrozen(combined)).toBe(true);

    // 4,097 emoji are 8,194 UTF-16 units: three chunks, not two, and every
    // chunk has to fit the same unit budget the Bot API enforces.
    const original = "😀".repeat(4_097);
    const chunked = coalesceQueue([
      { cursor: 10, message: { kind: "text", cursor: 10, text: original } },
    ]);
    expect(chunked).toHaveLength(3);
    expect(chunked.map((entry) => entry.message.kind === "text" ? entry.message.text : "").join(""))
      .toBe(original);
    expect(chunked.map((entry) => entry.message.kind === "text" ? entry.message.text.length : -1))
      .toEqual([4_096, 4_096, 2]);
    // No chunk may end on half of a surrogate pair.
    for (const entry of chunked) {
      expect(entry.cursor).toBe(10);
      const text = entry.message.kind === "text" ? entry.message.text : "";
      expect([...text].every((character) => character === "😀")).toBe(true);
    }

    expect(() => coalesceQueue([
      { cursor: 11, message: { kind: "text", cursor: 12, text: "mismatched cursor" } },
    ])).toThrow("telegram-delivery-queue-entry-invalid");
  });

  it("keeps an over-long snapshot as one message holding its newest window", () => {
    const oversized = coalesceQueue([
      { cursor: 20, message: { kind: "snapshot", cursor: 20, status: "idle", text: `OLDEST${"x".repeat(8_000)}NEWEST` } },
    ]);
    // A reconnect snapshot stays one Bot API send. Splitting it would replay
    // the retained window as several rate-limited messages on every inbound
    // message, and the newest text is what the reader is waiting for.
    expect(oversized).toHaveLength(1);
    const snapshotText = oversized[0]?.message.kind === "snapshot" ? oversized[0].message.text : "";
    expect(snapshotText).toHaveLength(4_096);
    expect(snapshotText.endsWith("NEWEST")).toBe(true);
    expect(snapshotText.startsWith("OLDEST")).toBe(false);

    const surrogateBoundary = coalesceQueue([
      { cursor: 21, message: { kind: "snapshot", cursor: 21, status: "idle", text: `${"😀".repeat(2_048)}x` } },
    ]);
    const boundaryText = surrogateBoundary[0]?.message.kind === "snapshot"
      ? surrogateBoundary[0].message.text
      : "";
    // Retaining the last 4,096 units would start on half of a surrogate pair,
    // so the bound gives back one unit instead of emitting a broken character.
    expect(boundaryText).toBe(`${"😀".repeat(2_047)}x`);
  });

  it("throttles one chat and checks abort or revocation again after an injected wait", async () => {
    let clock = 0;
    const waits: number[] = [];
    const fetchSpy = successfulFetch();
    const transport = createTelegramOutboundTransport({
      botToken: BOT_TOKEN,
      fetch: fetchSpy as unknown as typeof globalThis.fetch,
      minIntervalMs: 1_000,
      now: () => clock,
      wait: async (milliseconds) => {
        waits.push(milliseconds);
        clock += milliseconds;
      },
    });
    const options = sendOptions();
    await transport.send({ chatId: "42" }, { kind: "text", cursor: 1, text: "first" }, options);
    await transport.send({ chatId: "42" }, { kind: "text", cursor: 2, text: "second" }, options);
    expect(waits).toEqual([1_000]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    let routeCurrent = true;
    let revokedClock = 0;
    const revokedFetch = successfulFetch();
    const revokedTransport = createTelegramOutboundTransport({
      botToken: BOT_TOKEN,
      fetch: revokedFetch as unknown as typeof globalThis.fetch,
      minIntervalMs: 1_000,
      now: () => revokedClock,
      isChannelCurrent: () => routeCurrent,
      wait: async (milliseconds) => {
        revokedClock += milliseconds;
        routeCurrent = false;
      },
    });
    await revokedTransport.send({ chatId: "42" }, { kind: "text", cursor: 1, text: "first" }, options);
    await expect(revokedTransport.send(
      { chatId: "42" },
      { kind: "text", cursor: 2, text: "must not publish after revoke" },
      options,
    )).rejects.toThrow("telegram-delivery-failed");
    expect(revokedFetch).toHaveBeenCalledTimes(1);

    let abortedClock = 0;
    const abortedFetch = successfulFetch();
    const abortController = new AbortController();
    const abortedTransport = createTelegramOutboundTransport({
      botToken: BOT_TOKEN,
      fetch: abortedFetch as unknown as typeof globalThis.fetch,
      minIntervalMs: 1_000,
      now: () => abortedClock,
      wait: async (milliseconds) => {
        abortedClock += milliseconds;
        abortController.abort();
      },
    });
    await abortedTransport.send({ chatId: "42" }, { kind: "text", cursor: 1, text: "first" }, options);
    await expect(abortedTransport.send(
      { chatId: "42" },
      { kind: "text", cursor: 2, text: "must not publish after abort" },
      { signal: abortController.signal, generation: 1 },
    )).rejects.toThrow("telegram-delivery-failed");
    expect(abortedFetch).toHaveBeenCalledTimes(1);
  });

  it("serializes concurrent different-DM launches against Telegram's free bot-wide pace", async () => {
    let clock = 0;
    const waits: number[] = [];
    const launches: Array<{ readonly chatId: string; readonly at: number }> = [];
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { readonly chat_id: string };
      launches.push({ chatId: body.chat_id, at: clock });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const transport = createTelegramOutboundTransport({
      botToken: BOT_TOKEN,
      fetch: fetchSpy as unknown as typeof globalThis.fetch,
      now: () => clock,
      wait: async (milliseconds) => {
        waits.push(milliseconds);
        clock += milliseconds;
      },
    });

    await Promise.all([
      transport.send({ chatId: "42" }, { kind: "text", cursor: 1, text: "first" }, sendOptions()),
      transport.send({ chatId: "43" }, { kind: "text", cursor: 1, text: "second" }, sendOptions()),
    ]);

    expect(waits).toEqual([34]);
    expect(launches).toEqual([
      { chatId: "42", at: 0 },
      { chatId: "43", at: 34 },
    ]);
  });

  it("fails an old delivery lease after a reconnect changes the active channel while its request is pending", async () => {
    const oldChannel = Object.freeze({ chatId: "42", deliveryLease: "old-lease" });
    const newChannel = Object.freeze({ chatId: "42", deliveryLease: "new-lease" });
    let activeDeliveryLease: string | undefined = oldChannel.deliveryLease;
    let resolveResponse: ((response: Response) => void) | undefined;
    let markFetchStarted: (() => void) | undefined;
    const fetchStarted = new Promise<void>((resolve) => { markFetchStarted = resolve; });
    const fetchSpy = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => new Promise<Response>((resolve) => {
      resolveResponse = resolve;
      markFetchStarted?.();
    }));
    const channelGuard = vi.fn((channel: Readonly<TelegramDeliveryChannel>) => (
      channel.deliveryLease === activeDeliveryLease
    ));
    const transport = createTelegramOutboundTransport({
      botToken: BOT_TOKEN,
      fetch: fetchSpy as unknown as typeof globalThis.fetch,
      isChannelCurrent: channelGuard,
    });

    const oldDelivery = transport.send(
      oldChannel,
      { kind: "text", cursor: 1, text: "must not succeed after reconnect" },
      sendOptions(),
    );
    await fetchStarted;
    activeDeliveryLease = newChannel.deliveryLease;
    resolveResponse?.(new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    await expect(oldDelivery).rejects.toThrow("telegram-delivery-failed");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(channelGuard).toHaveBeenLastCalledWith(oldChannel, 1);
  });

  it("aborts a hung Bot API request at the configured timeout and reports one generic delivery failure", async () => {
    vi.useFakeTimers();
    try {
      let requestSignal: AbortSignal | undefined;
      let markFetchStarted: (() => void) | undefined;
      const fetchStarted = new Promise<void>((resolve) => { markFetchStarted = resolve; });
      const hangingFetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        const signal = init?.signal;
        requestSignal = signal ?? undefined;
        markFetchStarted?.();
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("request-aborted")), { once: true });
        });
      });
      const transport = createTelegramOutboundTransport({
        botToken: BOT_TOKEN,
        fetch: hangingFetch as unknown as typeof globalThis.fetch,
        requestTimeoutMs: 25,
      });
      const delivery = transport.send(
        { chatId: "42" },
        { kind: "text", cursor: 1, text: "will time out" },
        sendOptions(),
      );

      await fetchStarted;
      expect(requestSignal).toBeInstanceOf(AbortSignal);
      expect(requestSignal?.aborted).toBe(false);
      const deliveryFailure = expect(delivery).rejects.toThrow("telegram-delivery-failed");
      await vi.advanceTimersByTimeAsync(25);
      await deliveryFailure;
      expect(requestSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
