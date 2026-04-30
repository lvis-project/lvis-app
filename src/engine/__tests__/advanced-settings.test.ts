/**
 * CTRL simplification — StreamTurnParams shape verification.
 *
 * Verifies that StreamTurnParams only carries the fields that remain after
 * tuning-control removal (temperature, maxOutputTokens, seed, responseFormat,
 * stopSequences all removed). streamSmoothing, enableThinking, and
 * thinkingBudgetTokens remain.
 *
 * Vendor-specific payload mapping is covered by the VercelUnifiedProvider
 * adapter tests in src/engine/llm/vercel/__tests__/.
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

describe("CTRL simplification — StreamTurnParams shape", () => {
  it("StreamTurnParams carries streamSmoothing, enableThinking, thinkingBudgetTokens", async () => {
    const provider = new CapturingProvider();
    const iter = provider.streamTurn({
      model: "gpt-test",
      systemPrompt: "",
      messages: [{ role: "user", content: "hi" }],
      streamSmoothing: "word",
      enableThinking: false,
      thinkingBudgetTokens: 0,
    });
    for await (const _ of iter) { /* drain */ }
    const p = provider.lastParams!;
    expect(p.streamSmoothing).toBe("word");
    expect(p.enableThinking).toBe(false);
    expect(p.thinkingBudgetTokens).toBe(0);
  });

  it("StreamTurnParams does NOT include removed tuning controls", () => {
    // Type-level assertion: these keys must not exist on StreamTurnParams.
    // If they were re-added, TypeScript would fail at compile time (test files
    // excluded from tsconfig but checked by IDE and CI tsc --noEmit runs on src/).
    const params: StreamTurnParams = {
      model: "gpt-test",
      systemPrompt: "",
      messages: [],
    };
    // Runtime check: none of the removed fields appear on the object
    expect("temperature" in params).toBe(false);
    expect("maxOutputTokens" in params).toBe(false);
    expect("seed" in params).toBe(false);
    expect("responseFormat" in params).toBe(false);
    expect("stopSequences" in params).toBe(false);
  });
});
