// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ScenarioShowcase } from "../ScenarioShowcase.js";

describe("ScenarioShowcase (Option A — interactive demo launcher)", () => {
  it("renders nothing when open=false", () => {
    render(
      <ScenarioShowcase open={false} onStart={() => {}} onSkip={() => {}} />,
    );
    expect(screen.queryByTestId("scenario-showcase")).toBeNull();
  });

  it("renders 4 scenario cards in catalog order when open", () => {
    render(<ScenarioShowcase open onStart={() => {}} onSkip={() => {}} />);
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

  it("default '시작하기 →' button fires onStart with null scenario", () => {
    const onStart = vi.fn();
    render(
      <ScenarioShowcase open onStart={onStart} onSkip={() => {}} />,
    );
    fireEvent.click(screen.getByTestId("scenario-showcase:start"));
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onStart).toHaveBeenCalledWith(null);
  });

  it("'건너뛰기' fires onSkip", () => {
    const onSkip = vi.fn();
    render(
      <ScenarioShowcase open onStart={() => {}} onSkip={onSkip} />,
    );
    fireEvent.click(screen.getByTestId("scenario-showcase:skip"));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it("cards are interactive buttons (Option A — click → inline demo)", () => {
    render(<ScenarioShowcase open onStart={() => {}} onSkip={() => {}} />);
    const card = screen.getByTestId("scenario-showcase:card:meeting");
    expect(card.tagName).toBe("BUTTON");
  });

  it("clicking a card mounts the inline demo for that scenario", () => {
    render(<ScenarioShowcase open onStart={() => {}} onSkip={() => {}} />);
    fireEvent.click(screen.getByTestId("scenario-showcase:card:meeting"));
    expect(screen.getByTestId("scenario-showcase:inline-demo")).toBeTruthy();
    expect(
      screen.getByTestId("scenario-showcase:inline-demo:title").textContent,
    ).toBe("회의록 정리");
    // Grid should be unmounted in demo mode.
    expect(screen.queryByTestId("scenario-showcase:grid")).toBeNull();
  });

  it("inline demo header '← 다른 시나리오' returns to the grid", () => {
    render(<ScenarioShowcase open onStart={() => {}} onSkip={() => {}} />);
    fireEvent.click(screen.getByTestId("scenario-showcase:card:docs"));
    expect(screen.getByTestId("scenario-showcase:inline-demo")).toBeTruthy();
    fireEvent.click(screen.getByTestId("scenario-showcase:inline-demo:back"));
    expect(screen.queryByTestId("scenario-showcase:inline-demo")).toBeNull();
    expect(screen.getByTestId("scenario-showcase:grid")).toBeTruthy();
  });

  it("inline demo footer '이 시나리오로 시작 →' fires onStart with picked scenarioId", () => {
    const onStart = vi.fn();
    render(<ScenarioShowcase open onStart={onStart} onSkip={() => {}} />);
    fireEvent.click(screen.getByTestId("scenario-showcase:card:work"));
    fireEvent.click(screen.getByTestId("scenario-showcase:inline-demo:start"));
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onStart).toHaveBeenCalledWith("work");
  });

  it("inline demo footer '다른 시나리오' returns to the grid", () => {
    render(<ScenarioShowcase open onStart={() => {}} onSkip={() => {}} />);
    fireEvent.click(screen.getByTestId("scenario-showcase:card:multi-agent"));
    fireEvent.click(screen.getByTestId("scenario-showcase:inline-demo:other"));
    expect(screen.queryByTestId("scenario-showcase:inline-demo")).toBeNull();
    expect(screen.getByTestId("scenario-showcase:grid")).toBeTruthy();
  });

  it("data-active-scenario reflects the currently-previewed card", () => {
    render(<ScenarioShowcase open onStart={() => {}} onSkip={() => {}} />);
    expect(
      screen.getByTestId("scenario-showcase").getAttribute("data-active-scenario"),
    ).toBe("");
    fireEvent.click(screen.getByTestId("scenario-showcase:card:docs"));
    expect(
      screen.getByTestId("scenario-showcase").getAttribute("data-active-scenario"),
    ).toBe("docs");
  });
});
