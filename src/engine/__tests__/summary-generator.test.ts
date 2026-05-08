/**
 * Summary Generator — generateStructuredSummary + shouldSkipSummary
 */
import { describe, it, expect } from "vitest";
import type { LLMProvider, StreamEvent } from "../llm/types.js";
import { generateStructuredSummary, shouldSkipSummary } from "../summary-generator.js";
import type { GenericMessage } from "../llm/types.js";

// ─── Mock LLM Provider ────────────────────────────────

function makeMockLlm(response: string, vendor: "claude" | "openai" = "claude"): LLMProvider {
  return {
    vendor,
    async *streamTurn() {
      yield { type: "text_delta", text: response } satisfies StreamEvent;
      yield { type: "message_complete", stopReason: "end_turn" } satisfies StreamEvent;
    },
  };
}

function makeErrorLlm(): LLMProvider {
  return {
    vendor: "claude",
    async *streamTurn() {
      yield { type: "error", error: "api error" } satisfies StreamEvent;
    },
  };
}

// ─── shouldSkipSummary ────────────────────────────────

describe("shouldSkipSummary", () => {
  it("returns true when ctxUsage < 0.10 (below threshold)", () => {
    expect(shouldSkipSummary(0.09)).toBe(true);
  });

  it("returns false at exactly 0.10 (at threshold — not below)", () => {
    expect(shouldSkipSummary(0.10)).toBe(false);
  });

  it("returns false when ctxUsage > 0.10 (above threshold)", () => {
    expect(shouldSkipSummary(0.11)).toBe(false);
  });

  it("returns true at 0.0 (no context used)", () => {
    expect(shouldSkipSummary(0.0)).toBe(true);
  });

  it("returns false at 1.0 (fully used)", () => {
    expect(shouldSkipSummary(1.0)).toBe(false);
  });
});

// ─── generateStructuredSummary ─────────────────────────────────

describe("generateStructuredSummary", () => {
  it("returns empty string for empty messages array", async () => {
    const llm = makeMockLlm("이 텍스트는 반환되면 안 됩니다");
    const result = await generateStructuredSummary(llm, []);
    expect(result).toBe("");
  });

  it("calls LLM and returns the response text", async () => {
    const llm = makeMockLlm("요약: 사용자가 auth 모듈 구현을 요청했습니다.");
    const messages: GenericMessage[] = [
      { role: "user", content: "auth 모듈 구현해줘" },
      { role: "assistant", content: "네, JWT 기반으로 구현하겠습니다." },
    ];
    const result = await generateStructuredSummary(llm, messages);
    expect(result).toBe("요약: 사용자가 auth 모듈 구현을 요청했습니다.");
  });

  it("passes messages text to the LLM (checks prompt structure)", async () => {
    let capturedParams: unknown = null;
    const llm: LLMProvider = {
      vendor: "claude",
      async *streamTurn(params) {
        capturedParams = params;
        yield { type: "text_delta", text: "요약됨" } satisfies StreamEvent;
        yield { type: "message_complete", stopReason: "end_turn" } satisfies StreamEvent;
      },
    };

    const messages: GenericMessage[] = [
      { role: "user", content: "미팅 노트 정리해줘" },
      { role: "assistant", content: "노트를 정리했습니다." },
    ];
    await generateStructuredSummary(llm, messages);

    expect(capturedParams).not.toBeNull();
    const p = capturedParams as { messages: GenericMessage[]; systemPrompt: string };
    // prompt should contain the conversation text
    const userMsg = p.messages[0];
    expect(userMsg.role).toBe("user");
    const content = typeof userMsg.content === "string" ? userMsg.content : "";
    expect(content).toContain("미팅 노트 정리해줘");
    // system prompt should reference 요약
    expect(p.systemPrompt).toContain("요약");
  });

  it("throws when LLM returns an error event", async () => {
    const llm = makeErrorLlm();
    const messages: GenericMessage[] = [
      { role: "user", content: "테스트" },
    ];
    await expect(generateStructuredSummary(llm, messages)).rejects.toThrow("summary LLM error");
  });

  it("respects maxTokens option by truncating long responses", async () => {
    const longText = "요약 ".repeat(500); // ~2000 chars
    const llm = makeMockLlm(longText);
    const messages: GenericMessage[] = [
      { role: "user", content: "아주 긴 대화" },
      { role: "assistant", content: "응답" },
    ];
    // maxTokens=50 → max ~200 chars
    const result = await generateStructuredSummary(llm, messages, { maxTokens: 50 });
    expect(result.length).toBeLessThanOrEqual(200);
  });
});
