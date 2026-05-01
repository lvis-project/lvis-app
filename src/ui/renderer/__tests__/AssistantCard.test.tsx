/**
 * AssistantCard unit tests.
 *
 * Regression tests for the slash-command newline fix (route="command"):
 *   - slash command output (route="command") → whitespace-pre-wrap
 *   - regular LLM output (no route) → ReactMarkdown
 *   - search active → whitespace-pre-wrap regardless of route
 */
import "../../../../test/renderer/setup.js";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "@testing-library/react";
import { TooltipProvider } from "../../../components/ui/tooltip.js";
import { AssistantCard } from "../components/AssistantCard.js";
import type { ChatEntry } from "../../../lib/chat-stream-state.js";

type AssistantEntry = Extract<ChatEntry, { kind: "assistant" }>;

function makeEntry(overrides: Partial<AssistantEntry> = {}): AssistantEntry {
  return {
    kind: "assistant",
    text: "line1\nline2\nline3",
    streaming: false,
    ...overrides,
  };
}

function renderCard(entry: AssistantEntry, highlightQuery?: string) {
  return render(
    <TooltipProvider>
      <AssistantCard entry={entry} highlightQuery={highlightQuery} />
    </TooltipProvider>,
  );
}

describe("AssistantCard — slash command newline fix", () => {
  it("applies whitespace-pre-wrap for route=command entries", () => {
    const { container } = renderCard(makeEntry({ route: "command" }));
    const body = container.querySelector("[data-testid='assistant-message-body']");
    expect(body).not.toBeNull();
    const prewrap = body!.querySelector(".whitespace-pre-wrap");
    expect(prewrap).not.toBeNull();
  });

  it("does NOT apply whitespace-pre-wrap for regular LLM entries (uses ReactMarkdown)", () => {
    const { container } = renderCard(makeEntry());
    const body = container.querySelector("[data-testid='assistant-message-body']");
    expect(body).not.toBeNull();
    // ReactMarkdown renders a <p> tag; whitespace-pre-wrap div should be absent
    const prewrap = body!.querySelector(".whitespace-pre-wrap");
    expect(prewrap).toBeNull();
  });

  it("renders multi-line text with newlines preserved for route=command", () => {
    const text = "/help 출력:\n/new — 새 대화\n/sessions — 목록";
    const { container } = renderCard(makeEntry({ text, route: "command" }));
    // All three lines must appear in textContent
    expect(container.textContent).toContain("/new — 새 대화");
    expect(container.textContent).toContain("/sessions — 목록");
  });

  it("applies whitespace-pre-wrap for search active + route=command", () => {
    const { container } = renderCard(
      makeEntry({ route: "command" }),
      "line1",
    );
    const body = container.querySelector("[data-testid='assistant-message-body']");
    const prewrap = body!.querySelector(".whitespace-pre-wrap");
    expect(prewrap).not.toBeNull();
  });

  it("applies whitespace-pre-wrap for search active + no route (regular text)", () => {
    const { container } = renderCard(
      makeEntry(),
      "line1",
    );
    const body = container.querySelector("[data-testid='assistant-message-body']");
    const prewrap = body!.querySelector(".whitespace-pre-wrap");
    expect(prewrap).not.toBeNull();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
