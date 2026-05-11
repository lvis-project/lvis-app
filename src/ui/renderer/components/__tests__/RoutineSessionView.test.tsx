// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { RoutineSessionView } from "../RoutineSessionView.js";
import type { LvisApi } from "../../types.js";

function makeApi(jsonl: string): LvisApi {
  return {
    readRoutineSessionV2: vi.fn(async () => jsonl),
  } as unknown as LvisApi;
}

describe("RoutineSessionView", () => {
  it("contains long tool results inside a scrollable monospace block", async () => {
    const longResult = JSON.stringify({
      query: "May 11 2026 Reuters technology AI regulation headlines",
      result: "https://example.com/" + "very-long-unbroken-path-segment-".repeat(80),
    });
    const api = makeApi([
      JSON.stringify({ role: "assistant", content: "요약을 준비합니다." }),
      JSON.stringify({ role: "tool_result", toolName: "web_search", content: longResult }),
    ].join("\n"));

    render(<RoutineSessionView jsonlPath="/tmp/routine.jsonl" api={api} />);

    await waitFor(() => {
      expect(screen.getByTestId("routine-session-line-tool_result")).toBeTruthy();
    });
    const block = screen.getByTestId("routine-session-tool-result");
    expect(block.className).toContain("max-w-full");
    expect(block.className).toContain("overflow-auto");
    expect(block.className).toContain("break-all");
    expect(block.textContent).toContain("very-long-unbroken-path-segment");
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
      expect(screen.getByTestId("routine-session-text").textContent).toContain("object payload");
    });
  });
});
