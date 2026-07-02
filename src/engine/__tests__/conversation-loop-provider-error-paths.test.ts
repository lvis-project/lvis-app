/**
 * C1 gap-lock — ConversationLoop provider ERROR paths (throw / stream-end /
 * timeout).
 *
 * `conversation-loop-generate-text.test.ts` already covers the `error`-EVENT
 * path for both `generateText` and `pingProvider` (provider yields an
 * `{ type: "error" }` chunk). What was NOT covered is what happens when the
 * provider's `streamTurn` THROWS (rejects) rather than yielding an error
 * chunk, plus `pingProvider`'s stream-ended and timeout branches. This file
 * locks that CURRENT observable behavior.
 */
import { describe, expect, it } from "vitest";

import { KeywordEngine } from "../../core/keyword-engine.js";
import { RouteEngine } from "../../core/route-engine.js";
import { ConversationLoop } from "../conversation-loop.js";
import type { LLMProvider, StreamEvent, StreamTurnParams } from "../llm/types.js";
import { ToolRegistry } from "../../tools/registry.js";
import { fakeLlmSettings } from "../../shared/__tests__/fake-llm-settings.js";

class ThrowingProvider implements LLMProvider {
  readonly vendor = "openai" as const;
  constructor(private readonly err: Error) {}
  // eslint-disable-next-line require-yield
  async *streamTurn(_params: StreamTurnParams): AsyncIterable<StreamEvent> {
    throw this.err;
  }
}

class EmptyStreamProvider implements LLMProvider {
  readonly vendor = "openai" as const;
  // eslint-disable-next-line require-yield
  async *streamTurn(_params: StreamTurnParams): AsyncIterable<StreamEvent> {
    // Yields nothing and never emits message_complete or error.
  }
}

class HangingProvider implements LLMProvider {
  readonly vendor = "openai" as const;
  async *streamTurn(params: StreamTurnParams): AsyncIterable<StreamEvent> {
    await new Promise<void>((_, reject) => {
      params.abortSignal?.addEventListener("abort", () =>
        reject(new Error("aborted")),
      );
    });
    yield { type: "message_complete", stopReason: "end_turn" };
  }
}

function buildLoop(provider: LLMProvider | null): ConversationLoop {
  const toolRegistry = new ToolRegistry();
  const keywordEngine = new KeywordEngine();
  const routeEngine = new RouteEngine({ toolRegistry });
  const loop = new ConversationLoop(({
    settingsService: {
      get: () => fakeLlmSettings(),
      getSecret: () => "test-key",
    },
    systemPromptBuilder: { build: () => "system" },
    keywordEngine,
    routeEngine,
    toolRegistry,
    memoryManager: { saveSession: () => {}, listSessions: () => [] },
  } as unknown) as ConstructorParameters<typeof ConversationLoop>[0]);
  (loop as unknown as { provider: LLMProvider | null }).provider = provider;
  return loop;
}

describe("ConversationLoop.generateText provider throw", () => {
  it("propagates a streamTurn rejection to the caller", async () => {
    const loop = buildLoop(new ThrowingProvider(new Error("boom-generate")));
    await expect(loop.generateText("prompt")).rejects.toThrow("boom-generate");
  });
});

describe("ConversationLoop.pingProvider error branches", () => {
  it("streamTurn throw → online:false with the thrown error message", async () => {
    const loop = buildLoop(new ThrowingProvider(new Error("boom-ping")));
    const result = await loop.pingProvider();
    expect(result).toMatchObject({
      configured: true,
      online: false,
      vendor: "openai",
      error: "boom-ping",
    });
    expect((result as { latencyMs: number }).latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("stream ends with no message_complete/error → error:'stream-ended'", async () => {
    const loop = buildLoop(new EmptyStreamProvider());
    const result = await loop.pingProvider();
    expect(result).toMatchObject({
      configured: true,
      online: false,
      vendor: "openai",
      error: "stream-ended",
    });
  });

  it("timeout abort → error:'timeout'", async () => {
    const loop = buildLoop(new HangingProvider());
    const result = await loop.pingProvider(1);
    expect(result).toMatchObject({
      configured: true,
      online: false,
      vendor: "openai",
      error: "timeout",
    });
  });
});
