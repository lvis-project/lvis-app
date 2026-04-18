/**
 * Probe: Anthropic provider metadata shape (cache tokens).
 *
 * Runs against the real API when LVIS_RUN_PROBES=1 AND ANTHROPIC_API_KEY is set.
 * Writes observations to .omc/probes/anthropic-cache.json.
 */
import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const SHOULD_RUN =
  process.env.LVIS_RUN_PROBES === "1" && !!process.env.ANTHROPIC_API_KEY;

describe.skipIf(!SHOULD_RUN)("probe: anthropic cache providerMetadata", () => {
  it("captures cacheCreationInputTokens / cacheReadInputTokens shape", async () => {
    const { streamText } = await import("ai");
    const { anthropic } = await import("@ai-sdk/anthropic");

    const result = streamText({
      model: anthropic("claude-sonnet-4-5"),
      messages: [
        {
          role: "system",
          content: [
            {
              type: "text",
              text: "You are a helpful assistant. " + "x".repeat(2048),
              // experimental field (shape captured by probe) — cast via `any`
              // because this member is not on the stable type yet.
              ...({
                experimental_providerMetadata: {
                  anthropic: { cacheControl: { type: "ephemeral" } },
                },
              } as any),
            },
          ],
        },
        { role: "user", content: "Say hi." },
      ] as any,
    });

    const finish = await result.finishReason;
    const usage = await result.usage;
    const pm = await (result as any).providerMetadata;

    const out = {
      finishReason: finish,
      usage,
      providerMetadata: pm,
      capturedAt: new Date().toISOString(),
    };

    const dir = resolve(process.cwd(), ".omc/probes");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      resolve(dir, "anthropic-cache.json"),
      JSON.stringify(out, null, 2),
    );

    expect(finish).toBeDefined();
  }, 60_000);
});
