// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ScenarioShowcase } from "../ScenarioShowcase.js";

describe("ScenarioShowcase (first-boot intro)", () => {
  it("renders nothing when open=false", () => {
    render(<ScenarioShowcase open={false} onStart={() => {}} />);
    expect(screen.queryByTestId("scenario-showcase")).toBeNull();
  });

  it("renders 4 scenario cards in catalog order when open", () => {
    render(<ScenarioShowcase open onStart={() => {}} />);
    expect(screen.getByTestId("scenario-showcase")).toBeTruthy();
    const grid = screen.getByTestId("scenario-showcase:grid");
    expect(grid.children.length).toBe(4);
    expect(screen.getByTestId("scenario-showcase:card:meeting")).toBeTruthy();
    expect(screen.getByTestId("scenario-showcase:card:docs")).toBeTruthy();
    expect(screen.getByTestId("scenario-showcase:card:work")).toBeTruthy();
    expect(
      screen.getByTestId("scenario-showcase:card:multi-agent"),
    ).toBeTruthy();
  });

  it("grid exposes the login CTA but no skip button", () => {
    render(<ScenarioShowcase open onStart={() => {}} />);
    expect(screen.getByTestId("scenario-showcase:start").textContent).toContain(
      "로그인하여 LVIS 시작하기",
    );
    expect(screen.queryByTestId("scenario-showcase:skip")).toBeNull();
  });

  it("login CTA fires onStart", () => {
    const onStart = vi.fn();
    render(<ScenarioShowcase open onStart={onStart} />);
    fireEvent.click(screen.getByTestId("scenario-showcase:start"));
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onStart).toHaveBeenCalledWith(null);
  });

  it("cards are passive illustrations, not interactive buttons", () => {
    render(<ScenarioShowcase open onStart={() => {}} />);
    const card = screen.getByTestId("scenario-showcase:card:meeting");
    expect(card.tagName).not.toBe("BUTTON");
    expect(card.textContent).toContain("회의록 정리");
  });
});
