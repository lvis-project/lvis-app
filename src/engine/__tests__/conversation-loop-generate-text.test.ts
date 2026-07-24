import { describe, expect, it } from "vitest";

import { InputClassifier } from "../../core/input-classifier.js";
import { RouteEngine } from "../../core/route-engine.js";
import { ConversationLoop } from "../conversation-loop.js";
import type { LLMProvider, StreamEvent, StreamTurnParams,
} from "../llm/types.js";
import { ToolRegistry } from "../../tools/registry.js";
import { fakeLlmSettings } from "../../shared/__tests__/fake-llm-settings.js";
import { LLM_VENDOR_DEFAULTS } from "../../shared/llm-vendor-defaults.js";

class FakeProvider implements LLMProvider {
  readonly vendor = "openai" as const;
  lastParams: StreamTurnParams | null = null;

  constructor(private readonly events: StreamEvent[]) {}

  async *streamTurn(params: StreamTurnParams): AsyncIterable<StreamEvent> {
    this.lastParams = params;
    yield* this.events;
  }
}

function buildLoop(provider: LLMProvider | null): ConversationLoop {
  const toolRegistry = new ToolRegistry();
  const inputClassifier = new InputClassifier();
  const routeEngine = new RouteEngine();
  const loop = new ConversationLoop({
    settingsService: {
      get: () => fakeLlmSettings(),
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
});
