import { afterEach, describe, expect, it, vi } from "vitest";
import { TOOL_TIMEOUT_POLICY } from "../../../../shared/tool-timeout-policy.js";
import type { StreamEvent, StreamTurnParams } from "../../types.js";
import { fullStreamToStreamEvent, VercelUnifiedProvider, type VercelVendor } from "../adapter.js";
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

const CHAT_TEXT_CHUNK = {
  id: "fixture-response",
  model: TURN_PARAMS.model,
  choices: [{ index: 0, delta: { content: "Partial result" }, finish_reason: null }],
};
const CHAT_STOP_CHUNK = {
  id: "fixture-response",
  model: TURN_PARAMS.model,
  choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
};
const WIRE_COMPLETION_FIXTURES = [
  {
    route: "chat", vendor: "openai", model: TURN_PARAMS.model,
    partialChunks: [CHAT_TEXT_CHUNK], finishChunks: [CHAT_STOP_CHUNK],
  },
  {
    route: "responses", vendor: "openai", model: "gpt-5",
    partialChunks: [
      { type: "response.created", response: { id: "fixture", created_at: 1, model: "gpt-5" } },
      {
        type: "response.output_item.added", output_index: 0,
        item: { id: "fixture-message", type: "message", role: "assistant" },
      },
      {
        type: "response.output_text.delta", item_id: "fixture-message",
        output_index: 0, delta: "Partial result",
      },
    ],
    finishChunks: [{ type: "response.completed", response: {} }],
  },
  {
    route: "generated-content", vendor: "gemini", model: TURN_PARAMS.model,
    partialChunks: [{ candidates: [{ content: { parts: [{ text: "Partial result" }] } }] }],
    finishChunks: [{ candidates: [{ content: { parts: [] }, finishReason: "STOP" }] }],
  },
  {
    route: "messages", vendor: "claude", model: TURN_PARAMS.model,
    partialChunks: [
      {
        type: "message_start",
        message: { id: "fixture", model: TURN_PARAMS.model, role: "assistant", usage: { input_tokens: 1 } },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Partial result" } },
    ],
    finishChunks: [
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 1 },
      },
      { type: "message_stop" },
    ],
  },
  {
    route: "compatible-chat", vendor: "openai-compatible", model: TURN_PARAMS.model,
    partialChunks: [CHAT_TEXT_CHUNK], finishChunks: [CHAT_STOP_CHUNK],
  },
] as const;

function createResponseFixture(vendor: VercelVendor = "openai-compatible") {
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
  const sendData = (data: Record<string, unknown>) => {
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
  };
  return {
    fetchResponse,
    provider: new VercelUnifiedProvider(
      vendor, "fixture-key", "https://provider.invalid/v1", fetchResponse,
    ),
    sendData,
    send(delta: Record<string, unknown>, finishReason: string | null = null) {
      sendData({
        id: "fixture-response",
        model: TURN_PARAMS.model,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      });
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

  it.each(WIRE_COMPLETION_FIXTURES)(
    "rejects EOF without a provider terminal event on $route",
    async ({ vendor, model, partialChunks }) => {
      const fixture = createResponseFixture(vendor);
      for (const chunk of partialChunks) fixture.sendData(chunk);
      fixture.close();
      const events = await collect(fixture.provider.streamTurn({ ...TURN_PARAMS, model }));
      expect(events[0]).toMatchObject({ type: "text_delta", text: "Partial result" });
      expect(events.at(-1)).toMatchObject({ type: "error" });
      expect(events.some((event) => event.type === "message_complete")).toBe(false);
      expect(fixture.fetchResponse).toHaveBeenCalledTimes(1);
    },
  );

  it.each(WIRE_COMPLETION_FIXTURES)(
    "preserves a response with its provider terminal event on $route",
    async ({ vendor, model, partialChunks, finishChunks }) => {
      const fixture = createResponseFixture(vendor);
      for (const chunk of [...partialChunks, ...finishChunks]) fixture.sendData(chunk);
      fixture.close();
      expect(await collect(fixture.provider.streamTurn({ ...TURN_PARAMS, model }))).toEqual([
        { type: "text_delta", text: "Partial result" },
        expect.objectContaining({ type: "message_complete", stopReason: "end_turn" }),
      ]);
      expect(fixture.fetchResponse).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["openai", "gemini", "openai-compatible"] as const)(
    "preserves an explicit empty stop on %s",
    async (vendor) => {
      const fixture = createResponseFixture(vendor);
      if (vendor === "gemini") {
        fixture.sendData({ candidates: [{ content: { parts: [] }, finishReason: "STOP" }] });
      } else {
        fixture.send({}, "stop");
      }
      fixture.close();
      expect(await collect(fixture.provider.streamTurn(TURN_PARAMS))).toEqual([
        expect.objectContaining({ type: "message_complete", stopReason: "end_turn" }),
      ]);
    },
  );

  it.each(["openai", "gemini", "openai-compatible"] as const)(
    "preserves an explicit content filter response on %s",
    async (vendor) => {
      const fixture = createResponseFixture(vendor);
      if (vendor === "gemini") {
        fixture.sendData({ candidates: [{ content: { parts: [] }, finishReason: "SAFETY" }] });
      } else {
        fixture.send({}, "content_filter");
      }
      fixture.close();
      expect(await collect(fixture.provider.streamTurn(TURN_PARAMS))).toEqual([
        expect.objectContaining({ type: "message_complete", stopReason: "end_turn" }),
      ]);
    },
  );

  it.each(["openai", "openai-compatible"] as const)(
    "rejects a wire error reason normalized to other on %s",
    async (vendor) => {
      const fixture = createResponseFixture(vendor);
      fixture.send({ content: "Partial result" }, "error");
      fixture.close();
      const events = await collect(fixture.provider.streamTurn(TURN_PARAMS));
      expect(events.at(-1)).toMatchObject({ type: "error" });
      expect(events.some((event) => event.type === "message_complete")).toBe(false);
      expect(fixture.fetchResponse).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects an unclassified provider finish reason", async () => {
    const fixture = createResponseFixture("gemini");
    fixture.sendData({ candidates: [{
      content: { parts: [{ text: "Partial result" }] }, finishReason: "OTHER",
    }] });
    fixture.close();
    const events = await collect(fixture.provider.streamTurn(TURN_PARAMS));
    expect(events.at(-1)).toMatchObject({ type: "error" });
    expect(events.some((event) => event.type === "message_complete")).toBe(false);
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

  it.each(["error", "other", "unknown", undefined])(
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
  ] as const)("preserves the supported finish reason %s", async (finishReason, stopReason) => {
    const events: StreamEvent[] = await collect(fullStreamToStreamEvent(streamFromArray([
      { type: "finish", finishReason },
    ]), "openai-compatible"));
    expect(events).toEqual([{ type: "message_complete", stopReason, usage: undefined }]);
  });
});
