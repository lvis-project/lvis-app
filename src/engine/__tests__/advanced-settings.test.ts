/**
 * Sprint A — advanced generation settings forwarding.
 *
 * Verifies that StreamTurnParams carries the new vendor-agnostic fields
 * (temperature, maxOutputTokens, seed, responseFormat, stopSequences,
 * streamSmoothing) and that each legacy provider maps responseFormat="json"
 * to the correct vendor-specific payload.
 */
import { describe, expect, it, vi } from "vitest";
import type { LLMProvider, StreamEvent, StreamTurnParams } from "../llm/types.js";

class CapturingProvider implements LLMProvider {
  readonly vendor = "openai" as const;
  lastParams: StreamTurnParams | null = null;
  async *streamTurn(params: StreamTurnParams): AsyncIterable<StreamEvent> {
    this.lastParams = params;
    yield { type: "message_complete", stopReason: "end_turn" } as StreamEvent;
  }
}

describe("Sprint A — advanced settings forwarding", () => {
  it("StreamTurnParams carries every new advanced field", async () => {
    const provider = new CapturingProvider();
    const iter = provider.streamTurn({
      model: "gpt-test",
      systemPrompt: "",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.3,
      maxOutputTokens: 2048,
      seed: 42,
      responseFormat: "json",
      stopSequences: ["\n\n", "END"],
      streamSmoothing: "word",
    });
    for await (const _ of iter) { /* drain */ }
    const p = provider.lastParams!;
    expect(p.temperature).toBe(0.3);
    expect(p.maxOutputTokens).toBe(2048);
    expect(p.seed).toBe(42);
    expect(p.responseFormat).toBe("json");
    expect(p.stopSequences).toEqual(["\n\n", "END"]);
    expect(p.streamSmoothing).toBe("word");
  });

  it("OpenAIProvider maps responseFormat=json to response_format:{type:json_object} and forwards seed/stop/temperature", async () => {
    vi.resetModules();
    const createMock = vi.fn(async function* () {
      // empty stream — we only inspect the request params
    });
    vi.doMock("openai", () => {
      class FakeOpenAI {
        chat = { completions: { create: (args: unknown) => {
          (FakeOpenAI as any).last = args;
          return createMock();
        } } };
        static APIError = class extends Error {};
      }
      return { default: FakeOpenAI };
    });
    const { OpenAIProvider } = await import("../llm/openai-provider.js");
    const prov = new OpenAIProvider("key", "openai");
    const iter = prov.streamTurn({
      model: "gpt-4o",
      systemPrompt: "sys",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.4,
      seed: 7,
      stopSequences: ["STOP"],
      responseFormat: "json",
    });
    for await (const _ of iter) { /* drain */ }
    const OpenAICtor = (await import("openai")).default as unknown as { last: Record<string, unknown> };
    const args = OpenAICtor.last;
    expect(args.temperature).toBe(0.4);
    expect(args.seed).toBe(7);
    expect(args.stop).toEqual(["STOP"]);
    expect(args.response_format).toEqual({ type: "json_object" });
  });

  it("ClaudeProvider forwards temperature/stop_sequences and uses maxOutputTokens", async () => {
    vi.resetModules();
    const streamFn = vi.fn(() => ({
      async *[Symbol.asyncIterator]() { /* empty */ },
      finalMessage: async () => ({ content: [], stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 } }),
    }));
    vi.doMock("@anthropic-ai/sdk", () => {
      class FakeAnthropic {
        messages = { stream: (args: unknown) => {
          (FakeAnthropic as any).last = args;
          return streamFn();
        } };
        static APIError = class extends Error {};
      }
      return { default: FakeAnthropic };
    });
    const { ClaudeProvider } = await import("../llm/claude-provider.js");
    const prov = new ClaudeProvider("key");
    const iter = prov.streamTurn({
      model: "claude-sonnet-4-6",
      systemPrompt: "sys",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.2,
      stopSequences: ["HALT"],
      maxOutputTokens: 2222,
    });
    for await (const _ of iter) { /* drain */ }
    const Ctor = (await import("@anthropic-ai/sdk")).default as unknown as { last: Record<string, unknown> };
    const args = Ctor.last;
    expect(args.temperature).toBe(0.2);
    expect(args.stop_sequences).toEqual(["HALT"]);
    expect(args.max_tokens).toBe(2222);
  });

  it("GeminiProvider maps responseFormat=json to responseMimeType=application/json and forwards stop/temperature/seed/maxOutputTokens", async () => {
    vi.resetModules();
    let captured: Record<string, unknown> | null = null;
    vi.doMock("@google/generative-ai", () => {
      class FakeGoogleGenerativeAI {
        getGenerativeModel(args: Record<string, unknown>) {
          captured = args;
          return {
            generateContentStream: async () => ({
              stream: (async function* () { /* empty */ })(),
              response: Promise.resolve({ usageMetadata: undefined }),
            }),
          };
        }
      }
      return { GoogleGenerativeAI: FakeGoogleGenerativeAI };
    });
    const { GeminiProvider } = await import("../llm/gemini-provider.js");
    const prov = new GeminiProvider("key");
    const iter = prov.streamTurn({
      model: "gemini-2.5-flash",
      systemPrompt: "sys",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.5,
      seed: 9,
      stopSequences: ["END"],
      responseFormat: "json",
      maxOutputTokens: 1024,
    });
    for await (const _ of iter) { /* drain */ }
    expect(captured).not.toBeNull();
    const cfg = (captured as { generationConfig: Record<string, unknown> }).generationConfig;
    expect(cfg.temperature).toBe(0.5);
    expect(cfg.seed).toBe(9);
    expect(cfg.stopSequences).toEqual(["END"]);
    expect(cfg.responseMimeType).toBe("application/json");
    expect(cfg.maxOutputTokens).toBe(1024);
  });
});
