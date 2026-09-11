import { afterEach, describe, expect, it, vi } from "vitest";

import { estimateRequestInputProjection } from "../../../request-input-projection.js";
import type {
  LLMProvider,
  LLMVendor,
  ProviderRequestInputProjection,
  ProviderRequestInputProjectionParams,
  StreamEvent,
  StreamTurnParams,
} from "../../types.js";
import { genericToModelMessages } from "../adapter.js";
import { FallbackProvider } from "../fallback-chain.js";
import type { FallbackChainEntry } from "../fallback-chain.js";
import { collectStreamEvents } from "./test-helpers.js";

const input: ProviderRequestInputProjectionParams = {
  systemPrompt: "Complete the requested work.",
  messages: [
    {
      role: "assistant",
      content: "I inspected the input.",
      thought: "Display-only reasoning. ".repeat(20_000),
      thinkingBlocks: [{ thinking: "r".repeat(400_000), signature: "fixture-signature" }],
    },
    { role: "user", content: "Continue." },
  ],
  toolSchemas: [{ name: "read_file", description: "Read a file", inputSchema: { type: "object", properties: {} } }],
};

function makeProvider(vendor: LLMVendor): LLMProvider {
  return {
    vendor,
    streamTurn: async function* () {
      yield { type: "message_complete", stopReason: "end_turn" };
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("fallback request projection", () => {
  it("reserves signed history for a configured fallback before that route is lazily constructed", async () => {
    vi.useFakeTimers();
    const primary: LLMProvider = {
      vendor: "openai",
      streamTurn: vi.fn(async function* (): AsyncGenerator<StreamEvent> {
        yield { type: "error", error: "503 fixture unavailable", classification: "network" };
      }),
    };
    let fallbackWire: ReturnType<typeof genericToModelMessages> | undefined;
    const fallback: LLMProvider = {
      vendor: "claude",
      streamTurn: vi.fn(async function* (params: StreamTurnParams): AsyncGenerator<StreamEvent> {
        expect(params.messages).toBe(input.messages);
        expect(params.model).toBe("fallback-model");
        fallbackWire = genericToModelMessages(params.messages, "claude");
        yield { type: "message_complete", stopReason: "end_turn" };
      }),
    };
    const getApiKey = vi.fn(() => "fixture-key");
    const factory = vi.fn(() => fallback);
    const wrapped = new FallbackProvider(primary, [{ provider: "claude", model: "fallback-model" }], getApiKey, factory);
    const expected = estimateRequestInputProjection(input, fallback);

    expect(expected.totalTokens).toBeGreaterThan(100_000);
    expect(estimateRequestInputProjection(input, wrapped)).toEqual(expected);
    expect(estimateRequestInputProjection(input, wrapped.withCallbacks({}))).toEqual(expected);
    expect(getApiKey).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
    expect(primary.streamTurn).not.toHaveBeenCalled();

    const pending = collectStreamEvents(wrapped.streamTurn({ ...input, model: "primary-model" }));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await pending).toEqual([{ type: "message_complete", stopReason: "end_turn" }]);
    expect(primary.streamTurn).toHaveBeenCalledTimes(5);
    expect(factory).toHaveBeenCalledExactlyOnceWith({ vendor: "claude", apiKey: "fixture-key", model: "fallback-model" });
    expect(fallbackWire?.[0]).toMatchObject({
      role: "assistant",
      content: [
        { type: "reasoning", text: "r".repeat(400_000) },
        { type: "text", text: "I inspected the input." },
      ],
    });
  });

  it.each([
    { primaryVendor: "openai", chain: [] },
    { primaryVendor: "openai", chain: [{ provider: "openai", model: "another-model" }] },
    { primaryVendor: "openai", chain: [{ provider: "gemini", model: "another-model" }] },
    { primaryVendor: "claude", chain: [{ provider: "openai", model: "another-model" }] },
    { primaryVendor: "claude", chain: [{ provider: "claude", model: "one-model" }, { provider: "claude", model: "another-model" }] },
  ] satisfies Array<{ primaryVendor: LLMVendor; chain: FallbackChainEntry[] }>)(
    "does not sum routes or count reasoning for an unconfigured route: $primaryVendor $chain",
    ({ primaryVendor, chain }) => {
      const primary = makeProvider(primaryVendor);
      const getApiKey = vi.fn(() => "fixture-key");
      const factory = vi.fn(() => makeProvider("claude"));
      const wrapped = new FallbackProvider(primary, chain, getApiKey, factory);

      expect(estimateRequestInputProjection(input, wrapped))
        .toEqual(estimateRequestInputProjection(input, primary));
      expect(getApiKey).not.toHaveBeenCalled();
      expect(factory).not.toHaveBeenCalled();
    },
  );

  it("keeps empty-chain native projections and callback wrappers unchanged", () => {
    const nativeProjection = { totalTokens: 90, messageTokens: 50, systemPromptTokens: 30, toolSchemaTokens: 10 };
    const projectRequestInput = vi.fn(() => nativeProjection);
    const primary = { ...makeProvider("openai"), projectRequestInput };
    const wrapped = new FallbackProvider(primary, [], vi.fn(() => "fixture-key"));

    expect(wrapped.projectRequestInput(input)).toBe(nativeProjection);
    expect(wrapped.withCallbacks({}).projectRequestInput?.(input)).toBe(nativeProjection);
    expect(estimateRequestInputProjection(input, wrapped)).toBe(nativeProjection);
    expect(projectRequestInput).toHaveBeenCalledWith(input);
  });

  it.each([90, 200_000])("compares a valid native primary as one complete projection: %s tokens", (totalTokens) => {
    const nativeProjection = { totalTokens, messageTokens: totalTokens - 40, systemPromptTokens: 30, toolSchemaTokens: 10 };
    const projectRequestInput = vi.fn(() => nativeProjection);
    const primary = { ...makeProvider("openai"), projectRequestInput };
    const wrapped = new FallbackProvider(primary, [{ provider: "claude", model: "fallback-model" }], vi.fn(() => "fixture-key"));
    const fallbackProjection = estimateRequestInputProjection(input, { vendor: "claude" });
    const expected = totalTokens > fallbackProjection.totalTokens ? nativeProjection : fallbackProjection;

    expect(estimateRequestInputProjection(input, wrapped)).toEqual(expected);
    expect(projectRequestInput).toHaveBeenCalledExactlyOnceWith(input);
  });

  it.each(["throws", "invalid"] as const)("still covers reachable fallbacks when the primary projection %s", (kind) => {
    const primary = {
      ...makeProvider("openai"),
      projectRequestInput: (): ProviderRequestInputProjection => {
        if (kind === "throws") throw new Error("fixture projection failure");
        return { totalTokens: Number.NaN, messageTokens: 0, systemPromptTokens: 0, toolSchemaTokens: 0 };
      },
    };
    const wrapped = new FallbackProvider(primary, [{ provider: "claude", model: "fallback-model" }], vi.fn(() => "fixture-key"));

    expect(estimateRequestInputProjection(input, wrapped))
      .toEqual(estimateRequestInputProjection(input, { vendor: "claude" }));
  });
});
