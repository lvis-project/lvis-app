import { describe, expect, it, vi } from "vitest";
import {
  finalizeAfterRoundCap,
  mergeFinalizeUsage,
  resolveRoundCapText,
} from "../round-cap-finalize.js";
import type { GenericMessage, StreamEvent, TokenUsage } from "../../llm/types.js";

function provider(events: StreamEvent[]) {
  return {
    streamTurn: vi.fn(async function* () {
      for (const event of events) yield event;
    }),
  } as never;
}

const BASE = {
  model: "test-model",
  systemPrompt: "sys",
  messages: [{ role: "user", content: "do the thing" }] as GenericMessage[],
};

describe("finalizeAfterRoundCap", () => {
  it("returns the collected hand-off text and usage", async () => {
    const usage: TokenUsage = { inputTokens: 10, outputTokens: 4 };
    const result = await finalizeAfterRoundCap({
      ...BASE,
      provider: provider([
        { type: "text_delta", text: "found X. " },
        { type: "text_delta", text: "next: Y" },
        { type: "message_complete", stopReason: "end_turn", usage },
      ]),
    });

    expect(result).toEqual({ text: "found X. next: Y", usage });
  });

  it("offers NO tools, so the call cannot extend the work it summarizes", async () => {
    const p = provider([
      { type: "text_delta", text: "summary" },
      { type: "message_complete", stopReason: "end_turn" },
    ]);
    await finalizeAfterRoundCap({ ...BASE, provider: p });

    const params = (p as unknown as { streamTurn: { mock: { calls: unknown[][] } } })
      .streamTurn.mock.calls[0][0] as Record<string, unknown>;
    expect(params.tools).toBeUndefined();
    // Bounded so a runaway completion cannot follow a budget exhaustion.
    expect(params.outputTokenLimit).toBeGreaterThan(0);
  });

  it("appends a hand-off request after the existing history", async () => {
    const p = provider([
      { type: "text_delta", text: "summary" },
      { type: "message_complete", stopReason: "end_turn" },
    ]);
    await finalizeAfterRoundCap({ ...BASE, provider: p });

    const params = (p as unknown as { streamTurn: { mock: { calls: unknown[][] } } })
      .streamTurn.mock.calls[0][0] as { messages: GenericMessage[] };
    expect(params.messages).toHaveLength(BASE.messages.length + 1);
    expect(params.messages[0]).toEqual(BASE.messages[0]);
    expect(params.messages.at(-1)?.role).toBe("user");
  });

  it("returns null on a provider error rather than surfacing a broken hand-off", async () => {
    const result = await finalizeAfterRoundCap({
      ...BASE,
      provider: provider([{ type: "error", error: "boom" } as StreamEvent]),
    });
    expect(result).toBeNull();
  });

  it("returns null on an empty completion", async () => {
    const result = await finalizeAfterRoundCap({
      ...BASE,
      provider: provider([
        { type: "text_delta", text: "   " },
        { type: "message_complete", stopReason: "end_turn" },
      ]),
    });
    expect(result).toBeNull();
  });

  it("does not call the provider at all when already aborted", async () => {
    const p = provider([]);
    const controller = new AbortController();
    controller.abort();

    const result = await finalizeAfterRoundCap({
      ...BASE,
      provider: p,
      abortSignal: controller.signal,
    });

    expect(result).toBeNull();
    expect((p as unknown as { streamTurn: { mock: { calls: unknown[] } } }).streamTurn.mock.calls)
      .toHaveLength(0);
  });
});

describe("resolveRoundCapText", () => {
  const history: GenericMessage[] = [
    { role: "user", content: "q" },
    { role: "assistant", content: "partial answer" },
  ];

  it("prefers the finalize hand-off over the trailing partial text", () => {
    expect(resolveRoundCapText({ text: "hand-off" }, history, "notice"))
      .toBe("hand-off");
  });

  it("falls back to the last assistant message when finalize failed", () => {
    // A real partial answer beats a synthetic notice, so the pre-existing
    // behaviour is preserved whenever finalize could not produce text.
    expect(resolveRoundCapText(null, history, "notice")).toBe("partial answer");
  });

  it("uses the notice only when there is no assistant text at all", () => {
    // The tool-only final round — the case that used to read as an agent
    // stopping silently.
    expect(resolveRoundCapText(null, [{ role: "user", content: "q" }], "notice"))
      .toBe("notice");
  });
});

describe("mergeFinalizeUsage", () => {
  it("adds the finalize usage onto the turn total", () => {
    expect(
      mergeFinalizeUsage(
        { inputTokens: 5, outputTokens: 2, cacheReadTokens: 1, cacheWriteTokens: 0 },
        { text: "x", usage: { inputTokens: 3, outputTokens: 4 } },
      ),
    ).toEqual({
      inputTokens: 8,
      outputTokens: 6,
      cacheReadTokens: 1,
      cacheWriteTokens: 0,
    });
  });

  it("is identity when the finalize call produced no usage", () => {
    const turn = { inputTokens: 5, outputTokens: 2 };
    expect(mergeFinalizeUsage(turn, null)).toBe(turn);
    expect(mergeFinalizeUsage(turn, { text: "x" })).toBe(turn);
  });

  it("starts from zero when the turn had no usage yet", () => {
    expect(mergeFinalizeUsage(undefined, { text: "x", usage: { inputTokens: 3, outputTokens: 4 } }))
      .toEqual({ inputTokens: 3, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });
});
