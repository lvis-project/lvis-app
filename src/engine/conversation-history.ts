/**
 * Conversation History — §4.5.2 Step 3
 *
 * 인메모리 GenericMessage 배열 관리. LLM Provider에 전달되는 대화 이력.
 * 벤더 추상화: Anthropic.MessageParam 대신 GenericMessage 사용.
 */
import type { GenericMessage, ToolCallBlock } from "./llm/types.js";

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
    this.messages.push(message);
    this.trim();
  }

  getMessages(): GenericMessage[] {
    return [...this.messages];
  }

  clear(): void {
    this.messages = [];
  }

  restore(messages: GenericMessage[]): void {
    this.messages = [...messages];
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
    }
  }
}
