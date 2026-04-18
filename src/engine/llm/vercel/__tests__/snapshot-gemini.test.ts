/**
 * L1–L3 snapshot parity tests for VercelUnifiedProvider (Gemini path).
 *
 * Per docs/references/vercel-ai-sdk-migration.md §11:
 *   L1 — Structural: StreamEvent type sequence matches expectation
 *   L2 — Content:    concatenated text_delta + reasoning_delta matches
 *   L3 — Tool:       tool_call payload (id/name/input) matches
 *   L4 — Signature:  skipped for Gemini (no extended thinking signatures)
 */
import { describe, it, expect, vi } from "vitest";
import type { StreamEvent } from "../../types.js";
import { fullStreamToStreamEvent } from "../stream-mapper.js";
import { genericToModelMessages } from "../message-mapper.js";

async function collect(
  iter: AsyncIterable<StreamEvent>,
): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

async function* fromArray<T>(arr: T[]): AsyncIterable<T> {
  for (const item of arr) yield item;
}

describe("VercelUnifiedProvider gemini — L1 structural parity", () => {
  it("maps a canned fullStream to the expected StreamEvent sequence", async () => {
    const canned = [
      { type: "start" },
      { type: "start-step" },
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", text: "Hello " },
      { type: "text-delta", id: "t1", text: "world" },
      { type: "text-end", id: "t1" },
      { type: "finish-step" },
      {
        type: "finish",
        finishReason: "stop",
        rawFinishReason: "STOP",
        totalUsage: { inputTokens: 12, outputTokens: 3 },
      },
    ];

    const events = await collect(fullStreamToStreamEvent(fromArray(canned)));

    expect(events.map((e) => e.type)).toEqual([
      "text_delta",
      "text_delta",
      "message_complete",
    ]);

    const last = events.at(-1);
    expect(last?.type).toBe("message_complete");
    if (last?.type === "message_complete") {
      expect(last.stopReason).toBe("end_turn");
      expect(last.usage).toEqual({ inputTokens: 12, outputTokens: 3 });
    }
  });

  it("surfaces error parts as StreamEvent errors", async () => {
    const canned = [
      { type: "error", error: new Error("boom") },
      { type: "finish", finishReason: "error", totalUsage: {} },
    ];
    const events = await collect(fullStreamToStreamEvent(fromArray(canned)));
    expect(events[0]).toEqual({ type: "error", error: "boom" });
  });
});

describe("VercelUnifiedProvider gemini — L2 content parity", () => {
  it("concatenated text_delta + reasoning_delta equals the baseline string", async () => {
    const canned = [
      { type: "reasoning-delta", id: "r1", text: "think:" },
      { type: "text-delta", id: "t1", text: "foo " },
      { type: "reasoning-delta", id: "r1", text: "A" },
      { type: "text-delta", id: "t1", text: "bar" },
      {
        type: "finish",
        finishReason: "stop",
        totalUsage: { inputTokens: 1, outputTokens: 2 },
      },
    ];

    const events = await collect(fullStreamToStreamEvent(fromArray(canned)));

    const text = events
      .filter(
        (e): e is Extract<StreamEvent, { type: "text_delta" }> =>
          e.type === "text_delta",
      )
      .map((e) => e.text)
      .join("");
    const reasoning = events
      .filter(
        (e): e is Extract<StreamEvent, { type: "reasoning_delta" }> =>
          e.type === "reasoning_delta",
      )
      .map((e) => e.text)
      .join("");

    expect(text).toBe("foo bar");
    expect(reasoning).toBe("think:A");
  });
});

describe("VercelUnifiedProvider gemini — L3 tool payload parity", () => {
  it("tool_call input deep-equals the upstream part (id excluded from expectation)", async () => {
    const canned = [
      { type: "start" },
      {
        type: "tool-call",
        toolCallId: "call_abc_123",
        toolName: "index_scan",
        input: { path: "/tmp/foo", recursive: true, depth: 3 },
      },
      {
        type: "finish",
        finishReason: "tool-calls",
        totalUsage: { inputTokens: 5, outputTokens: 8 },
      },
    ];

    const events = await collect(fullStreamToStreamEvent(fromArray(canned)));
    const toolCall = events.find((e) => e.type === "tool_call");
    expect(toolCall).toBeDefined();
    if (toolCall?.type === "tool_call") {
      expect(toolCall.name).toBe("index_scan");
      expect(toolCall.input).toEqual({
        path: "/tmp/foo",
        recursive: true,
        depth: 3,
      });
      // id present (excluded from deep-equal per L3 rule)
      expect(typeof toolCall.id).toBe("string");
      expect(toolCall.id.length).toBeGreaterThan(0);
    }

    const finish = events.find((e) => e.type === "message_complete");
    expect(finish).toBeDefined();
    if (finish?.type === "message_complete") {
      expect(finish.stopReason).toBe("tool_use");
    }
  });
});

