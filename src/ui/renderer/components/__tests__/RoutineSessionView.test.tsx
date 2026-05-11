// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RoutineSessionView } from "../RoutineSessionView.js";
import type { LvisApi } from "../../types.js";

function makeApi(jsonl: string): LvisApi {
  return {
    readRoutineSessionV2: vi.fn(async () => jsonl),
  } as unknown as LvisApi;
}

describe("RoutineSessionView", () => {
  it("renders assistant markdown as the primary content and keeps tool results collapsed", async () => {
    const longResult = JSON.stringify({
      query: "May 11 2026 Reuters technology AI regulation headlines",
      result: "https://example.com/" + "very-long-unbroken-path-segment-".repeat(80),
    });
    const api = makeApi([
      JSON.stringify({
        role: "assistant",
        content: "요약을 준비합니다.",
        toolCalls: [
          {
            id: "tool-1",
            name: "web_search",
            input: { query: "May 11 2026 Reuters technology AI regulation headlines" },
          },
        ],
      }),
      JSON.stringify({ role: "tool_result", toolName: "web_search", content: longResult }),
      JSON.stringify({ role: "assistant", content: "## 결과\n\n- **핵심** 뉴스 요약 완료\n\n<summary>뉴스 요약 완료</summary>" }),
    ].join("\n"));

    const { container } = render(<RoutineSessionView jsonlPath="/tmp/routine.jsonl" api={api} />);

    await waitFor(() => {
      expect(screen.getByTestId("routine-session-line-tool_result")).toBeTruthy();
    });
    const assistantBodies = container.querySelectorAll("[data-testid='assistant-message-body']");
    expect(assistantBodies.length).toBe(2);
    expect(assistantBodies[1]?.querySelector("strong")?.textContent).toBe("핵심");
    expect(container.textContent).toContain("뉴스 요약 완료");
    expect(container.textContent).not.toContain("very-long-unbroken-path-segment");
    expect(container.textContent).not.toContain("<summary>");

    fireEvent.click(screen.getByRole("button", { name: /웹 검색/i }));
    expect(container.textContent).toContain("very-long-unbroken-path-segment");
  });

  it("renders object content instead of dropping non-string session payloads", async () => {
    const api = makeApi(
      JSON.stringify({
        role: "assistant",
        content: { type: "summary", text: "object payload" },
      }),
    );

    render(<RoutineSessionView jsonlPath="/tmp/routine.jsonl" api={api} />);

    await waitFor(() => {
      expect(screen.getByTestId("assistant-message-body").textContent).toContain("object payload");
    });
  });
});
