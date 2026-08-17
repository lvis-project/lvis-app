import { describe, expect, it, vi } from "vitest";
import type {
  PlatformBridgeDeliveryTransportSendOptions,
  PlatformBridgeOutboundMessage,
} from "../platform-bridge-delivery.js";
import { readPlatformBridgeDeliverySendFailure } from "../platform-bridge-delivery.js";
import {
  coalesceTelegramDeliveryQueue,
  createTelegramOutboundTransport,
  createTelegramPollingVerifier,
  parseTelegramCallbackQueryUpdate,
  type TelegramDeliveryChannel,
  type TelegramDeliveryQueueEntry,
} from "../telegram-platform-adapter.js";

const BOT_TOKEN = "123456:BOT_TOKEN-safe_123";

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

function polledUpdate(body: unknown) {
  return {
    rawBody: Buffer.from(JSON.stringify(body), "utf8"),
  } as unknown as Parameters<ReturnType<typeof createTelegramPollingVerifier>["verify"]>[0];
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
  it("maps only a simple private text update and ignores an unparseable body", () => {
    const verifier = createTelegramPollingVerifier();

    expect(verifier.verify(polledUpdate(update()))).toEqual({
      provider: "telegram",
      deliveryId: "123",
      channelId: "42",
      senderId: "42",
      text: "safe telegram text",
    });

    expect(verifier.verify(polledUpdate("not-json"))).toBeUndefined();
  });

  it("ignores reply decoration instead of killing the message that carries it", () => {
    const verifier = createTelegramPollingVerifier();
    // Swipe-to-reply is Telegram's default gesture in a DM. The parser never
    // reads these fields, so rejecting them discarded a perfectly ordinary
    // message for HOW it was composed, with no containment gain.
    for (const decorate of [
      (candidate: Record<string, any>) => { candidate.message.reply_to_message = { message_id: 7 }; },
      (candidate: Record<string, any>) => { candidate.message.quote = { text: "earlier" }; },
    ]) {
      const candidate = structuredClone(update()) as Record<string, any>;
      decorate(candidate);
      const envelope = verifier.verify(polledUpdate(candidate));
      expect(envelope).toBeDefined();
      // The decoration is metadata only: nothing from it enters the envelope.
      expect(JSON.stringify(envelope)).not.toContain("earlier");
    }
  });

  it("fails closed for every non-text or non-private message form", () => {
    const verifier = createTelegramPollingVerifier();
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
      expect(verifier.verify(polledUpdate(candidate))).toBeUndefined();
    }
  });

  it("enforces safe positive direct-message identifiers and text UTF-16 unit bounds", () => {
    const verifier = createTelegramPollingVerifier();
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
      expect(verifier.verify(polledUpdate(candidate))).toBeUndefined();
    }

    const boundary = structuredClone(update()) as Record<string, any>;
    boundary.message.text = "😀".repeat(2_048);
    expect(boundary.message.text).toHaveLength(4_096);
    expect(verifier.verify(polledUpdate(boundary))).toMatchObject({ text: boundary.message.text });

    const whitespace = structuredClone(update()) as Record<string, any>;
    whitespace.message.text = "safe\ntext\tstill allowed";
    expect(verifier.verify(polledUpdate(whitespace))).toMatchObject({ text: whitespace.message.text });
  });

  it("decodes only a plain private button press into a callback envelope", () => {
    const pressed = {
      update_id: 123,
      callback_query: {
        id: "press-1",
        from: { id: 42, is_bot: false },
        // Presence-only fields a real press always echoes; never read.
        message: { message_id: 456, date: 1_700_000_000, chat: { id: 42, type: "private" } },
        chat_instance: "-3538274119585",
        data: "opaque-token_ABC",
      },
    };
    const envelope = parseTelegramCallbackQueryUpdate(
      Buffer.from(JSON.stringify(pressed), "utf8"),
    );
    expect(envelope).toEqual({
      provider: "telegram",
      callbackQueryId: "press-1",
      senderId: "42",
      data: "opaque-token_ABC",
    });
    // Nothing routing-relevant is taken from the echoed card message.
    expect(JSON.stringify(envelope)).not.toContain("456");

    const rejected: readonly [string, (candidate: Record<string, any>) => void][] = [
      ["a text update instead", (candidate) => {
        delete candidate.callback_query;
        candidate.message = (update() as Record<string, any>).message;
      }],
      ["extra update key", (candidate) => { candidate.edited_message = {}; }],
      ["extra callback key", (candidate) => { candidate.callback_query.game_short_name = "g"; }],
      ["bot sender", (candidate) => { candidate.callback_query.from.is_bot = true; }],
      ["unsafe sender id", (candidate) => { candidate.callback_query.from.id = 0; }],
      ["missing data", (candidate) => { delete candidate.callback_query.data; }],
      ["structured data", (candidate) => { candidate.callback_query.data = '{"choice":"allow"}'; }],
      ["overlong data", (candidate) => { candidate.callback_query.data = "a".repeat(65); }],
      ["empty data", (candidate) => { candidate.callback_query.data = ""; }],
      ["non-token query id", (candidate) => { candidate.callback_query.id = "has space"; }],
      ["zero update id", (candidate) => { candidate.update_id = 0; }],
    ];
    for (const [name, mutate] of rejected) {
      const candidate = structuredClone(pressed) as Record<string, any>;
      mutate(candidate);
      expect(
        parseTelegramCallbackQueryUpdate(Buffer.from(JSON.stringify(candidate), "utf8")),
        name,
      ).toBeUndefined();
    }
    expect(parseTelegramCallbackQueryUpdate(Buffer.from("not-json", "utf8"))).toBeUndefined();
  });

  it("validates bot-token configuration without accepting URL-changing token material", () => {
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

  it("renders a failed turn with its category and safe summary, failing closed otherwise", async () => {
    const fetchSpy = successfulFetch();
    const transport = createTelegramOutboundTransport({
      botToken: BOT_TOKEN,
      fetch: fetchSpy as unknown as typeof globalThis.fetch,
      minIntervalMs: 1,
      wait: async () => undefined,
    });
    const messages: readonly PlatformBridgeOutboundMessage[] = [
      {
        kind: "status",
        cursor: 1,
        status: "turn-failed",
        failure: { category: "provider", summary: "The model provider returned an error." },
      },
      {
        kind: "status",
        cursor: 2,
        status: "turn-failed",
        failure: {
          category: "stack-trace",
          summary: "at C:\\private\\secret.ts:1 token sk-FAKE-TOKEN-123",
        } as unknown as { category: "provider"; summary: string },
      },
      { kind: "status", cursor: 3, status: "turn-failed" },
    ];

    for (const message of messages) {
      await transport.send({ chatId: "42" }, message, sendOptions());
    }

    const sentTexts = fetchSpy.mock.calls.map(([, init]) =>
      JSON.parse(String(init?.body)).text,
    );
    expect(sentTexts).toEqual([
      "LVIS: turn failed — provider error: The model provider returned an error.",
      "LVIS: turn failed",
      "LVIS: turn failed",
    ]);
    const bodies = JSON.stringify(fetchSpy.mock.calls.map(([, init]) => String(init?.body)));
    expect(bodies).not.toContain("secret.ts");
    expect(bodies).not.toContain("sk-FAKE-TOKEN-123");
  });

  it("keeps the failure summary on a coalesced turn-failed status and drops a forged one", () => {
    const failure = { category: "network", summary: "The model request failed over the network." } as const;
    const combined = coalesceQueue([
      { cursor: 1, message: { kind: "status", cursor: 1, status: "tool-running" } },
      { cursor: 2, message: { kind: "status", cursor: 2, status: "turn-failed", failure } },
    ]);
    expect(combined).toEqual([
      { cursor: 1, message: { kind: "status", cursor: 1, status: "tool-running" } },
      { cursor: 2, message: { kind: "status", cursor: 2, status: "turn-failed", failure } },
    ]);

    const forged = coalesceQueue([
      {
        cursor: 3,
        message: {
          kind: "status",
          cursor: 3,
          status: "turn-failed",
          failure: {
            category: "stack-trace",
            summary: "sk-FAKE-TOKEN-123",
          } as unknown as { category: "provider"; summary: string },
        },
      },
    ]);
    expect(forged).toEqual([
      { cursor: 3, message: { kind: "status", cursor: 3, status: "turn-failed" } },
    ]);
  });

  it("names the waiting tool in the approval notice and resumes with the plain working status", async () => {
    const fetchSpy = successfulFetch();
    const transport = createTelegramOutboundTransport({
      botToken: BOT_TOKEN,
      fetch: fetchSpy as unknown as typeof globalThis.fetch,
      minIntervalMs: 1,
      wait: async () => undefined,
    });
    const messages: readonly PlatformBridgeOutboundMessage[] = [
      { kind: "status", cursor: 1, status: "awaiting-local-approval", tool: "builtin:list_files" },
      // The approval decision itself never crosses the bridge; the turn simply
      // resumes through the ordinary tool status once it is approved locally.
      { kind: "status", cursor: 2, status: "tool-running" },
    ];

    for (const message of messages) {
      await transport.send({ chatId: "42" }, message, sendOptions());
    }

    const sentTexts = fetchSpy.mock.calls.map(([, init]) =>
      JSON.parse(String(init?.body)).text,
    );
    expect(sentTexts).toEqual([
      "LVIS: waiting for local approval — tool builtin:list_files (waiting for approval)",
      "LVIS: working",
    ]);
  });

  it("keeps the fixed approval text when the tool identifier is missing or unsafe", async () => {
    const fetchSpy = successfulFetch();
    const transport = createTelegramOutboundTransport({
      botToken: BOT_TOKEN,
      fetch: fetchSpy as unknown as typeof globalThis.fetch,
      minIntervalMs: 1,
      wait: async () => undefined,
    });

    for (const tool of [undefined, "unsafe tool C:\\private\\path"]) {
      await transport.send(
        { chatId: "42" },
        {
          kind: "status",
          cursor: 1,
          status: "awaiting-local-approval",
          ...(tool === undefined ? {} : { tool }),
        },
        sendOptions(),
      );
    }

    const sentTexts = fetchSpy.mock.calls.map(([, init]) =>
      JSON.parse(String(init?.body)).text,
    );
    expect(sentTexts).toEqual([
      "LVIS: waiting for local approval",
      "LVIS: waiting for local approval",
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

  it("collapses a repeated identical approval wait into one queued notice and keeps distinct ones", () => {
    const repeated = coalesceQueue([
      { cursor: 1, message: { kind: "status", cursor: 1, status: "awaiting-local-approval", tool: "builtin:list_files" } },
      { cursor: 2, message: { kind: "status", cursor: 2, status: "awaiting-local-approval", tool: "builtin:list_files" } },
      { cursor: 3, message: { kind: "status", cursor: 3, status: "awaiting-local-approval", tool: "builtin:list_files" } },
    ]);
    expect(repeated).toEqual([
      { cursor: 3, message: { kind: "status", cursor: 3, status: "awaiting-local-approval", tool: "builtin:list_files" } },
    ]);

    // A wait for a DIFFERENT tool is new information, not spam.
    const distinct = coalesceQueue([
      { cursor: 1, message: { kind: "status", cursor: 1, status: "awaiting-local-approval", tool: "builtin:list_files" } },
      { cursor: 2, message: { kind: "status", cursor: 2, status: "awaiting-local-approval", tool: "builtin:run_shell" } },
    ]);
    expect(distinct).toHaveLength(2);

    // Intervening text keeps both notices: the reader saw progress between them.
    const separated = coalesceQueue([
      { cursor: 1, message: { kind: "status", cursor: 1, status: "awaiting-local-approval", tool: "builtin:list_files" } },
      { cursor: 2, message: { kind: "text", cursor: 2, text: "partial reply" } },
      { cursor: 3, message: { kind: "status", cursor: 3, status: "awaiting-local-approval", tool: "builtin:list_files" } },
    ]);
    expect(separated).toHaveLength(3);

    // Re-admission drops a non-conforming or misplaced identifier rather than
    // killing the channel: the bare status still reaches the reader.
    expect(coalesceQueue([
      { cursor: 4, message: { kind: "status", cursor: 4, status: "awaiting-local-approval", tool: "unsafe tool name" } },
    ])).toEqual([
      { cursor: 4, message: { kind: "status", cursor: 4, status: "awaiting-local-approval" } },
    ]);
    expect(coalesceQueue([
      { cursor: 5, message: { kind: "status", cursor: 5, status: "turn-completed", tool: "builtin:list_files" } },
    ])).toEqual([
      { cursor: 5, message: { kind: "status", cursor: 5, status: "turn-completed" } },
    ]);
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

  it("classifies a network failure as transient and logs only a safe errno-style code", async () => {
    const logs: string[] = [];
    const networkError = new Error(
      `fetch failed for https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
    );
    (networkError as { cause?: unknown }).cause = Object.assign(
      new Error("connect ECONNREFUSED 127.0.0.1:443"),
      { code: "ECONNREFUSED" },
    );
    const transport = createTelegramOutboundTransport({
      botToken: BOT_TOKEN,
      fetch: vi.fn(async () => { throw networkError; }) as unknown as typeof globalThis.fetch,
      log: (message) => void logs.push(message),
    });

    const error: unknown = await transport.send(
      { chatId: "42" },
      { kind: "text", cursor: 1, text: "private reply text" },
      sendOptions(),
    ).then(() => undefined, (thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("telegram-delivery-failed");
    expect(readPlatformBridgeDeliverySendFailure(error)).toEqual({
      transient: true,
      reason: "network",
    });
    expect(logs).toEqual(["[telegram-egress] sendMessage failed: network error (ECONNREFUSED)"]);
    const logged = logs.join("\n");
    expect(logged).not.toContain(BOT_TOKEN);
    expect(logged).not.toContain("42");
    expect(logged).not.toContain("private reply text");
    expect(logged).not.toContain("https://");
  });

  it("classifies a request timeout as transient without leaking wire detail", async () => {
    vi.useFakeTimers();
    try {
      const logs: string[] = [];
      const hangingFetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("request-aborted")), { once: true });
        }));
      const transport = createTelegramOutboundTransport({
        botToken: BOT_TOKEN,
        fetch: hangingFetch as unknown as typeof globalThis.fetch,
        requestTimeoutMs: 25,
        log: (message) => void logs.push(message),
      });

      const delivery = transport.send(
        { chatId: "42" },
        { kind: "text", cursor: 1, text: "will time out" },
        sendOptions(),
      ).then(() => undefined, (thrown: unknown) => thrown);
      await vi.advanceTimersByTimeAsync(25);
      const error = await delivery;

      expect(readPlatformBridgeDeliverySendFailure(error)).toEqual({
        transient: true,
        reason: "timeout",
      });
      expect(logs).toEqual(["[telegram-egress] sendMessage failed: request timeout"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("classifies Bot API rejections by status: 5xx transient, 429 with capped retry-after, 403 permanent", async () => {
    const classify = async (status: number, body: Record<string, unknown>) => {
      const logs: string[] = [];
      const transport = createTelegramOutboundTransport({
        botToken: BOT_TOKEN,
        fetch: vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof globalThis.fetch,
        log: (message) => void logs.push(message),
      });
      const error: unknown = await transport.send(
        { chatId: "42" },
        { kind: "text", cursor: 1, text: "private reply text" },
        sendOptions(),
      ).then(() => undefined, (thrown: unknown) => thrown);
      expect((error as Error).message).toBe("telegram-delivery-failed");
      const logged = logs.join("\n");
      expect(logged).not.toContain(BOT_TOKEN);
      expect(logged).not.toContain("private reply text");
      return { failure: readPlatformBridgeDeliverySendFailure(error), logged };
    };

    const serverError = await classify(502, { ok: false, error_code: 502, description: "Bad Gateway" });
    expect(serverError.failure).toEqual({ transient: true, reason: "api-502" });
    expect(serverError.logged).toContain("http_status=502");
    expect(serverError.logged).toContain("error_code=502");

    const rateLimited = await classify(429, {
      ok: false,
      error_code: 429,
      description: "Too Many Requests: retry after 99",
      parameters: { retry_after: 99 },
    });
    // A 99-second provider hint is honored only up to the 30-second cap.
    expect(rateLimited.failure).toEqual({ transient: true, reason: "api-429", retryAfterMs: 30_000 });
    expect(rateLimited.logged).toContain("retry_after_ms=30000");

    const shortRateLimit = await classify(429, {
      ok: false,
      error_code: 429,
      description: "Too Many Requests: retry after 2",
      parameters: { retry_after: 2 },
    });
    expect(shortRateLimit.failure).toEqual({ transient: true, reason: "api-429", retryAfterMs: 2_000 });

    const forbidden = await classify(403, {
      ok: false,
      error_code: 403,
      description: "Forbidden: bot was blocked by the user",
    });
    expect(forbidden.failure).toEqual({ transient: false, reason: "api-403" });
    expect(forbidden.logged).toContain('description="Forbidden: bot was blocked by the user"');

    // A success status carrying a failure body is still a permanent rejection.
    const failedBody = await classify(200, { ok: false });
    expect(failedBody.failure).toEqual({ transient: false, reason: "http-200" });
  });

  it("truncates and sanitizes a hostile provider description before logging it", async () => {
    const logs: string[] = [];
    const hostileDescription = `${"A\"\u0000\u0007\n<x>".repeat(40)}${"B".repeat(5_000)}`;
    const transport = createTelegramOutboundTransport({
      botToken: BOT_TOKEN,
      fetch: vi.fn(async () => new Response(
        JSON.stringify({ ok: false, error_code: 400, description: hostileDescription }),
        { status: 400 },
      )) as unknown as typeof globalThis.fetch,
      log: (message) => void logs.push(message),
    });

    await expect(transport.send(
      { chatId: "42" },
      { kind: "text", cursor: 1, text: "safe" },
      sendOptions(),
    )).rejects.toThrow("telegram-delivery-failed");

    expect(logs).toHaveLength(1);
    const line = logs[0]!;
    // Prefix + status fields + a description hard-capped at 120 characters.
    expect(line.length).toBeLessThan(220);
    expect(line).toContain('description="A<x>');
    // Embedded quotes and control characters are stripped, so a hostile
    // description can neither restructure the line nor flood the log.
    const delimiter = 'description="';
    const loggedDescription = line.slice(line.indexOf(delimiter) + delimiter.length, -1);
    expect(loggedDescription.length).toBeLessThanOrEqual(120);
    expect(loggedDescription).not.toContain('"');
    expect(line).not.toContain("\u0000");
    expect(line).not.toContain("\u0007");
    expect(line).not.toContain("\n");
  });
});
