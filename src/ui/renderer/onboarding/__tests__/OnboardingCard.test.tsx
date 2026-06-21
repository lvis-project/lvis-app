// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { OnboardingCard, OnboardingHeader } from "../OnboardingCard.js";
import {
  Dialog,
  DialogContent,
} from "../../../../components/ui/dialog.js";

function renderHeader(props: Parameters<typeof OnboardingHeader>[0]) {
  return render(
    <Dialog open>
      <DialogContent>
        <OnboardingHeader {...props} />
      </DialogContent>
    </Dialog>,
  );
}

describe("OnboardingHeader", () => {
  it("renders the title and description", () => {
    renderHeader({ title: "Hello", description: "World" });
    expect(screen.getByText("Hello")).toBeTruthy();
    expect(screen.getByText("World")).toBeTruthy();
  });

  it("forwards titleTestId to the title element", () => {
    renderHeader({ title: "Greeting", titleTestId: "greet-id" });
    expect(screen.getByTestId("greet-id").textContent).toBe("Greeting");
  });

  it("paints the brand gradient avatar from the --gradient-brand token", () => {
    renderHeader({ title: "T" });
    const avatar = screen.getByTestId("onboarding-header:avatar");
    // The avatar must source its fill from the single brand-gradient token so
    // a bundle switch re-tints it — never a hand-written gradient literal.
    expect(avatar.style.background).toContain("var(--gradient-brand)");
    expect(avatar.style.background).not.toMatch(/hsl\([0-9]/);
  });

  it("uses the lg avatar variant for the grid intro", () => {
    renderHeader({ title: "T", size: "lg" });
    const avatar = screen.getByTestId("onboarding-header:avatar");
    expect(avatar.className).toContain("h-10");
  });
});

describe("OnboardingCard", () => {
  it("renders children inside a token-bordered card", () => {
    render(
      <OnboardingCard testId="card-x">
        <span>body</span>
      </OnboardingCard>,
    );
    const card = screen.getByTestId("card-x");
    expect(card.textContent).toBe("body");
    expect(card.className).toContain("bg-[hsl(var(--muted))]");
  });
});
