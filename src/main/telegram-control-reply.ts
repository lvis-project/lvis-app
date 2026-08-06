/**
 * Host-authored control notices for the Telegram surface.
 *
 * The conversation delivery path is fenced by the route guard, which is exactly
 * the fence that is closed when there is nothing to say. Without a second path
 * an unroutable message from the paired owner vanishes: the ingress consumes
 * the update, advances the offset, and sends nothing — indistinguishable from a
 * dead bot.
 *
 * This module is that second path, and it is deliberately narrow:
 *
 * - it speaks ONLY to an already-paired owner, never to a stranger, because a
 *   reply to an unknown sender would confirm that this bot is attached to a
 *   live desktop;
 * - it sends fixed host text with no conversation material of any kind;
 * - it is cooldown-gated per chat, so a flood of unroutable messages cannot
 *   turn the bridge into a reply amplifier;
 * - a send failure is swallowed. A notice is best-effort by definition; failing
 *   the ingress over one would be worse than staying quiet.
 */
import { t } from "../i18n/index.js";
import type { TelegramBotApiClient } from "./telegram-bot-api-client.js";

/**
 * One notice per chat per window. Long on purpose: this says "your surface is
 * idle", which does not become more true by being repeated.
 */
export const TELEGRAM_CONTROL_REPLY_COOLDOWN_MS = 10 * 60 * 1_000;
/** Bounded so a stream of distinct chat/notice pairs cannot grow this forever. */
const MAX_TRACKED_KEYS = 128;

export type TelegramControlNotice =
  | "conversation-not-shared"
  | "commands-not-supported";

export interface TelegramControlReplySender {
  /**
   * Send `notice` to a paired owner unless the cooldown is still open.
   * Resolves to whether a send was actually attempted.
   */
  notify(chatId: string, notice: TelegramControlNotice): Promise<boolean>;
}

export interface CreateTelegramControlReplySenderOptions {
  readonly client: TelegramBotApiClient;
  readonly now?: () => number;
  readonly cooldownMs?: number;
  readonly log?: (message: string) => void;
}

export function createTelegramControlReplySender(
  options: CreateTelegramControlReplySenderOptions,
): TelegramControlReplySender {
  if (!options || typeof options.client?.sendMessage !== "function") {
    throw new TypeError("telegram-control-reply-options-invalid");
  }
  const now = options.now ?? Date.now;
  const cooldownMs = options.cooldownMs ?? TELEGRAM_CONTROL_REPLY_COOLDOWN_MS;
  if (!Number.isSafeInteger(cooldownMs) || cooldownMs < 0) {
    throw new RangeError("telegram-control-reply-cooldown-invalid");
  }
  const lastSentAt = new Map<string, number>();

  return Object.freeze({
    async notify(chatId: string, notice: TelegramControlNotice): Promise<boolean> {
      const at = now();
      // Keyed by notice as well as chat: "nothing is shared" and "commands are
      // not supported" are different problems, and one must not silence the
      // other for ten minutes.
      const key = `${chatId}:${notice}`;
      const previous = lastSentAt.get(key);
      if (previous !== undefined && at - previous < cooldownMs) return false;

      // Record before sending: a provider failure must still hold the cooldown,
      // or a persistently failing send would retry on every inbound message.
      if (lastSentAt.size >= MAX_TRACKED_KEYS && !lastSentAt.has(key)) {
        const oldest = [...lastSentAt.entries()].sort((a, b) => a[1] - b[1])[0];
        if (oldest !== undefined) lastSentAt.delete(oldest[0]);
      }
      lastSentAt.set(key, at);

      try {
        await options.client.sendMessage(chatId, noticeText(notice));
      } catch {
        options.log?.("[telegram-control] notice could not be delivered");
        return true;
      }
      return true;
    },
  });
}

function noticeText(notice: TelegramControlNotice): string {
  switch (notice) {
    case "conversation-not-shared":
      return t("be_telegramBridge.conversationNotShared");
    case "commands-not-supported":
      return t("be_telegramBridge.commandsNotSupported");
  }
}
