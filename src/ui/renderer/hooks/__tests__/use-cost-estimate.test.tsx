import "../../../../../test/renderer/setup.js";

import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { estimateTokens } from "../../../../lib/cost-estimator.js";
import { useCostEstimate } from "../use-cost-estimate.js";
import type { ChatEntry } from "../../../../lib/chat-stream-state.js";

describe("useCostEstimate", () => {
  it("uses the latest context carrier instead of reserializing stale visible history", () => {
    const staleVisibleHistory = "x".repeat(2_000_000);
    const entries: ChatEntry[] = [
      { kind: "assistant", text: staleVisibleHistory, streaming: false },
      { kind: "context_usage", tokensIn: 42_000, source: "compact-estimate" },
    ];

    const { result } = renderHook(() =>
      useCostEstimate({
        entries,
        question: "hi",
        llmVendor: "azure-foundry",
        llmModel: "gpt-5.4-mini",
        maxOutputTokens: 1_000,
        composeOutgoing: (raw) => ({ text: raw }),
      }),
    );

    expect(result.current.costEstimate.inputTokens).toBe(
      42_000 + estimateTokens(JSON.stringify({ role: "user", content: "hi" })),
    );
    expect(result.current.costEstimate.inputTokens).toBeLessThan(50_000);
  });

  it("adds image attachment token estimates to the pre-send input cost", () => {
    const { result: withoutImage } = renderHook(() =>
      useCostEstimate({
        entries: [],
        question: "inspect",
        llmVendor: "azure-foundry",
        llmModel: "gpt-5.4-mini",
        maxOutputTokens: 1_000,
        composeOutgoing: (raw) => ({ text: raw, attachments: [] }),
      }),
    );
    const { result: withImage } = renderHook(() =>
      useCostEstimate({
        entries: [],
        question: "inspect",
        llmVendor: "azure-foundry",
        llmModel: "gpt-5.4-mini",
        maxOutputTokens: 1_000,
        composeOutgoing: (raw) => ({
          text: raw,
          attachments: [{
            type: "image",
            image: "data:image/png;base64,abc",
            mimeType: "image/png",
            width: 1024,
            height: 1024,
            bytes: 4096,
          }],
        }),
      }),
    );

    expect(withImage.current.costEstimate.inputTokens)
      .toBeGreaterThan(withoutImage.current.costEstimate.inputTokens);
  });

  it("marks zero-price placeholder models as pricing unknown instead of showing a fake zero cost", () => {
    const { result } = renderHook(() =>
      useCostEstimate({
        entries: [],
        question: "hi",
        llmVendor: "openai",
        llmModel: "gpt-4o",
        maxOutputTokens: 1_000,
        composeOutgoing: (raw) => ({ text: raw }),
      }),
    );

    expect(result.current.costEstimate.inputTokens).toBeGreaterThan(0);
    expect(result.current.costEstimate.total).toBe(0);
    expect(result.current.costEstimate.pricingKnown).toBe(false);
    expect(result.current.costBadgeClass).toBe("text-muted-foreground");
  });
});
