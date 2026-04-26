// @vitest-environment jsdom
import "../../../../../test/renderer/setup.ts";
import { describe, it, expect } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { ImportedTriggerCard } from "../ImportedTriggerCard.js";

describe("ImportedTriggerCard", () => {
  const base = {
    source: "proactive:meeting-detection",
    prompt: "회의 요청 이메일을 받았습니다. 발신자: tester@example.com",
    summary: "개발 회의 6/1 15:00 캘린더 등록 완료",
    toolCallCount: 2,
    importedAt: "2026-04-26T06:31:08.682Z",
  };

  it("renders source + summary + tool count", () => {
    const { getByTestId, getByText } = render(<ImportedTriggerCard {...base} />);
    const card = getByTestId("imported-trigger-card");
    expect(card.getAttribute("data-source")).toBe("proactive:meeting-detection");
    expect(getByText(/등록 완료/)).toBeTruthy();
    expect(getByText(/도구 2회/)).toBeTruthy();
  });

  it("does NOT show the brain templated prompt by default (collapsed)", () => {
    const { queryByText } = render(<ImportedTriggerCard {...base} />);
    expect(queryByText(/회의 요청 이메일을 받았습니다/)).toBeNull();
  });

  it("expands the prompt when the toggle is clicked", () => {
    const { getByText, queryByText } = render(<ImportedTriggerCard {...base} />);
    fireEvent.click(getByText(/트리거 프롬프트 보기/));
    expect(queryByText(/회의 요청 이메일을 받았습니다/)).toBeTruthy();
  });

  it("hides the tool-call footer when toolCallCount is 0", () => {
    const { queryByText } = render(
      <ImportedTriggerCard {...base} toolCallCount={0} />,
    );
    expect(queryByText(/도구 0회/)).toBeNull();
  });

  it("hides the summary block entirely when summary is empty (no placeholder noise)", () => {
    // Earlier the card showed "(요약 없음)" — that was leftover from
    // when the trigger session ran an LLM and a missing summary
    // signaled an LLM failure. The new flow has no LLM in the trigger
    // session; an empty summary is just "this card has no preview yet"
    // and the response area takes over once the user accepts.
    const { container } = render(<ImportedTriggerCard {...base} summary="" />);
    expect(container.textContent ?? "").not.toContain("(요약 없음)");
  });

  it("renders the response area while streaming, even when text is empty", () => {
    const { getByTestId } = render(
      <ImportedTriggerCard
        {...base}
        summary="brain summary"
        response=""
        responseStreaming
      />,
    );
    const responseEl = getByTestId("imported-trigger-response");
    expect(responseEl).toBeTruthy();
    expect(responseEl.textContent).toContain("LVIS 응답");
  });

  it("renders the response area with markdown after streaming completes", () => {
    const { getByTestId, getByText } = render(
      <ImportedTriggerCard
        {...base}
        response="6/1 15:00 캘린더 등록할까요?"
        responseStreaming={false}
      />,
    );
    const responseEl = getByTestId("imported-trigger-response");
    expect(responseEl).toBeTruthy();
    expect(getByText(/6\/1 15:00 캘린더 등록할까요\?/)).toBeTruthy();
  });

  it("renders an empty-response placeholder when the LLM ended without text", () => {
    // Edge case: LLM only emits a tool_use then end_turn, no text_delta.
    // Earlier the response section was hidden on empty content, which
    // made the click-then-blank case look broken to the user. Now we
    // surface "응답이 비어있습니다…" so the user sees the click landed.
    const { getByTestId, getByText } = render(
      <ImportedTriggerCard {...base} response="" responseStreaming={false} />,
    );
    expect(getByTestId("imported-trigger-response")).toBeTruthy();
    expect(getByText(/응답이 비어있습니다/)).toBeTruthy();
  });
});
