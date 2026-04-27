/**
 * Reactive Compact Recovery — tests
 *
 * Verifies that the conversation loop catches context-length errors from providers,
 * compacts history, retries once, and does NOT retry on other error types.
 */
import { describe, expect, it } from "vitest";

import { isContextLengthError } from "../auto-compact.js";
import { ConversationLoop } from "../conversation-loop.js";
import type { LLMProvider, StreamEvent } from "../llm/types.js";
import { KeywordEngine } from "../../core/keyword-engine.js";
import { RouteEngine } from "../../core/route-engine.js";
import { ToolRegistry } from "../../tools/registry.js";
import { fakeLlmSettings } from "../../shared/__tests__/fake-llm-settings.js";

// ─── Helpers ────────────────────────────────────────

function makeLoop(provider: LLMProvider): ConversationLoop {
  const toolRegistry = new ToolRegistry();
  const keywordEngine = new KeywordEngine();
  const routeEngine = new RouteEngine({ toolRegistry });

  const loop = new ConversationLoop(({
    settingsService: {
      get: (key: string) => key === "chat" ? { autoCompact: true } : fakeLlmSettings(),
      getSecret: () => "test-key",
    },
    systemPromptBuilder: { build: () => "system" },
    keywordEngine,
    routeEngine,
    toolRegistry,
    memoryManager: { saveSession: () => {}, listSessions: () => [] },
  } as unknown) as ConstructorParameters<typeof ConversationLoop>[0]);

  (loop as { provider: LLMProvider | null }).provider = provider;
  return loop;
}

/** Provider that throws on first call, yields normal events on second */
class ThrowThenSucceedProvider implements LLMProvider {
  readonly vendor = "openai" as const;
  private callCount = 0;

  constructor(
    private readonly throwError: Error,
    private readonly successEvents: StreamEvent[],
  ) {}

  async *streamTurn(): AsyncIterable<StreamEvent> {
    if (this.callCount === 0) {
      this.callCount++;
      throw this.throwError;
    }
    this.callCount++;
    yield* this.successEvents;
  }

  getCallCount(): number { return this.callCount; }
}

/** Provider that always throws */
class AlwaysThrowProvider implements LLMProvider {
  readonly vendor = "openai" as const;
  private callCount = 0;

  constructor(private readonly throwError: Error) {}

  async *streamTurn(): AsyncIterable<StreamEvent> {
    this.callCount++;
    throw this.throwError;
  }

  getCallCount(): number { return this.callCount; }
}

/** Provider that emits error stream event on first call, succeeds on second */
class ErrorEventThenSucceedProvider implements LLMProvider {
  readonly vendor = "openai" as const;
  private callCount = 0;

  constructor(
    private readonly errorMsg: string,
    private readonly successEvents: StreamEvent[],
  ) {}

  async *streamTurn(): AsyncIterable<StreamEvent> {
    if (this.callCount === 0) {
      this.callCount++;
      yield { type: "error", error: this.errorMsg };
      return;
    }
    this.callCount++;
    yield* this.successEvents;
  }

  getCallCount(): number { return this.callCount; }
}

/** Provider that always succeeds */
class SuccessProvider implements LLMProvider {
  readonly vendor = "openai" as const;
  private callCount = 0;

  constructor(private readonly events: StreamEvent[]) {}

  async *streamTurn(): AsyncIterable<StreamEvent> {
    this.callCount++;
    yield* this.events;
  }

  getCallCount(): number { return this.callCount; }
}

// ─── isContextLengthError unit tests ─────────────────

