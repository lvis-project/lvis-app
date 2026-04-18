import { describe, expect, it, vi } from "vitest";

// ─── Anthropic SDK mock ──────────────────────────────────────────────────────

const streamMock = vi.fn();

vi.mock("@anthropic-ai/sdk", () => {
  class MockAnthropic {
    static APIError = class APIError extends Error {
      status = 500;
    };

    messages = {
      stream: streamMock,
    };
  }

  return { default: MockAnthropic };
});

import { ClaudeProvider } from "../claude-provider.js";
import type { StreamTurnParams, ThinkingBlock } from "../types.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a minimal async iterable stream that yields no content_block_delta. */
function makeStream(
  finalMessage: {
    stop_reason: string;
    content: Array<Record<string, unknown>>;
    usage: { input_tokens: number; output_tokens: number };
  },
  requestCapture?: (req: Record<string, unknown>, opts: Record<string, unknown> | undefined) => void,
) {
  const iterable = (async function* () {
    // no content blocks — tests rely on finalMessage only
  })();

  const streamObj = {
    [Symbol.asyncIterator]: () => iterable,
    finalMessage: async () => finalMessage,
  };

  streamMock.mockImplementation((req: Record<string, unknown>, opts: Record<string, unknown> | undefined) => {
    requestCapture?.(req, opts);
    return streamObj;
  });
}

async function collect(params: Partial<StreamTurnParams> = {}) {
  const provider = new ClaudeProvider("test-key");
  const events: Array<Record<string, unknown>> = [];
  for await (const event of provider.streamTurn({
    model: "claude-sonnet-4-6",
    systemPrompt: "system",
    messages: [{ role: "user", content: "hello" }],
    ...(params as StreamTurnParams),
  })) {
    events.push(event as Record<string, unknown>);
  }
  return events;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("ClaudeProvider", () => {
  describe("interleaved-thinking beta header", () => {
    it("attaches the header when enableThinking=true AND tools are provided", async () => {
      let capturedOpts: Record<string, unknown> | undefined;
      makeStream(
        { stop_reason: "end_turn", content: [], usage: { input_tokens: 1, output_tokens: 1 } },
        (_req, opts) => { capturedOpts = opts as Record<string, unknown>; },
      );

      await collect({
        enableThinking: true,
        tools: [{ name: "web_search", description: "search", inputSchema: { type: "object", properties: {} } }],
      });

      expect(capturedOpts).toMatchObject({
        headers: { "anthropic-beta": "interleaved-thinking-2025-05-14" },
      });
    });

    it("does NOT attach the header when enableThinking=true but NO tools", async () => {
      let capturedOpts: Record<string, unknown> | undefined;
      makeStream(
        { stop_reason: "end_turn", content: [], usage: { input_tokens: 1, output_tokens: 1 } },
        (_req, opts) => { capturedOpts = opts; },
      );

      await collect({ enableThinking: true, tools: [] });

      expect(capturedOpts).toBeUndefined();
    });

    it("does NOT attach the header when enableThinking=false even with tools", async () => {
      let capturedOpts: Record<string, unknown> | undefined;
      makeStream(
        { stop_reason: "end_turn", content: [], usage: { input_tokens: 1, output_tokens: 1 } },
        (_req, opts) => { capturedOpts = opts; },
      );

      await collect({
        enableThinking: false,
        tools: [{ name: "web_search", description: "search", inputSchema: { type: "object", properties: {} } }],
      });

      expect(capturedOpts).toBeUndefined();
    });
  });

  describe("thinkingBlocks capture", () => {
    it("captures thinking blocks with their signature and surfaces them in message_complete", async () => {
      makeStream({
        stop_reason: "tool_use",
        content: [
          { type: "thinking", thinking: "step-by-step reasoning", signature: "sig-abc123" },
          { type: "tool_use", id: "tu-1", name: "web_search", input: { query: "test" } },
        ],
        usage: { input_tokens: 10, output_tokens: 20 },
      });

      const events = await collect({
        enableThinking: true,
        tools: [{ name: "web_search", description: "search", inputSchema: { type: "object", properties: {} } }],
      });

      const complete = events.find((e) => e.type === "message_complete");
      expect(complete).toBeDefined();
      expect(complete?.thinkingBlocks).toEqual<ThinkingBlock[]>([
        { thinking: "step-by-step reasoning", signature: "sig-abc123" },
      ]);
    });

    it("emits a tool_call event for each tool_use block", async () => {
      makeStream({
        stop_reason: "tool_use",
        content: [
          { type: "tool_use", id: "tu-2", name: "web_search", input: { query: "hello" } },
        ],
        usage: { input_tokens: 5, output_tokens: 5 },
      });

      const events = await collect({
        tools: [{ name: "web_search", description: "search", inputSchema: { type: "object", properties: {} } }],
      });

      expect(events).toContainEqual({
        type: "tool_call",
        id: "tu-2",
        name: "web_search",
        input: { query: "hello" },
      });
    });

    it("re-serializes thinkingBlocks ahead of text and tool_use in history messages", async () => {
      let capturedRequest: Record<string, unknown> | undefined;
      makeStream(
        { stop_reason: "end_turn", content: [], usage: { input_tokens: 1, output_tokens: 1 } },
        (req) => { capturedRequest = req; },
      );

      await collect({
        messages: [
          {
            role: "assistant",
            content: "ok",
            thinkingBlocks: [{ thinking: "my reasoning", signature: "sig-xyz" }],
            toolCalls: [{ id: "tc-1", name: "web_search", input: { query: "q" } }],
          },
          { role: "tool_result", toolUseId: "tc-1", content: "results" },
        ],
      });

      // The assistant message should have thinking block first, then text, then tool_use
      const messages = capturedRequest?.messages as Array<Record<string, unknown>>;
      const assistantMsg = messages?.find((m) => m.role === "assistant");
      const content = assistantMsg?.content as Array<Record<string, unknown>>;

      expect(content[0]).toMatchObject({ type: "thinking", thinking: "my reasoning", signature: "sig-xyz" });
      expect(content[1]).toMatchObject({ type: "text", text: "ok" });
      expect(content[2]).toMatchObject({ type: "tool_use", id: "tc-1", name: "web_search" });
    });
  });

  describe("signature validation", () => {
    it("silently skips a thinking block with an empty signature (no error emitted)", async () => {
      makeStream({
        stop_reason: "tool_use",
        content: [
          { type: "thinking", thinking: "reasoning", signature: "" }, // empty signature
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      });

      const events = await collect({ enableThinking: true });
      // empty signature is silently skipped — no error event, message_complete is emitted
      const errorEvent = events.find((e) => e.type === "error");
      expect(errorEvent).toBeUndefined();
      const completeEvent = events.find((e) => e.type === "message_complete");
      expect(completeEvent).toBeDefined();
      // thinking block with invalid signature must NOT appear in thinkingBlocks
      expect((completeEvent as { thinkingBlocks?: unknown[] })?.thinkingBlocks).toBeUndefined();
    });

    it("silently skips a thinking block missing a signature (no error emitted)", async () => {
      makeStream({
        stop_reason: "tool_use",
        content: [
          { type: "thinking", thinking: "reasoning" }, // no signature field
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      });

      const events = await collect({ enableThinking: true });
      // missing signature is silently skipped — no error event
      const errorEvent = events.find((e) => e.type === "error");
      expect(errorEvent).toBeUndefined();
      const completeEvent = events.find((e) => e.type === "message_complete");
      expect(completeEvent).toBeDefined();
    });
  });
});
