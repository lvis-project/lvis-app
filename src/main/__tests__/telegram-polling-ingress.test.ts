import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlatformBridgeInboundResult } from "../platform-bridge-inbound.js";
import type { TelegramBotApiResult, TelegramPolledUpdate } from "../telegram-bot-api-client.js";
import { mintTelegramPairingCode, telegramPairingCodeDigest } from "../telegram-pairing-code.js";
import {
  startTelegramPollingIngress,
  type TelegramPollingIngress,
  type TelegramPollingIngressOptions,
} from "../telegram-polling-ingress.js";

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
  const consumePairingAttempt = vi.fn(async () => {});
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
    consumePairingAttempt,
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
    consumePairingAttempt,
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

  it("charges an attempt for a near miss and still never forwards it", async () => {
    const wrong = mintTelegramPairingCode();
    const h = harness();
    h.queue({ ok: true, value: [textUpdate(30, wrong)] });
    start(h.options);

    await vi.waitFor(() => expect(h.consumePairingAttempt).toHaveBeenCalledOnce());
    // A code-shaped credential must not reach the transcript even when wrong.
    expect(h.handleWebhook).not.toHaveBeenCalled();
  });

  it("stays silent when a code arrives with nothing pending", async () => {
    const code = mintTelegramPairingCode();
    const h = harness({ hasPendingPairingCode: () => false });
    h.queue({ ok: true, value: [textUpdate(40, code)] });
    start(h.options);

    await vi.waitFor(() => expect(h.currentOffset()).toBe(41));
    expect(h.options.redeemPairingCode).not.toHaveBeenCalled();
    expect(h.consumePairingAttempt).not.toHaveBeenCalled();
    expect(h.handleWebhook).not.toHaveBeenCalled();
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
});
