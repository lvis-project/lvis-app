/**
 * Lazy-load semantics for `createProvider` (PR #705).
 *
 * The factory must:
 * 1. Return a proxy without evaluating `./vercel/adapter.js`.
 * 2. Trigger the adapter import only on the first `streamTurn` call.
 * 3. Reset the inner promise on transient construction failure so the
 *    next call retries rather than reusing a rejected promise.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { StreamTurnParams } from "../types.js";

const TURN: StreamTurnParams = {
  model: "gpt-4",
  systemPrompt: "",
  messages: [],
};

async function drain(iter: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const event of iter) out.push(event);
  return out;
}

describe("createProvider lazy adapter (PR #705)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("../vercel/adapter.js");
  });

  it("does not invoke the Vercel adapter at construction time", async () => {
    const ctor = vi.fn();
    vi.doMock("../vercel/adapter.js", () => ({ VercelUnifiedProvider: ctor }));

    const { createProvider } = await import("../provider-factory.js");
    const provider = createProvider({ vendor: "openai", apiKey: "k" });

    expect(provider.vendor).toBe("openai");
    expect(provider.constructor.name).toBe("LazyVercelProvider");
    expect(ctor).not.toHaveBeenCalled();
  });

  it("invokes the Vercel adapter on first streamTurn and reuses on subsequent calls", async () => {
    const innerStreamTurn = vi.fn(async function* () {
      yield { type: "text_delta", text: "hi" };
    });
    const ctor = vi.fn(function () {
      return {
        vendor: "openai",
        streamTurn: innerStreamTurn,
      };
    });
    vi.doMock("../vercel/adapter.js", () => ({ VercelUnifiedProvider: ctor }));

    const { createProvider } = await import("../provider-factory.js");
    const provider = createProvider({ vendor: "openai", apiKey: "k" });

    expect(ctor).not.toHaveBeenCalled();

    const first = await drain(provider.streamTurn(TURN));
    expect(first).toEqual([{ type: "text_delta", text: "hi" }]);
    expect(ctor).toHaveBeenCalledTimes(1);

    await drain(provider.streamTurn(TURN));
    expect(ctor).toHaveBeenCalledTimes(1);
    expect(innerStreamTurn).toHaveBeenCalledTimes(2);
  });

  it("retries after a transient adapter construction failure", async () => {
    let attempt = 0;
    const ctor = vi.fn(function () {
      if (++attempt === 1) throw new Error("first attempt fails");
      return {
        vendor: "openai",
        streamTurn: async function* () {
          yield { type: "text_delta", text: "second" };
        },
      };
    });
    vi.doMock("../vercel/adapter.js", () => ({ VercelUnifiedProvider: ctor }));

    const { createProvider } = await import("../provider-factory.js");
    const provider = createProvider({ vendor: "openai", apiKey: "k" });

    await expect(drain(provider.streamTurn(TURN))).rejects.toThrow(
      "first attempt fails",
    );

    const second = await drain(provider.streamTurn(TURN));
    expect(second).toEqual([{ type: "text_delta", text: "second" }]);
    expect(ctor).toHaveBeenCalledTimes(2);
  });
});
