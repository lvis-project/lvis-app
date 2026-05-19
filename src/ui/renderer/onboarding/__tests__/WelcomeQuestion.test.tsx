// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { WelcomeQuestion } from "../WelcomeQuestion.js";

describe("WelcomeQuestion", () => {
  it("renders nothing when open=false", () => {
    render(<WelcomeQuestion open={false} onAccept={() => {}} onSkip={() => {}} />);
    expect(screen.queryByTestId("welcome-question")).toBeNull();
  });

  it("uses neutral greeting when no displayName provided", () => {
    render(<WelcomeQuestion open onAccept={() => {}} onSkip={() => {}} />);
    // DialogTitle "안녕하세요 👋" should be in the document
    expect(screen.getByText(/안녕하세요/)).toBeTruthy();
  });

  it("uses 호칭 in greeting when displayName provided", () => {
    render(
      <WelcomeQuestion
        open
        displayName="Ken"
        onAccept={() => {}}
        onSkip={() => {}}
      />,
    );
    expect(screen.getByText(/Ken님/)).toBeTruthy();
  });

  it("'예, 시작할게요 →' fires onAccept", () => {
    const onAccept = vi.fn();
    render(
      <WelcomeQuestion open onAccept={onAccept} onSkip={() => {}} />,
    );
    fireEvent.click(screen.getByTestId("welcome-question:accept"));
    expect(onAccept).toHaveBeenCalledTimes(1);
  });

  it("'나중에 (skip)' fires onSkip", () => {
    const onSkip = vi.fn();
    render(<WelcomeQuestion open onAccept={() => {}} onSkip={onSkip} />);
    fireEvent.click(screen.getByTestId("welcome-question:skip"));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it("body copy mentions self-intro + 1분", () => {
    render(<WelcomeQuestion open onAccept={() => {}} onSkip={() => {}} />);
    const body = screen.getByTestId("welcome-question:body");
    expect(body.textContent).toMatch(/자기소개/);
    expect(body.textContent).toMatch(/1분/);
  });
});
