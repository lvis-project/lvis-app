// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ScenarioShowcase } from "../ScenarioShowcase.js";

describe("ScenarioShowcase", () => {
  it("renders nothing when open=false", () => {
    render(<ScenarioShowcase open={false} onStart={() => {}} onSkip={() => {}} />);
    expect(screen.queryByTestId("scenario-showcase")).toBeNull();
  });

  it("renders 4 passive scenario cards in catalog order when open", () => {
    render(<ScenarioShowcase open onStart={() => {}} onSkip={() => {}} />);
    expect(screen.getByTestId("scenario-showcase")).toBeTruthy();
    const grid = screen.getByTestId("scenario-showcase:grid");
    expect(grid.children.length).toBe(4);
    // Order: meeting, docs, work, multi-agent
    expect(screen.getByTestId("scenario-showcase:card:meeting")).toBeTruthy();
    expect(screen.getByTestId("scenario-showcase:card:docs")).toBeTruthy();
    expect(screen.getByTestId("scenario-showcase:card:work")).toBeTruthy();
    expect(
      screen.getByTestId("scenario-showcase:card:multi-agent"),
    ).toBeTruthy();
  });

  it("'시작하기 →' button fires onStart", () => {
    const onStart = vi.fn();
    render(<ScenarioShowcase open onStart={onStart} onSkip={() => {}} />);
    fireEvent.click(screen.getByTestId("scenario-showcase:start"));
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("'건너뛰기' fires onSkip", () => {
    const onSkip = vi.fn();
    render(<ScenarioShowcase open onStart={() => {}} onSkip={onSkip} />);
    fireEvent.click(screen.getByTestId("scenario-showcase:skip"));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it("cards are not buttons — passive previews (role=img)", () => {
    render(<ScenarioShowcase open onStart={() => {}} onSkip={() => {}} />);
    const card = screen.getByTestId("scenario-showcase:card:meeting");
    expect(card.getAttribute("role")).toBe("img");
    expect(card.tagName).not.toBe("BUTTON");
  });
});
