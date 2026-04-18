/**
 * ReasoningCard auto-collapse regression guard.
 *
 * Contract:
 *   - While streaming: always expanded; header click is a no-op.
 *   - Streaming -> done transition: auto-collapse once.
 *   - After auto-collapse, user click re-expands and the expanded state sticks
 *     across subsequent re-renders (no re-trigger of the one-shot collapse).
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

describe("ReasoningCard", () => {
  it("renders body expanded while streaming and hides it after the stream finishes", () => {
    const { rerender, queryByText, getByRole } = render(card(true));

    // Streaming: body visible, header button disabled.
    expect(queryByText("생각 정리 중")).toBeInTheDocument();
    expect(queryByText("thinking content here")).toBeInTheDocument();
    expect(getByRole("button")).toBeDisabled();

    // Stream finishes -> auto-collapse.
    rerender(card(false));
    expect(queryByText("생각 정리")).toBeInTheDocument();
    expect(queryByText("thinking content here")).not.toBeInTheDocument();
    expect(getByRole("button")).not.toBeDisabled();
  });

  it("re-expands on header click after auto-collapse and stays open across rerenders", () => {
    const { rerender, queryByText, getByRole } = render(card(true));
    rerender(card(false));
    expect(queryByText("thinking content here")).not.toBeInTheDocument();

    fireEvent.click(getByRole("button"));
    expect(queryByText("thinking content here")).toBeInTheDocument();

    // A benign prop-identity rerender must NOT snap the card back shut — the
    // one-shot auto-collapse should only fire on the streaming->done edge.
    rerender(card(false));
    expect(queryByText("thinking content here")).toBeInTheDocument();
  });

  it("starts expanded (not flashing a collapsed frame) when streaming is true from mount", () => {
    const { queryByText } = render(card(true));
    expect(queryByText("thinking content here")).toBeInTheDocument();
  });
});
