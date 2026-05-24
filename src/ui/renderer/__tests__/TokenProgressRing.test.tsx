import "../../../../test/renderer/setup.js";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { TokenProgressRing } from "../components/TokenProgressRing.js";
import { TooltipProvider } from "../../../components/ui/tooltip.js";

function renderRing(used: number, budget: number) {
  return render(
    <TooltipProvider>
      <TokenProgressRing used={used} budget={budget} />
    </TooltipProvider>,
  );
}

describe("TokenProgressRing", () => {
  it("renders the ring element with correct aria-label", () => {
    renderRing(47123, 64000);
    // 47123/64000 = 73.6% → Math.round → 74%
    const ring = screen.getByTestId("token-progress-ring");
    expect(ring).toBeInTheDocument();
    expect(ring.getAttribute("aria-label")).toBe("Projected input 74 percent");
  });

  it("does not show percent text inside the visual element", () => {
    renderRing(47123, 64000);
    // The ring is visual-only — no visible percent text
    expect(screen.queryByText("74%")).not.toBeInTheDocument();
  });

  it("does not divide by zero when budget is 0", () => {
    expect(() => renderRing(0, 0)).not.toThrow();
    const ring = screen.getByTestId("token-progress-ring");
    expect(ring.getAttribute("aria-label")).toBe("Projected input 0 percent");
  });

  it("caps pct at 100 when used exceeds budget", () => {
    renderRing(99999, 64000);
    const ring = screen.getByTestId("token-progress-ring");
    expect(ring.getAttribute("aria-label")).toBe("Projected input 100 percent");
  });
});
