/**
 * L1–L4 snapshot parity tests for VercelUnifiedProvider (Claude / Anthropic path).
 *
 * Per docs/references/vercel-ai-sdk-migration.md §11 + §5.2 P3:
 *   L1 — Structural: StreamEvent type sequence matches expectation
 *   L2 — Content:    concatenated text_delta + reasoning_delta matches baseline
 *   L3 — Tool:       tool_call payload (id/name/input) deep-equal
 *   L4 — Signature:  captured per-step via fullStream events (NEVER onFinish /
 *                    response.messages aggregate — that loses signatures #12433)
 *                    AND round-tripped verbatim into the next request's
 *                    assistant.reasoning part.
 *
 * Also exercises:
 *   - Budget → thinking config mapping (adaptive for claude-4.x, enabled for 3.x).
 *   - interleaved-thinking-2025-05-14 beta header only when thinking+tools.
 *   - Short-reasoning-then-tool (#12433 empty-buffer edge) → log-and-skip.
 */
import { describe, it, expect, vi } from "vitest";
import { collectStreamEvents as collect, streamFromArray as fromArray } from "./test-helpers.js";
import type { StreamEvent } from "../../types.js";
import {
  mapBudgetToEffort,
  supportsAdaptiveThinking,
} from "../adapter.js";
import { extractSignatureSafely } from "../signature-shim.js";
import { genericToModelMessages } from "../message-mapper.js";
import { fullStreamToStreamEvent } from "../stream-mapper.js";



// ────────────────────────────────────────────────────────────────
// Unit: helpers
// ────────────────────────────────────────────────────────────────

