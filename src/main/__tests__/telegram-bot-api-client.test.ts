import { describe, expect, it, vi } from "vitest";
import { createTelegramBotApiClient } from "../telegram-bot-api-client.js";

const BOT_TOKEN = "123456789:abcdefghijklmnopqrstuvwxyz_ABCDEF";

function json(value: unknown, init: ResponseInit = {}): Response {
  const body = JSON.stringify(value);
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function client(fetchImplementation: typeof fetch) {
  return createTelegramBotApiClient({ botToken: BOT_TOKEN, fetchImplementation });
}

function requestBody(call: unknown[]): Record<string, unknown> {
  const init = call[1] as RequestInit;
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

function message(updateId: number, text: string) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId + 1,
      date: 1_700_000_000,
      from: { id: 123456789, is_bot: false },
      chat: { id: 123456789, type: "private" },
      text,
    },
  };
}

describe("TelegramBotApiClient", () => {
  it("reads the bot identity and reports an already-registered webhook", async () => {
    const fetchStub = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target.endsWith("/getMe")) {
        return json({ ok: true, result: { id: 1, is_bot: true, username: "my_assistant_bot" } });
      }
      return json({ ok: true, result: { url: "https://example.com/telegram/webhook" } });
    }) as unknown as typeof fetch;
    const api = client(fetchStub);

    await expect(api.getMe()).resolves.toEqual({ ok: true, value: { username: "my_assistant_bot" } });
    await expect(api.getWebhookInfo()).resolves.toEqual({ ok: true, value: { hasWebhook: true } });
  });

  it("treats an empty webhook url as no webhook", async () => {
    const api = client(vi.fn(async () => json({ ok: true, result: { url: "" } })) as unknown as typeof fetch);
    await expect(api.getWebhookInfo()).resolves.toEqual({ ok: true, value: { hasWebhook: false } });
  });

  it("always asks for a bounded batch of message updates only", async () => {
    const fetchStub = vi.fn(async () => json({ ok: true, result: [] }));
    const api = client(fetchStub as unknown as typeof fetch);

    await api.getUpdates({ offset: 42 });

    const body = requestBody(fetchStub.mock.calls[0] as unknown as unknown[]);
    expect(body).toMatchObject({ offset: 42, allowed_updates: ["message"] });
    // An omitted limit would inherit Telegram's default of 100, and an omitted
    // allowed_updates would inherit whatever a prior setWebhook configured.
    expect(body.limit).toBe(25);
    expect(typeof body.timeout).toBe("number");
  });

  it("returns each update as the exact bytes the ingress core will re-validate", async () => {
    const updates = [message(10, "first"), message(11, "second")];
    const api = client(vi.fn(async () => json({ ok: true, result: updates })) as unknown as typeof fetch);

    const result = await api.getUpdates();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((entry) => entry.updateId)).toEqual([10, 11]);
    expect(JSON.parse(Buffer.from(result.value[0]!.rawBody).toString("utf8"))).toEqual(updates[0]);
  });

  it("classifies 409 by status alone, whatever the description says", async () => {
    for (const description of [
      "Conflict: terminated by other getUpdates request",
      "Conflict: can't use getUpdates method while webhook is active",
      "something Telegram has not documented",
    ]) {
      const api = client(vi.fn(async () => json(
        { ok: false, error_code: 409, description },
        { status: 409 },
      )) as unknown as typeof fetch);
      await expect(api.getUpdates()).resolves.toEqual({ ok: false, reason: "conflict" });
    }
  });

  it("surfaces flood control with the retry hint when Telegram supplies one", async () => {
    const withHeader = client(vi.fn(async () => json(
      { ok: false, error_code: 429 },
      { status: 429, headers: { "retry-after": "7" } },
    )) as unknown as typeof fetch);
    await expect(withHeader.getUpdates()).resolves.toEqual({
      ok: false,
      reason: "rate-limited",
      retryAfterMs: 7_000,
    });

    const withoutHeader = client(vi.fn(async () => json(
      { ok: false, error_code: 429 },
      { status: 429 },
    )) as unknown as typeof fetch);
    await expect(withoutHeader.getUpdates()).resolves.toEqual({ ok: false, reason: "rate-limited" });
  });

  it("rejects a wrong token as unauthorized rather than unreachable", async () => {
    const api = client(vi.fn(async () => json({ ok: false, error_code: 401 }, { status: 401 })) as unknown as typeof fetch);
    await expect(api.getMe()).resolves.toEqual({ ok: false, reason: "unauthorized" });
  });

  it("refuses an oversized body before parsing it", async () => {
    const declaredTooLarge = client(vi.fn(async () => new Response("{}", {
      status: 200,
      headers: { "content-length": String(8 * 1024 * 1024) },
    })) as unknown as typeof fetch);
    await expect(declaredTooLarge.getUpdates()).resolves.toEqual({ ok: false, reason: "invalid-response" });

    // Also cap a body that never declares its length.
    const oversized = "x".repeat(3 * 1024 * 1024);
    const undeclaredTooLarge = client(vi.fn(async () => new Response(
      JSON.stringify({ ok: true, result: [{ update_id: 1, filler: oversized }] }),
      { status: 200 },
    )) as unknown as typeof fetch);
    await expect(undeclaredTooLarge.getUpdates()).resolves.toEqual({ ok: false, reason: "invalid-response" });
  });

  it("refuses a batch it could not confirm, rather than skipping updates", async () => {
    const api = client(vi.fn(async () => json({
      ok: true,
      result: [message(5, "ok"), { message: { text: "no update_id" } }],
    })) as unknown as typeof fetch);
    await expect(api.getUpdates()).resolves.toEqual({ ok: false, reason: "invalid-response" });
  });

  it("never reaches a Bot API method that mutates the owner's bot", async () => {
    const fetchStub = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target.endsWith("/getMe")) return json({ ok: true, result: { username: "a_bot" } });
      if (target.endsWith("/getWebhookInfo")) return json({ ok: true, result: {} });
      return json({ ok: true, result: [] });
    });
    const api = client(fetchStub as unknown as typeof fetch);

    await api.getMe();
    await api.getWebhookInfo();
    await api.getUpdates({ offset: 1 });

    const targets = fetchStub.mock.calls.map((call) => String(call[0]));
    for (const forbidden of ["setWebhook", "deleteWebhook", "logOut", "close"]) {
      expect(targets.some((target) => target.endsWith(`/${forbidden}`))).toBe(false);
    }
    expect(targets).toHaveLength(3);
  });

  it("never lets the bot token escape through a transport failure", async () => {
    const api = client(vi.fn(async (url: string | URL | Request) => {
      // A real fetch rejection carries the request URL, which embeds the token.
      throw new Error(`request to ${String(url)} failed`);
    }) as unknown as typeof fetch);

    const result = await api.getMe();
    expect(result).toEqual({ ok: false, reason: "unreachable" });
    expect(JSON.stringify(result)).not.toContain(BOT_TOKEN);
  });

  it("rejects an unusable configuration instead of calling Telegram", async () => {
    expect(() => createTelegramBotApiClient({ botToken: "has/slash" })).toThrow(
      "telegram-bot-api-client-bot-token-invalid",
    );

    const fetchStub = vi.fn(async () => json({ ok: true, result: [] }));
    const api = client(fetchStub as unknown as typeof fetch);
    await expect(api.getUpdates({ limit: 1_000 })).rejects.toThrow(
      "telegram-bot-api-client-limit-invalid",
    );
    await expect(api.getUpdates({ offset: -2 })).rejects.toThrow(
      "telegram-bot-api-client-offset-invalid",
    );
    await expect(api.getUpdates({ timeoutSeconds: 600 })).rejects.toThrow(
      "telegram-bot-api-client-poll-timeout-invalid",
    );
    expect(fetchStub).not.toHaveBeenCalled();

    // -1 is the documented "most recent update" idiom used once to seed past a
    // backlog, so it must survive the same validation.
    await expect(api.getUpdates({ offset: -1 })).resolves.toEqual({ ok: true, value: [] });
    expect(requestBody(fetchStub.mock.calls[0] as unknown as unknown[]).offset).toBe(-1);
  });
});