describe("isContextLengthError()", () => {
  it("detects Anthropic prompt-too-long message", () => {
    expect(isContextLengthError(new Error("This request would exceed the model's prompt is too long limit"))).toBe(true);
  });

  it("detects OpenAI context_length_exceeded code", () => {
    const err = Object.assign(new Error("context length exceeded"), { code: "context_length_exceeded" });
    expect(isContextLengthError(err)).toBe(true);
  });

  it("detects OpenAI maximum context length message", () => {
    expect(isContextLengthError(new Error("This model's maximum context length is 128000 tokens"))).toBe(true);
  });

  it("detects Gemini context window message", () => {
    expect(isContextLengthError(new Error("Input exceeds the context window size"))).toBe(true);
  });

  it("returns false for auth errors", () => {
    expect(isContextLengthError(new Error("401 Unauthorized: invalid api key"))).toBe(false);
  });

  it("returns false for rate limit errors", () => {
    expect(isContextLengthError(new Error("429 Too Many Requests: rate limit exceeded"))).toBe(false);
  });

  it("returns false for non-Error values", () => {
    expect(isContextLengthError("string error")).toBe(false);
    expect(isContextLengthError(null)).toBe(false);
    expect(isContextLengthError(42)).toBe(false);
  });
});

// ─── Reactive recovery integration tests ─────────────

describe("ConversationLoop reactive compact recovery", () => {
  const successEvents: StreamEvent[] = [
    { type: "text_delta", text: "재시도 성공" },
    { type: "message_complete", stopReason: "end_turn" },
  ];

  it("retries once after context-length error and succeeds", async () => {
    const contextError = Object.assign(
      new Error("This model's maximum context length is 128000 tokens"),
      { code: "context_length_exceeded" },
    );
    const provider = new ThrowThenSucceedProvider(contextError, successEvents);
    const loop = makeLoop(provider);

    // Populate history with enough messages to compact
    const history = loop.getHistory();
    for (let i = 0; i < 10; i++) {
      history.append({ role: "user", content: `메시지 ${i}` });
      history.append({ role: "assistant", content: `응답 ${i}` });
    }

    const result = await loop.runTurn("새 질문", {});
    expect(result.text).toBe("재시도 성공");
    expect(provider.getCallCount()).toBe(2); // threw once, succeeded on retry
  });

  it("does NOT retry on non-context errors (auth error)", async () => {
    const authError = new Error("401 Unauthorized");
    const provider = new AlwaysThrowProvider(authError);
    const loop = makeLoop(provider);

    await expect(loop.runTurn("질문", {})).rejects.toThrow("401 Unauthorized");
    expect(provider.getCallCount()).toBe(1); // no retry
  });

  it("does NOT retry on rate-limit errors", async () => {
    const rateLimitError = new Error("429 rate limit exceeded");
    const provider = new AlwaysThrowProvider(rateLimitError);
    const loop = makeLoop(provider);

    await expect(loop.runTurn("질문", {})).rejects.toThrow("rate limit");
    expect(provider.getCallCount()).toBe(1);
  });

  it("propagates error if retry also fails (no infinite loop)", async () => {
    // Make the message match isContextLengthError
    const ctxErr = new Error("prompt is too long even after compact");
    const provider = new AlwaysThrowProvider(ctxErr);
    const loop = makeLoop(provider);

    // Populate history
    for (let i = 0; i < 10; i++) {
      loop.getHistory().append({ role: "user", content: `메시지 ${i}` });
      loop.getHistory().append({ role: "assistant", content: `응답 ${i}` });
    }

    await expect(loop.runTurn("질문", {})).rejects.toThrow("prompt is too long");
    // First call throws → compact → second call throws → propagate (total 2 calls)
    expect(provider.getCallCount()).toBe(2);
  });

  it("retries once after context-length stream error event and succeeds", async () => {
    const provider = new ErrorEventThenSucceedProvider(
      "This model's maximum context length is 128000 tokens",
      successEvents,
    );
    const loop = makeLoop(provider);

    // Populate history with enough messages to compact
    const history = loop.getHistory();
    for (let i = 0; i < 10; i++) {
      history.append({ role: "user", content: `메시지 ${i}` });
      history.append({ role: "assistant", content: `응답 ${i}` });
    }

    const result = await loop.runTurn("새 질문", {});
    expect(result.text).toBe("재시도 성공");
    expect(provider.getCallCount()).toBe(2); // error event once, succeeded on retry
  });

  it("does not trigger reactive compact on normal turns", async () => {
    const provider = new SuccessProvider(successEvents);
    const loop = makeLoop(provider);

    const result = await loop.runTurn("정상 질문", {});
    expect(result.text).toBe("재시도 성공");
    expect(provider.getCallCount()).toBe(1); // single call, no retry
  });
});
