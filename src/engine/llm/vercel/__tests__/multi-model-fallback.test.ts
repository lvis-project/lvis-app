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
import { describe, it, expect, vi } from "vitest";
import type { LLMProvider, StreamEvent } from "../../types.js";
import { streamWithFallback } from "../fallback-chain.js";
import type { FallbackEntry, ProviderFactory } from "../fallback-chain.js";

// ─── helpers ────────────────────────────────────────────────────

async function collect(iter: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

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
});

// ─── (b) Primary transient error → fallback succeeds ─────────────

describe("(b) primary transient error → fallback succeeds", () => {
  it("retryable error event triggers fallback; fallback yields good events", async () => {
    const primary: LLMProvider = {
      vendor: "claude" as any,
      streamTurn: async function* () {
        yield { type: "error" as const, error: "500 internal server error", classification: "network" };
      },
    };
    const fallbackProvider = makeProvider("openai", GOOD_EVENTS);
    const factory: ProviderFactory = vi.fn(() => fallbackProvider);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const events = await collect(
      streamWithFallback(primary, BASE_PARAMS, CHAIN, getApiKey, undefined, factory),
    );

    expect(factory).toHaveBeenCalledOnce();
    expect(events).toEqual(GOOD_EVENTS);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("fallback:"));
    warnSpy.mockRestore();
  });

  it("rate-limit (429) error event also triggers fallback", async () => {
    const primary: LLMProvider = {
      vendor: "claude" as any,
      streamTurn: async function* () {
        yield { type: "error" as const, error: "429 rate limit exceeded", classification: "rate-limit" };
      },
    };
    const fallbackProvider = makeProvider("openai", GOOD_EVENTS);
    const factory: ProviderFactory = vi.fn(() => fallbackProvider);

    const events = await collect(
      streamWithFallback(primary, BASE_PARAMS, CHAIN, getApiKey, undefined, factory),
    );

    expect(factory).toHaveBeenCalledOnce();
    expect(events).toEqual(GOOD_EVENTS);
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

    await expect(
      collect(streamWithFallback(primary, BASE_PARAMS, CHAIN, getApiKey, undefined, factory)),
    ).rejects.toThrow("second failure");
  });

  it("throws with no chain — just primary failure", async () => {
    const primary: LLMProvider = {
      vendor: "claude" as any,
      streamTurn: async function* () {
        yield { type: "error" as const, error: "network error", classification: "network" };
      },
    };

    await expect(
      collect(streamWithFallback(primary, BASE_PARAMS, [], getApiKey)),
    ).rejects.toThrow("network error");
  });
});
