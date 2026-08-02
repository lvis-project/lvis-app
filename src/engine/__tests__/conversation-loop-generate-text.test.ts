import { describe, expect, it } from "vitest";

import { InputClassifier } from "../../core/input-classifier.js";
import { RouteEngine } from "../../core/route-engine.js";
import { ConversationLoop } from "../conversation-loop.js";
import type { LLMProvider, StreamEvent, StreamTurnParams,
} from "../llm/types.js";
import { ToolRegistry } from "../../tools/registry.js";
import { fakeLlmSettings } from "../../shared/__tests__/fake-llm-settings.js";
import { LLM_VENDOR_DEFAULTS } from "../../shared/llm-vendor-defaults.js";
import { MAX_BACKGROUND_OUTPUT_TOKEN_LIMIT } from "../llm/output-token-limit.js";
import { estimateTokens } from "../../shared/token-estimate.js";

class FakeProvider implements LLMProvider {
  readonly vendor = "openai" as const;
  lastParams: StreamTurnParams | null = null;

  constructor(private readonly events: StreamEvent[]) {}

  async *streamTurn(params: StreamTurnParams): AsyncIterable<StreamEvent> {
    this.lastParams = params;
    yield* this.events;
  }
}
class SubscriptionFakeProvider extends FakeProvider {
  readonly subscriptionRuntime = { kind: "subscription", provider: "codex" } as const;
}

class OutputCapAbortProvider implements LLMProvider {
  readonly vendor = "openai" as const;
  lastParams: StreamTurnParams | null = null;
  streamClosed = false;
  observedOutputLimitAbort = false;

  async *streamTurn(params: StreamTurnParams): AsyncIterable<StreamEvent> {
    this.lastParams = params;
    try {
      yield { type: "text_delta", text: "bounded output ".repeat(120) };
      yield { type: "message_complete", stopReason: "end_turn" };
    } finally {
      this.streamClosed = true;
      this.observedOutputLimitAbort = params.abortSignal?.aborted === true;
      if (this.observedOutputLimitAbort) {
        throw new Error("transport aborted at output cap");
      }
    }
  }
}

class CallerAbortProvider implements LLMProvider {
  readonly vendor = "openai" as const;
  lastParams: StreamTurnParams | null = null;

  constructor(private readonly callerAbort: AbortController) {}

  async *streamTurn(params: StreamTurnParams): AsyncIterable<StreamEvent> {
    this.lastParams = params;
    yield { type: "text_delta", text: "first" };
    this.callerAbort.abort();
    yield { type: "text_delta", text: "must-not-return" };
  }
}


function buildLoop(
  provider: LLMProvider | null,
  activeChatRuntime: { kind: "api" } | { kind: "subscription"; provider: "codex"; model?: string } = { kind: "api" },
): ConversationLoop {
  const toolRegistry = new ToolRegistry();
  const inputClassifier = new InputClassifier();
  const routeEngine = new RouteEngine();
  const llm = { ...fakeLlmSettings(), activeChatRuntime };
  const loop = new ConversationLoop({
    settingsService: {
      get: () => llm,
      getSecret: () => "test-key",
    },
    systemPromptBuilder: { build: () => "system" },
    inputClassifier,
    routeEngine,
    toolRegistry,
    memoryManager: { saveSession: () => {}, listSessions: () => [] },
  } as unknown as ConstructorParameters<typeof ConversationLoop>[0]);
  (loop as { provider: LLMProvider | null }).provider = provider;
  return loop;
}

