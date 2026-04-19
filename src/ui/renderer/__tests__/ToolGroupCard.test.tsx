/**
 * ToolGroupCard unit tests.
 *
 * ToolGroupCard is a pure-props component that renders tool execution groups.
 */
import "../../../../test/renderer/setup.js";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { ToolGroupCard } from "../components/ToolGroupCard.js";
import type { ChatEntry } from "../../../lib/chat-stream-state.js";

type ToolGroupEntry = Extract<ChatEntry, { kind: "tool_group" }>;

function makeGroup(overrides: Partial<ToolGroupEntry> = {}): ToolGroupEntry {
  return {
    kind: "tool_group",
    groupId: "grp-1",
    groupIds: ["grp-1"],
    status: "done",
    tools: [
      {
        toolUseId: "tu-1",
        name: "read_file",
        input: { path: "/tmp/test.txt" },
        result: "file content",
        status: "done",
        displayOrder: 0,
      },
    ],
    ...overrides,
  };
}

describe("ToolGroupCard", () => {
  it("renders without crashing", () => {
    const { container } = render(<ToolGroupCard group={makeGroup()} />);
    expect(container).toBeTruthy();
  });

  it("shows '도구 사용 결과' when status is done", () => {
    const { container } = render(<ToolGroupCard group={makeGroup({ status: "done" })} />);
    expect(container.textContent).toContain("도구 사용 결과");
  });

  it("shows '도구 사용 중' when status is running", () => {
    const { container } = render(
      <ToolGroupCard
        group={makeGroup({
          status: "running",
          tools: [{ toolUseId: "tu-1", name: "read_file", input: {}, status: "running", displayOrder: 0 }],
        })}
      />,
    );
    expect(container.textContent).toContain("도구 사용 중");
  });

  it("expands tool list when header button is clicked", () => {
    const { container, getByText } = render(<ToolGroupCard group={makeGroup()} />);
    const headerBtn = container.querySelector("button") as HTMLButtonElement;
    fireEvent.click(headerBtn);
    expect(getByText("read_file")).toBeTruthy();
  });

  it("shows error badge when a tool has status=error", () => {
    const group = makeGroup({
      status: "error",
      tools: [
        {
          toolUseId: "tu-1",
          name: "read_file",
          input: {},
          result: "Permission denied",
          status: "error",
          displayOrder: 0,
        },
      ],
    });
    const { container } = render(<ToolGroupCard group={group} />);
    expect(container.textContent).toContain("오류 있음");
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
