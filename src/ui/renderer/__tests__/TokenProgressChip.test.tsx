import "../../../../test/renderer/setup.js";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { TokenProgressChip } from "../components/TokenProgressChip.js";
import { TooltipProvider } from "../../../components/ui/tooltip.js";

function renderChip(used: number, budget: number) {
  return render(
    <TooltipProvider>
      <TokenProgressChip used={used} budget={budget} />
    </TooltipProvider>,
  );
}

describe("TokenProgressChip", () => {
  it("renders correct percentage label", () => {
    renderChip(47123, 64000);
    // 47123/64000 = 73.6% → Math.round → 74%
    expect(screen.getByText("74%")).toBeInTheDocument();
  });

  it("applies emerald tier when pct < 50", () => {
    renderChip(10000, 64000);
    const chip = screen.getByTestId("token-progress-chip");
    expect(chip.className).toContain("text-emerald-700");
  });

  it("applies amber tier when 50 <= pct < 80", () => {
    renderChip(47123, 64000);
    const chip = screen.getByTestId("token-progress-chip");
    expect(chip.className).toContain("text-amber-700");
  });

  it("applies rose tier when pct >= 80", () => {
    renderChip(55000, 64000);
    const chip = screen.getByTestId("token-progress-chip");
    expect(chip.className).toContain("text-rose-700");
  });

  it("does not divide by zero when budget is 0", () => {
    expect(() => renderChip(0, 0)).not.toThrow();
    expect(screen.getByText("0%")).toBeInTheDocument();
  });

  it("caps pct at 100 when used exceeds budget", () => {
    renderChip(99999, 64000);
    expect(screen.getByText("100%")).toBeInTheDocument();
  });
});
