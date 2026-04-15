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

  get length(): number {
    return this.messages.length;
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
