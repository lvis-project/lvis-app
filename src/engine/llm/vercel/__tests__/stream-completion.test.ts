import { afterEach, describe, expect, it, vi } from "vitest";
import { TOOL_TIMEOUT_POLICY } from "../../../../shared/tool-timeout-policy.js";
import type { StreamEvent, StreamTurnParams } from "../../types.js";
import { fullStreamToStreamEvent, VercelUnifiedProvider } from "../adapter.js";
import { collectStreamEvents as collect, streamFromArray } from "./test-helpers.js";

const TURN_PARAMS: StreamTurnParams = {
  model: "fixture-model",
  systemPrompt: "Complete the requested operation.",
  messages: [{ role: "user", content: "Return the result." }],
};

const TOOL_TURN_PARAMS: StreamTurnParams = {
  ...TURN_PARAMS,
  tools: [{
    name: "record_value",
    description: "Record the supplied value.",
    inputSchema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
    },
  }],
};

function createResponseFixture() {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
    },
  });
  const fetchResponse = vi.fn<typeof fetch>(async (_input, init) => {
    init?.signal?.addEventListener("abort", () => {
      controller.error(new DOMException("Response body aborted", "AbortError"));
    }, { once: true });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  });
  return {
    fetchResponse,
    provider: new VercelUnifiedProvider(
      "openai-compatible", "fixture-key", "https://provider.invalid/v1", fetchResponse,
    ),
    send(delta: Record<string, unknown>, finishReason: string | null = null) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({
        id: "fixture-response",
        model: TURN_PARAMS.model,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })}\n\n`));
    },
    close() {
      controller.close();
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("provider stream completion", () => {
  it("keeps a response active while tool arguments continue streaming", async () => {
    vi.useFakeTimers();
    const fixture = createResponseFixture();
    fixture.send({ tool_calls: [{
      index: 0, id: "call_fixture", type: "function",
      function: { name: "record_value", arguments: '{"value":"' },
    }] });
    const result = collect(fixture.provider.streamTurn(TOOL_TURN_PARAMS));
    await vi.advanceTimersByTimeAsync(0);

    for (const text of ["A", "B", "C"]) {
      await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_POLICY.modelStreamIdleCeilingMs / 2);
      expect(fixture.fetchResponse.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
      fixture.send({ tool_calls: [{ index: 0, function: { arguments: text } }] });
      await vi.advanceTimersByTimeAsync(0);
    }
    fixture.send({ tool_calls: [{ index: 0, function: { arguments: '"}' } }] }, "tool_calls");
    fixture.close();

    expect(await result).toEqual([
      { type: "tool_call", id: "call_fixture", name: "record_value", input: { value: "ABC" } },
      expect.objectContaining({ type: "message_complete", stopReason: "tool_use" }),
    ]);
    expect(fixture.fetchResponse).toHaveBeenCalledTimes(1);
  });

  it("still aborts when streaming tool arguments stop arriving", async () => {
    vi.useFakeTimers();
    const fixture = createResponseFixture();
    fixture.send({ tool_calls: [{
      index: 0, id: "call_fixture", type: "function",
      function: { name: "record_value", arguments: '{"value":"' },
    }] });
    const result = collect(fixture.provider.streamTurn(TOOL_TURN_PARAMS));
    await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_POLICY.modelStreamIdleCeilingMs + 1);
    expect(await result).toEqual([
      expect.objectContaining({ type: "error", classification: "network" }),
    ]);
    expect(fixture.fetchResponse).toHaveBeenCalledTimes(1);
  });

  it("reports an idle abort from the response stream as a provider error", async () => {
    vi.useFakeTimers();
    const fixture = createResponseFixture();
    fixture.send({ content: "Partial result" });
    const iterator = fixture.provider.streamTurn(TURN_PARAMS)[Symbol.asyncIterator]();
    expect(await iterator.next()).toMatchObject({
      value: { type: "text_delta", text: "Partial result" },
    });

    const remaining = collect({ [Symbol.asyncIterator]: () => iterator });
    await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_POLICY.modelStreamIdleCeilingMs + 1);

    expect(await remaining).toEqual([
      expect.objectContaining({ type: "error", classification: "network" }),
    ]);
    expect(fixture.fetchResponse).toHaveBeenCalledTimes(1);
  });

  it("leaves caller cancellation without a successful completion", async () => {
    const fixture = createResponseFixture();
    const caller = new AbortController();
    fixture.send({ content: "Partial result" });
    const iterator = fixture.provider.streamTurn({
      ...TURN_PARAMS, abortSignal: caller.signal,
    })[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ type: "text_delta" });
    const remaining = collect({ [Symbol.asyncIterator]: () => iterator });
    caller.abort();
    expect(await remaining).toEqual([]);
  });

  it("rejects a response body that ends without an explicit finish reason", async () => {
    const fixture = createResponseFixture();
    fixture.send({ content: "Partial result" });
    fixture.close();
    const events = await collect(fixture.provider.streamTurn(TURN_PARAMS));
    expect(events[0]).toMatchObject({ type: "text_delta", text: "Partial result" });
    expect(events.at(-1)).toMatchObject({ type: "error" });
    expect(events.some((event) => event.type === "message_complete")).toBe(false);
    expect(fixture.fetchResponse).toHaveBeenCalledTimes(1);
  });

  it("preserves an explicit empty stop as a completed model response", async () => {
    const fixture = createResponseFixture();
    fixture.send({}, "stop");
    fixture.close();
    expect(await collect(fixture.provider.streamTurn(TURN_PARAMS))).toEqual([
      expect.objectContaining({ type: "message_complete", stopReason: "end_turn" }),
    ]);
  });

  it("treats an unsolicited abort event as a provider error", async () => {
    const events = await collect(fullStreamToStreamEvent(streamFromArray([
      { type: "text-delta", text: "Partial result" },
      { type: "abort", reason: "Upstream response interrupted" },
      { type: "finish", finishReason: "stop" },
    ]), "openai-compatible"));
    expect(events).toEqual([
      { type: "text_delta", text: "Partial result" },
      expect.objectContaining({ type: "error" }),
    ]);
  });

  it("does not complete after a provider error", async () => {
    expect(await collect(fullStreamToStreamEvent(streamFromArray([
      { type: "error", error: new Error("Response failed") },
      { type: "finish", finishReason: "error" },
    ]), "openai-compatible"))).toEqual([
      expect.objectContaining({ type: "error", error: "Response failed" }),
    ]);
  });

  it("does not infer a missing finish reason from a prior tool call", async () => {
    const events = await collect(fullStreamToStreamEvent(streamFromArray([
      { type: "tool-call", toolCallId: "call_fixture", toolName: "record_value", input: { value: "A" } },
      { type: "finish" },
    ]), "openai-compatible"));
    expect(events.map((event) => event.type)).toEqual(["tool_call", "error"]);
  });

  it.each(["error", "unknown", undefined])(
    "rejects an unsuccessful or absent finish reason: %s",
    async (finishReason) => {
      const events = await collect(fullStreamToStreamEvent(streamFromArray([
        { type: "finish", finishReason },
      ]), "openai-compatible"));
      expect(events).toEqual([expect.objectContaining({ type: "error" })]);
    },
  );

  it.each([
    ["stop", "end_turn"],
    ["length", "max_tokens"],
    ["tool-calls", "tool_use"],
    ["content-filter", "end_turn"],
    ["other", "end_turn"],
  ] as const)("preserves the supported finish reason %s", async (finishReason, stopReason) => {
    const events: StreamEvent[] = await collect(fullStreamToStreamEvent(streamFromArray([
      { type: "finish", finishReason },
    ]), "openai-compatible"));
    expect(events).toEqual([{ type: "message_complete", stopReason, usage: undefined }]);
  });
});
