/**
 * Unit tests for the shared Telegram connection validators.
 *
 * `isTelegramBotUsername` gates the post-`getMe` identity check in the connect
 * flow, and a failure there is surfaced as `telegram-provider-unreachable` —
 * so an over-tight grammar here turns a VALID bot into a phantom network
 * error. The length-boundary cases below pin the BotFather contract: 5-32
 * chars total, `bot` suffix (case-insensitive), leading letter.
 */
import { describe, expect, it } from "vitest";

import { isTelegramBotUsername, isTelegramBotToken, TELEGRAM_BOT_TOKEN_PATH_GRAMMAR } from "../telegram-connection.js";

describe("isTelegramBotUsername", () => {
  it("accepts the 5-char minimum handle (regression: 5-6 char handles were rejected)", () => {
    expect(isTelegramBotUsername("aebot")).toBe(true);
    expect(isTelegramBotUsername("a1bot")).toBe(true);
  });

  it("accepts a 6-char handle", () => {
    expect(isTelegramBotUsername("ae_bot")).toBe(true);
  });

  it("accepts the 32-char maximum handle", () => {
    // 1 leading letter + 28 middle + "bot" = 32.
    expect(isTelegramBotUsername(`a${"x".repeat(28)}bot`)).toBe(true);
  });

  it("rejects a 33-char handle", () => {
    expect(isTelegramBotUsername(`a${"x".repeat(29)}bot`)).toBe(false);
  });

  it("rejects a 4-char handle even with the bot suffix", () => {
    expect(isTelegramBotUsername("abot")).toBe(false);
  });

  it("accepts a case-mixed bot suffix", () => {
    expect(isTelegramBotUsername("lvis_ownerBOT")).toBe(true);
    expect(isTelegramBotUsername("lvis_ownerBot")).toBe(true);
  });

  it("rejects a handle without the bot suffix", () => {
    expect(isTelegramBotUsername("lvis_owner")).toBe(false);
  });

  it("rejects a leading digit or underscore", () => {
    expect(isTelegramBotUsername("1lvisbot")).toBe(false);
    expect(isTelegramBotUsername("_lvisbot")).toBe(false);
  });

  it("rejects characters outside the handle alphabet", () => {
    expect(isTelegramBotUsername("lvis-ownerbot")).toBe(false);
    expect(isTelegramBotUsername("lvis ownerbot")).toBe(false);
  });

  it("rejects non-string input", () => {
    expect(isTelegramBotUsername(undefined)).toBe(false);
    expect(isTelegramBotUsername(42)).toBe(false);
  });
});

describe("TELEGRAM_BOT_TOKEN_PATH_GRAMMAR", () => {
  it("is the URL-safety bound: every plausible token passes it, and nothing outside the path alphabet does", () => {
    const plausible = "123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    expect(isTelegramBotToken(plausible)).toBe(true);
    expect(TELEGRAM_BOT_TOKEN_PATH_GRAMMAR.test(plausible)).toBe(true);
    expect(TELEGRAM_BOT_TOKEN_PATH_GRAMMAR.test("abc/../def")).toBe(false);
    expect(TELEGRAM_BOT_TOKEN_PATH_GRAMMAR.test("a?b=c")).toBe(false);
    expect(TELEGRAM_BOT_TOKEN_PATH_GRAMMAR.test("x".repeat(257))).toBe(false);
  });
});
