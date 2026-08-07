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
import { computeCost, lookupPricing, type ModelPricing } from "../../../../shared/pricing-data.js";
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
    { vendor: "openai", pricing: gpt, label: "openai — provider-raw input includes cached tokens" },
    { vendor: "copilot", pricing: gpt, label: "copilot — provider-raw input includes cached tokens" },
    { vendor: "azure-foundry", pricing: gpt, label: "azure-foundry — provider-raw input includes cached tokens" },
    { vendor: "gemini", pricing: flash, label: "gemini — provider-raw input includes cached tokens, zero list price" },
    { vendor: "vertex-ai", pricing: flash, label: "vertex-ai — provider-raw input includes cached tokens, zero list price" },
  ])("$label", ({ vendor, pricing }) => {
    const freshInputTokens = 1_000_000;
    const tokensOut = 1_000_000;
    const cacheReadTokens = 500_000;
    const cacheWriteTokens = 200_000;
    const costInputTokens = vendor === "claude"
      ? freshInputTokens
      : freshInputTokens + cacheReadTokens + cacheWriteTokens;

    const expected = computeCost(
      { inputTokens: costInputTokens, outputTokens: tokensOut, cacheReadTokens, cacheWriteTokens },
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

  it("toggle stays disabled and unknown-cost state is visible when pricing is undefined", () => {
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
    expect(screen.getByText("미정")).toBeTruthy();
  });

  it("sums OpenAI long-context pricing per request segment", () => {
    const pricing = lookupPricing("openai", "gpt-5.4");
    renderInCostMode({
      tokensIn: 410_000,
      freshInputTokens: 400_000,
      tokensOut: 0,
      pricing,
      vendor: "openai",
      usageByModel: [
        {
          vendorProvider: "openai",
          vendorModel: "gpt-5.4",
          tokenUsage: { inputTokens: 200_000, outputTokens: 0 },
        },
        {
          vendorProvider: "openai",
          vendorModel: "gpt-5.4",
          tokenUsage: { inputTokens: 200_000, outputTokens: 0 },
        },
      ],
    });
    const costSpan = screen.getByText(/^≈ \$/);
    const numeric = Number((costSpan.textContent ?? "").replace(/[^0-9.]/g, ""));
    expect(numeric).toBeCloseTo(1, 2);
  });

  it("renders nothing when both tokensIn and headline tokens are zero", () => {
    const { container } = render(
      <TooltipProvider>
        <TokenCostBadge tokensIn={0} freshInputTokens={0} tokensOut={0} />
      </TooltipProvider>,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders subscription telemetry as a provenance-only token badge without cost toggling", () => {
    render(
      <TooltipProvider>
        <TokenCostBadge
          tokensIn={999_999}
          freshInputTokens={999_999}
          tokensOut={999_999}
          pricing={sonnet}
          vendor="claude"
          subscriptionUsage={[
            {
              provider: "codex",
              model: "gpt-5.4",
              source: "provider-reported",
              billable: false,
              inputTokens: 150,
              outputTokens: 50,
              totalTokens: 200,
            },
            {
              provider: "kimi-code",
              model: "default",
              source: "local-estimate",
              billable: false,
              inputTokens: 75,
              outputTokens: 25,
              totalTokens: 100,
            },
          ]}
        />
      </TooltipProvider>,
    );

    const badge = screen.getByTestId("token-cost-badge");
    expect(badge.getAttribute("data-usage-kind")).toBe("subscription");
    expect(badge.textContent).toContain("300");
    expect(badge.textContent).toContain("보고됨");
    expect(badge.textContent).toContain("추정");
    expect(badge.querySelector("button")).toBeNull();
    expect(screen.queryByText(/^≈ \$/)).toBeNull();
  });
});

/**
 * Wiring, not rules: the badge no longer owns a private `formatTokens`, so it
 * must render the shared authority's output. Asserted through a real render —
 * a green unit test on `cost-format.ts` proves nothing if the badge stops
 * calling it.
 */
describe("TokenCostBadge \u2014 token counts come from the shared formatter", () => {
  afterEach(() => cleanup());

  it.each<{ label: string; freshInputTokens: number; tokensOut: number; rendered: string }>([
    { label: "abbreviates millions with one decimal", freshInputTokens: 1_234_567, tokensOut: 0, rendered: "1.2M" },
    { label: "abbreviates thousands", freshInputTokens: 1_200, tokensOut: 0, rendered: "1.2k" },
    { label: "rounds a fractional sub-1k count", freshInputTokens: 42.7, tokensOut: 0, rendered: "43" },
    { label: "shows 0 rather than InfinityM", freshInputTokens: 1, tokensOut: Number.POSITIVE_INFINITY, rendered: "0" },
    { label: "shows 0 rather than NaN", freshInputTokens: 1, tokensOut: Number.NaN, rendered: "0" },
    { label: "shows 0 rather than a negative count", freshInputTokens: 10, tokensOut: -60, rendered: "0" },
  ])("$label", ({ freshInputTokens, tokensOut, rendered }) => {
    render(
      <TooltipProvider>
        <TokenCostBadge tokensIn={0} freshInputTokens={freshInputTokens} tokensOut={tokensOut} />
      </TooltipProvider>,
    );

    const headline = screen.getByTestId("token-cost-badge").querySelector("span");
    expect(headline?.textContent?.trim()).toBe(`\u{1FA99} ${rendered}`);
  });
});
