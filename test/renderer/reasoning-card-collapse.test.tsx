/**
 * ReasoningCard collapse behavior.
 *
 * Contract (current):
 *   - Always starts COLLAPSED — including while streaming. The body is hidden;
 *     only the header (spinner + "생각 중..." while streaming, brain + "생각 완료"
 *     once done) shows.
 *   - The header is ALWAYS clickable (even while streaming). Click toggles the
 *     body, and the open state sticks across subsequent re-renders.
 */
import "./setup.js";
import { describe, it, expect } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { ReasoningCard } from "../../src/ui/renderer/components/ReasoningCard.js";

function card(streaming: boolean, text = "thinking content here") {
  return (
    <ReasoningCard
      entry={{ kind: "reasoning", text, streaming }}
    />
  );
}

function embeddedCard(streaming: boolean, text = "embedded thinking content") {
  return (
    <ReasoningCard
      entry={{ kind: "reasoning", text, streaming }}
      embedded
    />
  );
}

describe("ReasoningCard", () => {
  it("stays collapsed WHILE streaming; the header is clickable and expands the body", () => {
    const { queryByText, getByRole } = render(card(true));

    // Streaming: header shows, body hidden, button NOT disabled.
    expect(queryByText("생각 중...")).toBeInTheDocument();
    expect(queryByText("thinking content here")).not.toBeInTheDocument();
    expect(getByRole("button")).not.toBeDisabled();

    // Click expands the live reasoning.
    fireEvent.click(getByRole("button"));
    expect(queryByText("thinking content here")).toBeInTheDocument();
  });

  it("stays collapsed after the stream finishes; click reveals the cached thought and sticks", () => {
    const { rerender, queryByText, getByRole } = render(card(true));
    rerender(card(false));

    // Done: header reads "생각 완료", body still hidden.
    expect(queryByText("생각 완료")).toBeInTheDocument();
    expect(queryByText("thinking content here")).not.toBeInTheDocument();

    fireEvent.click(getByRole("button"));
    expect(queryByText("thinking content here")).toBeInTheDocument();

    // A benign prop-identity rerender must NOT snap the card back shut.
    rerender(card(false));
    expect(queryByText("thinking content here")).toBeInTheDocument();
  });

  it("starts collapsed when mounted already-complete (session history rehydrate)", () => {
    const { queryByText, getByRole } = render(card(false));
    expect(queryByText("생각 완료")).toBeInTheDocument();
    expect(queryByText("thinking content here")).not.toBeInTheDocument();
    expect(getByRole("button")).not.toBeDisabled();

    // Click to inspect the cached thought.
    fireEvent.click(getByRole("button"));
    expect(queryByText("thinking content here")).toBeInTheDocument();
  });

  it("keeps embedded reasoning collapsed (streaming + done) with manual expansion", () => {
    const { rerender, queryByText, getByRole } = render(embeddedCard(true));
    // Collapsed while streaming.
    expect(queryByText("embedded thinking content")).not.toBeInTheDocument();
    expect(getByRole("button")).not.toBeDisabled();

    rerender(embeddedCard(false));
    expect(queryByText("생각 완료")).toBeInTheDocument();
    expect(queryByText("embedded thinking content")).not.toBeInTheDocument();

    fireEvent.click(getByRole("button"));
    expect(queryByText("embedded thinking content")).toBeInTheDocument();
  });
});
