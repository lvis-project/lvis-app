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

function embeddedCard(streaming: boolean, text = "embedded thinking content") {
  return (
    <ReasoningCard
      entry={{ kind: "reasoning", text, streaming }}
      embedded
    />
  );
}

describe("ReasoningCard", () => {
  it("renders body expanded while streaming and hides it after the stream finishes", () => {
    const { rerender, queryByText, getByRole } = render(card(true));

    // Streaming: body visible, header button disabled.
    expect(queryByText("생각 중...")).toBeInTheDocument();
    expect(queryByText("thinking content here")).toBeInTheDocument();
    expect(getByRole("button")).toBeDisabled();

    // Stream finishes -> auto-collapse.
    rerender(card(false));
    expect(queryByText("생각 완료")).toBeInTheDocument();
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

  it("starts collapsed when mounted already-complete (session history rehydrate)", () => {
    // Reasoning entries rebuilt from `historyToEntries` (PR #60 session
    // picker) arrive with streaming=false on first render. The auto-collapse
    // effect only fires on a streaming true→false edge, so initial open must
    // also depend on `streaming` — otherwise past thoughts render expanded.
    const { queryByText, getByRole } = render(card(false));
    expect(queryByText("생각 완료")).toBeInTheDocument();
    expect(queryByText("thinking content here")).not.toBeInTheDocument();
    expect(getByRole("button")).not.toBeDisabled();

    // And the header is still interactive: click to inspect the cached thought.
    fireEvent.click(getByRole("button"));
    expect(queryByText("thinking content here")).toBeInTheDocument();
  });

  it("collapses completed embedded reasoning and allows manual expansion", () => {
    const { rerender, queryByText, getByRole } = render(embeddedCard(true));
    expect(queryByText("embedded thinking content")).toBeInTheDocument();
    expect(getByRole("button")).toBeDisabled();

    rerender(embeddedCard(false));
    expect(queryByText("생각 완료")).toBeInTheDocument();
    expect(queryByText("embedded thinking content")).not.toBeInTheDocument();
    expect(getByRole("button")).not.toBeDisabled();

    fireEvent.click(getByRole("button"));
    expect(queryByText("embedded thinking content")).toBeInTheDocument();
  });
});
