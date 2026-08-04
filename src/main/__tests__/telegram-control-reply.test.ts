import { describe, expect, it, vi } from "vitest";
import type { TelegramBotApiClient } from "../telegram-bot-api-client.js";
import {
  TELEGRAM_CONTROL_REPLY_COOLDOWN_MS,
  createTelegramControlReplySender,
} from "../telegram-control-reply.js";

const OWNER_CHAT = "123456789";

function harness(overrides: { readonly failSend?: boolean } = {}) {
  const sendMessage = vi.fn(async () => {
    if (overrides.failSend) throw new Error("provider unavailable");
    return { ok: true as const, value: true as const };
  });
  const clock = { at: 1_700_000_000_000 };
  const sender = createTelegramControlReplySender({
    client: { sendMessage } as unknown as TelegramBotApiClient,
    now: () => clock.at,
  });
  return { sender, sendMessage, clock };
}

describe("createTelegramControlReplySender", () => {
  it("says something rather than nothing when a surface is idle", async () => {
    const h = harness();

    await expect(h.sender.notify(OWNER_CHAT, "conversation-not-shared")).resolves.toBe(true);
    expect(h.sendMessage).toHaveBeenCalledOnce();
    const [chatId, text] = h.sendMessage.mock.calls[0] as unknown as [string, string];
    expect(chatId).toBe(OWNER_CHAT);
    expect(text.length).toBeGreaterThan(0);
  });

  it("carries no conversation material, only fixed host text", async () => {
    const h = harness();
    await h.sender.notify(OWNER_CHAT, "conversation-not-shared");
    const [, text] = h.sendMessage.mock.calls[0] as unknown as [string, string];

    // Whatever the wording, it must not name a conversation, a session, or an id.
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i);
    expect(text).not.toContain(OWNER_CHAT);
    expect(text.length).toBeLessThanOrEqual(512);
  });

  it("cannot be turned into a reply amplifier", async () => {
    const h = harness();

    await h.sender.notify(OWNER_CHAT, "conversation-not-shared");
    for (let i = 0; i < 20; i += 1) {
      await expect(h.sender.notify(OWNER_CHAT, "conversation-not-shared")).resolves.toBe(false);
    }
    expect(h.sendMessage).toHaveBeenCalledOnce();

    // Non-vacuous: once the window passes, the owner can be told again.
    h.clock.at += TELEGRAM_CONTROL_REPLY_COOLDOWN_MS;
    await expect(h.sender.notify(OWNER_CHAT, "conversation-not-shared")).resolves.toBe(true);
    expect(h.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("holds the cooldown even when the send failed", async () => {
    const h = harness({ failSend: true });

    await expect(h.sender.notify(OWNER_CHAT, "conversation-not-shared")).resolves.toBe(true);
    // A failing provider must not mean a retry on every inbound message.
    await expect(h.sender.notify(OWNER_CHAT, "conversation-not-shared")).resolves.toBe(false);
    expect(h.sendMessage).toHaveBeenCalledOnce();
  });

  it("tracks each paired chat's cooldown separately", async () => {
    const h = harness();
    await h.sender.notify(OWNER_CHAT, "conversation-not-shared");
    await expect(h.sender.notify("987654321", "conversation-not-shared")).resolves.toBe(true);
    expect(h.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("rejects an unusable configuration", () => {
    expect(() => createTelegramControlReplySender({ client: {} as never }))
      .toThrow("telegram-control-reply-options-invalid");
    expect(() => createTelegramControlReplySender({
      client: { sendMessage: vi.fn() } as unknown as TelegramBotApiClient,
      cooldownMs: -1,
    })).toThrow("telegram-control-reply-cooldown-invalid");
  });
});
