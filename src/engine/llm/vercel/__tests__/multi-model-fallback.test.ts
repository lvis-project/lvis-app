/**
 * D1a — multi-model fallback chain tests.
 *
 * Tests cover:
 *   (a) Primary succeeds → no fallback attempt.
 *   (b) Primary throws transient error (5xx/network) → falls back to next, succeeds.
 *   (c) Primary throws auth error (401) → no fallback, re-throws.
 *   (d) AbortError from primary → no fallback, re-throws (user cancel sacred).
 *   (e) All chain entries exhausted → throws last error.
 */
import { afterEach, describe, it, expect, vi } from "vitest";
import { collectStreamEvents as collect } from "./test-helpers.js";
import type { LLMProvider, StreamEvent } from "../../types.js";
import { FallbackProvider, streamWithFallback } from "../fallback-chain.js";
import type { FallbackEntry, ProviderFactory } from "../fallback-chain.js";

// ─── helpers ────────────────────────────────────────────────────


function makeProvider(vendor: string, events: StreamEvent[]): LLMProvider {
  return {
    vendor: vendor as any,
    streamTurn: async function* () {
      for (const ev of events) yield ev;
    },
  };
}

function makeThrowingProvider(vendor: string, error: Error): LLMProvider {
  return {
    vendor: vendor as any,
    streamTurn(): AsyncIterable<StreamEvent> {
      return (async function* (): AsyncGenerator<StreamEvent, void, unknown> {
        throw error;
      })();
    },
  };
}

const GOOD_EVENTS: StreamEvent[] = [
  { type: "text_delta", text: "hello" },
  { type: "message_complete", stopReason: "end_turn" },
];

const BASE_PARAMS = {
  model: "primary-model",
  systemPrompt: "sys",
  messages: [{ role: "user" as const, content: "hi" }],
};

const CHAIN: FallbackEntry[] = [
  { provider: "openai", model: "fallback-model" },
];

const getApiKey = (_v: any) => "test-key";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ─── (a) Primary succeeds → no fallback ─────────────────────────

describe("(a) primary succeeds — no fallback", () => {
  it("yields all primary events without touching chain", async () => {
    const primary = makeProvider("claude", GOOD_EVENTS);
    const factorySpy: ProviderFactory = vi.fn(() => makeProvider("openai", [
      { type: "text_delta", text: "should not appear" },
    ]));

    const events = await collect(
      streamWithFallback(primary, BASE_PARAMS, CHAIN, getApiKey, undefined, factorySpy),
    );

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: "text_delta", text: "hello" });
    expect(events[1]).toEqual({ type: "message_complete", stopReason: "end_turn" });
    // Factory must not be called — primary succeeded.
    expect(factorySpy).not.toHaveBeenCalled();
  });

  it("waits for a slow first event instead of aborting the primary provider", async () => {
    vi.useFakeTimers();
    const primary: LLMProvider = {
      vendor: "openai" as any,
      streamTurn: vi.fn(async function* () {
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        yield* GOOD_EVENTS;
      }),
    };
    const factorySpy: ProviderFactory = vi.fn(() => makeProvider("azure-foundry", [
      { type: "text_delta", text: "fallback should not appear" },
    ]));

    const pending = collect(
      streamWithFallback(primary, BASE_PARAMS, CHAIN, getApiKey, undefined, factorySpy),
    );
    await vi.advanceTimersByTimeAsync(1_000);

    expect(primary.streamTurn).toHaveBeenCalledTimes(1);
    expect(factorySpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);
    const events = await pending;

    expect(events).toEqual(GOOD_EVENTS);
    expect(factorySpy).not.toHaveBeenCalled();
  });
});

// ─── (b) Primary transient error → fallback succeeds ─────────────