describe("ConversationLoop.generateText", () => {
  it("provider가 설정되지 않은 경우 명시적 에러를 던진다", async () => {
    const loop = buildLoop(null);
    await expect(loop.generateText("hello")).rejects.toThrow(
      "LLM provider not configured",
    );
  });

  it("text_delta 이벤트들을 집계해 문자열로 반환한다", async () => {
    const provider = new FakeProvider([
      { type: "text_delta", text: "안녕" },
      { type: "text_delta", text: "하세요" },
      { type: "message_complete", stopReason: "end_turn" },
    ]);
    const loop = buildLoop(provider);
    const result = await loop.generateText("prompt");
    expect(result).toBe("안녕하세요");
  });

  it("결과의 선후행 공백을 trim 한다", async () => {
    const provider = new FakeProvider([
      { type: "text_delta", text: "  답변" },
      { type: "text_delta", text: " 입니다.  " },
      { type: "message_complete", stopReason: "end_turn" },
    ]);
    const loop = buildLoop(provider);
    const result = await loop.generateText("prompt");
    expect(result).toBe("답변 입니다.");
  });

  it("error 이벤트가 오면 부분 텍스트를 반환하지 않고 throw 한다", async () => {
    const provider = new FakeProvider([
      { type: "text_delta", text: "부분 응답" },
      { type: "error", error: "rate_limit" },
      { type: "message_complete", stopReason: "end_turn" },
    ]);
    const loop = buildLoop(provider);
    await expect(loop.generateText("prompt")).rejects.toThrow(
      /LLM stream error: rate_limit/,
    );
  });

  it("message_complete 이후 이벤트는 집계하지 않는다 (stream break)", async () => {
    const provider = new FakeProvider([
      { type: "text_delta", text: "first" },
      { type: "message_complete", stopReason: "end_turn" },
      // 아래는 읽히면 안 됨
      { type: "text_delta", text: "-should-not-appear" },
    ]);
    const loop = buildLoop(provider);
    const result = await loop.generateText("prompt");
    expect(result).toBe("first");
  });

  it("generateText abortSignal을 provider streamTurn에 전달한다", async () => {
    const provider = new FakeProvider([
      { type: "message_complete", stopReason: "end_turn" },
    ]);
    const loop = buildLoop(provider);
    const controller = new AbortController();

    await loop.generateText("prompt", "system", controller.signal);
    expect(provider.lastParams?.abortSignal).toBe(controller.signal);
    expect(provider.lastParams).not.toHaveProperty("outputTokenLimit");
  });

  it("clamps a requested host output cap before the provider stream request", async () => {
    const provider = new FakeProvider([
      { type: "text_delta", text: "small response" },
      { type: "message_complete", stopReason: "end_turn" },
    ]);
    const loop = buildLoop(provider);

    await loop.generateText("prompt", "system", undefined, {
      outputTokenLimit: MAX_BACKGROUND_OUTPUT_TOKEN_LIMIT * 2,
    });

    expect(provider.lastParams?.outputTokenLimit).toBe(MAX_BACKGROUND_OUTPUT_TOKEN_LIMIT);
  });

  it("bounds a non-Vercel stream and treats its own output-cap abort as completion", async () => {
    const provider = new OutputCapAbortProvider();
    const loop = buildLoop(provider);

    const result = await loop.generateText("prompt", "system", undefined, {
      outputTokenLimit: 12,
    });

    expect(provider.lastParams?.outputTokenLimit).toBe(12);
    expect(provider.streamClosed).toBe(true);
    expect(provider.observedOutputLimitAbort).toBe(true);
    expect(estimateTokens(result)).toBeLessThanOrEqual(12);
  });

  it("still throws when the caller-owned signal aborts a capped generation", async () => {
    const controller = new AbortController();
    const provider = new CallerAbortProvider(controller);
    const loop = buildLoop(provider);

    await expect(loop.generateText("prompt", "system", controller.signal, {
      outputTokenLimit: 64,
    })).rejects.toThrow("LLM generation aborted");
    expect(provider.lastParams?.abortSignal).not.toBe(controller.signal);
    expect(provider.lastParams?.abortSignal?.aborted).toBe(true);
  });

  it("pre-aborted generateText는 provider 호출 전에 중단한다", async () => {
    const provider = new FakeProvider([
      { type: "message_complete", stopReason: "end_turn" },
    ]);
    const loop = buildLoop(provider);
    const controller = new AbortController();
    controller.abort();

    await expect(
      loop.generateText("prompt", "system", controller.signal),
    ).rejects.toThrow("LLM generation aborted");
    expect(provider.lastParams).toBeNull();
  });
  it("runs plugin one-shot generation through a subscription runtime", async () => {
    const provider = new SubscriptionFakeProvider([
      { type: "text_delta", text: "subscription answer" },
      { type: "message_complete", stopReason: "end_turn" },
    ]);
    const loop = buildLoop(provider, { kind: "subscription", provider: "codex" });

    await expect(loop.generateText("prompt")).resolves.toBe("subscription answer");
    expect(provider.lastParams).toMatchObject({
      model: "default",
      tools: [],
    });
  });
  it("refuses a stale API provider after subscription activation before it can stream", async () => {
    const provider = new FakeProvider([
      { type: "message_complete", stopReason: "end_turn" },
    ]);
    const loop = buildLoop(provider, { kind: "subscription", provider: "codex" });

    await expect(loop.generateText("prompt")).rejects.toThrow("LLM provider not configured");
    expect(provider.lastParams).toBeNull();
  });
  it("refuses a stale API provider at the chat execution boundary before streaming", async () => {
    const provider = new FakeProvider([
      { type: "message_complete", stopReason: "end_turn" },
    ]);
    const loop = buildLoop(provider, { kind: "subscription", provider: "codex" });

    await expect(
      loop.runTurn("hello", undefined, undefined, {
        inputOrigin: "user-keyboard",
      }),
    ).rejects.toThrow(/provider|프로바이더/i);
    expect(provider.lastParams).toBeNull();
  });
});

