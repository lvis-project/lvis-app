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
  it("renders the full routine result first and keeps intermediate assistant/tool work collapsed", async () => {
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
      JSON.stringify({
        role: "assistant",
        content: "## 결과\n\n- **핵심** 뉴스 요약 완료\n- 전체 본문은 결과 영역에 그대로 표시됩니다.\n\n<summary>뉴스 요약 완료</summary>",
      }),
    ].join("\n"));

    const { container } = render(<RoutineSessionView jsonlPath="/tmp/routine.jsonl" api={api} />);

    await waitFor(() => {
      expect(screen.getByTestId("routine-session-result")).toBeTruthy();
    });
    const result = screen.getByTestId("routine-session-result");
    expect(result.textContent).toContain("뉴스 요약 완료");
    expect(result.textContent).toContain("전체 본문은 결과 영역에 그대로 표시됩니다.");
    expect(container.textContent).toContain("작업");
    expect(container.textContent).toContain("2단계");
    expect(screen.queryByTestId("routine-session-line-tool_result")).toBeNull();
    expect(container.textContent).not.toContain("요약을 준비합니다.");
    expect(container.textContent).toContain("결과");
    expect(container.textContent).toContain("뉴스 요약 완료");
    expect(container.textContent).not.toContain("very-long-unbroken-path-segment");
    expect(container.textContent).not.toContain("<summary>");

    fireEvent.click(container.querySelector("[data-wg-id] button")!);
    await waitFor(() => {
      expect(screen.getByTestId("routine-session-line-tool_result")).toBeTruthy();
      expect(container.textContent).toContain("요약을 준비합니다.");
    });
    const assistantBodies = container.querySelectorAll("[data-testid='assistant-message-body']");
    expect(assistantBodies.length).toBe(2);
    expect(assistantBodies[0]?.querySelector("strong")?.textContent).toBe("핵심");

    fireEvent.click(screen.getByRole("button", { name: /웹 검색/i }));
    expect(container.textContent).toContain("very-long-unbroken-path-segment");
  });

  it("renders a non-string final assistant payload as the visible result", async () => {
    const api = makeApi(
      JSON.stringify({
        role: "assistant",
        content: { type: "summary", text: "object payload" },
      }),
    );

    const { container } = render(<RoutineSessionView jsonlPath="/tmp/routine.jsonl" api={api} />);

    await waitFor(() => {
      expect(screen.getByTestId("routine-session-result").textContent).toContain("object payload");
    });
    expect(container.querySelector("[data-wg-id] button")).toBeNull();
  });
});
