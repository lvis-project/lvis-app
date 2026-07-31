import "../../../../../test/renderer/setup.js";

import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { estimateOutgoingUserMessageTokens } from "../../../../shared/multimodal-token-estimate.js";
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
        draft: { text: "hi" },
        llmVendor: "azure-foundry",
        llmModel: "gpt-5.4-mini",
        maxOutputTokens: 1_000,
      }),
    );

    expect(result.current.costEstimate.inputTokens).toBe(
      42_000 + estimateOutgoingUserMessageTokens("hi"),
    );
    expect(result.current.costEstimate.inputTokens).toBeLessThan(50_000);
  });

  it("adds image attachment token estimates to the pre-send input cost", () => {
    const image = {
      type: "image" as const,
      image: "data:image/png;base64,abc",
      mimeType: "image/png",
      width: 1024,
      height: 1024,
      bytes: 4096,
    };
    const { result: withoutImage } = renderHook(() =>
      useCostEstimate({
        entries: [],
        draft: { text: "inspect" },
        llmVendor: "azure-foundry",
        llmModel: "gpt-5.4-mini",
        maxOutputTokens: 1_000,
      }),
    );
    const { result: withImage } = renderHook(() =>
      useCostEstimate({
        entries: [],
        draft: { text: "inspect", attachments: [image] },
        llmVendor: "azure-foundry",
        llmModel: "gpt-5.4-mini",
        maxOutputTokens: 1_000,
      }),
    );

    expect(withImage.current.costEstimate.inputTokens)
      .toBeGreaterThan(withoutImage.current.costEstimate.inputTokens);
  });

  it("uses the same Korean and resource-text draft estimate as the provider-wire path", () => {
    const attachments = [
      { type: "text" as const, text: "<resource>서버가 제공한 긴 리소스 본문</resource>" },
      {
        type: "image" as const,
        image: "data:image/png;base64,abc",
        mimeType: "image/png",
        width: 2048,
        height: 512,
      },
    ];
    const entries: ChatEntry[] = [{ kind: "context_usage", tokensIn: 7_000, source: "compact-estimate" }];
    const draft = "한글 사용자 질문";

    const { result } = renderHook(() =>
      useCostEstimate({
        entries,
        draft: { text: draft, attachments },
        llmVendor: "azure-foundry",
        llmModel: "gpt-5.4-mini",
        maxOutputTokens: 1_000,
      }),
    );

    expect(result.current.costEstimate.inputTokens).toBe(
      7_000 + estimateOutgoingUserMessageTokens(draft, attachments),
    );
  });

  it("marks zero-price placeholder models as pricing unknown instead of showing a fake zero cost", () => {
    const { result } = renderHook(() =>
      useCostEstimate({
        entries: [],
        draft: { text: "hi" },
        llmVendor: "openai",
        llmModel: "gpt-4o",
        maxOutputTokens: 1_000,
      }),
    );

    expect(result.current.costEstimate.inputTokens).toBeGreaterThan(0);
    expect(result.current.costEstimate.total).toBe(0);
    expect(result.current.costEstimate.pricingKnown).toBe(false);
    expect(result.current.costBadgeClass).toBe("text-muted-foreground");
  });

  it("does not derive an API cost estimate when the runtime has no verified billing contract", () => {
    const { result } = renderHook(() =>
      useCostEstimate({
        entries: [],
        draft: { text: "subscription runtime draft" },
        // These deliberately stale API values must be ignored.
        llmVendor: "openai",
        llmModel: "gpt-5.4-nano",
        maxOutputTokens: 1_000,
        enabled: false,
      }),
    );

    expect(result.current.costEstimate).toBeUndefined();
    expect(result.current.costBadgeClass).toBeUndefined();
  });
});