describe("(b) primary transient error → fallback succeeds", () => {
  it("retryable error event triggers fallback; fallback yields good events", async () => {
    vi.useFakeTimers();
    const primary: LLMProvider = {
      vendor: "claude" as any,
      streamTurn: async function* () {
        yield { type: "error" as const, error: "500 internal server error", classification: "network" };
      },
    };
    const fallbackProvider = makeProvider("openai", GOOD_EVENTS);
    const factory: ProviderFactory = vi.fn(() => fallbackProvider);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const pending = collect(
      streamWithFallback(primary, BASE_PARAMS, CHAIN, getApiKey, undefined, factory),
    );
    await vi.advanceTimersByTimeAsync(5_000);
    const events = await pending;

    expect(factory).toHaveBeenCalledOnce();
    expect(events).toEqual(GOOD_EVENTS);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("fallback:"));
  });

  it("rate-limit (429) error event also triggers fallback", async () => {
    vi.useFakeTimers();
    const primary: LLMProvider = {
      vendor: "claude" as any,
      streamTurn: async function* () {
        yield { type: "error" as const, error: "429 rate limit exceeded", classification: "rate-limit" };
      },
    };
    const fallbackProvider = makeProvider("openai", GOOD_EVENTS);
    const factory: ProviderFactory = vi.fn(() => fallbackProvider);

    const pending = collect(
      streamWithFallback(primary, BASE_PARAMS, CHAIN, getApiKey, undefined, factory),
    );
    await vi.advanceTimersByTimeAsync(5_000);
    const events = await pending;

    expect(factory).toHaveBeenCalledOnce();
    expect(events).toEqual(GOOD_EVENTS);
  });

  it("retries a provider five times before moving to the fallback model", async () => {
    vi.useFakeTimers();
    const statuses: unknown[] = [];
    const primary: LLMProvider = {
      vendor: "claude" as any,
      streamTurn: vi.fn(async function* () {
        yield { type: "error" as const, error: "500 internal server error", classification: "network" };
      }),
    };
    const fallbackProvider = makeProvider("openai", GOOD_EVENTS);
    const factory: ProviderFactory = vi.fn(() => fallbackProvider);

    const pending = collect(
      streamWithFallback(primary, BASE_PARAMS, CHAIN, getApiKey, undefined, factory, {
        onStatus: (status) => statuses.push(status),
      }),
    );
    await vi.advanceTimersByTimeAsync(4_999);

    expect(primary.streamTurn).toHaveBeenCalledTimes(5);
    expect(factory).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    const events = await pending;

    expect(primary.streamTurn).toHaveBeenCalledTimes(5);
    expect(factory).toHaveBeenCalledOnce();
    expect(events).toEqual(GOOD_EVENTS);
    expect(statuses).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: "retry", attempt: 2, maxAttempts: 5 }),
      expect.objectContaining({ phase: "retry", attempt: 5, maxAttempts: 5 }),
      expect.objectContaining({ phase: "fallback", from: "claude/primary-model", to: "openai/fallback-model" }),
      expect.objectContaining({ phase: "attempt", provider: "openai", model: "fallback-model" }),
    ]));
  });

  it("passes vendor-specific endpoint settings to the fallback provider", async () => {
    vi.useFakeTimers();
    const primary: LLMProvider = {
      vendor: "openai" as any,
      streamTurn: vi.fn(async function* () {
        yield { type: "error" as const, error: "500 internal server error", classification: "network" };
      }),
    };
    const fallbackProvider = makeProvider("azure-foundry", GOOD_EVENTS);
    const factory: ProviderFactory = vi.fn(() => fallbackProvider);
    const chain: FallbackEntry[] = [{
      provider: "azure-foundry",
      model: "gpt-5.4-nano",
      baseUrl: "https://example.openai.azure.com/openai/deployments/gpt/",
    }];

    const pending = collect(streamWithFallback(primary, BASE_PARAMS, chain, getApiKey, undefined, factory));
    await vi.advanceTimersByTimeAsync(5_000);
    const events = await pending;

    expect(factory).toHaveBeenCalledWith({
      vendor: "azure-foundry",
      apiKey: "test-key",
      model: "gpt-5.4-nano",
      baseUrl: "https://example.openai.azure.com/openai/deployments/gpt/",
    });
    expect(events).toEqual(GOOD_EVENTS);
  });

  it("does not persist scoped status callbacks onto later plain provider calls", async () => {
    vi.useFakeTimers();
    const statuses: unknown[] = [];
    const primary: LLMProvider = {
      vendor: "claude" as any,
      streamTurn: vi.fn(async function* () {
        yield { type: "error" as const, error: "500 internal server error", classification: "network" };
      }),
    };
    const fallbackProvider = makeProvider("openai", GOOD_EVENTS);
    const factory: ProviderFactory = vi.fn(() => fallbackProvider);
    const provider = new FallbackProvider(primary, CHAIN, getApiKey, undefined, factory);

    const scoped = collect(provider.streamTurnWithCallbacks(BASE_PARAMS, {
      onStatus: (status) => statuses.push(status),
    }));
    await vi.advanceTimersByTimeAsync(5_000);
    await scoped;
    const scopedStatusCount = statuses.length;
    expect(scopedStatusCount).toBeGreaterThan(0);

    const plain = collect(provider.streamTurn(BASE_PARAMS));
    await vi.advanceTimersByTimeAsync(5_000);
    await plain;

    expect(statuses).toHaveLength(scopedStatusCount);
  });
});

