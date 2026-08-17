import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlatformBridgeInboundResult } from "../platform-bridge-inbound.js";
import type { TelegramBotApiResult, TelegramPolledUpdate } from "../telegram-bot-api-client.js";
import { mintTelegramPairingCode, telegramPairingCodeDigest } from "../telegram-pairing-code.js";
import {
  startTelegramPollingIngress,
  type TelegramPollingIngress,
  type TelegramPollingIngressOptions,
} from "../telegram-polling-ingress.js";
import { callbackUpdate } from "./telegram-bridge-fixtures.js";

const OWNER_ID = 123456789;

function textUpdate(updateId: number, text: string): TelegramPolledUpdate {
  return {
    updateId,
    rawBody: Buffer.from(JSON.stringify({
      update_id: updateId,
      message: {
        message_id: updateId + 1,
        date: 1_700_000_000,
        from: { id: OWNER_ID, is_bot: false },
        chat: { id: OWNER_ID, type: "private" },
        text,
      },
    }), "utf8"),
  };
}

/** A membership change: well-formed, never a message the host can act on. */
function nonMessageUpdate(updateId: number): TelegramPolledUpdate {
  return {
    updateId,
    rawBody: Buffer.from(JSON.stringify({
      update_id: updateId,
      my_chat_member: { date: 1_700_000_000 },
    }), "utf8"),
  };
}

type Batch = TelegramBotApiResult<readonly TelegramPolledUpdate[]>;