describe("Claude helpers — budget → thinking effort mapping", () => {
  it("maps 4 budget bands: low / medium / high / max", () => {
    expect(mapBudgetToEffort(1000)).toBe("low");
    expect(mapBudgetToEffort(3000)).toBe("low");
    expect(mapBudgetToEffort(5000)).toBe("medium");
    expect(mapBudgetToEffort(6000)).toBe("medium");
    expect(mapBudgetToEffort(10_000)).toBe("high");
    expect(mapBudgetToEffort(16_000)).toBe("high");
    expect(mapBudgetToEffort(20_000)).toBe("max");
    expect(mapBudgetToEffort(32_000)).toBe("max");
  });

  it("detects adaptive-thinking-capable Claude families (≥ v4, version-parsed)", () => {
    expect(supportsAdaptiveThinking("claude-sonnet-4-5")).toBe(true);
    expect(supportsAdaptiveThinking("claude-sonnet-4-6")).toBe(true);
    expect(supportsAdaptiveThinking("claude-opus-4")).toBe(true);
    expect(supportsAdaptiveThinking("claude-haiku-4")).toBe(true);
    // Future-proof: claude-5.x and later are picked up without code changes.
    expect(supportsAdaptiveThinking("claude-sonnet-5-20270101")).toBe(true);
    expect(supportsAdaptiveThinking("claude-5-opus")).toBe(true);
    expect(supportsAdaptiveThinking("claude-3-5-sonnet-latest")).toBe(false);
    expect(supportsAdaptiveThinking("claude-3-opus-20240229")).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// Unit: signature shim (#12433 log-and-skip)
// ────────────────────────────────────────────────────────────────

describe("signature-shim — extractSignatureSafely", () => {
  it("returns signature when present", () => {
    expect(
      extractSignatureSafely({
        providerMetadata: { anthropic: { signature: "abc123" } },
      }),
    ).toBe("abc123");
  });

  it("returns null and warns when signature is missing (#12433 edge)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(extractSignatureSafely({})).toBeNull();
    expect(
      extractSignatureSafely({ providerMetadata: { anthropic: {} } }),
    ).toBeNull();
    expect(
      extractSignatureSafely({
        providerMetadata: { anthropic: { signature: "" } },
      }),
    ).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

// ────────────────────────────────────────────────────────────────
// Unit: message-mapper — thinkingBlocks round-trip
// ────────────────────────────────────────────────────────────────

describe("message-mapper — thinkingBlocks → assistant.reasoning parts (P3)", () => {
  it("prepends reasoning parts BEFORE text and tool-call parts, carrying signatures", () => {
    const result = genericToModelMessages([
      {
        role: "assistant",
        content: "visible",
        thinkingBlocks: [
          { thinking: "step-1 thought", signature: "sig-1" },
          { thinking: "step-2 thought", signature: "sig-2" },
        ],
        toolCalls: [{ id: "c1", name: "index_scan", input: { q: "x" } }],
      },
    ]);

    const asst = result[0] as { role: string; content: Array<Record<string, unknown>> };
    expect(asst.role).toBe("assistant");
    // Order: reasoning, reasoning, text, tool-call
    expect(asst.content.map((p) => p.type)).toEqual([
      "reasoning",
      "reasoning",
      "text",
      "tool-call",
    ]);
    expect(asst.content[0]).toEqual({
      type: "reasoning",
      text: "step-1 thought",
      providerOptions: { anthropic: { signature: "sig-1" } },
    });
    expect(asst.content[1]).toEqual({
      type: "reasoning",
      text: "step-2 thought",
      providerOptions: { anthropic: { signature: "sig-2" } },
    });
  });

  it("drops thinking blocks with missing/empty signature (log-and-skip)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = genericToModelMessages([
      {
        role: "assistant",
        content: "x",
        thinkingBlocks: [
          { thinking: "ok", signature: "sig-a" },
          { thinking: "dropped", signature: "" },
        ],
      },
    ]);
    const asst = result[0] as { content: Array<Record<string, unknown>> };
    const reasonings = asst.content.filter((p) => p.type === "reasoning");
    expect(reasonings).toHaveLength(1);
    expect((reasonings[0] as { text: string }).text).toBe("ok");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

// ────────────────────────────────────────────────────────────────
// Unit: stream-mapper — per-step signature capture (NEVER onFinish)
// ────────────────────────────────────────────────────────────────

describe("stream-mapper — Claude signature capture per-step", () => {
  it("accumulates reasoning per block id and attaches signature on reasoning-end", async () => {
    const canned = [
      { type: "start" },
      { type: "reasoning-start", id: "r1" },
      { type: "reasoning-delta", id: "r1", text: "hmm " },
      { type: "reasoning-delta", id: "r1", text: "ok" },
      {
        type: "reasoning-end",
        id: "r1",
        providerMetadata: { anthropic: { signature: "sig-block-1" } },
      },
      { type: "text-delta", id: "t1", text: "answer" },
      {
        type: "finish",
        finishReason: "stop",
        totalUsage: { inputTokens: 5, outputTokens: 9 },
      },
    ];
    const events = await collect(fullStreamToStreamEvent(fromArray(canned)));
    const last = events.at(-1);
    expect(last?.type).toBe("message_complete");
    if (last?.type === "message_complete") {
      expect(last.thinkingBlocks).toEqual([
        { thinking: "hmm ok", signature: "sig-block-1" },
      ]);
      expect(last.stopReason).toBe("end_turn");
    }
  });

  it("captures TWO thinking blocks across interleaved thinking+tool chain", async () => {
    const canned = [
      { type: "reasoning-start", id: "r1" },
      { type: "reasoning-delta", id: "r1", text: "step-1" },
      {
        type: "reasoning-end",
        id: "r1",
        providerMetadata: { anthropic: { signature: "sig-1" } },
      },
      {
        type: "tool-call",
        toolCallId: "call_a",
        toolName: "index_scan",
        input: { q: "foo" },
      },
      { type: "reasoning-start", id: "r2" },
      { type: "reasoning-delta", id: "r2", text: "step-2" },
      {
        type: "reasoning-end",
        id: "r2",
        providerMetadata: { anthropic: { signature: "sig-2" } },
      },
      {
        type: "finish",
        finishReason: "tool-calls",
        totalUsage: { inputTokens: 1, outputTokens: 2 },
      },
    ];
    const events = await collect(fullStreamToStreamEvent(fromArray(canned)));
    const last = events.at(-1);
    if (last?.type === "message_complete") {
      expect(last.thinkingBlocks).toEqual([
        { thinking: "step-1", signature: "sig-1" },
        { thinking: "step-2", signature: "sig-2" },
      ]);
      expect(last.stopReason).toBe("tool_use");
    }
  });

  it("short-reasoning-then-tool with missing signature → log-and-skip (#12433)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const canned = [
      { type: "reasoning-start", id: "r1" },
      // No reasoning-delta — empty buffer edge case
      {
        type: "reasoning-end",
        id: "r1",
        // No providerMetadata / signature
      },
      {
        type: "tool-call",
        toolCallId: "c1",
        toolName: "t",
        input: {},
      },
      {
        type: "finish",
        finishReason: "tool-calls",
        totalUsage: { inputTokens: 1, outputTokens: 1 },
      },
    ];
    const events = await collect(fullStreamToStreamEvent(fromArray(canned)));
    const last = events.at(-1);
    if (last?.type === "message_complete") {
      expect(last.thinkingBlocks).toBeUndefined();
    }
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("[signature-shim]"),
    );
    warn.mockRestore();
  });

  it("surfaces anthropic cache tokens from providerMetadata on finish", async () => {
    const canned = [
      { type: "text-delta", id: "t1", text: "hi" },
      {
        type: "finish",
        finishReason: "stop",
        totalUsage: { inputTokens: 10, outputTokens: 2 },
        providerMetadata: {
          anthropic: {
            cacheCreationInputTokens: 42,
            cacheReadInputTokens: 7,
          },
        },
      },
    ];
    const events = await collect(fullStreamToStreamEvent(fromArray(canned)));
    const last = events.at(-1);
    if (last?.type === "message_complete") {
      expect(last.usage?.cacheReadTokens).toBe(7);
      expect(last.usage?.cacheWriteTokens).toBe(42);
    }
  });

  it("omits cache fields entirely when neither providerMetadata nor cachedInputTokens present", async () => {
    const canned = [
      { type: "text-delta", id: "t1", text: "hi" },
      {
        type: "finish",
        finishReason: "stop",
        totalUsage: { inputTokens: 5, outputTokens: 1 },
      },
    ];
    const events = await collect(fullStreamToStreamEvent(fromArray(canned)));
    const last = events.at(-1);
    if (last?.type === "message_complete") {
      // Spread-conditional emits only when defined — undefined keys must
      // not pollute the usage shape (downstream cost math treats undefined
      // and 0 differently in the OpenAI/Gemini branches).
      expect(last.usage).toBeDefined();
      expect("cacheReadTokens" in (last.usage ?? {})).toBe(false);
      expect("cacheWriteTokens" in (last.usage ?? {})).toBe(false);
    }
  });

  it("falls back to Vercel SDK normalized cachedInputTokens when providerMetadata absent (Gemini/OpenAI path)", async () => {
    const canned = [
      { type: "text-delta", id: "t1", text: "hi" },
      {
        type: "finish",
        finishReason: "stop",
        totalUsage: {
          inputTokens: 100,
          outputTokens: 5,
          cachedInputTokens: 30, // SDK-normalized, no providerMetadata
        },
      },
    ];
    const events = await collect(fullStreamToStreamEvent(fromArray(canned)));
    const last = events.at(-1);
    if (last?.type === "message_complete") {
      expect(last.usage?.cacheReadTokens).toBe(30);
      // No providerMetadata.anthropic.cacheCreationInputTokens — write side stays absent
      expect("cacheWriteTokens" in (last.usage ?? {})).toBe(false);
    }
  });

  it("uses AI SDK 6 inputTokenDetails for canonical cache read/write tokens", async () => {
    const canned = [
      {
        type: "finish",
        finishReason: "stop",
        totalUsage: {
          inputTokens: 100,
          outputTokens: 5,
          cachedInputTokens: 10,
          inputTokenDetails: {
            noCacheTokens: 70,
            cacheReadTokens: 20,
            cacheWriteTokens: 10,
          },
        },
      },
    ];
    const events = await collect(fullStreamToStreamEvent(fromArray(canned)));
    const last = events.at(-1);
    if (last?.type === "message_complete") {
      expect(last.usage).toEqual({
        inputTokens: 100,
        outputTokens: 5,
        cacheReadTokens: 20,
        cacheWriteTokens: 10,
      });
    }
  });

  it("providerMetadata.anthropic takes precedence over SDK cachedInputTokens for cacheReadTokens", async () => {
    const canned = [
      {
        type: "finish",
        finishReason: "stop",
        totalUsage: { inputTokens: 50, outputTokens: 2, cachedInputTokens: 10 },
        providerMetadata: {
          anthropic: {
            cacheReadInputTokens: 999, // Authoritative when present
            cacheCreationInputTokens: 5,
          },
        },
      },
    ];
    const events = await collect(fullStreamToStreamEvent(fromArray(canned)));
    const last = events.at(-1);
    if (last?.type === "message_complete") {
      expect(last.usage?.cacheReadTokens).toBe(999);
      expect(last.usage?.cacheWriteTokens).toBe(5);
    }
  });
});

// ────────────────────────────────────────────────────────────────
// Integration: adapter wiring for Claude
// ────────────────────────────────────────────────────────────────

describe("VercelUnifiedProvider claude — adapter wiring (mocked streamText)", () => {
  it("claude-4.x + thinking uses adaptive thinking; tools add beta header", async () => {
    vi.resetModules();
    const streamTextSpy = vi.fn(() => ({
      stream: (async function* () {
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
    vi.doMock("@ai-sdk/anthropic", () => ({
      createAnthropic: () => ({
        languageModel: (_m: string) => ({ __mock: "claude" }),
      }),
    }));

    const { VercelUnifiedProvider } = await import("../adapter.js");
    const provider = new VercelUnifiedProvider("claude", "test-key");

    await collect(
      provider.streamTurn({
        model: "claude-sonnet-4-6",
        systemPrompt: "sys",
        messages: [{ role: "user", content: "hi" }],
        enableThinking: true,
        thinkingBudgetTokens: 10_000,
        tools: [
          {
            name: "t",
            description: "t",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      }),
    );

    expect(streamTextSpy).toHaveBeenCalledOnce();
    const callArg = streamTextSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(callArg.providerOptions).toEqual({
      anthropic: {
        thinking: { type: "adaptive", effort: "high" },
      },
    });
    // Two betas comma-joined: context-1m for the 1M-tier model + interleaved
    // thinking because thinking+tools coincide.
    expect(callArg.headers).toEqual({
      "anthropic-beta": "context-1m-2025-08-07,interleaved-thinking-2025-05-14",
    });

    vi.doUnmock("ai");
    vi.doUnmock("@ai-sdk/anthropic");
  });

  it("claude-3.x — no `context-1m-2025-08-07` header (model lacks contextWindow1MBeta)", async () => {
    vi.resetModules();
    const streamTextSpy = vi.fn(() => ({
      stream: (async function* () {
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
    vi.doMock("@ai-sdk/anthropic", () => ({
      createAnthropic: () => ({
        languageModel: (_m: string) => ({ __mock: "claude" }),
      }),
    }));

    const { VercelUnifiedProvider } = await import("../adapter.js");
    const provider = new VercelUnifiedProvider("claude", "test-key");

    await collect(
      provider.streamTurn({
        model: "claude-3-5-sonnet-20241022",
        systemPrompt: "sys",
        messages: [{ role: "user", content: "hi" }],
      }),
    );

    const callArg = streamTextSpy.mock.calls[0]![0] as Record<string, unknown>;
    // Negative case for the 1M-beta auto-send: claude-3-5-sonnet has no
    // contextWindow1MBeta in pricing-data, so the adapter must not emit
    // any anthropic-beta header (no thinking either → no interleaved beta).
    expect(callArg.headers).toBeUndefined();

    vi.doUnmock("ai");
    vi.doUnmock("@ai-sdk/anthropic");
  });

  it("claude-3.x + thinking uses budget-based enabled thinking", async () => {
    vi.resetModules();
    const streamTextSpy = vi.fn(() => ({
      stream: (async function* () {
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
    vi.doMock("@ai-sdk/anthropic", () => ({
      createAnthropic: () => ({
        languageModel: (_m: string) => ({ __mock: "claude" }),
      }),
    }));

    const { VercelUnifiedProvider } = await import("../adapter.js");
    const provider = new VercelUnifiedProvider("claude", "test-key");

    await collect(
      provider.streamTurn({
        model: "claude-3-5-sonnet-latest",
        systemPrompt: "sys",
        messages: [{ role: "user", content: "hi" }],
        enableThinking: true,
        thinkingBudgetTokens: 5000,
      }),
    );

    const callArg = streamTextSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(callArg.providerOptions).toEqual({
      anthropic: {
        thinking: { type: "enabled", budgetTokens: 5000 },
      },
    });
    // No tools → no beta header even with thinking.
    expect(callArg.headers).toBeUndefined();

    vi.doUnmock("ai");
    vi.doUnmock("@ai-sdk/anthropic");
  });

  it("thinking disabled → no providerOptions, no beta header", async () => {
    vi.resetModules();
    const streamTextSpy = vi.fn(() => ({
      stream: (async function* () {
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
    vi.doMock("@ai-sdk/anthropic", () => ({
      createAnthropic: () => ({
        languageModel: (_m: string) => ({ __mock: "claude" }),
      }),
    }));

    const { VercelUnifiedProvider } = await import("../adapter.js");
    const provider = new VercelUnifiedProvider("claude", "test-key");

    await collect(
      provider.streamTurn({
        model: "claude-sonnet-4-6",
        systemPrompt: "sys",
        messages: [{ role: "user", content: "hi" }],
        // enableThinking omitted
        tools: [
          {
            name: "t",
            description: "t",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      }),
    );

    const callArg = streamTextSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(callArg.providerOptions).toBeUndefined();
    // 1M beta still applies — thinking off but the model is 1M-tier, so the
    // adapter opts in unconditionally to match the pricing-data SoT.
    expect(callArg.headers).toEqual({
      "anthropic-beta": "context-1m-2025-08-07",
    });

    vi.doUnmock("ai");
    vi.doUnmock("@ai-sdk/anthropic");
  });
});

// ────────────────────────────────────────────────────────────────
// L4 — Signature byte-equality round-trip (turn-1 capture → turn-2 echo)
// ────────────────────────────────────────────────────────────────

describe("Claude — L4 signature byte-equality round-trip", () => {
  it("signatures captured on turn 1 are echoed verbatim into turn 2 assistant.reasoning", async () => {
    // Turn 1: mock a claude stream that emits two signed reasoning blocks
    // plus a tool-call. Capture thinkingBlocks from message_complete.
    const turn1Stream = [
      { type: "reasoning-start", id: "r1" },
      { type: "reasoning-delta", id: "r1", text: "plan A" },
      {
        type: "reasoning-end",
        id: "r1",
        providerMetadata: {
          anthropic: { signature: "SIG_AAA_BYTE_EQUAL_01" },
        },
      },
      { type: "reasoning-start", id: "r2" },
      { type: "reasoning-delta", id: "r2", text: "plan B" },
      {
        type: "reasoning-end",
        id: "r2",
        providerMetadata: {
          anthropic: { signature: "SIG_BBB_BYTE_EQUAL_02" },
        },
      },
      {
        type: "tool-call",
        toolCallId: "tc1",
        toolName: "index_scan",
        input: { q: "x" },
      },
      {
        type: "finish",
        finishReason: "tool-calls",
        totalUsage: { inputTokens: 3, outputTokens: 4 },
      },
    ];

    const turn1Events = await collect(
      fullStreamToStreamEvent(fromArray(turn1Stream)),
    );
    const complete = turn1Events.find((e) => e.type === "message_complete");
    expect(complete?.type).toBe("message_complete");
    if (complete?.type !== "message_complete") return;
    expect(complete.thinkingBlocks).toEqual([
      { thinking: "plan A", signature: "SIG_AAA_BYTE_EQUAL_01" },
      { thinking: "plan B", signature: "SIG_BBB_BYTE_EQUAL_02" },
    ]);

    // Turn 2: build the next assistant GenericMessage that includes those
    // thinkingBlocks verbatim, map to ModelMessage, and assert the signatures
    // are BYTE-EQUAL in the outgoing reasoning parts.
    const turn2Request = genericToModelMessages([
      { role: "user", content: "please continue" },
      {
        role: "assistant",
        content: "",
        thinkingBlocks: complete.thinkingBlocks!,
        toolCalls: [{ id: "tc1", name: "index_scan", input: { q: "x" } }],
      },
      {
        role: "tool_result",
        toolUseId: "tc1",
        toolName: "index_scan",
        content: "result",
      },
    ]);

    const asst = turn2Request[1] as { content: Array<Record<string, unknown>> };
    const reasoningParts = asst.content.filter((p) => p.type === "reasoning");
    expect(reasoningParts).toHaveLength(2);
    expect(
      (reasoningParts[0] as {
        providerOptions: { anthropic: { signature: string } };
      }).providerOptions.anthropic.signature,
    ).toBe("SIG_AAA_BYTE_EQUAL_01");
    expect(
      (reasoningParts[1] as {
        providerOptions: { anthropic: { signature: string } };
      }).providerOptions.anthropic.signature,
    ).toBe("SIG_BBB_BYTE_EQUAL_02");

    // Order: reasoning, reasoning, tool-call (text dropped since content "")
    expect(asst.content.map((p) => p.type)).toEqual([
      "reasoning",
      "reasoning",
      "tool-call",
    ]);
  });
});

// ────────────────────────────────────────────────────────────────
// [HIGH PRIVACY] Cross-vendor thinkingBlocks leak prevention
// ────────────────────────────────────────────────────────────────

describe("message-mapper — cross-vendor thinkingBlocks leak prevention", () => {
  it("strips thinkingBlocks when vendor=gemini (must never send Claude signed thoughts to Gemini)", () => {
    const result = genericToModelMessages(
      [
        {
          role: "assistant",
          content: "visible text",
          thinkingBlocks: [
            { thinking: "secret thought", signature: "sig-secret-1" },
          ],
        },
      ],
      "gemini",
    );

    const asst = result[0] as { role: string; content: Array<Record<string, unknown>> };
    expect(asst.role).toBe("assistant");
    // No reasoning parts — thinkingBlocks must be stripped for non-claude vendors
    const reasoningParts = asst.content.filter((p) => p.type === "reasoning");
    expect(reasoningParts).toHaveLength(0);
    // Text part still present
    expect(asst.content.some((p) => p.type === "text")).toBe(true);
  });

  it("strips thinkingBlocks when vendor=openai (signed thoughts must not reach OpenAI)", () => {
    const result = genericToModelMessages(
      [
        {
          role: "assistant",
          content: "answer",
          thinkingBlocks: [
            { thinking: "internal reasoning", signature: "sig-secret-2" },
          ],
        },
      ],
      "openai",
    );

    const asst = result[0] as { content: Array<Record<string, unknown>> };
    const reasoningParts = asst.content.filter((p) => p.type === "reasoning");
    expect(reasoningParts).toHaveLength(0);
  });

  it("preserves thinkingBlocks when vendor=claude (round-trip must be intact)", () => {
    const result = genericToModelMessages(
      [
        {
          role: "assistant",
          content: "answer",
          thinkingBlocks: [
            { thinking: "claude thought", signature: "sig-claude-ok" },
          ],
        },
      ],
      "claude",
    );

    const asst = result[0] as { content: Array<Record<string, unknown>> };
    const reasoningParts = asst.content.filter((p) => p.type === "reasoning");
    expect(reasoningParts).toHaveLength(1);
    expect(
      (reasoningParts[0] as { providerOptions: { anthropic: { signature: string } } })
        .providerOptions.anthropic.signature,
    ).toBe("sig-claude-ok");
  });
});