// ─── (c) Auth error (401) → no fallback ─────────────────────────

describe("(c) auth error → no fallback, re-throws", () => {
  it("error event with classification=api-key is yielded as-is (not retried)", async () => {
    const primary: LLMProvider = {
      vendor: "claude" as any,
      streamTurn: async function* () {
        yield { type: "error" as const, error: "401 unauthorized", classification: "api-key" };
      },
    };
    const factory: ProviderFactory = vi.fn(() => makeProvider("openai", GOOD_EVENTS));

    const events = await collect(
      streamWithFallback(primary, BASE_PARAMS, CHAIN, getApiKey, undefined, factory),
    );

    // Non-retryable error event is yielded directly — factory never called.
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", classification: "api-key" });
    expect(factory).not.toHaveBeenCalled();
  });

  it("thrown error matching 401 pattern is re-thrown without fallback", async () => {
    const primary = makeThrowingProvider("claude", new Error("401 unauthorized"));
    const factory: ProviderFactory = vi.fn(() => makeProvider("openai", GOOD_EVENTS));

    await expect(
      collect(streamWithFallback(primary, BASE_PARAMS, CHAIN, getApiKey, undefined, factory)),
    ).rejects.toThrow("401 unauthorized");

    expect(factory).not.toHaveBeenCalled();
  });

  it("configuration errors such as missing baseUrl are not retried", async () => {
    const primary = makeThrowingProvider(
      "azure-foundry",
      new Error("VercelUnifiedProvider(azure-foundry): baseUrl is required"),
    );
    const factory: ProviderFactory = vi.fn(() => makeProvider("openai", GOOD_EVENTS));

    await expect(
      collect(streamWithFallback(primary, BASE_PARAMS, CHAIN, getApiKey, undefined, factory)),
    ).rejects.toThrow("baseUrl is required");

    expect(factory).not.toHaveBeenCalled();
  });
});

// ─── (d) AbortError → no fallback ───────────────────────────────

describe("(d) AbortError → no fallback, re-throws (user cancel sacred)", () => {
  it("AbortError is never retried", async () => {
    const abortErr = Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    const primary = makeThrowingProvider("claude", abortErr);
    const factory: ProviderFactory = vi.fn(() => makeProvider("openai", GOOD_EVENTS));

    await expect(
      collect(streamWithFallback(primary, BASE_PARAMS, CHAIN, getApiKey, undefined, factory)),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(factory).not.toHaveBeenCalled();
  });
});

// ─── (e) All chain exhausted → throws last error ─────────────────

describe("(e) all chain exhausted → throws last error", () => {
  it("throws when every entry in the chain fails", async () => {
    vi.useFakeTimers();
    const primary: LLMProvider = {
      vendor: "claude" as any,
      streamTurn: async function* () {
        yield { type: "error" as const, error: "connection refused", classification: "network" };
      },
    };
    const alsoFailing: LLMProvider = {
      vendor: "openai" as any,
      streamTurn: async function* () {
        yield { type: "error" as const, error: "second failure", classification: "network" };
      },
    };
    const factory: ProviderFactory = vi.fn(() => alsoFailing);

    const pending = expect(
      collect(streamWithFallback(primary, BASE_PARAMS, CHAIN, getApiKey, undefined, factory)),
    ).rejects.toThrow("second failure");
    await vi.advanceTimersByTimeAsync(10_000);
    await pending;
  });

  it("throws with no chain — just primary failure", async () => {
    vi.useFakeTimers();
    const primary: LLMProvider = {
      vendor: "claude" as any,
      streamTurn: async function* () {
        yield { type: "error" as const, error: "network error", classification: "network" };
      },
    };

    const pending = expect(
      collect(streamWithFallback(primary, BASE_PARAMS, [], getApiKey)),
    ).rejects.toThrow("network error");
    await vi.advanceTimersByTimeAsync(5_000);
    await pending;
  });
});