function harness(overrides: Partial<TelegramPollingIngressOptions> = {}) {
  const batches: Batch[] = [];
  const getUpdatesCalls: { offset?: number; limit?: number; timeoutSeconds?: number }[] = [];
  let idle: (() => void) | undefined;

  const client = {
    getUpdates: vi.fn(async (input: {
      offset?: number;
      limit?: number;
      timeoutSeconds?: number;
      signal?: AbortSignal;
    } = {}) => {
      getUpdatesCalls.push({
        ...(input.offset === undefined ? {} : { offset: input.offset }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        ...(input.timeoutSeconds === undefined ? {} : { timeoutSeconds: input.timeoutSeconds }),
      });
      const next = batches.shift();
      if (next !== undefined) return next;
      // Park until the test stops the ingress, so the loop cannot spin.
      return await new Promise<Batch>((resolve) => {
        idle = () => resolve({ ok: true, value: [] });
        input.signal?.addEventListener("abort", () => resolve({ ok: true, value: [] }), { once: true });
      });
    }),
    getMe: vi.fn(async () => ({ ok: true as const, value: { username: "a_bot" } })),
    getWebhookInfo: vi.fn(async () => ({ ok: true as const, value: { hasWebhook: false } })),
  };

  const handleWebhook = vi.fn(
    async (_request: { rawBody: Uint8Array }): Promise<PlatformBridgeInboundResult> => "accepted",
  );
  const recordPollOffset = vi.fn(async () => {});
  const redeemPairingCode = vi.fn(async () => false);
  const onFatal = vi.fn();
  const onPaired = vi.fn();
  let offset: number | null = 100;

  const options: TelegramPollingIngressOptions = {
    client: client as never,
    gateway: { handleWebhook } as never,
    pollOffset: () => offset,
    recordPollOffset: async (next) => {
      offset = next;
      await recordPollOffset();
    },
    hasPendingPairingCode: () => true,
    redeemPairingCode,
    onFatal,
    onPaired,
    wait: async () => {},
    ...overrides,
  };

  return {
    options,
    client,
    handleWebhook,
    recordPollOffset,
    redeemPairingCode,
    onFatal,
    onPaired,
    getUpdatesCalls,
    queue(...next: Batch[]) { batches.push(...next); },
    releaseIdle() { idle?.(); },
    currentOffset() { return offset; },
    setOffset(next: number | null) { offset = next; },
  };
}

let running: TelegramPollingIngress | undefined;

afterEach(async () => {
  running?.stop();
  await running?.finished;
  running = undefined;
});

function start(options: TelegramPollingIngressOptions): TelegramPollingIngress {
  running = startTelegramPollingIngress(options);
  return running;
}

describe("startTelegramPollingIngress", () => {
  it("skips the backlog once instead of replaying it as live turns", async () => {
    const h = harness();
    h.setOffset(null);
    h.queue({ ok: true, value: [textUpdate(4_242, "old message")] });
    start(h.options);

    await vi.waitFor(() => expect(h.recordPollOffset).toHaveBeenCalled());
    expect(h.getUpdatesCalls[0]).toEqual({ offset: -1, limit: 1, timeoutSeconds: 0 });
    expect(h.currentOffset()).toBe(4_243);
    // The seeding call must not hand the backlog to the conversation.
    expect(h.handleWebhook).not.toHaveBeenCalled();
  });

  it("confirms an update only when the outcome is terminal for it", async () => {
    for (const outcome of [
      "accepted",
      "duplicate",
      "invalid-envelope",
      "slash-command-rejected",
      "authorization-denied",
      "idempotency-conflict",
      "command-outcome-unknown",
    ] as PlatformBridgeInboundResult[]) {
      const h = harness();
      h.handleWebhook.mockResolvedValue(outcome);
      h.queue({ ok: true, value: [textUpdate(200, "hello")] });
      const ingress = start(h.options);

      await vi.waitFor(() => expect(h.currentOffset()).toBe(201));
      ingress.stop();
      await ingress.finished;
      running = undefined;
    }
  });

  it("re-polls an update the core released for retry", async () => {
    for (const outcome of [
      "streaming-active",
      "rate-limited",
      "authorization-revoked",
      "receipt-unavailable",
      "idempotency-capacity-reached",
    ] as PlatformBridgeInboundResult[]) {
      const h = harness();
      h.handleWebhook.mockResolvedValue(outcome);
      h.queue({ ok: true, value: [textUpdate(200, "hello")] });
      const ingress = start(h.options);

      await vi.waitFor(() => expect(h.handleWebhook).toHaveBeenCalled());
      // Advancing here would destroy a delivery the core expects to see again.
      expect(h.recordPollOffset).not.toHaveBeenCalled();
      expect(h.currentOffset()).toBe(100);
      ingress.stop();
      await ingress.finished;
      running = undefined;
    }
  });

  it("advances past an update the host can never act on", async () => {
    const h = harness();
    h.queue({ ok: true, value: [nonMessageUpdate(300)] });
    start(h.options);

    // Not advancing would wedge the loop on this update forever.
    await vi.waitFor(() => expect(h.currentOffset()).toBe(301));
    expect(h.handleWebhook).not.toHaveBeenCalled();
  });

  it("hands a decision press to the callback handler, never to the conversation", async () => {
    const onCallbackQuery = vi.fn(async () => {});
    const h = harness({ onCallbackQuery });
    h.queue({ ok: true, value: [callbackUpdate(310, "opaque-token-abc")] });
    start(h.options);

    await vi.waitFor(() => expect(onCallbackQuery).toHaveBeenCalledWith({
      provider: "telegram",
      callbackQueryId: "press-310",
      senderId: String(OWNER_ID),
      data: "opaque-token-abc",
    }));
    // A press is a decision signal, not conversation input.
    expect(h.handleWebhook).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(h.currentOffset()).toBe(311));
  });

  it("consumes a press when no callback handler is wired, without wedging", async () => {
    const lines: string[] = [];
    const h = harness({ log: (message: string) => { lines.push(message); } });
    h.queue({ ok: true, value: [callbackUpdate(320, "opaque-token-abc")] });
    start(h.options);

    // Re-polling an unhandled press could never help; it is consumed on
    // purpose, so it must not be tallied as data loss either.
    await vi.waitFor(() => expect(h.currentOffset()).toBe(321));
    expect(h.handleWebhook).not.toHaveBeenCalled();
    expect(lines.filter((line) => line.includes("pre-envelope drop"))).toEqual([]);
  });

  it("keeps polling when the callback handler itself throws", async () => {
    const h = harness({
      onCallbackQuery: vi.fn(async () => { throw new Error("handler down"); }),
    });
    h.queue({
      ok: true,
      value: [callbackUpdate(330, "opaque-token-abc"), textUpdate(331, "hello")],
    });
    start(h.options);

    // The press is consumed and the following message still reaches the core.
    await vi.waitFor(() => expect(h.currentOffset()).toBe(332));
    expect(h.handleWebhook).toHaveBeenCalledTimes(1);
  });

  it("dispatches strictly one update at a time, in order", async () => {
    const h = harness();
    let active = 0;
    let maxActive = 0;
    const seen: number[] = [];
    h.handleWebhook.mockImplementation(async (request: { rawBody: Uint8Array }) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      const body = JSON.parse(Buffer.from(request.rawBody).toString("utf8"));
      seen.push(body.update_id as number);
      await Promise.resolve();
      active -= 1;
      return "accepted";
    });
    h.queue({
      ok: true,
      value: [textUpdate(10, "a"), textUpdate(11, "b"), textUpdate(12, "c")],
    });
    start(h.options);

    await vi.waitFor(() => expect(seen).toHaveLength(3));
    // A concurrent fan-out would lose all but one message to the turn lease.
    expect(maxActive).toBe(1);
    expect(seen).toEqual([10, 11, 12]);
  });

  it("redeems a pairing code without ever forwarding it to the conversation", async () => {
    const code = mintTelegramPairingCode();
    const h = harness({ redeemPairingCode: vi.fn(async () => true) });
    h.queue({ ok: true, value: [textUpdate(20, code)] });
    start(h.options);

    await vi.waitFor(() => expect(h.options.redeemPairingCode).toHaveBeenCalled());
    expect(h.options.redeemPairingCode).toHaveBeenCalledWith(
      telegramPairingCodeDigest(code),
      String(OWNER_ID),
    );
    expect(h.handleWebhook).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(h.currentOffset()).toBe(21));
  });

  it("leaves the attempt budget to the store and never forwards a near miss", async () => {
    const wrong = mintTelegramPairingCode();
    const h = harness();
    h.queue({ ok: true, value: [textUpdate(30, wrong)] });
    start(h.options);

    await vi.waitFor(() => expect(h.options.redeemPairingCode).toHaveBeenCalledOnce());
    // Exactly one redemption call, and no second charging path: the durable
    // store already debits the attempt when it rejects a digest, and charging
    // from here too spent the advertised five attempts in about three.
    expect(h.options.redeemPairingCode).toHaveBeenCalledTimes(1);
    // A code-shaped credential must not reach the transcript even when wrong.
    expect(h.handleWebhook).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(h.currentOffset()).toBe(31));
  });

  it("stays silent when a code arrives with nothing pending", async () => {
    const code = mintTelegramPairingCode();
    const h = harness({ hasPendingPairingCode: () => false });
    h.queue({ ok: true, value: [textUpdate(40, code)] });
    start(h.options);

    await vi.waitFor(() => expect(h.currentOffset()).toBe(41));
    expect(h.options.redeemPairingCode).not.toHaveBeenCalled();
    expect(h.handleWebhook).not.toHaveBeenCalled();
  });

  it("tells a paired owner their conversation is not shared, rather than vanishing", async () => {
    const notifyUnroutable = vi.fn(async () => {});
    const h = harness({ isPairedOwner: () => true, notifyUnroutable });
    h.handleWebhook.mockResolvedValue("authorization-denied");
    h.queue({ ok: true, value: [textUpdate(50, "are you there?")] });
    start(h.options);

    await vi.waitFor(() => expect(notifyUnroutable)
      .toHaveBeenCalledWith(String(OWNER_ID), "conversation-not-shared"));
    // The update is still consumed — the notice replaces silence, not handling.
    await vi.waitFor(() => expect(h.currentOffset()).toBe(51));
  });

  it("answers a slash message instead of consuming it in silence", async () => {
    const notifyUnroutable = vi.fn(async () => {});
    const h = harness({ isPairedOwner: () => true, notifyUnroutable });
    h.handleWebhook.mockResolvedValue("slash-command-rejected");
    h.queue({ ok: true, value: [textUpdate(55, "/status")] });
    start(h.options);

    // The core rejects every leading-slash message by policy and the update is
    // consumed. Without its own notice the owner typing /status saw nothing at
    // all, which is the same dead-bot reading the shared-conversation notice
    // was added to remove.
    await vi.waitFor(() => expect(notifyUnroutable)
      .toHaveBeenCalledWith(String(OWNER_ID), "commands-not-supported"));
    await vi.waitFor(() => expect(h.currentOffset()).toBe(56));
  });

  it("stays silent for a sender who is not the paired owner", async () => {
    const notifyUnroutable = vi.fn(async () => {});
    const h = harness({ isPairedOwner: () => false, notifyUnroutable });
    h.handleWebhook.mockResolvedValue("authorization-denied");
    h.queue({ ok: true, value: [textUpdate(60, "who is this")] });
    start(h.options);

    // Replying would confirm to a stranger that this bot is attached to a
    // live desktop.
    await vi.waitFor(() => expect(h.currentOffset()).toBe(61));
    expect(notifyUnroutable).not.toHaveBeenCalled();
  });

  it("never sends a notice for an outcome that was actually handled", async () => {
    const notifyUnroutable = vi.fn(async () => {});
    const h = harness({ isPairedOwner: () => true, notifyUnroutable });
    h.handleWebhook.mockResolvedValue("accepted");
    h.queue({ ok: true, value: [textUpdate(70, "hello")] });
    start(h.options);

    await vi.waitFor(() => expect(h.currentOffset()).toBe(71));
    expect(notifyUnroutable).not.toHaveBeenCalled();
  });

  it("keeps consuming updates when the notice itself fails", async () => {
    const h = harness({
      isPairedOwner: () => true,
      notifyUnroutable: vi.fn(async () => { throw new Error("provider down"); }),
    });
    h.handleWebhook.mockResolvedValue("authorization-denied");
    h.queue({ ok: true, value: [textUpdate(80, "still there?")] });
    start(h.options);

    await vi.waitFor(() => expect(h.currentOffset()).toBe(81));
  });

  it("stops on a rejected token instead of retrying forever", async () => {
    const h = harness();
    h.queue({ ok: false, reason: "unauthorized" });
    const ingress = start(h.options);

    await ingress.finished;
    expect(h.onFatal).toHaveBeenCalledWith("telegram-bot-token-rejected");
    running = undefined;
  });

  it("distinguishes the two conflicts by asking Telegram, not by reading its prose", async () => {
    const withWebhook = harness();
    withWebhook.client.getWebhookInfo.mockResolvedValue({ ok: true, value: { hasWebhook: true } });
    withWebhook.queue({ ok: false, reason: "conflict" });
    const first = start(withWebhook.options);
    await first.finished;
    expect(withWebhook.onFatal).toHaveBeenCalledWith("telegram-webhook-conflict");
    expect(withWebhook.client.getWebhookInfo).toHaveBeenCalled();
    running = undefined;

    const withoutWebhook = harness();
    withoutWebhook.queue({ ok: false, reason: "conflict" });
    const second = start(withoutWebhook.options);
    await second.finished;
    expect(withoutWebhook.onFatal).toHaveBeenCalledWith("telegram-poll-conflict");
    running = undefined;
  });

  it("ends the activation when a confirmed offset cannot be persisted", async () => {
    // Both write sites, because they are separate calls: a fix applied to one
    // leaves the other killing ingress without a word.
    const sites = [
      { name: "seeded offset", offset: null, batch: { ok: true as const, value: [] } },
      {
        name: "confirmed update",
        offset: 100,
        batch: { ok: true as const, value: [textUpdate(100, "hello")] },
      },
    ];

    for (const site of sites) {
      const failing = harness({
        recordPollOffset: async () => {
          throw new Error("telegram-connection-store-write-failed");
        },
      });
      failing.setOffset(site.offset);
      failing.queue(site.batch);
      // Resolves only because the loop gave up. Reaching this line at all is
      // half the assertion: a loop that carried on would park on the next poll
      // until the test times out.
      await start(failing.options).finished;
      running = undefined;
      expect(failing.onFatal.mock.calls, site.name)
        .toEqual([["telegram-connection-state-unwritable"]]);

      // Non-vacuous: the identical batch through a store that takes the write
      // neither stops nor reports anything.
      const healthy = harness();
      healthy.setOffset(site.offset);
      healthy.queue(site.batch);
      const survivor = start(healthy.options);
      await vi.waitFor(() => expect(healthy.recordPollOffset).toHaveBeenCalled());
      expect(healthy.onFatal, site.name).not.toHaveBeenCalled();
      survivor.stop();
      await survivor.finished;
      running = undefined;
    }
  });

  it("backs off for the interval Telegram asked for", async () => {
    const waits: number[] = [];
    const h = harness({ wait: async (ms) => { waits.push(ms); } });
    h.queue({ ok: false, reason: "rate-limited", retryAfterMs: 9_000 });
    start(h.options);

    await vi.waitFor(() => expect(waits).toContain(9_000));
    expect(h.onFatal).not.toHaveBeenCalled();
  });

  it("rejects an unusable configuration", () => {
    const h = harness();
    expect(() => startTelegramPollingIngress({
      ...h.options,
      onFatal: undefined as never,
    })).toThrow("telegram-polling-ingress-options-invalid");
  });

  // ── Pre-envelope drop counter ─────────────────────────
  //
  // Updates refused before an envelope exists are the one class the notice
  // path cannot reach: there is no verified sender to answer. Their only
  // trace is this tally, so these tests assert what a line says, not that
  // logging happened.
  describe("pre-envelope drops", () => {
    function counted(overrides: Partial<TelegramPollingIngressOptions> = {}) {
      const lines: string[] = [];
      return {
        ...harness({ log: (message: string) => { lines.push(message); }, ...overrides }),
        dropLines: () => lines.filter((line) => line.includes("pre-envelope drop")),
      };
    }

    /** Read a line's numbers so an assertion pins values, not prose. */
    function tally(line: string): { total: number; reasons: Record<string, number> } {
      const reasons: Record<string, number> = {};
      let total = -1;
      for (const [, key, value] of line.matchAll(/([\w-]+)=(\d+)/g)) {
        if (key === "total") total = Number(value);
        else reasons[key as string] = Number(value);
      }
      return { total, reasons };
    }

    async function stopAndDrain(ingress: TelegramPollingIngress): Promise<void> {
      ingress.stop();
      await ingress.finished;
      running = undefined;
    }

    it("counts an update the adapter could not turn into an envelope", async () => {
      const h = counted();
      h.queue({ ok: true, value: [nonMessageUpdate(300)] });
      const ingress = start(h.options);

      await vi.waitFor(() => expect(h.currentOffset()).toBe(301));
      await stopAndDrain(ingress);

      const lines = h.dropLines();
      expect(lines).toHaveLength(2);
      expect(tally(lines[lines.length - 1] as string)).toEqual({
        total: 1,
        reasons: { "unparsable-update": 1 },
      });
    });

    it("counts each gateway outcome decided before an envelope exists", async () => {
      for (const outcome of [
        "invalid-request",
        "request-too-large",
        "verification-failed",
        "invalid-envelope",
      ] as PlatformBridgeInboundResult[]) {
        const h = counted();
        h.handleWebhook.mockResolvedValue(outcome);
        h.queue({ ok: true, value: [textUpdate(200, "hello")] });
        const ingress = start(h.options);

        // The offset moving is what makes this a drop rather than a retry, so
        // the tally below is counting something that was really lost.
        await vi.waitFor(() => expect(h.currentOffset()).toBe(201));
        await stopAndDrain(ingress);

        const lines = h.dropLines();
        expect(tally(lines[lines.length - 1] as string)).toEqual({
          total: 1,
          reasons: { [outcome]: 1 },
        });
      }
    });

    it("counts nothing for an outcome that had an envelope to refuse", async () => {
      for (const outcome of [
        "accepted",
        "duplicate",
        "slash-command-rejected",
        "authorization-denied",
        "idempotency-conflict",
        "command-outcome-unknown",
      ] as PlatformBridgeInboundResult[]) {
        const h = counted();
        h.handleWebhook.mockResolvedValue(outcome);
        h.queue({ ok: true, value: [textUpdate(200, "hello")] });
        const ingress = start(h.options);

        await vi.waitFor(() => expect(h.currentOffset()).toBe(201));
        await stopAndDrain(ingress);

        expect(h.dropLines()).toEqual([]);
      }
    });

    it("counts nothing when the core re-polls instead of consuming", async () => {
      const h = counted();
      // Pre-envelope like the counted four, but it releases the update for
      // retry. Counting it would report a turned-off bridge as data loss.
      h.handleWebhook.mockResolvedValue("disabled");
      h.queue({ ok: true, value: [textUpdate(210, "hello")] });
      const ingress = start(h.options);

      await vi.waitFor(() => expect(h.handleWebhook).toHaveBeenCalled());
      expect(h.currentOffset()).toBe(100);
      await stopAndDrain(ingress);

      expect(h.dropLines()).toEqual([]);
    });

    it("counts nothing for a pairing code it consumed on purpose", async () => {
      const code = mintTelegramPairingCode();
      const h = counted();
      h.queue({ ok: true, value: [textUpdate(220, code)] });
      const ingress = start(h.options);

      await vi.waitFor(() => expect(h.currentOffset()).toBe(221));
      await stopAndDrain(ingress);

      // The update never reached the gateway, but it was consumed deliberately
      // rather than lost.
      expect(h.handleWebhook).not.toHaveBeenCalled();
      expect(h.dropLines()).toEqual([]);
    });

    it("names each reason the first time it appears", async () => {
      const h = counted();
      h.handleWebhook.mockResolvedValue("verification-failed");
      h.queue({
        ok: true,
        value: [nonMessageUpdate(400), textUpdate(401, "hello")],
      });
      const ingress = start(h.options);

      await vi.waitFor(() => expect(h.currentOffset()).toBe(402));
      await stopAndDrain(ingress);

      const lines = h.dropLines();
      expect(lines.filter((line) => line.includes("first of this kind"))).toHaveLength(2);
      expect(tally(lines[lines.length - 1] as string)).toEqual({
        total: 2,
        reasons: { "unparsable-update": 1, "verification-failed": 1 },
      });
    });

    it("reports at the first of a kind, at a power of ten, and once on exit", async () => {
      const h = counted();
      h.queue({
        ok: true,
        value: Array.from({ length: 12 }, (_, index) => nonMessageUpdate(500 + index)),
      });
      const ingress = start(h.options);

      await vi.waitFor(() => expect(h.currentOffset()).toBe(512));
      await stopAndDrain(ingress);

      // Anyone who can message the bot can drive this count, so a line per
      // drop would hand them the desktop log. Twelve drops, three lines.
      expect(h.dropLines().map((line) => tally(line).total)).toEqual([1, 10, 12]);
    });

    it("starts a fresh tally for each activation", async () => {
      const first = counted();
      first.queue({ ok: true, value: [nonMessageUpdate(600), nonMessageUpdate(601)] });
      const firstIngress = start(first.options);
      await vi.waitFor(() => expect(first.currentOffset()).toBe(602));
      await stopAndDrain(firstIngress);
      expect(tally(first.dropLines().at(-1) as string).total).toBe(2);

      const second = counted();
      second.queue({ ok: true, value: [nonMessageUpdate(700)] });
      const secondIngress = start(second.options);
      await vi.waitFor(() => expect(second.currentOffset()).toBe(701));
      await stopAndDrain(secondIngress);

      // A tally that outlived its activation would read 3 here.
      expect(tally(second.dropLines().at(-1) as string).total).toBe(1);
    });
  });
});
