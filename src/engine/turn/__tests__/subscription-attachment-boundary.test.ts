import { describe, expect, it, vi } from "vitest";

import { FallbackProvider } from "../../llm/vercel/fallback-chain.js";
import { createSubscriptionLlmProvider, SUBSCRIPTION_ATTACHMENT_INPUT_REJECTED } from "../../../main/subscription-llm-provider.js";
import type { SubscriptionRuntimeService } from "../../../main/subscription-runtime-service.js";
import { collectRoundStream } from "../stream-collector.js";

describe("subscription attachment boundary in the conversation engine", () => {
  it("returns the fail-closed attachment error without opening or retrying a subscription session", async () => {
    const openTextSession = vi.fn(async () => {
      throw new Error("subscription session must not open for an attachment");
    });
    const service: Pick<SubscriptionRuntimeService, "openTextSession"> = { openTextSession };
    const primary = createSubscriptionLlmProvider({
      selection: { kind: "subscription", provider: "codex", model: "gpt-5" },
      service,
    });
    const streamTurn = vi.spyOn(primary, "streamTurn");
    const provider = new FallbackProvider(primary, [], () => "must-not-read-api-key");

    const result = await collectRoundStream({
      provider,
      model: "gpt-5",
      systemPrompt: "system",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Inspect this file." },
          { type: "file", data: "data:text/plain;base64,c2VjcmV0", mimeType: "text/plain" },
        ],
      }],
      toolSchemas: [],
      llmSettings: {
        streamSmoothing: "none",
        enableThinking: false,
        thinkingBudgetTokens: 10_000,
      },
    });

    expect(streamTurn).toHaveBeenCalledOnce();
    expect(openTextSession).not.toHaveBeenCalled();
    expect(result.kind).toBe("stream_error");
    if (result.kind !== "stream_error") throw new Error("expected a stream error");
    expect(result.providerError).toMatchObject({
      statusCode: 400,
      providerCode: SUBSCRIPTION_ATTACHMENT_INPUT_REJECTED,
      classification: "unknown",
      messagePreview: "subscription attachment input rejected",
    });
    expect(JSON.stringify(result)).not.toContain("c2VjcmV0");
  });
});
