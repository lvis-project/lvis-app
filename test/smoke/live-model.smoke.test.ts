import { describe, it, expect } from "vitest";

import { VercelUnifiedProvider } from "../../src/engine/llm/vercel/adapter.js";
import { LLM_VENDOR_DEFAULTS } from "../../src/shared/llm-vendor-defaults.js";
import type { StreamEvent } from "../../src/engine/llm/types.js";

/**
 * Live model smoke tests — real HTTP to a real provider, real money.
 *
 * Skipped unless `LVIS_SMOKE_OPENROUTER_KEY` is set, so CI and unrelated pushes
 * neither fail nor get billed. Nothing here is mocked; that is the point. The
 * mocked adapter suites pass while the shipped binary can still break on wire
 * shape, auth, or model naming, and only a real call catches that.
 *
 * The key comes from the environment rather than the app's own secret store on
 * purpose: the store is Chromium OSCrypt-encrypted and only readable inside a
 * real Electron runtime, which the vitest runner is not (it runs Electron as
 * plain node). `scripts/smoke-live-model.mjs` bridges the two — it runs under
 * Electron, decrypts the key the user already configured in the app, and spawns
 * this suite with it in the child environment.
 *
 * Run: `bun run smoke:llm`
 *   or `LVIS_SMOKE_OPENROUTER_KEY=sk-... bun run test:vitest -- test/smoke/live-model.smoke.test.ts`
 */

const apiKey = process.env.LVIS_SMOKE_OPENROUTER_KEY?.trim() || null;
const live = !!apiKey;

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function provider(): VercelUnifiedProvider {
  return new VercelUnifiedProvider(
    "openrouter",
    apiKey as string,
    LLM_VENDOR_DEFAULTS.openrouter.baseUrl,
  );
}

/** A cheap, always-available routing target. */
const MODEL = "openrouter/auto";

describe.skipIf(!live)("live model smoke (OpenRouter)", () => {
  it("streams a real completion", async () => {
    const events = await collect(
      provider().streamTurn({
        model: MODEL,
        systemPrompt: "Answer with the single word: pong",
        messages: [{ role: "user", content: "ping" }],
      }),
    );

    const errors = events.filter((e) => e.type === "error");
    expect(errors, JSON.stringify(errors)).toEqual([]);

    const text = events
      .filter((e): e is Extract<StreamEvent, { type: "text_delta" }> => e.type === "text_delta")
      .map((e) => e.text)
      .join("");
    // Assert on substance, not just "no throw" — an empty stream that ends
    // cleanly is exactly the silent failure this suite exists to catch.
    expect(text.trim().length).toBeGreaterThan(0);
  }, 120_000);

  it("emits a tool call when given a tool", async () => {
    const events = await collect(
      provider().streamTurn({
        model: MODEL,
        systemPrompt:
          "You must call the `get_weather` tool to answer. Do not answer from memory.",
        messages: [{ role: "user", content: "What is the weather in Seoul?" }],
        tools: [
          {
            name: "get_weather",
            description: "Look up the current weather for a city.",
            inputSchema: {
              type: "object",
              properties: { city: { type: "string" } },
              required: ["city"],
            },
          },
        ],
      }),
    );

    const errors = events.filter((e) => e.type === "error");
    expect(errors, JSON.stringify(errors)).toEqual([]);

    // The tool wire is what the mocked suites cannot prove: schema shape,
    // vendor-specific tool encoding, and the streamed tool-call event all have
    // to line up against a real provider.
    const toolCalls = events.filter((e) => e.type === "tool_call");
    expect(toolCalls.length).toBeGreaterThan(0);
  }, 120_000);
});

describe.skipIf(live)("live model smoke (skipped)", () => {
  it("records that it did not run", () => {
    // A skipped live suite must never read as a passing one.
    expect(live).toBe(false);
    expect(process.env.LVIS_SMOKE_OPENROUTER_KEY ?? "").toBe("");
  });
});
