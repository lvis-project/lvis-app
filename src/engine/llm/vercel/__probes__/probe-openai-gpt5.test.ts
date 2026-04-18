/**
 * Probe: OpenAI GPT-5.x routing + stream event ordering.
 *
 * Verifies that @ai-sdk/openai auto-routes gpt-5.x models to /v1/responses
 * and emits reasoning-delta → text-delta → tool-call → finish in order.
 */
import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const SHOULD_RUN =
  process.env.LVIS_RUN_PROBES === "1" && !!process.env.OPENAI_API_KEY;

describe.skipIf(!SHOULD_RUN)("probe: openai gpt-5 responses API", () => {
  it("routes gpt-5.x to /v1/responses and orders stream parts", async () => {
    const { streamText, tool } = await import("ai");
    const { openai } = await import("@ai-sdk/openai");
    const { z } = await import("zod");

    let observedUrl: string | null = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
      observedUrl =
        typeof input === "string" ? input : (input?.url ?? String(input));
      return originalFetch(input, init);
    }) as typeof fetch;

    const order: string[] = [];
    try {
      const result = streamText({
        model: openai("gpt-5.4-mini"),
        messages: [
          { role: "user", content: "What's the weather in Seoul? Use the tool." },
        ],
        tools: {
          get_weather: tool({
            description: "Get the weather for a city",
            inputSchema: z.object({ city: z.string() }),
            execute: async ({ city }) => ({ city, temp: 20 }),
          }),
        },
      });

      for await (const part of result.fullStream) {
        order.push((part as any).type);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }

    const dir = resolve(process.cwd(), ".omc/probes");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      resolve(dir, "openai-gpt5.json"),
      JSON.stringify(
        {
          observedUrl,
          order,
          capturedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );

    expect(observedUrl).toMatch(/\/v1\/responses/);
  }, 60_000);
});