describe("message-mapper (gemini-safe)", () => {
  it("converts user / assistant / assistant+toolCalls / tool_result", () => {
    const result = genericToModelMessages([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "c1", name: "index_scan", input: { q: "foo" } },
        ],
      },
      {
        role: "tool_result",
        toolUseId: "c1",
        toolName: "index_scan",
        content: "ok",
      },
    ]);

    expect(result).toHaveLength(4);
    expect(result[0]).toEqual({
      role: "user",
      content: [{ type: "text", text: "hi" }],
    });
    expect(result[1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
    });
    expect(result[2]).toEqual({
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "c1",
          toolName: "index_scan",
          input: { q: "foo" },
        },
      ],
    });
    expect(result[3]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "c1",
          toolName: "index_scan",
          output: { type: "text", value: "ok" },
        },
      ],
    });
  });

  it("emits thinkingBlocks as reasoning parts (P3 — Claude round-trip path)", () => {
    // P3 change: thinkingBlocks now map to `reasoning` parts carrying
    // providerOptions.anthropic.signature. Non-Anthropic providers ignore
    // reasoning parts they don't recognize, so this is safe cross-vendor.
    const result = genericToModelMessages([
      {
        role: "assistant",
        content: "visible",
        thinkingBlocks: [{ thinking: "secret", signature: "sig" }],
      },
    ]);
    const asst = result[0] as { content: Array<Record<string, unknown>> };
    expect(asst.content.map((p) => p.type)).toEqual(["reasoning", "text"]);
    expect(asst.content[0]).toEqual({
      type: "reasoning",
      text: "secret",
      providerOptions: { anthropic: { signature: "sig" } },
    });
  });
});

describe("VercelUnifiedProvider gemini — adapter smoke (mocked ai.streamText)", () => {
  it("vendor=gemini routes through streamText and emits message_complete", async () => {
    vi.resetModules();
    vi.doMock("ai", async () => {
      const actual = await vi.importActual<typeof import("ai")>("ai");
      return {
        ...actual,
        streamText: vi.fn(() => ({
          fullStream: (async function* () {
            yield { type: "text-delta", id: "t1", text: "hi" };
            yield {
              type: "finish",
              finishReason: "stop",
              totalUsage: { inputTokens: 1, outputTokens: 1 },
            };
          })(),
        })),
      };
    });
    vi.doMock("@ai-sdk/google", () => ({
      createGoogleGenerativeAI: () => (_model: string) => ({ __mock: true }),
    }));

    const { VercelUnifiedProvider } = await import("../adapter.js");
    const provider = new VercelUnifiedProvider("gemini", "test-key");

    const events: StreamEvent[] = [];
    for await (const ev of provider.streamTurn({
      model: "gemini-2.5-flash",
      systemPrompt: "sys",
      messages: [{ role: "user", content: "hi" }],
    })) {
      events.push(ev);
    }

    expect(events.map((e) => e.type)).toEqual([
      "text_delta",
      "message_complete",
    ]);

    vi.doUnmock("ai");
    vi.doUnmock("@ai-sdk/google");
  });

  // (P2: openai is now implemented — see snapshot-openai.test.ts.
  //  Claude stub assertion also lives there.)

  it("forwards abortSignal to streamText()", async () => {
    vi.resetModules();
    const streamTextSpy = vi.fn(() => ({
      fullStream: (async function* () {
        yield {
          type: "finish",
          finishReason: "stop",
          totalUsage: { inputTokens: 1, outputTokens: 1 },
        };
      })(),
    }));
    vi.doMock("ai", async () => {
      const actual = await vi.importActual<typeof import("ai")>("ai");
      return { ...actual, streamText: streamTextSpy };
    });
    vi.doMock("@ai-sdk/google", () => ({
      createGoogleGenerativeAI: () => (_model: string) => ({ __mock: true }),
    }));

    const { VercelUnifiedProvider } = await import("../adapter.js");
    const provider = new VercelUnifiedProvider("gemini", "test-key");
    const ac = new AbortController();

    const events: StreamEvent[] = [];
    for await (const ev of provider.streamTurn({
      model: "gemini-2.5-flash",
      systemPrompt: "sys",
      messages: [{ role: "user", content: "hi" }],
      abortSignal: ac.signal,
    })) {
      events.push(ev);
    }

    expect(streamTextSpy).toHaveBeenCalledTimes(1);
    const callArgs = streamTextSpy.mock.calls[0]![0] as {
      abortSignal?: AbortSignal;
    };
    expect(callArgs.abortSignal).toBe(ac.signal);

    vi.doUnmock("ai");
    vi.doUnmock("@ai-sdk/google");
  });

  it("yields error event with classification when streamText() throws synchronously (pre-stream)", async () => {
    vi.resetModules();
    vi.doMock("ai", async () => {
      const actual = await vi.importActual<typeof import("ai")>("ai");
      return {
        ...actual,
        streamText: vi.fn(() => {
          // Simulate APICallError-style pre-stream failure (e.g. 429 rate limit).
          const err = new Error("429 rate limited");
          throw err;
        }),
      };
    });
    vi.doMock("@ai-sdk/google", () => ({
      createGoogleGenerativeAI: () => (_model: string) => ({ __mock: true }),
    }));

    const { VercelUnifiedProvider } = await import("../adapter.js");
    const provider = new VercelUnifiedProvider("gemini", "test-key");

    const events: StreamEvent[] = [];
    for await (const ev of provider.streamTurn({
      model: "gemini-2.5-flash",
      systemPrompt: "sys",
      messages: [{ role: "user", content: "hi" }],
    })) {
      events.push(ev);
    }

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("error");
    if (events[0]!.type === "error") {
      expect(typeof events[0]!.error).toBe("string");
      expect(events[0]!.classification).toBeDefined();
      expect(typeof events[0]!.classification).toBe("string");
    }

    vi.doUnmock("ai");
    vi.doUnmock("@ai-sdk/google");
  });

  // P3: vendor=claude is now implemented — see snapshot-claude.test.ts.
});

