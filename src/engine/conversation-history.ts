/**
 * Conversation History — §4.5.2 Step 3
 *
 * 인메모리 GenericMessage 배열 관리. LLM Provider에 전달되는 대화 이력.
 * 벤더 추상화: Anthropic.MessageParam 대신 GenericMessage 사용.
 */
import type { GenericMessage } from "./llm/types.js";

export interface ConversationHistoryOptions {
  maxMessages?: number;
}

export class ConversationHistory {
  private messages: GenericMessage[] = [];
  private readonly maxMessages: number;

  constructor(options?: ConversationHistoryOptions) {
    this.maxMessages = options?.maxMessages ?? 50;
  }

  append(message: GenericMessage): void {
    this.messages.push(stampCreatedAt(message));
    this.trim();
  }

  /**
   * Attach `turnSummary` to the last assistant message. Dedicated entry-point
   * (rather than a generic meta merge) so the type system enforces every
   * required turnSummary field — including `freshInputTokens` — at every
   * future call site, not just the one in conversation-loop today.
   *
   * No-op when there is no assistant message yet (rare tool-only termination).
   *
   * Mutation contract: `getMessages()` returns a shallow copy of the array
   * but each element is the same object reference held internally, so an
   * `attachTurnSummaryToLastAssistant` call AFTER a getMessages() snapshot
   * IS visible through that snapshot. This is intentional — the persistence
   * path (`saveSession`) calls `getMessages()` followed by attach so both
   * see the same final meta.
   */
  attachTurnSummaryToLastAssistant(
    turnSummary: NonNullable<NonNullable<GenericMessage["meta"]>["turnSummary"]>,
  ): void {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.role === "assistant") {
        m.meta = { ...(m.meta ?? {}), turnSummary };
        return;
      }
    }
  }

  /**
   * Returns a SHALLOW copy of the messages array. Each element is the same
   * object reference held internally — mutations applied via
   * `attachTurnSummaryToLastAssistant` (or any future meta mutator) are
   * visible through previously-returned snapshots. This is intentional:
   * `saveSession` reads a snapshot then the loop attaches turnSummary, and
   * both must see the same final meta.
   */
  getMessages(): GenericMessage[] {
    return [...this.messages];
  }

  repairToolPairInvariant(): { removedMessages: number; removedToolCalls: number } {
    const { messages, removedMessages, removedToolCalls } = normalizeToolPairInvariant(this.messages);
    if (removedMessages > 0 || removedToolCalls > 0) {
      this.messages = messages;
    }
    return { removedMessages, removedToolCalls };
  }

  clear(): void {
    this.messages = [];
  }

  restore(messages: GenericMessage[]): void {
    // Restore from disk — preserve original createdAt (set on prior session
    // turn) rather than restamping with the load time. Messages with no
    // createdAt (legacy sessions written before the field existed) stay
    // undefined — UI renders nothing rather than fake a fresh timestamp.
    this.messages = normalizeToolPairInvariant(messages).messages;
    this.trim();
  }

  /**
   * Sprint 4.C — edit/fork support. Keep only the first `count` messages.
   * No-op if `count` is >= current length or negative.
   */
  truncate(count: number): void {
    if (count < 0) return;
    if (count >= this.messages.length) return;
    this.messages = this.messages.slice(0, count);
  }

  get length(): number {
    return this.messages.length;
  }

  /**
   * How many more messages can be appended before `trim()` would start
   * dropping the oldest entries. Used by the trigger-import path to refuse
   * imports that would silently evict user chat history.
   */
  getCapacityRemaining(): number {
    return Math.max(0, this.maxMessages - this.messages.length);
  }

  getLastAssistantText(): string {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const msg = this.messages[i];
      if (msg.role === "assistant") return msg.content;
    }
    return "";
  }

  private trim(): void {
    if (this.messages.length > this.maxMessages) {
      this.messages = this.messages.slice(-this.maxMessages);
      this.messages = normalizeToolPairInvariant(this.messages, { preserveOpenToolTail: true }).messages;
    }
  }
}

interface NormalizeToolPairOptions {
  preserveOpenToolTail?: boolean;
}

/**
 * Stamp `meta.createdAt` (wall-clock epoch ms) on any incoming message that
 * doesn't already carry one. Append boundary is the single chokepoint for
 * every message route (user input, LLM round assistant, executor tool_result,
 * structured-compact boundary) so this is the right place to ensure every
 * persisted row has a creation time. Existing createdAt is preserved so
 * restored or programmatically-constructed messages keep their original time.
 */
function stampCreatedAt(message: GenericMessage): GenericMessage {
  if (message.meta?.createdAt !== undefined) return message;
  return { ...message, meta: { ...(message.meta ?? {}), createdAt: Date.now() } };
}

export function normalizeToolPairInvariant(
  messages: GenericMessage[],
  options: NormalizeToolPairOptions = {},
): {
  messages: GenericMessage[];
  removedMessages: number;
  removedToolCalls: number;
} {
  const futureResultCounts = new Map<string, number>();
  for (const message of messages) {
    if (message.role === "tool_result") {
      futureResultCounts.set(message.toolUseId, (futureResultCounts.get(message.toolUseId) ?? 0) + 1);
    }
  }

  const availableToolCalls = new Set<string>();
  const normalized: GenericMessage[] = [];
  let removedMessages = 0;
  let removedToolCalls = 0;

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
      const isOpenToolTail =
        options.preserveOpenToolTail === true &&
        messages.slice(i + 1).every((next) => next.role === "tool_result");
      const pairedToolCalls = isOpenToolTail
        ? message.toolCalls
        : message.toolCalls.filter((toolCall) => (futureResultCounts.get(toolCall.id) ?? 0) > 0);
      removedToolCalls += message.toolCalls.length - pairedToolCalls.length;

      if (pairedToolCalls.length > 0) {
        for (const toolCall of pairedToolCalls) {
          availableToolCalls.add(toolCall.id);
        }
        normalized.push({ ...message, toolCalls: pairedToolCalls });
        continue;
      }

      const { toolCalls: _toolCalls, ...withoutToolCalls } = message;
      const hasVisibleAssistantPayload =
        withoutToolCalls.content.length > 0 ||
        Boolean(withoutToolCalls.thought && withoutToolCalls.thought.length > 0) ||
        Boolean(withoutToolCalls.thinkingBlocks && withoutToolCalls.thinkingBlocks.length > 0);
      if (hasVisibleAssistantPayload) {
        normalized.push(withoutToolCalls);
      } else {
        removedMessages += 1;
      }
      continue;
    }

    if (message.role === "tool_result") {
      const count = futureResultCounts.get(message.toolUseId) ?? 0;
      if (count <= 1) {
        futureResultCounts.delete(message.toolUseId);
      } else {
        futureResultCounts.set(message.toolUseId, count - 1);
      }
      if (availableToolCalls.has(message.toolUseId)) {
        normalized.push(message);
        availableToolCalls.delete(message.toolUseId);
      } else {
        removedMessages += 1;
      }
      continue;
    }

    normalized.push(message);
  }

  return {
    messages: normalized,
    removedMessages,
    removedToolCalls,
  };
}
