/**
 * Sprint A — advanced generation settings forwarding.
 *
 * Verifies that StreamTurnParams carries the new vendor-agnostic fields
 * (temperature, maxOutputTokens, seed, responseFormat, stopSequences,
 * streamSmoothing). Vendor-specific payload mapping is covered by the
 * VercelUnifiedProvider adapter tests in src/engine/llm/vercel/__tests__/.
 */
import { describe, expect, it } from "vitest";
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
});