describe("stream-mapper — usage v4/v5 fallback", () => {
  it("reads v4-shape usage { promptTokens, completionTokens }", async () => {
    const canned = [
      { type: "text-delta", id: "t1", text: "ok" },
      {
        type: "finish",
        finishReason: "stop",
        usage: { promptTokens: 10, completionTokens: 5 },
      },
    ];
    const events = await collect(fullStreamToStreamEvent(fromArray(canned)));
    const finish = events.find((e) => e.type === "message_complete");
    expect(finish).toBeDefined();
    if (finish?.type === "message_complete") {
      expect(finish.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    }
  });

  it("honors finishReason='tool-calls' even without tool-call parts", async () => {
    const canned = [
      {
        type: "finish",
        finishReason: "tool-calls",
        totalUsage: { inputTokens: 1, outputTokens: 2 },
      },
    ];
    const events = await collect(fullStreamToStreamEvent(fromArray(canned)));
    const finish = events.find((e) => e.type === "message_complete");
    expect(finish).toBeDefined();
    if (finish?.type === "message_complete") {
      expect(finish.stopReason).toBe("tool_use");
    }
  });

  it("honors finishReason='stop' even when hasToolCalls (sticky) would say tool_use", async () => {
    const canned = [
      {
        type: "tool-call",
        toolCallId: "c1",
        toolName: "x",
        input: {},
      },
      {
        type: "finish",
        finishReason: "stop",
        totalUsage: { inputTokens: 1, outputTokens: 2 },
      },
    ];
    const events = await collect(fullStreamToStreamEvent(fromArray(canned)));
    const finish = events.find((e) => e.type === "message_complete");
    expect(finish).toBeDefined();
    if (finish?.type === "message_complete") {
      expect(finish.stopReason).toBe("end_turn");
    }
  });
});

describe("message-mapper — additional MEDIUM fixes", () => {
  it("maps tool_result with isError=true to error-text output", () => {
    const result = genericToModelMessages([
      {
        role: "tool_result",
        toolUseId: "c1",
        toolName: "index_scan",
        content: "boom",
        isError: true,
      },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "c1",
          toolName: "index_scan",
          output: { type: "error-text", value: "boom" },
        },
      ],
    });
  });

  it("omits empty assistant message (no text, no toolCalls)", () => {
    const result = genericToModelMessages([
      { role: "user", content: "hi" },
      { role: "assistant", content: "" },
      { role: "user", content: "again" },
    ]);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      role: "user",
      content: [{ type: "text", text: "hi" }],
    });
    expect(result[1]).toEqual({
      role: "user",
      content: [{ type: "text", text: "again" }],
    });
  });
});
