/**
 * TokenCostBadge — vendor-branch cost parity.
 *
 * Closes #854 — the badge previously re-implemented cache cost math inline
 * (claude → cache additive, others → cache ignored). After SoT consolidation
 * the badge calls `shared/pricing-data.ts:computeCost`, so this test mirrors
 * the vendor matrix in `engine/__tests__/usage-stats.test.ts` to detect
 * future drift via render-level assertions on the cost-mode label.
 */
// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { TooltipProvider } from "../../../../components/ui/tooltip.js";
import { TokenCostBadge } from "../TokenCostBadge.js";
import { computeCost, type ModelPricing } from "../../../../shared/pricing-data.js";
import type { LLMVendor } from "../../../../shared/llm-vendor-defaults.js";

const sonnet: ModelPricing = { inputPer1M: 3, outputPer1M: 15, contextWindow: 200_000 };
const gpt: ModelPricing = { inputPer1M: 2, outputPer1M: 8, contextWindow: 1_000_000 };
const flash: ModelPricing = { inputPer1M: 0, outputPer1M: 0, contextWindow: 1_000_000 };

function renderInCostMode(props: Parameters<typeof TokenCostBadge>[0]) {
  const result = render(
    <TooltipProvider>
      <TokenCostBadge {...props} />
    </TooltipProvider>,
  );
  // Badge defaults to "tokens" mode. `fireEvent.click` wraps in `act()` so
  // React 18's state update flushes before the next assertion — a raw
  // `button.click()` leaves the test querying the stale render.
  const btn = result.container.querySelector("button");
  if (btn) fireEvent.click(btn);
  return result;
}

describe("TokenCostBadge — cost parity with shared computeCost", () => {
  afterEach(() => cleanup());

  it.each<{ vendor: LLMVendor; pricing: ModelPricing; label: string }>([
    { vendor: "claude", pricing: sonnet, label: "claude — cache additive at Anthropic ratios" },
    { vendor: "openai", pricing: gpt, label: "openai — cache fields ignored (already in prompt_tokens)" },
    { vendor: "copilot", pricing: gpt, label: "copilot — cache fields ignored" },
    { vendor: "azure-foundry", pricing: gpt, label: "azure-foundry — cache fields ignored" },
    { vendor: "gemini", pricing: flash, label: "gemini — cache fields ignored, zero list price" },
    { vendor: "vertex-ai", pricing: flash, label: "vertex-ai — cache fields ignored, zero list price" },
  ])("$label", ({ vendor, pricing }) => {
    const freshInputTokens = 1_000_000;
    const tokensOut = 1_000_000;
    const cacheReadTokens = 500_000;
    const cacheWriteTokens = 200_000;

    const expected = computeCost(
      { inputTokens: freshInputTokens, outputTokens: tokensOut, cacheReadTokens, cacheWriteTokens },
      pricing,
      vendor,
    );

    renderInCostMode({
      tokensIn: 1_500_000,
      freshInputTokens,
      tokensOut,
      cacheReadTokens,
      cacheWriteTokens,
      pricing,
      vendor,
    });

    const costSpan = screen.getByText(/^≈ \$/);
    const numeric = Number((costSpan.textContent ?? "").replace(/[^0-9.]/g, ""));
    // Tolerance = cents — `formatCost` rounds for display; we only need to
    // detect formula drift, not float wobble.
    expect(numeric).toBeCloseTo(expected, 2);
  });

  it("toggle stays disabled and cost label is absent when pricing is undefined", () => {
    render(
      <TooltipProvider>
        <TokenCostBadge
          tokensIn={1000}
          freshInputTokens={500}
          tokensOut={500}
          vendor="claude"
        />
      </TooltipProvider>,
    );
    const btn = screen.getByRole("button");
    expect(btn.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(btn);
    expect(screen.queryByText(/^≈ \$/)).toBeNull();
  });

  it("renders nothing when both tokensIn and headline tokens are zero", () => {
    const { container } = render(
      <TooltipProvider>
        <TokenCostBadge tokensIn={0} freshInputTokens={0} tokensOut={0} />
      </TooltipProvider>,
    );
    expect(container.firstChild).toBeNull();
  });
});
