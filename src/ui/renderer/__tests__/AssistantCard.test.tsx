/**
 * AssistantCard unit tests.
 *
 * Regression tests for assistant prose rendering:
 *   - slash command output (route="command") → ReactMarkdown
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
  it("renders Markdown for route=command entries", () => {
    const { container } = renderCard(makeEntry({ text: "표 제목은 **진하게** 표시", route: "command" }));
    const body = container.querySelector("[data-testid='assistant-message-body']");
    expect(body).not.toBeNull();
    expect(body!.className).toContain("whitespace-pre-wrap");
    const strong = body!.querySelector("strong");
    expect(strong).not.toBeNull();
    expect(strong!.textContent).toBe("진하게");
  });

  it("does NOT apply whitespace-pre-wrap for regular LLM entries (uses ReactMarkdown)", () => {
    const { container } = renderCard(makeEntry());
    const body = container.querySelector("[data-testid='assistant-message-body']");
    expect(body).not.toBeNull();
    // ReactMarkdown renders a <p> tag; whitespace-pre-wrap div should be absent
    const prewrap = body!.querySelector(".whitespace-pre-wrap");
    expect(prewrap).toBeNull();
  });

  it("renders multi-line command output through Markdown", () => {
    const text = "/help 출력:\n\n- /new — 새 대화\n- /sessions — 목록";
    const { container } = renderCard(makeEntry({ text, route: "command" }));
    expect(container.textContent).toContain("/new — 새 대화");
    expect(container.textContent).toContain("/sessions — 목록");
    expect(container.querySelector("li")).not.toBeNull();
  });

  it("preserves single newlines in plain command output", () => {
    const { container } = renderCard(makeEntry({ text: "line1\nline2\nline3", route: "command" }));
    const body = container.querySelector("[data-testid='assistant-message-body']");
    expect(body!.querySelectorAll("br")).toHaveLength(2);
    expect(body!.textContent).toContain("line1");
    expect(body!.textContent).toContain("line2");
    expect(body!.textContent).toContain("line3");
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

  it("does NOT strikethrough single-tilde ranges like 7~12℃ (singleTilde:false)", () => {
    const text = "최저 7~12℃ / 최고 14~19℃";
    const { container } = renderCard(makeEntry({ text }));
    expect(container.querySelector("del")).toBeNull();
    expect(container.querySelector("s")).toBeNull();
    expect(container.textContent).toContain("7~12℃");
    expect(container.textContent).toContain("14~19℃");
  });

  it("still renders double-tilde strikethrough ~~text~~ (GFM standard)", () => {
    const text = "this is ~~struck~~ text";
    const { container } = renderCard(makeEntry({ text }));
    const del = container.querySelector("del");
    expect(del).not.toBeNull();
    expect(del!.textContent).toBe("struck");
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
