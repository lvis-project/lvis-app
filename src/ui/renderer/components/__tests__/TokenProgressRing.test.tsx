// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { TooltipProvider } from "../../../../components/ui/tooltip.js";
import { TokenProgressRing } from "../TokenProgressRing.js";

function renderWithProvider(ui: React.ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

describe("TokenProgressRing", () => {
  it("has tabIndex=0 for keyboard focusability", () => {
    const { getByTestId } = renderWithProvider(<TokenProgressRing used={500} budget={1000} />);
    const ring = getByTestId("token-progress-ring");
    expect(ring).toHaveAttribute("tabindex", "0");
  });

  it("has aria-label describing token usage", () => {
    const { getByTestId } = renderWithProvider(<TokenProgressRing used={500} budget={1000} />);
    const ring = getByTestId("token-progress-ring");
    expect(ring).toHaveAttribute("aria-label", "Token usage 50 percent");
  });

  it("has role=img", () => {
    const { getByTestId } = renderWithProvider(<TokenProgressRing used={250} budget={1000} />);
    const ring = getByTestId("token-progress-ring");
    expect(ring).toHaveAttribute("role", "img");
  });

  it("exposes a compact native hint label like the cost badge", () => {
    const { getByTestId } = renderWithProvider(<TokenProgressRing used={250} budget={1000} />);
    const ring = getByTestId("token-progress-ring");
    expect(ring).toHaveAttribute("title", "컨텍스트 사용량");
  });
});
