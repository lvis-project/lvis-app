// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, it, expect } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { TurnSummaryFooter } from "../TurnSummaryFooter.js";

describe("TurnSummaryFooter", () => {
  it("renders step count, duration, and token totals", () => {
    const { getByTestId } = render(
      <TurnSummaryFooter
        turnDurationMs={252_700}
        toolCount={28}
        cumulativeToolMs={48_000}
        tokensIn={32_000}
        tokensOut={15_300}
      />,
    );
    const steps = getByTestId("turn-summary-steps");
    expect(steps.textContent).toContain("28 steps");

    const duration = getByTestId("turn-summary-duration");
    expect(duration.textContent).toContain("4m 12.7s");

    const toolsDuration = getByTestId("turn-summary-tools-duration");
    expect(toolsDuration.textContent).toContain("48.0s");

    const tokens = getByTestId("turn-summary-tokens");
    expect(tokens.textContent).toContain("47.3k tokens");
    expect(tokens.textContent).toContain("32.0k in");
    expect(tokens.textContent).toContain("15.3k out");
  });

  it("uses singular 'step' when toolCount === 1", () => {
    const { getByTestId } = render(
      <TurnSummaryFooter
        turnDurationMs={1_400}
        toolCount={1}
        cumulativeToolMs={400}
        tokensIn={200}
        tokensOut={50}
      />,
    );
    expect(getByTestId("turn-summary-steps").textContent).toContain("1 step");
    expect(getByTestId("turn-summary-steps").textContent).not.toContain("steps");
  });

  it("hides per-tool ms slice when cumulativeToolMs is 0 (executor not yet instrumented)", () => {
    const { queryByTestId } = render(
      <TurnSummaryFooter
        turnDurationMs={1_400}
        toolCount={2}
        cumulativeToolMs={0}
        tokensIn={500}
        tokensOut={100}
      />,
    );
    expect(queryByTestId("turn-summary-tools-duration")).toBeNull();
  });

  it("hides token in/out parens when total tokens is 0", () => {
    const { getByTestId } = render(
      <TurnSummaryFooter
        turnDurationMs={1_400}
        toolCount={0}
        cumulativeToolMs={0}
        tokensIn={0}
        tokensOut={0}
      />,
    );
    const tokens = getByTestId("turn-summary-tokens");
    expect(tokens.textContent).toContain("0 tokens");
    expect(tokens.textContent).not.toContain("in /");
  });

  it("expands per-tool breakdown on click and sorts by ms descending", () => {
    const { getByTestId, queryByTestId } = render(
      <TurnSummaryFooter
        turnDurationMs={252_700}
        toolCount={28}
        cumulativeToolMs={30_800}
        tokensIn={32_000}
        tokensOut={15_300}
        breakdown={{
          WebSearch: { count: 12, ms: 23_400 },
          Bash: { count: 9, ms: 6_200 },
          Read: { count: 4, ms: 800 },
          Edit: { count: 3, ms: 400 },
        }}
      />,
    );

    // Collapsed by default
    expect(queryByTestId("turn-summary-breakdown")).toBeNull();
    fireEvent.click(getByTestId("turn-summary-footer-toggle"));

    const panel = getByTestId("turn-summary-breakdown");
    expect(panel).toBeTruthy();

    // Verify rows present + ms-desc order: WebSearch(23.4s) > Bash(6.2s) > Read(0.8s) > Edit(<0.5s)
    const rows = panel.querySelectorAll('[data-testid^="turn-summary-breakdown-row:"]');
    expect(rows.length).toBe(4);
    expect((rows[0] as HTMLElement).getAttribute("data-testid")).toBe(
      "turn-summary-breakdown-row:WebSearch",
    );
    expect((rows[1] as HTMLElement).getAttribute("data-testid")).toBe(
      "turn-summary-breakdown-row:Bash",
    );
  });

  it("does not render an expand chevron when breakdown is missing", () => {
    const { getByTestId } = render(
      <TurnSummaryFooter
        turnDurationMs={1_400}
        toolCount={0}
        cumulativeToolMs={0}
        tokensIn={500}
        tokensOut={100}
      />,
    );
    const toggle = getByTestId("turn-summary-footer-toggle");
    // Without breakdown, the toggle is non-interactive (no aria-expanded attr).
    expect(toggle.getAttribute("aria-expanded")).toBeNull();
  });
});
