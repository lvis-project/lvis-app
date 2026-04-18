/**
 * Probe: Gemini provider metadata shape.
 */
import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const SHOULD_RUN =
  process.env.LVIS_RUN_PROBES === "1" && !!process.env.GOOGLE_API_KEY;

describe.skipIf(!SHOULD_RUN)("probe: gemini providerMetadata", () => {
  it("captures google providerMetadata shape", async () => {
    const { streamText } = await import("ai");
    const { google } = await import("@ai-sdk/google");

    const result = streamText({
      model: google("gemini-2.5-flash"),
      messages: [{ role: "user", content: "Say hi." }],
    });

    const finish = await result.finishReason;
    const usage = await result.usage;
    const pm = await (result as any).providerMetadata;

    const dir = resolve(process.cwd(), ".omc/probes");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      resolve(dir, "gemini.json"),
      JSON.stringify(
        {
          finishReason: finish,
          usage,
          providerMetadata: pm,
          capturedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );

    expect(finish).toBeDefined();
  }, 60_000);
});