describe("ConversationLoop.pingProvider", () => {
  it("returns not-configured when no provider is available", async () => {
    const loop = buildLoop(null);
    await expect(loop.pingProvider()).resolves.toEqual({
      configured: false,
      online: false,
      vendor: "openai",
      model: LLM_VENDOR_DEFAULTS.openai.model,
      error: "not-configured",
    });
  });

  it("returns online=true after a message_complete ping", async () => {
    const provider = new FakeProvider([
      { type: "text_delta", text: "PONG" },
      { type: "message_complete", stopReason: "end_turn" },
    ]);
    const loop = buildLoop(provider);
    const result = await loop.pingProvider();
    expect(result).toMatchObject({
      configured: true,
      online: true,
      vendor: "openai",
      model: LLM_VENDOR_DEFAULTS.openai.model,
    });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(provider.lastParams?.messages).toEqual([{ role: "user", content: "ping" },
    ]);
    expect(provider.lastParams?.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it("returns online=false when the ping stream emits an error", async () => {
    const provider = new FakeProvider([
      { type: "error", error: "rate_limit" }]);
    const loop = buildLoop(provider);
    await expect(loop.pingProvider()).resolves.toMatchObject({
      configured: true,
      online: false,
      vendor: "openai",
      model: LLM_VENDOR_DEFAULTS.openai.model,
      error: "rate_limit",
    });
  });
  it("executes a normal ping through a subscription runtime", async () => {
    const provider = new SubscriptionFakeProvider([
      { type: "text_delta", text: "PONG" },
      { type: "message_complete", stopReason: "end_turn" },
    ]);
    const loop = buildLoop(provider, { kind: "subscription", provider: "codex" });

    await expect(loop.pingProvider()).resolves.toMatchObject({
      configured: true,
      online: true,
      vendor: "subscription:codex",
      model: "default",
    });
    expect(provider.lastParams?.messages).toEqual([{ role: "user", content: "ping" }]);
    expect(provider.lastParams?.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it("returns not-configured instead of pinging a stale API provider after subscription activation", async () => {
    const provider = new FakeProvider([
      { type: "message_complete", stopReason: "end_turn" },
    ]);
    const loop = buildLoop(provider, { kind: "subscription", provider: "codex" });

    await expect(loop.pingProvider()).resolves.toMatchObject({
      configured: false,
      online: false,
      vendor: "subscription:codex",
      model: "default",
      error: "not-configured",
    });
    expect(provider.lastParams).toBeNull();
  });
});
